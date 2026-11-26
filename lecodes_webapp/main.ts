/**
 * Главная точка входа ИИдеал-Авто для платформы le.codes (Native Android & Web).
 * Объединяет все экраны («Диагноз», «Чеклист & DTC», «OBD-2», «Сессии», «Настройки»),
 * единый оверлей AR/VR HUD, реактивную смену тем и начальную синхронизацию с Django API.
 *
 * Лицензия: GPL-3.0
 */

import "./src/utils/polyfills";

import { apiClient } from "./src/api/BackendApiClient";
import { externalDisplayBridge } from "./src/ar/ExternalDisplayBridge";
import { cacheManager } from "./src/cache/ResourceCacheManager";
import { appState, createWelcomeMessage } from "./src/state/appState";

// Инициализируем нативный мост внешнего AR-дисплея (RayNeo / XREAL / эмулируемый 2-й экран)
externalDisplayBridge.init();
import {
  createArHudOverlay,
  currentThemeSignal,
  openFirstLaunchConsentModal,
  THEME
} from "./src/ui/components";
import { createDiagnosticsScreen } from "./src/ui/DiagnosticsScreen";
import { createDtcDictionaryScreen } from "./src/ui/DtcDictionaryScreen";
import { createObdScannerScreen } from "./src/ui/ObdScannerScreen";
import { createSessionsHistoryScreen } from "./src/ui/SessionsHistoryScreen";
import { createSettingsScreen } from "./src/ui/SettingsScreen";

// Глобальный двухрежимный AR / VR HUD оверлей (доступен с любого экрана)
const arHudModal = createArHudOverlay({
  getSensors: () => appState.obdStateSignal.value,
  onClose: () => {}
});

const openGlobalArHud = (mode: "optical" | "vr" = "optical") => {
  if (typeof arHudModal.openWithMode === "function") {
    arHudModal.openWithMode(mode);
  } else {
    arHudModal.show();
  }
};

let tabs: any = null;

const switchTab = (tabId: string) => {
  if (tabs && typeof tabs.select === "function") {
    tabs.select(tabId);
  }
};

appState.switchTabFn = switchTab;

// Экраны приложения внутри безопасных отступов системных панелей Android
const wrapTabScreen = (content: any) =>
  UIScreen(content).style({
    backgroundColor: () => THEME.bgBase,
    paddingTop: "safe-top"
  });

const diagScreen = wrapTabScreen(
  createDiagnosticsScreen({
    onOpenAr: () => openGlobalArHud("optical"),
    onOpenSettings: () => switchTab("settings"),
    onOpenObd: () => switchTab("obd"),
    onOpenDtc: () => switchTab("dtc"),
    onOpenSessions: () => switchTab("sessions")
  })
);

const dtcScreen = wrapTabScreen(
  createDtcDictionaryScreen({
    onSelectCode: () => switchTab("diag"),
    onOpenAr: () => openGlobalArHud("optical"),
    onOpenSettings: () => switchTab("settings")
  })
);

const obdScreen = wrapTabScreen(
  createObdScannerScreen({
    onOpenAr: () => openGlobalArHud("optical"),
    onOpenSettings: () => switchTab("settings"),
    onAttachToAi: () => switchTab("diag")
  })
);

const sessionsScreen = wrapTabScreen(
  createSessionsHistoryScreen({
    onOpenSession: () => switchTab("diag"),
    onOpenAr: () => openGlobalArHud("optical"),
    onOpenSettings: () => switchTab("settings")
  })
);

const settingsScreen = wrapTabScreen(
  createSettingsScreen({
    onOpenAr: () => openGlobalArHud("optical"),
    onServerUrlChanged: () => {
      void bootstrapFromServer();
    },
    onAuthChanged: () => {
      appState.sessionsRefreshCounterSignal.value++;
    }
  })
);

