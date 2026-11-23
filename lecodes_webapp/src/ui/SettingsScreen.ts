/**
 * Экран «Настройки & Кэш».
 * Включает:
 * 1. Стандартные настройки кэширования ресурсов (Cache API + LocalStorage).
 * 2. Диагностику аппаратных Web APIs (Web Bluetooth, Web Serial).
 * 3. СКРЫТОЕ ИНЖЕНЕРНОЕ МЕНЮ (активируется 7 кликами по версии приложения) для смены
 *    непостоянного IP/порта тестового стенда при отладке в Android Emulator / Visual Studio .NET SDK.
 */

import { apiClient } from "../api/BackendApiClient";
import { cacheManager, CacheStats } from "../cache/ResourceCacheManager";
import { WebBluetoothOBD } from "../obd/WebBluetoothOBD";
import { WebSerialOBD } from "../obd/WebSerialOBD";
import { HeaderBar, PrimaryButton, SecondaryButton } from "./components";

export function createSettingsScreen(): any {
  const apiUrlSignal = signal(apiClient.getBaseUrl());
  const cacheStatsSignal = signal<CacheStats>(cacheManager.getStats());
  const syncMsgSignal = signal("");

  // Реактивное состояние для скрытого инженерного меню
  const isDevUnlockedSignal = signal<boolean>(cacheManager.getSetting("dev_menu_unlocked", false));
  const tapCountSignal = signal(0);
  const tapNoticeSignal = signal("");
  const devTestResultSignal = signal("");
  const isTestingSignal = signal(false);

  const hasBt = WebBluetoothOBD.isSupported();
  const hasSerial = WebSerialOBD.isSupported();
  const hasCache = cacheManager.isCacheApiSupported();

  const handleVersionTap = () => {
    if (isDevUnlockedSignal.value) {
      tapNoticeSignal.value = "Инженерное меню уже активно (прокрутите вниз)";
      return;
    }

    tapCountSignal.value++;
    const remaining = 7 - tapCountSignal.value;

    if (remaining > 0) {
      tapNoticeSignal.value = `Нажмите ещё ${remaining} раз(а) для открытия Инженерного меню стенда...`;
    } else {
      isDevUnlockedSignal.value = true;
      cacheManager.saveSetting("dev_menu_unlocked", true);
      tapNoticeSignal.value = "Инженерное меню разработчика разблокировано!";
    }
  };

  const handleSaveDevUrl = (urlToSave: string) => {
    apiClient.setBaseUrl(urlToSave);
    apiUrlSignal.value = apiClient.getBaseUrl();
    devTestResultSignal.value = `Адрес стенда сохранен: ${apiUrlSignal.value || "Относительный путь (/)"}`;
  };

  const handleTestPing = async (targetUrl: string) => {
    if (isTestingSignal.value) return;
    isTestingSignal.value = true;
    devTestResultSignal.value = `Проверка связи с ${targetUrl || "текущим хостом"}...`;

    try {
      const res = await apiClient.testConnection(targetUrl);
      if (res.ok) {
        devTestResultSignal.value = `[OK] ${res.message} (Сервер стенда отвечает)`;
      } else {
        devTestResultSignal.value = `[ВНИМАНИЕ] ${res.message}`;
      }
    } catch (e: any) {
      devTestResultSignal.value = `[ОШИБКА] Не удалось подключиться: ${e.message}`;
    } finally {
      isTestingSignal.value = false;
    }
  };

  const handleSyncDtc = async () => {
    syncMsgSignal.value = "Синхронизация словаря кодов...";
    try {
      const count = await apiClient.syncDtcDictionary();
      cacheStatsSignal.value = cacheManager.getStats();
      syncMsgSignal.value = `Успешно синхронизировано кодов: ${count}`;
    } catch (e: any) {
      syncMsgSignal.value = `Ошибка синхронизации: ${e.message}`;
    }
  };

  const handleClearCache = async () => {
    await cacheManager.clearCache();
    cacheStatsSignal.value = cacheManager.getStats();
    syncMsgSignal.value = "Кэш полностью очищен";
  };

  const header = HeaderBar(
    "Настройки & Оборудование",
    "Конфигурация API, локального хранилища и внешних датчиков"
  );

  // --- Блок кэширования ---
  const cacheSection = UIColumn(
    UIText("Интеллектуальное кэширование ресурсов").style({ color: "#f8fafc", fontSize: 16, fontWeight: "bold" }),
    UIText("Позволяет приложению мгновенно отвечать на запросы и искать коды ошибок даже без интернета.")
      .style({ color: "#94a3b8", fontSize: 13, marginTop: 4, marginBottom: 12 }),
    UIRow(
      UIColumn(
        UIText("Кэшировано кодов DTC:").style({ color: "#94a3b8", fontSize: 12 }),
        UIText(() => `${cacheStatsSignal.value.dtcCount} кодов`).style({ color: "#38bdf8", fontSize: 18, fontWeight: "bold", marginTop: 2 })
      ).style({ flex: 1 }),
      UIColumn(
        UIText("Сохраненных сессий:").style({ color: "#94a3b8", fontSize: 12 }),
        UIText(() => `${cacheStatsSignal.value.sessionsCount} шт`).style({ color: "#34d399", fontSize: 18, fontWeight: "bold", marginTop: 2 })
      ).style({ flex: 1 }),
      UIColumn(
        UIText("Последняя синхронизация:").style({ color: "#94a3b8", fontSize: 12 }),
        UIText(() => cacheStatsSignal.value.lastDtcSync).style({ color: "#cbd5e1", fontSize: 13, marginTop: 4 })
      ).style({ flex: 1 })
    ).style({ marginBottom: 16 }),
    UIRow(
      PrimaryButton("Синхронизировать словарь с сервером", handleSyncDtc),
      UIRow().style({ width: 10 }),
      SecondaryButton("Очистить кэш", handleClearCache),
      UISpacer(),
      UIText(() => syncMsgSignal.value).style({ color: "#f59e0b", fontSize: 13, alignSelf: "center" })
    ).style({ alignItems: "center", flexWrap: "wrap", gap: 8 })
  ).style({
    backgroundColor: "#131b2e",
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: "#1e293b",
    marginBottom: 16
  });

  // --- Блок аппаратных возможностей браузера ---
  const renderCapRow = (name: string, supported: boolean, desc: string) => {
    return UIRow(
      UIRow().style({
        width: 10,
        height: 10,
        borderRadius: 5,
        backgroundColor: supported ? "#10b981" : "#ef4444",
        marginRight: 10,
        alignSelf: "center"
      }),
      UIColumn(
        UIText(name).style({ color: "#ffffff", fontSize: 14, fontWeight: "bold" }),
        UIText(desc).style({ color: "#94a3b8", fontSize: 12, marginTop: 2 })
      ),
      UISpacer(),
      UIText(supported ? "Поддерживается" : "Не поддерживается")
        .style({ color: supported ? "#10b981" : "#ef4444", fontSize: 12, fontWeight: "bold", alignSelf: "center" })
    ).style({
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderColor: "#1e293b"
    });
  };

  const hardwareSection = UIColumn(
    UIText("Аппаратные интерфейсы (Проброс устройств)").style({ color: "#f8fafc", fontSize: 16, fontWeight: "bold" }),
    UIText("Для прямого проброса OBD2 датчиков через браузер или Android PWA/APK:")
      .style({ color: "#94a3b8", fontSize: 13, marginTop: 4, marginBottom: 12 }),
    renderCapRow("Web Bluetooth API", hasBt, "Прямое подключение к ELM327 BLE и беспроводным адаптерам"),
    renderCapRow("Web Serial API", hasSerial, "Прямое подключение к USB/COM сканерам (FTDI, CH340, CP2102)"),
    renderCapRow("Cache Storage API", hasCache, "Офлайн-хранилище статических ресурсов и словарей"),
    UIColumn(
      UIText("Подсказка для Android:").style({ color: "#f59e0b", fontSize: 13, fontWeight: "bold", marginTop: 12 }),
      UIText("• В Android Chrome / WebAPK интерфейс Web Bluetooth работает нативно из коробки с системным диалогом выбора устройств.")
        .style({ color: "#94a3b8", fontSize: 12, marginTop: 4 }),
      UIText("• В нативном APK разрешения BLUETOOTH_SCAN и BLUETOOTH_CONNECT уже прописаны в AndroidManifest.xml.")
        .style({ color: "#94a3b8", fontSize: 12, marginTop: 2 })
    )
  ).style({
    backgroundColor: "#131b2e",
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: "#1e293b",
    marginBottom: 16
  });

  // --- СКРЫТОЕ ИНЖЕНЕРНОЕ МЕНЮ СТЕНДА ---
  let devUrlInputField: any = null;
  const devUrlInputText = signal(apiUrlSignal.value);

  devUrlInputField = UIInput(devUrlInputText.value)
    .style({
      backgroundColor: "#090d16",
      color: "#f8fafc",
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 10,
      fontSize: 14,
      borderWidth: 1,
      borderColor: "#f59e0b",
      flex: 1
    })
    .placeholder("http://10.0.2.2:8000 или http://192.168.1.X:8000")
    .onChange((val: string) => {
      devUrlInputText.value = val;
    });

  const setPreset = (presetUrl: string) => {
    devUrlInputText.value = presetUrl;
    if (devUrlInputField) {
      devUrlInputField.value = presetUrl;
    }
  };

  const engineeringSection = UIColumn(
    UIRow(
      UIRow().style({
        backgroundColor: "#f59e0b",
        borderRadius: 4,
        paddingHorizontal: 8,
        paddingVertical: 2,
        marginRight: 8,
        alignSelf: "center"
      }),
      UIText("ИНЖЕНЕРНОЕ МЕНЮ СТЕНДА (DEV MODE)").style({ color: "#f59e0b", fontSize: 15, fontWeight: "bold" }),
      UISpacer(),
      UIButton(
        UIText("Скрыть меню").style({ color: "#94a3b8", fontSize: 12 })
      )
        .style({ padding: 4, $pressed: { opacity: 0.7 } })
        .onClick(() => {
          isDevUnlockedSignal.value = false;
          cacheManager.saveSetting("dev_menu_unlocked", false);
          tapNoticeSignal.value = "Инженерное меню скрыто";
        })
    ).style({ alignItems: "center", marginBottom: 8 }),

    UIText("Прямая смена IP и порта бэкенда для отладки в эмуляторах (Visual Studio .NET Android SDK, AVD) и на тестовых стендах с динамическим IP.")
      .style({ color: "#cbd5e1", fontSize: 13, lineHeight: 18, marginBottom: 14 }),

    UIText("Базовый URL API сервера:").style({ color: "#94a3b8", fontSize: 12, marginBottom: 4 }),
    UIRow(
      devUrlInputField,
      UIRow().style({ width: 8 }),
      PrimaryButton("Сохранить", () => handleSaveDevUrl(devUrlInputText.value)),
      UIRow().style({ width: 8 }),
      SecondaryButton("Ping", () => handleTestPing(devUrlInputText.value))
    ).style({ alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 6 }),

    UIText("Быстрые пресеты для отладки:").style({ color: "#94a3b8", fontSize: 12, marginBottom: 6 }),
    UIRow(
      UIButton(UIText("Эмулятор VS (10.0.2.2:8000)").style({ color: "#38bdf8", fontSize: 12, fontWeight: "bold" }))
        .style({ backgroundColor: "#1e293b", paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, marginRight: 6, marginBottom: 6 })
        .onClick(() => setPreset("http://10.0.2.2:8000")),

      UIButton(UIText("Локальный ПК (localhost:8000)").style({ color: "#34d399", fontSize: 12, fontWeight: "bold" }))
        .style({ backgroundColor: "#1e293b", paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, marginRight: 6, marginBottom: 6 })
        .onClick(() => setPreset("http://localhost:8000")),

      UIButton(UIText("Wi-Fi стенд (192.168.1.100:8000)").style({ color: "#fbbf24", fontSize: 12, fontWeight: "bold" }))
        .style({ backgroundColor: "#1e293b", paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, marginRight: 6, marginBottom: 6 })
        .onClick(() => setPreset("http://192.168.1.100:8000")),

      UIButton(UIText("Относительный (/)").style({ color: "#94a3b8", fontSize: 12 }))
        .style({ backgroundColor: "#1e293b", paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, marginBottom: 6 })
        .onClick(() => setPreset(""))
    ).style({ flexWrap: "wrap" }),

    UIText(() => devTestResultSignal.value).style({
      color: () => (devTestResultSignal.value.includes("[OK]") ? "#10b981" : devTestResultSignal.value.includes("[ОШИБКА]") ? "#ef4444" : "#f59e0b"),
      fontSize: 13,
      marginTop: 8,
      fontFamily: "monospace"
    })
  ).style({
    backgroundColor: "rgba(245, 158, 11, 0.07)",
    borderRadius: 14,
    padding: 16,
    borderWidth: 2,
    borderColor: "#f59e0b",
    marginBottom: 20
  });

  // --- Нижняя плашка с версией (Easter Egg) ---
  const versionEasterEggButton = UIButton(
    UIColumn(
      UIText("ИИдеал-Авто • Версия 1.0.0 (Build 2026.11-lecodes)").style({
        color: "#64748b",
        fontSize: 13,
        textAlign: "center"
      }),
      UIText("Движок: le.codes SDK • Лицензия: GPL-3.0").style({
        color: "#475569",
        fontSize: 11,
        textAlign: "center",
        marginTop: 2
      }),
      UIText(() => tapNoticeSignal.value).style({
        color: "#f59e0b",
        fontSize: 12,
        textAlign: "center",
        marginTop: 4
      })
    ).style({ alignItems: "center" })
  )
    .style({
      paddingVertical: 14,
      alignItems: "center",
      justifyContent: "center",
      $pressed: { opacity: 0.6 }
    })
    .onClick(handleVersionTap);

  const scrollBody = UIScrollable(
    UIColumn(
      () => (isDevUnlockedSignal.value ? engineeringSection : null),
      cacheSection,
      hardwareSection,
      versionEasterEggButton
    ).style({ padding: 20, maxWidth: 960, alignSelf: "center", width: "100%" })
  ).style({ flexGrow: 1 });

  return UIScreen(header, scrollBody).style({ backgroundColor: "#0a0f1d", flex: 1 });
}
