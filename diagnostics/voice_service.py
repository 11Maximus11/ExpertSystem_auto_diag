"""
Сервис прямого мультимодального аудиовхода для Google Gemma 4 12B
(Gemma4UnifiedForConditionalGeneration + Gemma4UnifiedProcessor).

Модель Gemma 4 12B имеет встроенный аудиоэнкодер (model.embed_audio) и напрямую
принимает 16 кГц монофонический сигнал (float32 waveform) через токен <|audio|>.
Внешний Whisper полностью исключен из проекта — распознавание речи мастера и акустический
анализ звуков автомобиля выполняются исключительно нативно моделью Gemma 4.
"""

from __future__ import annotations

import io
import logging
import wave
from pathlib import Path
from typing import Any, Dict, Optional

import numpy as np

logger = logging.getLogger("diagnostics.voice")

TARGET_SAMPLE_RATE = 16000
MAX_AUDIO_SECONDS = 45.0


def _decode_wav_bytes_16k(audio_bytes: bytes) -> Optional[np.ndarray]:
    """Резервный декодер стандартных PCM WAV-файлов в float32 [-1.0, 1.0] 16 кГц моно."""
    try:
        with wave.open(io.BytesIO(audio_bytes), "rb") as wf:
            n_channels = wf.getnchannels()
            sampwidth = wf.getsampwidth()
            framerate = wf.getframerate()
            n_frames = wf.getnframes()
            raw = wf.readframes(n_frames)

        if sampwidth == 2:
            audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        elif sampwidth == 1:
            audio = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
        elif sampwidth == 4:
            audio = np.frombuffer(raw, dtype=np.int32).astype(np.float32) / 2147483648.0
        else:
            return None

        if n_channels > 1:
            audio = audio.reshape(-1, n_channels).mean(axis=1)

        if framerate != TARGET_SAMPLE_RATE and len(audio) > 0:
            duration = len(audio) / float(framerate)
            target_len = max(1, int(duration * TARGET_SAMPLE_RATE))
            x_old = np.linspace(0.0, 1.0, num=len(audio))
            x_new = np.linspace(0.0, 1.0, num=target_len)
            audio = np.interp(x_new, x_old, audio).astype(np.float32)

        return audio.astype(np.float32)
    except Exception:
        return None


def decode_audio_to_waveform_16k(
    audio_bytes: bytes,
    filename: str = "voice.webm",
    max_seconds: float = MAX_AUDIO_SECONDS,
) -> Optional[np.ndarray]:
    """
    Декодирует аудио любого поддерживаемого формата (.webm, .wav, .mp3, .ogg, .m4a, .flac, .aac)
    в монофонический массив float32 с частотой дискретизации 16 000 Гц для прямой подачи
    в Gemma4UnifiedProcessor (audio=[waveform], sampling_rate=16000).
    """
    if not audio_bytes:
        return None

    waveform: Optional[np.ndarray] = None

    # 1. Быстрое декодирование через PyAV (FFmpeg-биндинги в памяти без внешних процессов)
    try:
        import av

        container = av.open(io.BytesIO(audio_bytes))
        audio_stream = next((s for s in container.streams if s.type == "audio"), None)
        if audio_stream is not None:
            resampler = av.AudioResampler(format="fltp", layout="mono", rate=TARGET_SAMPLE_RATE)
            chunks = []
            for frame in container.decode(audio_stream):
                resampled_frames = resampler.resample(frame)
                if not isinstance(resampled_frames, list):
                    resampled_frames = [resampled_frames] if resampled_frames is not None else []
                for rf in resampled_frames:
                    arr = rf.to_ndarray()
                    if arr.ndim > 1:
                        arr = arr.mean(axis=0)
                    chunks.append(arr.astype(np.float32))
            if chunks:
                waveform = np.concatenate(chunks, axis=0)
        container.close()
    except Exception as exc:
        logger.debug("PyAV не смог декодировать %s (%s), пробуем WAV-парсер.", filename, exc)

    # 2. Резерв: встроенный модуль wave (для несжатых WAV PCM)
    if waveform is None or len(waveform) == 0:
        waveform = _decode_wav_bytes_16k(audio_bytes)

    if waveform is None or len(waveform) == 0:
        logger.warning("Не удалось декодировать аудиофайл %s (%d байт) в PCM 16kHz.", filename, len(audio_bytes))
        return None

    max_samples = int(max_seconds * TARGET_SAMPLE_RATE)
    if len(waveform) > max_samples:
        waveform = waveform[:max_samples]

    # Удаление постоянного смещения (DC offset) для чистоты сигнала и устранения треска микрофона
    waveform = waveform - float(np.mean(waveform))

    # Нормализация пиков при слишком тихой записи
    peak = float(np.max(np.abs(waveform))) if len(waveform) > 0 else 0.0
    if peak > 1e-4:
        waveform = (waveform / peak * 0.75).astype(np.float32)

    return np.clip(waveform, -1.0, 1.0).astype(np.float32)


def process_voice_input(
    audio_bytes: Optional[bytes],
    filename: str = "voice.webm",
    voice_mode: str = "direct_audio",
    browser_transcript: str = "",
    client_transcript: str = "",
    **kwargs: Any,
) -> Dict[str, Any]:
    """
    Конвейер прямого мультимодального аудиовхода для модели Google Gemma 4 12B:
    декодирует голосовую запись или аудиофайл в 16 кГц float32 массив для нативного
    модуля `model.embed_audio` (токен `<|audio|>`).

    Распознавание речи и анализ акустических шумов узлов автомобиля осуществляются
    исключительно нативно моделью Google Gemma 4 12B без сторонних моделей.
    """
    hint_text = (browser_transcript or client_transcript or "").strip()

    if not audio_bytes:
        return {
            "mode_used": "direct_audio",
            "mode_label": "Прямой аудиовход Gemma 4 12B (embed_audio)",
            "transcript": hint_text,
            "audio_attached_to_model": False,
            "audio_waveform_16k": None,
            "duration_sec": 0.0,
            "engine": "Browser SpeechRecognition" if hint_text else "none",
        }

    waveform = decode_audio_to_waveform_16k(audio_bytes, filename=filename)
    duration_sec = round(float(len(waveform)) / TARGET_SAMPLE_RATE, 2) if waveform is not None else 0.0
    attached = bool(waveform is not None and len(waveform) > 0)

    logger.debug(
        "[Voice Direct Gemma 4] Файл=%s (%d байт) -> декодировано=%s, длительность=%.2f с, подсказка='%s'",
        filename,
        len(audio_bytes),
        attached,
        duration_sec,
        hint_text[:80],
    )

    return {
        "mode_used": "direct_audio",
        "mode_label": f"Нативное аудио Gemma 4 12B ({duration_sec} с)",
        "transcript": hint_text,
        "audio_attached_to_model": attached,
        "audio_waveform_16k": waveform,
        "duration_sec": duration_sec,
        "engine": "Google Gemma 4 Unified (embed_audio 16kHz)",
    }
