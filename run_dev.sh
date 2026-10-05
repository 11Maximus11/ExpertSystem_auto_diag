#!/usr/bin/env bash
# Скрипт быстрого запуска «ИИдеал Авто» (AIdeal Auto) на Linux (Bash)
# На базе послойного AirLLM (Google Gemma 4 12B Unified Text+Vision+Audio) + RAG (BERT/FAISS/BM25/CrossEncoder)

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

export GGML_VULKAN=1
export LLAMA_VULKAN=1
export VULKAN_DEVICE="${VULKAN_DEVICE:-0}"
export PYTORCH_CUDA_ALLOC_CONF="expandable_segments:True,max_split_size_mb:256"
export LLM_CTX_SIZE="${LLM_CTX_SIZE:-32768}"

if [ ! -d ".venv" ]; then
    echo "[AIdeal Auto] Создание виртуального окружения .venv..."
    python3 -m venv .venv
    ./.venv/bin/pip install --upgrade pip
    ./.venv/bin/pip install -r requirements.txt
fi

echo "[AIdeal Auto] Проверка послойных шардов модели AirLLM (Google Gemma 4 12B) и RAG BERT..."
./.venv/bin/python prepare_airllm_model.py

echo "[AIdeal Auto] Применение миграций..."
./.venv/bin/python manage.py migrate --noinput

echo "[AIdeal Auto] Запуск Django + предзагрузка AirLLM в GPU VRAM на http://0.0.0.0:8000/ (AR: http://0.0.0.0:8000/ar/)"
exec ./.venv/bin/python manage.py runserver 0.0.0.0:8000 --noreload
