"""
Автоматический стартовый бенчмарк и калибратор параметров инференса AirLLM Google Gemma 4 12B.

При первом запуске сервера (или при смене GPU / существенном изменении свободной VRAM)
выполняет быструю калибровку (~10-18 с) прямо на загруженной модели без повторного чтения
шардов с диска:
1. Подбирает оптимальное число резидентных слоёв в GPU VRAM (`optimal_gpu_layers`),
   измеряя реальную скорость декодирования (`decode_tps`) и контролируя отсутствие
   падения в Windows WDDM Shared GPU Memory (сохраняя безопасный запас VRAM).
2. Измеряет `prefill_ms` и `decode_tps` на типовом диагностическом промпте.
3. Вычисляет оптимальные бюджеты токенов (`max_new_tokens_diag`, `max_new_tokens_followup`,
   `max_new_tokens_greeting`), целевые слова прозы, `rag_top_n`, таймауты и режим
   `enable_thinking`, дающие максимальное качество ответа в пределах целевого SLA (по умолчанию <= 55-60 с).
4. Кэширует локальный профиль в `models/airllm_shards/autotune_profile.json`
   (файл исключён из Git, поэтому на каждом новом устройстве перекалибровка проходит автоматически).

Лицензия: GPL-3.0
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

import torch

logger = logging.getLogger("diagnostics.autotune")

AUTOTUNE_SCHEMA_VERSION = 2
DEFAULT_TARGET_SLA_SEC = 55.0
VRAM_BUCKET_STEP_MB = 512


@dataclass
class AirLLMAutotuneProfile:
    schema_version: int = AUTOTUNE_SCHEMA_VERSION
    gpu_name: str = "CPU"
    vram_total_mb: int = 0
    vram_free_bucket_mb: int = 0
    target_sla_sec: float = DEFAULT_TARGET_SLA_SEC

    optimal_gpu_layers: int = 24
    streamed_layers: int = 24
    prefill_ms: int = 3000
    decode_tps: float = 3.0
    min_free_vram_mb: int = 900

    max_new_tokens_diag: int = 440
    max_new_tokens_followup: int = 300
    max_new_tokens_greeting: int = 120

    max_time_sec_diag: float = 60.0
    max_time_sec_followup: float = 48.0
    max_time_sec_greeting: float = 25.0

    enable_thinking: bool = False
    compact_json: bool = False
    rag_top_n: int = 3
    max_memory_chars: int = 1200
    prose_word_hint: str = "80–120 слов"
    source: str = "default"
    calibrated_at: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "AirLLMAutotuneProfile":
        valid_fields = {f for f in cls.__dataclass_fields__.keys()}
        filtered = {k: v for k, v in (data or {}).items() if k in valid_fields}
        return cls(**filtered)


def get_autotune_profile_path(shards_dir: Path) -> Path:
    return Path(shards_dir) / "autotune_profile.json"


def compute_vram_bucket_mb(free_vram_mb: int) -> int:
    if free_vram_mb <= 0:
        return 0
    return (int(free_vram_mb) // VRAM_BUCKET_STEP_MB) * VRAM_BUCKET_STEP_MB


def compute_optimal_profile(
    *,
    gpu_name: str,
    vram_total_mb: int,
    vram_free_bucket_mb: int,
    optimal_gpu_layers: int,
    prefill_ms: int,
    decode_tps: float,
    min_free_vram_mb: int,
    target_sla_sec: float = DEFAULT_TARGET_SLA_SEC,
    source: str = "benchmark",
) -> AirLLMAutotuneProfile:
    """
    По реально измеренным `prefill_ms` и `decode_tps` вычисляет параметры генерации,
    максимизирующие глубину ответа и полноту JSON при удержании времени ответа в пределах `target_sla_sec` (<= 60 с).
    """
    sla = max(25.0, min(180.0, float(target_sla_sec)))
    prefill_sec = max(0.2, float(prefill_ms) / 1000.0)
    tps = max(0.3, float(decode_tps))

    # Оставляем 2.5 с запас под RAG/парсинг JSON/сеть
    usable_decode_sec = max(12.0, sla - prefill_sec - 2.5)
    raw_diag_budget = int(usable_decode_sec * tps)

    # При 3–6 tok/s (8 ГБ GPU) переводим JSON в компактный высокосигнальный формат,
    # чтобы Gemma 4 гарантированно укладывала и экспертный текст, и закрытый JSON в <= 60 с.
    compact_json = bool(raw_diag_budget < 340)

    # Даём небольшой запас по токенам (+15%), а жёсткой границей SLA выступает max_time_sec_diag
    max_new_diag = max(230, min(960, int(raw_diag_budget * 1.15)))
    max_new_followup = max(180, min(680, int(max_new_diag * 0.72)))
    max_new_greeting = max(85, min(150, int(max(95, usable_decode_sec * tps * 0.35))))

    # Режим внутреннего рассуждения (thinking) выгоден только когда скорость позволяет
    # уложить thought + полноценный ответ + JSON в SLA <= 55-60 с.
    enable_thinking = bool(tps >= 11.0 and raw_diag_budget >= 580)
    if enable_thinking:
        # Добавляем резерв под скрытую цепочку рассуждений в пределах SLA
        max_new_diag = min(1150, max_new_diag + 160)

    # Компактность RAG-контекста и лимит междиалоговой памяти под измеренную скорость GPU
    rag_top_n = 3 if (prefill_sec <= 4.5 and tps >= 4.0) else 2
    if tps >= 10.0:
        max_memory_chars = 4000
    elif tps >= 3.8:
        max_memory_chars = 1200
    else:
        max_memory_chars = 650

    # Подсказываем модели целевую длину текстовой части в соответствии с бюджетом,
    # чтобы она всегда успевала закрыть блок ```json ... ``` без обрыва.
    if raw_diag_budget >= 400:
        prose_word_hint = "100–150 слов"
    elif raw_diag_budget >= 240:
        prose_word_hint = "60–85 слов"
    else:
        prose_word_hint = "30–45 слов"

    max_time_diag = round(min(max(sla + 4.0, 45.0), 60.0 if sla <= 56.0 else 95.0), 1)
    max_time_followup = round(min(max(sla * 0.85, 35.0), 75.0), 1)
    max_time_greeting = round(min(max(sla * 0.48, 22.0), 38.0), 1)

    return AirLLMAutotuneProfile(
        schema_version=AUTOTUNE_SCHEMA_VERSION,
        gpu_name=gpu_name,
        vram_total_mb=int(vram_total_mb),
        vram_free_bucket_mb=int(vram_free_bucket_mb),
        target_sla_sec=round(sla, 1),
        optimal_gpu_layers=int(optimal_gpu_layers),
        streamed_layers=max(0, 48 - int(optimal_gpu_layers)),
        prefill_ms=int(prefill_ms),
        decode_tps=round(tps, 2),
        min_free_vram_mb=int(min_free_vram_mb),
        max_new_tokens_diag=int(max_new_diag),
        max_new_tokens_followup=int(max_new_followup),
        max_new_tokens_greeting=int(max_new_greeting),
        max_time_sec_diag=max_time_diag,
        max_time_sec_followup=max_time_followup,
        max_time_sec_greeting=max_time_greeting,
        enable_thinking=enable_thinking,
        compact_json=compact_json,
        rag_top_n=rag_top_n,
        max_memory_chars=max_memory_chars,
        prose_word_hint=prose_word_hint,
        source=source,
        calibrated_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
    )


def load_cached_profile(
    shards_dir: Path,
    *,
    gpu_name: str,
    vram_total_mb: int,
    vram_free_bucket_mb: int,
    target_sla_sec: float,
) -> Optional[AirLLMAutotuneProfile]:
    """Загружает кэшированный локальный профиль калибровки, если железо и SLA совпадают."""
    if os.environ.get("AIRLLM_RECALIBRATE") == "1":
        return None
    path = get_autotune_profile_path(shards_dir)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        prof = AirLLMAutotuneProfile.from_dict(data)
        if prof.schema_version != AUTOTUNE_SCHEMA_VERSION:
            return None
        if prof.gpu_name != gpu_name:
            return None
        if abs(prof.vram_total_mb - int(vram_total_mb)) > 256:
            return None
        # Если свободная VRAM изменилась более чем на 1024 МБ (например, закрыли/открыли тяжёлую программу), перекалибруем
        if abs(prof.vram_free_bucket_mb - int(vram_free_bucket_mb)) > 1024:
            return None
        if abs(prof.target_sla_sec - float(target_sla_sec)) > 2.0:
            return None
        if prof.decode_tps <= 0.1 or prof.optimal_gpu_layers < 0 or prof.optimal_gpu_layers > 48:
            return None
        prof.source = "cache"
        return prof
    except Exception as exc:
        logger.debug("[AutoTuner] Не удалось прочитать кэш калибровки %s: %s", path, exc)
        return None


def save_cached_profile(shards_dir: Path, profile: AirLLMAutotuneProfile) -> Path:
    path = get_autotune_profile_path(shards_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(profile.to_dict(), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return path


def _build_probe_inputs(processor, device: str) -> Tuple[Dict[str, Any], int]:
    """Собирает реалистичный калибровочный диагностический промпт (~550-650 токенов, как в реальном /api/ask/)."""
    probe_messages = [
        {
            "role": "system",
            "content": [
                {
                    "type": "text",
                    "text": (
                        "Ты — ИИдеал Авто (AIdeal Auto), ведущий инженер-автодиагност и автоэлектрик. "
                        "Дай профессиональный разбор без воды: 1) Физическая первопричина и специфика двигателя; "
                        "2) Конкретные параметры замера (Live Data, STFT/LTFT, давление топлива, вакуум); "
                        "3) Рациональный порядок проверок.\n\n"
                        "ФОРМАТ ВЫВОДА:\n"
                        "1) Сначала 2–3 ёмких предложения на русском (30–45 слов).\n"
                        "2) Сразу в конце добавь ОДИН компактный однострочный блок ```json ... ``` БЕЗ mentor_reply:\n"
                        '```json\n{"response_type":"diagnosis","summary_title":"Заголовок до 6 слов",'
                        '"vehicle_detected":"Марка Модель Двигатель","faults":[{"code":"P0171","system":"engine",'
                        '"title":"Суть причины","severity":"warning","confidence":90,"root_cause":"Краткая причина"}],'
                        '"repair_steps":[{"title":"Шаг 1","instruction":"Конкретное действие и норма"},'
                        '{"title":"Шаг 2","instruction":"Следующая проверка"}],'
                        '"follow_up_question":"Один точный вопрос диагноста"}\n```\n'
                        "Правила: MPI 3.5–4.0 бар, GDI/TSI низкое 3.5–6 бар / рампа 40–150 бар, норма STFT/LTFT ±5–8%."
                    ),
                }
            ],
        },
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": (
                        "[Релевантные прецеденты из экспертной базы знаний (BERT + BM25 + CrossEncoder)]:\n"
                        "1. Код: P0171 (Двигатель) | Релевантность: 3.753\n"
                        "   Симптомы: Слишком бедная топливовоздушная смесь (Bank 1), плавают обороты холостого хода, "
                        "провалы при разгоне, потеря мощности, шипение под капотом, высокий LTFT (> +15%)\n"
                        "   Причина: Подсос неучтённого воздуха во впуск (патрубки, прокладка коллектора, мембрана КВКГ/PCV, "
                        "клапан адсорбера EVAP), загрязнение ДМРВ (MAF), снижение давления топлива.\n"
                        "   Проверка и ремонт: Проверить STFT+LTFT на ХХ и при 2500 об/мин; опрессовать впуск дымогенератором; "
                        "проверить КВКГ; измерить давление топлива; проверить ДМРВ.\n"
                        "   Эталон телеметрии (66.0% HI): ltft: +18.2%, stft: +6.4%, rpm_idle: 780, maf_g_s: 2.1\n\n"
                        "[Текущий запрос мастера / симптомы]:\n"
                        "Skoda Octavia 1.8 TSI (CJSA), ошибка P0171, на холостых плавают обороты и свист под капотом, LTFT +18%"
                    ),
                }
            ],
        },
    ]
    try:
        prompt_str = processor.apply_chat_template(
            probe_messages,
            tokenize=False,
            add_generation_prompt=True,
            enable_thinking=False,
        )
    except TypeError:
        prompt_str = processor.apply_chat_template(
            probe_messages,
            tokenize=False,
            add_generation_prompt=True,
        )
    model_inputs = processor(text=[prompt_str], return_tensors="pt", padding=True)
    model_inputs = {
        k: (v.to(device) if isinstance(v, torch.Tensor) else v)
        for k, v in model_inputs.items()
    }
    in_len = int(model_inputs["input_ids"].shape[-1])
    return model_inputs, in_len


def _get_usable_free_vram_mb() -> int:
    """
    Возвращает реально доступную свободную VRAM (МБ) с учётом свободных блоков кэширующего
    аллокатора PyTorch (`memory_reserved - memory_allocated`), чтобы Windows WDDM не давал ложный 0 МБ.
    """
    if not torch.cuda.is_available():
        return 0
    free_b, _ = torch.cuda.mem_get_info(0)
    reserved_unalloc_b = max(0, torch.cuda.memory_reserved(0) - torch.cuda.memory_allocated(0))
    return int((free_b + reserved_unalloc_b) // (1024 * 1024))


def _measure_generation_speed(
    model,
    processor,
    model_inputs: Dict[str, Any],
    input_len: int,
    *,
    num_tokens: int = 7,
    max_probe_sec: float = 18.0,
) -> Tuple[int, float, int]:
    """
    Замеряет за один короткий вызов `model.generate`:
    - `prefill_ms` (время до генерации 1-го токена)
    - `decode_tps` (установившаяся скорость генерации токенов 2..N, tok/s)
    - `min_free_vram_mb` (минимальная доступная VRAM во время прогона)
    """
    from transformers import StoppingCriteria, StoppingCriteriaList

    is_cuda = torch.cuda.is_available() and str(getattr(model, "running_device", "")).startswith("cuda")
    step_timestamps: list[float] = []
    free_samples_mb: list[int] = []

    class _BenchmarkTimingCriteria(StoppingCriteria):
        def __init__(self, start_t: float, cap_sec: float):
            self.start_t = start_t
            self.cap_sec = cap_sec

        def __call__(self, input_ids: torch.LongTensor, scores: torch.FloatTensor, **kwargs) -> torch.BoolTensor:
            step_idx = len(step_timestamps)
            if is_cuda:
                torch.cuda.synchronize()
                # Снимаем замер VRAM только на 1-м шаге (пик после prefill), не тормозя WDDM-вызовами каждый токен!
                if step_idx == 0:
                    free_samples_mb.append(_get_usable_free_vram_mb())
            now = time.perf_counter()
            step_timestamps.append(now)
            stop = (now - self.start_t) >= self.cap_sec
            return torch.full((input_ids.shape[0],), stop, device=input_ids.device, dtype=torch.bool)

    if is_cuda:
        torch.cuda.empty_cache()
        torch.cuda.synchronize()

    tok = getattr(processor, "tokenizer", processor)
    pad_id = tok.pad_token_id if hasattr(tok, "pad_token_id") and tok.pad_token_id is not None else 0

    t0 = time.perf_counter()
    criteria = StoppingCriteriaList([_BenchmarkTimingCriteria(t0, max_probe_sec)])
    try:
        with torch.inference_mode():
            _ = model.generate(
                **model_inputs,
                max_new_tokens=max(3, int(num_tokens)),
                min_new_tokens=min(3, max(2, int(num_tokens) - 1)),
                do_sample=False,
                use_cache=True,
                pad_token_id=pad_id,
                stopping_criteria=criteria,
            )
    finally:
        if hasattr(model, "clear_prefetch_cache"):
            model.clear_prefetch_cache()
        if is_cuda:
            torch.cuda.synchronize()
            torch.cuda.empty_cache()

    if len(step_timestamps) == 0:
        total_ms = int((time.perf_counter() - t0) * 1000)
        return max(500, total_ms), 0.5, min(free_samples_mb) if free_samples_mb else 512

    prefill_ms = int(max(50.0, (step_timestamps[0] - t0) * 1000.0))
    if len(step_timestamps) >= 3:
        # Игнорируем 1-й шаг (prefill), считаем установившуюся скорость между шагом 1 и последним
        decode_span = max(0.01, step_timestamps[-1] - step_timestamps[0])
        decode_tps = (len(step_timestamps) - 1) / decode_span
    elif len(step_timestamps) == 2:
        decode_span = max(0.01, step_timestamps[1] - step_timestamps[0])
        decode_tps = 1.0 / decode_span
    else:
        total_span = max(0.1, time.perf_counter() - t0)
        decode_tps = 1.0 / total_span

    min_free_mb = min(free_samples_mb) if free_samples_mb else (
        _get_usable_free_vram_mb() if is_cuda else 0
    )
    return prefill_ms, round(float(decode_tps), 3), int(min_free_mb)


def run_startup_calibration(
    model,
    processor,
    shards_dir: Path,
    *,
    initial_free_vram_mb: int,
    target_sla_sec: Optional[float] = None,
) -> AirLLMAutotuneProfile:
    """
    Выполняет стартовую авто-калибровку числа резидентных слоёв GPU и лимитов генерации
    (либо применяет валидный кэшированный локальный профиль для текущего GPU и VRAM).
    """
    sla = float(
        target_sla_sec
        if target_sla_sec is not None
        else os.environ.get("AIRLLM_TARGET_SLA_SEC", str(DEFAULT_TARGET_SLA_SEC))
    )
    is_cuda = torch.cuda.is_available() and str(getattr(model, "running_device", "")).startswith("cuda")
    gpu_name = torch.cuda.get_device_name(0) if is_cuda else "CPU"
    vram_total_mb = int(torch.cuda.mem_get_info(0)[1] // (1024 * 1024)) if is_cuda else 0
    vram_bucket_mb = compute_vram_bucket_mb(initial_free_vram_mb)

    # 1. Проверяем локальный кэш калибровки (если не запрошена принудительная перекалибровка)
    cached = load_cached_profile(
        shards_dir,
        gpu_name=gpu_name,
        vram_total_mb=vram_total_mb,
        vram_free_bucket_mb=vram_bucket_mb,
        target_sla_sec=sla,
    )
    if cached is not None:
        if is_cuda and hasattr(model, "set_resident_layer_count"):
            cur_res = getattr(model, "resident_gpu_layers_count", 0)
            if cur_res != cached.optimal_gpu_layers:
                model.set_resident_layer_count(cached.optimal_gpu_layers)
        logger.info(
            "[AutoTuner] Применён кэшированный профиль (%s): %d/48 слоёв GPU | %.2f tok/s | "
            "diag=%d ток. | followup=%d ток. | thinking=%s | SLA=%.0f с.",
            cached.gpu_name,
            cached.optimal_gpu_layers,
            cached.decode_tps,
            cached.max_new_tokens_diag,
            cached.max_new_tokens_followup,
            cached.enable_thinking,
            cached.target_sla_sec,
        )
        return cached

    # 2. Запускаем живую калибровку на загруженной модели
    t_cal_start = time.perf_counter()
    print(
        f"[AirLLM AutoTuner] Запуск авто-калибровки на {gpu_name} "
        f"(целевой SLA <= {sla:.0f} с, стартовые слои GPU: {getattr(model, 'resident_gpu_layers_count', 0)}/48)...",
        flush=True,
    )

    device = getattr(model, "running_device", "cuda:0" if is_cuda else "cpu")
    model_inputs, input_len = _build_probe_inputs(processor, device)

    # Прогревочный 2-токенный шаг (инициализирует CUDA-ядра cuBLAS/SDPA/int4pack)
    _measure_generation_speed(model, processor, model_inputs, input_len, num_tokens=2, max_probe_sec=15.0)

    # Базовый замер на текущем числе слоёв
    best_layers = int(getattr(model, "resident_gpu_layers_count", 0))
    best_prefill_ms, best_tps, best_free_mb = _measure_generation_speed(
        model, processor, model_inputs, input_len, num_tokens=6, max_probe_sec=16.0
    )
    logger.info(
        "[AutoTuner] База %d/48 слоёв: prefill=%d мс, speed=%.2f tok/s, min_free_vram=%d МБ",
        best_layers,
        best_prefill_ms,
        best_tps,
        best_free_mb,
    )

    # Если даже на базе попали в WDDM-своп (< 350 МБ свободно или < 0.7 tok/s) — откатываем по 2 слоя в CPU
    if is_cuda and hasattr(model, "set_resident_layer_count"):
        demote_guard = 0
        while (best_free_mb < 350 or best_tps < 0.7) and best_layers >= 4 and demote_guard < 4:
            demote_guard += 1
            cand_layers = max(0, best_layers - 2)
            model.set_resident_layer_count(cand_layers)
            p_ms, tps, f_mb = _measure_generation_speed(
                model, processor, model_inputs, input_len, num_tokens=5, max_probe_sec=14.0
            )
            logger.info(
                "[AutoTuner] Откат до %d/48 слоёв: prefill=%d мс, speed=%.2f tok/s, min_free_vram=%d МБ",
                cand_layers, p_ms, tps, f_mb,
            )
            if tps >= best_tps or (best_free_mb < 350 and f_mb > best_free_mb + 150):
                best_layers, best_prefill_ms, best_tps, best_free_mb = cand_layers, p_ms, tps, f_mb
            else:
                model.set_resident_layer_count(best_layers)
                break

        # Если есть запас VRAM (>= 650 МБ) и не все 48 слоёв на GPU — пробуем поднять по +2 слоя до пика tok/s
        explicit_env_layers = os.environ.get("VULKAN_GPU_LAYERS") or os.environ.get("AIRLLM_GPU_LAYERS")
        if not explicit_env_layers and best_layers < 48 and best_free_mb >= 650:
            for _step in range(6):
                if best_layers >= 48:
                    break
                cur_free_now_mb = _get_usable_free_vram_mb()
                if cur_free_now_mb < 650:
                    break
                cand_layers = min(48, best_layers + 2)
                actual = model.set_resident_layer_count(cand_layers)
                if actual <= best_layers:
                    break
                p_ms, tps, f_mb = _measure_generation_speed(
                    model, processor, model_inputs, input_len, num_tokens=6, max_probe_sec=14.0
                )
                logger.info(
                    "[AutoTuner] Проба %d/48 слоёв: prefill=%d мс, speed=%.2f tok/s, min_free_vram=%d МБ",
                    actual, p_ms, tps, f_mb,
                )
                # Принимаем шаг только если скорость реально выросла и сохраняется безопасный буфер >= 450 МБ
                if tps >= best_tps * 1.01 and f_mb >= 450:
                    best_layers, best_prefill_ms, best_tps, best_free_mb = actual, p_ms, tps, f_mb
                else:
                    # Подошли к границе WDDM или плато — откатываемся на лучший шаг
                    model.set_resident_layer_count(best_layers)
                    break

        # Финальный контрольный замер на 8 токенах для точного расчёта SLA-бюджета
        best_prefill_ms, best_tps, best_free_mb = _measure_generation_speed(
            model, processor, model_inputs, input_len, num_tokens=8, max_probe_sec=16.0
        )

    del model_inputs
    if is_cuda:
        torch.cuda.empty_cache()

    profile = compute_optimal_profile(
        gpu_name=gpu_name,
        vram_total_mb=vram_total_mb,
        vram_free_bucket_mb=vram_bucket_mb,
        optimal_gpu_layers=best_layers,
        prefill_ms=best_prefill_ms,
        decode_tps=best_tps,
        min_free_vram_mb=best_free_mb,
        target_sla_sec=sla,
        source="benchmark",
    )
    try:
        save_cached_profile(shards_dir, profile)
    except Exception as exc:
        logger.warning("[AutoTuner] Не удалось сохранить кэш калибровки: %s", exc)

    cal_sec = time.perf_counter() - t_cal_start
    print(
        f"[AirLLM AutoTuner] Калибровка завершена за {cal_sec:.1f} с | "
        f"Оптимум: {profile.optimal_gpu_layers}/48 слоёв GPU (free VRAM: {profile.min_free_vram_mb} МБ) | "
        f"prefill={profile.prefill_ms} мс, speed={profile.decode_tps:.2f} tok/s | "
        f"Бюджеты (SLA <= {profile.target_sla_sec:.0f} с): diag={profile.max_new_tokens_diag} ток., "
        f"followup={profile.max_new_tokens_followup} ток., greeting={profile.max_new_tokens_greeting} ток., "
        f"thinking={profile.enable_thinking}.",
        flush=True,
    )
    return profile
