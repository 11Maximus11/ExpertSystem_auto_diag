@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0\.."

set GGML_VULKAN=1
set LLAMA_VULKAN=1
set VULKAN_DEVICE=0
set MODEL_FILE=models\gemma-4-12b-it-Q4_K_M.gguf

echo [VULKAN] Запуск llama-server с ускорением Vulkan (профиль 8 ГБ VRAM)...
echo [VULKAN] Относительный путь к модели: %MODEL_FILE%

if exist "llama\llama-server.exe" (
    "llama\llama-server.exe" -m "%MODEL_FILE%" --device Vulkan0 -ngl 35 -c 2048 --host 127.0.0.1 --port 8080
) else (
    where llama-server >nul 2>nul
    if %ERRORLEVEL% EQU 0 (
        llama-server -m "%MODEL_FILE%" --device Vulkan0 -ngl 35 -c 2048 --host 127.0.0.1 --port 8080
    ) else (
        echo [INFO] Бинарный файл llama-server не найден в ./llama/ или PATH. Используйте встроенный AirLLM / GGUF воркер Django.
    )
)
endlocal
