@echo off
title Android Emulator - Pixel 5 (API 34)
chcp 65001 >nul
echo [INFO] Запуск графического окна эмулятора Pixel 5 (API 34)...
set "PATH=C:\Program Files (x86)\Android\android-sdk\platform-tools;%PATH%"
start "" "C:\Program Files (x86)\Android\android-sdk\emulator\emulator.exe" -avd pixel_5_-_api_34 -no-snapshot-load
echo [OK] Процесс запущен в отдельном окне.
