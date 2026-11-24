/**
 * Главная точка входа Android-приложения и веб-клиента ИИдеал-Авто на базе библиотеки le.codes.
 *
 * Архитектура:
 * - 100% нативные разделы и графика (UIScreen, UITabs, UIColumn, UIRow, MetricCard, DtcChip, UIModal).
 * - Полная поддержка протокола ELM327 (Web Bluetooth, Web Serial, Demo Simulator).
 * - Бэкенд подключен к Django REST API (/api/ask/, /api/sessions/, /api/dtc/, /api/settings/).
 * - Инженерное меню (Dev Mode) для динамической смены домена/IP бэкенда при отладке в эмуляторе
 *   (10.0.2.2:8000), на локальном ПК (localhost:8000) или в Wi-Fi сети (192.168.x.x:8000).
 * - Адаптивная мобильная верстка без переполнений и проблем с масштабированием на вертикальных экранах.
 *
 * Лицензия: GPL-3.0
 */

import { apiClient } from "./src/api/BackendApiClient";
import { cacheManager } from "./src/cache/ResourceCacheManager";
import { obdProtocol } from "./src/obd/ELM327Protocol";
import { createDiagnosticsScreen } from "./src/ui/DiagnosticsScreen";
import { createDtcDictionaryScreen } from "./src/ui/DtcDictionaryScreen";
import { createObdScannerScreen } from "./src/ui/ObdScannerScreen";
import { createSessionsHistoryScreen } from "./src/ui/SessionsHistoryScreen";
import { createSettingsScreen } from "./src/ui/SettingsScreen";
import { PrimaryButton, SecondaryButton } from "./src/ui/components";

// 1. Конфигурация темы приложения le.codes
theme({
  bg: "#0a0f1d",
  surface: "#121a2d",
  accent: "#2563eb",
  text: "#f8fafc",
  textMuted: "#94a3b8",
  border: "#1e293b",
  colorScheme: "dark"
});

// 2. Реактивное состояние оболочки
const DEFAULT_URL = "http://10.0.2.2:8000";
const serverUrl = signal<string>(apiClient.getBaseUrl() || DEFAULT_URL).stored("pwa_server_url");

if (serverUrl.value) {
  apiClient.setBaseUrl(serverUrl.value);
}

// Диагностика сети в инженерном меню
const pingLatency = signal<string>("не проверялась");
const isPinging = signal<boolean>(false);
const urlInputValue = signal<string>(serverUrl.value || DEFAULT_URL);

// Состояние телеметрии OBD-II для быстрого оверлея
const obdState = signal({
  rpm: 0,
  speed: 0,
  coolantTemp: 0,
  batteryVoltage: 12.6,
  status: "ELM327 готов"
});

const isHudVisible = signal<boolean>(false);

obdProtocol.onSensorsUpdate = (s) => {
  obdState.value = {
    rpm: s.rpm,
    speed: s.speed,
    coolantTemp: s.coolantTemp,
    batteryVoltage: s.voltage,
    status: obdProtocol.getStatusMessage()
  };
};

