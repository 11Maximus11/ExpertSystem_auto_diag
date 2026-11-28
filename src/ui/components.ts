// ИИдеал Авто — Shared UI Components, Work-Order Canvas & Optical AR HUD (2026-11-28)
// Copyright (C) 2026 ИИдеал Авто (LeCodes48 Edition)
// Licensed under the GNU General Public License v3.0 (GPL-3.0).

import { appState, reloadSessionsFromDb, selectSession, updateSettingsPatch, updateVehicleInfo } from "../state/appState";
import { localDb } from "../storage/LocalDatabase";
import type { ChatMessageItem, ParsedDocInfo, StagedItem, ThemeMode } from "../types";
import { formatDateTimeRu } from "../utils/polyfills";

// =========================================================================
// ТЕМА И ЦВЕТОВАЯ СИСТЕМА
// =========================================================================

export const currentThemeSignal = signal<ThemeMode>(localDb.getSettings().theme_mode);

export function isDark(): boolean {
  return currentThemeSignal.value !== "light";
}

export function toggleTheme(): void {
  const next: ThemeMode = isDark() ? "light" : "dark";
  currentThemeSignal.value = next;
  updateSettingsPatch({ theme_mode: next });
}

export const THEME = {
  get bgBase() { return isDark() ? "#090d16" : "#f1f5f9"; },
  get bgSurface() { return isDark() ? "#111827" : "#ffffff"; },
  get bgElevated() { return isDark() ? "#1e293b" : "#f8fafc"; },
  get bgInput() { return isDark() ? "#0f172a" : "#ffffff"; },

  get borderDefault() { return isDark() ? "#1f2937" : "#cbd5e1"; },
  get borderStrong() { return isDark() ? "#334155" : "#94a3b8"; },

  get textPrimary() { return isDark() ? "#f8fafc" : "#0f172a"; },
  get textSecondary() { return isDark() ? "#cbd5e1" : "#334155"; },
  get textMuted() { return isDark() ? "#94a3b8" : "#475569"; },
  get inputPlaceholder() { return isDark() ? "#64748b" : "#64748b"; },

  accentOrange: "#f97316",
  accentCyan: "#38bdf8",
  accentViolet: "#a855f7",

  statusOk: "#10b981",
  statusWarn: "#f59e0b",
  statusCrit: "#ef4444",

  get bubbleUserBg() { return isDark() ? "#172536" : "#eff6ff"; },
  get bubbleUserBorder() { return isDark() ? "#274060" : "#bfdbfe"; },
  get bubbleAiBg() { return isDark() ? "#111827" : "#ffffff"; },
  get headerTint() { return isDark() ? "rgba(17, 24, 39, 0.94)" : "rgba(255, 255, 255, 0.95)"; },
};

// =========================================================================
// ИКОНКИ LUCIDE (СТРОГО ЛИТЕРАЛЬНЫЕ СТРОКИ ДЛЯ ASSET-КОМПИЛЯТОРА LE.CODES)
// =========================================================================

export function LucideIcon(name: string, size: number = 16, color: any = () => THEME.textSecondary): any {
  let iconAsset: SvgSource;
  switch (name) {
    case "lucide:car": iconAsset = assetIcon("lucide:car"); break;
    case "lucide:wrench": iconAsset = assetIcon("lucide:wrench"); break;
    case "lucide:message-square": iconAsset = assetIcon("lucide:message-square"); break;
    case "lucide:cpu": iconAsset = assetIcon("lucide:cpu"); break;
    case "lucide:radio": iconAsset = assetIcon("lucide:radio"); break;
    case "lucide:history": iconAsset = assetIcon("lucide:history"); break;
    case "lucide:settings": iconAsset = assetIcon("lucide:settings"); break;
    case "lucide:mic": iconAsset = assetIcon("lucide:mic"); break;
    case "lucide:camera": iconAsset = assetIcon("lucide:camera"); break;
    case "lucide:paperclip": iconAsset = assetIcon("lucide:paperclip"); break;
    case "lucide:send": iconAsset = assetIcon("lucide:send"); break;
    case "lucide:glasses": iconAsset = assetIcon("lucide:glasses"); break;
    case "lucide:box": iconAsset = assetIcon("lucide:box"); break;
    case "lucide:sun": iconAsset = assetIcon("lucide:sun"); break;
    case "lucide:moon": iconAsset = assetIcon("lucide:moon"); break;
    case "lucide:shield-alert": iconAsset = assetIcon("lucide:shield-alert"); break;
    case "lucide:shield-check": iconAsset = assetIcon("lucide:shield-check"); break;
    case "lucide:flashlight": iconAsset = assetIcon("lucide:flashlight"); break;
    case "lucide:download": iconAsset = assetIcon("lucide:download"); break;
    case "lucide:upload": iconAsset = assetIcon("lucide:upload"); break;
    case "lucide:copy": iconAsset = assetIcon("lucide:copy"); break;
    case "lucide:share-2": iconAsset = assetIcon("lucide:share-2"); break;
    case "lucide:trash-2": iconAsset = assetIcon("lucide:trash-2"); break;
    case "lucide:pin": iconAsset = assetIcon("lucide:pin"); break;
    case "lucide:plus": iconAsset = assetIcon("lucide:plus"); break;
    case "lucide:check": iconAsset = assetIcon("lucide:check"); break;
    case "lucide:x": iconAsset = assetIcon("lucide:x"); break;
    case "lucide:activity": iconAsset = assetIcon("lucide:activity"); break;
    case "lucide:gauge": iconAsset = assetIcon("lucide:gauge"); break;
    case "lucide:thermometer": iconAsset = assetIcon("lucide:thermometer"); break;
    case "lucide:battery-charging": iconAsset = assetIcon("lucide:battery-charging"); break;
    case "lucide:bluetooth": iconAsset = assetIcon("lucide:bluetooth"); break;
    case "lucide:usb": iconAsset = assetIcon("lucide:usb"); break;
    case "lucide:terminal": iconAsset = assetIcon("lucide:terminal"); break;
    case "lucide:search": iconAsset = assetIcon("lucide:search"); break;
    case "lucide:refresh-cw": iconAsset = assetIcon("lucide:refresh-cw"); break;
    case "lucide:info": iconAsset = assetIcon("lucide:info"); break;
    case "lucide:volume-2": iconAsset = assetIcon("lucide:volume-2"); break;
    case "lucide:square": iconAsset = assetIcon("lucide:square"); break;
    case "lucide:play": iconAsset = assetIcon("lucide:play"); break;
    case "lucide:pause": iconAsset = assetIcon("lucide:pause"); break;
    case "lucide:chevron-right": iconAsset = assetIcon("lucide:chevron-right"); break;
    case "lucide:chevron-left": iconAsset = assetIcon("lucide:chevron-left"); break;
    case "lucide:file-text": iconAsset = assetIcon("lucide:file-text"); break;
    case "lucide:folder-plus": iconAsset = assetIcon("lucide:folder-plus"); break;
    case "lucide:message-square-plus": iconAsset = assetIcon("lucide:message-square-plus"); break;
    case "lucide:pencil": iconAsset = assetIcon("lucide:pencil"); break;
    case "lucide:tag": iconAsset = assetIcon("lucide:tag"); break;
    case "lucide:zap": iconAsset = assetIcon("lucide:zap"); break;
    case "lucide:rotate-ccw": iconAsset = assetIcon("lucide:rotate-ccw"); break;
    case "lucide:image": iconAsset = assetIcon("lucide:image"); break;
    case "lucide:switch-camera": iconAsset = assetIcon("lucide:switch-camera"); break;
    case "lucide:sparkles": iconAsset = assetIcon("lucide:sparkles"); break;
    case "lucide:database": iconAsset = assetIcon("lucide:database"); break;
    case "lucide:alert-triangle": iconAsset = assetIcon("lucide:alert-triangle"); break;
    case "lucide:book-open": iconAsset = assetIcon("lucide:book-open"); break;
    case "lucide:bot": iconAsset = assetIcon("lucide:bot"); break;
    case "lucide:eye": iconAsset = assetIcon("lucide:eye"); break;
    default: iconAsset = assetIcon("lucide:circle-alert"); break;
  }

  return UIImage(iconAsset).style({
    width: size,
    height: size,
    objectFit: "contain",
    tintColor: color,
  });
}

// =========================================================================
// БАЗОВЫЕ КНОПКИ, ПОЛОСЫ И БЕЙДЖИ
// =========================================================================

export type GradientBarVariant = "orange" | "cyan" | "ok" | "warn" | "crit" | "pending";

