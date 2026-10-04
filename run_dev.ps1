$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectRoot

$env:PYTHONUTF8 = "1"
$env:GGML_VULKAN = "1"
$env:LLAMA_VULKAN = "1"
$env:MAX_VRAM_MB = "8192"
$env:LLM_CTX_SIZE = "2048"
$env:AIRLLM_COMPRESSION = "4bit"

$PythonExe = Join-Path $ProjectRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $PythonExe)) {
    Write-Host "[SETUP] Создание виртуального окружения .venv..." -ForegroundColor Cyan
    python -m venv .venv
    & $PythonExe -m pip install -r requirements.txt
}

Write-Host "[MIGRATE] Проверка миграций БД Django..." -ForegroundColor Cyan
& $PythonExe manage.py migrate

Write-Host "[START] Запуск AutoDiag Pro AI на http://127.0.0.1:8000 (Режим AR: http://127.0.0.1:8000/ar/)" -ForegroundColor Green
& $PythonExe manage.py runserver 0.0.0.0:8000