// 3. Быстрый выдвижной мини-HUD бар (телеметрия над экранами)
const obdMiniHud = UIColumn(
  UIRow(
    UIColumn(
      UIText("RPM").style({ fontSize: 9, color: "#64748b", fontWeight: "bold" }),
      UIText(() => `${obdState.value.rpm}`).style({ fontSize: 16, fontWeight: "bold", color: "#38bdf8" })
    ).style({ flex: 1, alignItems: "center" }),

    UIColumn(
      UIText("Скорость").style({ fontSize: 9, color: "#64748b", fontWeight: "bold" }),
      UIText(() => `${obdState.value.speed}`).style({ fontSize: 16, fontWeight: "bold", color: "#22c55e" })
    ).style({ flex: 1, alignItems: "center" }),

    UIColumn(
      UIText("ОЖ").style({ fontSize: 9, color: "#64748b", fontWeight: "bold" }),
      UIText(() => `${obdState.value.coolantTemp}°`).style({ fontSize: 16, fontWeight: "bold", color: "#f59e0b" })
    ).style({ flex: 1, alignItems: "center" }),

    UIColumn(
      UIText("АКБ").style({ fontSize: 9, color: "#64748b", fontWeight: "bold" }),
      UIText(() => `${obdState.value.batteryVoltage.toFixed(1)}V`).style({ fontSize: 16, fontWeight: "bold", color: "#a855f7" })
    ).style({ flex: 1, alignItems: "center" }),

    UIButton(
      UIText(() => (obdProtocol.getStatus() === "connected" && obdProtocol.getTransportType() === "demo" ? "Стоп тест" : "Демо")).style({
        fontSize: 10,
        color: "#ffffff",
        fontWeight: "bold"
      })
    )
      .style({
        backgroundColor: "#2563eb",
        paddingHorizontal: 8,
        paddingVertical: 5,
        borderRadius: 6
      })
      .onClick(() => {
        if (obdProtocol.getStatus() === "connected" && obdProtocol.getTransportType() === "demo") {
          obdProtocol.disconnect();
        } else {
          obdProtocol.connect("demo");
        }
      })
  ).style({
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: "rgba(10, 15, 29, 0.96)",
    borderBottomWidth: 1,
    borderColor: "#2563eb",
    alignItems: "center",
    width: "100%"
  })
).style({
  width: "100%",
  display: () => (isHudVisible.value ? "flex" : "none")
});

// 4. Модальное Инженерное Меню (Dev Mode)
let devUrlInput: any = null;
devUrlInput = UIInput()
  .style({
    placeholder: "http://10.0.2.2:8000",
    backgroundColor: "#0a0f1d",
    borderColor: "#2563eb",
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: "#f8fafc",
    fontSize: 13,
    marginTop: 6,
    width: "100%"
  })
  .onChange((val: string) => {
    urlInputValue.value = val;
  });
devUrlInput.value = urlInputValue.value;

async function testServerConnection(targetUrl: string) {
  isPinging.value = true;
  pingLatency.value = "Запрос отправлен...";
  try {
    const res = await apiClient.testConnection(targetUrl);
    if (res.ok) {
      pingLatency.value = `✓ ${res.message}`;
    } else {
      pingLatency.value = `⚠️ ${res.message}`;
    }
  } catch (err: any) {
    pingLatency.value = `✗ Ошибка: ${err?.message || "Сервер недоступен"}`;
  } finally {
    isPinging.value = false;
  }
}

function createPresetButton(title: string, presetUrl: string) {
  return UIButton(
    UIText(title).style({
      fontSize: 11,
      color: "#38bdf8",
      fontWeight: "500"
    })
  )
    .style({
      backgroundColor: "#131b2e",
      borderColor: "#1e293b",
      borderWidth: 1,
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 5,
      marginRight: 4,
      marginBottom: 4
    })
    .onClick(() => {
      urlInputValue.value = presetUrl;
      if (devUrlInput) {
        devUrlInput.value = presetUrl;
      }
    });
}