export function GradientBarFill(
  variant: GradientBarVariant,
  widthExpr: any,
  heightPx: number = 6
): any {
  const getBg = () => {
    if (variant === "ok") return THEME.statusOk;
    if (variant === "warn") return THEME.statusWarn;
    if (variant === "crit") return THEME.statusCrit;
    if (variant === "cyan") return THEME.accentCyan;
    return THEME.accentOrange;
  };
  return UIBox().style({
    width: widthExpr,
    height: heightPx,
    borderRadius: Math.ceil(heightPx / 2),
    backgroundColor: getBg,
  });
}

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
      textAlign: "center",
    })
  )
    .style({
      backgroundColor: () => (isDis() ? "#64748b" : THEME.accentOrange),
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderRadius: 11,
      alignItems: "center",
      justifyContent: "center",
      opacity: () => (isDis() ? 0.65 : 1),
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
      textAlign: "center",
    })
  );

  return UIButton(
    UIRow(...children).style({
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
    })
  )
    .style({
      backgroundColor: () => THEME.bgElevated,
      borderWidth: 1,
      borderColor: () => THEME.borderStrong,
      paddingHorizontal: 11,
      paddingVertical: 9,
      borderRadius: 10,
      alignItems: "center",
      justifyContent: "center",
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
      marginRight: 6,
    }),
    UIText(label).style({
      color: getColor,
      fontSize: 11,
      fontWeight: "bold",
    })
  ).style({
    backgroundColor: getBg,
    borderWidth: 1,
    borderColor: () => THEME.borderDefault,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    alignItems: "center",
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
      fontWeight: "bold",
    })
  ).style({ flex: 1, gap: 2 });

  if (subtitle) {
    col.append(
      UIText(subtitle).style({
        color: () => THEME.textMuted,
        fontSize: 11,
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
    gap: 8,
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
      fontWeight: "bold",
    })
  )
    .style({
      backgroundColor: () => THEME.bgElevated,
      borderWidth: 1,
      borderColor: getTint,
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 4,
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
        flex: 1,
      })
    ).style({ alignItems: "center", gap: 5, width: "100%", marginBottom: 4 }),
    UIRow(
      UIText(valueFn).style({
        color: () => THEME.textPrimary,
        fontSize: 19,
        fontWeight: "bold",
      }),
      UIText(unit ? ` ${unit}` : "").style({
        color: () => THEME.textMuted,
        fontSize: 11,
        marginBottom: 2,
      })
    ).style({ alignItems: "flex-end", width: "100%" })
  ).style({
    backgroundColor: () => THEME.bgSurface,
    borderWidth: 1,
    borderColor: () => THEME.borderDefault,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flex: 1,
  });
}

// =========================================================================
// ШАПКА ПРИЛОЖЕНИЯ (БЕЗ РЕГИСТРАЦИИ / 100% НА УСТРОЙСТВЕ)
// =========================================================================

export interface AppHeaderOptions {
  title?: string;
  onOpenAr?: () => void;
  onOpen3d?: () => void;
  onOpenSettings?: () => void;
  onResetChat?: () => void;
}

export function AppHeader(options: AppHeaderOptions): any {
  const brandTitle = options.title || "ИИДЕАЛ АВТО";

  const statusText = () => {
    if (appState.isGeneratingSignal.value) return "Анализ RAG + ИИ...";
    const mode = appState.settingsSignal.value.llm_mode;
    const obd = appState.obdConnectedSignal.value ? "ELM327" : "Автономно";
    const aiLabel =
      mode === "lecodes_ai" ? "LeCodes AI" : mode === "local_only" ? "RAG Оффлайн" : "BYOK AI";
    return `${aiLabel} • ${obd}`;
  };

  const statusDotColor = () => {
    if (appState.isGeneratingSignal.value) return THEME.statusWarn;
    return appState.obdConnectedSignal.value ? THEME.statusOk : THEME.accentCyan;
  };

  const brandBlock = UIRow(
    UIImage(asset("../../assets/icon.png")).style({
      width: 28,
      height: 28,
      borderRadius: 7,
      objectFit: "cover",
      flexShrink: 0,
    }),
    UIColumn(
      UIText(brandTitle).style({
        color: () => THEME.textPrimary,
        fontSize: 14,
        fontWeight: "bold",
        lineClamp: 1,
      }),
      UIRow(
        UIBox().style({
          width: 6,
          height: 6,
          borderRadius: 3,
          backgroundColor: statusDotColor,
          marginRight: 5,
        }),
        UIText(statusText).style({
          color: () => THEME.textMuted,
          fontSize: 10,
          lineClamp: 1,
        })
      ).style({ alignItems: "center" })
    ).style({ flex: 1, flexShrink: 1, gap: 1 })
  ).style({
    flex: 1,
    flexShrink: 1,
    alignItems: "center",
    gap: 8,
  });

  const actionControls: any[] = [];

  if (options.onResetChat) {
    actionControls.push(
      UIButton(LucideIcon("lucide:message-square-plus", 16, () => THEME.textSecondary))
        .style({
          width: 32,
          height: 32,
          borderRadius: 9,
          backgroundColor: () => THEME.bgElevated,
          borderWidth: 1,
          borderColor: () => THEME.borderDefault,
          alignItems: "center",
          justifyContent: "center",
        })
        .onClick(options.onResetChat)
    );
  }

  if (options.onOpen3d) {
    actionControls.push(
      UIButton(LucideIcon("lucide:box", 16, () => THEME.accentCyan))
        .style({
          width: 32,
          height: 32,
          borderRadius: 9,
          backgroundColor: () => THEME.bgElevated,
          borderWidth: 1,
          borderColor: () => THEME.accentCyan,
          alignItems: "center",
          justifyContent: "center",
        })
        .onClick(options.onOpen3d)
    );
  }

  if (options.onOpenAr) {
    actionControls.push(
      UIButton(
        UIRow(
          LucideIcon("lucide:glasses", 15, "#ffffff"),
          UIText("AR").style({
            color: "#ffffff",
            fontSize: 11,
            fontWeight: "bold",
          })
        ).style({ alignItems: "center", gap: 4 })
      )
        .style({
          backgroundColor: THEME.accentOrange,
          paddingHorizontal: 9,
          height: 32,
          borderRadius: 9,
          alignItems: "center",
          justifyContent: "center",
        })
        .onClick(options.onOpenAr)
    );
  }

  actionControls.push(
    UIButton(
      LucideIcon(
        "lucide:sun",
        16,
        () => (currentThemeSignal.value === "light" ? THEME.accentOrange : THEME.statusWarn)
      )
    )
      .style({
        width: 32,
        height: 32,
        borderRadius: 9,
        backgroundColor: () => THEME.bgElevated,
        borderWidth: 1,
        borderColor: () => THEME.borderDefault,
        alignItems: "center",
        justifyContent: "center",
        display: () => (currentThemeSignal.value === "dark" ? "flex" : "none"),
      })
      .onClick(toggleTheme),
    UIButton(LucideIcon("lucide:moon", 16, () => THEME.accentCyan))
      .style({
        width: 32,
        height: 32,
        borderRadius: 9,
        backgroundColor: () => THEME.bgElevated,
        borderWidth: 1,
        borderColor: () => THEME.borderDefault,
        alignItems: "center",
        justifyContent: "center",
        display: () => (currentThemeSignal.value === "light" ? "flex" : "none"),
      })
      .onClick(toggleTheme)
  );

  if (options.onOpenSettings) {
    actionControls.push(
      UIButton(LucideIcon("lucide:settings", 16, () => THEME.textSecondary))
        .style({
          width: 32,
          height: 32,
          borderRadius: 9,
          backgroundColor: () => THEME.bgElevated,
          borderWidth: 1,
          borderColor: () => THEME.borderDefault,
          alignItems: "center",
          justifyContent: "center",
        })
        .onClick(options.onOpenSettings)
    );
  }

  return UIRow(
    brandBlock,
    UIRow(...actionControls).style({
      alignItems: "center",
      gap: 5,
      flexShrink: 0,
    })
  ).style({
    width: "100%",
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: () => THEME.bgSurface,
    borderBottomWidth: 1,
    borderBottomColor: () => THEME.borderDefault,
    alignItems: "center",
    gap: 6,
  });
}

// =========================================================================
// ПРЕДУПРЕЖДЕНИЕ О ЛОКАЛЬНОМ ХРАНЕНИИ ДАННЫХ И ПОТЕРЕ ПРИ УДАЛЕНИИ
// =========================================================================

