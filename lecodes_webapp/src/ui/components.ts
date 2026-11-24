/**
 * Переиспользуемая библиотека компонентов UI ИИдеал-Авто (le.codes Native).
 * 100% реактивная тёмная и светлая темы, векторные иконки Lucide (без эмоджи),
 * интерактивные карточки диагностики, чеклисты, медиа-модалки и двухрежимный AR / VR HUD.
 *
 * Лицензия: GPL-3.0
 */

import { apiClient } from "../api/BackendApiClient";
import { cacheManager } from "../cache/ResourceCacheManager";
import { appState, createWelcomeMessage } from "../state/appState";
import {
  ChatMessageItem,
  DiagnosticSessionItem,
  ParsedDocInfo,
  StagedItem
} from "../types";

// Глобальное реактивное состояние темы (dark / light) с сохранением в локальном кеше
export const currentThemeSignal = signal<"dark" | "light">(
  cacheManager.getSetting<"dark" | "light">("theme_mode", "dark")
);

export function isDark(): boolean {
  return currentThemeSignal.value === "dark";
}

export function toggleTheme(): void {
  const next = currentThemeSignal.value === "dark" ? "light" : "dark";
  currentThemeSignal.value = next;
  cacheManager.saveSetting("theme_mode", next);
}

// Фирменные цвета темы: геттеры читают currentThemeSignal внутри реактивных функций () => THEME.*
export const THEME = {
  get bgBase() {
    return currentThemeSignal.value === "light" ? "#f1f5f9" : "#090d16";
  },
  get bgSurface() {
    return currentThemeSignal.value === "light" ? "#ffffff" : "#111827";
  },
  get bgElevated() {
    return currentThemeSignal.value === "light" ? "#f8fafc" : "#1e293b";
  },
  get bgCard() {
    return currentThemeSignal.value === "light" ? "#ffffff" : "#131c31";
  },
  get bgInput() {
    return currentThemeSignal.value === "light" ? "#f8fafc" : "#0b1120";
  },
  get borderDefault() {
    return currentThemeSignal.value === "light"
      ? "#cbd5e1"
      : "rgba(148, 163, 184, 0.20)";
  },
  get borderStrong() {
    return currentThemeSignal.value === "light"
      ? "rgba(15, 23, 42, 0.28)"
      : "rgba(148, 163, 184, 0.36)";
  },
  get textPrimary() {
    return currentThemeSignal.value === "light" ? "#0f172a" : "#f8fafc";
  },
  get textSecondary() {
    return currentThemeSignal.value === "light" ? "#334155" : "#cbd5e1";
  },
  get textMuted() {
    return currentThemeSignal.value === "light" ? "#475569" : "#94a3b8";
  },
  get inputPlaceholder() {
    return currentThemeSignal.value === "light" ? "#64748b" : "#94a3b8";
  },
  get accentOrange() {
    return "#f97316";
  },
  get accentOrangeLight() {
    return currentThemeSignal.value === "light" ? "#c2410c" : "#fb923c";
  },
  get accentCyan() {
    return currentThemeSignal.value === "light" ? "#0284c7" : "#38bdf8";
  },
  get accentViolet() {
    return currentThemeSignal.value === "light" ? "#7c3aed" : "#a78bfa";
  },
  get statusOk() {
    return currentThemeSignal.value === "light" ? "#059669" : "#10b981";
  },
  get statusWarn() {
    return currentThemeSignal.value === "light" ? "#d97706" : "#f59e0b";
  },
  get statusCrit() {
    return currentThemeSignal.value === "light" ? "#dc2626" : "#ef4444";
  },
  get bubbleUserBg() {
    return currentThemeSignal.value === "light" ? "#eff6ff" : "#111c33";
  },
  get bubbleUserBorder() {
    return currentThemeSignal.value === "light"
      ? "rgba(2, 132, 199, 0.35)"
      : "rgba(56, 189, 248, 0.35)";
  },
  get bubbleAiBg() {
    return currentThemeSignal.value === "light" ? "#ffffff" : "#131b2e";
  }
};

/**
 * Рендерит векторную иконку Lucide (только статические литералы assetIcon для компилятора).
 */
export function LucideIcon(
  name: string,
  size: number = 18,
  color: any = () => THEME.textPrimary
): any {
  let iconAsset: any;
  switch (name) {
    case "lucide:camera":
      iconAsset = assetIcon("lucide:camera");
      break;
    case "lucide:mic":
      iconAsset = assetIcon("lucide:mic");
      break;
    case "lucide:paperclip":
      iconAsset = assetIcon("lucide:paperclip");
      break;
    case "lucide:book-open":
      iconAsset = assetIcon("lucide:book-open");
      break;
    case "lucide:gauge":
      iconAsset = assetIcon("lucide:gauge");
      break;
    case "lucide:sliders-horizontal":
      iconAsset = assetIcon("lucide:sliders-horizontal");
      break;
    case "lucide:send":
      iconAsset = assetIcon("lucide:send");
      break;
    case "lucide:user":
      iconAsset = assetIcon("lucide:user");
      break;
    case "lucide:settings":
      iconAsset = assetIcon("lucide:settings");
      break;
    case "lucide:glasses":
      iconAsset = assetIcon("lucide:glasses");
      break;
    case "lucide:circle-alert":
      iconAsset = assetIcon("lucide:circle-alert");
      break;
    case "lucide:bot":
      iconAsset = assetIcon("lucide:bot");
      break;
    case "lucide:check-check":
      iconAsset = assetIcon("lucide:check-check");
      break;
    case "lucide:folder-clock":
      iconAsset = assetIcon("lucide:folder-clock");
      break;
    case "lucide:car":
      iconAsset = assetIcon("lucide:car");
      break;
    case "lucide:trash-2":
      iconAsset = assetIcon("lucide:trash-2");
      break;
    case "lucide:plus":
      iconAsset = assetIcon("lucide:plus");
      break;
    case "lucide:refresh-cw":
      iconAsset = assetIcon("lucide:refresh-cw");
      break;
    case "lucide:arrow-right":
      iconAsset = assetIcon("lucide:arrow-right");
      break;
    case "lucide:lock":
      iconAsset = assetIcon("lucide:lock");
      break;
    case "lucide:sun":
      iconAsset = assetIcon("lucide:sun");
      break;
    case "lucide:moon":
      iconAsset = assetIcon("lucide:moon");
      break;
    case "lucide:x":
      iconAsset = assetIcon("lucide:x");
      break;
    case "lucide:activity":
      iconAsset = assetIcon("lucide:activity");
      break;
    case "lucide:check":
      iconAsset = assetIcon("lucide:check");
      break;
    case "lucide:copy":
      iconAsset = assetIcon("lucide:copy");
      break;
    case "lucide:file-text":
      iconAsset = assetIcon("lucide:file-text");
      break;
    case "lucide:pin":
      iconAsset = assetIcon("lucide:pin");
      break;
    case "lucide:tag":
      iconAsset = assetIcon("lucide:tag");
      break;
    case "lucide:pencil":
      iconAsset = assetIcon("lucide:pencil");
      break;
    case "lucide:folder-plus":
      iconAsset = assetIcon("lucide:folder-plus");
      break;
    case "lucide:message-square-plus":
      iconAsset = assetIcon("lucide:message-square-plus");
      break;
    case "lucide:search":
      iconAsset = assetIcon("lucide:search");
      break;
    case "lucide:volume-2":
      iconAsset = assetIcon("lucide:volume-2");
      break;
    case "lucide:square":
      iconAsset = assetIcon("lucide:square");
      break;
    case "lucide:play":
      iconAsset = assetIcon("lucide:play");
      break;
    case "lucide:pause":
      iconAsset = assetIcon("lucide:pause");
      break;
    case "lucide:eye":
      iconAsset = assetIcon("lucide:eye");
      break;
    case "lucide:cpu":
      iconAsset = assetIcon("lucide:cpu");
      break;
    case "lucide:wrench":
      iconAsset = assetIcon("lucide:wrench");
      break;
    case "lucide:shield-alert":
      iconAsset = assetIcon("lucide:shield-alert");
      break;
    case "lucide:sparkles":
      iconAsset = assetIcon("lucide:sparkles");
      break;
    case "lucide:switch-camera":
      iconAsset = assetIcon("lucide:switch-camera");
      break;
    case "lucide:maximize-2":
      iconAsset = assetIcon("lucide:maximize-2");
      break;
    case "lucide:minimize-2":
      iconAsset = assetIcon("lucide:minimize-2");
      break;
    case "lucide:menu":
      iconAsset = assetIcon("lucide:menu");
      break;
    case "lucide:log-out":
      iconAsset = assetIcon("lucide:log-out");
      break;
    case "lucide:chevron-right":
      iconAsset = assetIcon("lucide:chevron-right");
      break;
    case "lucide:chevron-left":
      iconAsset = assetIcon("lucide:chevron-left");
      break;
    case "lucide:wifi":
      iconAsset = assetIcon("lucide:wifi");
      break;
    case "lucide:wifi-off":
      iconAsset = assetIcon("lucide:wifi-off");
      break;
    case "lucide:shield-check":
      iconAsset = assetIcon("lucide:shield-check");
      break;
    case "lucide:bluetooth":
      iconAsset = assetIcon("lucide:bluetooth");
      break;
    case "lucide:zap":
      iconAsset = assetIcon("lucide:zap");
      break;
    case "lucide:rotate-ccw":
      iconAsset = assetIcon("lucide:rotate-ccw");
      break;
    case "lucide:image":
      iconAsset = assetIcon("lucide:image");
      break;
    default:
      iconAsset = assetIcon("lucide:circle-alert");
      break;
  }

  return UIImage(iconAsset).style({
    width: size,
    height: size,
    objectFit: "contain",
    tintColor: color
  });
}

// =========================================================================
// БАЗОВЫЕ КНОПКИ И БЕЙДЖИ
// =========================================================================

export function PrimaryButton(
  label: string | (() => string),
  onClick: () => void,
  disabledSignal?: any
): any {
  const isDis = () => Boolean(disabledSignal?.value);
  return UIButton(
    UIText(label).style({
      color: "#ffffff",
      fontSize: 13,
      fontWeight: "bold",
      textAlign: "center"
    })
  )
    .style({
      backgroundColor: () => (isDis() ? "#64748b" : THEME.accentOrange),
      paddingHorizontal: 15,
      paddingVertical: 10,
      borderRadius: 11,
      alignItems: "center",
      justifyContent: "center",
      opacity: () => (isDis() ? 0.65 : 1)
    })
    .onClick(() => {
      if (!isDis()) onClick();
    });
}

export function SecondaryButton(
  label: string | (() => string),
  onClick: () => void,
  iconName?: string
): any {
  const children: any[] = [];
  if (iconName) {
    children.push(LucideIcon(iconName, 14, () => THEME.textSecondary));
  }
  children.push(
    UIText(label).style({
      color: () => THEME.textSecondary,
      fontSize: 12,
      fontWeight: "600",
      textAlign: "center"
    })
  );

  return UIButton(
    UIRow(...children).style({
      alignItems: "center",
      justifyContent: "center",
      gap: 6
    })
  )
    .style({
      backgroundColor: () => THEME.bgElevated,
      borderWidth: 1,
      borderColor: () => THEME.borderStrong,
      paddingHorizontal: 12,
      paddingVertical: 9,
      borderRadius: 10,
      alignItems: "center",
      justifyContent: "center"
    })
    .onClick(onClick);
}

export function StatusBadge(status: any, label: any): any {
  const getSt = () => (typeof status === "function" ? status() : status);
  const getColor = () => {
    const s = getSt();
    if (s === "ok" || s === "connected" || s === "completed") return THEME.statusOk;
    if (s === "warn" || s === "connecting" || s === "running") return THEME.statusWarn;
    if (s === "crit" || s === "error") return THEME.statusCrit;
    return THEME.textMuted;
  };
  const getBg = () => {
    const s = getSt();
    if (s === "ok" || s === "connected" || s === "completed") return "rgba(16, 185, 129, 0.14)";
    if (s === "warn" || s === "connecting" || s === "running") return "rgba(245, 158, 11, 0.14)";
    if (s === "crit" || s === "error") return "rgba(239, 68, 68, 0.14)";
    return "rgba(148, 163, 184, 0.14)";
  };

  return UIRow(
    UIBox().style({
      width: 7,
      height: 7,
      borderRadius: 4,
      backgroundColor: getColor,
      marginRight: 6
    }),
    UIText(label).style({
      color: getColor,
      fontSize: 11,
      fontWeight: "bold"
    })
  ).style({
    backgroundColor: getBg,
    borderWidth: 1,
    borderColor: () => THEME.borderDefault,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    alignItems: "center"
  });
}

export function HeaderBar(
  title: string | (() => string),
  subtitle?: string | (() => string),
  rightNode?: any
): any {
  const col = UIColumn(
    UIText(title).style({
      color: () => THEME.textPrimary,
      fontSize: 17,
      fontWeight: "bold"
    })
  ).style({ flex: 1, gap: 2 });

  if (subtitle) {
    col.append(
      UIText(subtitle).style({
        color: () => THEME.textMuted,
        fontSize: 11
      })
    );
  }

  return UIRow(col, ...(rightNode ? [rightNode] : [])).style({
    width: "100%",
    paddingHorizontal: 14,
    paddingVertical: 11,
    backgroundColor: () => THEME.bgSurface,
    borderBottomWidth: 1,
    borderBottomColor: () => THEME.borderDefault,
    alignItems: "center",
    gap: 8
  });
}

export function DtcChip(code: string, onClick?: () => void): any {
  const upper = (code || "").toUpperCase();
  const getTint = () => {
    if (upper.startsWith("P")) return THEME.statusCrit;
    if (upper.startsWith("U")) return THEME.accentCyan;
    if (upper.startsWith("C")) return THEME.statusWarn;
    return THEME.accentViolet;
  };
  return UIButton(
    UIText(upper).style({
      color: getTint,
      fontSize: 11,
      fontWeight: "bold"
    })
  )
    .style({
      backgroundColor: () => THEME.bgElevated,
      borderWidth: 1,
      borderColor: getTint,
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 4
    })
    .onClick(() => {
      if (onClick) onClick();
    });
}

export function MetricCard(
  title: string,
  valueFn: () => string,
  unit: string,
  accentColor: any = () => THEME.accentCyan,
  iconName: string = "lucide:activity"
): any {
  return UIColumn(
    UIRow(
      LucideIcon(iconName, 14, accentColor),
      UIText(title).style({
        color: () => THEME.textMuted,
        fontSize: 10,
        fontWeight: "bold",
        flex: 1
      })
    ).style({ alignItems: "center", gap: 5, width: "100%", marginBottom: 4 }),
    UIRow(
      UIText(valueFn).style({
        color: () => THEME.textPrimary,
        fontSize: 20,
        fontWeight: "bold"
      }),
      UIText(unit ? ` ${unit}` : "").style({
        color: () => THEME.textMuted,
        fontSize: 11,
        marginBottom: 2
      })
    ).style({ alignItems: "flex-end", width: "100%" })
  ).style({
    backgroundColor: () => THEME.bgSurface,
    borderWidth: 1,
    borderColor: () => THEME.borderDefault,
    borderRadius: 14,
    paddingHorizontal: 13,
    paddingVertical: 11,
    flex: 1
  });
}

