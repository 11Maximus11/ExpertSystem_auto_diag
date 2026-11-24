/**
 * Экран «Настройки & Инженерное меню стенда».
 * Включает:
 * 1. ИНЖЕНЕРНОЕ МЕНЮ (Dev Mode) для динамической смены базового адреса (IP и порт)
 *    тестового стенда (Android Emulator 10.0.2.2:8000, localhost:8000, Wi-Fi 192.168.x.x:8000).
 * 2. Ping-тест связи со стендом с замером задержки.
 * 3. Настройки интеллектуального кэширования ресурсов (Cache API + LocalStorage).
 * 4. Диагностику аппаратных интерфейсов (Web Bluetooth, Web Serial, BLE).
 * Адаптирован для вертикальных экранов смартфонов.
 * Лицензия: GPL-3.0
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

  // Реактивное состояние для инженерного меню (по умолчанию открыто или разблокировано)
  const isDevUnlockedSignal = signal<boolean>(cacheManager.getSetting("dev_menu_unlocked", true));
  const tapCountSignal = signal(0);
  const tapNoticeSignal = signal("");
  const devTestResultSignal = signal("");
  const isTestingSignal = signal(false);

  const hasBt = WebBluetoothOBD.isSupported();
  const hasSerial = WebSerialOBD.isSupported();
  const hasCache = cacheManager.isCacheApiSupported();

  const handleVersionTap = () => {
    tapCountSignal.value++;
    const remaining = 7 - tapCountSignal.value;

    if (remaining > 0 && remaining < 5) {
      tapNoticeSignal.value = `Нажмите ещё ${remaining} раз для переключения режима разработчика...`;
    } else if (remaining <= 0) {
      tapCountSignal.value = 0;
      isDevUnlockedSignal.value = !isDevUnlockedSignal.value;
      cacheManager.saveSetting("dev_menu_unlocked", isDevUnlockedSignal.value);
      tapNoticeSignal.value = isDevUnlockedSignal.value
        ? "Инженерное меню разработчика разблокировано!"
        : "Инженерное меню скрыто";
    }
  };

  const handleSaveDevUrl = (urlToSave: string) => {
    const clean = urlToSave.trim().replace(/\/+$/, "");
    apiClient.setBaseUrl(clean);
    apiUrlSignal.value = apiClient.getBaseUrl();
    devTestResultSignal.value = `✓ Адрес стенда сохранен: ${apiUrlSignal.value || "Относительный путь (/)"}`;
  };

  const handleTestPing = async (targetUrl: string) => {
    if (isTestingSignal.value) return;
    isTestingSignal.value = true;
    devTestResultSignal.value = `Проверка связи с ${targetUrl || "хостом"}...`;

    try {
      const res = await apiClient.testConnection(targetUrl);
      if (res.ok) {
        devTestResultSignal.value = `[OK] ${res.message}`;
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
      syncMsgSignal.value = `Успешно загружено кодов: ${count}`;
    } catch (e: any) {
      syncMsgSignal.value = `Ошибка синхронизации: ${e.message}`;
    }
  };

  const handleClearCache = async () => {
    await cacheManager.clearCache();
    cacheStatsSignal.value = cacheManager.getStats();
    syncMsgSignal.value = "Кэш приложения очищен";
  };

  const header = HeaderBar(
    "Настройки & Инженерное меню",
    "Конфигурация сервера, кэша и аппаратных датчиков"
  );

  // --- БЛОК ИНЖЕНЕРНОГО МЕНЮ СТЕНДА ---
  let devUrlInputField: any = null;
  const devUrlInputText = signal(apiUrlSignal.value);

  devUrlInputField = UIInput()
    .style({
      placeholder: "http://10.0.2.2:8000",
      backgroundColor: "#090d16",
      color: "#f8fafc",
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 9,
      fontSize: 13,
      borderWidth: 1,
      borderColor: "#f59e0b",
      flex: 1
    })
    .onChange((val: string) => {
      devUrlInputText.value = val;
    });
  devUrlInputField.value = devUrlInputText.value;

  const setPreset = (presetUrl: string) => {
    devUrlInputText.value = presetUrl;
    if (devUrlInputField) {
      devUrlInputField.value = presetUrl;
    }
  };

  const engineeringSection = UIColumn(
    UIRow(
      UIRow().style({
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: "#f59e0b",
        marginRight: 6,
        alignSelf: "center"
      }),
      UIText("ИНЖЕНЕРНОЕ МЕНЮ СТЕНДА (DEV MODE)").style({ color: "#f59e0b", fontSize: 13, fontWeight: "bold", flex: 1 }),
      UIButton(
        UIText(() => (isDevUnlockedSignal.value ? "Свернуть" : "Развернуть")).style({ color: "#94a3b8", fontSize: 11 })
      )
        .style({ padding: 4 })
        .onClick(() => {
          isDevUnlockedSignal.value = !isDevUnlockedSignal.value;
          cacheManager.saveSetting("dev_menu_unlocked", isDevUnlockedSignal.value);
        })
    ).style({ alignItems: "center", marginBottom: 6, width: "100%" }),

    UIText("Настройка IP и порта бэкенда для отладки в эмуляторах и на тестовых стендах:")
      .style({ color: "#cbd5e1", fontSize: 11, lineHeight: 16, marginBottom: 10 }),

    UIText("Базовый URL API сервера:").style({ color: "#94a3b8", fontSize: 11, marginBottom: 4 }),
    UIRow(
      devUrlInputField,
      UIRow().style({ width: 6 }),
      PrimaryButton("Сохранить", () => handleSaveDevUrl(devUrlInputText.value)),
      UIRow().style({ width: 6 }),
      SecondaryButton(
        () => (isTestingSignal.value ? "..." : "Ping"),
        () => handleTestPing(devUrlInputText.value)
      )
    ).style({ alignItems: "center", marginBottom: 8, width: "100%", flexWrap: "wrap", gap: 6 }),

    UIText("Быстрые пресеты стенда:").style({ color: "#94a3b8", fontSize: 11, marginBottom: 4 }),
    UIRow(
      UIButton(UIText("10.0.2.2 (VS Emulator)").style({ color: "#38bdf8", fontSize: 11, fontWeight: "600" }))
        .style({ backgroundColor: "#1e293b", paddingHorizontal: 8, paddingVertical: 5, borderRadius: 6, marginRight: 4, marginBottom: 4 })
        .onClick(() => setPreset("http://10.0.2.2:8000")),

      UIButton(UIText("localhost:8000").style({ color: "#34d399", fontSize: 11, fontWeight: "600" }))
        .style({ backgroundColor: "#1e293b", paddingHorizontal: 8, paddingVertical: 5, borderRadius: 6, marginRight: 4, marginBottom: 4 })
        .onClick(() => setPreset("http://localhost:8000")),

      UIButton(UIText("Wi-Fi (192.168.1.100)").style({ color: "#fbbf24", fontSize: 11, fontWeight: "600" }))
        .style({ backgroundColor: "#1e293b", paddingHorizontal: 8, paddingVertical: 5, borderRadius: 6, marginRight: 4, marginBottom: 4 })
        .onClick(() => setPreset("http://192.168.1.100:8000")),

      UIButton(UIText("Относительный (/)").style({ color: "#94a3b8", fontSize: 11 }))
        .style({ backgroundColor: "#1e293b", paddingHorizontal: 8, paddingVertical: 5, borderRadius: 6, marginBottom: 4 })
        .onClick(() => setPreset(""))
    ).style({ flexWrap: "wrap", width: "100%" }),

    UIText(() => devTestResultSignal.value).style({
      color: () =>
        devTestResultSignal.value.includes("[OK]")
          ? "#10b981"
          : devTestResultSignal.value.includes("[ОШИБКА]")
          ? "#ef4444"
          : "#f59e0b",
      fontSize: 12,
      marginTop: 6,
      fontFamily: "monospace"
    })
  ).style({
    backgroundColor: "rgba(245, 158, 11, 0.08)",
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: "#f59e0b",
    marginBottom: 12,
    width: "100%"
  });

  // --- Блок кэширования ---
  const cacheSection = UIColumn(
    UIText("Интеллектуальное кэширование (Офлайн-база)").style({ color: "#f8fafc", fontSize: 14, fontWeight: "bold" }),
    UIText("Обеспечивает мгновенный доступ к словарям кодов и истории без интернета:")
      .style({ color: "#94a3b8", fontSize: 11, marginTop: 2, marginBottom: 10 }),

    UIRow(
      UIColumn(
        UIText("Кодов DTC:").style({ color: "#94a3b8", fontSize: 11 }),
        UIText(() => `${cacheStatsSignal.value.dtcCount} кодов`).style({ color: "#38bdf8", fontSize: 16, fontWeight: "bold", marginTop: 2 })
      ).style({ flex: 1, minWidth: 90 }),
      UIColumn(
        UIText("Сессий:").style({ color: "#94a3b8", fontSize: 11 }),
        UIText(() => `${cacheStatsSignal.value.sessionsCount} шт`).style({ color: "#34d399", fontSize: 16, fontWeight: "bold", marginTop: 2 })
      ).style({ flex: 1, minWidth: 90 }),
      UIColumn(
        UIText("Синхронизация:").style({ color: "#94a3b8", fontSize: 11 }),
        UIText(() => cacheStatsSignal.value.lastDtcSync || "Не выполнялась").style({ color: "#cbd5e1", fontSize: 11, marginTop: 2 })
      ).style({ flex: 1, minWidth: 100 })
    ).style({ marginBottom: 12, flexWrap: "wrap", gap: 8, width: "100%" }),

    UIRow(
      PrimaryButton("Синхронизировать словарь с бэкендом", handleSyncDtc),
      SecondaryButton("Очистить кэш", handleClearCache)
    ).style({ alignItems: "center", flexWrap: "wrap", gap: 6, width: "100%" }),

    UIText(() => syncMsgSignal.value).style({ color: "#f59e0b", fontSize: 12, marginTop: 6 })
  ).style({
    backgroundColor: "#131b2e",
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: "#1e293b",
    marginBottom: 12,
    width: "100%"
  });

  // --- Блок аппаратных возможностей ---
  const renderCapRow = (name: string, supported: boolean, desc: string) => {
    return UIRow(
      UIRow().style({
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: supported ? "#10b981" : "#ef4444",
        marginRight: 8,
        alignSelf: "center",
        flexShrink: 0
      }),
      UIColumn(
        UIText(name).style({ color: "#ffffff", fontSize: 12, fontWeight: "bold" }),
        UIText(desc).style({ color: "#94a3b8", fontSize: 11, marginTop: 1 })
      ).style({ flex: 1 }),
      UIText(supported ? "✓ Есть" : "✗ Нет")
        .style({ color: supported ? "#10b981" : "#ef4444", fontSize: 11, fontWeight: "bold", alignSelf: "center", flexShrink: 0, marginLeft: 6 })
    ).style({
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderColor: "#1e293b",
      width: "100%"
    });
  };

  const hardwareSection = UIColumn(
    UIText("Аппаратные интерфейсы (OBD-II проброс)").style({ color: "#f8fafc", fontSize: 14, fontWeight: "bold" }),
    UIText("Поддержка прямого проброса датчиков через Web APIs и Android:")
      .style({ color: "#94a3b8", fontSize: 11, marginTop: 2, marginBottom: 8 }),
    renderCapRow("Web Bluetooth API", hasBt, "ELM327 BLE и беспроводные OBD-сканеры"),
    renderCapRow("Web Serial API", hasSerial, "USB/COM сканеры (FTDI, CH340, CP2102)"),
    renderCapRow("Cache Storage API", hasCache, "Офлайн-хранилище базы знаний DTC"),
    UIColumn(
      UIText("Подсказка для Android / VS Emulator:").style({ color: "#f59e0b", fontSize: 11, fontWeight: "bold", marginTop: 8 }),
      UIText("• В Android приложении разрешения BLUETOOTH_SCAN, CONNECT, CAMERA и RECORD_AUDIO уже включены в манифест.")
        .style({ color: "#94a3b8", fontSize: 11, marginTop: 2 }),
      UIText("• Для подключения к эмулятору используйте адрес http://10.0.2.2:8000.")
        .style({ color: "#94a3b8", fontSize: 11, marginTop: 2 })
    )
  ).style({
    backgroundColor: "#131b2e",
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: "#1e293b",
    marginBottom: 12,
    width: "100%"
  });

  // --- Нижняя плашка с версией (Easter Egg) ---
  const versionEasterEggButton = UIButton(
    UIColumn(
      UIText("ИИдеал-Авто • Версия 1.0.0 (le.codes Native Client)").style({
        color: "#64748b",
        fontSize: 12,
        textAlign: "center"
      }),
      UIText("Движок: le.codes SDK 2.12+ • Лицензия: GPL-3.0").style({
        color: "#475569",
        fontSize: 10,
        textAlign: "center",
        marginTop: 2
      }),
      UIText(() => tapNoticeSignal.value).style({
        color: "#f59e0b",
        fontSize: 11,
        textAlign: "center",
        marginTop: 4
      })
    ).style({ alignItems: "center" })
  )
    .style({
      paddingVertical: 10,
      alignItems: "center",
      justifyContent: "center",
      $pressed: { opacity: 0.6 }
    })
    .onClick(handleVersionTap);

  const scrollBody = UIScrollable(
    UIColumn(
      engineeringSection,
      cacheSection,
      hardwareSection,
      versionEasterEggButton
    ).style({ padding: 14, maxWidth: 860, alignSelf: "center", width: "100%", paddingBottom: 24 })
  ).style({ flex: 1, width: "100%" });

  return UIScreen(header, scrollBody).style({ backgroundColor: "#0a0f1d", flex: 1, width: "100%", height: "100%" });
}
