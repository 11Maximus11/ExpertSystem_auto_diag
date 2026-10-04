#!/usr/bin/env bash
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

export GGML_VULKAN=1
export LLAMA_VULKAN=1
export VULKAN_DEVICE=0
MODEL_FILE="models/gemma-4-12b-it-Q4_K_M.gguf"

echo "[VULKAN] Запуск llama-server (Linux Vulkan, профиль 8 ГБ VRAM)..."
echo "[VULKAN] Относительный путь к модели: $MODEL_FILE"

if [ -x "./llama/llama-server" ]; then
    ./llama/llama-server -m "$MODEL_FILE" --device Vulkan0 -ngl 35 -c 2048 --host 127.0.0.1 --port 8080
elif command -v llama-server >/dev/null 2>&1; then
    llama-server -m "$MODEL_FILE" --device Vulkan0 -ngl 35 -c 2048 --host 127.0.0.1 --port 8080
else
    echo "[INFO] Бинарный файл llama-server не найден. Используйте встроенный AirLLM / GGUF воркер Django."
fi