// Нижняя панель навигации по разделам
tabs = UITabs({
  diag: {
    label: "Диагноз",
    icon: assetIcon("lucide:bot"),
    screen: diagScreen
  },
  dtc: {
    label: "Чеклист",
    icon: assetIcon("lucide:check-check"),
    screen: dtcScreen
  },
  obd: {
    label: "OBD-2",
    icon: assetIcon("lucide:gauge"),
    screen: obdScreen
  },
  sessions: {
    label: "Сессии",
    icon: assetIcon("lucide:folder-clock"),
    screen: sessionsScreen
  },
  settings: {
    label: "Настройки",
    icon: assetIcon("lucide:settings"),
    screen: settingsScreen
  }
});

// Реактивная синхронизация оформления нижней панели вкладок с активной темой
effect(() => {
  const _mode = currentThemeSignal.value;
  void _mode;
  try {
    tabs.bar.theme({
      accent: THEME.accentOrange,
      textMuted: THEME.textMuted,
      surface: THEME.bgSurface,
      border: THEME.borderDefault
    });
  } catch (_) {}
});

// Инициализация навигации
Router.init(tabs);

// Системная кнопка "Назад": сначала возвращаемся на главный экран диагностики
try {
  tabs.onBack(() => {
    if (tabs.tab !== "diag") {
      tabs.select("diag");
    }
  });
} catch (_) {}

// =========================================================================
// НАЧАЛЬНАЯ СИНХРОНИЗАЦИЯ С СЕРВЕРОМ ПРИ ЗАПУСКЕ ПРИЛОЖЕНИЯ
// =========================================================================

async function bootstrapFromServer(): Promise<void> {
  try {
    const isOnline = await apiClient.checkConnectivity();
    if (!isOnline) {
      return;
    }

    const auth = await apiClient.getAuthStatus();
    if (auth.is_authenticated && auth.username) {
      appState.currentUserSignal.value = {
        username: auth.username,
        email: auth.email || auth.user?.email,
        is_staff: auth.user?.is_staff,
        is_authenticated: true
      };

      const srvSettings = await apiClient.getSettings();
      appState.crossMemoryEnabledSignal.value = srvSettings.cross_dialog_memory_enabled;
      appState.globalMemorySummarySignal.value = srvSettings.global_memory_summary || "";

      const sessions = await apiClient.getSessions();
      if (sessions.length > 0) {
        const preferredId = cacheManager.getSetting<string>("active_session_id", "");
        const targetSession =
          sessions.find(s => s.id === preferredId) || sessions[0];
        const detail = await apiClient.getSessionDetail(targetSession.id);
        if (detail) {
          appState.currentSessionIdSignal.value = detail.id;
          appState.currentSessionTitleSignal.value = detail.title;
          if (detail.vehicle_info) {
            appState.vehicleSignal.value = detail.vehicle_info;
          }
          appState.sessionSummarySignal.value = detail.summary || "";
          const msgs =
            detail.messages.length > 0 ? detail.messages : [createWelcomeMessage()];
          appState.messagesSignal.value = msgs;
          appState.latestAssistantMessageSignal.value =
            [...msgs].reverse().find(m => m.role === "assistant") || msgs[0];
        }
      }
      appState.sessionsRefreshCounterSignal.value++;
    } else {
      appState.currentUserSignal.value = { username: "", is_authenticated: false };
    }
  } catch (_) {}

  // Фоновая синхронизация справочника DTC при первом запуске
  try {
    const cachedCount = cacheManager.getStats().dtcCount;
    if (cachedCount < 20) {
      void apiClient.syncDtcDictionary();
    }
  } catch (_) {}
}

// Автоматическое отслеживание онлайн-статуса и восстановление связи
try {
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("offline", () => {
      appState.isOnlineSignal.value = false;
      appState.offlineReasonSignal.value = "Нет подключения к интернету";
    });
    window.addEventListener("online", () => {
      void apiClient.checkConnectivity();
    });
  }
} catch (_) {}

setInterval(() => {
  if (!appState.isOnlineSignal.value) {
    void apiClient.checkConnectivity();
  }
}, 10000);

// При самом первом входе в приложение запрашиваем согласие на cookies, Условия и Политику (152-ФЗ)
openFirstLaunchConsentModal();

void bootstrapFromServer();
