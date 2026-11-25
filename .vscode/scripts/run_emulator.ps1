param(
    [string]$Avd = "pixel_5_-_api_34",
    [switch]$ForceGui
)

$env:PATH = "C:\Program Files (x86)\Android\android-sdk\platform-tools;" + $env:PATH
$adb = "C:\Program Files (x86)\Android\android-sdk\platform-tools\adb.exe"
$emulator = "C:\Program Files (x86)\Android\android-sdk\emulator\emulator.exe"

$qemu = Get-Process | Where-Object { $_.ProcessName -match "qemu" -and $_.MainWindowHandle -ne 0 }

if (-not $qemu -or $ForceGui) {
    Write-Host "[INFO] Запуск графического окна эмулятора $Avd..." -ForegroundColor Cyan
    Stop-Process -Name qemu-system-x86_64, emulator -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
    Start-Process -FilePath $emulator -ArgumentList "-avd $Avd -no-snapshot-load"
    Write-Host "[INFO] Ожидание готовности Android..." -ForegroundColor Yellow
    & $adb wait-for-device
    while ((& $adb shell getprop sys.boot_completed 2>$null).Trim() -ne "1") {
        Start-Sleep -Seconds 1
    }
    Write-Host "[OK] Графическое окно эмулятора $Avd успешно открыто и готово!" -ForegroundColor Green
} else {
    Write-Host "[OK] Графическое окно эмулятора уже открыто на рабочем столе." -ForegroundColor Green
}
