#!/usr/bin/env bash
set -e

if [ -z "${HF_TOKEN:-}" ]; then
    unset HF_TOKEN
fi

echo "[AIdeal Auto Docker] Проверка подсистемы Vulkan и CUDA GPU..."
python -c "from vulkan_backend import init_vulkan_environment; init_vulkan_environment(verbose=True)" || true

if [ "${AUTODIAG_FAST_TEST:-0}" != "1" ] && [ "${SKIP_AIRLLM_PRELOAD:-0}" != "1" ]; then
    echo "[AIdeal Auto Docker] Проверка послойных шардов AirLLM (Gemma 4 12B) и BERT RAG..."
    python prepare_airllm_model.py
fi

echo "[AIdeal Auto Docker] Сборка статических файлов..."
python manage.py collectstatic --noinput

echo "[AIdeal Auto Docker] Применение миграций базы данных Django..."
python manage.py migrate --noinput

echo "[AIdeal Auto Docker] Запуск сервера экспертной системы на 0.0.0.0:8000..."
exec "$@"
