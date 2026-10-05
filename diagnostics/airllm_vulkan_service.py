"""
Оркестратор локального ИИ на базе послойного движка AirLLM для Google Gemma 4 12B
(google/gemma-4-12B-it-qat-w4a16-ct, 48 слоев, нативная мультимодальность Text + Vision + Audio):
1. Нативная поддержка архитектуры Gemma 4 Unified (Vision `model.embed_vision` + Audio `model.embed_audio` + W4A16 QAT Linear).
2. Адаптивное управление видеопамятью (Adaptive GPU VRAM Residency + AirLLM Layer Streaming):
   - Закрепляет в VRAM максимум слоев (~32-36 из 48 на 8 ГБ VRAM, либо все 48 слоев на >=12 ГБ VRAM).
   - Оставшиеся слои стримит послойно через хуки AirLLM из закрепленной оперативной памяти (page-locked RAM / PCIe DMA).
   - Поддерживает окно контекста 32K токенов и длину ответа модели до ~5000 токенов.
3. Прямой мультимодальный ввод: передача фото в `embed_vision` и нативного 16 кГц аудиосигнала в `embed_audio`.
4. Сохранение контекста: модель напрямую помнит последние 5 сообщений пользователя и 5 ответов ИИ.
5. Автообрезка ответа по последнему завершенному предложению (`truncate_to_last_sentence`).
"""

import base64
import gc
import io
import json
import logging
import os
import re
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from PIL import Image

from engine import SYSTEM_DISPLAY_NAMES, VehicleExpertEngine
from vulkan_backend import (
    BASE_DIR,
    compute_adaptive_vram_allocation,
    compute_optimal_vulkan_layers,
    get_vulkan_status,
    init_vulkan_environment,
)

from .context_worker import RECENT_EXCHANGES_TO_KEEP, format_assistant_core_memory
from .schemas import (
    DIAGNOSTIC_JSON_SCHEMA,
    DetectedFault,
    DiagnosticStructuredResponse,
    InventoryItem,
    RepairTaskStep,
    ToolCallExecution,
    truncate_to_last_sentence,
    validate_and_coerce_structured_json,
)

logger = logging.getLogger("diagnostics.airllm")


SYSTEM_INVENTORY_TEMPLATES: Dict[str, List[Dict[str, Any]]] = {
    "engine": [
        {
            "name": "Диагностический сканер OBD-II (чтение Freeze Frame и коррекций STFT/LTFT)",
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
            "name": "Комплект профильных запчастей/датчиков по коду DTC",
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
            "name": "Установка для вакуумной прокачки тормозов и микрометр",
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
            "name": "Набор игольчатых щупов и термоусадка с клеем",
            "category": "tool",
            "spec": "Герметизация соединений IP67",
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
            "spec": "Извлечь сервисную чеку (Service Plug) перед работами",
            "required": True,
        },
    ],
}


