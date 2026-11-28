// ИИдеал Авто — Главная точка входа автономного приложения (le.codes / le.store) (2026-11-28)
// Copyright (C) 2026 ИИдеал Авто (LeCodes48 Edition)
// Licensed under the GNU General Public License v3.0 (GPL-3.0).

import "./src/utils/polyfills";

import {
  appState,
  askExpertHandler,
  bootstrapAppState,
  stageDtcCodes,
} from "./src/state/appState";
import {
  createArHudOverlay,
  currentThemeSignal,
  openDataLossWarningModal,
  THEME,
} from "./src/ui/components";
import { createDiagnosticsScreen } from "./src/ui/DiagnosticsScreen";
import { createDtcDictionaryScreen } from "./src/ui/DtcDictionaryScreen";
import { createObdScannerScreen } from "./src/ui/ObdScannerScreen";
import { createSessionsHistoryScreen } from "./src/ui/SessionsHistoryScreen";
import { createSettingsScreen } from "./src/ui/SettingsScreen";
import { openVehicle3DInspector } from "./src/ui/Vehicle3DInspector";

// 1. Инициализация локальной базы знаний (12 141 DTC), БД устройства и ELM327-колбэков
bootstrapAppState();

const TAB_KEYS = ["diag", "dtc", "obd", "sessions", "settings"] as const;
let tabs: any = null;

const switchTab = (tabId: (typeof TAB_KEYS)[number]) => {
  const idx = TAB_KEYS.indexOf(tabId);
  if (idx >= 0) {
    appState.activeTabSignal.value = idx;
  }
  if (tabs && typeof tabs.select === "function") {
    tabs.select(tabId);
  }
};

// 2. Глобальный AR / VR HUD и 3D-инспектор подсистем автомобиля
const openGlobal3d = () => {
  openVehicle3DInspector(appState.active3dSubsystemSignal.value, (promptText, dtcHints) => {
    if (dtcHints && dtcHints.length > 0) {
      stageDtcCodes(dtcHints);
    }
    switchTab("diag");
    if (promptText.trim()) {
      void askExpertHandler(promptText);
    }
  });
};

const openGlobalAr = (startMode: "optical" | "vr" = "optical") => {
  createArHudOverlay({
    startMode,
    onOpen3d: openGlobal3d,
    onClose: () => {},
  });
};

// 3. Экраны приложения внутри безопасных отступов
const wrapTabScreen = (screenId: string, content: any) =>
  UIScreen(content)
    .named(screenId)
    .style({
      backgroundColor: () => THEME.bgBase,
      paddingTop: "safe-top",
    });

const diagScreen = wrapTabScreen(
  "diag",
  createDiagnosticsScreen({
    onOpenAr: () => openGlobalAr("optical"),
    onOpen3d: openGlobal3d,
    onOpenSettings: () => switchTab("settings"),
    onOpenObd: () => switchTab("obd"),
    onOpenDtc: () => switchTab("dtc"),
    onOpenSessions: () => switchTab("sessions"),
  })
);

const dtcScreen = wrapTabScreen(
  "dtc",
  createDtcDictionaryScreen({
    onSelectCode: () => switchTab("diag"),
    onOpenAr: () => openGlobalAr("optical"),
    onOpen3d: openGlobal3d,
    onOpenSettings: () => switchTab("settings"),
  })
);

const obdScreen = wrapTabScreen(
  "obd",
  createObdScannerScreen({
    onOpenAr: () => openGlobalAr("optical"),
    onOpen3d: openGlobal3d,
    onOpenSettings: () => switchTab("settings"),
    onAttachToAi: () => switchTab("diag"),
  })
);

const sessionsScreen = wrapTabScreen(
  "sessions",
  createSessionsHistoryScreen({
    onOpenSession: () => switchTab("diag"),
    onOpenAr: () => openGlobalAr("optical"),
    onOpen3d: openGlobal3d,
    onOpenSettings: () => switchTab("settings"),
  })
);

const settingsScreen = wrapTabScreen(
  "settings",
  createSettingsScreen({
    onOpenAr: () => openGlobalAr("optical"),
    onOpen3d: openGlobal3d,
  })
);

// 4. Нижняя панель навигации
tabs = UITabs({
  diag: {
    label: "Диагноз",
    icon: assetIcon("lucide:bot"),
    screen: diagScreen,
  },
  dtc: {
    label: "Чеклист",
    icon: assetIcon("lucide:check-check"),
    screen: dtcScreen,
  },
  obd: {
    label: "OBD-2",
    icon: assetIcon("lucide:gauge"),
    screen: obdScreen,
  },
  sessions: {
    label: "Сессии",
    icon: assetIcon("lucide:folder-clock"),
    screen: sessionsScreen,
  },
  settings: {
    label: "Настройки",
    icon: assetIcon("lucide:settings"),
    screen: settingsScreen,
  },
});

effect(() => {
  const idx = appState.activeTabSignal.value;
  const target = TAB_KEYS[idx];
  if (target && tabs && typeof tabs.select === "function" && tabs.tab !== target) {
    tabs.select(target);
  }
});

effect(() => {
  const _mode = currentThemeSignal.value;
  void _mode;
  try {
    tabs.bar.theme({
      accent: THEME.accentOrange,
      textMuted: THEME.textMuted,
      surface: THEME.bgSurface,
      border: THEME.borderDefault,
    });
  } catch {}
});

Router.init(tabs);

try {
  tabs.onBack(() => {
    if (tabs.tab !== "diag") {
      switchTab("diag");
    }
  });
} catch {}

// 5. Предупреждение о локальном хранении данных и бэкапах при первом запуске
openDataLossWarningModal(false);