// =========================================================================
// ШАПКА ПРИЛОЖЕНИЯ (1-в-1 С МОБИЛЬНОЙ ВЕРСИЕЙ САЙТА + БЕЗ ОБРЕЗАНИЯ ИМЕНИ)
// =========================================================================

export interface AppHeaderOptions {
  title?: string;
  subtitle?: string | (() => string);
  onOpenAr?: () => void;
  onOpenDrawer?: () => void;
  onOpenSettings?: () => void;
  onResetChat?: () => void;
}

export function AppHeader(options: AppHeaderOptions): any {
  const brandTitle = options.title || "ИИДЕАЛ АВТО";

  const statusText = () => {
    if (appState.workerStatusSignal.value === "running") {
      return "Воркер памяти...";
    }
    const u = appState.currentUserSignal.value;
    if (u && u.is_authenticated && u.username) {
      return u.username;
    }
    return "Гость / Демо";
  };

  const statusDotColor = () => {
    if (appState.workerStatusSignal.value === "running") return THEME.statusWarn;
    return appState.currentUserSignal.value?.is_authenticated
      ? THEME.statusOk
      : THEME.accentCyan;
  };

  const brandBlock = UIRow(
    UIImage(asset("../../assets/icon.png")).style({
      width: 30,
      height: 30,
      borderRadius: 7,
      objectFit: "cover",
      flexShrink: 0
    }),
    UIColumn(
      UIText(brandTitle).style({
        color: () => THEME.textPrimary,
        fontSize: 14,
        fontWeight: "bold",
        numberOfLines: 1
      }),
      UIRow(
        UIBox().style({
          width: 6,
          height: 6,
          borderRadius: 3,
          backgroundColor: statusDotColor,
          marginRight: 5
        }),
        UIText(statusText).style({
          color: () => THEME.textMuted,
          fontSize: 10,
          numberOfLines: 1
        })
      ).style({ alignItems: "center" })
    ).style({ flex: 1, flexShrink: 1, gap: 1 })
  ).style({
    flex: 1,
    flexShrink: 1,
    alignItems: "center",
    gap: 8
  });

  const actionControls: any[] = [];

  if (options.onResetChat) {
    actionControls.push(
      UIButton(LucideIcon("lucide:message-square-plus", 17, () => THEME.textSecondary))
        .style({
          width: 34,
          height: 34,
          borderRadius: 9,
          backgroundColor: () => THEME.bgElevated,
          borderWidth: 1,
          borderColor: () => THEME.borderDefault,
          alignItems: "center",
          justifyContent: "center"
        })
        .onClick(options.onResetChat)
    );
  }

  // Крупная заметная кнопка AR HUD (в точности по запросу пользователя)
  if (options.onOpenAr) {
    actionControls.push(
      UIButton(
        UIRow(
          LucideIcon("lucide:glasses", 17, "#ffffff"),
          UIText("AR").style({
            color: "#ffffff",
            fontSize: 12,
            fontWeight: "bold"
          })
        ).style({ alignItems: "center", gap: 5 })
      )
        .style({
          backgroundColor: () => THEME.accentOrange,
          paddingHorizontal: 11,
          height: 34,
          borderRadius: 9,
          alignItems: "center",
          justifyContent: "center"
        })
        .onClick(options.onOpenAr)
    );
  }

  // Переключатель Светлой / Тёмной темы
  actionControls.push(
    UIButton(
      LucideIcon(
        "lucide:sun",
        17,
        () => (currentThemeSignal.value === "light" ? THEME.accentOrange : THEME.statusWarn)
      )
    )
      .style({
        width: 34,
        height: 34,
        borderRadius: 9,
        backgroundColor: () => THEME.bgElevated,
        borderWidth: 1,
        borderColor: () => THEME.borderDefault,
        alignItems: "center",
        justifyContent: "center",
        display: () => (currentThemeSignal.value === "dark" ? "flex" : "none")
      })
      .onClick(toggleTheme),
    UIButton(LucideIcon("lucide:moon", 17, () => THEME.accentCyan))
      .style({
        width: 34,
        height: 34,
        borderRadius: 9,
        backgroundColor: () => THEME.bgElevated,
        borderWidth: 1,
        borderColor: () => THEME.borderDefault,
        alignItems: "center",
        justifyContent: "center",
        display: () => (currentThemeSignal.value === "light" ? "flex" : "none")
      })
      .onClick(toggleTheme)
  );

  if (options.onOpenSettings) {
    actionControls.push(
      UIButton(LucideIcon("lucide:settings", 17, () => THEME.textSecondary))
        .style({
          width: 34,
          height: 34,
          borderRadius: 9,
          backgroundColor: () => THEME.bgElevated,
          borderWidth: 1,
          borderColor: () => THEME.borderDefault,
          alignItems: "center",
          justifyContent: "center"
        })
        .onClick(options.onOpenSettings)
    );
  }

  const topBarRow = UIRow(
    brandBlock,
    UIRow(...actionControls).style({
      alignItems: "center",
      gap: 6,
      flexShrink: 0
    })
  ).style({
    width: "100%",
    paddingHorizontal: 12,
    paddingVertical: 9,
    backgroundColor: () => THEME.bgSurface,
    borderBottomWidth: 1,
    borderBottomColor: () => THEME.borderDefault,
    alignItems: "center",
    gap: 8
  });

  return UIColumn(topBarRow, OfflineBanner()).style({
    width: "100%",
    backgroundColor: () => THEME.bgBase
  });
}

const isCheckingConnSignal = signal(false);

/**
 * Баннер о недоступности приложения и ИИ-функций при отсутствии интернета или связи с сервером
 */
export function OfflineBanner(): any {
  return UIRow(
    UIBox(LucideIcon("lucide:wifi-off", 17, () => THEME.statusCrit)).style({
      width: 32,
      height: 32,
      borderRadius: 9,
      backgroundColor: "rgba(239, 68, 68, 0.16)",
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0
    }),
    UIColumn(
      UIText("Нет подключения к интернету / серверу").style({
        color: () => THEME.statusCrit,
        fontSize: 12,
        fontWeight: "bold"
      }),
      UIText("ИИ-диагностика и облако недоступны без сети. Проверьте Wi-Fi или сервер.").style({
        color: () => THEME.textSecondary,
        fontSize: 10,
        lineHeight: 14
      })
    ).style({ flex: 1, gap: 2 }),
    UIButton(
      UIRow(
        LucideIcon("lucide:refresh-cw", 12, () => THEME.textPrimary),
        UIText(() => (isCheckingConnSignal.value ? "..." : "Сеть")).style({
          color: () => THEME.textPrimary,
          fontSize: 11,
          fontWeight: "bold"
        })
      ).style({ alignItems: "center", gap: 4 })
    )
      .style({
        backgroundColor: () => THEME.bgSurface,
        borderWidth: 1,
        borderColor: "rgba(239, 68, 68, 0.45)",
        borderRadius: 8,
        paddingHorizontal: 9,
        paddingVertical: 7,
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0
      })
      .onClick(async () => {
        if (isCheckingConnSignal.value) return;
        isCheckingConnSignal.value = true;
        const ok = await apiClient.checkConnectivity();
        isCheckingConnSignal.value = false;
        toast(ok ? "Подключение восстановлено" : "Сеть или сервер по-прежнему недоступны");
      })
  ).style({
    width: "100%",
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: "rgba(239, 68, 68, 0.12)",
    borderBottomWidth: 1,
    borderBottomColor: "rgba(239, 68, 68, 0.42)",
    alignItems: "center",
    gap: 9,
    display: () => (appState.isOnlineSignal.value ? "none" : "flex")
  });
}

/**
 * Модальное окно согласия при самом первом запуске приложения:
 * явная галочка на cookies/кэш, Пользовательское соглашение и Политику конфиденциальности (152-ФЗ РФ).
 */
export function openFirstLaunchConsentModal(onAccepted?: () => void): void {
  if (cacheManager.getSetting<boolean>("first_entry_legal_accepted", false)) {
    onAccepted?.();
    return;
  }

  const acceptedSignal = signal(false);
  const hintErrorSignal = signal("");
  let modal: any = null;

  modal = UIModal(
    UIColumn(
      UIRow(
        UIBox(LucideIcon("lucide:shield-check", 20, () => THEME.accentOrange)).style({
          width: 36,
          height: 36,
          borderRadius: 10,
          backgroundColor: "rgba(249, 115, 22, 0.14)",
          borderWidth: 1,
          borderColor: "rgba(249, 115, 22, 0.35)",
          alignItems: "center",
          justifyContent: "center"
        }),
        UIColumn(
          UIText("Добро пожаловать в ИИдеал Авто").style({
            color: () => THEME.textPrimary,
            fontSize: 15,
            fontWeight: "bold"
          }),
          UIText("Согласие с правилами сервиса (152-ФЗ РФ)").style({
            color: () => THEME.textMuted,
            fontSize: 11
          })
        ).style({ flex: 1, gap: 2 })
      ).style({ alignItems: "center", gap: 10, width: "100%", marginBottom: 10 }),

      UIText("Приложение (com.mmcco.aidealauto) использует файлы cookies и локальное хранилище для сохранения диагностических сессий, оффлайн-справочника DTC и настроек, а также задействует камеру, микрофон и OBD-II по вашему запросу.").style({
        color: () => THEME.textSecondary,
        fontSize: 12,
        lineHeight: 17,
        marginBottom: 10
      }),

      UIRow(
        UIButton(
          UIBox(
            LucideIcon("lucide:check", 12, "#ffffff").style({
              display: () => (acceptedSignal.value ? "flex" : "none")
            })
          ).style({
            width: 20,
            height: 20,
            borderRadius: 6,
            borderWidth: 1.5,
            borderColor: () => (acceptedSignal.value ? THEME.statusOk : THEME.borderStrong),
            backgroundColor: () => (acceptedSignal.value ? THEME.statusOk : "transparent"),
            alignItems: "center",
            justifyContent: "center"
          })
        )
          .style({ padding: 2 })
          .onClick(() => {
            acceptedSignal.value = !acceptedSignal.value;
            if (acceptedSignal.value) hintErrorSignal.value = "";
          }),
        UIText("Я принимаю cookies и локальное хранилище, Пользовательское соглашение и Политику конфиденциальности").style({
          color: () => THEME.textPrimary,
          fontSize: 12,
          lineHeight: 17,
          flex: 1
        })
      ).style({ alignItems: "flex-start", gap: 9, width: "100%", marginBottom: 8 }),

      UIRow(
        UIButton(
          UIText("Пользовательское соглашение").style({
            color: () => THEME.accentCyan,
            fontSize: 11,
            textDecorationLine: "underline"
          })
        ).onClick(() => {
          openURL(`${apiClient.getBaseUrl()}/terms/`).catch(() => {});
        }),
        UIText("•").style({ color: () => THEME.textMuted, fontSize: 11 }),
        UIButton(
          UIText("Политика (152-ФЗ)").style({
            color: () => THEME.accentCyan,
            fontSize: 11,
            textDecorationLine: "underline"
          })
        ).onClick(() => {
          openURL(`${apiClient.getBaseUrl()}/privacy/`).catch(() => {});
        })
      ).style({ alignItems: "center", gap: 6, paddingLeft: 30, marginBottom: 10 }),

      UIRow(
        LucideIcon("lucide:circle-alert", 14, () => THEME.statusCrit),
        UIText(() => hintErrorSignal.value).style({
          color: () => THEME.statusCrit,
          fontSize: 11,
          flex: 1
        })
      ).style({
        backgroundColor: "rgba(239, 68, 68, 0.14)",
        borderWidth: 1,
        borderColor: "rgba(239, 68, 68, 0.35)",
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 7,
        marginBottom: 10,
        alignItems: "center",
        gap: 6,
        width: "100%",
        display: () => (hintErrorSignal.value ? "flex" : "none")
      }),

      PrimaryButton("Принять и продолжить", () => {
        if (!acceptedSignal.value) {
          hintErrorSignal.value = "Отметьте галочку согласия для начала работы";
          return;
        }
        cacheManager.saveSetting("first_entry_legal_accepted", true);
        modal.hide();
        onAccepted?.();
      }).style({ width: "100%" })
    ).style({
      backgroundColor: () => THEME.bgSurface,
      borderRadius: 18,
      padding: 18,
      borderWidth: 1,
      borderColor: () => THEME.borderStrong,
      width: "92%"
    })
  )
    .dismissible(false)
    .transition({
      opacity: 0,
      transform: "scale(0.95)",
      duration: 210
    });

  modal.show();
}

// =========================================================================
// МОДАЛЬНЫЕ ОКНА ОБЩЕГО НАЗНАЧЕНИЯ (LIGHTBOX, ДОКУМЕНТ, ВВОД, ПОДТВЕРЖДЕНИЕ)
// =========================================================================

export function openImageLightboxModal(src: any, title: string = "Снимок узла"): void {
  let modal: any = null;
  modal = UIModal(
    UIColumn(
      UIRow(
        LucideIcon("lucide:image", 16, () => THEME.accentCyan),
        UIText(title).style({
          color: "#f8fafc",
          fontSize: 13,
          fontWeight: "bold",
          flex: 1
        }),
        UIButton(LucideIcon("lucide:x", 18, "#f8fafc"))
          .style({
            width: 32,
            height: 32,
            borderRadius: 16,
            backgroundColor: "rgba(255,255,255,0.14)",
            alignItems: "center",
            justifyContent: "center"
          })
          .onClick(() => modal.hide())
      ).style({ alignItems: "center", gap: 8, width: "100%", marginBottom: 10 }),
      UIImage(src).style({
        width: "100%",
        height: 380,
        borderRadius: 12,
        objectFit: "contain",
        backgroundColor: "#020617"
      })
    ).style({
      backgroundColor: "#0f172a",
      borderRadius: 18,
      padding: 16,
      borderWidth: 1,
      borderColor: "rgba(148,163,184,0.3)",
      width: "92%"
    })
  )
    .transition({ opacity: 0, transform: "scale(0.95)", duration: 200 })
    .onClose(() => {
      // Освобождаем нативную модалку при закрытии
    });
  modal.show();
}

