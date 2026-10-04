#!/usr/bin/env bash
set -e

echo "[AutoDiag Docker] Проверка подсистемы Vulkan..."
python -c "from vulkan_backend import init_vulkan_environment; init_vulkan_environment(verbose=True)" || true

echo "[AutoDiag Docker] Применение миграций базы данных Django..."
python manage.py migrate --noinput

echo "[AutoDiag Docker] Запуск сервера экспертной системы на 0.0.0.0:8000..."
exec "$@"