export function openDataLossWarningModal(forceShow: boolean = false, onAccepted?: () => void): void {
  const settings = localDb.getSettings();
  if (!forceShow && settings.local_warning_ack) {
    onAccepted?.();
    return;
  }

  const confirmedSignal = signal(settings.local_warning_ack);
  let modal: any = null;

  modal = UIModal(
    UIColumn(
      UIRow(
        UIBox(LucideIcon("lucide:database", 20, () => THEME.accentOrange)).style({
          width: 38,
          height: 38,
          borderRadius: 11,
          backgroundColor: "rgba(249, 115, 22, 0.14)",
          borderWidth: 1,
          borderColor: "rgba(249, 115, 22, 0.4)",
          alignItems: "center",
          justifyContent: "center",
        }),
        UIColumn(
          UIText("Локальное хранение на устройстве").style({
            color: () => THEME.textPrimary,
            fontSize: 15,
            fontWeight: "bold",
          }),
          UIText("Без регистрации и сторонних серверов").style({
            color: () => THEME.accentCyan,
            fontSize: 11,
            fontWeight: "600",
          })
        ).style({ flex: 1, gap: 2 })
      ).style({ alignItems: "center", gap: 10, width: "100%", marginBottom: 10 }),

      UIBox(
        UIColumn(
          UIText(
            "Все ваши диалоги, чеклисты ремонта, проекты автопарка, коды ЭБУ и память автомобиля хранятся строго локально внутри памяти этого телефона."
          ).style({
            color: () => THEME.textSecondary,
            fontSize: 12,
            lineHeight: 18,
          }),
          UIText(
            "ВАЖНО: При удалении приложения «ИИдеал Авто» или очистке данных все переписки и история диагностик будут безвозвратно удалены! Регулярно сохраняйте резервную копию (JSON) в разделе «Настройки»."
          ).style({
            color: () => THEME.statusWarn,
            fontSize: 12,
            fontWeight: "600",
            lineHeight: 18,
          })
        ).style({ gap: 8 })
      ).style({
        backgroundColor: () => THEME.bgInput,
        borderWidth: 1,
        borderColor: () => THEME.statusWarn,
        borderRadius: 12,
        padding: 12,
        width: "100%",
        marginBottom: 12,
      }),

      UIButton(
        UIRow(
          UIBox(
            LucideIcon("lucide:check", 13, "#ffffff").style({
              display: () => (confirmedSignal.value ? "flex" : "none"),
            })
          ).style({
            width: 20,
            height: 20,
            borderRadius: 6,
            borderWidth: 1.5,
            borderColor: () => (confirmedSignal.value ? THEME.accentOrange : THEME.borderStrong),
            backgroundColor: () => (confirmedSignal.value ? THEME.accentOrange : "transparent"),
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }),
          UIText("Я понимаю, что данные удалятся при удалении приложения, и буду делать резервные копии").style({
            color: () => THEME.textPrimary,
            fontSize: 12,
            lineHeight: 17,
            flex: 1,
          })
        ).style({ alignItems: "center", gap: 9, width: "100%" })
      )
        .style({
          paddingVertical: 6,
          width: "100%",
          marginBottom: 12,
        })
        .onClick(() => {
          confirmedSignal.value = !confirmedSignal.value;
        }),

      PrimaryButton("Продолжить в ИИдеал Авто", () => {
        if (!confirmedSignal.value) {
          toast("Отметьте ознакомление с условием локального хранения");
          return;
        }
        updateSettingsPatch({ local_warning_ack: true });
        modal.hide();
        onAccepted?.();
      })
    ).style({
      backgroundColor: () => THEME.bgSurface,
      borderRadius: 18,
      padding: 18,
      borderWidth: 1,
      borderColor: () => THEME.borderStrong,
      width: "92%",
    })
  ).transition({ opacity: 0, transform: "scale(0.96)", duration: 180 });
  modal.show();
}

// =========================================================================
// РЕЗЕРВНОЕ КОПИРОВАНИЕ И ВОССТАНОВЛЕНИЕ ЛОКАЛЬНОЙ БД (JSON)
// =========================================================================

export function openBackupRestoreModal(onRestored?: () => void): void {
  const stats = localDb.getStorageStats();
  const statusMsgSignal = signal(
    localDb.getSettings().last_backup_at
      ? `Последний бэкап: ${localDb.getSettings().last_backup_at}`
      : "Бэкап еще не создавался"
  );
  const importTextSignal = signal("");
  let modal: any = null;

  const importArea = UITextArea()
    .style({
      placeholder: "Вставьте сюда JSON резервной копии (aideal-auto-backup-v1)...",
      placeholderColor: () => THEME.inputPlaceholder,
      backgroundColor: () => THEME.bgInput,
      color: () => THEME.textPrimary,
      borderWidth: 1,
      borderColor: () => THEME.borderStrong,
      borderRadius: 10,
      paddingHorizontal: 10,
      paddingVertical: 8,
      fontSize: 11,
      width: "100%",
      height: 110,
    })
    .onChange((v: string) => {
      importTextSignal.value = v;
    });

  const exportToClipboard = async () => {
    const json = localDb.exportBackupJson();
    try {
      await clipboard.write(json);
      const nowStr = formatDateTimeRu(Date.now());
      updateSettingsPatch({ last_backup_at: nowStr });
      statusMsgSignal.value = `Скопировано в буфер (${Math.round(json.length / 1024) || 1} КБ) • ${nowStr}`;
      toast("Резервная копия JSON скопирована в буфер обмена");
    } catch {
      importArea.value = json;
      importTextSignal.value = json;
      toast("JSON помещен в поле ниже — скопируйте вручную");
    }
  };

  const exportToFile = async () => {
    const json = localDb.exportBackupJson();
    const fname = "aideal_auto_backup_2026-11-28.json";
    try {
      if (files.supported) {
        await files.write(fname, json);
        const nowStr = formatDateTimeRu(Date.now());
        updateSettingsPatch({ last_backup_at: nowStr });
        statusMsgSignal.value = `Файл сохранен: ${fname}`;
        toast(`Сохранен файл ${fname}`);
        return;
      }
      // Browser environment download fallback if DOM document is available
      const g = globalThis as any;
      if (g.document && typeof g.Blob === "function" && g.URL?.createObjectURL) {
        const blob = new g.Blob([json], { type: "application/json" });
        const url = g.URL.createObjectURL(blob);
        const a = g.document.createElement("a");
        a.href = url;
        a.download = fname;
        g.document.body?.appendChild(a);
        a.click();
        g.document.body?.removeChild(a);
        g.URL.revokeObjectURL(url);
        const nowStr = formatDateTimeRu(Date.now());
        updateSettingsPatch({ last_backup_at: nowStr });
        statusMsgSignal.value = `Скачан файл ${fname}`;
        toast(`Загружен ${fname}`);
        return;
      }
    } catch (_) {}
    await exportToClipboard();
  };

  const doRestore = (raw: string) => {
    const res = localDb.importBackupJson(raw);
    if (!res.ok) {
      toast(res.error || "Неверный формат JSON");
      statusMsgSignal.value = res.error || "Ошибка импорта";
      return;
    }
    reloadSessionsFromDb();
    const activeId = localDb.getActiveSessionId();
    if (activeId) selectSession(activeId);
    const updatedSettings = localDb.getSettings();
    appState.settingsSignal.value = updatedSettings;
    currentThemeSignal.value = updatedSettings.theme_mode;
    toast(`Восстановлено: сессий ${res.sessions}, сообщений ${res.messages}`);
    modal?.hide();
    onRestored?.();
  };

  modal = UIModal(
    UIColumn(
      UIRow(
        LucideIcon("lucide:database", 18, () => THEME.accentCyan),
        UIText("Резервное копирование БД").style({
          color: () => THEME.textPrimary,
          fontSize: 15,
          fontWeight: "bold",
          flex: 1,
        }),
        UIButton(LucideIcon("lucide:x", 18, () => THEME.textMuted))
          .style({ padding: 4 })
          .onClick(() => modal.hide())
      ).style({ alignItems: "center", gap: 8, width: "100%", marginBottom: 8 }),

      UIText(
        `Проектов: ${stats.projects} • Сессий: ${stats.sessions} • Сообщений: ${stats.totalMessages}`
      ).style({
        color: () => THEME.textSecondary,
        fontSize: 12,
        fontWeight: "600",
        marginBottom: 4,
      }),
      UIText(() => statusMsgSignal.value).style({
        color: () => THEME.accentCyan,
        fontSize: 11,
        marginBottom: 10,
      }),

      UIRow(
        SecondaryButton("Копировать JSON", exportToClipboard, "lucide:copy"),
        SecondaryButton("Сохранить файл", exportToFile, "lucide:download")
      ).style({ gap: 8, width: "100%", marginBottom: 12 }),

      UIText("Восстановление из резервной копии:").style({
        color: () => THEME.textPrimary,
        fontSize: 12,
        fontWeight: "bold",
        marginBottom: 6,
      }),
      importArea,

      UIRow(
        SecondaryButton("Вставить из буфера", async () => {
          try {
            const clip = await clipboard.read();
            if (clip) {
              importArea.value = clip;
              importTextSignal.value = clip;
              toast("Текст вставлен из буфера");
            }
          } catch {
            toast("Буфер обмена недоступен");
          }
        }, "lucide:file-text"),
        UISpacer(),
        PrimaryButton("Восстановить БД", () => {
          const text = (importArea.value || importTextSignal.value || "").trim();
          doRestore(text);
        })
      ).style({ alignItems: "center", width: "100%", marginTop: 10 })
    ).style({
      backgroundColor: () => THEME.bgSurface,
      borderRadius: 18,
      padding: 16,
      borderWidth: 1,
      borderColor: () => THEME.borderStrong,
      width: "94%",
    })
  ).transition({ opacity: 0, transform: "scale(0.95)", duration: 180 });
  modal.show();
}

