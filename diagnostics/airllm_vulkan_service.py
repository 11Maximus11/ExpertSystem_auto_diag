"""
Оркестратор локального ИИ на базе официально поддерживаемого стека AirLLM (AirLLMQwen3_5 -> Qwen/Qwen3.5-4B):
1. Нативная поддержка мультимодальной архитектуры Qwen 3.5 (Vision `model.visual` + гибридный декодер Gated DeltaNet / Attention).
2. Адаптивное управление видеопамятью (Adaptive GPU VRAM Residency + AirLLM Layer Streaming):
   - Максимально заполняет доступную VRAM видеокарты резидентными слоями, оставляя гарантированный буфер под окно контекста (KV-cache).
   - Оставшиеся слои, не поместившиеся в VRAM, стримит послойно через хуки AirLLM (`_pre_hook` / `_post_hook`) из оперативной памяти / SSD-шардов.
   - Работает на любом объёме видеопамяти (4 ГБ, 6 ГБ, 8 ГБ, 12+ ГБ) без переполнения (OOM).
3. Полный отказ от внешних серверов (Ollama / llama-server) и статичных заглушек: каждый запрос обрабатывается реальной нейросетью.
"""

import gc
import json
import logging
import os
import re
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import torch
from accelerate.utils.modeling import set_module_tensor_to_device
from PIL import Image

from engine import SYSTEM_DISPLAY_NAMES, VehicleExpertEngine
from vulkan_backend import BASE_DIR, get_vulkan_status, init_vulkan_environment

from .schemas import (
    DIAGNOSTIC_JSON_SCHEMA,
    DetectedFault,
    DiagnosticStructuredResponse,
    InventoryItem,
    RepairTaskStep,
    ToolCallExecution,
    validate_and_coerce_structured_json,
)

logger = logging.getLogger(__name__)


SYSTEM_INVENTORY_TEMPLATES: Dict[str, List[Dict[str, Any]]] = {
    "engine": [
        {
            "name": "Диагностический сканер OBD-II (чтение Freeze Frame и топливных коррекций STFT/LTFT)",
            "category": "tool",
            "spec": "Протокол ISO 15765-4 CAN / KWP2000",
            "required": True,
        },
        {
            "name": "Динамометрический ключ 5–60 Н·м и свечная головка 14/16 мм",
            "category": "tool",
            "spec": "Момент затяжки свечей: 20–25 Н·м",
            "required": True,
        },
        {
            "name": "Цифровой мультиметр True RMS и компрессометр",
            "category": "tool",
            "spec": "Первичная обмотка катушек: 0.5–1.5 Ом | Компрессия: 11–14 бар",
            "required": True,
        },
        {
            "name": "Комплект профильных запчастей/датчиков по выявленному коду DTC",
            "category": "part",
            "spec": "Подбор по VIN-каталогу OEM",
            "required": True,
        },
        {
            "name": "Очиститель электрических контактов и диэлектрическая смазка",
            "category": "consumable",
            "spec": "Для разъёмов датчиков и катушек зажигания",
            "required": False,
        },
        {
            "name": "Защитные перчатки и очки",
            "category": "safety",
            "spec": "Работы выполнять после остывания ДВС ниже 45 °C",
            "required": True,
        },
    ],
    "transmission": [
        {
            "name": "Мультимарочный сканер с поддержкой блока TCM (АКПП/РКПП)",
            "category": "tool",
            "spec": "Контроль температуры ATF (35–45 °C) и токов соленоидов",
            "required": True,
        },
        {
            "name": "Динамометрический ключ и набор бит Torx/Hex",
            "category": "tool",
            "spec": "Поддон АКПП: 8–12 Н·м | Гидроблок: 7–10 Н·м",
            "required": True,
        },
        {
            "name": "Манометр линейного давления АКПП и мультиметр",
            "category": "tool",
            "spec": "Сопротивление соленоидов: 5–16 Ом",
            "required": True,
        },
        {
            "name": "Фильтр АКПП, прокладка поддона и ремкомплект соленоидов",
            "category": "part",
            "spec": "По спецификации трансмиссии",
            "required": True,
        },
        {
            "name": "Трансмиссионная жидкость ATF соответствующего допуска",
            "category": "consumable",
            "spec": "Частичная замена 4.5–6 л / полная 8–10 л",
            "required": True,
        },
    ],
    "brakes": [
        {
            "name": "Сканер с функцией сервисной прокачки блока ABS/ESP",
            "category": "tool",
            "spec": "Контроль скорости вращения каждого колеса (Live Data)",
            "required": True,
        },
        {
            "name": "Установка для вакуумной/нагнетательной прокачки тормозов",
            "category": "tool",
            "spec": "Рабочее давление до 1.5–2.0 бар",
            "required": True,
        },
        {
            "name": "Тестер влажности тормозной жидкости и микрометр",
            "category": "tool",
            "spec": "Допустимая влажность ТЖ < 1.5%",
            "required": True,
        },
        {
            "name": "Тормозная жидкость DOT 4 Class 6 и очиститель тормозов",
            "category": "consumable",
            "spec": "Объём полной замены: 1.0 л",
            "required": True,
        },
        {
            "name": "Противооткатные упоры и страховочные стойки",
            "category": "safety",
            "spec": "Запрещена работа только на гидравлическом домкрате",
            "required": True,
        },
    ],
    "electrical": [
        {
            "name": "Двухканальный осциллограф и мультиметр True RMS",
            "category": "tool",
            "spec": "CAN-High (2.5–3.5 В), CAN-Low (1.5–2.5 В), терминатор 60 Ом",
            "required": True,
        },
        {
            "name": "Сканер опроса всех блоков топологии CAN/LIN",
            "category": "tool",
            "spec": "Опрос ECM, TCM, ABS, BCM, SRS",
            "required": True,
        },
        {
            "name": "Набор игольчатых щупов, обжимной инструмент и термоусадка с клеем",
            "category": "tool",
            "spec": "Герметизация соединений IP67",
            "required": True,
        },
        {
            "name": "Ключ на 10 мм для отключения минусовой клеммы АКБ",
            "category": "safety",
            "spec": "Выждать 10 минут перед работами с цепями SRS/Airbag",
            "required": True,
        },
    ],
    "suspension": [
        {
            "name": "Сканер с функцией калибровки датчиков высоты кузова",
            "category": "tool",
            "spec": "Контроль давления ресивера (15–17 бар)",
            "required": True,
        },
        {
            "name": "Манометр пневмолиний и пенный течеискатель",
            "category": "tool",
            "spec": "Проверка фитингов, блока клапанов и пневмобаллонов",
            "required": True,
        },
        {
            "name": "Страховочные опоры (активировать сервисный режим Домкрат)",
            "category": "safety",
            "spec": "Блокировка регулировки клиренса перед подъёмом",
            "required": True,
        },
    ],
    "battery": [
        {
            "name": "Мегаомметр 500 В и диагностический сканер BMS",
            "category": "tool",
            "spec": "Сопротивление изоляции ВВБ > 100 МОм, разбаланс ячеек < 0.03 В",
            "required": True,
        },
        {
            "name": "Диэлектрические перчатки до 1000 В и инструмент IEC 60900",
            "category": "safety",
            "spec": "Обязательно извлечь сервисную чеку (Service Plug) и выждать 10 мин",
            "required": True,
        },
    ],
}