export function openDocumentPreviewModal(
  doc: ParsedDocInfo,
  onStageDtc?: (code: string) => void
): void {
  let modal: any = null;
  const codes = Array.from(
    new Set([...(doc.detected_dtc_codes || []), ...(doc.detected_codes || [])])
  );
  const metrics = doc.key_metrics || [];
  const excerpt = doc.llm_ready_text || doc.preview_excerpt || "Текстовое содержимое не извлечено.";

  modal = UIModal(
    UIColumn(
      UIRow(
        LucideIcon("lucide:file-text", 18, () => THEME.accentCyan),
        UIColumn(
          UIText(doc.filename || "Документ диагностики").style({
            color: () => THEME.textPrimary,
            fontSize: 14,
            fontWeight: "bold",
            numberOfLines: 1
          }),
          UIText(
            `Объём текста: ${doc.char_length || excerpt.length} симв. • Режим: ${
              doc.processing_mode || "LLM Parser"
            }`
          ).style({
            color: () => THEME.textMuted,
            fontSize: 10
          })
        ).style({ flex: 1, gap: 2 }),
        UIButton(LucideIcon("lucide:x", 18, () => THEME.textMuted))
          .style({ padding: 4 })
          .onClick(() => modal.hide())
      ).style({ alignItems: "center", gap: 8, width: "100%", marginBottom: 10 }),

      codes.length > 0
        ? UIColumn(
            UIText("Найденные коды DTC (нажмите для добавления):").style({
              color: () => THEME.statusWarn,
              fontSize: 11,
              fontWeight: "bold",
              marginBottom: 4
            }),
            UIRow(
              ...codes.slice(0, 12).map(code =>
                DtcChip(code, () => {
                  onStageDtc?.(code);
                  toast(`Код ${code} добавлен`);
                })
              )
            ).style({ flexWrap: "wrap", gap: 6 })
          ).style({ width: "100%", marginBottom: 10 })
        : UIBox().style({ height: 0 }),

      metrics.length > 0
        ? UIText(`Метрики: ${metrics.slice(0, 6).join(" • ")}`).style({
            color: () => THEME.statusOk,
            fontSize: 11,
            marginBottom: 8
          })
        : UIBox().style({ height: 0 }),

      UIScrollable(
        UIText(excerpt.slice(0, 4500)).style({
          color: () => THEME.textSecondary,
          fontSize: 11,
          lineHeight: 16
        })
      ).style({
        width: "100%",
        height: 260,
        backgroundColor: () => THEME.bgInput,
        borderWidth: 1,
        borderColor: () => THEME.borderDefault,
        borderRadius: 11,
        padding: 10,
        marginBottom: 12
      }),

      PrimaryButton("Закрыть", () => modal.hide())
    ).style({
      backgroundColor: () => THEME.bgSurface,
      borderRadius: 18,
      padding: 18,
      borderWidth: 1,
      borderColor: () => THEME.borderStrong,
      width: "92%"
    })
  ).transition({ opacity: 0, transform: "scale(0.95)", duration: 200 });
  modal.show();
}

export function openTextPromptModal(options: {
  title: string;
  subtitle?: string;
  placeholder?: string;
  initialValue?: string;
  confirmLabel?: string;
  quickChips?: string[];
  onConfirm: (value: string) => void | Promise<void>;
}): void {
  const valSignal = signal(options.initialValue || "");
  let modal: any = null;

  const input = UIInput()
    .style({
      placeholder: options.placeholder || "Введите значение...",
      placeholderColor: () => THEME.inputPlaceholder,
      backgroundColor: () => THEME.bgInput,
      color: () => THEME.textPrimary,
      borderWidth: 1.5,
      borderColor: () => THEME.borderStrong,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 13,
      width: "100%",
      marginBottom: 10
    })
    .onChange((v: string) => {
      valSignal.value = v;
    });
  if (options.initialValue) {
    input.value = options.initialValue;
  }

  const chipsRow =
    options.quickChips && options.quickChips.length > 0
      ? UIRow(
          ...options.quickChips.map(chip =>
            UIButton(
              UIText(chip).style({
                color: () => THEME.accentCyan,
                fontSize: 11,
                fontWeight: "600"
              })
            )
              .style({
                backgroundColor: () => THEME.bgElevated,
                borderWidth: 1,
                borderColor: () => THEME.borderDefault,
                borderRadius: 8,
                paddingHorizontal: 9,
                paddingVertical: 5
              })
              .onClick(() => {
                valSignal.value = chip;
                input.value = chip;
              })
          )
        ).style({ flexWrap: "wrap", gap: 6, marginBottom: 12, width: "100%" })
      : UIBox().style({ height: 0 });

  modal = UIModal(
    UIColumn(
      UIRow(
        UIText(options.title).style({
          color: () => THEME.textPrimary,
          fontSize: 15,
          fontWeight: "bold",
          flex: 1
        }),
        UIButton(LucideIcon("lucide:x", 18, () => THEME.textMuted))
          .style({ padding: 4 })
          .onClick(() => modal.hide())
      ).style({ alignItems: "center", width: "100%", marginBottom: 6 }),
      ...(options.subtitle
        ? [
            UIText(options.subtitle).style({
              color: () => THEME.textMuted,
              fontSize: 11,
              marginBottom: 10
            })
          ]
        : []),
      input,
      chipsRow,
      UIRow(
        SecondaryButton("Отмена", () => modal.hide()),
        UISpacer(),
        PrimaryButton(options.confirmLabel || "Сохранить", async () => {
          const val = (input.value || valSignal.value || "").trim();
          modal.hide();
          await options.onConfirm(val);
        })
      ).style({ alignItems: "center", width: "100%" })
    ).style({
      backgroundColor: () => THEME.bgSurface,
      borderRadius: 18,
      padding: 18,
      borderWidth: 1,
      borderColor: () => THEME.borderStrong,
      width: "90%"
    })
  ).transition({ opacity: 0, transform: "scale(0.95)", duration: 200 });
  modal.show();
}

export function openConfirmModal(options: {
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void | Promise<void>;
}): void {
  let modal: any = null;
  modal = UIModal(
    UIColumn(
      UIRow(
        LucideIcon("lucide:circle-alert", 18, () => THEME.statusCrit),
        UIText(options.title).style({
          color: () => THEME.textPrimary,
          fontSize: 15,
          fontWeight: "bold",
          flex: 1
        })
      ).style({ alignItems: "center", gap: 8, width: "100%", marginBottom: 8 }),
      UIText(options.message).style({
        color: () => THEME.textSecondary,
        fontSize: 12,
        lineHeight: 17,
        marginBottom: 14
      }),
      UIRow(
        SecondaryButton("Отмена", () => modal.hide()),
        UISpacer(),
        UIButton(
          UIText(options.confirmLabel || "Подтвердить").style({
            color: "#ffffff",
            fontSize: 13,
            fontWeight: "bold"
          })
        )
          .style({
            backgroundColor: () => THEME.statusCrit,
            paddingHorizontal: 14,
            paddingVertical: 10,
            borderRadius: 10
          })
          .onClick(async () => {
            modal.hide();
            await options.onConfirm();
          })
      ).style({ alignItems: "center", width: "100%" })
    ).style({
      backgroundColor: () => THEME.bgSurface,
      borderRadius: 18,
      padding: 18,
      borderWidth: 1,
      borderColor: () => THEME.borderStrong,
      width: "88%"
    })
  ).transition({ opacity: 0, transform: "scale(0.95)", duration: 200 });
  modal.show();
}

export function openVehicleModal(vehicleSignal: any, onSaved?: (val: string) => void): void {
  openTextPromptModal({
    title: "Автомобиль для диагностики",
    subtitle: "Укажите марку, модель, год и двигатель (например: VW Tiguan 2.0 TSI 2018)",
    placeholder: "Например: Lada Vesta 1.6 16V (2021)",
    initialValue: vehicleSignal?.value || "",
    confirmLabel: "Применить",
    quickChips: [
      "Lada Vesta 1.6 16V",
      "Hyundai Solaris 1.6 G4FG",
      "VW Polo 1.6 CWVA",
      "Toyota Camry 2.5 2AR-FE"
    ],
    onConfirm: async val => {
      if (vehicleSignal) vehicleSignal.value = val;
      if (appState.currentSessionIdSignal.value && appState.currentUserSignal.value.is_authenticated) {
        await apiClient.setSessionVehicle(appState.currentSessionIdSignal.value, val).catch(() => {});
      }
      onSaved?.(val);
    }
  });
}

// =========================================================================
// ПАНЕЛЬ АВТОМОБИЛЯ И STAGING BAR ВЛОЖЕНИЙ
// =========================================================================

export function VehicleBar(vehicleSignal: any, onEdit?: () => void): any {
  const handleEdit = () => {
    if (onEdit) onEdit();
    else openVehicleModal(vehicleSignal);
  };

  return UIRow(
    LucideIcon("lucide:car", 16, () => THEME.accentOrange),
    UIText("Авто:").style({
      color: () => THEME.textMuted,
      fontSize: 12,
      fontWeight: "600"
    }),
    UIText(() => (vehicleSignal.value ? vehicleSignal.value : "Не указан")).style({
      color: () => THEME.textPrimary,
      fontSize: 12,
      fontWeight: "bold",
      flex: 1,
      numberOfLines: 1
    }),
    UIButton(
      UIRow(
        LucideIcon("lucide:pencil", 12, () => THEME.accentCyan),
        UIText("Изм.").style({
          color: () => THEME.accentCyan,
          fontSize: 11,
          fontWeight: "bold"
        })
      ).style({ alignItems: "center", gap: 4 })
    )
      .style({
        backgroundColor: () => THEME.bgElevated,
        borderWidth: 1,
        borderColor: () => THEME.borderDefault,
        paddingHorizontal: 9,
        paddingVertical: 5,
        borderRadius: 7
      })
      .onClick(handleEdit)
  ).style({
    width: "100%",
    backgroundColor: () => THEME.bgSurface,
    borderBottomWidth: 1,
    borderBottomColor: () => THEME.borderDefault,
    paddingHorizontal: 12,
    paddingVertical: 7,
    alignItems: "center",
    gap: 6
  });
}

export function StagingBar(
  stagedItemsSignal: any,
  onRemove: (id: string) => void,
  onPreviewDoc?: (item: StagedItem) => void
): any {
  const getTypeColor = (type: string) => {
    if (type === "photo") return THEME.accentCyan;
    if (type === "audio") return "#ec4899";
    if (type === "dtc") return THEME.statusWarn;
    if (type === "obd") return THEME.statusOk;
    return THEME.accentViolet;
  };

  const getTypeIcon = (type: string) => {
    if (type === "photo") return "lucide:camera";
    if (type === "audio") return "lucide:mic";
    if (type === "dtc") return "lucide:zap";
    if (type === "obd") return "lucide:gauge";
    return "lucide:file-text";
  };

  const buildChips = (): any[] => {
    const items: StagedItem[] = stagedItemsSignal.value || [];
    return items.map(item => {
      const thumbNode =
        item.type === "photo" && item.file
          ? UIImage(item.file).style({
              width: 22,
              height: 22,
              borderRadius: 5,
              objectFit: "cover"
            })
          : LucideIcon(getTypeIcon(item.type), 13, () => getTypeColor(item.type));

      const openChipPreview = () => {
        if (item.parsedDoc && onPreviewDoc) onPreviewDoc(item);
        else if (item.parsedDoc) openDocumentPreviewModal(item.parsedDoc);
        else if (item.type === "photo" && item.file) openImageLightboxModal(item.file, item.label);
      };

      return UIRow(
        UIButton(
          UIRow(
            thumbNode,
            UIColumn(
              UIText(item.label).style({
                color: () => THEME.textPrimary,
                fontSize: 11,
                fontWeight: "600",
                numberOfLines: 1,
                maxWidth: 165
              }),
              ...(item.meta
                ? [
                    UIText(item.meta).style({
                      color: () => THEME.textMuted,
                      fontSize: 9,
                      numberOfLines: 1,
                      maxWidth: 165
                    })
                  ]
                : [])
            ).style({ gap: 1 })
          ).style({ alignItems: "center", gap: 6 })
        )
          .style({ paddingVertical: 1 })
          .onClick(openChipPreview),
        UIButton(LucideIcon("lucide:x", 13, () => THEME.textMuted))
          .style({ padding: 3, marginLeft: 2 })
          .onClick(() => onRemove(item.id))
      ).style({
        backgroundColor: () => THEME.bgElevated,
        borderWidth: 1,
        borderColor: () => getTypeColor(item.type),
        borderRadius: 10,
        paddingHorizontal: 8,
        paddingVertical: 5,
        alignItems: "center",
        gap: 4
      });
    });
  };

  return UIBox(
    UIScrollable(
      UIRow(() => buildChips()).style({
        alignItems: "center",
        gap: 7,
        paddingHorizontal: 10,
        paddingVertical: 6
      })
    ).style({
      scrollDirection: "horizontal",
      showScrollbar: false,
      width: "100%",
      height: 48
    })
  ).style({
    width: "100%",
    height: 49,
    backgroundColor: () => THEME.bgSurface,
    borderTopWidth: 1,
    borderTopColor: () => THEME.borderDefault,
    display: () => ((stagedItemsSignal.value || []).length > 0 ? "flex" : "none")
  });
}

// =========================================================================
// ПАНЕЛЬ ПАКЕТНОГО ВЫДЕЛЕНИЯ СООБЩЕНИЙ
// =========================================================================

export function SelectionToolbar(
  selectedIdsSignal: any,
  onClearSelection: () => void,
  onDeleteSelected: () => void,
  onClearAllChat: () => void
): any {
  const count = () => (selectedIdsSignal.value || []).length;
  return UIRow(
    UIText(() => `Выбрано: ${count()}`).style({
      color: () => THEME.textPrimary,
      fontSize: 12,
      fontWeight: "bold"
    }),
    UISpacer(),
    UIButton(
      UIText("Снять").style({
        color: () => THEME.textSecondary,
        fontSize: 11,
        fontWeight: "600"
      })
    )
      .style({
        backgroundColor: () => THEME.bgElevated,
        paddingHorizontal: 9,
        paddingVertical: 6,
        borderRadius: 8
      })
      .onClick(onClearSelection),
    UIButton(
      UIRow(
        LucideIcon("lucide:trash-2", 13, "#ffffff"),
        UIText("Удалить").style({ color: "#ffffff", fontSize: 11, fontWeight: "bold" })
      ).style({ alignItems: "center", gap: 4 })
    )
      .style({
        backgroundColor: () => THEME.statusCrit,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 8
      })
      .onClick(onDeleteSelected),
    UIButton(
      UIText("Всё").style({
        color: () => THEME.statusCrit,
        fontSize: 11,
        fontWeight: "bold"
      })
    )
      .style({
        backgroundColor: "rgba(239, 68, 68, 0.14)",
        borderWidth: 1,
        borderColor: () => THEME.statusCrit,
        paddingHorizontal: 9,
        paddingVertical: 6,
        borderRadius: 8
      })
      .onClick(onClearAllChat)
  ).style({
    width: "100%",
    backgroundColor: () => THEME.bgSurface,
    borderBottomWidth: 1,
    borderBottomColor: () => THEME.borderStrong,
    paddingHorizontal: 12,
    paddingVertical: 8,
    alignItems: "center",
    gap: 6,
    display: () => (count() > 0 ? "flex" : "none")
  });
}

// =========================================================================
// КАРТОЧКА СООБЩЕНИЯ (ПОЛНАЯ ВЕРСИЯ: НЕИСПРАВНОСТИ, ЧЕКЛИСТ, ИНВЕНТАРЬ, ДЕЙСТВИЯ)
// =========================================================================

export interface MessageCardCallbacks {
  onToggleSelect?: (msgId: string) => void;
  isSelected?: (msgId: string) => boolean;
  onToggleTask?: (
    msgId: string,
    itemType: "step" | "inventory",
    checkId: string | number,
    done: boolean
  ) => void;
  onFollowupClick?: (promptText: string) => void;
  onDeleteMessage?: (msgId: string) => void;
  onOpenAr?: () => void;
  onStageDtc?: (code: string) => void;
}

