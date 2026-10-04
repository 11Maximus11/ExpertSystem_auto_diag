#!/usr/bin/env bash
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

export PYTHONUTF8=1
export GGML_VULKAN=1
export LLAMA_VULKAN=1
export MAX_VRAM_MB=8192
export LLM_CTX_SIZE=2048
export AIRLLM_COMPRESSION=4bit

if [ ! -x ".venv/bin/python" ]; then
    echo "[SETUP] Создание виртуального окружения .venv..."
    python3 -m venv .venv
    .venv/bin/pip install -r requirements.txt
fi

echo "[MIGRATE] Применение миграций БД Django..."
.venv/bin/python manage.py migrate

echo "[START] Запуск AutoDiag Pro AI на http://127.0.0.1:8000 (Режим AR: http://127.0.0.1:8000/ar/)"
.venv/bin/python manage.py runserver 0.0.0.0:8000