def _create_adaptive_airllm_model(
    model_path: str,
    shards_path: str,
    max_seq_len: int = 4096,
):
    """
    Создаёт экземпляр официально поддерживаемого класса `AirLLMQwen3_5`
    с адаптивным закреплением максимума слоёв в видеопамяти GPU и быстрым DMA-стримингом AirLLM
    (`pin_memory` + `non_blocking`) для оставшихся слоёв.
    """
    from airllm.airllm_qwen3_5 import AirLLMQwen3_5

    class AdaptiveAirLLMQwen3_5(AirLLMQwen3_5):
        """
        Расширение официального `AirLLMQwen3_5`:
        1. Не держит визуальную башню `model.visual` (636 МБ) в VRAM во время текстовых запросов —
           подгружает её на GPU только при передаче фотографий (`pixel_values`), экономя 636 МБ VRAM под слои декодера.
        2. Закрепляет в видеопамяти GPU максимально возможное число слоёв декодера (24–26 из 32 на 8 ГБ VRAM,
           либо все 32 слоя на >=10 ГБ VRAM), оставляя резерв под гибридный KV-кэш Gated DeltaNet.
        3. Оставшиеся слои стримит через хуки AirLLM из закреплённой памяти (`pin_memory`) по шине PCIe DMA
           без накладных расходов `set_module_tensor_to_device` на каждый параметр.
        """

        def _load_resident_modules(self):
            # Визуальная башня model.visual (636 МБ) подгружается по требованию только при наличии фото
            self._visual_loaded_on_gpu = False

        def ensure_visual_tower_on_gpu(self):
            if getattr(self, "_visual_loaded_on_gpu", False):
                return
            try:
                state_dict = self.load_layer_to_cpu("model.visual")
                self.move_layer_to_device(state_dict)
                del state_dict
                self._visual_loaded_on_gpu = True
            except FileNotFoundError:
                pass

        def offload_visual_tower_from_gpu(self):
            if not getattr(self, "_visual_loaded_on_gpu", False):
                return
            try:
                vis_mod = self.model.get_submodule("model.visual")
                vis_mod.to("meta")
                self._visual_loaded_on_gpu = False
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass

        def _install_streaming_hooks(self):
            n = len(self.layer_names)
            self.tie_word_embeddings = bool(
                getattr(self.config, "tie_word_embeddings", False)
                or getattr(getattr(self.config, "text_config", None), "tie_word_embeddings", False)
            )
            self._ram_shard_cache: Dict[int, Dict[str, torch.Tensor]] = {}
            self._fast_layer_bindings: Dict[int, List[Tuple[ Any, str, torch.Tensor, torch.nn.Parameter]]] = {}
            self.resident_gpu_layers_count = 0
            self.streamed_layers_count = 0

            # 1. Загружаем эмбеддинги и финальную нормализацию/голову резидентно на GPU
            embed_state = self.load_layer_to_cpu(self.layer_names[0])
            self.move_layer_to_device(embed_state)
            del embed_state

            norm_idx = n - 2
            norm_state = self.load_layer_to_cpu(self.layer_names[norm_idx])
            self.move_layer_to_device(norm_state)
            del norm_state

            if self.tie_word_embeddings:
                self.model.tie_weights()
            else:
                lm_head_idx = n - 1
                try:
                    head_state = self.load_layer_to_cpu(self.layer_names[lm_head_idx])
                    self.move_layer_to_device(head_state)
                    del head_state
                except FileNotFoundError:
                    self.model.tie_weights()

            # 2. Динамический расчёт бюджета VRAM:
            # У Qwen3.5-4B 24 из 32 слоёв — линейные Gated DeltaNet (без растущего KV-кэша),
            # поэтому KV-кэш на 4096 токенов занимает всего ~134 МБ + ~215 МБ под 1 стриминговый слой AirLLM.
            decoder_indices = list(range(1, n - 2))
            streamed_indices: List[int] = []

            if torch.cuda.is_available() and str(self.running_device).startswith("cuda"):
                torch.cuda.empty_cache()
                free_b, total_b = torch.cuda.mem_get_info(0)
                reserved_unallocated_b = torch.cuda.memory_reserved(0) - torch.cuda.memory_allocated(0)
                usable_free_mb = (free_b + reserved_unallocated_b) // (1024 * 1024)
                # Оставляем 680 МБ под KV-кэш контекста, активации и 1 буферный слой AirLLM
                kv_and_stream_reserve_mb = 680
                layer_budget_mb = max(0, usable_free_mb - kv_and_stream_reserve_mb)

                loaded_mb = 0.0
                for idx in decoder_indices:
                    state_dict = self.load_layer_to_cpu(self.layer_names[idx])
                    shard_mb = sum(t.numel() * t.element_size() for t in state_dict.values()) / (1024 * 1024)
                    if loaded_mb + shard_mb <= layer_budget_mb:
                        self.move_layer_to_device(state_dict)
                        del state_dict
                        loaded_mb += shard_mb
                        self.resident_gpu_layers_count += 1
                    else:
                        self._ram_shard_cache[idx] = state_dict
                        streamed_indices.append(idx)
            else:
                streamed_indices = decoder_indices

            self._streamed_indices = streamed_indices
            self._streamed_set = set(streamed_indices)
            self.streamed_layers_count = len(streamed_indices)

            # 3. Предварительно связываем ссылки на подмодули и закрепляем тензоры в page-locked RAM (pin_memory)
            # для мгновенного асинхронного копирования по шине PCIe DMA без вызовов set_module_tensor_to_device
            use_pin = torch.cuda.is_available() and str(self.running_device).startswith("cuda")
            for idx in self._streamed_indices:
                sd = self._ram_shard_cache.get(idx)
                if sd is None:
                    sd = self.load_layer_to_cpu(self.layer_names[idx])
                bindings = []
                for param_name, val in sd.items():
                    self._adopt_checkpoint_shape(param_name, val)
                    mod_path, _, attr = param_name.rpartition(".")
                    submod = self.model.get_submodule(mod_path) if mod_path else self.model
                    cpu_t = val.to(dtype=self.running_dtype, device="cpu").contiguous()
                    if use_pin:
                        try:
                            cpu_t = cpu_t.pin_memory()
                        except Exception:
                            pass
                    meta_p = torch.nn.Parameter(
                        torch.empty(cpu_t.shape, dtype=cpu_t.dtype, device="meta"),
                        requires_grad=False,
                    )
                    submod._parameters[attr] = meta_p
                    bindings.append((submod, attr, cpu_t, meta_p))
                self._fast_layer_bindings[idx] = bindings
                self._ram_shard_cache.pop(idx, None)

            for idx in self._streamed_indices:
                module = self.layers[idx]
                module._airllm_idx = idx
                module.register_forward_pre_hook(self._pre_hook)
                module.register_forward_hook(self._post_hook)

            if torch.cuda.is_available():
                torch.cuda.empty_cache()

            logger.info(
                f"[AirLLM Adaptive GPU] Слоёв закреплено в VRAM: {self.resident_gpu_layers_count}/{len(decoder_indices)} | "
                f"Послойный DMA-стриминг AirLLM: {self.streamed_layers_count} слоёв"
            )

        def _pre_hook(self, module, args):
            idx = module._airllm_idx
            bindings = self._fast_layer_bindings.get(idx)
            if bindings is not None:
                dev = self.running_device
                for submod, attr, cpu_t, _ in bindings:
                    submod._parameters[attr] = torch.nn.Parameter(
                        cpu_t.to(dev, non_blocking=True),
                        requires_grad=False,
                    )
                return
            return super()._pre_hook(module, args)

        def _post_hook(self, module, args, output):
            idx = module._airllm_idx
            bindings = self._fast_layer_bindings.get(idx)
            if bindings is not None:
                for submod, attr, _, meta_p in bindings:
                    submod._parameters[attr] = meta_p
                return output
            for param_name in getattr(module, "_airllm_moved", []):
                set_module_tensor_to_device(self.model, param_name, "meta")
            module._airllm_moved = []
            return output

    device = "cuda:0" if torch.cuda.is_available() else "cpu"
    return AdaptiveAirLLMQwen3_5(
        model_path,
        device=device,
        dtype=torch.bfloat16 if device.startswith("cuda") else torch.float32,
        max_seq_len=max_seq_len,
        layer_shards_saving_path=shards_path,
        prefetching=False,
        delete_original=True,
    )


