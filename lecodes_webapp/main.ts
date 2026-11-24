/**
 * Главная точка входа Android-приложения и нативного клиента ИИдеал-Авто на базе le.codes.
 *
 * Полное соответствие возможностям и стилю оригинального мобильного сайта:
 * 1. Нижняя навигация Mobile-First:
 *    - «Диагноз» (Чат, мультимодальный ввод, вложения, камера, микрофон)
 *    - «Чеклист» (Инспектор задач ремонта и справочник кодов DTC)
 *    - «OBD-2» (Приборная панель, живые датчики, чтение и сброс DTC)
 *    - «Сессии» (Проекты, диалоги, теги, выжимка контекста воркера)
 *    - «Настройки» (Инженерное меню стенда, базовый URL, сквозная память)
 * 2. Мини-HUD бар телеметрии над экранами
 * 3. Поддержка AR HUD для смарт-очков RayNeo / внешних дисплеев
 * 4. Лицензия: GPL-3.0
 */

import "./src/utils/polyfills";
import { apiClient } from "./src/api/BackendApiClient";
import { cacheManager } from "./src/cache/ResourceCacheManager";
import { obdProtocol } from "./src/obd/ELM327Protocol";
import { AuthUser } from "./src/types";
import { createDiagnosticsScreen } from "./src/ui/DiagnosticsScreen";
import { createDtcDictionaryScreen } from "./src/ui/DtcDictionaryScreen";
import { createObdScannerScreen } from "./src/ui/ObdScannerScreen";
import { createSessionsHistoryScreen } from "./src/ui/SessionsHistoryScreen";
import { createSettingsScreen } from "./src/ui/SettingsScreen";
import { PrimaryButton, SecondaryButton, THEME } from "./src/ui/components";

// 1. Конфигурация темы приложения le.codes под стилистику сайта
theme({
  bg: THEME.bgBase,
  surface: THEME.bgSurface,
  accent: THEME.accentOrange,
  text: THEME.textPrimary,
  textMuted: THEME.textMuted,
  border: THEME.borderSubtle,
  colorScheme: "dark"
});

// 2. Реактивное состояние оболочки
const DEFAULT_URL = "http://10.0.2.2:8000";
const serverUrl = signal<string>(apiClient.getBaseUrl() || DEFAULT_URL).stored("pwa_server_url");

if (serverUrl.value) {
  apiClient.setBaseUrl(serverUrl.value);
}

// Учетная запись мастера
const currentUserSignal = signal<AuthUser>({
  username: "",
  is_authenticated: false
});

// Проверка сессии при старте
apiClient.getAuthStatus().then(res => {
  if (res && res.is_authenticated) {
    currentUserSignal.value = {
      username: res.username || "",
      is_staff: res.is_staff,
      is_authenticated: true
    };
  }
}).catch(() => {});

// Телеметрия для мини-HUD бара
const obdState = signal({
  rpm: 0,
  speed: 0,
  coolantTemp: 0,
  batteryVoltage: 12.6,
  status: "ELM327 готов"
});

obdProtocol.onSensorsUpdate = (s) => {
  obdState.value = {
    rpm: s.rpm,
    speed: s.speed,
    coolantTemp: s.coolantTemp,
    batteryVoltage: s.voltage,
    status: obdProtocol.getStatusMessage()
  };
};

// 3. Выдвижной мини-HUD бар над экранами
const obdMiniHud = UIColumn(
  UIRow(
    UIColumn(
      UIText("RPM").style({ fontSize: 9, color: THEME.textMuted, fontWeight: "bold" }),
      UIText(() => `${obdState.value.rpm}`).style({ fontSize: 15, fontWeight: "bold", color: THEME.accentCyan })
    ).style({ flex: 1, alignItems: "center" }),

    UIColumn(
      UIText("Скорость").style({ fontSize: 9, color: THEME.textMuted, fontWeight: "bold" }),
      UIText(() => `${obdState.value.speed}`).style({ fontSize: 15, fontWeight: "bold", color: THEME.statusOk })
    ).style({ flex: 1, alignItems: "center" }),

    UIColumn(
      UIText("ОЖ").style({ fontSize: 9, color: THEME.textMuted, fontWeight: "bold" }),
      UIText(() => `${obdState.value.coolantTemp}°`).style({ fontSize: 15, fontWeight: "bold", color: THEME.statusWarn })
    ).style({ flex: 1, alignItems: "center" }),

    UIColumn(
      UIText("АКБ").style({ fontSize: 9, color: THEME.textMuted, fontWeight: "bold" }),
      UIText(() => `${obdState.value.batteryVoltage.toFixed(1)}V`).style({ fontSize: 15, fontWeight: "bold", color: "#a855f7" })
    ).style({ flex: 1, alignItems: "center" }),

    UIButton(
      UIText(() => (obdProtocol.getStatus() === "connected" && obdProtocol.getTransportType() === "demo" ? "Стоп" : "Демо")).style({
        fontSize: 10,
        color: "#ffffff",
        fontWeight: "bold"
      })
    )
      .style({
        backgroundColor: THEME.accentOrange,
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
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 4,
    backgroundColor: "rgba(9, 13, 22, 0.98)",
    borderBottomWidth: 1,
    borderColor: THEME.borderSubtle,
    width: "100%"
  })
);

// 4. Экземпляр вкладок приложения
let tabsInstance: any = null;

const diagnosticsScreen = createDiagnosticsScreen({
  onToggleSidebar: () => {
    tabsInstance?.select("sessions");
  },
  onNavigateToDtc: (code) => {
    tabsInstance?.select("inspector");
  },
  onNavigateToObd: () => {
    tabsInstance?.select("obd");
  },
  onOpenEngineeringMenu: () => {
    tabsInstance?.select("settings");
  },
  onEnterAr: () => {
    tabsInstance?.select("obd");
  }
});

const inspectorScreen = createDtcDictionaryScreen((code) => {
  tabsInstance?.select("diagnostics");
});

const obdScreen = createObdScannerScreen({
  onSendDtcToAi: (codes) => {
    tabsInstance?.select("diagnostics");
  },
  onOpenEngineeringMenu: () => {
    tabsInstance?.select("settings");
  }
});

const sessionsScreen = createSessionsHistoryScreen({
  onSelectSession: (session) => {
    tabsInstance?.select("diagnostics");
  }
});

const settingsScreen = createSettingsScreen();

// 5. Сборка UITabs (Mobile-First 5 вкладок как в мобильной версии сайта)
tabsInstance = UITabs({
  diagnostics: {
    label: "Диагноз",
    icon: assetIcon("lucide:bot"),
    screen: diagnosticsScreen
  },
  inspector: {
    label: "Чеклист",
    icon: assetIcon("lucide:check-check"),
    screen: inspectorScreen
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

// Настройка стилей таб-бара с безопасным отступом для навигационного бара Android
tabsInstance.bar.style({
  backgroundColor: "rgba(17, 24, 39, 0.98)",
  borderTopWidth: 1,
  borderColor: THEME.borderSubtle,
  paddingBottom: 22,
  paddingTop: 6,
  minHeight: 68
});

// 6. Монтирование в глобальный роутер le.codes
Router.init(tabsInstance);

console.log("ИИдеал-Авто (le.codes Native Client) успешно запущен. API:", serverUrl.value);
