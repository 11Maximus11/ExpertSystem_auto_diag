#!/usr/bin/env bash
# Скрипт быстрого запуска AutoDiag Pro AI на Linux (Bash)
# Полностью на базе AirLLM (Qwen/Qwen3.5-4B Vision-Language) + адаптивное ускорение GPU / Vulkan

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

export GGML_VULKAN=1
export LLAMA_VULKAN=1
export VULKAN_DEVICE="${VULKAN_DEVICE:-0}"
export PYTORCH_CUDA_ALLOC_CONF="expandable_segments:True,max_split_size_mb:256"
export LLM_CTX_SIZE="${LLM_CTX_SIZE:-6144}"

if [ ! -d ".venv" ]; then
    echo "[AutoDiag] Создание виртуального окружения .venv..."
    python3 -m venv .venv
    ./.venv/bin/pip install --upgrade pip
    ./.venv/bin/pip install -r requirements.txt
fi

echo "[AutoDiag] Проверка послойных шардов модели AirLLM (Qwen/Qwen3.5-4B)..."
./.venv/bin/python prepare_airllm_model.py

echo "[AutoDiag] Применение миграций..."
./.venv/bin/python manage.py migrate --noinput

echo "[AutoDiag] Запуск Django + предзагрузка AirLLM в GPU VRAM на http://0.0.0.0:8000/ (AR RayNeo: http://0.0.0.0:8000/ar/)"
exec ./.venv/bin/python manage.py runserver 0.0.0.0:8000 --noreload