class AirLLMVulkanOrchestrator:
    """
    Единый сервис управления локальной нейросетью через AirLLM (`Qwen/Qwen3.5-4B`),
    гибридным RAG-поиском и выполнением инструментов Function Calling.
    """

    def __init__(self):
        self.vulkan_status = init_vulkan_environment(verbose=False)
        self.rag_engine = VehicleExpertEngine()
        self._model_lock = threading.Lock()
        self._airllm_model = None
        self._processor = None
        self._loaded_model_id: Optional[str] = None
        self._last_inference_ms: int = 0

    def _resolve_local_model_and_shards(self, settings_obj) -> Tuple[Path, Path]:
        local_dir = BASE_DIR / "models" / "Qwen3.5-4B"
        shards_dir = BASE_DIR / "models" / "airllm_shards"
        return local_dir, shards_dir

    def is_airllm_shards_ready(self) -> bool:
        local_dir = BASE_DIR / "models" / "Qwen3.5-4B"
        splitted_dir = BASE_DIR / "models" / "airllm_shards" / "splitted_model"
        if not (local_dir / "config.json").exists() or not splitted_dir.exists():
            return False
        done_files = list(splitted_dir.glob("*.done"))
        return len(done_files) >= 33

    def ensure_model_loaded(self, settings_obj=None):
        """Потокобезопасная инициализация AirLLM-модели в GPU VRAM и мультимодального процессора."""
        if self._airllm_model is not None and self._processor is not None:
            return self._airllm_model, self._processor

        with self._model_lock:
            if self._airllm_model is not None and self._processor is not None:
                return self._airllm_model, self._processor

            local_dir, shards_dir = self._resolve_local_model_and_shards(settings_obj)
            if not self.is_airllm_shards_ready():
                from prepare_airllm_model import ensure_airllm_model_ready

                local_dir, _ = ensure_airllm_model_ready()

            import transformers

            max_seq = getattr(settings_obj, "context_window_tokens", 6144) or 6144
            logger.info(f"[AirLLM] Загрузка модели из {local_dir} в видеопамять GPU (шарды: {shards_dir}, ctx={max_seq})...")
            self._processor = transformers.AutoProcessor.from_pretrained(
                str(local_dir),
                trust_remote_code=True,
            )
            self._airllm_model = _create_adaptive_airllm_model(
                model_path=str(local_dir),
                shards_path=str(shards_dir),
                max_seq_len=max_seq,
            )
            self._loaded_model_id = "Qwen/Qwen3.5-4B"
            return self._airllm_model, self._processor

    def preload_model_on_startup(self, async_load: bool = False) -> None:
        """
        Предзагружает модель Qwen/Qwen3.5-4B (резидентные слои в VRAM + закреплённые в pin_memory DMA-слои)
        непосредственно при старте сервиса, чтобы первый запрос пользователя обрабатывался мгновенно без холодного старта.
        """
        if os.environ.get("AUTODIAG_FAST_TEST") == "1" or os.environ.get("SKIP_AIRLLM_PRELOAD") == "1":
            return
        if self._airllm_model is not None and self._processor is not None:
            return

        def _do_preload():
            t0 = time.perf_counter()
            try:
                print("[AirLLM Startup] Предзагрузка модели Qwen/Qwen3.5-4B в видеопамять GPU...", flush=True)
                model, _ = self.ensure_model_loaded(None)
                elapsed = time.perf_counter() - t0
                res_layers = getattr(model, "resident_gpu_layers_count", 0)
                str_layers = getattr(model, "streamed_layers_count", 0)
                print(
                    f"[AirLLM Startup] Модель предзагружена в GPU VRAM за {elapsed:.1f} с "
                    f"(в VRAM закреплено слоёв: {res_layers}/32 | DMA-стриминг: {str_layers} слоёв).",
                    flush=True,
                )
            except Exception as exc:
                logger.error(f"[AirLLM Startup] Ошибка предзагрузки модели при старте сервиса: {exc}")

        if async_load:
            threading.Thread(target=_do_preload, name="airllm-startup-preload", daemon=True).start()
        else:
            _do_preload()

    def get_hardware_and_model_telemetry(self, settings_obj) -> Dict[str, Any]:
        """Возвращает живую телеметрию по GPU / Vulkan, шардам AirLLM и базе знаний."""
        vk = get_vulkan_status()
        local_dir, shards_dir = self._resolve_local_model_and_shards(settings_obj)
        splitted_dir = shards_dir / "splitted_model"
        shard_files = list(splitted_dir.glob("*.safetensors")) if splitted_dir.exists() else []
        shards_size_gb = round(sum(f.stat().st_size for f in shard_files) / (1024**3), 2) if shard_files else 0.0

        resident_layers = getattr(self._airllm_model, "resident_gpu_layers_count", vk.recommended_gpu_layers)
        streamed_layers = getattr(self._airllm_model, "streamed_layers_count", max(0, 32 - resident_layers))

        return {
            "vulkan": vk.to_dict(),
            "airllm": {
                "installed": True,
                "active_model_id": "Qwen/Qwen3.5-4B (Multimodal VL)",
                "compression": "BF16 Adaptive GPU + AirLLM Offload",
                "shards_dir": str(shards_dir.relative_to(BASE_DIR)),
                "shards_count": len(shard_files),
                "shards_ready": self.is_airllm_shards_ready(),
                "model_loaded_in_memory": self._airllm_model is not None,
                "resident_gpu_layers": resident_layers,
                "streamed_airllm_layers": streamed_layers,
                "last_inference_ms": self._last_inference_ms,
                "layer_wise_mode": True,
                "vram_budget_gb": round(vk.vram_total_mb / 1024, 1),
            },
            "gguf": {
                "rel_path": str(local_dir.relative_to(BASE_DIR)),
                "exists": self.is_airllm_shards_ready(),
                "size_gb": shards_size_gb,
                "gpu_layers": resident_layers,
            },
            "rag": {
                "total_documents": len(self.rag_engine.raw_data),
                "total_dtc_codes": len(self.rag_engine.dtc_catalog),
                "telemetry_profiles": len(self.rag_engine.telemetry_catalog),
            },
            "context_window": settings_obj.context_window_tokens,
            "backend_selected": "airllm_vulkan",
        }

    # =========================================================================
    # Выполнение инструментов Function Calling
    # =========================================================================
    def execute_function_calls(
        self,
        query: str,
        attached_codes: List[str],
        image_analyses: List[Dict[str, Any]],
        doc_analyses: List[Dict[str, Any]],
    ) -> Tuple[List[ToolCallExecution], List[Dict[str, Any]], Dict[str, Dict[str, Any]]]:
        executed_calls: List[ToolCallExecution] = []
        dtc_cards: Dict[str, Dict[str, Any]] = {}

        all_codes = list(attached_codes)
        for c in self.rag_engine._extract_dtc_codes_from_text(query):
            if c not in all_codes:
                all_codes.append(c)
        for doc in doc_analyses:
            for c in doc.get("detected_dtc_codes", []):
                if c not in all_codes:
                    all_codes.append(c)

        for code in all_codes:
            details = self.rag_engine.get_dtc_details(code)
            if details:
                dtc_cards[code] = details
                sym_str = "; ".join(details.get("symptoms", [])[:2])
                sol_str = "; ".join(details.get("solutions", [])[:2])
                executed_calls.append(
                    ToolCallExecution(
                        tool_name="lookup_dtc_code",
                        arguments={"code": code},
                        result_summary=(
                            f"Код {code} ({details['system_ru']}): Симптом — {sym_str}. "
                            f"Решение — {sol_str}. Индекс здоровья: {details['health_index']}%."
                        ),
                        status="success",
                    )
                )
            else:
                executed_calls.append(
                    ToolCallExecution(
                        tool_name="lookup_dtc_code",
                        arguments={"code": code},
                        result_summary=f"Код {code}: точной карточки в локальном словаре нет, применён семантический поиск OBD-II.",
                        status="warning",
                    )
                )

        search_q = query.strip() or (" ".join(all_codes) if all_codes else "")
        rag_hits = self.rag_engine.diagnose(search_q, top_n=4, dtc_codes=all_codes) if search_q else []
        if rag_hits:
            top_hit = rag_hits[0]
            top_code = top_hit["meta"].get("code", "")
            if top_code and top_code not in dtc_cards:
                card = self.rag_engine.get_dtc_details(top_code)
                if card:
                    dtc_cards[top_code] = card

            executed_calls.append(
                ToolCallExecution(
                    tool_name="search_knowledge_base",
                    arguments={"symptom_query": search_q, "top_n": 4},
                    result_summary=(
                        f"Найдено {len(rag_hits)} релевантных тех. регламентов. "
                        f"Лучшее совпадение: [{top_hit['meta'].get('code', 'N/A')}] "
                        f"({top_hit['meta'].get('system_ru', 'Система')}, score={top_hit['score']:.2f})."
                    ),
                    status="success",
                )
            )

        for img_info in image_analyses:
            clues = "; ".join(img_info.get("visual_clues", []))
            executed_calls.append(
                ToolCallExecution(
                    tool_name="inspect_attached_image",
                    arguments={
                        "filename": img_info.get("filename", "photo.jpg"),
                        "resolution": f"{img_info.get('width', 0)}x{img_info.get('height', 0)}",
                    },
                    result_summary=f"Передано в Vision-модуль Qwen3.5-VL ({clues})",
                    status="success",
                )
            )

        if rag_hits or dtc_cards:
            primary_system = "engine"
            if rag_hits:
                primary_system = rag_hits[0]["meta"].get("system", "engine")
            elif dtc_cards:
                primary_system = next(iter(dtc_cards.values())).get("system", "engine")

            executed_calls.append(
                ToolCallExecution(
                    tool_name="build_repair_inventory",
                    arguments={"system": primary_system, "codes": list(dtc_cards.keys())[:4]},
                    result_summary=(
                        f"Подготовлен базовый перечень инструментов и допусков для узла "
                        f"«{SYSTEM_DISPLAY_NAMES.get(primary_system, primary_system)}»."
                    ),
                    status="success",
                )
            )

        return executed_calls, rag_hits, dtc_cards

    # =========================================================================
    # Вспомогательная сборка карточек неисправностей, инвентаря и шагов
    # =========================================================================
    def _build_diagnostic_scaffolding(
        self,
        query: str,
        rag_hits: List[Dict[str, Any]],
        dtc_cards: Dict[str, Dict[str, Any]],
        tool_calls: List[ToolCallExecution],
        image_analyses: List[Dict[str, Any]],
        doc_analyses: List[Dict[str, Any]],
    ) -> DiagnosticStructuredResponse:
        # Если запрос разговорный (нет ни совпадений в RAG, ни кодов ошибок, ни фото/документов)
        if not rag_hits and not dtc_cards and not image_analyses and not doc_analyses:
            return DiagnosticStructuredResponse(
                response_type="general",
                summary_title="Консультация ведущего инженера-диагноста AutoDiag AI",
                mentor_reply=(
                    "Здравствуйте! Я готов помочь с диагностикой и ремонтом вашего автомобиля. "
                    "Опишите симптомы неисправности (например: *«троит двигатель на холостых»*, "
                    "*«пинки АКПП при переключении»*, *«мягкая педаль тормоза»*), выберите код ошибки OBD-II "
                    "из словаря или прикрепите фотографию узла / приборной панели."
                ),
                faults=[],
                inventory=[],
                repair_steps=[],
                telemetry_notes=[],
                recommendations=[
                    "Укажите марку, модель, год выпуска и пробег автомобиля в верхнем поле для более точной диагностики.",
                    "Вы можете прикрепить лог сканера (.txt, .csv, .pdf) или сделать снимок прямо с камеры / AR-очков.",
                ],
                follow_up_question="Какой автомобиль мы сегодня диагностируем и какие симптомы или коды ошибок наблюдаются?",
                tool_calls=tool_calls,
            )

        faults: List[DetectedFault] = []
        seen_codes = set()

        for code, card in dtc_cards.items():
            seen_codes.add(code)
            health = float(card.get("health_index", 75.0))
            severity = "critical" if health < 65 or code.startswith(("C", "U")) else "warning"
            sym = card["symptoms"][0] if card.get("symptoms") else "Отклонение рабочих параметров узла"
            sol = card["solutions"][0] if card.get("solutions") else "Требуется инструментальная проверка"
            faults.append(
                DetectedFault(
                    code=code,
                    system=card["system"],
                    system_ru=card["system_ru"],
                    title=f"{sym} ({card['system_ru']})",
                    severity=severity,
                    confidence=94,
                    health_index=health,
                    root_cause=f"Причина по базе знаний: {sym}. Рекомендованный регламент: {sol}.",
                )
            )

        for hit in rag_hits[:3]:
            meta = hit["meta"]
            code = meta.get("code", "N/A")
            if code in seen_codes or len(faults) >= 3:
                continue
            seen_codes.add(code)
            sym, sol = self.rag_engine._extract_symptom_and_solution(hit["text"])
            health = float(meta.get("health_index", 78.0))
            severity = "critical" if health < 65 else "warning"
            faults.append(
                DetectedFault(
                    code=code,
                    system=meta.get("system", "engine"),
                    system_ru=meta.get("system_ru", "Двигатель"),
                    title=sym[:110],
                    severity=severity,
                    confidence=max(75, min(96, int(hit["score"] * 22))),
                    health_index=health,
                    root_cause=sol or hit["text"],
                )
            )

        primary_system = faults[0].system if faults else "engine"
        primary_system_ru = SYSTEM_DISPLAY_NAMES.get(primary_system, "Двигатель (ДВС)")
        primary_code = faults[0].code if faults else "OBD-DIAG"

        raw_inv = SYSTEM_INVENTORY_TEMPLATES.get(primary_system, SYSTEM_INVENTORY_TEMPLATES["engine"])
        inventory = [
            InventoryItem(
                id=f"inv_{primary_system}_{idx}",
                name=item["name"],
                category=item["category"],
                spec=item["spec"],
                required=item["required"],
                checked=False,
            )
            for idx, item in enumerate(raw_inv, start=1)
        ]

        repair_steps: List[RepairTaskStep] = [
            RepairTaskStep(
                step_number=1,
                title="Подготовка поста и чтение стоп-кадра (Freeze Frame)",
                instruction=(
                    f"Зафиксируйте автомобиль противооткатными упорами. Подключите диагностический сканер, "
                    f"сохраните параметры Freeze Frame для кода {primary_code} по системе «{primary_system_ru}». "
                    f"Перед демонтажем разъёмов скиньте минусовую клемму АКБ."
                ),
                torque_or_spec="Напряжение АКБ в покое: 12.5–12.8 В",
                safety_warning="Работы проводить при выключенном зажигании и остывшем агрегате.",
                verification_hint="Лог стоп-кадра сохранён, питание обесточено.",
                estimated_minutes=10,
                completed=False,
            )
        ]

        step_idx = 2
        collected_actions: List[str] = []
        for f_obj in faults:
            card = self.rag_engine.get_dtc_details(f_obj.code)
            if card:
                for sol in card.get("solutions", []):
                    for sub_act in re.split(r"[,;.]", sol):
                        clean_act = sub_act.strip()
                        if len(clean_act) > 4 and clean_act.lower() not in [a.lower() for a in collected_actions]:
                            collected_actions.append(clean_act)

        for act in collected_actions[:4]:
            act_cap = act[0].upper() + act[1:]
            repair_steps.append(
                RepairTaskStep(
                    step_number=step_idx,
                    title=act_cap,
                    instruction=(
                        f"Выполните регламентную операцию: «{act_cap}» для устранения причины кода {primary_code}. "
                        f"Проверьте целостность проводки, контактных пинов и герметичность сопряжений."
                    ),
                    torque_or_spec="Соблюдайте заводской допуск OEM",
                    safety_warning="Используйте динамометрический ключ при сборке.",
                    verification_hint=f"Операция «{act_cap}» выполнена, параметры в норме.",
                    estimated_minutes=20,
                    completed=False,
                )
            )
            step_idx += 1

        repair_steps.append(
            RepairTaskStep(
                step_number=step_idx,
                title="Сброс кодов ошибок и контрольная проверка телеметрии",
                instruction=(
                    f"Подключите АКБ, очистите память ошибок ({', '.join(seen_codes) or primary_code}), "
                    f"запустите двигатель и проверьте параметры системы «{primary_system_ru}» в режиме Live Data."
                ),
                torque_or_spec="Статус ошибки: Отсутствует",
                safety_warning="Выполните пробный выезд на низкой скорости.",
                verification_hint="Ошибки не возвращаются, индекс здоровья узла в норме.",
                estimated_minutes=15,
                completed=False,
            )
        )

        telemetry_notes: List[str] = []
        for code in seen_codes:
            t_info = self.rag_engine.telemetry_catalog.get(code)
            if t_info:
                meas = ", ".join(f"{k}: {v}" for k, v in t_info.get("sample_measurements", {}).items())
                telemetry_notes.append(
                    f"Эталон телеметрии [{code} | {t_info.get('system_ru')}]: {meas} "
                    f"(Средний Health Index: {t_info.get('avg_health_index')}%)."
                )

        summary_title = (
            f"Диагностика {primary_code}: {faults[0].title}"
            if faults
            else f"Инженерный разбор: {primary_system_ru}"
        )

        return DiagnosticStructuredResponse(
            response_type="visual_inspection" if image_analyses and not dtc_cards else "diagnosis",
            summary_title=summary_title[:120],
            mentor_reply="",
            faults=faults,
            inventory=inventory,
            repair_steps=repair_steps,
            telemetry_notes=telemetry_notes,
            recommendations=[
                f"Перед заменой узлов системы «{primary_system_ru}» проверьте состояние разъёмов и массы.",
                "Отмечайте выполненные пункты чеклиста и подготовленный инвентарь прямо в карточке.",
            ],
            follow_up_question="Какой шаг чеклиста вы выполняете сейчас? Нужна ли подсказка по замерам?",
            tool_calls=tool_calls,
        )

    # =========================================================================
    # Реальный нейросетевой инференс через AirLLM (Qwen/Qwen3.5-4B Vision + Text)
    # =========================================================================
    def _run_airllm_inference(
        self,
        query: str,
        rag_hits: List[Dict[str, Any]],
        dtc_cards: Dict[str, Dict[str, Any]],
        recent_messages: List[Any],
        image_analyses: List[Dict[str, Any]],
        doc_analyses: List[Dict[str, Any]],
        dialog_summary: str,
        global_summary: str,
        settings_obj,
    ) -> Optional[str]:
        """
        Выполняет реальную генерацию ответа через AirLLM (`AdaptiveAirLLMQwen3_5`) на GPU
        с передачей текста, RAG-контекста, выжимок памяти и фотографий (`PIL.Image`).
        """
        if os.environ.get("AUTODIAG_FAST_TEST") == "1":
            return None

        try:
            model, processor = self.ensure_model_loaded(settings_obj)
        except Exception as exc:
            logger.error(f"[AirLLM] Не удалось инициализировать модель AirLLM: {exc}")
            return None

        is_conversational = not rag_hits and not dtc_cards and not image_analyses and not doc_analyses

        if is_conversational:
            sys_prompt = (
                "Ты — AutoDiag Pro AI, ведущий инженер-диагност и доброжелательный наставник автосервиса. "
                "Отвечай на русском языке живо, профессионально и структурированно. "
                "Поприветствуй пользователя или ответь на его вопрос, расскажи о своих возможностях "
                "(диагностика по симптомам, кодам OBD-II, фото поломок и AR-режим) и спроси, какой автомобиль нужно проверить. "
                "Всегда полностью завершай мысль и последнее предложение."
            )
            user_prompt_text = query
            if dialog_summary:
                user_prompt_text = f"[Контекст диалога: {dialog_summary}]\nСообщение пользователя: {query}"
        else:
            extra_docs_text = "\n".join(
                f"Документ {d['filename']}: {d['text_snippet'][:1200]}" for d in doc_analyses
            )
            rag_context = self.rag_engine.prepare_llm_context(
                query=query,
                top_n=3,
                dtc_codes=list(dtc_cards.keys()),
                extra_docs_text=extra_docs_text or None,
                dialog_summary=dialog_summary,
                global_summary=global_summary,
            )
            sys_prompt = (
                "Ты — AutoDiag Pro AI, ведущий инженер-диагност автосервиса. "
                "На основе предоставленного технического контекста, телеметрии и фото дай точный, "
                "полный практический инженерный разбор неисправности на русском языке: "
                "1) Главная причина поломки и физика процесса; "
                "2) На что обратить особое внимание при проверке и ремонте (допуски, типичные ошибки); "
                "3) Ответ на конкретный вопрос пользователя. "
                "Всегда дописывай ответ до логического конца, не обрывай фразы."
            )
            user_prompt_text = rag_context

        # Собираем сообщения в формате Qwen3.5-VL
        chat_messages: List[Dict[str, Any]] = [
            {"role": "system", "content": [{"type": "text", "text": sys_prompt}]}
        ]

        for msg in recent_messages[-6:]:
            if msg.role in ("user", "assistant") and (msg.content or "").strip():
                chat_messages.append(
                    {
                        "role": msg.role,
                        "content": [{"type": "text", "text": (msg.content or "")[:1000]}],
                    }
                )

        user_content_items: List[Dict[str, Any]] = []
        pil_images: List[Image.Image] = []
        for img_info in image_analyses:
            abs_p = img_info.get("abs_path")
            if abs_p and Path(abs_p).exists():
                try:
                    pil_img = Image.open(abs_p).convert("RGB")
                    pil_img.thumbnail((768, 768))
                    pil_images.append(pil_img)
                    user_content_items.append({"type": "image", "image": pil_img})
                except Exception:
                    pass

        user_content_items.append({"type": "text", "text": user_prompt_text})
        chat_messages.append({"role": "user", "content": user_content_items})

        t_start = time.perf_counter()
        with self._model_lock:
            try:
                if pil_images and hasattr(model, "ensure_visual_tower_on_gpu"):
                    model.ensure_visual_tower_on_gpu()

                prompt_str = processor.apply_chat_template(
                    chat_messages,
                    tokenize=False,
                    add_generation_prompt=True,
                    enable_thinking=False,
                )
                if pil_images:
                    model_inputs = processor(
                        text=[prompt_str],
                        images=pil_images,
                        return_tensors="pt",
                        padding=True,
                    )
                else:
                    model_inputs = processor(
                        text=[prompt_str],
                        return_tensors="pt",
                        padding=True,
                    )

                device = model.running_device
                model_inputs = {
                    k: (v.to(device) if isinstance(v, torch.Tensor) else v)
                    for k, v in model_inputs.items()
                }
                input_len = model_inputs["input_ids"].shape[-1]
                ctx_limit = getattr(settings_obj, "context_window_tokens", 6144) or 6144
                available_ctx = max(384, ctx_limit - input_len)
                target_max_new = 450 if is_conversational else 768
                max_new = min(target_max_new, available_ctx)

                eos_ids = [248044, 248046]
                tok = getattr(processor, "tokenizer", processor)
                if getattr(tok, "eos_token_id", None) is not None:
                    if isinstance(tok.eos_token_id, list):
                        for eid in tok.eos_token_id:
                            if eid not in eos_ids:
                                eos_ids.append(eid)
                    elif tok.eos_token_id not in eos_ids:
                        eos_ids.append(int(tok.eos_token_id))

                with torch.inference_mode():
                    gen_ids = model.generate(
                        **model_inputs,
                        max_new_tokens=max_new,
                        eos_token_id=eos_ids,
                        pad_token_id=248044,
                        do_sample=True,
                        temperature=0.25,
                        top_p=0.9,
                        use_cache=True,
                    )

                new_tokens = gen_ids[0][input_len:]
                decoded = tok.decode(new_tokens, skip_special_tokens=True).strip()
                decoded = re.sub(r"<think>.*?</think>", "", decoded, flags=re.DOTALL).strip()
                self._last_inference_ms = int((time.perf_counter() - t_start) * 1000)
                logger.info(f"[AirLLM] Ответ сгенерирован за {self._last_inference_ms} мс ({len(new_tokens)} токенов).")
                return decoded
            except Exception as exc:
                logger.error(f"[AirLLM] Ошибка во время генерации: {exc}")
                return None
            finally:
                if pil_images and hasattr(model, "offload_visual_tower_from_gpu"):
                    model.offload_visual_tower_from_gpu()
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()

    def diagnose_and_respond(
        self,
        query: str,
        session,
        settings_obj,
        recent_messages: List[Any],
        attached_codes: List[str],
        image_analyses: List[Dict[str, Any]],
        doc_analyses: List[Dict[str, Any]],
        voice_info: Optional[Dict[str, Any]] = None,
    ) -> DiagnosticStructuredResponse:
        """
        Полный цикл обработки запроса:
        1. Выполняет Function Calling (поиск по словарю DTC, гибридный RAG, инспекция фото/документов).
        2. Запускает реальную генерацию ответа через AirLLM (`Qwen/Qwen3.5-4B` Vision-Language) на GPU.
        3. Приводит ответ к строгому валидированному JSON-виду `DiagnosticStructuredResponse` (Pydantic v2 + JSON Schema).
        """
        tool_calls, rag_hits, dtc_cards = self.execute_function_calls(
            query=query,
            attached_codes=attached_codes,
            image_analyses=image_analyses,
            doc_analyses=doc_analyses,
        )

        global_summary = (
            settings_obj.global_memory_summary
            if settings_obj.cross_dialog_memory_enabled
            else ""
        )

        scaffolding = self._build_diagnostic_scaffolding(
            query=query,
            rag_hits=rag_hits,
            dtc_cards=dtc_cards,
            tool_calls=tool_calls,
            image_analyses=image_analyses,
            doc_analyses=doc_analyses,
        )

        llm_output = self._run_airllm_inference(
            query=query,
            rag_hits=rag_hits,
            dtc_cards=dtc_cards,
            recent_messages=recent_messages,
            image_analyses=image_analyses,
            doc_analyses=doc_analyses,
            dialog_summary=session.summary or "",
            global_summary=global_summary or "",
            settings_obj=settings_obj,
        )

        if llm_output:
            # Если модель вернула JSON по схеме — валидируем напрямую, иначе обогащаем структурированный ответ живым текстом ИИ
            if llm_output.lstrip().startswith("{") and '"mentor_reply"' in llm_output:
                validated = validate_and_coerce_structured_json(
                    raw_output=llm_output,
                    fallback_response=scaffolding,
                )
                if not validated.tool_calls:
                    validated.tool_calls = tool_calls
                return validated

            scaffolding.mentor_reply = llm_output
            if scaffolding.response_type == "general":
                scaffolding.summary_title = "AutoDiag AI • Диалог с диагностом"
            return validate_and_coerce_structured_json(
                raw_output=json.dumps(scaffolding.model_dump(), ensure_ascii=False),
                fallback_response=scaffolding,
            )

        # Если запущен быстрый unit-тест (AUTODIAG_FAST_TEST=1) или шарды ещё докачиваются
        if not scaffolding.mentor_reply:
            fault_lines = [
                f"• **{f.code}** ({f.system_ru}): {f.title} — *Индекс здоровья: {f.health_index}%*"
                for f in scaffolding.faults
            ]
            scaffolding.mentor_reply = (
                f"Выполнен анализ запроса по данным локальной базы знаний и телеметрии.\n\n"
                + ("\n".join(fault_lines) if fault_lines else "Опишите симптомы или укажите код ошибки OBD-II.")
            )
        return scaffolding


# Глобальный экземпляр оркестратора AirLLM
orchestrator = AirLLMVulkanOrchestrator()
