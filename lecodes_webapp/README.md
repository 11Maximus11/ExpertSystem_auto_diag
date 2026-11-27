# ИИдеал-Авто • Нативное Android, Web и Desktop приложение на базе le.codes

100% нативный клиент экспертной системы автодиагностики **«ИИдеал-Авто»**, построенный на фреймворке и SDK [le.codes](https://le.codes/ru/docs) (`lecodes-cli@^2.14.3`, Android Runtime **`io.letary:lecodes-sdk-core:2.12.7@aar`**).

Весь пользовательский интерфейс реализован без встроенного WebView веб-сайта на **нативных компонентах `le.codes`** (`UITabs`, `UIColumn`, `UIRow`, `UIModal`, `UIButton`, `UIInput`, `UICameraNode`, сигналы `signal`/`effect`). На Android скомпилированный бандл `assets/app.js` исполняется движком **QuickJS** с прямым доступом к нативным плагинам камеры, диктофона, распознавания речи, аппаратному сканеру **OBD-II (ELM327 BLE / USB Serial)** и вторичному экрану **AR-очков** через `ARHudPresentation.kt`.

> 📄 Полная документация всей системы (включая серверную часть, RAG, веб-сайт и Android-слой) доступна в корневом [`README.md`](../README.md) и в PDF-редакции [`docs/AIdeal_Auto_Documentation.pdf`](../docs/AIdeal_Auto_Documentation.pdf).

---

## 1. Архитектура клиента (`lecodes_webapp`)

### 1.1. Целевые платформы (`app.json`, `package.json`)
- **Android Native**: `applicationId = "com.mmcco.aidealauto"`, `version = "1.0.0"`, `versionCode = 1`, `compileSdk = 36`, `targetSdk = 36`, `minSdk = 23`, JDK 17, ABI `arm64-v8a` и `armeabi-v7a`.
- **Desktop**: `npm run desktop` (`lecodes dev --desktop`), окно `1280×840` (`minWidth: 400`, `minHeight: 640`).
- **Web**: `npm run dev` / `npm run build` (`dist/web`), маршрутизация `urls: "hash"`, локальный dev-сервер `serve_app.py` (порт `3000` с CORS и fallback на `port + 1`).

### 1.2. Навигация и 5 нативных экранов (`main.ts`, `src/ui/`)

1. **`DiagnosticsScreen` (вкладка `diag` — «Диагноз»)**:
   - Интерактивный чат с ИИ-экспертом (текст, голосовая запись через `AudioRecorder` `.m4a` или `SpeechRecognizer` `ru-RU`, фото через `UICameraNode` / галерею, загрузка логов и документов PDF/DOCX/XLSX с авто-извлечением кодов DTC через `/api/preview-document/`, быстрый ввод DTC, прикрепление снимка OBD-II).
   - Отображение карточек неисправностей (`DtcChip` + `GradientBarFill`), интерактивных чеклистов ремонта и инвентаря, кнопок уточнения, экспорта отчета, массового удаления сообщений и отправки ответа в AR HUD.
2. **`DtcDictionaryScreen` (вкладка `dtc` — «Чеклист»)**:
   - Подвкладка **«Чеклист & Инвентарь»**: сводный прогресс-бар выполнения шагов ремонта, допуски/моменты затяжки (`torque_or_spec`), предупреждения (`safety_warning`) и кнопка перехода в AR HUD.
   - Подвкладка **«Словарь DTC»**: онлайн- и офлайн-поиск по каталогу из **12 141** кода DTC (debounce `250 мс`, фильтры систем `P/C/B/U`, пагинация по 80 кодов, OEM-варианты, статистика бюллетеней NHTSA, кнопка `В чат`).
3. **`ObdScannerScreen` (вкладка `obd` — «OBD-2»)**:
   - Модуль [`src/obd/ELM327Protocol.ts`](src/obd/ELM327Protocol.ts): подключения **Web Bluetooth** (8 сервисных UUID BLE), **Web Serial** (`[38400, 115200, 9600, 230400, 500000]` бод) и встроенный **Демо-симулятор ЭБУ** (прогрев `45°C -> 92°C`, перегазовки, коды `P0300`, `P0171`, `C0050`, VIN `WAUZZZ8V1GA123456`).
   - 6 живых цифровых датчиков `MetricCard` (опрос каждые `450 мс`: RPM, Скорость, Температура ОЖ, Напряжение АКБ `ATRV`, Нагрузка ДВС, Дроссель TPS), чтение/сброс DTC (`03` / `04` с подтверждением), чтение VIN (`0902`), прикрепление телеметрии в ИИ-чат и интерактивная консоль AT-команд (30 строк).
4. **`SessionsHistoryScreen` (вкладка `sessions` — «Сессии»)**:
   - Проекты диагностики, закрепление, переименование, тегирование агрегатов, поиск, работа как с серверной БД, так и в гостевом демо-режиме, а также карточка статуса фонового воркера и ручная правка выжимки сессии.
5. **`SettingsScreen` (вкладка `settings` — «Настройки») + `AuthModal.ts`**:
   - Вход, регистрация, выход и удаление аккаунта (с согласием 152-ФЗ при первом запуске, входе и регистрации), выбор темы (Тёмная / Светлая), управление кросс-диалоговой памятью (`UserMemorySettings`), диагностика аппаратных прав (`Камера`, `Микрофон`, `Речь`) и **скрытое Инженерное меню (Dev Mode)**.

### 1.3. Скрытое Инженерное меню (Dev Mode)
- Разблокируется **10 быстрыми нажатиями** на плашку версии внизу экрана «Настройки» (с 6-го нажатия отображается обратный отсчет). При каждом повторном открытии экрана настроек меню сбрасывается в скрытое состояние.
- Позволяет на лету переключать URL бэкенда Django (`http://localhost:8000` для `adb reverse`, `http://10.0.2.2:8000` для эмулятора Android, либо LAN IP для отладки по Wi-Fi), выполнять **Ping-тест `/api/settings/`** с замером задержки в мс и принудительно синхронизировать словарь DTC.

### 1.4. Сетевой протокол, асинхронные задачи и 3-уровневый кэш
- **`BackendApiClient.ts`**: авторизация по заголовку **`X-Session-Key`** (или `X-Demo-Mode: "1"` для гостя), отправка диагностических запросов через **`POST /api/ask/?async=1`** (HTTP `202 {job_id}`) с фоновым опросом `GET /api/ask/job/<job_id>/` каждые `1500 мс` до `15 минут` и отменой через `POST /api/cancel/`.
- **`ResourceCacheManager.ts`**: трехуровневый кэш **L1 (`inMemoryDtc`) -> L2 (`localStorage`) -> L3 (`CacheStorage` `aideal-lecodes-cache-v1`)**. В офлайне без синхронизированной базы доступно 6 базовых кодов + синтез расшифровок по шаблону `/^[PCBU][0-9]{4}$/i`.

### 1.5. Внешние AR-очки (`ARHudPresentation.kt`), 3DoF и пульт-тачпад на смартфоне

- **Поддерживаемые AR-очки и адаптеры (`AndroidManifest.xml`, `device_filter.xml`)**:
  - Очки (USB VID): **RayNeo / TCL** (`0x1BBB`, `0x2E04`), **XREAL** (`0x3318`), **Rokid** (`0x04D8`, `0x3273`), **Viture** (`0x35CA`), **STM XR Bridge** (`0x0483`).
  - OBD-II USB-OTG сканеры: **FTDI** (`0x0403`), **CH340** (`0x1A86`), **CP2102** (`0x10C4`), **PL2303** (`0x067B`), **Tactrix OpenPort 2.0** (`0x2717`).
- **Двусторонний мост `ExternalDisplayBridge.ts` <-> `MainActivity.kt` (`app.ar_display`)**:
  - При подключении внешнего дисплея (`DisplayManager`) на очках автоматически открывается нативное окно **`ARHudPresentation.kt`** в двух режимах: **`optical`** (фон `#000000` + два перетаскиваемых окна камеры и ассистента) или **`vr`** (полноэкранный видеопоток Camera2 за окном ассистента).
  - На телефоне при этом вместо дублирования HUD автоматически открывается **«Пульт внешнего AR HUD»** с виртуальным тачпадом (чувствительность `2.2×`) для перемещения окон в очках, переключением режима/камеры, выбором фото из галереи (`<= 1600 px`), захватом кадра в ИИ, голосовым вводом и управлением сессиями.
  - **3DoF-ориентация**: `SensorManager` (`TYPE_ROTATION_VECTOR`) считывает углы `yaw / pitch / roll` и передает их в заголовок AR HUD и в TypeScript (`250 мс`).
- **4 встроенных нативных плагина (`letary/lecodes-plugins@v2.4.0`)**: `lecodes-camera`, `lecodes-audio-recorder`, `lecodes-speech`, `lecodes-browser`.

---

## 2. Сборка APK и запуск

### 2.1. Пересборка и компиляция Debug APK

```powershell
# 1. Установка JS-зависимостей и синхронизация бандла в Android-проект
cd lecodes_webapp
npm ci
npx lecodes-cli app sync android

# 2. Компиляция Debug APK через Gradle
cd android
# Рекомендуется на сетевых/облачных дисках (Google Drive): выносит кэш сборки в C:\Users\<USER>\.android_build\
.\gradlew.bat assembleDebug --init-script build_cache.init.gradle.kts
```

**Пути к скомпилированному APK:**
- С `--init-script build_cache.init.gradle.kts` (и через задачу VS Code):
  `C:\Users\<USER>\.android_build\aideal-autodiag-lecodes\app\outputs\apk\debug\app-debug.apk`
- Без `--init-script` (стандартный локальный билд Gradle):
  `lecodes_webapp/android/app/build/outputs/apk/debug/app-debug.apk`

Для сборки подписанного **Release APK / AAB** настройте `android/keystore.properties` или переменные `LECODES_ANDROID_KEYSTORE_*` (подробно описано в [`android/README.md`](android/README.md)) и выполните `.\gradlew.bat assembleRelease`.

---

## 3. Руководство по отладке

### Вариант 1: Быстрая отладка в браузере и на Desktop
```powershell
cd lecodes_webapp
npm run dev      # Браузер с Hot-Reload (http://localhost:3000)
npm run desktop  # Нативное окно Desktop (1280x840)
```

### Вариант 2: Отладка в Android-эмуляторе (CLI / VS Code)
1. В корне репозитория запустите Django-сервер:
   ```powershell
   .\.venv\Scripts\python.exe manage.py runserver 0.0.0.0:8000 --noreload
   ```
2. Запустите эмулятор (напр., задачей VS Code `Android: Запустить эмулятор Pixel 5 (API 34)` или `emulator -avd pixel_5_-_api_34 -no-snapshot-load`).
3. Пробросьте порт сервера, установите APK и выдайте разрешения:
   ```powershell
   adb wait-for-device
   adb reverse tcp:8000 tcp:8000
   adb install -r "C:\Users\<USER>\.android_build\aideal-autodiag-lecodes\app\outputs\apk\debug\app-debug.apk"
   adb shell pm grant com.mmcco.aidealauto android.permission.CAMERA
   adb shell pm grant com.mmcco.aidealauto android.permission.RECORD_AUDIO
   adb shell am start -n com.mmcco.aidealauto/.MainActivity
   ```
4. **Hot-Reload без пересборки APK**: после изменений в `src/*.ts` запускайте задачу VS Code `Android: Hot-Reload JS бандла (le.codes sync)` — бандл обновляется за ~0.5 сек.
5. **Logcat в реальном времени**:
   ```powershell
   adb logcat -v time -s LeCodes:V CreatorPkg:V AIdealMainActivity:V AndroidRuntime:E
   ```

### Вариант 3: Отладка на реальном Android-смартфоне (USB / Wi-Fi)
1. Подключите смартфон по USB с включенной отладкой по USB.
2. Либо выполните `adb reverse tcp:8000 tcp:8000` (работает по кабелю на `http://localhost:8000`), либо по одной Wi-Fi сети откройте в приложении **Настройки -> 10 тапов по версии -> Dev Menu**, введите `http://<IP_ПК>:8000` (из `ipconfig`), нажмите **Сохранить URL** и **Пинг /api/**.

---

## Лицензия

Проект распространяется под лицензией **GNU General Public License v3.0 (GPL-3.0)**.
