# ИИдеал-Авто • Android-оболочка на базе le.codes

Высокотехнологичная нативная Android-оболочка для существующего PWA-приложения экспертной системы автодиагностики **«ИИдеал-Авто»**, построенная на базе библиотеки и runtime-движка [le.codes](https://le.codes/ru/docs).

Приложение работает **без изменений существующего веб-сайта и его PWA**, выступая в качестве умной, производительной оболочки с нативным UI-оверлеем, аппаратным пробросом датчиков OBD-II и скрытым инженерным меню разработчика.

---

## Архитектура: Где и как используется le.codes

В приложении Android библиотека и SDK `le.codes` задействованы на всех ключевых уровнях:

1. **Точка входа Android (Activity & View)**:
   - В [MainActivity.kt](file:///d:/GDrive/Документы/Visual%20Studio%202022/ExpertSystem_auto_diag/lecodes_webapp/android/app/src/main/java/com/example/aidealautodiaglecodes/MainActivity.kt) корневым представлением экрана установлен **`LeCodesView(engine = viewModel.engine, context = applicationContext)`**.
   - [AppViewModel.kt](file:///d:/GDrive/Документы/Visual%20Studio%202022/ExpertSystem_auto_diag/lecodes_webapp/android/app/src/main/java/com/example/aidealautodiaglecodes/AppViewModel.kt) управляет жизненным циклом `LecodesEngine`.
   - `LeCodesRuntime.registerBundledPlugins(viewModel.engine, applicationContext)` регистрирует плагин `:plugins:lecodes-browser`.
   - `LeCodesShell.boot(engine, activity)` загружает скомпилированный бандл `app.js` прямо из нативных ассетов APK.

2. **Движок интерфейса оболочки (`main.ts` -> `assets/app.js`)**:
   - `UIScreen`: корневой нативный экран `le.codes`.
   - `UIWebViewNode({ url: serverUrl.value, bridge: true })`: встроенный в дерево компонентов `le.codes` узел браузера, рендерящий основное PWA-приложение на полный экран со стилем `{ flex: 1, width: "100%", height: "100%" }`.
   - `signal(...).stored("pwa_server_url")`: реактивное состояние le.codes с автоматическим сохранением URL тестового стенда в постоянное хранилище Android устройства.
   - `UIModal`: диалог скрытого инженерного меню, плавно анимируемый и управляемый реактивным стейтом.
   - `UIInput`, `UIButton`, `UIRow`, `UIColumn`, `UIText`: нативные элементы управления le.codes для шапки, приборной панели и меню.

3. **Аппаратный проброс OBD-II & Мультимедиа**:
   - Плагин `lecodes-browser` (`WebViewPage.kt`) сконфигурирован с:
     - `WebSettings.MIXED_CONTENT_ALWAYS_ALLOW` (для работы с локальными HTTP-стендами без SSL-блокировок).
     - `domStorageEnabled = true`, `databaseEnabled = true`, `allowFileAccess = true`.
     - `WebChromeClient.onPermissionRequest` (автоматическая выдача разрешений для WebRTC камеры и аудио для визуальной диагностики и распознавания речи).
     - Нативный мост `window.AndroidOBD` и двунаправленный мост `window.lecodes.postMessage(...)` / `webNode.onMessage(...)`.
   - Полная поддержка **Web Bluetooth API**, **Web Serial API** и **ELM327 BLE** на уровне Android-манифеста с разрешениями `BLUETOOTH_SCAN`, `BLUETOOTH_CONNECT`, `ACCESS_FINE_LOCATION`, `CAMERA`, `RECORD_AUDIO`, `USB_HOST`.

4. **Автомобильный оверлей OBD-II HUD**:
   - Встроенный в оболочку `le.codes` выдвижной телеметрический HUD-бар:
     - Живые датчики: **Обороты (RPM)**, **Скорость (км/ч)**, **Температура ОЖ (°C)**, **Напряжение АКБ (В)**.
     - Индикатор статуса подключения к ELM327 BLE.
     - Интерактивный режим симулятора датчиков для тестирования задержки отображения и анимаций.

---

## Скрытое Инженерное Меню (Dev Mode)

Для отладки в Visual Studio .NET Android SDK emulator и на временных локальных стендах в приложение встроено инженерное меню:

### Как открыть:
- В верхней шапке приложения кликните **7 раз подряд** по бейджу версии **`v1.0.0 ⚙`**.
- Начиная с 3-го клика внизу появляется подсказка с оставшимся числом кликов.
- После 7-го клика открывается модальное окно **Инженерного меню**.

### Возможности:
- **Перезапись адреса стенда**: Поле ввода `UIInput` с текущим адресом (например, `http://10.0.2.2:8000` или `http://192.168.1.55:8000`).
- **Быстрые пресеты в 1 клик**:
  - `10.0.2.2 (VS Emulator)` — шлюз loopback к хост-компьютеру из эмулятора Android.
  - `localhost` — для локального окружения.
  - `Wi-Fi стенд` (`http://192.168.1.100:8000`) — для подключения к ПК по Wi-Fi с физического телефона.
- **Инструмент проверки связи (Ping)**: Отправляет проверочный GET-запрос к стенду и замеряет точную задержку в миллисекундах (`✓ Связь есть! HTTP 200, 12 мс`).
- **Сброс кэша**: Вызывает `webNode.clearData()` для очистки кэша WebView, кук и локального хранилища.
- **Сохранить и загрузить**: Записывает новый адрес в `serverUrl.value` (с автоматическим сохранением через `.stored()`), вызывает `webNode.load(newUrl)` и мгновенно перезагружает PWA с нового стенда.

---

## Сборка и запуск в Visual Studio .NET Android Emulator

### 1. Готовый скомпилированный APK
Файл отладочной сборки с нативным runtime-движком le.codes:
```
lecodes_webapp/android/app/build/outputs/apk/debug/app-debug.apk
```

### 2. Запуск бэкенда Django (хост)
В корне репозитория запустите Django-сервер так, чтобы он слушал внешний интерфейс:
```powershell
.\.venv\Scripts\Activate.ps1
python manage.py runserver 0.0.0.0:8000
```

### 3. Установка в эмулятор через ADB
В эмуляторе Visual Studio .NET Android SDK (или любом AVD):
```powershell
C:\android_sdk\platform-tools\adb.exe devices
C:\android_sdk\platform-tools\adb.exe install -r "d:\GDrive\Документы\Visual Studio 2022\ExpertSystem_auto_diag\lecodes_webapp\android\app\build\outputs\apk\debug\app-debug.apk"
```

Приложение подключится к тестовому стенду по адресу `http://10.0.2.2:8000` (дефолтный адрес для Android эмулятора).

### 4. Пересборка при изменениях

Для компиляции изменений TypeScript в бандл le.codes и синхронизации с Android:
```powershell
cd lecodes_webapp
npx lecodes-cli app sync android
```

Для сборки APK:
```powershell
cd android
.\gradlew.bat assembleDebug --no-daemon
```

---

## Лицензия

Проект распространяется строго под лицензией **GPL-3.0 (GNU General Public License v3.0)**.