// =========================================================================
// ГЕНЕРАЦИЯ ГРАФИЧЕСКОГО ЗАКАЗ-НАРЯДА НА CANVAS + SHARE(PNG)
// =========================================================================

export async function openWorkOrderShareModal(msg: ChatMessageItem): Promise<void> {
  try {
    const cv = new Canvas(720, 960, { pixelRatio: 2 });
    cv.fillStyle = "#090d16";
    cv.fillRect(0, 0, 720, 960);

    // Header gradient bar
    const grad = cv.createLinearGradient(0, 0, 720, 110);
    grad.addColorStop(0, "#ea580c");
    grad.addColorStop(1, "#0284c7");
    cv.fillStyle = grad;
    cv.fillRect(0, 0, 720, 110);

    cv.fillStyle = "#ffffff";
    cv.font = "bold 28px sans-serif";
    cv.fillText("ИИДЕАЛ АВТО • КАРТА ДИАГНОСТИКИ", 30, 48);
    cv.font = "16px sans-serif";
    cv.fillText(
      `Дата: 2026-11-28 ${msg.timestamp || ""}  |  Автономная СТО-система (GPL-3.0)`,
      30,
      82
    );

    // Vehicle card
    cv.fillStyle = "#111827";
    cv.beginPath();
    cv.roundRect(28, 132, 664, 78, 14);
    cv.fill();
    cv.strokeStyle = "#334155";
    cv.lineWidth = 2;
    cv.stroke();

    cv.fillStyle = "#94a3b8";
    cv.font = "bold 14px sans-serif";
    cv.fillText("АВТОМОБИЛЬ И ДВИГАТЕЛЬ", 46, 158);
    cv.fillStyle = "#f8fafc";
    cv.font = "bold 20px sans-serif";
    cv.fillText(
      (msg.vehicle || appState.vehicleSignal.value || "Профиль OBD-II / Универсальный ЭБУ").slice(0, 52),
      46,
      190
    );

    // DTC section
    let y = 236;
    const codes = msg.dtcCodes && msg.dtcCodes.length > 0 ? msg.dtcCodes : ["CHECK"];
    cv.fillStyle = "#38bdf8";
    cv.font = "bold 16px sans-serif";
    cv.fillText(`КОДЫ НЕИСПРАВНОСТИ (${codes.join(", ")})`, 30, y);
    y += 18;

    const faults = (msg.faults || []).slice(0, 3);
    if (faults.length > 0) {
      for (const f of faults) {
        cv.fillStyle = "#1e293b";
        cv.beginPath();
        cv.roundRect(28, y, 664, 68, 10);
        cv.fill();
        cv.fillStyle = f.severity === "critical" ? "#ef4444" : "#f59e0b";
        cv.font = "bold 17px sans-serif";
        cv.fillText(`${f.code}  •  ${(f.title || f.system_ru).slice(0, 48)}`, 44, y + 28);
        cv.fillStyle = "#cbd5e1";
        cv.font = "14px sans-serif";
        cv.fillText(`Вероятность: ${Math.round((f.confidence || 0.75) * 100)}%  |  Причина: ${(f.root_cause || "").slice(0, 52)}`, 44, y + 52);
        y += 80;
      }
    } else {
      y += 24;
    }

    // Checklist section
    y += 12;
    cv.fillStyle = "#10b981";
    cv.font = "bold 16px sans-serif";
    cv.fillText("РЕГЛАМЕНТ ПРОВЕРОК И РЕМОНТА", 30, y);
    y += 18;

    const tasks = (msg.tasks || []).slice(0, 7);
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      const mark = t.done ? "[V]" : "[ ]";
      cv.fillStyle = t.done ? "#10b981" : "#f8fafc";
      cv.font = "15px sans-serif";
      const line = `${mark} ${i + 1}. ${(t.instruction || t.text || t.title).slice(0, 64)}`;
      cv.fillText(line, 34, y + 20);
      y += 34;
      if (y > 860) break;
    }

    // Footer
    cv.fillStyle = "#111827";
    cv.fillRect(0, 895, 720, 65);
    cv.fillStyle = "#94a3b8";
    cv.font = "14px sans-serif";
    cv.fillText("Сформировано локально на устройстве • ИИдеал Авто • База 12 141 код DTC", 30, 932);

    const pngFile = await cv.toFile("aideal_work_order.png", "image/png");
    let modal: any = null;
    modal = UIModal(
      UIColumn(
        UIRow(
          LucideIcon("lucide:share-2", 18, () => THEME.accentOrange),
          UIText("Заказ-наряд (PNG)").style({
            color: () => THEME.textPrimary,
            fontSize: 15,
            fontWeight: "bold",
            flex: 1,
          }),
          UIButton(LucideIcon("lucide:x", 18, () => THEME.textMuted))
            .style({ padding: 4 })
            .onClick(() => modal.hide())
        ).style({ alignItems: "center", gap: 8, width: "100%", marginBottom: 8 }),
        UIImage(pngFile).style({
          width: "100%",
          height: 360,
          objectFit: "contain",
          borderRadius: 10,
          backgroundColor: "#020617",
          marginBottom: 10,
        }),
        UIRow(
          SecondaryButton("Закрыть", () => modal.hide()),
          UISpacer(),
          PrimaryButton("Поделиться PNG", () => {
            share(pngFile, "Заказ-наряд автодиагностики — ИИдеал Авто");
            toast("Открыто меню отправки отчета");
          })
        ).style({ width: "100%", alignItems: "center" })
      ).style({
        backgroundColor: () => THEME.bgSurface,
        borderRadius: 16,
        padding: 14,
        borderWidth: 1,
        borderColor: () => THEME.borderStrong,
        width: "92%",
      })
    );
    modal.show();
  } catch (err) {
    toast(`Ошибка генерации бланка: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// =========================================================================
// МОДАЛЬНЫЕ ОКНА ПРОСМОТРА ИЗОБРАЖЕНИЙ / ДОКУМЕНТОВ / ВВОДА ТЕКСТА
// =========================================================================

export function openImageLightboxModal(src: any, title: string = "Снимок узла"): void {
  let modal: any = null;
  modal = UIModal(
    UIColumn(
      UIRow(
        UIText(title).style({
          color: "#ffffff",
          fontSize: 14,
          fontWeight: "bold",
          flex: 1,
          lineClamp: 1,
        }),
        UIButton(LucideIcon("lucide:x", 20, "#ffffff"))
          .style({ padding: 4 })
          .onClick(() => modal.hide())
      ).style({ alignItems: "center", width: "100%", marginBottom: 10 }),
      UIImage(src).style({
        width: "100%",
        height: 340,
        objectFit: "contain",
        borderRadius: 12,
        backgroundColor: "#000000",
      })
    ).style({
      backgroundColor: "#0b1120",
      borderRadius: 18,
      padding: 14,
      borderWidth: 1,
      borderColor: "#334155",
      width: "92%",
    })
  ).transition({ opacity: 0, transform: "scale(0.92)", duration: 180 });
  modal.show();
}

export function openDocumentPreviewModal(doc: {
  filename?: string;
  processing_mode?: string;
  detected_dtc_codes?: string[];
  llm_ready_text?: string;
  preview_excerpt?: string;
}): void {
  let modal: any = null;
  const fullText = (doc.llm_ready_text || doc.preview_excerpt || "Текст документа пуст.").trim();
  const dtcs = doc.detected_dtc_codes || [];

  modal = UIModal(
    UIColumn(
      UIRow(
        LucideIcon("lucide:file-text", 18, () => THEME.accentCyan),
        UIText(doc.filename || "Документ").style({
          color: () => THEME.textPrimary,
          fontSize: 15,
          fontWeight: "bold",
          flex: 1,
          lineClamp: 1,
        }),
        UIButton(LucideIcon("lucide:x", 18, () => THEME.textMuted))
          .style({ padding: 4 })
          .onClick(() => modal.hide())
      ).style({ alignItems: "center", gap: 8, width: "100%", marginBottom: 8 }),

      ...(dtcs.length > 0
        ? [
            UIRow(
              UIText("DTC:").style({ color: () => THEME.textMuted, fontSize: 11, fontWeight: "bold" }),
              ...dtcs.slice(0, 6).map((c) => DtcChip(c))
            ).style({ flexWrap: "wrap", gap: 6, marginBottom: 8, width: "100%" }),
          ]
        : []),

      UIScrollable(
        UIText(fullText).style({
          color: () => THEME.textSecondary,
          fontSize: 12,
          lineHeight: 18,
        })
      ).style({
        width: "100%",
        height: 260,
        backgroundColor: () => THEME.bgInput,
        borderWidth: 1,
        borderColor: () => THEME.borderDefault,
        borderRadius: 10,
        padding: 10,
        marginBottom: 12,
      }),

      UIRow(
        SecondaryButton("Копировать", async () => {
          try {
            await clipboard.write(fullText);
            toast("Текст скопирован");
          } catch {
            toast("Не удалось скопировать");
          }
        }, "lucide:copy"),
        UISpacer(),
        PrimaryButton("Закрыть", () => modal.hide())
      ).style({ alignItems: "center", width: "100%" })
    ).style({
      backgroundColor: () => THEME.bgSurface,
      borderRadius: 18,
      padding: 16,
      borderWidth: 1,
      borderColor: () => THEME.borderStrong,
      width: "92%",
    })
  );
  modal.show();
}

export function openTextPromptModal(options: {
  title: string;
  subtitle?: string;
  placeholder?: string;
  initialValue?: string;
  confirmLabel?: string;
  quickChips?: string[];
  multiline?: boolean;
  onConfirm: (value: string) => void | Promise<void>;
}): void {
  const valSignal = signal(options.initialValue || "");
  let modal: any = null;

  const input = (options.multiline ? UITextArea() : UIInput())
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
      ...(options.multiline ? { height: 130 } : {}),
      marginBottom: 10,
    })
    .onChange((v: string) => {
      valSignal.value = v;
    });
  if (options.initialValue) input.value = options.initialValue;

  const chipsRow =
    options.quickChips && options.quickChips.length > 0
      ? UIRow(
          ...options.quickChips.map((chip) =>
            UIButton(
              UIText(chip).style({
                color: () => THEME.accentCyan,
                fontSize: 11,
                fontWeight: "600",
              })
            )
              .style({
                backgroundColor: () => THEME.bgElevated,
                borderWidth: 1,
                borderColor: () => THEME.borderDefault,
                borderRadius: 8,
                paddingHorizontal: 9,
                paddingVertical: 5,
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
          flex: 1,
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
              marginBottom: 10,
            }),
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
      padding: 16,
      borderWidth: 1,
      borderColor: () => THEME.borderStrong,
      width: "92%",
    })
  );
  modal.show();
}

export function openConfirmModal(options: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
}): void {
  let modal: any = null;
  modal = UIModal(
    UIColumn(
      UIText(options.title).style({
        color: () => THEME.textPrimary,
        fontSize: 15,
        fontWeight: "bold",
        marginBottom: 8,
      }),
      UIText(options.message).style({
        color: () => THEME.textSecondary,
        fontSize: 13,
        lineHeight: 19,
        marginBottom: 14,
      }),
      UIRow(
        SecondaryButton("Отмена", () => modal.hide()),
        UISpacer(),
        UIButton(
          UIText(options.confirmLabel || "Подтвердить").style({
            color: "#ffffff",
            fontSize: 12,
            fontWeight: "bold",
          })
        )
          .style({
            backgroundColor: options.danger ? THEME.statusCrit : THEME.accentOrange,
            paddingHorizontal: 14,
            paddingVertical: 10,
            borderRadius: 10,
          })
          .onClick(async () => {
            modal.hide();
            await options.onConfirm();
          })
      ).style({ width: "100%", alignItems: "center" })
    ).style({
      backgroundColor: () => THEME.bgSurface,
      borderRadius: 16,
      padding: 16,
      borderWidth: 1,
      borderColor: () => THEME.borderStrong,
      width: "90%",
    })
  );
  modal.show();
}

export function openVehicleModal(vehicleSignal: any, onSaved?: (val: string) => void): void {
  openTextPromptModal({
    title: "Автомобиль для диагностики",
    subtitle: "Марка, модель, двигатель и год (для точного подбора норм в RAG и ИИ)",
    placeholder: "Например: Lada Vesta 1.6 16V (2021)",
    initialValue: vehicleSignal?.value || "",
    confirmLabel: "Применить",
    quickChips: [
      "Lada Vesta 1.6 16V",
      "Hyundai Solaris 1.6 G4FG",
      "VW Polo 1.6 CWVA",
      "KIA Rio 1.6 G4FC",
      "Geely Coolray 1.5T",
      "Haval Jolion 1.5T",
    ],
    onConfirm: (val) => {
      updateVehicleInfo(val);
      onSaved?.(val);
      toast(val ? `Авто: ${val}` : "Профиль авто сброшен");
    },
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
    LucideIcon("lucide:car", 15, () => THEME.accentOrange),
    UIText("Авто:").style({
      color: () => THEME.textMuted,
      fontSize: 12,
      fontWeight: "600",
    }),
    UIText(() => (vehicleSignal.value ? vehicleSignal.value : "Не указан (универсальный профиль)")).style({
      color: () => THEME.textPrimary,
      fontSize: 12,
      fontWeight: "bold",
      flex: 1,
      lineClamp: 1,
    }),
    UIButton(
      UIRow(
        LucideIcon("lucide:pencil", 12, () => THEME.accentCyan),
        UIText("Изм.").style({
          color: () => THEME.accentCyan,
          fontSize: 11,
          fontWeight: "bold",
        })
      ).style({ alignItems: "center", gap: 4 })
    )
      .style({
        backgroundColor: () => THEME.bgElevated,
        borderWidth: 1,
        borderColor: () => THEME.borderDefault,
        paddingHorizontal: 9,
        paddingVertical: 5,
        borderRadius: 7,
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
    gap: 6,
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
    return items.map((item) => {
      const thumbNode =
        item.type === "photo" && item.file
          ? UIImage(item.file).style({
              width: 22,
              height: 22,
              borderRadius: 5,
              objectFit: "cover",
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
                lineClamp: 1,
                maxWidth: 165,
              }),
              ...(item.meta
                ? [
                    UIText(item.meta).style({
                      color: () => THEME.textMuted,
                      fontSize: 9,
                      lineClamp: 1,
                      maxWidth: 165,
                    }),
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
        gap: 4,
      });
    });
  };

  return UIBox(
    UIScrollable(
      UIRow(() => buildChips()).style({
        alignItems: "center",
        gap: 7,
        paddingHorizontal: 10,
        paddingVertical: 6,
      })
    ).style({
      scrollDirection: "horizontal",
      showScrollbar: false,
      width: "100%",
      height: 48,
    })
  ).style({
    width: "100%",
    height: 49,
    backgroundColor: () => THEME.bgSurface,
    borderTopWidth: 1,
    borderTopColor: () => THEME.borderDefault,
    display: () => ((stagedItemsSignal.value || []).length > 0 ? "flex" : "none"),
  });
}

// =========================================================================
// КАРТОЧКА СООБЩЕНИЯ И ИНДИКАТОР ГЕНЕРАЦИИ
// =========================================================================

export interface MessageCardCallbacks {
  onToggleTask?: (
    msgId: string,
    itemType: "step" | "inventory",
    checkId: string | number,
    done: boolean
  ) => void;
  onFollowupClick?: (promptText: string) => void;
  onDeleteMessage?: (msgId: string) => void;
  onOpenAr?: () => void;
  onOpen3d?: () => void;
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
  const tasksDoneMap = signal<Record<string, boolean>>({});
  const invDoneMap = signal<Record<string, boolean>>({});

  if (msg.tasks) {
    const initTasks: Record<string, boolean> = {};
    msg.tasks.forEach((t, idx) => {
      initTasks[String(t.id ?? t.step_number ?? idx + 1)] = Boolean(t.done);
    });
    tasksDoneMap.value = initTasks;
  }
  if (msg.inventoryItems) {
    const initInv: Record<string, boolean> = {};
    msg.inventoryItems.forEach((it, idx) => {
      initInv[String(it.id || it.name || idx)] = Boolean(it.checked);
    });
    invDoneMap.value = initInv;
  }

  const cardChildren: any[] = [];

  const engineBadge =
    msg.engineSource === "lecodes_ai"
      ? "LeCodes AI"
      : msg.engineSource === "byok_custom"
      ? "BYOK AI"
      : msg.engineSource === "local_rag"
      ? "Локальный RAG"
      : "";

  const headerControls: any[] = [
    UIText(isUser ? "ЗАПРОС МАСТЕРА" : "ИИДЕАЛ АВТО • ЭКСПЕРТ").style({
      color: () => (isUser ? THEME.accentCyan : THEME.accentOrange),
      fontSize: 10,
      fontWeight: "bold",
      flex: 1,
    }),
  ];

  if (!isUser && engineBadge) {
    headerControls.push(
      UIBox(
        UIText(engineBadge).style({
          color: () => (msg.engineSource === "lecodes_ai" ? THEME.statusOk : THEME.accentCyan),
          fontSize: 9,
          fontWeight: "bold",
        })
      ).style({
        backgroundColor: "rgba(56, 189, 248, 0.12)",
        borderWidth: 1,
        borderColor: () => (msg.engineSource === "lecodes_ai" ? THEME.statusOk : THEME.accentCyan),
        borderRadius: 6,
        paddingHorizontal: 6,
        paddingVertical: 2,
      })
    );
  }

  headerControls.push(
    UIText(msg.timestamp || "").style({
      color: () => THEME.textMuted,
      fontSize: 10,
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
      marginBottom: 6,
    })
  );

  if (msg.summaryTitle) {
    cardChildren.push(
      UIText(cleanMarkdownForNative(msg.summaryTitle)).style({
        color: () => THEME.textPrimary,
        fontSize: 15,
        fontWeight: "bold",
        lineHeight: 20,
        marginBottom: 6,
      })
    );
  }

  if (msg.content) {
    cardChildren.push(
      UIText(cleanMarkdownForNative(msg.content)).style({
        color: () => (isUser ? THEME.textPrimary : THEME.textSecondary),
        fontSize: 13,
        lineHeight: 19,
        marginBottom: 8,
      })
    );
  }

  if (msg.attachments && msg.attachments.length > 0) {
    const attNodes = msg.attachments.map((att) => {
      if (att.type === "photo" && att.file) {
        return UIButton(
          UIImage(att.file).style({
            width: 84,
            height: 62,
            borderRadius: 8,
            objectFit: "cover",
          })
        )
          .style({ borderRadius: 8, overflow: "hidden" })
          .onClick(() => openImageLightboxModal(att.file, att.label));
      }
      return UIButton(
        UIRow(
          LucideIcon(
            att.type === "audio" ? "lucide:mic" : att.type === "obd" ? "lucide:gauge" : "lucide:file-text",
            12,
            () => THEME.accentCyan
          ),
          UIText(att.label).style({
            color: () => THEME.textPrimary,
            fontSize: 10,
            fontWeight: "600",
          })
        ).style({ alignItems: "center", gap: 4 })
      )
        .style({
          backgroundColor: () => THEME.bgElevated,
          borderWidth: 1,
          borderColor: () => THEME.borderDefault,
          borderRadius: 8,
          paddingHorizontal: 8,
          paddingVertical: 4,
        })
        .onClick(() => {
          if (att.parsedDoc) openDocumentPreviewModal(att.parsedDoc);
        });
    });

    cardChildren.push(
      UIRow(...attNodes).style({ flexWrap: "wrap", gap: 6, marginBottom: 8, width: "100%" })
    );
  }

  if (msg.faults && msg.faults.length > 0) {
    const faultCards = msg.faults.map((fault) => {
      const h = Math.max(0, Math.min(100, Number(fault.health_index ?? 50)));
      const hColor = h >= 70 ? THEME.statusOk : h >= 40 ? THEME.statusWarn : THEME.statusCrit;
      const barVariant: GradientBarVariant = h >= 70 ? "ok" : h >= 40 ? "warn" : "crit";
      return UIColumn(
        UIRow(
          DtcChip(fault.code || "CHECK", () => callbacks?.onStageDtc?.(fault.code)),
          UIText(fault.title || fault.system_ru || "Узел системы").style({
            color: () => THEME.textPrimary,
            fontSize: 12,
            fontWeight: "bold",
            flex: 1,
          }),
          UIText(`${h}%`).style({
            color: hColor,
            fontSize: 11,
            fontWeight: "bold",
          })
        ).style({ alignItems: "center", gap: 6, width: "100%", marginBottom: 4 }),
        UIBox(...(h > 0 ? [GradientBarFill(barVariant, `${h}%`, 6)] : [])).style({
          width: "100%",
          height: 6,
          borderRadius: 3,
          backgroundColor: () => THEME.bgElevated,
          overflow: "hidden",
          marginBottom: 6,
        }),
        ...(fault.description
          ? [
              UIText(fault.description).style({
                color: () => THEME.textSecondary,
                fontSize: 11,
                lineHeight: 16,
              }),
            ]
          : []),
        ...(fault.root_cause
          ? [
              UIText(`Причина: ${fault.root_cause}`).style({
                color: () => THEME.textMuted,
                fontSize: 11,
                lineHeight: 15,
                marginTop: 2,
              }),
            ]
          : [])
      ).style({
        backgroundColor: () => THEME.bgInput,
        borderWidth: 1,
        borderColor: () => THEME.borderDefault,
        borderRadius: 10,
        padding: 9,
        width: "100%",
      });
    });

    cardChildren.push(
      UIColumn(
        UIRow(
          LucideIcon("lucide:shield-alert", 14, () => THEME.statusCrit),
          UIText("Выявленные неисправности").style({
            color: () => THEME.textPrimary,
            fontSize: 12,
            fontWeight: "bold",
          })
        ).style({ alignItems: "center", gap: 6, marginBottom: 4 }),
        ...faultCards
      ).style({ gap: 6, width: "100%", marginBottom: 10 })
    );
  }

  if (msg.tasks && msg.tasks.length > 0) {
    const stepRows = msg.tasks.map((task, idx) => {
      const checkId = task.id ?? task.step_number ?? idx + 1;
      const mapKey = String(checkId);
      const isDone = () => Boolean(tasksDoneMap.value[mapKey]);
      const stepLabel =
        task.instruction || task.text || task.title || `Шаг ${idx + 1}`;

      return UIButton(
        UIRow(
          UIBox(
            LucideIcon("lucide:check", 12, "#ffffff").style({
              display: () => (isDone() ? "flex" : "none"),
            })
          ).style({
            width: 18,
            height: 18,
            borderRadius: 5,
            borderWidth: 1.5,
            borderColor: () => (isDone() ? THEME.statusOk : THEME.borderStrong),
            backgroundColor: () => (isDone() ? THEME.statusOk : "transparent"),
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            marginTop: 2,
          }),
          UIColumn(
            UIText(`${idx + 1}. ${stepLabel}`).style({
              color: () => (isDone() ? THEME.textMuted : THEME.textPrimary),
              fontSize: 12,
              lineHeight: 17,
            }),
            ...(task.safety_warning
              ? [
                  UIText(`Опасно: ${task.safety_warning}`).style({
                    color: () => THEME.statusCrit,
                    fontSize: 11,
                    fontWeight: "600",
                    marginTop: 2,
                  }),
                ]
              : [])
          ).style({ flex: 1 })
        ).style({ alignItems: "flex-start", gap: 8, width: "100%" })
      )
        .style({
          backgroundColor: () => THEME.bgInput,
          borderWidth: 1,
          borderColor: () => THEME.borderDefault,
          borderRadius: 9,
          padding: 8,
          width: "100%",
        })
        .onClick(() => {
          const nextVal = !Boolean(tasksDoneMap.value[mapKey]);
          tasksDoneMap.value = { ...tasksDoneMap.value, [mapKey]: nextVal };
          callbacks?.onToggleTask?.(msg.id, "step", checkId, nextVal);
        });
    });

    cardChildren.push(
      UIColumn(
        UIRow(
          LucideIcon("lucide:wrench", 13, () => THEME.accentCyan),
          UIText(`Чеклист ремонта (${msg.tasks.length} шагов)`).style({
            color: () => THEME.textPrimary,
            fontSize: 12,
            fontWeight: "bold",
          })
        ).style({ alignItems: "center", gap: 6, marginBottom: 4 }),
        ...stepRows
      ).style({ gap: 5, width: "100%", marginBottom: 10 })
    );
  }

  if (!isUser && !isWelcome && msg.followupSuggestions && msg.followupSuggestions.length > 0) {
    cardChildren.push(
      UIRow(
        ...msg.followupSuggestions.slice(0, 3).map((q) =>
          UIButton(
            UIText(q).style({
              color: () => THEME.accentCyan,
              fontSize: 11,
              fontWeight: "600",
            })
          )
            .style({
              backgroundColor: () => THEME.bgElevated,
              borderWidth: 1,
              borderColor: () => THEME.borderDefault,
              borderRadius: 8,
              paddingHorizontal: 9,
              paddingVertical: 5,
            })
            .onClick(() => callbacks?.onFollowupClick?.(q))
        )
      ).style({ flexWrap: "wrap", gap: 6, marginBottom: 8, width: "100%" })
    );
  }

  if (!isUser && !isWelcome) {
    const buildPlainReport = () => {
      const parts: string[] = [];
      if (msg.summaryTitle) parts.push(msg.summaryTitle);
      if (msg.content) parts.push(cleanMarkdownForNative(msg.content));
      if (msg.tasks && msg.tasks.length > 0) {
        parts.push(
          "ЧЕКЛИСТ:\n" +
            msg.tasks
              .map((t, i) => `${t.done ? "[v]" : "[ ]"} ${i + 1}. ${t.instruction || t.text || t.title}`)
              .join("\n")
        );
      }
      return parts.join("\n\n");
    };

    cardChildren.push(
      UIRow(
        UIButton(
          UIRow(
            LucideIcon("lucide:copy", 12, () => THEME.textSecondary),
            UIText("Копия").style({ color: () => THEME.textSecondary, fontSize: 11, fontWeight: "600" })
          ).style({ alignItems: "center", gap: 4 })
        )
          .style({
            backgroundColor: () => THEME.bgElevated,
            borderWidth: 1,
            borderColor: () => THEME.borderDefault,
            borderRadius: 7,
            paddingHorizontal: 8,
            paddingVertical: 5,
          })
          .onClick(async () => {
            try {
              await clipboard.write(buildPlainReport());
              toast("Вердикт скопирован");
            } catch {
              toast("Не удалось скопировать");
            }
          }),
        UIButton(
          UIRow(
            LucideIcon("lucide:share-2", 12, () => THEME.statusOk),
            UIText("Бланк PNG").style({ color: () => THEME.statusOk, fontSize: 11, fontWeight: "600" })
          ).style({ alignItems: "center", gap: 4 })
        )
          .style({
            backgroundColor: () => THEME.bgElevated,
            borderWidth: 1,
            borderColor: () => THEME.statusOk,
            borderRadius: 7,
            paddingHorizontal: 8,
            paddingVertical: 5,
          })
          .onClick(() => void openWorkOrderShareModal(msg)),
        ...(callbacks?.onOpen3d
          ? [
              UIButton(
                UIRow(
                  LucideIcon("lucide:box", 12, () => THEME.accentCyan),
                  UIText("3D Узел").style({ color: () => THEME.accentCyan, fontSize: 11, fontWeight: "600" })
                ).style({ alignItems: "center", gap: 4 })
              )
                .style({
                  backgroundColor: () => THEME.bgElevated,
                  borderWidth: 1,
                  borderColor: () => THEME.borderDefault,
                  borderRadius: 7,
                  paddingHorizontal: 8,
                  paddingVertical: 5,
                })
                .onClick(() => callbacks.onOpen3d?.()),
            ]
          : []),
        ...(callbacks?.onOpenAr
          ? [
              UIButton(
                UIRow(
                  LucideIcon("lucide:glasses", 12, () => THEME.accentOrange),
                  UIText("AR HUD").style({ color: () => THEME.accentOrange, fontSize: 11, fontWeight: "600" })
                ).style({ alignItems: "center", gap: 4 })
              )
                .style({
                  backgroundColor: () => THEME.bgElevated,
                  borderWidth: 1,
                  borderColor: () => THEME.borderDefault,
                  borderRadius: 7,
                  paddingHorizontal: 8,
                  paddingVertical: 5,
                })
                .onClick(() => callbacks.onOpenAr?.()),
            ]
          : [])
      ).style({ flexWrap: "wrap", alignItems: "center", gap: 6, width: "100%", marginTop: 2 })
    );
  }

  return UIColumn(...cardChildren).style({
    width: "100%",
    backgroundColor: () => (isUser ? THEME.bubbleUserBg : THEME.bubbleAiBg),
    borderWidth: 1,
    borderColor: () => (isUser ? THEME.bubbleUserBorder : THEME.borderDefault),
    borderLeftWidth: isUser ? 1 : 3,
    borderLeftColor: () => (isUser ? THEME.bubbleUserBorder : THEME.accentOrange),
    borderRadius: 14,
    padding: 13,
  });
}

export interface PendingCardHandle {
  node: any;
  setStage: (stageText: string) => void;
  stop: () => void;
}

export function PendingGenerationCard(): PendingCardHandle {
  const stageSignal = signal("Поиск по локальному индексу 12 141 DTC...");
  const elapsedMsSignal = signal(0);
  const pulseTickSignal = signal(0);
  const startedAt = Date.now();

  const timer = setInterval(() => {
    const ms = Date.now() - startedAt;
    elapsedMsSignal.value = ms;
    pulseTickSignal.value = (pulseTickSignal.value + 1) % 3;
    if (ms > 5500) {
      stageSignal.value = "Формирование пошагового чеклиста ремонта...";
    } else if (ms > 2000) {
      stageSignal.value = "LeCodes AI + телеметрия ЭБУ: синтез причин...";
    }
  }, 350);

  const node = UIColumn(
    UIRow(
      LucideIcon("lucide:bot", 18, () => THEME.accentOrange),
      UIText("ИИдеал Авто анализирует...").style({
        color: () => THEME.textPrimary,
        fontSize: 13,
        fontWeight: "bold",
        flex: 1,
      }),
      UIText(() => `${(elapsedMsSignal.value / 1000).toFixed(1)}с`).style({
        color: () => THEME.accentCyan,
        fontSize: 11,
        fontWeight: "bold",
      })
    ).style({ alignItems: "center", gap: 8, width: "100%", marginBottom: 6 }),
    UIText(() => stageSignal.value).style({
      color: () => THEME.textSecondary,
      fontSize: 12,
      marginBottom: 8,
    }),
    UIBox(
      GradientBarFill("pending", () => `${32 + (pulseTickSignal.value + 1) * 22}%`, 5)
    ).style({
      width: "100%",
      height: 5,
      borderRadius: 3,
      backgroundColor: () => THEME.bgElevated,
      overflow: "hidden",
    })
  ).style({
    width: "100%",
    backgroundColor: () => THEME.bgSurface,
    borderWidth: 1,
    borderColor: () => THEME.accentOrange,
    borderRadius: 14,
    padding: 13,
  });

  return {
    node,
    setStage: (t: string) => {
      stageSignal.value = t;
    },
    stop: () => {
      clearInterval(timer);
    },
  };
}

// =========================================================================
// ОВЕРЛЕЙ AR HUD (ЖИВАЯ КАМЕРА + ФОНАРИК TORCH + 3DoF ДАТЧИКИ + ДИАГНОСТИКА)
// =========================================================================

export function createArHudOverlay(options: {
  onClose?: () => void;
  onOpen3d?: () => void;
  startMode?: "optical" | "vr";
}): void {
  const arModeSignal = signal<"optical" | "vr">(options.startMode || "optical");
  const cameraFacingSignal = signal<"back" | "front">("back");
  const torchOnSignal = signal<boolean>(false);
  const arStatusSignal = signal<string>("AR-визир готов");
  const arAttitudeSignal = signal<string>("3DoF: ожидание");
  const isListeningSignal = signal<boolean>(false);

  let activeCamNode: any = null;
  let activeSpeech: any = null;
  let motionStarted = false;
  let modal: any = null;

  const camHostContainer = UIBox().style({
    width: "100%",
    height: 230,
    borderRadius: 14,
    backgroundColor: "#020617",
    borderWidth: 1,
    borderColor: () => THEME.borderStrong,
    overflow: "hidden",
    position: "relative",
    alignItems: "center",
    justifyContent: "center",
  });

  const mountCamera = () => {
    activeCamNode = null;
    if (UICameraNode.supported) {
      const cam = UICameraNode({ facingMode: cameraFacingSignal.value }).style({
        width: "100%",
        height: "100%",
      });
      cam.onError((err) => {
        arStatusSignal.value = `Камера: ${err?.message || "отказ"}`;
      });
      activeCamNode = cam;
      camHostContainer.setContent([cam]);
    } else {
      camHostContainer.setContent([
        UIColumn(
          LucideIcon("lucide:camera", 34, () => THEME.accentCyan),
          UIText("Поток камеры доступен на мобильном устройстве (Android/iOS)").style({
            color: "#94a3b8",
            fontSize: 12,
            textAlign: "center",
          }),
          UIText("В веб-превью можно загрузить фото узла из галереи").style({
            color: "#64748b",
            fontSize: 11,
            textAlign: "center",
          })
        ).style({ alignItems: "center", gap: 8, padding: 18 }),
      ]);
    }
  };

  if (device.motion.available) {
    try {
      device.motion.start();
      motionStarted = true;
    } catch (_) {}
  }

  const telemetryTimer = setInterval(() => {
    if (device.motion.available && motionStarted) {
      try {
        const att = device.motion.attitude;
        if (att) {
          const pitch = Math.round(Math.asin(Math.max(-1, Math.min(1, 2 * ((att.w ?? 1) * att.y - att.z * att.x)))) * 57.3);
          const yaw = Math.round(Math.atan2(2 * ((att.w ?? 1) * att.z + att.x * att.y), 1 - 2 * (att.y * att.y + att.z * att.z)) * 57.3);
          arAttitudeSignal.value = `3DoF Y${yaw}° P${pitch}°`;
        }
      } catch (_) {}
    }
  }, 300);

  const cleanup = () => {
    clearInterval(telemetryTimer);
    if (motionStarted) {
      try { device.motion.stop(); } catch (_) {}
      motionStarted = false;
    }
    if (activeSpeech) {
      try { activeSpeech.abort(); } catch (_) {}
      activeSpeech = null;
    }
    if (torchOnSignal.value && Torch.supported) {
      void Torch.set(false).catch(() => {});
      torchOnSignal.value = false;
    }
    try { app.setOrientation("auto"); } catch (_) {}
    options.onClose?.();
  };

  mountCamera();

  const toggleTorch = async () => {
    if (!Torch.supported) {
      toast("Фонарик доступен только в мобильном клиенте le.codes");
      return;
    }
    const avail = await Torch.available().catch(() => false);
    if (!avail) {
      toast("На данном устройстве нет вспышки");
      return;
    }
    try {
      const next = await Torch.toggle();
      torchOnSignal.value = next.on;
      arStatusSignal.value = next.on ? "Подсветка моторного отсека ВКЛ" : "Подсветка ВЫКЛ";
    } catch {
      toast("Камера удерживает вспышку или перегрев");
    }
  };

  const captureAndAnalyze = async () => {
    try {
      let file: File | null = null;
      if (activeCamNode) {
        file = await activeCamNode.takePhoto();
      } else {
        const picked = await openFilePicker({ multiple: false, accept: "image/*" });
        file = Array.isArray(picked) ? picked[0] : picked;
      }
      if (!file) return;
      modal.hide();
      cleanup();
      appState.stagedItemsSignal.value = [
        ...appState.stagedItemsSignal.value.filter((i) => i.type !== "photo"),
        {
          id: `ar-shot-${Date.now()}`,
          type: "photo",
          label: file.name || "AR_снимок_узла.jpg",
          meta: "AR HUD Vision",
          file,
        },
      ];
      appState.activeTabSignal.value = 0;
      toast("Снимок с AR HUD прикреплен! Запуск анализа ИИ...");
    } catch (err) {
      toast(`Не удалось снять кадр: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const toggleVoiceCommand = async () => {
    if (!SpeechRecognizer.supported) {
      toast("Голосовой ввод доступен на мобильном устройстве");
      return;
    }
    if (isListeningSignal.value && activeSpeech) {
      activeSpeech.stop();
      isListeningSignal.value = false;
      return;
    }
    try {
      activeSpeech = new SpeechRecognizer();
      isListeningSignal.value = true;
      arStatusSignal.value = "Слушаю голосовую команду...";
      activeSpeech.addEventListener("result", (r: any) => {
        if (r?.isFinal && r.transcript) {
          arStatusSignal.value = `Распознано: ${r.transcript}`;
          toast(`Команда: ${r.transcript}`);
        }
      });
      activeSpeech.addEventListener("end", () => {
        isListeningSignal.value = false;
      });
      await activeSpeech.start({ language: "ru-RU", interimResults: true });
    } catch {
      isListeningSignal.value = false;
      toast("Микрофон недоступен");
    }
  };

  const sensors = () => appState.obdSensorsSignal.value;

  modal = UIModal(
    UIColumn(
      UIRow(
        LucideIcon("lucide:glasses", 18, () => THEME.accentOrange),
        UIText(() => (arModeSignal.value === "vr" ? "VR ДИАГНОСТИКА" : "AR HUD ОСМОТР")).style({
          color: () => THEME.textPrimary,
          fontSize: 14,
          fontWeight: "bold",
          flex: 1,
        }),
        UIText(() => arAttitudeSignal.value).style({
          color: () => THEME.accentCyan,
          fontSize: 10,
          fontWeight: "600",
        }),
        UIButton(LucideIcon("lucide:x", 18, () => THEME.textMuted))
          .style({ padding: 4 })
          .onClick(() => {
            modal.hide();
            cleanup();
          })
      ).style({ alignItems: "center", gap: 6, width: "100%", marginBottom: 8 }),

      camHostContainer,

      // HUD Telemetry Overlay Strip
      UIRow(
        UIColumn(
          UIText("ОБОРОТЫ").style({ color: () => THEME.textMuted, fontSize: 9 }),
          UIText(() => `${sensors().rpm} об/м`).style({
            color: () => THEME.accentCyan,
            fontSize: 13,
            fontWeight: "bold",
          })
        ).style({ flex: 1, alignItems: "center" }),
        UIColumn(
          UIText("ОЖ").style({ color: () => THEME.textMuted, fontSize: 9 }),
          UIText(() => `${sensors().coolantTemp} °C`).style({
            color: () => (sensors().coolantTemp > 103 ? THEME.statusCrit : THEME.statusOk),
            fontSize: 13,
            fontWeight: "bold",
          })
        ).style({ flex: 1, alignItems: "center" }),
        UIColumn(
          UIText("АКБ").style({ color: () => THEME.textMuted, fontSize: 9 }),
          UIText(() => `${sensors().voltage.toFixed(1)} В`).style({
            color: () => (sensors().voltage > 0 && sensors().voltage < 11.8 ? THEME.statusCrit : THEME.textPrimary),
            fontSize: 13,
            fontWeight: "bold",
          })
        ).style({ flex: 1, alignItems: "center" }),
        UIColumn(
          UIText("ОШИБКИ").style({ color: () => THEME.textMuted, fontSize: 9 }),
          UIText(() => (sensors().dtcList.length > 0 ? sensors().dtcList[0] : "OK")).style({
            color: () => (sensors().dtcList.length > 0 ? THEME.statusCrit : THEME.statusOk),
            fontSize: 13,
            fontWeight: "bold",
          })
        ).style({ flex: 1, alignItems: "center" })
      ).style({
        width: "100%",
        backgroundColor: () => THEME.bgInput,
        borderWidth: 1,
        borderColor: () => THEME.borderDefault,
        borderRadius: 10,
        paddingVertical: 8,
        marginTop: 8,
        marginBottom: 8,
      }),

      UIText(() => arStatusSignal.value).style({
        color: () => THEME.textMuted,
        fontSize: 11,
        marginBottom: 8,
      }),

      UIRow(
        SecondaryButton(
          () => (torchOnSignal.value ? "Свет ВКЛ" : "Фонарь"),
          () => void toggleTorch(),
          "lucide:flashlight"
        ),
        SecondaryButton(
          () => (isListeningSignal.value ? "Стоп" : "Голос"),
          () => void toggleVoiceCommand(),
          "lucide:mic"
        ),
        ...(options.onOpen3d
          ? [
              SecondaryButton("3D Узлы", () => {
                modal.hide();
                cleanup();
                options.onOpen3d?.();
              }, "lucide:box"),
            ]
          : []),
        PrimaryButton("Снять в ИИ", () => void captureAndAnalyze())
      ).style({ flexWrap: "wrap", gap: 6, width: "100%", alignItems: "center" })
    ).style({
      backgroundColor: () => THEME.bgSurface,
      borderRadius: 18,
      padding: 14,
      borderWidth: 1,
      borderColor: () => THEME.borderStrong,
      width: "95%",
    })
  );
  modal.show();
}
