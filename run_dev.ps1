# Скрипт быстрого запуска AutoDiag Pro AI на Windows (PowerShell)
# Полностью на базе AirLLM (Qwen/Qwen3.5-4B Vision-Language) + адаптивное ускорение GPU / Vulkan

param(
    [int]$Port = 8000
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectRoot

$env:GGML_VULKAN = "1"
$env:LLAMA_VULKAN = "1"
$env:VULKAN_DEVICE = "0"
$env:PYTORCH_CUDA_ALLOC_CONF = "expandable_segments:True,max_split_size_mb:256"
$env:LLM_CTX_SIZE = "6144"

$PythonExe = Join-Path $ProjectRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $PythonExe)) {
    Write-Host "[AutoDiag] Создание виртуального окружения .venv и установка PyTorch (CUDA) + зависимостей..." -ForegroundColor Cyan
    python -m venv .venv
    & $PythonExe -m pip install --upgrade pip
    & $PythonExe -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124
    & $PythonExe -m pip install triton-windows flash-linear-attention
    & $PythonExe -m pip install -r requirements.txt
}

Write-Host "[AutoDiag] Проверка и подготовка послойных шардов модели AirLLM (Qwen/Qwen3.5-4B)..." -ForegroundColor Cyan
& $PythonExe prepare_airllm_model.py

Write-Host "[AutoDiag] Применение миграций базы данных..." -ForegroundColor Cyan
& $PythonExe manage.py migrate --noinput

Write-Host "[AutoDiag] Запуск веб-интерфейса Django + предзагрузка AirLLM в GPU VRAM на http://127.0.0.1:$Port/ (AR-режим: http://127.0.0.1:$Port/ar/)" -ForegroundColor Green
& $PythonExe manage.py runserver "0.0.0.0:$Port" --noreload
