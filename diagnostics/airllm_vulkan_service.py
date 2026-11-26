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

from .autotune import (
    AirLLMAutotuneProfile,
    run_startup_calibration,
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


class GenerationCancelledError(Exception):
    """Исключение при принудительной отмене генерации ответа модели пользователем."""
    pass


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
    "cooling": [
        {
            "name": "Опрессовщик системы охлаждения и тестер прорыва газов CO₂",
            "category": "tool",
            "spec": "Испытательное давление 1.2–1.5 бар (удержание > 10 мин)",
            "required": True,
        },
        {
            "name": "Диагностический сканер (Live Data ТОЖ, скважность термостата/вентилятора)",
            "category": "tool",
            "spec": "Контроль ΔT радиатора, пороги включения вентиляторов",
            "required": True,
        },
        {
            "name": "ИК-пирометр и рефрактометр / ареометр антифриза",
            "category": "tool",
            "spec": "Температура замерзания -35…-40 °C, допуск OEM",
            "required": False,
        },
    ],
    "hybrid": [
        {
            "name": "Диэлектрические перчатки до 1000 В и инструмент IEC 60900",
            "category": "safety",
            "spec": "Обязательное извлечение Service Plug и ожидание разряда 10 мин",
            "required": True,
        },
        {
            "name": "Диагностический сканер HV Battery / Inverter + мегаомметр 500–1000 В",
            "category": "tool",
            "spec": "Контроль изоляции > 10 МОм, ΔV модулей < 0.03 В, контур инвертора",
            "required": True,
        },
    ],
    "chassis": [
        {
            "name": "Механический стетоскоп и индикатор часового типа на стойке",
            "category": "tool",
            "spec": "Биение тормозного диска/ступицы ≤ 0.05–0.08 мм",
            "required": True,
        },
        {
            "name": "Монтажная лопатка и динамометрический ключ",
            "category": "tool",
            "spec": "Затяжка ступичных и рычажных болтов по моменту OEM на нагруженной подвеске",
            "required": True,
        },
    ],
}


