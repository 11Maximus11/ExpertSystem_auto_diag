# Скрипт быстрого запуска «ИИдеал Авто» (AIdeal Auto) на Windows (PowerShell)
# На базе послойного AirLLM (Google Gemma 4 12B Unified Text+Vision+Audio) + RAG (BERT/FAISS/BM25/CrossEncoder)

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
$env:LLM_CTX_SIZE = "32768"

$PythonExe = Join-Path $ProjectRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $PythonExe)) {
    Write-Host "[AIdeal Auto] Создание виртуального окружения .venv и установка PyTorch (CUDA) + зависимостей..." -ForegroundColor Cyan
    python -m venv .venv
    & $PythonExe -m pip install --upgrade pip
    & $PythonExe -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124
    & $PythonExe -m pip install triton-windows flash-linear-attention
    & $PythonExe -m pip install -r requirements.txt
}

Write-Host "[AIdeal Auto] Проверка и подготовка послойных шардов модели AirLLM (Google Gemma 4 12B) и RAG BERT..." -ForegroundColor Cyan
& $PythonExe prepare_airllm_model.py

Write-Host "[AIdeal Auto] Применение миграций базы данных..." -ForegroundColor Cyan
& $PythonExe manage.py migrate --noinput

# Определение локальных IPv4 для подключения телефона и VR очков
$LanIps = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object {
    $_.InterfaceAlias -notlike "*Loopback*" -and $_.InterfaceAlias -notlike "*vEthernet*" -and $_.IPAddress -notlike "169.254*"
} | Select-Object -ExpandProperty IPAddress

Write-Host "[AIdeal Auto] Веб-интерфейс готов к подключению:" -ForegroundColor Green
Write-Host "  -> Локально на ПК:     http://127.0.0.1:$Port/ (AR: http://127.0.0.1:$Port/ar/)" -ForegroundColor Cyan
foreach ($ip in $LanIps) {
    Write-Host "  -> С телефона / очков: http://${ip}:$Port/ (AR: http://${ip}:$Port/ar/)" -ForegroundColor Yellow
}

$FwRule = Get-NetFirewallRule -DisplayName "*$Port*" -ErrorAction SilentlyContinue
if (-not $FwRule) {
    Write-Host "[Совет] Если телефон в сети Wi-Fi не может открыть сайт, разрешите порт в Брандмауэре Windows:" -ForegroundColor DarkYellow
    Write-Host "  New-NetFirewallRule -DisplayName 'AIdeal Auto $Port' -Direction Inbound -LocalPort $Port -Protocol TCP -Action Allow" -ForegroundColor Gray
}

& $PythonExe manage.py runserver "0.0.0.0:$Port" --noreload

