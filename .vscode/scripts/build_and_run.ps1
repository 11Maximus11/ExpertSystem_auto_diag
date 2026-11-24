$ErrorActionPreference = "Stop"
$adb = "C:\Program Files (x86)\Android\android-sdk\platform-tools\adb.exe"
$projectRoot = Resolve-Path "$PSScriptRoot\..\.."
$apkPath = "C:\Users\maxxf\.android_build\aideal-autodiag-lecodes\app\outputs\apk\debug\app-debug.apk"

Write-Host "=== 1. Синхронизация JS-бандла le.codes ===" -ForegroundColor Cyan
Set-Location "$projectRoot\lecodes_webapp"
npx lecodes-cli app sync android

Write-Host "=== 2. Сборка APK (Gradle Debug вне GDrive) ===" -ForegroundColor Cyan
Set-Location "$projectRoot\lecodes_webapp\android"
& .\gradlew.bat assembleDebug --init-script build_cache.init.gradle.kts
if ($LASTEXITCODE -ne 0) {
    Write-Error "Ошибка сборки Gradle."
    exit 1
}

Write-Host "=== 3. Проброс портов (adb reverse tcp:8000 tcp:8000) ===" -ForegroundColor Cyan
& $adb reverse tcp:8000 tcp:8000

Write-Host "=== 4. Установка APK на эмулятор ($apkPath) ===" -ForegroundColor Cyan
& $adb install -r $apkPath

Write-Host "=== 5. Запуск приложения com.example.aidealautodiaglecodes/.MainActivity ===" -ForegroundColor Green
& $adb shell am force-stop com.example.aidealautodiaglecodes
& $adb shell am start -n com.example.aidealautodiaglecodes/.MainActivity

Write-Host "[SUCCESS] Приложение ИИдеал-Авто успешно собрано и запущено в эмуляторе!" -ForegroundColor Green