function cleanMarkdownForNative(text: string): string {
  return (text || "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

export function MessageCard(msg: ChatMessageItem, callbacks?: MessageCardCallbacks): any {
  const isUser = msg.role === "user";
  const isWelcome = msg.id === "msg-welcome";
  const selectedSignal = signal(Boolean(msg.selected || callbacks?.isSelected?.(msg.id)));
  const tasksDoneMap = signal<Record<string, boolean>>({});
  const invDoneMap = signal<Record<string, boolean>>({});
  let audioPlayer: any = null;
  const playingAudioIdSignal = signal<string>("");

  // Инициализация состояний чекбоксов из объекта msg
  if (msg.tasks) {
    const initTasks: Record<string, boolean> = {};
    msg.tasks.forEach((t, idx) => {
      const key = String(t.step_number ?? t.id ?? idx + 1);
      initTasks[key] = Boolean(t.done);
    });
    tasksDoneMap.value = initTasks;
  }
  if (msg.inventoryItems) {
    const initInv: Record<string, boolean> = {};
    msg.inventoryItems.forEach((it, idx) => {
      const key = String(it.id || it.name || idx);
      initInv[key] = Boolean(it.checked);
    });
    invDoneMap.value = initInv;
  }

  const cardChildren: any[] = [];

  // 1. Шапка карточки (чекбокс выбора + автор + тип ответа + время + удаление)
  const diagTypeLabel =
    msg.diagnosticType === "followup"
      ? "Уточнение"
      : msg.diagnosticType === "visual_inspection"
        ? "Визуальный осмотр"
        : msg.diagnosticType === "general"
          ? "Диалог"
          : "Диагностика";

  const headerControls: any[] = [];
  if (!isWelcome) {
    headerControls.push(
      UIButton(
        UIBox(
          LucideIcon("lucide:check", 11, "#ffffff").style({
            display: () =>
              (callbacks?.isSelected ? callbacks.isSelected(msg.id) : selectedSignal.value)
                ? "flex"
                : "none"
          })
        ).style({
          width: 17,
          height: 17,
          borderRadius: 5,
          borderWidth: 1.5,
          borderColor: () =>
            (callbacks?.isSelected ? callbacks.isSelected(msg.id) : selectedSignal.value)
              ? THEME.accentOrange
              : THEME.borderStrong,
          backgroundColor: () =>
            (callbacks?.isSelected ? callbacks.isSelected(msg.id) : selectedSignal.value)
              ? THEME.accentOrange
              : "transparent",
          alignItems: "center",
          justifyContent: "center"
        })
      )
        .style({ padding: 2 })
        .onClick(() => {
          selectedSignal.value = !selectedSignal.value;
          callbacks?.onToggleSelect?.(msg.id);
        })
    );
  }

  headerControls.push(
    UIText(isUser ? "ЗАПРОС МАСТЕРА" : "ИИДЕАЛ АВТО • ЭКСПЕРТ").style({
      color: () => (isUser ? THEME.accentCyan : THEME.accentOrange),
      fontSize: 10,
      fontWeight: "bold",
      flex: 1
    })
  );

  if (!isUser && !isWelcome) {
    headerControls.push(
      UIBox(
        UIText(diagTypeLabel).style({
          color: () => THEME.accentCyan,
          fontSize: 9,
          fontWeight: "bold"
        })
      ).style({
        backgroundColor: "rgba(56, 189, 248, 0.14)",
        borderWidth: 1,
        borderColor: () => THEME.accentCyan,
        borderRadius: 6,
        paddingHorizontal: 6,
        paddingVertical: 2
      })
    );
  }

  headerControls.push(
    UIText(msg.timestamp || "").style({
      color: () => THEME.textMuted,
      fontSize: 10
    })
  );

  if (!isWelcome && callbacks?.onDeleteMessage) {
    headerControls.push(
      UIButton(LucideIcon("lucide:trash-2", 14, () => THEME.textMuted))
        .style({ padding: 3 })
        .onClick(() => callbacks.onDeleteMessage!(msg.id))
    );
  }

  cardChildren.push(
    UIRow(...headerControls).style({
      alignItems: "center",
      gap: 6,
      width: "100%",
      marginBottom: 6
    })
  );

  // 2. Заголовок резюме
  if (msg.summaryTitle) {
    cardChildren.push(
      UIText(cleanMarkdownForNative(msg.summaryTitle)).style({
        color: () => THEME.textPrimary,
        fontSize: 15,
        fontWeight: "bold",
        lineHeight: 20,
        marginBottom: 6
      })
    );
  }

  // 3. Основной текст сообщения
  if (msg.content) {
    cardChildren.push(
      UIText(cleanMarkdownForNative(msg.content)).style({
        color: () => (isUser ? THEME.textPrimary : THEME.textSecondary),
        fontSize: 13,
        lineHeight: 19,
        marginBottom: 8
      })
    );
  }

  // 4. Прикрепленные материалы (в запросах пользователя или в загруженной истории)
  if (msg.attachments && msg.attachments.length > 0) {
    const attNodes = msg.attachments.map(att => {
      if (att.type === "photo" && att.file) {
        return UIButton(
          UIImage(att.file).style({
            width: 90,
            height: 68,
            borderRadius: 8,
            objectFit: "cover"
          })
        )
          .style({ borderRadius: 8, overflow: "hidden" })
          .onClick(() => openImageLightboxModal(att.file, att.label));
      }
      if (att.type === "audio" && att.file) {
        return UIButton(
          UIRow(
            LucideIcon(
              "lucide:volume-2",
              14,
              () => (playingAudioIdSignal.value === att.id ? THEME.statusOk : "#ec4899")
            ),
            UIText(() =>
              playingAudioIdSignal.value === att.id ? "Пауза" : att.label || "Голосовое"
            ).style({
              color: () => THEME.textPrimary,
              fontSize: 11,
              fontWeight: "600"
            })
          ).style({ alignItems: "center", gap: 5 })
        )
          .style({
            backgroundColor: () => THEME.bgElevated,
            borderWidth: 1,
            borderColor: "#ec4899",
            borderRadius: 8,
            paddingHorizontal: 8,
            paddingVertical: 5
          })
          .onClick(() => {
            try {
              if (playingAudioIdSignal.value === att.id && audioPlayer) {
                audioPlayer.stop();
                playingAudioIdSignal.value = "";
              } else {
                if (audioPlayer) audioPlayer.stop();
                audioPlayer = new AudioPlayer(att.file);
                audioPlayer.addEventListener("completed", () => {
                  playingAudioIdSignal.value = "";
                });
                playingAudioIdSignal.value = att.id;
                audioPlayer.play();
              }
            } catch (_) {
              toast("Воспроизведение недоступно на этом устройстве");
            }
          });
      }
      return UIButton(
        UIRow(
          LucideIcon(
            att.type === "dtc" ? "lucide:zap" : att.type === "obd" ? "lucide:gauge" : "lucide:file-text",
            13,
            () => THEME.accentCyan
          ),
          UIText(att.label).style({
            color: () => THEME.textPrimary,
            fontSize: 11
          })
        ).style({ alignItems: "center", gap: 5 })
      )
        .style({
          backgroundColor: () => THEME.bgElevated,
          borderWidth: 1,
          borderColor: () => THEME.borderDefault,
          borderRadius: 8,
          paddingHorizontal: 8,
          paddingVertical: 5
        })
        .onClick(() => {
          if (att.parsedDoc) {
            openDocumentPreviewModal(att.parsedDoc, callbacks?.onStageDtc);
          } else if (att.type === "dtc" && att.data && callbacks?.onStageDtc) {
            callbacks.onStageDtc(String(att.data));
          }
        });
    });

    cardChildren.push(
      UIRow(...attNodes).style({
        flexWrap: "wrap",
        gap: 6,
        width: "100%",
        marginBottom: 8
      })
    );
  }

type GradientBarVariant = "crit" | "warn" | "ok" | "pending";
const gradientBarCanvasCache: Partial<Record<GradientBarVariant, any>> = {};

function getGradientBarCanvas(variant: GradientBarVariant): any {
  if (gradientBarCanvasCache[variant]) {
    return gradientBarCanvasCache[variant];
  }
  const w = 240;
  const h = 6;
  const cvs = new Canvas(w, h, { pixelRatio: 2 });
  const grad = cvs.createLinearGradient(0, 0, w, 0);
  if (variant === "crit") {
    grad.addColorStop(0, "#dc2626");
    grad.addColorStop(0.55, "#ef4444");
    grad.addColorStop(1, "#f97316");
  } else if (variant === "warn") {
    grad.addColorStop(0, "#ef4444");
    grad.addColorStop(0.45, "#f97316");
    grad.addColorStop(1, "#fbbf24");
  } else if (variant === "pending") {
    grad.addColorStop(0, "#f97316");
    grad.addColorStop(0.55, "#f59e0b");
    grad.addColorStop(1, "#38bdf8");
  } else {
    grad.addColorStop(0, "#f97316");
    grad.addColorStop(0.45, "#eab308");
    grad.addColorStop(1, "#10b981");
  }
  cvs.fillStyle = grad;
  cvs.fillRect(0, 0, w, h);
  gradientBarCanvasCache[variant] = cvs;
  return cvs;
}

  // 5. Выявленные неисправности и DTC + Health Index прогресс-бар
  if (msg.faults && msg.faults.length > 0) {
    const faultCards = msg.faults.map(fault => {
      const h = Math.max(0, Math.min(100, Number(fault.health_index ?? 50)));
      const hColor =
        h >= 70 ? THEME.statusOk : h >= 40 ? THEME.statusWarn : THEME.statusCrit;
      const barVariant: GradientBarVariant = h >= 70 ? "ok" : h >= 40 ? "warn" : "crit";
      return UIColumn(
        UIRow(
          DtcChip(fault.code || "CHECK", () => callbacks?.onStageDtc?.(fault.code)),
          UIText(fault.title || fault.system_ru || "Узел системы").style({
            color: () => THEME.textPrimary,
            fontSize: 12,
            fontWeight: "bold",
            flex: 1
          }),
          UIText(`${h}%`).style({
            color: hColor,
            fontSize: 11,
            fontWeight: "bold"
          })
        ).style({ alignItems: "center", gap: 6, width: "100%", marginBottom: 4 }),
        UIBox(
          ...(h > 0
            ? [
                UIBox(
                  UIImage(getGradientBarCanvas(barVariant)).style({
                    width: "100%",
                    height: 6,
                    objectFit: "fill"
                  })
                ).style({
                  width: `${h}%`,
                  height: 6,
                  borderRadius: 3,
                  overflow: "hidden",
                  alignItems: "flex-start",
                  justifyContent: "center"
                })
              ]
            : [])
        ).style({
          width: "100%",
          height: 6,
          borderRadius: 3,
          backgroundColor: () => THEME.bgElevated,
          alignItems: "flex-start",
          justifyContent: "center",
          overflow: "hidden",
          marginBottom: 6
        }),
        ...(fault.description
          ? [
              UIText(fault.description).style({
                color: () => THEME.textSecondary,
                fontSize: 11,
                lineHeight: 16
              })
            ]
          : []),
        ...(fault.root_cause
          ? [
              UIText(`Причина: ${fault.root_cause}`).style({
                color: () => THEME.textMuted,
                fontSize: 11,
                lineHeight: 15,
                marginTop: 2
              })
            ]
          : [])
      ).style({
        backgroundColor: () => THEME.bgInput,
        borderWidth: 1,
        borderColor: () => THEME.borderDefault,
        borderRadius: 10,
        padding: 9,
        width: "100%"
      });
    });

    cardChildren.push(
      UIColumn(
        UIRow(
          LucideIcon("lucide:shield-alert", 14, () => THEME.statusCrit),
          UIText("Выявленные неисправности").style({
            color: () => THEME.textPrimary,
            fontSize: 12,
            fontWeight: "bold"
          })
        ).style({ alignItems: "center", gap: 6, marginBottom: 6 }),
        ...faultCards
      ).style({ gap: 6, width: "100%", marginBottom: 10 })
    );
  }

  // 6. Интерактивный пошаговый чеклист ремонта
  if (msg.tasks && msg.tasks.length > 0) {
    const totalTasks = msg.tasks.length;
    const doneCount = () =>
      msg.tasks!.filter((t, idx) => {
        const key = String(t.step_number ?? t.id ?? idx + 1);
        return Boolean(tasksDoneMap.value[key]);
      }).length;

    const stepRows = msg.tasks.map((task, idx) => {
      const checkId = task.step_number ?? task.id ?? idx + 1;
      const mapKey = String(checkId);
      const isDone = () => Boolean(tasksDoneMap.value[mapKey]);
      const stepLabel = task.title && task.instruction && task.title !== task.instruction
        ? `${task.title}: ${task.instruction}`
        : task.text || task.instruction || task.title || `Шаг ${idx + 1}`;

      return UIButton(
        UIRow(
          UIBox(
            LucideIcon("lucide:check", 12, "#ffffff").style({
              display: () => (isDone() ? "flex" : "none")
            })
          ).style({
            width: 19,
            height: 19,
            borderRadius: 6,
            borderWidth: 1.5,
            borderColor: () => (isDone() ? THEME.statusOk : THEME.borderStrong),
            backgroundColor: () => (isDone() ? THEME.statusOk : "transparent"),
            alignItems: "center",
            justifyContent: "center",
            marginTop: 1,
            flexShrink: 0
          }),
          UIColumn(
            UIText(`${idx + 1}. ${stepLabel}`).style({
              color: () => (isDone() ? THEME.textMuted : THEME.textPrimary),
              fontSize: 12,
              lineHeight: 17,
              textDecorationLine: () => (isDone() ? "line-through" : "none")
            }),
            ...(task.torque_or_spec || task.estimated_minutes
              ? [
                  UIText(
                    [
                      task.torque_or_spec ? `Спец.: ${task.torque_or_spec}` : "",
                      task.estimated_minutes ? `~${task.estimated_minutes} мин` : ""
                    ]
                      .filter(Boolean)
                      .join(" • ")
                  ).style({
                    color: () => THEME.accentCyan,
                    fontSize: 10
                  })
                ]
              : [])
          ).style({ flex: 1, gap: 2 })
        ).style({ alignItems: "flex-start", gap: 8, width: "100%" })
      )
        .style({
          width: "100%",
          paddingVertical: 5
        })
        .onClick(() => {
          const next = !isDone();
          tasksDoneMap.value = { ...tasksDoneMap.value, [mapKey]: next };
          task.done = next;
          callbacks?.onToggleTask?.(msg.id, "step", checkId, next);
        });
    });

    cardChildren.push(
      UIColumn(
        UIRow(
          LucideIcon("lucide:check-check", 14, () => THEME.accentOrange),
          UIText("План проверки и ремонта:").style({
            color: () => THEME.accentOrangeLight,
            fontSize: 12,
            fontWeight: "bold",
            flex: 1
          }),
          UIText(() => `${doneCount()} / ${totalTasks} выполн.`).style({
            color: () => THEME.textMuted,
            fontSize: 11
          })
        ).style({ alignItems: "center", gap: 6, width: "100%", marginBottom: 4 }),
        ...stepRows
      ).style({
        backgroundColor: () => THEME.bgInput,
        borderWidth: 1,
        borderColor: () => THEME.borderDefault,
        borderRadius: 10,
        padding: 10,
        width: "100%",
        marginBottom: 10
      })
    );
  }

  // 7. Необходимые запчасти и инструмент (чекбоксы синхронизированы с Инспектором)
  if (msg.inventoryItems && msg.inventoryItems.length > 0) {
    const invRows = msg.inventoryItems.map((inv, idx) => {
      const checkId = inv.id || inv.name || String(idx);
      const isChecked = () => Boolean(invDoneMap.value[String(checkId)]);
      return UIButton(
        UIRow(
          UIBox(
            LucideIcon("lucide:check", 11, "#ffffff").style({
              display: () => (isChecked() ? "flex" : "none")
            })
          ).style({
            width: 17,
            height: 17,
            borderRadius: 5,
            borderWidth: 1.5,
            borderColor: () => (isChecked() ? THEME.statusOk : THEME.borderStrong),
            backgroundColor: () => (isChecked() ? THEME.statusOk : "transparent"),
            alignItems: "center",
            justifyContent: "center"
          }),
          UIText(`${inv.name}${inv.spec ? ` (${inv.spec})` : ""}`).style({
            color: () => (isChecked() ? THEME.textMuted : THEME.textSecondary),
            fontSize: 11,
            flex: 1,
            textDecorationLine: () => (isChecked() ? "line-through" : "none")
          })
        ).style({ alignItems: "center", gap: 7, width: "100%" })
      )
        .style({ width: "100%", paddingVertical: 3 })
        .onClick(() => {
          const next = !isChecked();
          invDoneMap.value = { ...invDoneMap.value, [String(checkId)]: next };
          inv.checked = next;
          callbacks?.onToggleTask?.(msg.id, "inventory", checkId, next);
        });
    });

    cardChildren.push(
      UIColumn(
        UIRow(
          LucideIcon("lucide:wrench", 14, () => THEME.statusOk),
          UIText("Инструменты и запчасти:").style({
            color: () => THEME.statusOk,
            fontSize: 12,
            fontWeight: "bold"
          })
        ).style({ alignItems: "center", gap: 6, marginBottom: 4 }),
        ...invRows
      ).style({
        backgroundColor: "rgba(16, 185, 129, 0.08)",
        borderWidth: 1,
        borderColor: "rgba(16, 185, 129, 0.28)",
        borderRadius: 10,
        padding: 10,
        width: "100%",
        marginBottom: 10
      })
    );
  }

  // 8. Телеметрия и рекомендации
  if (
    (msg.telemetryNotes && msg.telemetryNotes.length > 0) ||
    (msg.recommendations && msg.recommendations.length > 0)
  ) {
    const notes = [...(msg.telemetryNotes || []), ...(msg.recommendations || [])];
    cardChildren.push(
      UIColumn(
        UIText("Рекомендации и нормы:").style({
          color: () => THEME.accentCyan,
          fontSize: 11,
          fontWeight: "bold",
          marginBottom: 3
        }),
        ...notes.slice(0, 6).map(n =>
          UIText(`• ${n}`).style({
            color: () => THEME.textSecondary,
            fontSize: 11,
            lineHeight: 16
          })
        )
      ).style({
        backgroundColor: () => THEME.bgInput,
        borderWidth: 1,
        borderColor: () => THEME.borderDefault,
        borderRadius: 9,
        padding: 9,
        width: "100%",
        marginBottom: 10
      })
    );
  }

  // 9. Сценарии / уточняющие вопросы (кликабельные чипы)
  if (msg.followupSuggestions && msg.followupSuggestions.length > 0) {
    cardChildren.push(
      UIColumn(
        ...msg.followupSuggestions.map(prompt =>
          UIButton(
            UIRow(
              LucideIcon("lucide:arrow-right", 13, () => THEME.accentOrange),
              UIText(prompt).style({
                color: () => THEME.accentOrangeLight,
                fontSize: 11,
                fontWeight: "600",
                flex: 1
              })
            ).style({ alignItems: "center", gap: 6, width: "100%" })
          )
            .style({
              backgroundColor: "rgba(234, 88, 12, 0.1)",
              borderWidth: 1,
              borderColor: "rgba(234, 88, 12, 0.35)",
              borderRadius: 9,
              paddingHorizontal: 10,
              paddingVertical: 7,
              width: "100%"
            })
            .onClick(() => callbacks?.onFollowupClick?.(prompt))
        )
      ).style({ gap: 6, width: "100%", marginBottom: 8 })
    );
  }

  // 10. Кнопки действий ассистента (Копировать, Отчёт, AR)
  if (!isUser && !isWelcome) {
    const buildPlainReport = () => {
      const lines = [
        `ИИДЕАЛ АВТО — Диагностический отчёт`,
        msg.summaryTitle ? `Вердикт: ${msg.summaryTitle}` : "",
        msg.content || "",
        msg.tasks && msg.tasks.length > 0
          ? `\nПлан ремонта:\n${msg.tasks.map((t, i) => `${i + 1}. ${t.text}`).join("\n")}`
          : "",
        msg.inventoryItems && msg.inventoryItems.length > 0
          ? `\nИнвентарь:\n${msg.inventoryItems.map(it => `- ${it.name}`).join("\n")}`
          : ""
      ];
      return lines.filter(Boolean).join("\n\n");
    };

    cardChildren.push(
      UIRow(
        UIButton(
          UIRow(
            LucideIcon("lucide:copy", 13, () => THEME.textSecondary),
            UIText("Копировать").style({
              color: () => THEME.textSecondary,
              fontSize: 11,
              fontWeight: "600"
            })
          ).style({ alignItems: "center", gap: 4 })
        )
          .style({
            backgroundColor: () => THEME.bgElevated,
            borderWidth: 1,
            borderColor: () => THEME.borderDefault,
            borderRadius: 7,
            paddingHorizontal: 9,
            paddingVertical: 5
          })
          .onClick(async () => {
            try {
              await clipboard.write(buildPlainReport());
              toast("Вердикт скопирован в буфер");
            } catch (_) {
              toast("Не удалось скопировать");
            }
          }),

        UIButton(
          UIRow(
            LucideIcon("lucide:file-text", 13, () => THEME.accentCyan),
            UIText("Отчёт").style({
              color: () => THEME.accentCyan,
              fontSize: 11,
              fontWeight: "600"
            })
          ).style({ alignItems: "center", gap: 4 })
        )
          .style({
            backgroundColor: () => THEME.bgElevated,
            borderWidth: 1,
            borderColor: () => THEME.borderDefault,
            borderRadius: 7,
            paddingHorizontal: 9,
            paddingVertical: 5
          })
          .onClick(() => {
            openDocumentPreviewModal({
              filename: "diagnostic_report.txt",
              processing_mode: "Отчёт автодиагностики",
              detected_dtc_codes: msg.dtcCodes || [],
              llm_ready_text: buildPlainReport()
            });
          }),

        ...(callbacks?.onOpenAr
          ? [
              UIButton(
                UIRow(
                  LucideIcon("lucide:glasses", 13, () => THEME.accentOrange),
                  UIText("В AR HUD").style({
                    color: () => THEME.accentOrange,
                    fontSize: 11,
                    fontWeight: "600"
                  })
                ).style({ alignItems: "center", gap: 4 })
              )
                .style({
                  backgroundColor: () => THEME.bgElevated,
                  borderWidth: 1,
                  borderColor: () => THEME.borderDefault,
                  borderRadius: 7,
                  paddingHorizontal: 9,
                  paddingVertical: 5
                })
                .onClick(() => callbacks.onOpenAr?.())
            ]
          : [])
      ).style({ alignItems: "center", gap: 7, width: "100%", marginTop: 2 })
    );
  }

  const card = UIColumn(...cardChildren).style({
    width: "100%",
    backgroundColor: () => (isUser ? THEME.bubbleUserBg : THEME.bubbleAiBg),
    borderWidth: 1,
    borderColor: () => (isUser ? THEME.bubbleUserBorder : THEME.borderDefault),
    borderLeftWidth: isUser ? 1 : 3,
    borderLeftColor: () => (isUser ? THEME.bubbleUserBorder : THEME.accentOrange),
    borderRadius: 14,
    padding: 13
  });

  return card;
}

// =========================================================================
// АНИМИРОВАННЫЙ ИНДИКАТОР ГЕНЕРАЦИИ ОТВЕТА ИИ (С ЭТАПАМИ И ТАЙМЕРОМ)
// =========================================================================

export interface PendingCardHandle {
  node: any;
  setStage: (stageText: string) => void;
  stop: () => void;
}

export function PendingGenerationCard(onCancel?: () => void): PendingCardHandle {
  const stageSignal = signal("Анализ симптомов, кодов ЭБУ и телеметрии...");
  const elapsedMsSignal = signal(0);
  const pulseTickSignal = signal(0);
  const startedAt = Date.now();

  const timer = setInterval(() => {
    const ms = Date.now() - startedAt;
    elapsedMsSignal.value = ms;
    pulseTickSignal.value = (pulseTickSignal.value + 1) % 3;

    if (ms > 14000 && stageSignal.value.indexOf("чек") === -1) {
      stageSignal.value = "Формирование пошагового плана ремонта и чеклиста...";
    } else if (ms > 6000 && ms <= 14000 && stageSignal.value.indexOf("причин") === -1) {
      stageSignal.value = "Локализация причины и сверка с таблицами неисправностей...";
    } else if (ms > 2000 && ms <= 6000 && stageSignal.value.indexOf("баз") === -1) {
      stageSignal.value = "Поиск по базе знаний автодиагностики (RAG)...";
    }
  }, 350);

  const botIconWrap = UIBox(LucideIcon("lucide:bot", 17, () => THEME.accentOrange)).style({
    width: 28,
    height: 28,
    borderRadius: 9,
    backgroundColor: "rgba(249, 115, 22, 0.14)",
    borderWidth: 1,
    borderColor: "rgba(249, 115, 22, 0.35)",
    alignItems: "center",
    justifyContent: "center"
  });

  const pulseDot = (idx: number) =>
    UIBox().style({
      width: 7,
      height: 7,
      borderRadius: 4,
      backgroundColor: () =>
        pulseTickSignal.value === idx ? THEME.accentOrange : THEME.accentCyan,
      opacity: () => (pulseTickSignal.value === idx ? 1 : 0.35)
    });

  const node = UIColumn(
    UIRow(
      botIconWrap,
      UIText("ИИдеал Авто формирует ответ...").style({
        color: () => THEME.textPrimary,
        fontSize: 13,
        fontWeight: "bold",
        flex: 1
      }),
      UIRow(pulseDot(0), pulseDot(1), pulseDot(2)).style({
        alignItems: "center",
        gap: 4,
        marginRight: 6
      }),
      UIText(() => `${(elapsedMsSignal.value / 1000).toFixed(1)}с`).style({
        color: () => THEME.accentCyan,
        fontSize: 11,
        fontWeight: "bold"
      })
    ).style({ alignItems: "center", gap: 8, width: "100%", marginBottom: 7 }),

    UIText(() => stageSignal.value).style({
      color: () => THEME.textSecondary,
      fontSize: 12,
      lineHeight: 17,
      marginBottom: 10
    }),

    // Анимированная градиентная полоса прогресса (строго от левого края)
    UIBox(
      UIBox(
        UIImage(getGradientBarCanvas("pending")).style({
          width: "100%",
          height: 5,
          objectFit: "fill"
        })
      ).style({
        width: () => `${28 + ((pulseTickSignal.value + 1) * 23)}%`,
        height: 5,
        borderRadius: 3,
        overflow: "hidden",
        alignItems: "flex-start",
        justifyContent: "center"
      })
    ).style({
      width: "100%",
      height: 5,
      borderRadius: 3,
      backgroundColor: () => THEME.bgElevated,
      alignItems: "flex-start",
      justifyContent: "center",
      marginBottom: 10,
      overflow: "hidden"
    }),

    UIRow(
      UISpacer(),
      UIButton(
        UIRow(
          LucideIcon("lucide:square", 12, "#ffffff"),
          UIText("Отменить генерацию").style({
            color: "#ffffff",
            fontSize: 11,
            fontWeight: "bold"
          })
        ).style({ alignItems: "center", gap: 5 })
      )
        .style({
          backgroundColor: () => THEME.statusCrit,
          paddingHorizontal: 12,
          paddingVertical: 7,
          borderRadius: 9
        })
        .onClick(() => {
          clearInterval(timer);
          try {
            botAnim?.cancel?.();
          } catch (_) {}
          onCancel?.();
        })
    ).style({ width: "100%", alignItems: "center" })
  ).style({
    width: "100%",
    backgroundColor: () => THEME.bgSurface,
    borderWidth: 1,
    borderColor: () => THEME.accentOrange,
    borderLeftWidth: 3,
    borderRadius: 14,
    padding: 13
  });

  let botAnim: any = null;
  try {
    node.animateFrom?.({
      opacity: 0,
      transform: "translateY(8px)",
      duration: 200,
      easing: "outCubic"
    });
    botAnim = botIconWrap.animateTo?.({
      transform: "scale(1.08)",
      opacity: 0.72,
      duration: 750,
      loop: true,
      loopMode: "ping-pong",
      easing: "inOutSine"
    });
  } catch (_) {}

  return {
    node,
    setStage: (txt: string) => {
      stageSignal.value = txt;
    },
    stop: () => {
      clearInterval(timer);
      try {
        botAnim?.cancel?.();
      } catch (_) {}
    }
  };
}

// =========================================================================
// ПОЛНОФУНКЦИОНАЛЬНЫЙ ДВУХРЕЖИМНЫЙ AR / VR HUD ОВЕРЛЕЙ (RAYNEO + PASSTHROUGH)
// =========================================================================

export function createArHudOverlay(options: {
  onClose?: () => void;
  getSensors?: () => any;
  startMode?: "optical" | "vr";
}): any {
  const arModeSignal = signal<"optical" | "vr">(options.startMode || "optical");
  const cameraFacingSignal = signal<"back" | "front">("back");
  const arStatusSignal = signal<string>("AR-HUD готов к работе");
  const arAttitudeSignal = signal<string>("3DoF: готов");
  const isListeningArSignal = signal<boolean>(false);
  const arQuerySignal = signal<string>("");

  // Размеры вьюпорта (отслеживаются через onLayout для определения портретной ориентации и границ перетаскивания)
  const viewportSignal = signal<{ w: number; h: number }>({ w: 800, h: 400 });
  const camWinRectSignal = signal({ left: 12, top: 58, width: 280, height: 270 });
  const aiWinRectSignal = signal({ left: 304, top: 58, width: 470, height: 270 });
  let layoutInitialized = false;

  const isPortrait = () =>
    viewportSignal.value.h > viewportSignal.value.w + 20 ||
    (viewportSignal.value.w > 0 && viewportSignal.value.w < 480);

  const getSensors =
    options.getSensors ||
    (() => ({
      rpm: appState.obdStateSignal.value.rpm,
      speed: appState.obdStateSignal.value.speed,
      coolantTemp: appState.obdStateSignal.value.coolantTemp,
      voltage: appState.obdStateSignal.value.voltage,
      throttle: appState.obdStateSignal.value.throttle,
      engineLoad: appState.obdStateSignal.value.engineLoad,
      dtcList: appState.obdStateSignal.value.dtcList
    }));

  const tickSignal = signal(0);
  let sensorInterval: any = null;
  let motionStarted = false;
  let activeCamNode: any = null;
  let activeSpeech: any = null;
  let activeRecorder: any = null;
  let modalRef: any = null;
  let camWinNode: any = null;
  let aiWinNode: any = null;
  let phoneAnim: any = null;

  const vrBgCamContainer = UIBox().style({
    width: "100%",
    height: "100%",
    position: "relative"
  });

  const opticalWinCamContainer = UIBox().style({
    width: "100%",
    height: "100%",
    backgroundColor: "#020617",
    position: "relative",
    overflow: "hidden"
  });

  const applyDefaultWindowLayout = (animate: boolean = false) => {
    const vp = viewportSignal.value;
    const w = Math.max(vp.w, vp.h, 640);
    const h = Math.max(300, Math.min(vp.w, vp.h));
    const topSafe = 58;
    const padLeft = 24;
    const padRight = 18;
    const padBottom = 22;
    const gap = 10;
    const availH = Math.max(190, h - topSafe - padBottom);
    const usableW = w - padLeft - padRight;
    const camW = Math.min(340, Math.max(210, Math.round((usableW - gap) * 0.37)));
    const aiW = Math.max(270, usableW - gap - camW);
    const vrAiW = Math.min(540, Math.max(320, Math.round(usableW * 0.64)));

    camWinRectSignal.value = { left: padLeft, top: topSafe, width: camW, height: availH };
    aiWinRectSignal.value =
      arModeSignal.value === "vr"
        ? {
            left: Math.max(padLeft, Math.round(padLeft + (usableW - vrAiW) / 2)),
            top: topSafe,
            width: vrAiW,
            height: availH
          }
        : { left: padLeft + camW + gap, top: topSafe, width: aiW, height: availH };

    if (animate) {
      try {
        camWinNode?.animateFrom?.({
          opacity: 0.55,
          transform: "scale(0.95)",
          duration: 220,
          easing: "outCubic"
        });
        aiWinNode?.animateFrom?.({
          opacity: 0.55,
          transform: "scale(0.95)",
          duration: 220,
          easing: "outCubic"
        });
      } catch (_) {}
    }
  };

  const clampWindowsToViewport = () => {
    const vp = viewportSignal.value;
    if (vp.w <= vp.h + 20) return;
    const clampOne = (rect: { left: number; top: number; width: number; height: number }) => {
      const width = Math.min(rect.width, Math.max(200, vp.w - 20));
      const height = Math.min(rect.height, Math.max(190, vp.h - 68));
      const left = Math.max(8, Math.min(Math.max(8, vp.w - width - 8), rect.left));
      const top = Math.max(54, Math.min(Math.max(54, vp.h - height - 8), rect.top));
      return { left, top, width, height };
    };
    camWinRectSignal.value = clampOne(camWinRectSignal.value);
    aiWinRectSignal.value = clampOne(aiWinRectSignal.value);
  };

  const makeDraggable = (dragBar: any, rectSignal: any) => {
    dragBar.onTouchStart((ev: any) => {
      const startRect = rectSignal.value;
      const originX = ev.clientX;
      const originY = ev.clientY;
      ev.track?.({
        claim: true,
        onMove: (pos: any) => {
          const vp = viewportSignal.value;
          const cur = rectSignal.value;
          const dx = pos.clientX - originX;
          const dy = pos.clientY - originY;
          const maxLeft = Math.max(8, vp.w - cur.width - 8);
          const maxTop = Math.max(54, vp.h - cur.height - 8);
          rectSignal.value = {
            ...cur,
            left: Math.max(8, Math.min(maxLeft, Math.round(startRect.left + dx))),
            top: Math.max(54, Math.min(maxTop, Math.round(startRect.top + dy)))
          };
        }
      });
    });
  };

  const mountCameraForCurrentMode = () => {
    try {
      activeCamNode = null;
      vrBgCamContainer.setContent([]);
      opticalWinCamContainer.setContent([]);

      if (!UICameraNode.supported) return;

      const cam = UICameraNode({ facingMode: cameraFacingSignal.value }).style({
        width: "100%",
        height: "100%"
      });
      cam.onError((err: any) => {
        arStatusSignal.value = `Камера: ${err?.message || "отказ доступа"}`;
      });
      activeCamNode = cam;

      if (arModeSignal.value === "vr") {
        vrBgCamContainer.setContent([cam]);
      } else {
        opticalWinCamContainer.setContent([cam]);
      }
    } catch (err: any) {
      arStatusSignal.value = `Камера: ${err?.message || err}`;
    }
  };

  const cleanupResources = () => {
    if (sensorInterval) {
      clearInterval(sensorInterval);
      sensorInterval = null;
    }
    try {
      phoneAnim?.cancel?.();
    } catch (_) {}
    phoneAnim = null;
    try {
      activeCamNode = null;
      vrBgCamContainer.setContent([]);
      opticalWinCamContainer.setContent([]);
    } catch (_) {}
    if (motionStarted) {
      try {
        device.motion.stop();
      } catch (_) {}
      motionStarted = false;
    }
    if (activeSpeech) {
      try {
        activeSpeech.abort();
      } catch (_) {}
      activeSpeech = null;
    }
    if (activeRecorder) {
      try {
        activeRecorder.cancel();
      } catch (_) {}
      activeRecorder = null;
    }
    isListeningArSignal.value = false;
    try {
      app.setOrientation("auto");
    } catch (_) {}
  };

  const startResources = () => {
    cleanupResources();
    try {
      app.setOrientation("landscape");
    } catch (_) {}

    sensorInterval = setInterval(() => {
      tickSignal.value++;
      if (device.motion.available && motionStarted) {
        try {
          const att = device.motion.attitude;
          if (att) {
            arAttitudeSignal.value = `3DoF Y${Math.round((att.yaw || 0) * 57.3)}° P${Math.round(
              (att.pitch || 0) * 57.3
            )}°`;
          }
        } catch (_) {}
      }
    }, 350);

    if (device.motion.available) {
      try {
        device.motion.start();
        motionStarted = true;
        arAttitudeSignal.value = "3DoF активен";
      } catch (_) {}
    }
    mountCameraForCurrentMode();
  };

  const captureArPhotoToAi = async () => {
    if (!UICameraNode.supported) {
      toast("Модуль камеры не поддерживается");
      return;
    }
    if (!activeCamNode) {
      mountCameraForCurrentMode();
      toast("Камера инициализируется, повторите через секунду");
      return;
    }

    try {
      arStatusSignal.value = "Захват кадра узла...";
      const file = await activeCamNode.takePhoto();
      const item: StagedItem = {
        id: "ar-photo-" + Date.now(),
        type: "photo",
        label: `AR снимок (${new Date().toLocaleTimeString("ru-RU", {
          hour: "2-digit",
          minute: "2-digit"
        })})`,
        meta: file?.size ? `${Math.round(file.size / 1024)} КБ` : "JPEG AR",
        data: file,
        file,
        mimeType: "image/jpeg"
      };
      appState.stagedItemsSignal.value = [...appState.stagedItemsSignal.value, item];
      arStatusSignal.value = "Кадр передан нейросети...";
      if (appState.askHandler) {
        await appState.askHandler("Осмотри этот узел автомобиля и подскажи возможную неисправность", true);
        arStatusSignal.value = "Вердикт ИИ обновлён в AR";
      } else {
        toast("Кадр добавлен в чат");
      }
    } catch (err: any) {
      arStatusSignal.value = `Ошибка снимка: ${err?.message || err}`;
    }
  };

  const handleArVoiceToggle = async () => {
    if (isListeningArSignal.value) {
      try {
        activeSpeech?.stop();
      } catch (_) {}
      if (activeRecorder) {
        try {
          const rec = await activeRecorder.stop();
          isListeningArSignal.value = false;
          if (rec?.file) {
            const sec = Math.max(1, Math.round((rec.duration || 1000) / 1000));
            const itemId = "ar-audio-" + Date.now();
            appState.stagedItemsSignal.value = [
              ...appState.stagedItemsSignal.value,
              {
                id: itemId,
                type: "audio",
                label: `Голос AR (${sec}с)`,
                file: rec.file,
                data: rec.file,
                mimeType: rec.mimeType || "audio/mp4",
                duration: sec
              }
            ];
            arStatusSignal.value = "Отправка голосового в ИИ...";
            await appState.askHandler?.("Голосовой запрос из AR HUD", true);
            arStatusSignal.value = "Ответ ИИ обновлён";
          }
        } catch (_) {}
      }
      isListeningArSignal.value = false;
      return;
    }

    if (AudioRecorder.supported) {
      try {
        const rec = new AudioRecorder();
        activeRecorder = rec;
        isListeningArSignal.value = true;
        arStatusSignal.value = "Запись речи (нажмите ещё раз чтобы отправить)...";
        await rec.start({ maxDuration: 30000 });
        return;
      } catch (err: any) {
        isListeningArSignal.value = false;
        arStatusSignal.value = `Микрофон: ${err?.message || err}`;
      }
    }

    if (SpeechRecognizer.supported) {
      try {
        const sp = new SpeechRecognizer();
        activeSpeech = sp;
        let finalText = "";
        isListeningArSignal.value = true;
        arStatusSignal.value = "Говорите запрос для ИИ...";
        sp.addEventListener("result", (r: any) => {
          finalText = r.transcript || finalText;
          arStatusSignal.value = `Распознано: ${finalText}`;
        });
        sp.addEventListener("end", async () => {
          isListeningArSignal.value = false;
          if (finalText.trim()) {
            await appState.askHandler?.(finalText.trim(), true);
            arStatusSignal.value = "Ответ ИИ получен в AR";
          } else {
            arStatusSignal.value = "Речь не распознана";
          }
        });
        sp.addEventListener("error", (_code: any, msg: string) => {
          isListeningArSignal.value = false;
          arStatusSignal.value = `Голос: ${msg}`;
        });
        await sp.start({ language: "ru-RU", continuous: false, interimResults: true });
        return;
      } catch (_) {
        isListeningArSignal.value = false;
      }
    }
    toast("Микрофон / распознавание речи недоступно");
  };

  // Быстрый выбор или создание диалога прямо из верхней AR-панели (как на сайте)
  const openArSessionPicker = async () => {
    let pickModal: any = null;
    const listSignal = signal<DiagnosticSessionItem[]>(
      appState.currentUserSignal.value.is_authenticated ? [] : appState.demoSessionsSignal.value
    );
    const loadingSignal = signal<boolean>(appState.currentUserSignal.value.is_authenticated);

    const buildSessionRows = (): any[] => {
      const items = listSignal.value || [];
      if (loadingSignal.value && items.length === 0) {
        return [
          UIText("Загрузка списка диалогов...").style({
            color: "#94a3b8",
            fontSize: 12,
            paddingVertical: 10
          })
        ];
      }
      if (items.length === 0) {
        return [
          UIText("Сохранённых диалогов пока нет.").style({
            color: "#94a3b8",
            fontSize: 12,
            paddingVertical: 10
          })
        ];
      }
      return items.map(sess => {
        const isCurrent = sess.id === appState.currentSessionIdSignal.value;
        return UIButton(
          UIRow(
            LucideIcon("lucide:folder-clock", 14, isCurrent ? "#fb923c" : "#38bdf8"),
            UIColumn(
              UIText(sess.title || "Диагностика").style({
                color: "#f8fafc",
                fontSize: 12,
                fontWeight: "bold",
                numberOfLines: 1
              }),
              UIText(`${sess.vehicle_info || "Авто не указано"} • ${sess.updated_at || ""}`).style({
                color: "#94a3b8",
                fontSize: 10,
                numberOfLines: 1
              })
            ).style({ flex: 1, gap: 1 }),
            isCurrent
              ? UIText("Активный").style({ color: "#fb923c", fontSize: 10, fontWeight: "bold" })
              : UIText("")
          ).style({ alignItems: "center", gap: 8, width: "100%" })
        )
          .style({
            width: "100%",
            backgroundColor: isCurrent ? "rgba(249, 115, 22, 0.16)" : "rgba(30, 41, 59, 0.72)",
            borderWidth: 1,
            borderColor: isCurrent ? "rgba(249, 115, 22, 0.55)" : "rgba(148, 163, 184, 0.25)",
            borderRadius: 10,
            paddingHorizontal: 10,
            paddingVertical: 8
          })
          .onClick(async () => {
            pickModal.hide();
            appState.currentSessionIdSignal.value = sess.id;
            appState.currentSessionTitleSignal.value = sess.title || "Диагностика";
            cacheManager.saveSetting("active_session_id", sess.id);
            if (appState.currentUserSignal.value.is_authenticated) {
              const detail = await apiClient.getSessionDetail(sess.id);
              if (detail) {
                const msgs = detail.messages.length > 0 ? detail.messages : [createWelcomeMessage()];
                appState.messagesSignal.value = msgs;
                appState.latestAssistantMessageSignal.value =
                  [...msgs].reverse().find(m => m.role === "assistant") || null;
                if (detail.title) {
                  appState.currentSessionTitleSignal.value = detail.title;
                }
                if (detail.vehicle_info) {
                  appState.vehicleSignal.value = detail.vehicle_info;
                }
                appState.sessionSummarySignal.value = detail.summary || "";
              }
            } else {
              const demoMsgs = appState.demoMessagesBySession[sess.id] || [createWelcomeMessage()];
              appState.messagesSignal.value = demoMsgs;
              appState.latestAssistantMessageSignal.value =
                [...demoMsgs].reverse().find(m => m.role === "assistant") || null;
            }
            arStatusSignal.value = `Диалог: ${appState.currentSessionTitleSignal.value}`;
          });
      });
    };

    pickModal = UIModal(
      UIColumn(
        UIRow(
          LucideIcon("lucide:folder-clock", 16, "#38bdf8"),
          UIText("Выбор диалога в AR HUD").style({
            color: "#f8fafc",
            fontSize: 14,
            fontWeight: "bold",
            flex: 1
          }),
          UIButton(LucideIcon("lucide:x", 17, "#94a3b8"))
            .style({ padding: 4 })
            .onClick(() => pickModal.hide())
        ).style({ alignItems: "center", gap: 8, width: "100%", marginBottom: 8 }),
        UIScrollable(() => buildSessionRows()).style({
          width: "100%",
          height: 185,
          gap: 6
        })
      ).style({
        backgroundColor: "rgba(15, 23, 42, 0.96)",
        borderRadius: 16,
        borderWidth: 1,
        borderColor: "rgba(56, 189, 248, 0.45)",
        padding: 14,
        width: "70%",
        maxWidth: 440
      })
    ).transition({ opacity: 0, transform: "scale(0.95)", duration: 190 });
    pickModal.show();

    if (appState.currentUserSignal.value.is_authenticated) {
      const list = await apiClient.getSessions();
      listSignal.value = list || [];
      loadingSignal.value = false;
    }
  };

  const createNewSessionFromAr = async () => {
    const welcome = createWelcomeMessage();
    appState.selectedMessageIdsSignal.value = [];
    appState.stagedItemsSignal.value = [];
    appState.messagesSignal.value = [welcome];
    appState.latestAssistantMessageSignal.value = welcome;
    appState.sessionSummarySignal.value = "";
    if (appState.currentUserSignal.value.is_authenticated) {
      const created = await apiClient.createSession(null, "AR-диагностика", appState.vehicleSignal.value);
      if (created?.id) {
        appState.currentSessionIdSignal.value = created.id;
        appState.currentSessionTitleSignal.value = created.title;
        cacheManager.saveSetting("active_session_id", created.id);
        appState.sessionsRefreshCounterSignal.value++;
        arStatusSignal.value = "Создан новый облачный диалог";
        return;
      }
    }
    const newId = "ar-" + Date.now() + "-" + Math.floor(Math.random() * 10000);
    appState.currentSessionIdSignal.value = newId;
    appState.currentSessionTitleSignal.value = `AR-сессия #${appState.demoSessionsSignal.value.length + 1}`;
    appState.demoMessagesBySession[newId] = [welcome];
    appState.demoSessionsSignal.value = [
      {
        id: newId,
        title: appState.currentSessionTitleSignal.value,
        is_pinned: false,
        tag: "",
        project_id: null,
        vehicle_info: appState.vehicleSignal.value,
        summary: "",
        updated_at: "Сейчас",
        message_count: 0
      },
      ...appState.demoSessionsSignal.value
    ];
    cacheManager.saveSetting("active_session_id", newId);
    appState.sessionsRefreshCounterSignal.value++;
    arStatusSignal.value = "Начат новый диалог";
  };

  const buildChecklistInsideAr = (): any[] => {
    const msgs = appState.messagesSignal.value || [];
    const latestUser = [...msgs].reverse().find(m => m.role === "user");
    const latest = appState.latestAssistantMessageSignal.value;
    const nodes: any[] = [];

    if (latestUser) {
      nodes.push(
        UIBox(
          UIText(`Вы: ${latestUser.content}`).style({
            color: "#38bdf8",
            fontSize: 11,
            fontWeight: "600",
            lineHeight: 15
          })
        ).style({
          width: "100%",
          alignItems: "flex-start",
          backgroundColor: "rgba(56, 189, 248, 0.12)",
          borderWidth: 1,
          borderColor: "rgba(56, 189, 248, 0.3)",
          borderRadius: 9,
          paddingHorizontal: 9,
          paddingVertical: 6,
          marginBottom: 6
        })
      );
    }

    if (!latest || latest.id === "msg-welcome") {
      nodes.push(
        UIText(
          "Наведите камеру на узел двигателя или задайте вопрос голосом/текстом. Здесь появятся вердикт ИИ и пошаговый чеклист ремонта."
        ).style({
          color: "#94a3b8",
          fontSize: 12,
          lineHeight: 17
        })
      );
      return nodes;
    }

    if (latest.summaryTitle) {
      nodes.push(
        UIText(latest.summaryTitle).style({
          color: "#f8fafc",
          fontSize: 13,
          fontWeight: "bold",
          marginBottom: 4
        })
      );
    }
    if (latest.content) {
      nodes.push(
        UIText(cleanMarkdownForNative(latest.content)).style({
          color: "#cbd5e1",
          fontSize: 12,
          lineHeight: 17,
          marginBottom: 6
        })
      );
    }
    if (latest.followupSuggestions && latest.followupSuggestions.length > 0) {
      latest.followupSuggestions.slice(0, 2).forEach(q => {
        nodes.push(
          UIText(`-> ${q}`).style({
            color: "#fb923c",
            fontSize: 11,
            fontWeight: "600",
            marginBottom: 5
          })
        );
      });
    }

    const checklistSource =
      latest.tasks && latest.tasks.length > 0
        ? latest
        : [...msgs].reverse().find(m => m.role === "assistant" && m.tasks && m.tasks.length > 0) || latest;

    const faultsToShow =
      latest.faults && latest.faults.length > 0 ? latest.faults : checklistSource.faults || [];
    if (faultsToShow.length > 0) {
      nodes.push(
        UIRow(...faultsToShow.slice(0, 4).map(f => DtcChip(f.code))).style({
          flexWrap: "wrap",
          gap: 6,
          marginBottom: 6
        })
      );
    }

    if (checklistSource.tasks && checklistSource.tasks.length > 0) {
      nodes.push(
        UIText("ШАГИ РЕМОНТА И ПРОВЕРКИ:").style({
          color: "#fb923c",
          fontSize: 10,
          fontWeight: "bold",
          marginTop: 2,
          marginBottom: 4
        })
      );
      checklistSource.tasks.forEach((t, idx) => {
        const cid = t.step_number ?? t.id ?? idx + 1;
        nodes.push(
          UIButton(
            UIRow(
              UIBox(
                LucideIcon("lucide:check", 11, "#000000").style({
                  display: t.done ? "flex" : "none"
                })
              ).style({
                width: 17,
                height: 17,
                borderRadius: 5,
                borderWidth: 1.5,
                borderColor: t.done ? "#10b981" : "#38bdf8",
                backgroundColor: t.done ? "#10b981" : "transparent",
                alignItems: "center",
                justifyContent: "center"
              }),
              UIText(`${idx + 1}. ${t.text}`).style({
                color: t.done ? "#64748b" : "#e2e8f0",
                fontSize: 12,
                flex: 1,
                textDecorationLine: t.done ? "line-through" : "none"
              })
            ).style({ alignItems: "center", gap: 8, width: "100%" })
          )
            .style({ paddingVertical: 4, width: "100%" })
            .onClick(() => {
              appState.toggleTaskHandler?.(checklistSource.id, "step", cid, !t.done);
            })
        );
      });
    }
    return nodes;
  };

  // Переключатель AR-очки / VR режим (точно как .ar-top-status на сайте)
  const submodePill = (label: string, iconName: string, mode: "optical" | "vr") =>
    UIButton(
      UIRow(
        LucideIcon(iconName, 14, () => (arModeSignal.value === mode ? "#ffffff" : "#94a3b8")),
        UIText(label).style({
          color: () => (arModeSignal.value === mode ? "#ffffff" : "#94a3b8"),
          fontSize: 11,
          fontWeight: "bold"
        })
      ).style({ alignItems: "center", gap: 5 })
    )
      .style({
        backgroundColor: () => (arModeSignal.value === mode ? "#ea580c" : "rgba(255, 255, 255, 0.06)"),
        borderWidth: 1,
        borderColor: () => (arModeSignal.value === mode ? "#f97316" : "rgba(148, 163, 184, 0.28)"),
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 8
      })
      .onClick(() => {
        arModeSignal.value = mode;
        applyDefaultWindowLayout(true);
        mountCameraForCurrentMode();
      });

  // 1. ВЕРХНЯЯ ПЛАВАЮЩАЯ ТАБЛЕТКА УПРАВЛЕНИЯ (.ar-top-status)
  const topFloatingBar = UIBox(
    UIScrollable(
      UIRow(
        submodePill("AR-очки", "lucide:glasses", "optical"),
        submodePill("VR режим", "lucide:eye", "vr"),

        // Кнопка смены камеры VR (отображается только в VR-режиме как на сайте)
        UIButton(
          UIRow(
            LucideIcon("lucide:switch-camera", 13, "#e2e8f0"),
            UIText("Камера").style({ color: "#e2e8f0", fontSize: 11, fontWeight: "600" })
          ).style({ alignItems: "center", gap: 4 })
        )
          .style({
            backgroundColor: "rgba(255, 255, 255, 0.08)",
            borderWidth: 1,
            borderColor: "rgba(148, 163, 184, 0.28)",
            paddingHorizontal: 9,
            paddingVertical: 5,
            borderRadius: 8,
            display: () => (arModeSignal.value === "vr" ? "flex" : "none")
          })
          .onClick(async () => {
            cameraFacingSignal.value = cameraFacingSignal.value === "back" ? "front" : "back";
            if (activeCamNode?.setFacingMode) {
              await activeCamNode.setFacingMode(cameraFacingSignal.value).catch(() => {});
            } else {
              mountCameraForCurrentMode();
            }
          }),

        UIBox().style({ width: 1, height: 18, backgroundColor: "rgba(148, 163, 184, 0.28)" }),

        // Селектор сессии + "+ Диалог"
        UIButton(
          UIRow(
            LucideIcon("lucide:folder-clock", 13, "#38bdf8"),
            UIText(() => appState.currentSessionTitleSignal.value || "Диалог").style({
              color: "#f8fafc",
              fontSize: 11,
              fontWeight: "600",
              maxWidth: 120,
              numberOfLines: 1
            })
          ).style({ alignItems: "center", gap: 5 })
        )
          .style({
            backgroundColor: "rgba(15, 23, 42, 0.9)",
            borderWidth: 1,
            borderColor: "rgba(56, 189, 248, 0.35)",
            paddingHorizontal: 9,
            paddingVertical: 5,
            borderRadius: 8
          })
          .onClick(() => {
            void openArSessionPicker();
          }),

        UIButton(
          UIRow(
            LucideIcon("lucide:plus", 13, "#38bdf8"),
            UIText("Диалог").style({ color: "#38bdf8", fontSize: 11, fontWeight: "bold" })
          ).style({ alignItems: "center", gap: 3 })
        )
          .style({
            backgroundColor: "rgba(56, 189, 248, 0.14)",
            borderWidth: 1,
            borderColor: "rgba(56, 189, 248, 0.4)",
            paddingHorizontal: 9,
            paddingVertical: 5,
            borderRadius: 8
          })
          .onClick(() => {
            void createNewSessionFromAr();
          }),

        UIButton(
          UIRow(
            LucideIcon("lucide:rotate-ccw", 13, "#cbd5e1"),
            UIText("Сброс окон").style({ color: "#cbd5e1", fontSize: 11, fontWeight: "600" })
          ).style({ alignItems: "center", gap: 4 })
        )
          .style({
            backgroundColor: "rgba(255, 255, 255, 0.08)",
            borderWidth: 1,
            borderColor: "rgba(148, 163, 184, 0.28)",
            paddingHorizontal: 9,
            paddingVertical: 5,
            borderRadius: 8
          })
          .onClick(() => {
            applyDefaultWindowLayout(true);
            arStatusSignal.value = "Позиция окон сброшена";
          }),

        UIButton(
          UIRow(
            LucideIcon("lucide:x", 13, "#fca5a5"),
            UIText("Выйти из AR").style({ color: "#fecaca", fontSize: 11, fontWeight: "bold" })
          ).style({ alignItems: "center", gap: 4 })
        )
          .style({
            backgroundColor: "rgba(239, 68, 68, 0.2)",
            borderWidth: 1,
            borderColor: "rgba(239, 68, 68, 0.55)",
            paddingHorizontal: 10,
            paddingVertical: 5,
            borderRadius: 8
          })
          .onClick(() => {
            cleanupResources();
            modalRef?.hide();
            options.onClose?.();
          })
      ).style({ alignItems: "center", gap: 6 })
    ).style({
      scrollDirection: "horizontal",
      showScrollbar: false,
      backgroundColor: "rgba(10, 15, 25, 0.94)",
      borderWidth: 1,
      borderColor: "rgba(56, 189, 248, 0.45)",
      borderRadius: 14,
      paddingHorizontal: 10,
      paddingVertical: 5,
      maxWidth: "98%"
    })
  ).style({
    position: "absolute",
    top: 8,
    left: 8,
    right: 8,
    alignItems: "center",
    justifyContent: "center",
    display: () => (isPortrait() ? "none" : "flex")
  });

  // 2. ПЛАВАЮЩЕЕ ОКНО КАМЕРЫ И ВИЗИРА (#arWindowCamera — только в оптическом AR-режиме)
  const camDragBar = UIButton(
    UIRow(
      UIRow(
        LucideIcon("lucide:camera", 14, "#fb923c"),
        UIText("Камера и визир узла").style({
          color: "#f8fafc",
          fontSize: 12,
          fontWeight: "bold",
          numberOfLines: 1
        })
      ).style({ alignItems: "center", gap: 6, flex: 1 }),
      UIText("::: Перетащить").style({
        color: "#cbd5e1",
        fontSize: 10,
        fontWeight: "600"
      })
    ).style({ width: "100%", alignItems: "center", gap: 6 })
  ).style({
    width: "100%",
    backgroundColor: "rgba(249, 115, 22, 0.16)",
    borderBottomWidth: 1,
    borderBottomColor: "rgba(249, 115, 22, 0.3)",
    paddingHorizontal: 10,
    paddingVertical: 7
  });
  makeDraggable(camDragBar, camWinRectSignal);

  // Оптический визир поверх камеры
  const camReticle = UIBox(
    UIBox().style({ position: "absolute", top: 14, left: 14, width: 18, height: 2, backgroundColor: "rgba(249, 115, 22, 0.85)" }),
    UIBox().style({ position: "absolute", top: 14, left: 14, width: 2, height: 18, backgroundColor: "rgba(249, 115, 22, 0.85)" }),
    UIBox().style({ position: "absolute", top: 14, right: 14, width: 18, height: 2, backgroundColor: "rgba(249, 115, 22, 0.85)" }),
    UIBox().style({ position: "absolute", top: 14, right: 14, width: 2, height: 18, backgroundColor: "rgba(249, 115, 22, 0.85)" }),
    UIBox().style({ position: "absolute", bottom: 14, left: 14, width: 18, height: 2, backgroundColor: "rgba(249, 115, 22, 0.85)" }),
    UIBox().style({ position: "absolute", bottom: 14, left: 14, width: 2, height: 18, backgroundColor: "rgba(249, 115, 22, 0.85)" }),
    UIBox().style({ position: "absolute", bottom: 14, right: 14, width: 18, height: 2, backgroundColor: "rgba(249, 115, 22, 0.85)" }),
    UIBox().style({ position: "absolute", bottom: 14, right: 14, width: 2, height: 18, backgroundColor: "rgba(249, 115, 22, 0.85)" }),
    UIBox().style({
      position: "absolute",
      bottom: 8,
      left: 8,
      backgroundColor: "rgba(2, 6, 23, 0.78)",
      borderWidth: 1,
      borderColor: "rgba(56, 189, 248, 0.4)",
      borderRadius: 6,
      paddingHorizontal: 6,
      paddingVertical: 3
    }).setContent([
      UIText(() => {
        const _ = tickSignal.value;
        const s = getSensors();
        return `${s.rpm || 0} rpm • ${s.coolantTemp || 0}°C • ${(s.voltage || 12.6).toFixed(1)}V`;
      }).style({ color: "#38bdf8", fontSize: 9, fontWeight: "bold" })
    ])
  ).style({
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0
  });

  camWinNode = UIColumn(
    camDragBar,
    UIBox(
      opticalWinCamContainer,
      camReticle
    ).style({
      flex: 1,
      width: "100%",
      position: "relative",
      backgroundColor: "#020617"
    }),
    UIRow(
      UIButton(LucideIcon("lucide:switch-camera", 15, "#e2e8f0"))
        .style({
          width: 34,
          height: 34,
          borderRadius: 9,
          backgroundColor: "rgba(30, 41, 59, 0.9)",
          borderWidth: 1,
          borderColor: "rgba(148, 163, 184, 0.3)",
          alignItems: "center",
          justifyContent: "center"
        })
        .onClick(async () => {
          cameraFacingSignal.value = cameraFacingSignal.value === "back" ? "front" : "back";
          if (activeCamNode?.setFacingMode) {
            await activeCamNode.setFacingMode(cameraFacingSignal.value).catch(() => {});
          } else {
            mountCameraForCurrentMode();
          }
        }),
      UIButton(
        UIRow(
          LucideIcon("lucide:camera", 14, "#ffffff"),
          UIText("Сфоткать в ИИ").style({ color: "#ffffff", fontSize: 11, fontWeight: "bold" })
        ).style({ alignItems: "center", gap: 5 })
      )
        .style({
          flex: 1,
          height: 34,
          backgroundColor: "#ea580c",
          borderRadius: 9,
          alignItems: "center",
          justifyContent: "center"
        })
        .onClick(captureArPhotoToAi),
      UIButton(LucideIcon("lucide:mic", 15, "#ffffff"))
        .style({
          width: 34,
          height: 34,
          borderRadius: 9,
          backgroundColor: () => (isListeningArSignal.value ? "#ef4444" : "#0284c7"),
          alignItems: "center",
          justifyContent: "center"
        })
        .onClick(handleArVoiceToggle)
    ).style({
      width: "100%",
      padding: 8,
      gap: 6,
      alignItems: "center",
      backgroundColor: "rgba(15, 23, 42, 0.95)",
      borderTopWidth: 1,
      borderTopColor: "rgba(148, 163, 184, 0.2)"
    })
  ).style({
    position: "absolute",
    left: () => camWinRectSignal.value.left,
    top: () => camWinRectSignal.value.top,
    width: () => camWinRectSignal.value.width,
    height: () => camWinRectSignal.value.height,
    backgroundColor: "rgba(8, 12, 20, 0.88)",
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: "rgba(249, 115, 22, 0.65)",
    overflow: "hidden",
    display: () => (!isPortrait() && arModeSignal.value === "optical" ? "flex" : "none")
  });

  // 3. ПЛАВАЮЩЕЕ ОКНО АССИСТЕНТА И ЧЕКЛИСТА РЕМОНТА (#arWindowAssistant)
  const aiDragBar = UIButton(
    UIRow(
      UIRow(
        LucideIcon("lucide:bot", 14, "#38bdf8"),
        UIColumn(
          UIText("Ассистент и чеклист ремонта").style({
            color: "#f8fafc",
            fontSize: 12,
            fontWeight: "bold",
            numberOfLines: 1
          }),
          UIText(() => `${arAttitudeSignal.value} • ${arStatusSignal.value}`).style({
            color: "#94a3b8",
            fontSize: 9,
            numberOfLines: 1
          })
        ).style({ flex: 1, gap: 0 })
      ).style({ alignItems: "center", gap: 6, flex: 1 }),
      UIText("::: Перетащить").style({
        color: "#cbd5e1",
        fontSize: 10,
        fontWeight: "600"
      })
    ).style({ width: "100%", alignItems: "center", gap: 6 })
  ).style({
    width: "100%",
    backgroundColor: "rgba(56, 189, 248, 0.16)",
    borderBottomWidth: 1,
    borderBottomColor: "rgba(56, 189, 248, 0.3)",
    paddingHorizontal: 10,
    paddingVertical: 6
  });
  makeDraggable(aiDragBar, aiWinRectSignal);

  const arQuickInput = UIInput()
    .style({
      flex: 1,
      height: 34,
      backgroundColor: "rgba(15, 23, 42, 0.9)",
      color: "#f8fafc",
      placeholder: "Вопрос или DTC в AR...",
      placeholderColor: "#94a3b8",
      borderWidth: 1,
      borderColor: "rgba(148, 163, 184, 0.3)",
      borderRadius: 9,
      paddingHorizontal: 10,
      fontSize: 12,
      keyboardShrink: true
    })
    .onChange((val: string) => {
      arQuerySignal.value = val;
    });

  const handleArQuickSend = async () => {
    const q = (arQuickInput.value || arQuerySignal.value || "").trim();
    const hasStaged = (appState.stagedItemsSignal.value || []).length > 0;
    if (!q && !hasStaged) {
      toast("Введите вопрос в AR или сфотографируйте узел");
      return;
    }
    arQuickInput.value = "";
    arQuerySignal.value = "";
    arStatusSignal.value = "ИИ формирует диагностику...";
    await appState.askHandler?.(q || undefined, true);
    arStatusSignal.value = "Ответ ИИ готов в AR";
  };

  aiWinNode = UIColumn(
    aiDragBar,

    // Компактная полоса телеметрии OBD-II внутри окна ассистента
    UIRow(
      UIRow(
        UIText("RPM ").style({ color: "#94a3b8", fontSize: 10 }),
        UIText(() => {
          const _ = tickSignal.value;
          return `${getSensors().rpm || 0}`;
        }).style({ color: "#10b981", fontSize: 11, fontWeight: "bold" })
      ).style({ flex: 1, justifyContent: "center" }),
      UIRow(
        UIText("ОЖ ").style({ color: "#94a3b8", fontSize: 10 }),
        UIText(() => {
          const _ = tickSignal.value;
          return `${getSensors().coolantTemp || 0}°C`;
        }).style({ color: "#f59e0b", fontSize: 11, fontWeight: "bold" })
      ).style({ flex: 1, justifyContent: "center" }),
      UIRow(
        UIText("АКБ ").style({ color: "#94a3b8", fontSize: 10 }),
        UIText(() => {
          const _ = tickSignal.value;
          return `${(getSensors().voltage || 12.6).toFixed(1)}V`;
        }).style({ color: "#38bdf8", fontSize: 11, fontWeight: "bold" })
      ).style({ flex: 1, justifyContent: "center" }),
      UIRow(
        UIText("TPS ").style({ color: "#94a3b8", fontSize: 10 }),
        UIText(() => {
          const _ = tickSignal.value;
          return `${getSensors().throttle || 0}%`;
        }).style({ color: "#e2e8f0", fontSize: 11, fontWeight: "bold" })
      ).style({ flex: 1, justifyContent: "center" })
    ).style({
      width: "100%",
      backgroundColor: "rgba(2, 6, 23, 0.78)",
      borderBottomWidth: 1,
      borderBottomColor: "rgba(16, 185, 129, 0.25)",
      paddingVertical: 4,
      paddingHorizontal: 8
    }),

    // Баннер генерации внутри AR-окна
    UIRow(
      LucideIcon("lucide:bot", 14, "#fb923c"),
      UIText("ИИ анализирует кадр и симптомы...").style({
        color: "#fb923c",
        fontSize: 11,
        fontWeight: "bold"
      })
    ).style({
      width: "100%",
      backgroundColor: "rgba(234, 88, 12, 0.22)",
      borderBottomWidth: 1,
      borderBottomColor: "#ea580c",
      paddingHorizontal: 10,
      paddingVertical: 5,
      alignItems: "center",
      gap: 6,
      display: () => (appState.isAskingSignal.value ? "flex" : "none")
    }),

    // Лента вердикта и интерактивный чеклист шагов ремонта
    UIScrollable(() => buildChecklistInsideAr()).style({
      flex: 1,
      width: "100%",
      padding: 10
    }),

    StagingBar(appState.stagedItemsSignal, (removeId: string) => {
      appState.stagedItemsSignal.value = appState.stagedItemsSignal.value.filter(
        it => it.id !== removeId
      );
    }),

    // Нижняя строка быстрого ввода внутри окна #arWindowAssistant (.ar-assistant-footer)
    UIRow(
      arQuickInput,
      UIButton(LucideIcon("lucide:camera", 15, "#fb923c"))
        .style({
          width: 34,
          height: 34,
          borderRadius: 9,
          backgroundColor: "rgba(249, 115, 22, 0.16)",
          borderWidth: 1,
          borderColor: "rgba(249, 115, 22, 0.45)",
          alignItems: "center",
          justifyContent: "center"
        })
        .onClick(captureArPhotoToAi),
      UIButton(LucideIcon("lucide:mic", 15, () => (isListeningArSignal.value ? "#ffffff" : "#ec4899")))
        .style({
          width: 34,
          height: 34,
          borderRadius: 9,
          backgroundColor: () =>
            isListeningArSignal.value ? "#ef4444" : "rgba(236, 72, 153, 0.14)",
          borderWidth: 1,
          borderColor: () =>
            isListeningArSignal.value ? "#ef4444" : "rgba(236, 72, 153, 0.45)",
          alignItems: "center",
          justifyContent: "center"
        })
        .onClick(handleArVoiceToggle),
      UIButton(
        UIRow(
          LucideIcon("lucide:send", 13, "#ffffff"),
          UIText("Отпр.").style({ color: "#ffffff", fontSize: 11, fontWeight: "bold" })
        ).style({ alignItems: "center", gap: 4 })
      )
        .style({
          height: 34,
          paddingHorizontal: 10,
          borderRadius: 9,
          backgroundColor: "#0284c7",
          alignItems: "center",
          justifyContent: "center"
        })
        .onClick(() => {
          void handleArQuickSend();
        })
    ).style({
      width: "100%",
      padding: 8,
      gap: 6,
      alignItems: "center",
      backgroundColor: "rgba(15, 23, 42, 0.94)",
      borderTopWidth: 1,
      borderTopColor: "rgba(148, 163, 184, 0.22)"
    })
  ).style({
    position: "absolute",
    left: () => aiWinRectSignal.value.left,
    top: () => aiWinRectSignal.value.top,
    width: () => aiWinRectSignal.value.width,
    height: () => aiWinRectSignal.value.height,
    backgroundColor: () =>
      arModeSignal.value === "vr" ? "rgba(8, 12, 20, 0.80)" : "rgba(8, 12, 20, 0.88)",
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: "rgba(56, 189, 248, 0.7)",
    overflow: "hidden",
    display: () => (isPortrait() ? "none" : "flex")
  });

  // 4. ПОРТРЕТНЫЙ БАРЬЕР ОРИЕНТАЦИИ (.ar-portrait-barrier — 1-в-1 с сайтом)
  const phoneRotateIcon = UIBox(
    UIBox().style({
      width: 12,
      height: 2,
      borderRadius: 1,
      backgroundColor: "#fb923c",
      marginBottom: 4
    }),
    UIBox().style({
      width: 22,
      height: 32,
      borderRadius: 3,
      backgroundColor: "rgba(249, 115, 22, 0.16)",
      borderWidth: 1,
      borderColor: "rgba(249, 115, 22, 0.35)"
    }),
    UIBox().style({
      width: 4,
      height: 4,
      borderRadius: 2,
      backgroundColor: "#fb923c",
      marginTop: 4
    })
  ).style({
    width: 34,
    height: 54,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: "#fb923c",
    backgroundColor: "rgba(15, 23, 42, 0.9)",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 4
  });

  const portraitBarrier = UIBox(
    UIColumn(
      phoneRotateIcon,
      UIText("Поверните экран горизонтально").style({
        color: "#f8fafc",
        fontSize: 16,
        fontWeight: "bold",
        textAlign: "center",
        marginTop: 14
      }),
      UIText(
        "Интерфейс AR / VR очков ИИдеал Авто разработан для альбомной (горизонтальной) ориентации."
      ).style({
        color: "#94a3b8",
        fontSize: 12,
        lineHeight: 17,
        textAlign: "center",
        marginTop: 6,
        marginBottom: 16
      }),
      UIRow(
        UIButton(
          UIText("В альбомный").style({ color: "#ffffff", fontSize: 12, fontWeight: "bold" })
        )
          .style({
            backgroundColor: "#ea580c",
            paddingHorizontal: 14,
            paddingVertical: 10,
            borderRadius: 10
          })
          .onClick(() => {
            try {
              app.setOrientation("landscape");
            } catch (_) {}
          }),
        UIButton(
          UIText("Выйти из AR").style({ color: "#fecaca", fontSize: 12, fontWeight: "bold" })
        )
          .style({
            backgroundColor: "rgba(239, 68, 68, 0.2)",
            borderWidth: 1,
            borderColor: "rgba(239, 68, 68, 0.5)",
            paddingHorizontal: 14,
            paddingVertical: 10,
            borderRadius: 10
          })
          .onClick(() => {
            cleanupResources();
            modalRef?.hide();
            options.onClose?.();
          })
      ).style({ gap: 10, alignItems: "center", justifyContent: "center" })
    ).style({
      width: "90%",
      maxWidth: 340,
      backgroundColor: "rgba(15, 23, 42, 0.96)",
      borderWidth: 1.5,
      borderColor: "rgba(249, 115, 22, 0.55)",
      borderRadius: 18,
      padding: 24,
      alignItems: "center"
    })
  ).style({
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: "#000000",
    alignItems: "center",
    justifyContent: "center",
    display: () => (isPortrait() ? "flex" : "none")
  });

  // Корневой контейнер с отслеживанием размеров экрана и поддержкой VR-фона камеры
  const arRootBox = UIBox(
    UIBox(vrBgCamContainer).style({
      position: "absolute",
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
      display: () => (!isPortrait() && arModeSignal.value === "vr" ? "flex" : "none")
    }),
    camWinNode,
    aiWinNode,
    topFloatingBar,
    portraitBarrier
  )
    .style({
      width: "100%",
      height: "100%",
      position: "relative",
      backgroundColor: "#000000",
      overflow: "hidden"
    })
    .onLayout((layout: { left: number; top: number; width: number; height: number }) => {
      if (layout.width > 0 && layout.height > 0) {
        viewportSignal.value = { w: layout.width, h: layout.height };
        if (layout.width > layout.height + 20) {
          if (!layoutInitialized) {
            layoutInitialized = true;
            applyDefaultWindowLayout(false);
          } else {
            clampWindowsToViewport();
          }
        }
      }
    });

  modalRef = UIModal(arRootBox)
    .style({
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
      padding: 0,
      margin: 0,
      borderRadius: 0,
      backgroundColor: "#000000"
    })
    .transition({ opacity: 0, duration: 180 })
    .onOpen(() => {
      layoutInitialized = false;
      startResources();
      try {
        phoneAnim = phoneRotateIcon.animateTo?.({
          transform: "rotate(-90deg)",
          duration: 950,
          loop: true,
          loopMode: "ping-pong",
          easing: "inOutSine"
        });
      } catch (_) {}
    })
    .onClose(() => {
      cleanupResources();
    })
    .onDismiss(() => {
      cleanupResources();
      modalRef.hide();
      options.onClose?.();
    });

  (modalRef as any).openWithMode = (mode?: "optical" | "vr") => {
    if (mode) arModeSignal.value = mode;
    modalRef.show();
  };

  return modalRef;
}
