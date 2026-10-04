"""
Сервис голосового ввода (Requirement #12):
- Если активная модель поддерживает прямой мультимодальный аудиоввод (Gemma-4 Omni / OpenAI input_audio),
  формирует прямой аудио-пакет без промежуточной потери интонации и шумов мотора.
- Если модель не поддерживает прямое аудио (или выбран режим GGML), выполняет локальное
  распознавание речи через GGML (whisper.cpp / pywhispercpp / faster-whisper).
"""

import base64
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Dict, Optional

from vulkan_backend import BASE_DIR

MODELS_DIR = BASE_DIR / "models"


def model_supports_direct_audio(model_name: str, backend: str) -> bool:
    """
    Проверяет, поддерживает ли выбранная модель прямой ввод аудио-потока.
    Модели семейства Gemma-4-Omni / Qwen2-Audio / GPT-4o-Audio принимают аудио напрямую.
    """
    name_lower = (model_name or "").lower()
    direct_keywords = ("omni", "audio", "gemma-4", "qwen2-audio", "ultravox")
    return any(kw in name_lower for kw in direct_keywords)


def transcribe_with_ggml(audio_bytes: bytes, filename: str = "voice.wav") -> Dict[str, Any]:
    """
    Распознавание речи с использованием локального GGML-стека (pywhispercpp / whisper-cli / faster-whisper).
    Использует относительные пути к моделям в ./models/.
    """
    suffix = Path(filename).suffix or ".wav"
    ggml_candidates = list(MODELS_DIR.glob("ggml-*.bin")) + list(MODELS_DIR.glob("*whisper*.bin"))
    ggml_model_path = ggml_candidates[0] if ggml_candidates else (MODELS_DIR / "ggml-base.bin")

    # 1. Пробуем pywhispercpp (Python-биндинг к whisper.cpp GGML)
    try:
        from pywhispercpp.model import Model as WhisperGGMLModel  # type: ignore

        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(audio_bytes)
            tmp_path = tmp.name
        try:
            model_arg = str(ggml_model_path) if ggml_model_path.exists() else "base"
            w_model = WhisperGGMLModel(model_arg, n_threads=4)
            segments = w_model.transcribe(tmp_path, language="ru")
            text = " ".join(seg.text.strip() for seg in segments).strip()
            if text:
                return {
                    "success": True,
                    "engine": "pywhispercpp (GGML)",
                    "text": text,
                }
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
    except Exception:
        pass

    # 2. Пробуем консольный бинарник whisper-cli / main из ./llama/ или системного PATH с моделью GGML
    whisper_bins = [
        BASE_DIR / "llama" / ("whisper-cli.exe" if os.name == "nt" else "whisper-cli"),
        BASE_DIR / "llama" / ("main.exe" if os.name == "nt" else "main"),
    ]
    which_whisper = shutil.which("whisper-cli") or shutil.which("whisper-cpp")
    if which_whisper:
        whisper_bins.append(Path(which_whisper))

    for bin_path in whisper_bins:
        if bin_path.exists() and ggml_model_path.exists():
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
                tmp.write(audio_bytes)
                tmp_path = tmp.name
            try:
                proc = subprocess.run(
                    [
                        str(bin_path),
                        "-m",
                        str(ggml_model_path),
                        "-f",
                        tmp_path,
                        "-l",
                        "ru",
                        "-nt",
                    ],
                    capture_output=True,
                    text=True,
                    timeout=30,
                    encoding="utf-8",
                    errors="replace",
                )
                if proc.returncode == 0 and proc.stdout.strip():
                    return {
                        "success": True,
                        "engine": f"whisper.cpp GGML ({ggml_model_path.name})",
                        "text": proc.stdout.strip(),
                    }
            except Exception:
                pass
            finally:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)

    # 3. Пробуем faster-whisper (CTranslate2 / GGML-совместимый локальный движок)
    try:
        from faster_whisper import WhisperModel  # type: ignore

        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(audio_bytes)
            tmp_path = tmp.name
        try:
            fw_model = WhisperModel("base", device="cpu", compute_type="int8")
            segments, _ = fw_model.transcribe(tmp_path, language="ru")
            text = " ".join(s.text.strip() for s in segments).strip()
            if text:
                return {
                    "success": True,
                    "engine": "faster-whisper (int8 local)",
                    "text": text,
                }
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
    except Exception:
        pass

    return {
        "success": False,
        "engine": "GGML Whisper (ожидание весов ggml-base.bin в ./models/)",
        "text": "",
    }


def process_voice_input(
    audio_bytes: bytes,
    filename: str,
    voice_mode: str,
    model_name: str,
    backend: str,
    client_transcript: str = "",
) -> Dict[str, Any]:
    """
    Обрабатывает голосовой ввод пользователя:
    - При поддержке прямого аудио возвращает base64 пакет `input_audio` для модели.
    - При режиме GGML (или отсутствии прямой поддержки аудио у текстовой модели) запускает GGML распознавание.
    """
    supports_direct = model_supports_direct_audio(model_name, backend)
    use_direct = voice_mode == "direct_audio" or (voice_mode == "auto" and supports_direct)

    audio_b64 = base64.b64encode(audio_bytes).decode("utf-8")
    ext = (Path(filename).suffix or ".wav").lstrip(".").lower()
    if ext not in ("wav", "mp3", "ogg", "webm"):
        ext = "wav"

    ggml_result = transcribe_with_ggml(audio_bytes, filename=filename)
    recognized_text = ggml_result.get("text") or client_transcript.strip()

    if use_direct:
        return {
            "mode_used": "direct_audio",
            "mode_label": f"Прямой аудиоввод в модель ({model_name})",
            "audio_payload": {
                "type": "input_audio",
                "input_audio": {
                    "data": audio_b64,
                    "format": ext,
                },
            },
            "transcript": recognized_text or "[Аудиозапись передана напрямую в мультимодальную модель]",
            "ggml_engine": ggml_result.get("engine", "Direct Multimodal Audio"),
        }

    return {
        "mode_used": "ggml_whisper",
        "mode_label": f"Распознавание речи GGML ({ggml_result.get('engine', 'GGML Whisper')})",
        "audio_payload": None,
        "transcript": recognized_text or "[Голосовое сообщение получено]",
        "ggml_engine": ggml_result.get("engine", "GGML Whisper"),
    }