class W4A16Linear(nn.Module):
    """
    Модуль линейного слоя с прямой аппаратной декомпрессией весов W4A16 QAT
    в bfloat16/float32 на GPU (и опциональным TensorCore int4pack-ускорением).
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
        self.register_buffer("_int4_weight", None, persistent=False)
        self.register_buffer("_int4_scales_zeros", None, persistent=False)

    def prepare_int4pack(self) -> bool:
        """Конвертирует резидентные веса W4A16 на CUDA GPU в быстрый формат _weight_int4pack_mm."""
        if (
            self.weight_packed is None
            or self.weight_scale is None
            or self.weight_packed.device.type != "cuda"
            or self.out_features % 8 != 0
            or self.in_features % 64 != 0
            or self.group_size not in (32, 64, 128, 256)
            or not hasattr(torch, "_convert_weight_to_int4pack")
            or not hasattr(torch.ops.aten, "_weight_int4pack_mm")
        ):
            return False
        try:
            with torch.no_grad():
                wp_u8 = self.weight_packed.detach().contiguous().view(torch.uint8)
                swapped = ((wp_u8 & 0x0F) << 4) | (wp_u8 >> 4)
                packed_4 = torch._convert_weight_to_int4pack(swapped, 2)
                sz = torch.zeros(
                    (self.in_features // self.group_size, self.out_features, 2),
                    dtype=torch.bfloat16,
                    device=self.weight_packed.device,
                )
                sz[:, :, 0] = self.weight_scale.detach().to(torch.bfloat16).T
                probe_x = torch.zeros((1, self.in_features), dtype=torch.bfloat16, device=self.weight_packed.device)
                _ = torch.ops.aten._weight_int4pack_mm(probe_x, packed_4, self.group_size, sz)

            self._int4_weight = packed_4
            self._int4_scales_zeros = sz
            self.weight_packed = None
            self.weight_scale = None
            return True
        except Exception as exc:
            logger.debug("[W4A16Linear] int4pack fallback для (%d, %d): %s", self.in_features, self.out_features, exc)
            self._int4_weight = None
            self._int4_scales_zeros = None
            return False

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        if self._int4_weight is not None and self._int4_scales_zeros is not None and x.device.type == "cuda":
            orig_dtype = x.dtype
            x_2d = x.reshape(-1, self.in_features)
            if x_2d.dtype != torch.bfloat16:
                x_2d = x_2d.to(torch.bfloat16)
            if not x_2d.is_contiguous():
                x_2d = x_2d.contiguous()
            out = torch.ops.aten._weight_int4pack_mm(
                x_2d,
                self._int4_weight,
                self.group_size,
                self._int4_scales_zeros,
            )
            if out.dtype != orig_dtype:
                out = out.to(orig_dtype)
            return out.reshape(*x.shape[:-1], self.out_features)

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

            # 2. Адаптивный динамический расчет резидентных слоев в VRAM
            decoder_indices = list(range(1, 49))
            resident_indices: List[int] = []
            streamed_indices: List[int] = []
            packed_linears_count = 0

            if torch.cuda.is_available() and str(self.running_device).startswith("cuda"):
                import gc
                gc.collect()
                torch.cuda.empty_cache()
                try:
                    torch.backends.cuda.matmul.allow_tf32 = True
                    torch.backends.cudnn.allow_tf32 = True
                except Exception:
                    pass

                # Безопасный запас VRAM под динамический KV-кэш, DMA-стриминг и WDDM (по умолчанию 1152 МБ)
                min_safety_headroom_mb = int(os.environ.get("VRAM_HEADROOM_MB", "1152"))
                target_gpu_layers_env = os.environ.get("VULKAN_GPU_LAYERS") or os.environ.get("AIRLLM_GPU_LAYERS")
                max_target_layers = int(target_gpu_layers_env) if target_gpu_layers_env else 48

                free_init_b, total_init_b = torch.cuda.mem_get_info(0)
                logger.info(
                    "[AirLLM Gemma 4] Инициализация VRAM GPU (%s): свободно %d МБ / всего %d МБ | целевой буфер: %d МБ",
                    torch.cuda.get_device_name(0),
                    free_init_b // (1024 * 1024),
                    total_init_b // (1024 * 1024),
                    min_safety_headroom_mb,
                )

                for idx in decoder_indices:
                    state_dict = self.load_layer_to_cpu(self.layer_names[idx])
                    shard_mb = sum(t.numel() * t.element_size() for t in state_dict.values()) / (1024 * 1024)

                    torch.cuda.empty_cache()
                    free_b, _ = torch.cuda.mem_get_info(0)
                    reserved_unallocated_b = torch.cuda.memory_reserved(0) - torch.cuda.memory_allocated(0)
                    curr_usable_free_mb = (free_b + reserved_unallocated_b) // (1024 * 1024)

                    # Закрепляем слой в GPU VRAM, если остается безопасный запас памяти
                    if (
                        self.resident_gpu_layers_count < max_target_layers
                        and (curr_usable_free_mb - shard_mb) >= min_safety_headroom_mb
                    ):
                        try:
                            self.move_layer_to_device(state_dict)
                            del state_dict
                            layer_mod = self.layers[idx] if idx < len(self.layers) else None
                            if layer_mod is not None:
                                for sub in layer_mod.modules():
                                    if isinstance(sub, W4A16Linear) and sub.prepare_int4pack():
                                        packed_linears_count += 1
                            resident_indices.append(idx)
                            self.resident_gpu_layers_count += 1
                            continue
                        except RuntimeError as oom_exc:
                            logger.warning(
                                "[AirLLM Gemma 4] Нехватка VRAM при закреплении слоя %d (%s). Переход на PCIe DMA стриминг.",
                                idx,
                                oom_exc,
                            )
                            torch.cuda.empty_cache()

                    # Слой не поместился в VRAM — отправляем в быстрый PCIe DMA стриминг
                    self._pinned_cpu_cache[idx] = state_dict
                    streamed_indices.append(idx)
            else:
                if not torch.cuda.is_available():
                    logger.error(
                        "[AirLLM Gemma 4] КРИТИЧЕСКОЕ ПРЕДУПРЕЖДЕНИЕ: torch.cuda.is_available() == False! "
                        "PyTorch запущен в режиме CPU. Для использования видеокарты RTX 4060 установите PyTorch с поддержкой CUDA: "
                        "pip install --force-reinstall torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu126"
                    )
                else:
                    logger.warning(
                        "[AirLLM Gemma 4] Устройство '%s' не является CUDA. Все слои переведены на CPU.",
                        self.running_device,
                    )
                streamed_indices = decoder_indices

            self._resident_indices = resident_indices
            self._streamed_indices = streamed_indices
            self.streamed_layers_count = len(streamed_indices)

            # 3. Закрепляем стриминговые слои в page-locked RAM (pin_memory) с предконвертацией W4A16 -> int4pack для мгновенного PCIe DMA без пиков VRAM
            self._fast_buffer_bindings: Dict[int, List[Tuple[Any, str, torch.Tensor]]] = {}
            use_pin = torch.cuda.is_available() and str(self.running_device).startswith("cuda")
            can_int4pack = (
                use_pin
                and hasattr(torch, "_convert_weight_to_int4pack")
                and hasattr(torch.ops.aten, "_weight_int4pack_mm")
            )
            streamed_int4_count = 0
            for idx in self._streamed_indices:
                sd = self._pinned_cpu_cache.get(idx)
                if sd is None:
                    sd = self.load_layer_to_cpu(self.layer_names[idx])
                bindings = []
                buf_bindings = []

                # Предварительно группируем W4A16Linear-пары (weight_packed + weight_scale) для int4pack DMA
                w4_groups: Dict[str, Dict[str, Tuple[str, torch.Tensor]]] = {}
                if can_int4pack:
                    for param_name, val in sd.items():
                        mod_path, _, attr = param_name.rpartition(".")
                        if attr in ("weight_packed", "weight_scale") and mod_path:
                            w4_groups.setdefault(mod_path, {})[attr] = (param_name, val)

                packed_param_names = set()
                if can_int4pack and w4_groups:
                    for mod_path, pair in w4_groups.items():
                        if "weight_packed" not in pair or "weight_scale" not in pair:
                            continue
                        submod = self.model.get_submodule(mod_path)
                        if (
                            isinstance(submod, W4A16Linear)
                            and submod.out_features % 8 == 0
                            and submod.in_features % 64 == 0
                            and submod.group_size in (32, 64, 128, 256)
                        ):
                            wp_name, wp_val = pair["weight_packed"]
                            ws_name, ws_val = pair["weight_scale"]
                            try:
                                with torch.no_grad():
                                    wp_gpu = wp_val.to(device=self.running_device, non_blocking=False).contiguous()
                                    wp_u8 = wp_gpu.view(torch.uint8)
                                    swapped = ((wp_u8 & 0x0F) << 4) | (wp_u8 >> 4)
                                    p4_gpu = torch._convert_weight_to_int4pack(swapped, 2)
                                    p4_cpu = p4_gpu.to("cpu").contiguous().pin_memory()
                                    del wp_gpu, wp_u8, swapped, p4_gpu

                                    sz_cpu = torch.zeros(
                                        (submod.in_features // submod.group_size, submod.out_features, 2),
                                        dtype=torch.bfloat16,
                                        device="cpu",
                                    )
                                    sz_cpu[:, :, 0] = ws_val.detach().to(dtype=torch.bfloat16, device="cpu").T
                                    sz_cpu = sz_cpu.contiguous().pin_memory()

                                submod.weight_packed = None
                                submod.weight_scale = None
                                submod._int4_weight = None
                                submod._int4_scales_zeros = None
                                buf_bindings.append((submod, "_int4_weight", p4_cpu))
                                buf_bindings.append((submod, "_int4_scales_zeros", sz_cpu))
                                packed_param_names.add(wp_name)
                                packed_param_names.add(ws_name)
                                streamed_int4_count += 1
                            except Exception:
                                pass

                for param_name, val in sd.items():
                    if param_name in packed_param_names:
                        continue
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
                self._fast_buffer_bindings[idx] = buf_bindings
                self._pinned_cpu_cache.pop(idx, None)

            self._hook_handles: Dict[int, Tuple[Any, Any]] = {}
            self._prefetch_stream = (
                torch.cuda.Stream(device=self.running_device)
                if use_pin and os.environ.get("AIRLLM_DISABLE_PREFETCH") != "1"
                else None
            )
            self._prefetched_gpu: Dict[int, Tuple[Any, List[Tuple[Any, str, torch.Tensor]], List[Tuple[Any, str, torch.nn.Parameter]]]] = {}
            self._next_streamed_map: Dict[int, int] = {}

            for idx in self._streamed_indices:
                module = self.layers[idx]
                module._airllm_idx = idx
                h_pre = module.register_forward_pre_hook(self._pre_hook)
                h_post = module.register_forward_hook(self._post_hook)
                self._hook_handles[idx] = (h_pre, h_post)

            self._rebuild_stream_order()

            if torch.cuda.is_available():
                torch.cuda.empty_cache()

            logger.info(
                "[AirLLM Gemma 4 12B] В VRAM GPU закреплено: %d/48 слоёв (int4pack: %d резид. + %d DMA-стриминг, CUDA-prefetch=%s) | PCIe DMA стриминг: %d слоёв.",
                self.resident_gpu_layers_count,
                packed_linears_count,
                streamed_int4_count,
                "ON" if self._prefetch_stream is not None else "OFF",
                self.streamed_layers_count,
            )

        def _rebuild_stream_order(self) -> None:
            self._resident_indices.sort()
            self._streamed_indices.sort()
            self._next_streamed_map = {
                self._streamed_indices[i]: self._streamed_indices[i + 1]
                for i in range(len(self._streamed_indices) - 1)
            }
            # Замыкаем prefetch с последнего стримингового слоя на первый для перекрытия lm_head + резидентных слоёв следующего токена
            if len(self._streamed_indices) >= 2:
                self._next_streamed_map[self._streamed_indices[-1]] = self._streamed_indices[0]
            self.resident_gpu_layers_count = len(self._resident_indices)
            self.streamed_layers_count = len(self._streamed_indices)

        def clear_prefetch_cache(self) -> None:
            if getattr(self, "_prefetch_stream", None) is not None:
                try:
                    self._prefetch_stream.synchronize()
                except Exception:
                    pass
            if hasattr(self, "_prefetched_gpu"):
                self._prefetched_gpu.clear()

        def _schedule_prefetch(self, target_idx: int) -> None:
            stream = self._prefetch_stream
            if stream is None or target_idx in self._prefetched_gpu:
                return
            bindings = self._fast_layer_bindings.get(target_idx)
            buf_bindings = self._fast_buffer_bindings.get(target_idx)
            if bindings is None and buf_bindings is None:
                return
            dev = self.running_device
            gpu_bufs: List[Tuple[Any, str, torch.Tensor]] = []
            gpu_params: List[Tuple[Any, str, torch.nn.Parameter]] = []
            with torch.cuda.stream(stream):
                if buf_bindings:
                    for submod, attr, cpu_t in buf_bindings:
                        gpu_bufs.append((submod, attr, cpu_t.to(dev, non_blocking=True)))
                if bindings:
                    for submod, attr, cpu_t, _ in bindings:
                        gpu_params.append(
                            (submod, attr, torch.nn.Parameter(cpu_t.to(dev, non_blocking=True), requires_grad=False))
                        )
                ev = torch.cuda.Event()
                ev.record(stream)
            self._prefetched_gpu[target_idx] = (ev, gpu_bufs, gpu_params)

        def set_resident_layer_count(self, target_count: int) -> int:
            """
            Живая миграция числа резидентных слоёв GPU (0..48) прямо в памяти без перечитывания шардов с диска.
            Используется авто-калибратором при старте сервера для поиска оптимальной точки tok/s без WDDM-свопа.
            """
            if not (torch.cuda.is_available() and str(self.running_device).startswith("cuda")):
                return self.resident_gpu_layers_count

            self.clear_prefetch_cache()
            target_count = max(0, min(48, int(target_count)))
            dev = self.running_device

            # Повышение числа резидентных слоёв (CPU pinned RAM -> GPU VRAM)
            while len(self._resident_indices) < target_count and self._streamed_indices:
                idx = self._streamed_indices[0]
                bindings = self._fast_layer_bindings.get(idx, [])
                buf_bindings = self._fast_buffer_bindings.get(idx, [])
                try:
                    gpu_bufs = [(submod, attr, cpu_t.to(dev, non_blocking=False)) for submod, attr, cpu_t in buf_bindings]
                    gpu_params = [
                        (submod, attr, torch.nn.Parameter(cpu_t.to(dev, non_blocking=False), requires_grad=False))
                        for submod, attr, cpu_t, _ in bindings
                    ]
                    for submod, attr, gpu_t in gpu_bufs:
                        submod._buffers[attr] = gpu_t
                    for submod, attr, gpu_p in gpu_params:
                        submod._parameters[attr] = gpu_p
                    handles = self._hook_handles.pop(idx, None)
                    if handles:
                        handles[0].remove()
                        handles[1].remove()
                    self._fast_layer_bindings.pop(idx, None)
                    self._fast_buffer_bindings.pop(idx, None)
                    self._streamed_indices.pop(0)
                    self._resident_indices.append(idx)
                except RuntimeError as oom_exc:
                    logger.warning("[AutoTuner] Нехватка VRAM при переносе слоя %d на GPU: %s", idx, oom_exc)
                    for submod, attr, _ in buf_bindings:
                        submod._buffers[attr] = None
                    for submod, attr, _, meta_p in bindings:
                        submod._parameters[attr] = meta_p
                    torch.cuda.empty_cache()
                    break

            # Понижение числа резидентных слоёв (GPU VRAM -> CPU pinned RAM)
            while len(self._resident_indices) > target_count and self._resident_indices:
                idx = self._resident_indices.pop()
                layer_mod = self.layers[idx]
                bindings = []
                buf_bindings = []
                for submod in layer_mod.modules():
                    if (
                        isinstance(submod, W4A16Linear)
                        and submod._int4_weight is not None
                        and submod._int4_scales_zeros is not None
                    ):
                        p4_cpu = submod._int4_weight.detach().to("cpu").contiguous().pin_memory()
                        sz_cpu = submod._int4_scales_zeros.detach().to("cpu").contiguous().pin_memory()
                        submod._buffers["_int4_weight"] = None
                        submod._buffers["_int4_scales_zeros"] = None
                        buf_bindings.append((submod, "_int4_weight", p4_cpu))
                        buf_bindings.append((submod, "_int4_scales_zeros", sz_cpu))
                    for attr, param in list(submod._parameters.items()):
                        if param is None or param.device.type == "meta":
                            continue
                        cpu_t = param.detach().to("cpu").contiguous().pin_memory()
                        meta_p = torch.nn.Parameter(
                            torch.empty(cpu_t.shape, dtype=cpu_t.dtype, device="meta"),
                            requires_grad=False,
                        )
                        submod._parameters[attr] = meta_p
                        bindings.append((submod, attr, cpu_t, meta_p))

                self._fast_layer_bindings[idx] = bindings
                self._fast_buffer_bindings[idx] = buf_bindings
                self._streamed_indices.append(idx)
                layer_mod._airllm_idx = idx
                h_pre = layer_mod.register_forward_pre_hook(self._pre_hook)
                h_post = layer_mod.register_forward_hook(self._post_hook)
                self._hook_handles[idx] = (h_pre, h_post)

            self._rebuild_stream_order()
            torch.cuda.synchronize()
            torch.cuda.empty_cache()
            return self.resident_gpu_layers_count

        def _pre_hook(self, module, args):
            idx = module._airllm_idx
            bindings = self._fast_layer_bindings.get(idx)
            buf_bindings = self._fast_buffer_bindings.get(idx)
            if bindings is not None or buf_bindings is not None:
                dev = self.running_device
                prefetched = self._prefetched_gpu.pop(idx, None)
                if prefetched is not None:
                    ev, gpu_bufs, gpu_params = prefetched
                    cur_stream = torch.cuda.current_stream(device=dev)
                    cur_stream.wait_event(ev)
                    for submod, attr, gpu_t in gpu_bufs:
                        gpu_t.record_stream(cur_stream)
                        submod._buffers[attr] = gpu_t
                    for submod, attr, gpu_p in gpu_params:
                        gpu_p.data.record_stream(cur_stream)
                        submod._parameters[attr] = gpu_p
                else:
                    if buf_bindings:
                        for submod, attr, cpu_t in buf_bindings:
                            submod._buffers[attr] = cpu_t.to(dev, non_blocking=True)
                    if bindings:
                        for submod, attr, cpu_t, _ in bindings:
                            submod._parameters[attr] = torch.nn.Parameter(
                                cpu_t.to(dev, non_blocking=True),
                                requires_grad=False,
                            )
                next_idx = self._next_streamed_map.get(idx)
                if next_idx is not None:
                    self._schedule_prefetch(next_idx)
                return
            return super()._pre_hook(module, args)

        def _post_hook(self, module, args, output):
            idx = module._airllm_idx
            bindings = self._fast_layer_bindings.get(idx)
            buf_bindings = self._fast_buffer_bindings.get(idx)
            if bindings is not None or buf_bindings is not None:
                if buf_bindings:
                    for submod, attr, _ in buf_bindings:
                        submod._buffers[attr] = None
                if bindings:
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
        self._cancel_events: Dict[str, threading.Event] = {}
        self._cancel_lock = threading.Lock()
        self._airllm_model = None
        self._processor = None
        self._loaded_model_id: Optional[str] = None
        self._last_inference_ms: int = 0
        self._autotune_profile: Optional[AirLLMAutotuneProfile] = None

    def register_cancel_event(self, session_id: str, event: threading.Event) -> None:
        """Регистрирует событие отмены для диагностической сессии."""
        with self._cancel_lock:
            self._cancel_events[str(session_id)] = event

    def unregister_cancel_event(self, session_id: str) -> None:
        """Удаляет событие отмены сессии после завершения генерации."""
        with self._cancel_lock:
            self._cancel_events.pop(str(session_id), None)

    def cancel_generation(self, session_id: Optional[str] = None) -> bool:
        """
        Устанавливает флаг отмены для указанной сессии или всех активных генераций.
        Возвращает True, если было отменено хотя бы одно событие.
        """
        with self._cancel_lock:
            if session_id and str(session_id) in self._cancel_events:
                self._cancel_events[str(session_id)].set()
                return True
            cancelled = False
            for ev in list(self._cancel_events.values()):
                ev.set()
                cancelled = True
            return cancelled

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
            initial_free_vram_mb = (
                int(torch.cuda.mem_get_info(0)[0] // (1024 * 1024))
                if torch.cuda.is_available()
                else 0
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

            if os.environ.get("AUTODIAG_FAST_TEST") != "1" and os.environ.get("AIRLLM_SKIP_AUTOTUNE") != "1":
                try:
                    self._autotune_profile = run_startup_calibration(
                        self._airllm_model,
                        self._processor,
                        shards_dir,
                        initial_free_vram_mb=initial_free_vram_mb,
                    )
                except Exception as tune_exc:
                    logger.warning("[AutoTuner] Ошибка стартовой калибровки (используются дефолтные лимиты): %s", tune_exc)

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
                "autotune": self._autotune_profile.to_dict() if self._autotune_profile else None,
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
    def _analyze_dialog_state(
        self,
        query: str,
        recent_messages: List[Any],
        attached_codes: List[str],
        dtc_cards: Dict[str, Dict[str, Any]],
        has_images: bool,
        has_docs: bool,
        vehicle_info: str = "",
    ) -> Dict[str, Any]:
        """Определяет контекст активного диагностического диалога (первичный разбор vs уточняющий шаг)."""
        active_codes: List[str] = []
        prior_diagnosis = False
        prior_vehicle = (vehicle_info or "").strip()

        for msg in recent_messages or []:
            sdata = getattr(msg, "structured_data", None)
            if isinstance(sdata, dict):
                if sdata.get("faults") or sdata.get("response_type") in ("diagnosis", "visual_inspection"):
                    prior_diagnosis = True
                for f in sdata.get("faults") or []:
                    if isinstance(f, dict) and f.get("code"):
                        c = str(f["code"]).strip().upper()
                        if c and c not in active_codes:
                            active_codes.append(c)
                if not prior_vehicle and sdata.get("vehicle_detected"):
                    prior_vehicle = str(sdata["vehicle_detected"]).strip()
            for c in getattr(msg, "dtc_codes", None) or []:
                c_up = str(c).strip().upper()
                if c_up and c_up not in active_codes:
                    active_codes.append(c_up)

        explicit_in_query = list(
            dict.fromkeys([c.upper() for c in attached_codes] + self.rag_engine._extract_dtc_codes_from_text(query))
        )
        new_explicit_codes = [c for c in explicit_in_query if c not in active_codes]
        is_greeting = (
            self.rag_engine.is_general_or_greeting_query(query)
            and not explicit_in_query
            and not has_images
            and not has_docs
        )

        q_low = (query or "").lower()
        requests_new_plan = any(
            kw in q_low
            for kw in ("чеклист", "чек-лист", "план ремонта", "новый план", "список инструментов", "заказ-наряд")
        )
        is_followup = bool(
            prior_diagnosis
            and not new_explicit_codes
            and not has_images
            and not has_docs
            and not is_greeting
            and not requests_new_plan
        )
        return {
            "has_prior_diagnosis": prior_diagnosis,
            "active_codes": active_codes,
            "explicit_in_query": explicit_in_query,
            "is_greeting": is_greeting,
            "is_followup": is_followup,
            "vehicle_info": prior_vehicle,
        }

    def _build_diagnostic_scaffolding(
        self,
        query: str,
        rag_hits: List[Dict[str, Any]],
        dtc_cards: Dict[str, Dict[str, Any]],
        tool_calls: List[ToolCallExecution],
        image_analyses: List[Dict[str, Any]],
        doc_analyses: List[Dict[str, Any]],
        voice_info: Optional[Dict[str, Any]] = None,
        is_followup: bool = False,
        vehicle_info: str = "",
    ) -> DiagnosticStructuredResponse:
        # Уточняющий ход в активном диалоге: не дублируем шаблонный чеклист повторно
        if is_followup:
            return DiagnosticStructuredResponse(
                response_type="followup",
                summary_title="Уточнение и следующий шаг диагностики",
                mentor_reply="",
                faults=[],
                inventory=[],
                repair_steps=[],
                telemetry_notes=[],
                recommendations=[],
                follow_up_question="Какие показания или изменения наблюдаются после проверки?",
                tool_calls=tool_calls,
                vehicle_detected=vehicle_info,
            )

        # Разговорный или голосовой запрос без явно найденных кодов/регламентов
        if not rag_hits and not dtc_cards and not image_analyses and not doc_analyses:
            has_audio = bool(voice_info and voice_info.get("audio_attached_to_model"))
            return DiagnosticStructuredResponse(
                response_type="general",
                summary_title=(
                    "ИИдеал Авто • Голосовой анализ (Gemma 4 Native Audio)"
                    if has_audio
                    else "ИИдеал Авто • Консультация диагноста"
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
                    "Вы можете загрузить лог сканера (.txt, .csv, .pdf, .obd) или фото с камеры.",
                ],
                follow_up_question="Какой автомобиль диагностируем и какие симптомы наблюдаются?",
                tool_calls=tool_calls,
                vehicle_detected=vehicle_info,
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

        primary_dtc_systems = {card.get("system", "engine") for card in dtc_cards.values()} if dtc_cards else set()
        for hit in rag_hits[:3]:
            meta = hit["meta"]
            code = meta.get("code", "N/A")
            if code in seen_codes or len(faults) >= 3:
                continue
            # Если пользователь указал конкретный код DTC (например P0171), не подмешиваем шумные коды из других систем
            hit_sys = meta.get("system", "engine")
            if primary_dtc_systems and hit_sys not in primary_dtc_systems and float(hit.get("score", 0.0)) < 1.5:
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
                    for sub_act in re.split(r";|\.(?!\d)", sol):
                        clean_act = sub_act.strip(" .;")
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
        dialog_state: Optional[Dict[str, Any]] = None,
        cancel_event: Optional[threading.Event] = None,
    ) -> Optional[str]:
        if cancel_event and cancel_event.is_set():
            raise GenerationCancelledError("Генерация диагностического ответа отменена пользователем.")
        if os.environ.get("AUTODIAG_FAST_TEST") == "1":
            return None
        dialog_state = dialog_state or {}

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
                    pil_img.thumbnail((640, 640))
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
        is_greeting_or_casual = (
            dialog_state.get("is_greeting", False)
            and not has_images
            and not doc_analyses
            and not has_native_audio
        )
        is_followup = bool(dialog_state.get("is_followup", False))
        vehicle_info = (dialog_state.get("vehicle_info") or "").strip()
        active_codes = dialog_state.get("active_codes") or []

        profile = self._autotune_profile
        prose_hint = profile.prose_word_hint if profile else "80–115 слов"
        rag_top_n = profile.rag_top_n if profile else 2
        compact_json = bool(profile.compact_json) if profile else False
        max_mem_chars = profile.max_memory_chars if profile else 1000
        if compact_json and not is_followup:
            # На 8 ГБ GPU не раздуваем первичный промпт старыми несвязанными диалогами (экономим prefill и VRAM)
            max_mem_chars = min(max_mem_chars, 320)
        if global_summary and len(global_summary) > max_mem_chars:
            global_summary = "…" + global_summary[-max_mem_chars:]
        if dialog_summary and len(dialog_summary) > max_mem_chars:
            dialog_summary = "…" + dialog_summary[-max_mem_chars:]

        if compact_json:
            json_schema_hint_diag = (
                "\n\nФОРМАТ ВЫВОДА:\n"
                f"1) Сначала 2–3 ёмких предложения на русском ({prose_hint}, без воды: точная физическая причина и контрольные цифры Live Data).\n"
                "2) Сразу в конце добавь ОДИН компактный однострочный блок ```json ... ``` БЕЗ mentor_reply:\n"
                "```json\n"
                '{"response_type":"diagnosis","summary_title":"Заголовок до 6 слов","vehicle_detected":"Марка Модель Двигатель","faults":[{"code":"P0171","system":"engine","title":"Суть причины","severity":"warning","confidence":90,"root_cause":"Краткая причина"}],"repair_steps":[{"title":"Шаг 1","instruction":"Конкретное действие и норма"},{"title":"Шаг 2","instruction":"Следующая проверка"}],"follow_up_question":"Один точный вопрос диагноста"}\n'
                "```\n"
                "Правила: 1–2 faults, ровно 2 кратких repair_steps (без повтора текста из абзаца и без повтора заменённого); "
                "MPI 3.5–4.0 бар, GDI/TSI низкое 3.5–6 бар / рампа 40–150 бар, норма STFT/LTFT ±5–8%. "
                "system: engine, cooling, transmission, brakes, electrical, suspension, chassis, hybrid, battery."
            )
        else:
            json_schema_hint_diag = (
                "\n\nФОРМАТ ВЫВОДА:\n"
                f"1) Сначала напиши ёмкий и точный разбор на русском ({prose_hint}, без приветствий и воды: физическая причина, точные ориентиры замеров).\n"
                "2) Затем сразу в конце добавь ОДИН компактный блок ```json ... ``` БЕЗ поля mentor_reply:\n"
                "```json\n"
                "{\n"
                '  "response_type": "diagnosis",\n'
                '  "summary_title": "Заголовок до 7 слов",\n'
                '  "vehicle_detected": "Марка Модель Двигатель (если известны)",\n'
                '  "faults": [{"code": "P0300", "system": "engine", "system_ru": "Двигатель", "title": "Короткое название", "severity": "warning", "confidence": 90, "health_index": 70, "root_cause": "Короткая причина"}],\n'
                '  "inventory": [{"name": "Нужный инструмент", "category": "tool", "spec": "Допуск", "required": true}],\n'
                '  "repair_steps": [{"step_number": 1, "title": "Шаг", "instruction": "Краткое действие", "torque_or_spec": "Эталон"}],\n'
                '  "recommendations": ["1 краткий практический совет"],\n'
                '  "follow_up_question": "Один точный вопрос диагноста"\n'
                "}\n"
                "```\n"
                "Правила точности: строго 1–2 faults, 2–3 inventory и 3 repair_steps (от простого к сложному, без повтора уже заменённого); "
                "различай MPI (3.5–4.0 бар) и GDI/TSI (низкое до ТНВД 3.5–6 бар, высокое в рампе 40–150 бар); для STFT/LTFT указывай рабочую норму ±5–8%. "
                "Допустимые system: engine, cooling, transmission, brakes, electrical, suspension, chassis, hybrid, battery."
            )

        json_schema_hint_followup = (
            "\n\nФОРМАТ ВЫВОДА:\n"
            f"1) Сразу дай прямой, толковый ответ на русском ({prose_hint}, без приветствий и без повтора исключённых версий; для GDI давление в рампе 40–150 бар, норма коррекций ±5–8%).\n"
            "2) В самом конце добавь компактный блок ```json ... ``` БЕЗ mentor_reply:\n"
            "```json\n"
            "{\n"
            '  "response_type": "followup",\n'
            '  "summary_title": "Заголовок шага до 6 слов",\n'
            '  "vehicle_detected": "Марка Модель Двигатель (если известны)",\n'
            '  "faults": [],\n'
            '  "inventory": [],\n'
            '  "repair_steps": [],\n'
            '  "follow_up_question": "Один конкретный вопрос по следующему замеру"\n'
            "}\n"
            "```\n"
            "Оставляй faults, inventory и repair_steps пустыми [], заполняй только при смене диагноза."
        )

        if has_images:
            vision_schema_hint = (
                json_schema_hint_diag
                .replace('"response_type": "diagnosis"', '"response_type": "visual_inspection"')
                .replace('"response_type":"diagnosis"', '"response_type":"visual_inspection"')
                .replace(prose_hint, "55–85 слов")
            )
            sys_prompt = (
                "Ты — ИИдеал Авто (AIdeal Auto), ведущий автодиагност и автоэлектрик. "
                "К запросу ПРИКРЕПЛЕНА ФОТОГРАФИЯ (передана напрямую в Gemma 4 Vision)."
                + (
                    " Также передана АУДИОЗАПИСЬ речи мастера (нативно в Gemma 4 embed_audio). "
                    if has_native_audio
                    else " "
                )
                + "Внимательно осмотри фото"
                + (" и прослушай аудио! " if has_native_audio else "! ")
                + "Не проси прислать фото или аудио повторно. "
                "1) Определи двигатель/узел на фото и чётко укажи по видимым на изображении ориентирам (крышка мотора, гофрированный воздуховод, корпус воздушного фильтра, бачки, разъёмы), где именно на этом фото расположен искомый узел или дефект; "
                "2) Объясни физическую причину симптомов; "
                "3) Дай практический порядок проверки/чистки и адаптации с конкретными параметрами. "
                "Без банальных инструкций и без лишней воды."
                + vision_schema_hint
            )
            extra_notes = []
            if vehicle_info:
                extra_notes.append(f"Авто: {vehicle_info}")
            if dtc_cards:
                extra_notes.append("Коды DTC: " + ", ".join(dtc_cards.keys()))
            if doc_analyses:
                doc_summaries = []
                for d in doc_analyses:
                    mode_lbl = "полный текст" if d.get("is_fully_processed", True) else "умная выборка"
                    doc_snippet = d.get("llm_ready_text") or d.get("raw_excerpt") or d.get("text_snippet") or ""
                    doc_summaries.append(f"Вложен документ {d['filename']} ({mode_lbl}): {doc_snippet[:3500]}")
                extra_notes.append("\n".join(doc_summaries))
            if has_native_audio:
                extra_notes.append("Прикреплена аудиозапись мастера (Gemma 4 embed_audio)")
            notes_str = f" [Контекст: {'; '.join(extra_notes)}]" if extra_notes else ""
            if has_native_audio:
                user_prompt_text = (
                    f"Изучи прикреплённое фото и внимательно прослушай голосовой вопрос мастера.{notes_str}\n"
                    f"Дай точное заключение автодиагноста."
                )
            else:
                user_prompt_text = f"Изучи прикреплённое фото узла автомобиля и дай заключение диагноста.{notes_str}\nВопрос мастера: {query}"
            if dialog_summary:
                user_prompt_text = f"[Сводка ранней истории: {dialog_summary}]\n{user_prompt_text}"

        elif is_greeting_or_casual:
            sys_prompt = (
                "Ты — ИИдеал Авто (AIdeal Auto), опытный и доброжелательный инженер-автодиагност. "
                "Ответь живо, кратко и естественно (2–4 предложения). Если это приветствие — представься кратко и "
                "предложи описать симптомы, указать марку/двигатель автомобиля или код ошибки OBD-II."
            )
            user_prompt_text = query
            if dialog_summary:
                user_prompt_text = f"[Контекст: {dialog_summary}]\nСообщение: {query}"

        elif has_native_audio and not rag_hits and not dtc_cards:
            sys_prompt = (
                "Ты — ИИдеал Авто (AIdeal Auto), опытный инженер-диагност. "
                "К запросу прикреплена аудиозапись (Gemma 4 embed_audio). "
                "Прослушай русскую речь мастера или звуки работы узла (стуки, вой, свист, перебои): "
                "прямо ответь на вопрос или разбери акустический признак и дай чёткий план проверки. Не проси прислать аудио снова."
                + (json_schema_hint_followup if is_followup else json_schema_hint_diag)
            )
            ctx_prefix = f"[Автомобиль: {vehicle_info}]\n" if vehicle_info else ""
            if query and not any(query.strip().startswith(p) for p in ("Голосовой запрос", "Голосовой вопрос", "Аудиозапись")):
                user_prompt_text = f"{ctx_prefix}Мастер прикрепил аудиозапись и пояснил: «{query}».\nПрослушай аудио и дай точный разбор."
            else:
                user_prompt_text = f"{ctx_prefix}Мастер отправил голосовой запрос.\nПрослушай речь/звук в аудиозаписи и дай практический разбор."
            if dialog_summary:
                user_prompt_text = f"[Сводка ранней истории: {dialog_summary}]\n{user_prompt_text}"

        elif is_followup:
            extra_docs_text = "\n\n".join(
                f"=== Документ: {d['filename']} ===\n"
                f"{d.get('llm_ready_text', d.get('extracted_text', d.get('raw_excerpt', '')))}"
                for d in doc_analyses
            )
            rag_context = self.rag_engine.prepare_llm_context(
                query=query,
                top_n=2,
                dtc_codes=list(dtc_cards.keys()),
                extra_docs_text=extra_docs_text or None,
                dialog_summary=dialog_summary,
                global_summary=global_summary,
                vehicle_info=vehicle_info,
                precomputed_hits=rag_hits[:2] if rag_hits else [],
            )
            active_codes_note = f"Активные коды сессии: {', '.join(active_codes)}. " if active_codes else ""
            sys_prompt = (
                "Ты — ИИдеал Авто (AIdeal Auto), ведущий автодиагност в живом диалоге с мастером/владельцем. "
                + active_codes_note
                + "Это ПРОДОЛЖЕНИЕ диагностики: пользователь сообщил новые результаты проверки/замеры или задал уточняющий вопрос. "
                "Правила: "
                "1) Исключи всё, что уже заменено или проверено в норме по истории диалога — не повторяй эти советы; "
                "2) Проанализируй новые факты/цифры с учётом конструкции конкретного двигателя/КПП; "
                "3) Назови 1–3 следующие самые вероятные причины и точные контрольные значения; "
                "4) Отвечай без приветствий, ёмко и по делу."
                + json_schema_hint_followup
            )
            user_prompt_text = rag_context

        else:
            extra_docs_text = "\n\n".join(
                f"=== Документ: {d['filename']} ({'Полный текст без сокращений' if d.get('is_fully_processed', True) else 'Интеллектуальная диагностическая выборка'}) ===\n"
                f"{d.get('llm_ready_text', d.get('extracted_text', d.get('raw_excerpt', '')))}"
                for d in doc_analyses
            )
            rag_context = self.rag_engine.prepare_llm_context(
                query=query,
                top_n=rag_top_n,
                dtc_codes=list(dtc_cards.keys()),
                extra_docs_text=extra_docs_text or None,
                dialog_summary=dialog_summary,
                global_summary=global_summary,
                vehicle_info=vehicle_info,
                precomputed_hits=rag_hits[:rag_top_n] if rag_hits else [],
            )
            sys_prompt = (
                "Ты — ИИдеал Авто (AIdeal Auto), ведущий инженер-автодиагност и автоэлектрик. "
                + (
                    "К запросу прикреплена АУДИОЗАПИСЬ (нативно в embed_audio). Прослушай её! "
                    if has_native_audio
                    else ""
                )
                + "Дай профессиональный, практичный разбор без воды и без очевидных бытовых советов (не пиши 'наденьте перчатки' или 'обратитесь в сервис'). "
                "1) Физическая первопричина и специфика указанного автомобиля/двигателя; "
                "2) Конкретные параметры и точки замера (сканер Live Data, коррекции STFT/LTFT, давление, сопротивление/падение напряжения, осциллограф); "
                "3) Рациональный порядок проверок от простого к сложному (чётко и компактно, без воды)."
                + json_schema_hint_diag
            )
            user_prompt_text = rag_context
            if has_native_audio:
                user_prompt_text += "\n\n[Примечание]: Учти голосовую запись мастера из нативного аудиовхода."

        # Собираем сообщения диалога (сохраняем последние 5 вопросов пользователя и 5 ответов ИИ)
        chat_messages: List[Dict[str, Any]] = [
            {"role": "system", "content": [{"type": "text", "text": sys_prompt}]}
        ]

        # Добавляем последние 10 сообщений (5 пар «пользователь - ассистент») с полным техническим контекстом
        recent_window = recent_messages[-(RECENT_EXCHANGES_TO_KEEP * 2):] if recent_messages else []
        for msg in recent_window:
            if msg.role == "user" and (msg.content or "").strip():
                chat_messages.append(
                    {
                        "role": "user",
                        "content": [{"type": "text", "text": (msg.content or "").strip()[:1200]}],
                    }
                )
            elif msg.role == "assistant":
                core_reply = format_assistant_core_memory(msg, max_chars=1400)
                if core_reply:
                    chat_messages.append(
                        {
                            "role": "assistant",
                            "content": [{"type": "text", "text": core_reply}],
                        }
                    )

        # Формируем текущее сообщение пользователя с нативными мультимодальными вложениями
        user_content_items: List[Dict[str, Any]] = []
        for pil_img in pil_images:
            user_content_items.append({"type": "image", "image": pil_img})
        if audio_waveform_16k is not None and len(audio_waveform_16k) > 0:
            user_content_items.append({"type": "audio", "audio": audio_waveform_16k})

        user_content_items.append({"type": "text", "text": user_prompt_text})
        chat_messages.append({"role": "user", "content": user_content_items})

        t_start = time.perf_counter()
        with self._model_lock:
            if cancel_event and cancel_event.is_set():
                raise GenerationCancelledError("Генерация диагностического ответа отменена пользователем.")
            try:
                use_thinking = bool(profile and profile.enable_thinking and not is_greeting_or_casual)
                try:
                    prompt_str = processor.apply_chat_template(
                        chat_messages,
                        tokenize=False,
                        add_generation_prompt=True,
                        enable_thinking=use_thinking,
                    )
                except TypeError:
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
                available_ctx = max(400, ctx_limit - input_len)
                env_max_new = int(os.environ.get("GEMMA_MAX_NEW_TOKENS", "0") or 0)
                if env_max_new > 0:
                    target_max_new = min(env_max_new, available_ctx)
                elif is_greeting_or_casual:
                    target_max_new = min(profile.max_new_tokens_greeting if profile else 120, available_ctx)
                elif is_followup:
                    target_max_new = min(profile.max_new_tokens_followup if profile else 320, available_ctx)
                elif has_images:
                    # Для Vision-инспекции нужен запас токенов на ориентиры по фото + компактный JSON
                    target_max_new = min(max(profile.max_new_tokens_diag if profile else 340, 300), available_ctx)
                else:
                    target_max_new = min(profile.max_new_tokens_diag if profile else 460, available_ctx)

                tok = getattr(processor, "tokenizer", processor)
                # Токены завершения хода Gemma 4: 1=<eos>, 106=<turn|>, 105=<|turn>.
                # ВАЖНО: НЕ добавлять 101 (<channel|>) — иначе генерация оборвётся сразу после thought до ответа!
                eos_ids = [1, 106, 105]
                tok_eos = getattr(tok, "eos_token_id", None)
                if tok_eos is not None:
                    if isinstance(tok_eos, list):
                        for eid in tok_eos:
                            if int(eid) not in (101, 107) and int(eid) not in eos_ids:
                                eos_ids.append(int(eid))
                    elif int(tok_eos) not in (101, 107) and int(tok_eos) not in eos_ids:
                        eos_ids.append(int(tok_eos))

                gen_temp = 0.55 if is_greeting_or_casual else 0.35

                from transformers import StoppingCriteria, StoppingCriteriaList

                if is_greeting_or_casual:
                    max_time_sec = profile.max_time_sec_greeting if profile else 30.0
                elif is_followup:
                    max_time_sec = profile.max_time_sec_followup if profile else 50.0
                elif has_images:
                    # Мультимодальный Vision-проход включает embed_vision prefill + визуальное описание + JSON
                    base_diag = profile.max_time_sec_diag if profile else 60.0
                    max_time_sec = max(base_diag, 260.0)
                else:
                    max_time_sec = profile.max_time_sec_diag if profile else 60.0

                class SmartDiagnosticStoppingCriteria(StoppingCriteria):
                    """
                    Умная остановка генерации без преждевременного обрыва:
                    - Останавливает по cancel_event, SLA-таймауту или реальному маркеру конца хода (<eos>/<turn|>).
                    - Для диагностического режима проверяет завершение ТОЛЬКО после закрывающего ```
                      и успешного разбора JSON (никогда не обрывает на открывающем ```json\\n!).
                    """

                    def __init__(self, ev, tokenizer, in_len: int, is_greet: bool, max_time: float):
                        self.ev = ev
                        self.tokenizer = tokenizer
                        self.input_len = in_len
                        self.is_greeting = is_greet
                        self.max_time = max_time
                        self.start_t = time.perf_counter()
                        self.stop_ids = {1, 106, 105}

                    def __call__(self, input_ids: torch.LongTensor, scores: torch.FloatTensor, **kwargs) -> torch.BoolTensor:
                        bsz = input_ids.shape[0]
                        dev = input_ids.device
                        if self.ev is not None and self.ev.is_set():
                            return torch.full((bsz,), True, device=dev, dtype=torch.bool)
                        if (time.perf_counter() - self.start_t) >= self.max_time:
                            return torch.full((bsz,), True, device=dev, dtype=torch.bool)
                        cur_len = input_ids.shape[-1]
                        if cur_len > self.input_len:
                            last_id = int(input_ids[0, -1].item())
                            if last_id in self.stop_ids:
                                return torch.full((bsz,), True, device=dev, dtype=torch.bool)
                            new_cnt = cur_len - self.input_len
                            if not self.is_greeting and new_cnt >= 45:
                                piece = self.tokenizer.decode([last_id], skip_special_tokens=False)
                                if "`" in piece or last_id == 107:
                                    full_gen = self.tokenizer.decode(
                                        input_ids[0, self.input_len :].tolist(),
                                        skip_special_tokens=False,
                                    )
                                    visible = re.sub(
                                        r"<\|channel>thought.*?<channel\|>",
                                        "",
                                        full_gen,
                                        flags=re.DOTALL,
                                    )
                                    fence_m = re.search(
                                        r"```(?:json)?\s*(\{.*?\})\s*```",
                                        visible,
                                        flags=re.DOTALL,
                                    )
                                    if fence_m:
                                        try:
                                            json.loads(fence_m.group(1))
                                            return torch.full((bsz,), True, device=dev, dtype=torch.bool)
                                        except Exception:
                                            pass
                        return torch.full((bsz,), False, device=dev, dtype=torch.bool)

                stopping_criteria = StoppingCriteriaList([
                    SmartDiagnosticStoppingCriteria(
                        ev=cancel_event,
                        tokenizer=tok,
                        in_len=input_len,
                        is_greet=is_greeting_or_casual,
                        max_time=max_time_sec,
                    )
                ])

                with torch.inference_mode():
                    gen_ids = model.generate(
                        **model_inputs,
                        max_new_tokens=target_max_new,
                        eos_token_id=eos_ids,
                        pad_token_id=tok.pad_token_id if hasattr(tok, "pad_token_id") and tok.pad_token_id is not None else 0,
                        do_sample=True,
                        temperature=gen_temp,
                        top_p=0.92,
                        top_k=64,
                        repetition_penalty=1.07,
                        use_cache=True,
                        stopping_criteria=stopping_criteria,
                    )

                if cancel_event and cancel_event.is_set():
                    raise GenerationCancelledError("Генерация диагностического ответа отменена пользователем.")

                new_tokens = gen_ids[0][input_len:]
                # Сначала декодируем со специальными токенами, чтобы гарантированно вырезать теги рассуждений
                raw_with_specials = tok.decode(new_tokens, skip_special_tokens=False)
                raw_cleaned = re.sub(r"<\|channel>thought.*?<channel\|>", "", raw_with_specials, flags=re.DOTALL)
                raw_cleaned = re.sub(r"<think>.*?</think>", "", raw_cleaned, flags=re.DOTALL)
                raw_cleaned = re.sub(r"^thought\s*\n.*?(?=(?:\n(?:[А-ЯA-Z#*]|На|В|Для|По|Про|При|Шаг|Симптом)|\Z))", "", raw_cleaned, flags=re.DOTALL)
                decoded = re.sub(r"<\|[^>]+>|<[^>]+channel\|>|<turn\|>|<\|turn>|<pad>", "", raw_cleaned).strip()

                self._last_inference_ms = int((time.perf_counter() - t_start) * 1000)
                logger.info(
                    "[AirLLM Gemma 4] Ответ сгенерирован за %d мс (in=%d, out=%d/%d токенов, %.2f tok/s, temp=%.2f, mode=%s, thinking=%s).",
                    self._last_inference_ms,
                    input_len,
                    len(new_tokens),
                    target_max_new,
                    (len(new_tokens) / max(0.1, self._last_inference_ms / 1000.0)),
                    gen_temp,
                    "greeting" if is_greeting_or_casual else ("followup" if is_followup else "diag"),
                    use_thinking,
                )
                return decoded
            except GenerationCancelledError:
                logger.info("[AirLLM Gemma 4] Генерация прервана по событию отмены.")
                raise
            except Exception as exc:
                logger.error("[AirLLM Gemma 4] Ошибка во время генерации: %s", exc)
                return None
            finally:
                if hasattr(model, "clear_prefetch_cache"):
                    model.clear_prefetch_cache()
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
        cancel_event: Optional[threading.Event] = None,
    ) -> DiagnosticStructuredResponse:
        """
        Полный цикл обработки запроса:
        1. Анализ состояния диалога (первичная диагностика vs уточняющий шаг vs приветствие).
        2. Function Calling (поиск по словарю DTC, гибридный RAG BERT + FAISS + BM25, инспекция медиа).
        3. Генерация ответа через AirLLM Google Gemma 4 12B на GPU.
        4. Разбор гибридного вывода (текст диагноста + компактный JSON) и автообрезка по последнему предложению.
        """
        if cancel_event and cancel_event.is_set():
            raise GenerationCancelledError("Генерация диагностического ответа отменена пользователем.")

        tool_calls, rag_hits, dtc_cards = self.execute_function_calls(
            query=query,
            attached_codes=attached_codes,
            image_analyses=image_analyses,
            doc_analyses=doc_analyses,
            voice_info=voice_info,
        )

        if cancel_event and cancel_event.is_set():
            raise GenerationCancelledError("Генерация диагностического ответа отменена пользователем.")

        dialog_state = self._analyze_dialog_state(
            query=query,
            recent_messages=recent_messages,
            attached_codes=attached_codes,
            dtc_cards=dtc_cards,
            has_images=bool(image_analyses),
            has_docs=bool(doc_analyses),
            vehicle_info=getattr(session, "vehicle_info", "") or "",
        )

        # На уточняющем шаге подтягиваем контекст активных кодов сессии, если запрос не назвал новых кодов
        if dialog_state["is_followup"] and not dtc_cards and dialog_state["active_codes"]:
            for active_c in dialog_state["active_codes"][:2]:
                card = self.rag_engine.get_dtc_details(active_c)
                if card:
                    dtc_cards[active_c] = card

        if settings_obj is None:
            try:
                from .models import SystemSettings
                settings_obj = SystemSettings.get_active()
            except Exception:
                settings_obj = None

        global_summary = (
            settings_obj.global_memory_summary
            if settings_obj and settings_obj.cross_dialog_memory_enabled
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
            is_followup=dialog_state["is_followup"],
            vehicle_info=dialog_state["vehicle_info"],
        )

        llm_output = self._run_airllm_inference(
            query=query,
            rag_hits=rag_hits,
            dtc_cards=dtc_cards,
            recent_messages=recent_messages,
            image_analyses=image_analyses,
            doc_analyses=doc_analyses,
            voice_info=voice_info,
            dialog_summary=getattr(session, "summary", "") or "",
            global_summary=global_summary or "",
            settings_obj=settings_obj,
            dialog_state=dialog_state,
            cancel_event=cancel_event,
        )

        if cancel_event and cancel_event.is_set():
            raise GenerationCancelledError("Генерация диагностического ответа отменена пользователем.")

        if llm_output:
            validated = validate_and_coerce_structured_json(
                raw_output=llm_output,
                fallback_response=scaffolding,
            )
            if not validated.tool_calls:
                validated.tool_calls = tool_calls
            if dialog_state["is_greeting"] and not image_analyses and not doc_analyses and not attached_codes:
                validated.response_type = "general"
                validated.faults = []
                validated.inventory = []
                validated.repair_steps = []
            if not validated.vehicle_detected and dialog_state["vehicle_info"]:
                validated.vehicle_detected = dialog_state["vehicle_info"]
            return validated

        # Резервный ответ при AUTODIAG_FAST_TEST=1 или при отсутствии весов модели
        if not scaffolding.mentor_reply:
            fault_lines = [
                f"• **{f.code}** ({f.system_ru}): {f.title} — *Индекс здоровья: {f.health_index}%*"
                for f in scaffolding.faults
            ]
            scaffolding.mentor_reply = (
                "Выполнен анализ запроса по локальной базе знаний и телеметрии.\n\n"
                + ("\n".join(fault_lines) if fault_lines else "Опишите результаты проверки или уточните симптомы для следующего шага.")
            )
            scaffolding.mentor_reply = truncate_to_last_sentence(scaffolding.mentor_reply)
        return scaffolding

    def generate_diagnostic_response(
        self,
        query: str,
        session=None,
        settings_obj=None,
        recent_messages: Optional[List[Any]] = None,
        attached_codes: Optional[List[str]] = None,
        image_analyses: Optional[List[Dict[str, Any]]] = None,
        doc_analyses: Optional[List[Dict[str, Any]]] = None,
        voice_info: Optional[Dict[str, Any]] = None,
        cancel_event: Optional[threading.Event] = None,
        **kwargs,
    ) -> DiagnosticStructuredResponse:
        """
        Основной цикл генерации диагностического ответа с проверкой Event отмены.
        При установленном Event немедленно прерывает инференс, освобождая блокировки.
        """
        if cancel_event and cancel_event.is_set():
            raise GenerationCancelledError("Генерация диагностического ответа отменена пользователем.")
        return self.diagnose_and_respond(
            query=query,
            session=session,
            settings_obj=settings_obj,
            recent_messages=recent_messages or [],
            attached_codes=attached_codes or [],
            image_analyses=image_analyses or [],
            doc_analyses=doc_analyses or [],
            voice_info=voice_info,
            cancel_event=cancel_event,
        )


# Глобальный экземпляр оркестратора AirLLM Gemma 4 12B
orchestrator = AirLLMVulkanOrchestrator()