const devMenuModal = UIModal(
  UIColumn(
    UIRow(
      UIText("🛠️ Инженерное меню (Dev Mode)").style({
        fontSize: 15,
        fontWeight: "bold",
        color: "#f8fafc",
        flex: 1
      }),
      UIButton(
        UIText("✕").style({ fontSize: 16, color: "#94a3b8" })
      )
        .style({ padding: 4 })
        .onClick(() => {
          devMenuModal.hide();
        })
    ).style({ alignItems: "center", marginBottom: 6, width: "100%" }),

    UIText("Настройка базового адреса Django API для Android-эмулятора и сети:").style({
      fontSize: 11,
      color: "#94a3b8",
      marginBottom: 6
    }),

    devUrlInput,

    UIText("Быстрые пресеты стенда:").style({
      fontSize: 11,
      color: "#64748b",
      marginTop: 8,
      marginBottom: 4
    }),
    UIRow(
      createPresetButton("10.0.2.2 (VS Emulator)", "http://10.0.2.2:8000"),
      createPresetButton("localhost:8000", "http://localhost:8000"),
      createPresetButton("Wi-Fi (192.168.1.100)", "http://192.168.1.100:8000"),
      createPresetButton("Относительный (/)", "")
    ).style({ flexWrap: "wrap", marginBottom: 8, width: "100%" }),

    UIRow(
      UIText("Статус связи: ").style({ fontSize: 11, color: "#64748b" }),
      UIText(() => pingLatency.value).style({
        fontSize: 11,
        color: () => (pingLatency.value.startsWith("✓") ? "#10b981" : "#f59e0b"),
        flex: 1
      })
    ).style({ alignItems: "center", marginBottom: 12, width: "100%" }),

    UIRow(
      SecondaryButton(
        () => (isPinging.value ? "Тест..." : "Ping"),
        () => testServerConnection(urlInputValue.value || serverUrl.value)
      ),
      UIRow().style({ width: 6 }),
      SecondaryButton("Сброс кэша", () => {
        cacheManager.clearCache();
        pingLatency.value = "Кэш приложения очищен";
      }),
      UISpacer(),
      PrimaryButton("Сохранить и применить", () => {
        const newUrl = (urlInputValue.value || serverUrl.value).trim().replace(/\/+$/, "");
        serverUrl.value = newUrl;
        apiClient.setBaseUrl(newUrl);
        pingLatency.value = `Базовый URL установлен: ${newUrl || "Относительный"}`;
        devMenuModal.hide();
      })
    ).style({ alignItems: "center", width: "100%", flexWrap: "wrap", gap: 6 })
  ).style({
    backgroundColor: "#121a2d",
    borderColor: "#1e293b",
    borderWidth: 1,
    borderRadius: 14,
    padding: 16,
    width: "92%",
    maxWidth: 440
  })
);

export function openDevMenu() {
  urlInputValue.value = serverUrl.value || DEFAULT_URL;
  if (devUrlInput) {
    devUrlInput.value = urlInputValue.value;
  }
  devMenuModal.show();
}

// 5. Инициализация экранов и вкладок
let tabsInstance: any = null;

const diagnosticsScreen = createDiagnosticsScreen({
  onNavigateToDtc: (code) => {
    tabsInstance?.select("dtc");
  },
  onOpenEngineeringMenu: () => {
    openDevMenu();
  }
});

const obdScreen = createObdScannerScreen({
  onSendDtcToAi: (codes) => {
    tabsInstance?.select("diagnostics");
  },
  onOpenEngineeringMenu: () => {
    openDevMenu();
  }
});

const dtcScreen = createDtcDictionaryScreen((code) => {
  tabsInstance?.select("diagnostics");
});

const historyScreen = createSessionsHistoryScreen((session) => {
  tabsInstance?.select("diagnostics");
});

const settingsScreen = createSettingsScreen();

// 6. Сборка UITabs
tabsInstance = UITabs({
  diagnostics: {
    label: "Диагностика",
    icon: assetIcon("lucide:bot"),
    screen: diagnosticsScreen
  },
  obd: {
    label: "Приборы OBD",
    icon: assetIcon("lucide:gauge"),
    screen: obdScreen
  },
  dtc: {
    label: "Коды DTC",
    icon: assetIcon("lucide:triangle-alert"),
    screen: dtcScreen
  },
  history: {
    label: "Сессии",
    icon: assetIcon("lucide:folder-clock"),
    screen: historyScreen
  },
  settings: {
    label: "Настройки",
    icon: assetIcon("lucide:settings"),
    screen: settingsScreen
  }
});

// Настройка стилей таб-бара для удобства на смартфонах
tabsInstance.bar.style({
  backgroundColor: "rgba(10, 15, 29, 0.98)",
  borderTopWidth: 1,
  borderColor: "#1e293b",
  height: 56
});

// Добавляем модальное инженерное меню в экран
tabsInstance.widgets(devMenuModal);

// 7. Монтирование в глобальный роутер le.codes
Router.init(tabsInstance);

console.log("ИИдеал-Авто (le.codes Native Client) успешно запущен. API:", serverUrl.value);