class W4A16Linear(nn.Module):
    """
    Модуль линейного слоя с прямой аппаратной декомпрессией весов W4A16 QAT
    в bfloat16/float32 на GPU во время прямого прохода.
    """
    def __init__(self, in_features: int, out_features: int, group_size: int = 32, device: str = "meta"):
        super().__init__()
        self.in_features = in_features
        self.out_features = out_features
        self.group_size = group_size
        self.weight_packed = nn.Parameter(
            torch.empty((out_features, in_features // 8), dtype=torch.int32, device=device),
            requires_grad=False,
        )
        self.weight_scale = nn.Parameter(
            torch.empty((out_features, in_features // group_size), dtype=torch.bfloat16, device=device),
            requires_grad=False,
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        wp_u8 = self.weight_packed.view(torch.uint8)
        lo = (wp_u8 & 0x0F).to(x.dtype) - 8.0
        hi = (wp_u8 >> 4).to(x.dtype) - 8.0
        w = torch.stack((lo, hi), dim=-1).view(self.out_features, self.in_features // self.group_size, self.group_size)
        w = (w * self.weight_scale.to(x.dtype).unsqueeze(-1)).view(self.out_features, self.in_features)
        return F.linear(x, w)


def _replace_decoder_linears_with_w4a16(root_module: nn.Module, group_size: int = 32) -> int:
    """Заменяет стандартные nn.Linear внутри декодер-слоёв Gemma 4 на квантованные W4A16Linear (на meta-устройстве)."""
    replaced = 0
    for name, child in list(root_module.named_children()):
        if isinstance(child, nn.Linear):
            setattr(
                root_module,
                name,
                W4A16Linear(
                    in_features=child.in_features,
                    out_features=child.out_features,
                    group_size=group_size,
                    device="meta",
                ),
            )
            replaced += 1
        else:
            replaced += _replace_decoder_linears_with_w4a16(child, group_size=group_size)
    return replaced


def _create_adaptive_airllm_model(
    model_path: str,
    shards_path: str,
    max_seq_len: int = 32768,
):
    """
    Создает экземпляр AirLLM для Google Gemma 4 12B (48 слоев, W4A16)
    с адаптивным закреплением максимума слоев в видеопамяти GPU и быстрым DMA-стримингом.
    """
    from accelerate.utils.modeling import set_module_tensor_to_device
    from airllm.airllm_base import AirLLMBaseModel

    class AdaptiveAirLLMGemma4(AirLLMBaseModel):
        def set_layer_names_dict(self):
            self.layer_names_dict = {
                "embed": "model.language_model.embed_tokens",
                "layer_prefix": "model.language_model.layers",
                "norm": "model.language_model.norm",
                "lm_head": "lm_head",
                "resident": ["model.embed_vision", "model.embed_audio"],
            }

        def init_model(self):
            super().init_model()
            _replace_decoder_linears_with_w4a16(
                self.model.model.language_model.layers,
                group_size=32,
            )

        def _install_streaming_hooks(self):
            self._pinned_cpu_cache: Dict[int, Dict[str, torch.Tensor]] = {}
            self._fast_layer_bindings: Dict[int, List[Tuple[Any, str, torch.Tensor, torch.nn.Parameter]]] = {}
            self.resident_gpu_layers_count = 0
            self.streamed_layers_count = 0

            # 1. Загружаем эмбеддинги, нормализацию, vision и audio на устройство
            for resident_key in [
                "model.language_model.embed_tokens",
                "model.language_model.norm",
                "model.embed_vision",
                "model.embed_audio",
            ]:
                try:
                    sd = self.load_layer_to_cpu(resident_key)
                    self.move_layer_to_device(sd)
                    del sd
                except FileNotFoundError:
                    pass

            # Восстанавливаем привязку весов lm_head к материализованному на GPU embed_tokens.weight
            try:
                self.model.lm_head.weight = self.model.model.language_model.embed_tokens.weight
            except Exception:
                pass

            # 2. Адаптивный расчет резидентных слоев в VRAM
            decoder_indices = list(range(1, 49))
            streamed_indices: List[int] = []

            if torch.cuda.is_available() and str(self.running_device).startswith("cuda"):
                torch.cuda.empty_cache()
                free_b, total_b = torch.cuda.mem_get_info(0)
                reserved_unallocated_b = torch.cuda.memory_reserved(0) - torch.cuda.memory_allocated(0)
                usable_free_mb = (free_b + reserved_unallocated_b) // (1024 * 1024)
                # Резерв под KV-кэш 32K окна + декомпрессию активного слоя W4A16
                kv_and_stream_reserve_mb = 1350
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
                        self._pinned_cpu_cache[idx] = state_dict
                        streamed_indices.append(idx)
            else:
                streamed_indices = decoder_indices

            self._streamed_indices = streamed_indices
            self.streamed_layers_count = len(streamed_indices)

            # 3. Закрепляем стриминговые слои в page-locked RAM (pin_memory) для мгновенного PCIe DMA
            use_pin = torch.cuda.is_available() and str(self.running_device).startswith("cuda")
            for idx in self._streamed_indices:
                sd = self._pinned_cpu_cache.get(idx)
                if sd is None:
                    sd = self.load_layer_to_cpu(self.layer_names[idx])
                bindings = []
                for param_name, val in sd.items():
                    mod_path, _, attr = param_name.rpartition(".")
                    submod = self.model.get_submodule(mod_path) if mod_path else self.model
                    # Небольшие буферы (например, layer_scalar) сразу закрепляем на GPU
                    if attr in getattr(submod, "_buffers", {}):
                        set_module_tensor_to_device(
                            self.model,
                            param_name,
                            self.running_device,
                            value=val,
                            dtype=self.running_dtype,
                        )
                        continue
                    self._adopt_checkpoint_shape(param_name, val)
                    target_dtype = val.dtype if self._should_load_verbatim(param_name, val) else self.running_dtype
                    cpu_t = val.to(dtype=target_dtype, device="cpu").contiguous()
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
                self._pinned_cpu_cache.pop(idx, None)

            for idx in self._streamed_indices:
                module = self.layers[idx]
                module._airllm_idx = idx
                module.register_forward_pre_hook(self._pre_hook)
                module.register_forward_hook(self._post_hook)

            if torch.cuda.is_available():
                torch.cuda.empty_cache()

            logger.info(
                "[AirLLM Gemma 4 12B] В VRAM GPU закреплено: %d/48 слоёв | PCIe DMA стриминг: %d слоёв.",
                self.resident_gpu_layers_count,
                self.streamed_layers_count,
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
            return super()._post_hook(module, args, output)

    device = "cuda:0" if torch.cuda.is_available() else "cpu"
    return AdaptiveAirLLMGemma4(
        model_path,
        device=device,
        dtype=torch.bfloat16 if device.startswith("cuda") else torch.float32,
        max_seq_len=max_seq_len,
        layer_shards_saving_path=shards_path,
        prefetching=False,
        delete_original=False,
        load_resident=False,
    )


class AirLLMVulkanOrchestrator:
    """
    Единый сервис управления моделью Google Gemma 4 12B через AirLLM,
    гибридным RAG-поиском BERT + FAISS и выполнением инструментов Function Calling.
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
        local_dir = BASE_DIR / "models" / "gemma-4-12B-it"
        shards_dir = BASE_DIR / "models" / "airllm_shards"
        return local_dir, shards_dir

    def is_airllm_shards_ready(self) -> bool:
        local_dir = BASE_DIR / "models" / "gemma-4-12B-it"
        splitted_dir = BASE_DIR / "models" / "airllm_shards" / "splitted_model"
        if not (local_dir / "config.json").exists() or not splitted_dir.exists():
            return False
        done_files = list(splitted_dir.glob("*.done"))
        return len(done_files) >= 50

    def ensure_model_loaded(self, settings_obj=None):
        """Потокобезопасная инициализация AirLLM Gemma 4 12B в GPU VRAM и мультимодального процессора."""
        if self._airllm_model is not None and self._processor is not None:
            return self._airllm_model, self._processor

        with self._model_lock:
            if self._airllm_model is not None and self._processor is not None:
                return self._airllm_model, self._processor

            local_dir, shards_dir = self._resolve_local_model_and_shards(settings_obj)
            if not self.is_airllm_shards_ready():
                from prepare_airllm_model import download_and_split_model

                download_and_split_model()

            import transformers

            max_seq = getattr(settings_obj, "context_window_tokens", 32768) or 32768
            logger.info(
                "[AirLLM Gemma 4] Загрузка модели из %s в видеопамять GPU (шарды: %s, ctx=%d)...",
                local_dir,
                shards_dir,
                max_seq,
            )
            self._processor = transformers.AutoProcessor.from_pretrained(
                str(local_dir),
                trust_remote_code=True,
            )
            self._airllm_model = _create_adaptive_airllm_model(
                model_path=str(local_dir),
                shards_path=str(shards_dir),
                max_seq_len=max_seq,
            )
            self._loaded_model_id = "google/gemma-4-12B-it-qat-w4a16-ct"
            return self._airllm_model, self._processor

    def preload_model_on_startup(self, async_load: bool = False) -> None:
        """
        Предзагружает модель Google Gemma 4 12B (резидентные слои в VRAM + DMA-слои)
        при старте сервиса, чтобы первый запрос пользователя обрабатывался мгновенно.
        """
        if os.environ.get("AUTODIAG_FAST_TEST") == "1" or os.environ.get("SKIP_AIRLLM_PRELOAD") == "1":
            return
        if self._airllm_model is not None and self._processor is not None:
            return

        def _do_preload():
            t0 = time.perf_counter()
            try:
                print("[AirLLM Startup] Предзагрузка модели Google Gemma 4 12B в видеопамять GPU...", flush=True)
                model, _ = self.ensure_model_loaded(None)
                elapsed = time.perf_counter() - t0
                res_layers = getattr(model, "resident_gpu_layers_count", 0)
                str_layers = getattr(model, "streamed_layers_count", 0)
                print(
                    f"[AirLLM Startup] Модель предзагружена в GPU VRAM за {elapsed:.1f} с "
                    f"(в VRAM закреплено слоёв: {res_layers}/48 | DMA-стриминг: {str_layers} слоёв).",
                    flush=True,
                )
            except Exception as exc:
                logger.error("[AirLLM Startup] Ошибка предзагрузки модели при старте сервиса: %s", exc)

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
        streamed_layers = getattr(self._airllm_model, "streamed_layers_count", max(0, 48 - resident_layers))

        return {
            "vulkan": vk.to_dict(),
            "airllm": {
                "installed": True,
                "active_model_id": "google/gemma-4-12B-it-qat-w4a16-ct",
                "model_family": "Google Gemma 4 Unified (Text + Vision + Audio)",
                "compression": "4bit W4A16 QAT + Adaptive GPU Layer Streaming",
                "shards_dir": str(shards_dir.relative_to(BASE_DIR)),
                "shards_count": len(shard_files),
                "shards_ready": self.is_airllm_shards_ready(),
                "model_loaded_in_memory": self._airllm_model is not None,
                "resident_gpu_layers": resident_layers,
                "streamed_airllm_layers": streamed_layers,
                "last_inference_ms": self._last_inference_ms,
                "layer_wise_mode": True,
                "total_layers": 48,
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
                "bert_embedder_ready": True,
            },
            "context_window": settings_obj.context_window_tokens,
            "max_response_tokens": getattr(settings_obj, "max_response_tokens", 5000),
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
        voice_info: Optional[Dict[str, Any]] = None,
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
                            f"Код {code} ({details['system_ru']}): {sym_str}. Решение: {sol_str}."
                        ),
                        status="success",
                    )
                )
            else:
                executed_calls.append(
                    ToolCallExecution(
                        tool_name="lookup_dtc_code",
                        arguments={"code": code},
                        result_summary=f"Код {code}: карточка сформирована по общему протоколу OBD-II.",
                        status="warning",
                    )
                )

        is_pure_voice_placeholder = bool(
            query.strip().startswith("Голосовой запрос / аудиозапись")
            and not (voice_info and voice_info.get("transcript"))
        )
        search_q = (
            (" ".join(all_codes) if all_codes else "")
            if is_pure_voice_placeholder
            else (query.strip() or (" ".join(all_codes) if all_codes else ""))
        )
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
                        f"Найдено {len(rag_hits)} регламентов в базе знаний. "
                        f"Основной узел: [{top_hit['meta'].get('code', 'N/A')}] "
                        f"({top_hit['meta'].get('system_ru', 'Система')})."
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
                    result_summary=f"Передано в Vision-энкодер Gemma 4 ({clues})",
                    status="success",
                )
            )

        for doc in doc_analyses:
            executed_calls.append(
                ToolCallExecution(
                    tool_name="parse_uploaded_document",
                    arguments={
                        "filename": doc.get("filename", "document.txt"),
                        "extension": doc.get("extension", ""),
                    },
                    result_summary=(
                        f"Обработан документ {doc.get('filename')}. "
                        f"Кодов DTC: {len(doc.get('detected_dtc_codes', []))}, "
                        f"параметров телеметрии: {len(doc.get('key_metrics', []))}."
                    ),
                    status="success",
                )
            )

        if voice_info and voice_info.get("audio_attached_to_model"):
            dur = voice_info.get("duration_sec", 0.0)
            executed_calls.append(
                ToolCallExecution(
                    tool_name="inspect_attached_audio",
                    arguments={"duration_sec": dur, "sampling_rate": 16000},
                    result_summary=f"Прямой звуковой сигнал ({dur} с) передан в аудиоэнкодер Gemma 4 (embed_audio)",
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
                    result_summary=f"Сформирован перечень инструментов для «{SYSTEM_DISPLAY_NAMES.get(primary_system, primary_system)}».",
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
        voice_info: Optional[Dict[str, Any]] = None,
    ) -> DiagnosticStructuredResponse:
        # Разговорный или голосовой запрос без явно найденных кодов/регламентов
        if not rag_hits and not dtc_cards and not image_analyses and not doc_analyses:
            has_audio = bool(voice_info and voice_info.get("audio_attached_to_model"))
            return DiagnosticStructuredResponse(
                response_type="general",
                summary_title=(
                    "ИИдеал Авто • Голосовой анализ (Gemma 4 Native Audio)"
                    if has_audio
                    else "ИИдеал Авто (AIdeal Auto) • Консультация диагноста"
                ),
                mentor_reply=(
                    "Голосовой запрос мастера принят и передан напрямую в нативный аудиоэнкодер Google Gemma 4 12B (embed_audio). "
                    "Уточните марку автомобиля или код ошибки OBD-II для формирования подробного чеклиста ремонта."
                    if has_audio
                    else (
                        "Здравствуйте! Я инженерная система автодиагностики ИИдеал Авто. "
                        "Опишите симптомы поломки (например: *«троит двигатель на холостых»*, "
                        "*«пинки АКПП»*, *«проваливается педаль тормоза»*), назовите код ошибки OBD-II, "
                        "запишите голосовое сообщение или прикрепите фото узла / приборной панели."
                    )
                ),
                faults=[],
                inventory=[],
                repair_steps=[],
                telemetry_notes=[],
                recommendations=[
                    "Укажите марку, модель, год выпуска и двигатель для точной привязки допусков OEM.",
                    "Вы можете загрузить лог сканера (.txt, .csv, .pdf, .obd) или фото с камеры / AR-очков.",
                ],
                follow_up_question="Какой автомобиль диагностируем и какие симптомы наблюдаются?",
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
                    confidence=95,
                    health_index=health,
                    root_cause=f"{sym}. Регламент: {sol}.",
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
                title="Чтение стоп-кадра (Freeze Frame) и параметров телеметрии",
                instruction=(
                    f"Подключите диагностический сканер, сохраните параметры Freeze Frame "
                    f"для ошибки {primary_code} по системе «{primary_system_ru}»."
                ),
                torque_or_spec="Напряжение АКБ: 12.4–12.8 В",
                safety_warning="Работы проводить при выключенном зажигании.",
                verification_hint="Стоп-кадр сохранен, коды зафиксированы.",
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
                    instruction=f"Выполните операцию: «{act_cap}» для устранения причины ошибки {primary_code}.",
                    torque_or_spec="По заводскому допуску OEM",
                    safety_warning="Используйте динамометрический инструмент.",
                    verification_hint=f"«{act_cap}» выполнено, контакты и параметры в норме.",
                    estimated_minutes=20,
                    completed=False,
                )
            )
            step_idx += 1

        repair_steps.append(
            RepairTaskStep(
                step_number=step_idx,
                title="Сброс ошибок и контрольный тест Live Data",
                instruction=(
                    f"Очистите память ошибок ({', '.join(seen_codes) or primary_code}) "
                    f"и проверьте параметры системы «{primary_system_ru}» в движении."
                ),
                torque_or_spec="Статус DTC: Отсутствует",
                safety_warning="Пробный выезд выполнять с соблюдением ПДД.",
                verification_hint="Ошибки не возвращаются, параметры в допуске.",
                estimated_minutes=15,
                completed=False,
            )
        )

        telemetry_notes: List[str] = []
        tel_cat = getattr(self.rag_engine, "telemetry_catalog", None) or getattr(self.rag_engine, "telemetry_stats", {})
        for code in seen_codes:
            t_info = tel_cat.get(code) if isinstance(tel_cat, dict) else None
            if t_info:
                meas = ", ".join(f"{k}: {v}" for k, v in t_info.get("sample_measurements", {}).items())
                sys_lbl = t_info.get("system_ru") or t_info.get("system") or "Система"
                telemetry_notes.append(
                    f"Эталон телеметрии [{code} | {sys_lbl}]: {meas} "
                    f"(Health Index: {t_info.get('avg_health_index')}%)."
                )

        if image_analyses and not dtc_cards:
            summary_title = f"Визуальный осмотр: {image_analyses[0].get('filename', 'фотография узла')}"
        elif faults:
            summary_title = f"Диагностика {primary_code}: {faults[0].title}"
        else:
            summary_title = f"Разбор неисправности: {primary_system_ru}"

        return DiagnosticStructuredResponse(
            response_type="visual_inspection" if image_analyses and not dtc_cards else "diagnosis",
            summary_title=summary_title[:120],
            mentor_reply="",
            faults=faults,
            inventory=inventory,
            repair_steps=repair_steps,
            telemetry_notes=telemetry_notes,
            recommendations=[
                f"Проверьте состояние электрических разъемов и массы узла «{primary_system_ru}».",
                "Отмечайте прогресс в интерактивном чеклисте по мере выполнения.",
            ],
            follow_up_question="Какой шаг чеклиста выполняете сейчас?",
            tool_calls=tool_calls,
        )

    # =========================================================================
    # Реальный инференс через AirLLM Google Gemma 4 12B (Text + Vision + Audio)
    # =========================================================================
    def _run_airllm_inference(
        self,
        query: str,
        rag_hits: List[Dict[str, Any]],
        dtc_cards: Dict[str, Dict[str, Any]],
        recent_messages: List[Any],
        image_analyses: List[Dict[str, Any]],
        doc_analyses: List[Dict[str, Any]],
        voice_info: Optional[Dict[str, Any]],
        dialog_summary: str,
        global_summary: str,
        settings_obj,
    ) -> Optional[str]:
        if os.environ.get("AUTODIAG_FAST_TEST") == "1":
            return None

        try:
            model, processor = self.ensure_model_loaded(settings_obj)
        except Exception as exc:
            logger.error("[AirLLM] Не удалось инициализировать модель Gemma 4: %s", exc)
            return None

        # 1. Предварительно извлекаем изображения (Vision) из фото и вложенных документов
        pil_images: List[Image.Image] = []
        for img_info in image_analyses:
            pil_img = None
            raw_jpeg = img_info.get("raw_jpeg_bytes")
            abs_p = img_info.get("abs_path")
            data_url = img_info.get("data_url") or img_info.get("data_uri") or ""
            try:
                if raw_jpeg:
                    pil_img = Image.open(io.BytesIO(raw_jpeg)).convert("RGB")
                elif abs_p and Path(abs_p).exists():
                    pil_img = Image.open(abs_p).convert("RGB")
                elif "base64," in data_url:
                    b64_part = data_url.split("base64,", 1)[-1]
                    pil_img = Image.open(io.BytesIO(base64.b64decode(b64_part))).convert("RGB")
                if pil_img is not None:
                    pil_img.thumbnail((768, 768))
                    pil_images.append(pil_img)
            except Exception as img_exc:
                logger.warning("[AirLLM Vision] Ошибка декодирования фото %s: %s", img_info.get("filename"), img_exc)

        for doc in doc_analyses:
            for emb_bytes in doc.get("embedded_images_bytes", []):
                if len(pil_images) >= 4:
                    break
                try:
                    pil_img = Image.open(io.BytesIO(emb_bytes)).convert("RGB")
                    pil_img.thumbnail((768, 768))
                    pil_images.append(pil_img)
                except Exception:
                    pass

        # 2. Нативное аудио (Gemma 4 embed_audio)
        audio_waveform_16k: Optional[np.ndarray] = None
        if voice_info and voice_info.get("audio_attached_to_model"):
            wf = voice_info.get("audio_waveform_16k")
            if wf is not None and len(wf) > 0:
                audio_waveform_16k = wf
        if audio_waveform_16k is None:
            for doc in doc_analyses:
                wf = doc.get("audio_waveform_16k")
                if wf is not None and len(wf) > 0:
                    audio_waveform_16k = wf
                    break

        has_images = bool(pil_images)
        has_native_audio = bool(audio_waveform_16k is not None)
        is_conversational = (
            not rag_hits
            and not dtc_cards
            and not has_images
            and not doc_analyses
            and not has_native_audio
        )

        if has_images:
            sys_prompt = (
                "Ты — ИИдеал Авто (AIdeal Auto), практичный эксперт автодиагностики и автоэлектрик. "
                "К запросу пользователя ПРИКРЕПЛЕНА ФОТОГРАФИЯ (передана напрямую в твой визуальный вход Gemma 4 Vision)."
                + (
                    " Также передана АУДИОЗАПИСЬ речи мастера (передана напрямую в твой нативный аудиовход Gemma 4 embed_audio). "
                    if has_native_audio
                    else " "
                )
                + "Внимательно изучи изображение"
                + (" и прослушай аудиозапись мастера! " if has_native_audio else "! ")
                + "НИ В КОЕМ СЛУЧАЕ НЕ ПРОСИ пользователя прислать фото или аудио, они уже перед тобой. "
                "1) Опиши, что конкретно видно на фотографии (состояние проводки, жгутов, разъемов, деталей, повреждения); "
                + (
                    "2) Внимательно вслушайся в речь мастера из аудиозаписи и дай прямой ответ на его голосовой вопрос; "
                    if has_native_audio
                    else "2) Объясни физическую причину проблемы и почему автомобиль не заводится или работает с перебоями; "
                )
                + "3) Дай четкий практический план ремонта (восстановление жгута, пайка/обжим пинов, термоусадка, прозвонка мультиметром) без банальных советов. "
                "Пиши профессионально, ёмко и понятно, всегда полностью завершай мысль и последнее предложение."
            )
            extra_notes = []
            if dtc_cards:
                extra_notes.append("Коды DTC: " + ", ".join(dtc_cards.keys()))
            if doc_analyses:
                extra_notes.append("Вложенный документ: " + doc_analyses[0].get("filename", ""))
            if has_native_audio:
                extra_notes.append("Прикреплена аудиозапись мастера (Gemma 4 embed_audio)")
            notes_str = f" [Дополнительные данные: {'; '.join(extra_notes)}]" if extra_notes else ""
            if has_native_audio:
                user_prompt_text = (
                    f"Изучи прикреплённое фото узла/проводки автомобиля и внимательно прослушай голосовой вопрос мастера в аудиозаписи.{notes_str}\n"
                    f"Ответь на вопрос мастера и дай практическое заключение автодиагноста."
                )
            else:
                user_prompt_text = f"Изучи прикреплённое фото узла/проводки автомобиля и дай заключение автодиагноста.{notes_str}\nВопрос мастера: {query}"
            if dialog_summary:
                user_prompt_text = f"[Сжатая выжимка ранней истории: {dialog_summary}]\n{user_prompt_text}"
        elif is_conversational:
            sys_prompt = (
                "Ты — ИИдеал Авто (AIdeal Auto), практичный инженер-диагност и наставник автосервиса. "
                "Пиши понятным, живым и профессиональным языком, кратко и по делу, без банальных инструкций "
                "и без лишней воды. Ответь пользователю, уточни симптомы и марку автомобиля. "
                "Всегда полностью завершай мысль и последнее предложение."
            )
            user_prompt_text = query
            if dialog_summary:
                user_prompt_text = f"[Сжатая выжимка ранней истории: {dialog_summary}]\nВопрос пользователя: {query}"
        elif has_native_audio and not rag_hits and not dtc_cards:
            sys_prompt = (
                "Ты — ИИдеал Авто (AIdeal Auto), практичный инженер-диагност и наставник автосервиса. "
                "К запросу пользователя прикреплена аудиозапись, переданная напрямую в твой нативный аудиоэнкодер Gemma 4 (embed_audio). "
                "ТВОЯ ЗАДАЧА: "
                "1) Внимательно прослушай человеческую русскую речь в аудиозаписи, пойми вопрос мастера или описанную проблему; "
                "2) Если мастер голосом задает вопрос, просит совета или описывает неисправность — дай четкий, подробный технический ответ автоэксперта по существу проблемы; "
                "3) Если в аудиозаписи параллельно слышны звуки работы двигателя, подвески, стуки, треск или вой — проанализируй их акустические признаки и укажи вероятный источник шума; "
                "4) Не проси прислать аудио снова — оно уже загружено и обработано. Всегда полностью завершай мысль и последнее предложение."
            )
            if query and not any(query.strip().startswith(p) for p in ("Голосовой запрос", "Голосовой вопрос", "Аудиозапись")):
                user_prompt_text = (
                    f"Мастер прикрепил голосовую аудиозапись и пояснил: «{query}».\n"
                    "Внимательно прослушай речь мастера в аудиозаписи, пойми суть вопроса и дай развёрнутый технический ответ автодиагноста."
                )
            else:
                user_prompt_text = (
                    "Мастер обратился с голосовым запросом через аудиозапись.\n"
                    "Внимательно прослушай сказанное мастером в прикреплённом аудиофайле, распознай его вопрос или описание поломки и дай подробный практический ответ автодиагноста."
                )
            if dialog_summary:
                user_prompt_text = f"[Сжатая выжимка ранней истории: {dialog_summary}]\n{user_prompt_text}"
        else:
            extra_docs_text = "\n".join(
                f"Документ {d['filename']}: {d.get('raw_excerpt', d.get('text_snippet', ''))[:1200]}"
                for d in doc_analyses
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
                "Ты — ИИдеал Авто (AIdeal Auto), ведущий эксперт автодиагностики. "
                + (
                    "К запросу прикреплена АУДИОЗАПИСЬ с речью мастера или звуками работы узлов (нативно в embed_audio). Прослушай её! "
                    if has_native_audio
                    else ""
                )
                + "Дай четкий, понятный технический разбор без глупых и очевидных инструкций (не пиши банальности вроде 'наденьте перчатки'). "
                "1) Точная физическая причина неисправности; "
                "2) Конкретные параметры и точки проверки мультиметром/осциллографом/сканером; "
                "3) Прямой ответ на вопрос мастера"
                + (" (включая услышанное в голосовой аудиозаписи)." if has_native_audio else ".")
                + " Пиши емко и по существу, всегда дописывай последнее предложение до конца."
            )
            user_prompt_text = rag_context
            if has_native_audio:
                user_prompt_text += (
                    "\n\n[Примечание к аудио]: В нативный аудиовход передана голосовая запись мастера. "
                    "Внимательно прослушай речь мастера в аудиозаписи и ответь на его вопрос с учетом базы знаний."
                )

        # Собираем сообщения диалога (сохраняем последние 5 вопросов пользователя и 5 ответов ИИ)
        chat_messages: List[Dict[str, Any]] = [
            {"role": "system", "content": [{"type": "text", "text": sys_prompt}]}
        ]

        # Добавляем последние 10 сообщений (5 пар «пользователь - ассистент») с ключевой информацией
        recent_window = recent_messages[-(RECENT_EXCHANGES_TO_KEEP * 2):] if recent_messages else []
        for msg in recent_window:
            if msg.role == "user" and (msg.content or "").strip():
                chat_messages.append(
                    {
                        "role": "user",
                        "content": [{"type": "text", "text": (msg.content or "").strip()[:1000]}],
                    }
                )
            elif msg.role == "assistant":
                core_reply = format_assistant_core_memory(msg, max_chars=800)
                if core_reply:
                    chat_messages.append(
                        {
                            "role": "assistant",
                            "content": [{"type": "text", "text": core_reply}],
                        }
                    )

        # Формируем текущее сообщение пользователя с нативными мультимодальными вложениями
        user_content_items: List[Dict[str, Any]] = []

        # 1. Фотографии (Vision)
        for pil_img in pil_images:
            user_content_items.append({"type": "image", "image": pil_img})

        # 2. Нативное аудио (Gemma 4 embed_audio)
        if audio_waveform_16k is not None and len(audio_waveform_16k) > 0:
            user_content_items.append({"type": "audio", "audio": audio_waveform_16k})

        user_content_items.append({"type": "text", "text": user_prompt_text})
        chat_messages.append({"role": "user", "content": user_content_items})

        t_start = time.perf_counter()
        with self._model_lock:
            try:
                prompt_str = processor.apply_chat_template(
                    chat_messages,
                    tokenize=False,
                    add_generation_prompt=True,
                )

                proc_kwargs: Dict[str, Any] = {"text": [prompt_str], "return_tensors": "pt", "padding": True}
                if pil_images:
                    proc_kwargs["images"] = pil_images
                if audio_waveform_16k is not None:
                    proc_kwargs["audio"] = [audio_waveform_16k]
                    proc_kwargs["sampling_rate"] = 16000

                model_inputs = processor(**proc_kwargs)

                device = model.running_device
                model_inputs = {
                    k: (v.to(device) if isinstance(v, torch.Tensor) else v)
                    for k, v in model_inputs.items()
                }
                input_len = model_inputs["input_ids"].shape[-1]
                ctx_limit = getattr(settings_obj, "context_window_tokens", 32768) or 32768
                available_ctx = max(500, ctx_limit - input_len)
                target_max_new = min(5000, available_ctx)

                tok = getattr(processor, "tokenizer", processor)
                eos_ids = [1, 107]
                if getattr(tok, "eos_token_id", None) is not None:
                    if isinstance(tok.eos_token_id, list):
                        eos_ids.extend(tok.eos_token_id)
                    else:
                        eos_ids.append(int(tok.eos_token_id))

                with torch.inference_mode():
                    gen_ids = model.generate(
                        **model_inputs,
                        max_new_tokens=target_max_new,
                        eos_token_id=eos_ids,
                        pad_token_id=tok.pad_token_id if hasattr(tok, "pad_token_id") and tok.pad_token_id is not None else 0,
                        do_sample=True,
                        temperature=0.2,
                        top_p=0.92,
                        use_cache=True,
                    )

                new_tokens = gen_ids[0][input_len:]
                decoded = tok.decode(new_tokens, skip_special_tokens=True).strip()
                decoded = re.sub(r"<think>.*?</think>", "", decoded, flags=re.DOTALL).strip()
                # Автообрезка по последнему завершенному предложению
                decoded = truncate_to_last_sentence(decoded)

                self._last_inference_ms = int((time.perf_counter() - t_start) * 1000)
                logger.info(
                    "[AirLLM Gemma 4] Ответ сгенерирован за %d мс (%d токенов, обрезано по предложению).",
                    self._last_inference_ms,
                    len(new_tokens),
                )
                return decoded
            except Exception as exc:
                logger.error("[AirLLM Gemma 4] Ошибка во время генерации: %s", exc)
                return None
            finally:
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
        1. Function Calling (поиск по словарю DTC, гибридный RAG BERT + FAISS, инспекция медиа).
        2. Реальная генерация ответа через AirLLM Google Gemma 4 12B на GPU.
        3. Приведение ответа к строгому JSON виду с автообрезкой по последнему предложению.
        """
        tool_calls, rag_hits, dtc_cards = self.execute_function_calls(
            query=query,
            attached_codes=attached_codes,
            image_analyses=image_analyses,
            doc_analyses=doc_analyses,
            voice_info=voice_info,
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
            voice_info=voice_info,
        )

        llm_output = self._run_airllm_inference(
            query=query,
            rag_hits=rag_hits,
            dtc_cards=dtc_cards,
            recent_messages=recent_messages,
            image_analyses=image_analyses,
            doc_analyses=doc_analyses,
            voice_info=voice_info,
            dialog_summary=session.summary or "",
            global_summary=global_summary or "",
            settings_obj=settings_obj,
        )

        if llm_output:
            if llm_output.lstrip().startswith("{") and '"mentor_reply"' in llm_output:
                validated = validate_and_coerce_structured_json(
                    raw_output=llm_output,
                    fallback_response=scaffolding,
                )
                if not validated.tool_calls:
                    validated.tool_calls = tool_calls
                return validated

            scaffolding.mentor_reply = truncate_to_last_sentence(llm_output)
            if scaffolding.response_type == "general":
                scaffolding.summary_title = "ИИдеал Авто • Диалог с диагностом"
            return validate_and_coerce_structured_json(
                raw_output=json.dumps(scaffolding.model_dump(), ensure_ascii=False),
                fallback_response=scaffolding,
            )

        # Резервный ответ при тестировании или докачке
        if not scaffolding.mentor_reply:
            fault_lines = [
                f"• **{f.code}** ({f.system_ru}): {f.title} — *Индекс здоровья: {f.health_index}%*"
                for f in scaffolding.faults
            ]
            scaffolding.mentor_reply = (
                "Выполнен анализ запроса по локальной базе знаний и телеметрии.\n\n"
                + ("\n".join(fault_lines) if fault_lines else "Опишите симптомы или укажите код ошибки OBD-II.")
            )
            scaffolding.mentor_reply = truncate_to_last_sentence(scaffolding.mentor_reply)
        return scaffolding


# Глобальный экземпляр оркестратора AirLLM Gemma 4 12B
orchestrator = AirLLMVulkanOrchestrator()
