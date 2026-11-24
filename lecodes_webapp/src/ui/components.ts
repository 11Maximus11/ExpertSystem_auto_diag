/**
 * Расширенная библиотека нативных UI-компонентов ИИдеал-Авто на базе le.codes SDK.
 * Точное воспроизведение стилистики и возможностей оригинального мобильного сайта:
 * - AppHeader (бургер-меню, логотип, пилл автомобиля, кнопка AR, тема, настройки)
 * - VehicleBar (быстрое редактирование марки/модели/двигателя)
 * - StagingBar (прикрепленные фото, аудиозаписи, DTC коды, снимки OBD-II с удалением [×])
 * - SelectionToolbar (мультивыбор, удаление выбранных, очистка сессии)
 * - MessageCard (структурированные блоки: Markdown, Faults, интерактивный чеклист с прогрессом, инвентарь, followup чипы)
 * - MetricCard, DtcChip, фирменные кнопки
 *
 * Лицензия: GPL-3.0
 */

import { ChatMessageItem, DtcCodeInfo, StagedItem } from "../types";

// Фирменные цвета темы
export const THEME = {
  bgBase: "#090d16",
  bgSurface: "#111827",
  bgElevated: "#1e293b",
  bgGlass: "rgba(17, 24, 39, 0.92)",
  borderSubtle: "rgba(148, 163, 184, 0.16)",
  borderStrong: "rgba(249, 115, 22, 0.45)",
  accentOrange: "#f97316",
  accentOrangeHover: "#ea580c",
  accentCyan: "#38bdf8",
  statusOk: "#22c55e",
  statusWarn: "#f59e0b",
  statusCrit: "#ef4444",
  textPrimary: "#f8fafc",
  textSecondary: "#cbd5e1",
  textMuted: "#94a3b8"
};

/**
 * Вспомогательный хелпер отрисовки нативных векторных SVG-иконок Lucide
 */
export function LucideIcon(name: string, size: number = 18, color: any = THEME.textPrimary): any {
  return UIImage(assetIcon(name)).style({
    width: size,
    height: size,
    tintColor: color
  });
}

// =========================================================================
// 1. Верхняя панель (AppHeader и HeaderBar)
// =========================================================================

export function HeaderBar(title: string, subtitle?: string, rightNode?: any): any {
  return UIColumn(
    UIRow(
      UIColumn(
        UIText(title).style({ color: THEME.textPrimary, fontSize: 15, fontWeight: "bold" }),
        subtitle
          ? UIText(subtitle).style({ color: THEME.textMuted, fontSize: 11, marginTop: 2 })
          : null
      ).style({ flex: 1, minWidth: 100 }),
      rightNode ? UIRow(rightNode).style({ marginLeft: 8, alignItems: "center", flexShrink: 0 }) : null
    ).style({ alignItems: "center", width: "100%" })
  ).style({
    paddingHorizontal: 14,
    paddingTop: 52,
    paddingBottom: 10,
    backgroundColor: THEME.bgSurface,
    borderBottomWidth: 1,
    borderColor: THEME.borderSubtle
  });
}

export function StatusBadge(status: any, label: any): any {
  const getCol = () => {
    const s = typeof status === "function" ? status() : status;
    if (s === "connected") return THEME.statusOk;
    if (s === "connecting") return THEME.statusWarn;
    return THEME.statusCrit;
  };
  const getBg = () => {
    const s = typeof status === "function" ? status() : status;
    if (s === "connected") return "rgba(34, 197, 94, 0.15)";
    if (s === "connecting") return "rgba(245, 158, 11, 0.15)";
    return "rgba(239, 68, 68, 0.15)";
  };

  return UIRow(
    UIRow().style({
      width: 7,
      height: 7,
      borderRadius: 4,
      backgroundColor: getCol,
      marginRight: 6
    }),
    UIText(label).style({ color: getCol, fontSize: 11, fontWeight: "bold" })
  ).style({
    backgroundColor: getBg,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 10,
    alignItems: "center"
  });
}

export interface AppHeaderOptions {
  onToggleSidebar?: () => void;
  onEnterAr?: () => void;
  onOpenSettings?: () => void;
  onOpenAuth?: () => void;
  onEditVehicle?: () => void;
  vehicleSignal?: any;
  userSignal?: any;
}

export function AppHeader(options: AppHeaderOptions): any {
  // Кнопка мобильного меню (бургер)
  const menuBtn = UIButton(
    UIColumn(
      UIRow().style({ width: 18, height: 2, backgroundColor: THEME.textPrimary, borderRadius: 1, marginBottom: 3 }),
      UIRow().style({ width: 14, height: 2, backgroundColor: THEME.accentOrange, borderRadius: 1, marginBottom: 3 }),
      UIRow().style({ width: 18, height: 2, backgroundColor: THEME.textPrimary, borderRadius: 1 })
    )
  )
    .style({
      padding: 6,
      backgroundColor: "transparent",
      marginRight: 8,
      $pressed: { opacity: 0.6 }
    })
    .onClick(() => {
      options.onToggleSidebar?.();
    });

  // Логотип и название бренда
  const brandBlock = UIRow(
    UIRow(
      UIText("ИИ").style({ color: THEME.accentOrange, fontSize: 13, fontWeight: "900" })
    ).style({
      width: 28,
      height: 28,
      borderRadius: 7,
      backgroundColor: "rgba(249, 115, 22, 0.15)",
      borderWidth: 1,
      borderColor: THEME.borderStrong,
      alignItems: "center",
      justifyContent: "center",
      marginRight: 8
    }),
    UIText("ИИДЕАЛ АВТО").style({
      color: THEME.textPrimary,
      fontSize: 14,
      fontWeight: "800",
      letterSpacing: 0.5
    })
  ).style({ alignItems: "center" });

  // Кнопка быстрого вызова AR HUD для очков RayNeo
  const arBtn = UIButton(
    UIRow(
      LucideIcon("lucide:glasses", 14, "#ffffff"),
      UIText("AR").style({ color: "#ffffff", fontSize: 11, fontWeight: "800", marginLeft: 4 })
    ).style({ alignItems: "center" })
  )
    .style({
      background: "linear-gradient(135deg, #f97316, #ea580c)",
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 5,
      marginRight: 6,
      $pressed: { opacity: 0.8 }
    })
    .onClick(() => {
      options.onEnterAr?.();
    });

  // Кнопка профиля/авторизации
  const userBtn = UIButton(
    UIRow(
      LucideIcon("lucide:user", 13, () => (options.userSignal?.value?.is_authenticated ? THEME.accentOrange : THEME.textMuted)),
      UIText(() => (options.userSignal?.value?.is_authenticated ? options.userSignal.value.username : "Вход")).style({
        color: () => (options.userSignal?.value?.is_authenticated ? THEME.textPrimary : THEME.accentOrange),
        fontSize: 11,
        fontWeight: "bold",
        marginLeft: 4
      })
    ).style({ alignItems: "center" })
  )
    .style({
      paddingHorizontal: 7,
      paddingVertical: 5,
      backgroundColor: THEME.bgElevated,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: THEME.borderSubtle,
      marginRight: 6,
      $pressed: { opacity: 0.7 }
    })
    .onClick(() => {
      options.onOpenAuth?.();
    });

  // Кнопка настроек
  const settingsBtn = UIButton(
    LucideIcon("lucide:settings", 15, THEME.textSecondary)
  )
    .style({
      padding: 6,
      backgroundColor: THEME.bgElevated,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: THEME.borderSubtle,
      $pressed: { opacity: 0.7 }
    })
    .onClick(() => {
      options.onOpenSettings?.();
    });

  return UIRow(
    UIRow(menuBtn, brandBlock).style({ alignItems: "center", flex: 1 }),
    UIRow(arBtn, userBtn, settingsBtn).style({ alignItems: "center" })
  ).style({
    minHeight: 56,
    paddingTop: 52,
    paddingBottom: 10,
    paddingHorizontal: 14,
    backgroundColor: THEME.bgSurface,
    borderBottomWidth: 1,
    borderColor: THEME.borderSubtle,
    alignItems: "center",
    width: "100%"
  });
}

// =========================================================================
// 2. Полоса автомобиля (VehicleBar)
// =========================================================================

export function VehicleBar(vehicleSignal: any, onEdit?: () => void): any {
  return UIRow(
    UIRow(
      UIText("АВТОМОБИЛЬ:").style({
        color: THEME.accentOrange,
        fontSize: 10,
        fontWeight: "bold",
        letterSpacing: 0.5,
        marginRight: 6
      }),
      UIText(() => vehicleSignal.value || "Укажите марку, модель, двигатель...").style({
        color: () => (vehicleSignal.value ? THEME.textPrimary : THEME.textMuted),
        fontSize: 12,
        fontWeight: "500",
        flex: 1
      })
    ).style({ alignItems: "center", flex: 1 }),
    UIButton(
      UIText("ИЗМЕНИТЬ").style({ color: THEME.accentCyan, fontSize: 10, fontWeight: "bold" })
    )
      .style({
        paddingHorizontal: 8,
        paddingVertical: 4,
        backgroundColor: "rgba(56, 189, 248, 0.12)",
        borderRadius: 6,
        borderWidth: 1,
        borderColor: "rgba(56, 189, 248, 0.3)"
      })
      .onClick(() => {
        onEdit?.();
      })
  ).style({
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: "rgba(15, 23, 42, 0.85)",
    borderBottomWidth: 1,
    borderColor: THEME.borderSubtle,
    alignItems: "center",
    width: "100%"
  });
}

// =========================================================================
// 3. Строка прикрепленных файлов (StagingBar)
// =========================================================================

export function StagingBar(stagedItemsSignal: any, onRemove: (id: string) => void): any {
  const chipsRow = UIRow().style({ flexWrap: "wrap", width: "100%" });

  const updateChips = () => {
    const items: StagedItem[] = stagedItemsSignal.value || [];
    const chips: any[] = [];
    items.forEach(item => {
      let iconName = "lucide:paperclip";
      let color = THEME.textPrimary;
      let bg = THEME.bgElevated;

      if (item.type === "photo") {
        iconName = "lucide:camera";
        color = THEME.accentCyan;
        bg = "rgba(56, 189, 248, 0.15)";
      } else if (item.type === "audio") {
        iconName = "lucide:mic";
        color = "#ec4899";
        bg = "rgba(236, 72, 153, 0.15)";
      } else if (item.type === "dtc") {
        iconName = "lucide:alert-circle";
        color = THEME.statusCrit;
        bg = "rgba(239, 68, 68, 0.15)";
      } else if (item.type === "obd") {
        iconName = "lucide:sliders";
        color = THEME.statusOk;
        bg = "rgba(34, 197, 94, 0.15)";
      }

      const chip = UIRow(
        LucideIcon(iconName, 13, color),
        UIText(` ${item.label}`).style({
          color: color,
          fontSize: 11,
          fontWeight: "600",
          marginRight: 6,
          marginLeft: 4
        }),
        UIButton(
          UIText("✕").style({ color: THEME.textMuted, fontSize: 10, fontWeight: "bold" })
        )
          .style({ padding: 2 })
          .onClick(() => onRemove(item.id))
      ).style({
        backgroundColor: bg,
        borderWidth: 1,
        borderColor: color,
        borderRadius: 8,
        paddingHorizontal: 8,
        paddingVertical: 4,
        marginRight: 6,
        marginBottom: 4,
        alignItems: "center"
      });

      chips.push(chip);
    });
    chipsRow.setContent(chips);
  };

  // Слушаем изменение сигналов
  stagedItemsSignal.watch?.(() => updateChips());

  return UIColumn(
    UIRow(
      UIText("Вложения к запросу:").style({ color: THEME.textMuted, fontSize: 10, marginBottom: 4 })
    ),
    chipsRow
  ).style({
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: "rgba(10, 15, 29, 0.95)",
    borderTopWidth: 1,
    borderColor: THEME.borderSubtle,
    width: "100%",
    display: () => ((stagedItemsSignal.value && stagedItemsSignal.value.length > 0) ? "flex" : "none")
  });
}

// =========================================================================
// 4. Тулбар множественного выделения (SelectionToolbar)
// =========================================================================

export function SelectionToolbar(
  selectedCountSignal: any,
  totalCountSignal: any,
  onSelectAll: () => void,
  onDeleteSelected: () => void,
  onDeselectAll: () => void,
  onClearAll: () => void
): any {
  const getCount = () => {
    const val = selectedCountSignal?.value;
    if (Array.isArray(val)) return val.length;
    return typeof val === "number" ? val : 0;
  };

  return UIRow(
    UIRow(
      UIText(() => `${getCount()} выбрано`).style({
        color: THEME.accentOrange,
        fontSize: 12,
        fontWeight: "bold",
        marginRight: 10
      })
    ).style({ alignItems: "center" }),

    UISpacer(),

    UIButton(
      UIText("Все").style({ color: THEME.textSecondary, fontSize: 11 })
    )
      .style({ paddingHorizontal: 8, paddingVertical: 4, backgroundColor: THEME.bgElevated, borderRadius: 6, marginRight: 6 })
      .onClick(onSelectAll),

    UIButton(
      UIText(() => `Удалить (${getCount()})`).style({ color: "#ffffff", fontSize: 11, fontWeight: "bold" })
    )
      .style({ paddingHorizontal: 10, paddingVertical: 4, backgroundColor: THEME.statusCrit, borderRadius: 6, marginRight: 6 })
      .onClick(onDeleteSelected),

    UIButton(
      UIText("Отмена").style({ color: THEME.textMuted, fontSize: 11 })
    )
      .style({ paddingHorizontal: 8, paddingVertical: 4, backgroundColor: THEME.bgElevated, borderRadius: 6 })
      .onClick(onDeselectAll)
  ).style({
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: "rgba(17, 24, 39, 0.98)",
    borderBottomWidth: 1,
    borderColor: THEME.borderStrong,
    alignItems: "center",
    width: "100%",
    display: () => (getCount() > 0 ? "flex" : "none")
  });
}

// =========================================================================
// 5. Карточка диагностического сообщения (MessageCard)
// =========================================================================

export interface MessageCardCallbacks {
  onToggleSelect?: (msgId: string) => void;
  onDelete?: (msgId: string) => void;
  onNavigateDtc?: (code: string) => void;
  onToggleTask?: (msgId: string, taskIdx: number, done: boolean) => void;
  onFollowupClick?: (text: string) => void;
}

export function MessageCard(msg: ChatMessageItem, callbacks?: MessageCardCallbacks): any {
  const isUser = msg.role === "user";

  // Стили карточки
  const bg = isUser ? "linear-gradient(180deg, #1e293b, #0f172a)" : THEME.bgSurface;
  const borderColor = isUser ? "rgba(56, 189, 248, 0.35)" : THEME.borderSubtle;
  const leftBorderColor = isUser ? "transparent" : THEME.accentOrange;

  // Шапка сообщения
  const roleTitle = isUser ? "ЗАПРОС МАСТЕРА" : "ИИДЕАЛ АВТО • ЭКСПЕРТНАЯ ДИАГНОСТИКА";
  const roleColor = isUser ? THEME.accentCyan : THEME.accentOrange;

  const headerRow = UIRow(
    UIText(roleTitle).style({ color: roleColor, fontSize: 11, fontWeight: "bold", flex: 1 }),
    UIText(msg.timestamp).style({ color: THEME.textMuted, fontSize: 10, marginRight: 8 }),
    UIButton(
      UIText("✕").style({ color: THEME.textMuted, fontSize: 11, fontWeight: "bold" })
    )
      .style({ padding: 3 })
      .onClick(() => callbacks?.onDelete?.(msg.id))
  ).style({ alignItems: "center", width: "100%", marginBottom: 6 });

  // Заголовок вердикта и бейдж типа
  let verdictRow = null;
  if (!isUser && msg.summaryTitle) {
    const diagType = msg.diagnosticType || "diagnosis";
    const typeLabel = diagType === "followup" ? "Уточнение" : "Диагностика";
    const typeColor = diagType === "followup" ? THEME.statusOk : THEME.accentOrange;
    const typeBg = diagType === "followup" ? "rgba(34, 197, 94, 0.15)" : "rgba(249, 115, 22, 0.15)";

    verdictRow = UIRow(
      UIText(msg.summaryTitle).style({
        color: THEME.textPrimary,
        fontSize: 13,
        fontWeight: "bold",
        flex: 1
      }),
      UIRow(
        UIText(typeLabel).style({ color: typeColor, fontSize: 10, fontWeight: "bold" })
      ).style({
        backgroundColor: typeBg,
        borderColor: typeColor,
        borderWidth: 1,
        borderRadius: 6,
        paddingHorizontal: 6,
        paddingVertical: 2
      })
    ).style({ alignItems: "center", width: "100%", marginBottom: 8 });
  }

  // Текст сообщения
  const contentText = UIText(msg.content).style({
    color: THEME.textSecondary,
    fontSize: 13,
    lineHeight: 20,
    marginBottom: 8
  });

  // Блок неисправностей (Faults)
  let faultsBlock = null;
  if (msg.faults && msg.faults.length > 0) {
    const faultRows = msg.faults.map(f => {
      const isCrit = f.severity === "critical";
      const health = f.health_index || 70;
      return UIColumn(
        UIRow(
          DtcChip(f.code, () => callbacks?.onNavigateDtc?.(f.code)),
          UIText(f.description || "").style({ color: THEME.textPrimary, fontSize: 11, flex: 1 })
        ).style({ alignItems: "center", width: "100%" }),
        UIRow(
          UIRow().style({
            height: 4,
            borderRadius: 2,
            backgroundColor: isCrit ? THEME.statusCrit : THEME.statusWarn,
            width: `${health}%`
          })
        ).style({
          height: 4,
          borderRadius: 2,
          backgroundColor: THEME.bgElevated,
          width: "100%",
          marginTop: 4,
          overflow: "hidden"
        })
      ).style({
        backgroundColor: "rgba(0, 0, 0, 0.25)",
        borderRadius: 8,
        padding: 8,
        borderWidth: 1,
        borderColor: isCrit ? "rgba(239, 68, 68, 0.3)" : THEME.borderSubtle,
        marginBottom: 6,
        width: "100%"
      });
    });

    faultsBlock = UIColumn(
      UIText("Обнаруженные неисправности:").style({ color: THEME.accentOrange, fontSize: 11, fontWeight: "bold", marginBottom: 6 }),
      ...faultRows
    ).style({ marginBottom: 8, width: "100%" });
  }

  // Интерактивный чеклист ремонта
  let tasksBlock = null;
  if (msg.tasks && msg.tasks.length > 0) {
    const doneCount = msg.tasks.filter(t => t.done).length;
    const taskRows = msg.tasks.map((task, idx) => {
      const isDone = signal(Boolean(task.done));

      return UIButton(
        UIRow(
          UIRow(
            UIText(() => (isDone.value ? "✓" : "")).style({
              color: "#ffffff",
              fontSize: 11,
              fontWeight: "bold"
            })
          ).style({
            width: 18,
            height: 18,
            borderRadius: 4,
            backgroundColor: () => (isDone.value ? THEME.statusOk : "transparent"),
            borderWidth: 1.5,
            borderColor: () => (isDone.value ? THEME.statusOk : THEME.textMuted),
            alignItems: "center",
            justifyContent: "center",
            marginRight: 8
          }),
          UIText(task.text).style({
            color: () => (isDone.value ? THEME.textMuted : THEME.textPrimary),
            fontSize: 12,
            textDecorationLine: () => (isDone.value ? "line-through" : "none"),
            flex: 1
          })
        ).style({ alignItems: "flex-start", width: "100%" })
      )
        .style({ paddingVertical: 4, width: "100%", $pressed: { opacity: 0.7 } })
        .onClick(() => {
          isDone.value = !isDone.value;
          task.done = isDone.value;
          callbacks?.onToggleTask?.(msg.id, idx, isDone.value);
        });
    });

    tasksBlock = UIColumn(
      UIRow(
        UIText("Чеклист проверки и ремонта:").style({ color: THEME.statusWarn, fontSize: 11, fontWeight: "bold", flex: 1 }),
        UIText(`${doneCount} / ${msg.tasks.length} выполнено`).style({ color: THEME.textMuted, fontSize: 10 })
      ).style({ alignItems: "center", width: "100%", marginBottom: 6 }),
      ...taskRows
    ).style({
      backgroundColor: "rgba(0, 0, 0, 0.3)",
      borderRadius: 8,
      padding: 10,
      borderWidth: 1,
      borderColor: "rgba(245, 158, 11, 0.3)",
      marginBottom: 8,
      width: "100%"
    });
  }

  // Инвентарь и запчасти
  let inventoryBlock = null;
  if (msg.inventory && msg.inventory.length > 0) {
    inventoryBlock = UIColumn(
      UIText("Необходимые детали и инструмент:").style({ color: THEME.statusOk, fontSize: 11, fontWeight: "bold", marginBottom: 4 }),
      UIText(msg.inventory.join(" • ")).style({ color: THEME.textSecondary, fontSize: 11, lineHeight: 16 })
    ).style({
      backgroundColor: "rgba(34, 197, 94, 0.08)",
      borderRadius: 6,
      padding: 8,
      borderWidth: 1,
      borderColor: "rgba(34, 197, 94, 0.25)",
      marginBottom: 8,
      width: "100%"
    });
  }

  // Коды ошибок DTC
  let dtcBlock = null;
  if (msg.dtcCodes && msg.dtcCodes.length > 0) {
    dtcBlock = UIRow(
      UIText("Коды: ").style({ color: THEME.textMuted, fontSize: 11, alignSelf: "center", marginRight: 4 }),
      ...msg.dtcCodes.map(code => DtcChip(code, () => callbacks?.onNavigateDtc?.(code)))
    ).style({ marginTop: 4, flexWrap: "wrap", width: "100%" });
  }

  // Кнопки быстрых подсказок (Followup chips)
  let followupBlock = null;
  if (msg.followupSuggestions && msg.followupSuggestions.length > 0) {
    const chips = msg.followupSuggestions.map(text =>
      UIButton(
        UIText(`→ ${text}`).style({ color: THEME.accentOrange, fontSize: 11, fontWeight: "500" })
      )
        .style({
          backgroundColor: "rgba(249, 115, 22, 0.1)",
          borderWidth: 1,
          borderColor: "rgba(249, 115, 22, 0.3)",
          borderRadius: 8,
          paddingHorizontal: 8,
          paddingVertical: 5,
          marginRight: 6,
          marginBottom: 6,
          $pressed: { opacity: 0.7 }
        })
        .onClick(() => callbacks?.onFollowupClick?.(text))
    );

    followupBlock = UIRow(...chips).style({ flexWrap: "wrap", marginTop: 6, width: "100%" });
  }

  return UIColumn(
    headerRow,
    verdictRow,
    contentText,
    faultsBlock,
    tasksBlock,
    inventoryBlock,
    dtcBlock,
    followupBlock
  ).style({
    background: bg,
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: borderColor,
    borderLeftWidth: isUser ? 1 : 4,
    borderLeftColor: isUser ? borderColor : leftBorderColor,
    marginBottom: 10,
    width: "100%",
    maxWidth: 820,
    alignSelf: "center"
  });
}

// =========================================================================
// 6. Кнопки и вспомогательные виджеты
// =========================================================================

export function PrimaryButton(label: string | (() => string), onClick: () => void, icon?: any): any {
  return UIButton(
    icon ? UIRow(icon).style({ marginRight: 6 }) : null,
    UIText(label).style({ color: "#ffffff", fontSize: 13, fontWeight: "bold" })
  )
    .style({
      backgroundColor: THEME.accentOrange,
      borderRadius: 8,
      paddingHorizontal: 14,
      paddingVertical: 8,
      alignItems: "center",
      justifyContent: "center",
      $hovered: { backgroundColor: THEME.accentOrangeHover },
      $pressed: { opacity: 0.8 }
    })
    .onClick(onClick);
}

export function SecondaryButton(label: string | (() => string), onClick: () => void, icon?: any): any {
  return UIButton(
    icon ? UIRow(icon).style({ marginRight: 6 }) : null,
    UIText(label).style({ color: THEME.textSecondary, fontSize: 12, fontWeight: "500" })
  )
    .style({
      backgroundColor: THEME.bgElevated,
      borderWidth: 1,
      borderColor: THEME.borderSubtle,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 7,
      alignItems: "center",
      justifyContent: "center",
      $pressed: { opacity: 0.8 }
    })
    .onClick(onClick);
}

export function DtcChip(code: string, onClick?: () => void): any {
  const isP = code.startsWith("P");
  const isC = code.startsWith("C");
  const isB = code.startsWith("B");
  let color = THEME.accentCyan;
  let bg = "rgba(56, 189, 248, 0.15)";

  if (isP) {
    color = THEME.statusCrit;
    bg = "rgba(239, 68, 68, 0.15)";
  } else if (isC) {
    color = THEME.statusWarn;
    bg = "rgba(245, 158, 11, 0.15)";
  } else if (isB) {
    color = "#a855f7";
    bg = "rgba(168, 85, 247, 0.15)";
  }

  const btn = UIButton(
    UIText(code).style({ color: color, fontSize: 11, fontWeight: "bold" })
  ).style({
    backgroundColor: bg,
    borderWidth: 1,
    borderColor: color,
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 3,
    marginRight: 6,
    marginBottom: 6,
    $pressed: { opacity: 0.7 }
  });

  if (onClick) {
    btn.onClick(onClick);
  }
  return btn;
}

export function MetricCard(
  title: string,
  valueStr: string | (() => string),
  unit: string,
  accentColor: string = THEME.accentCyan,
  progressFn?: () => number
): any {
  let progressBar = null;
  if (progressFn) {
    progressBar = UIRow(
      UIRow().style({
        height: 4,
        borderRadius: 2,
        backgroundColor: accentColor,
        width: () => `${Math.min(100, Math.max(0, Math.round((progressFn() || 0) * 100)))}%`
      })
    ).style({
      height: 4,
      borderRadius: 2,
      backgroundColor: THEME.bgElevated,
      width: "100%",
      marginTop: 8,
      overflow: "hidden"
    });
  }

  return UIColumn(
    UIText(title).style({ color: THEME.textMuted, fontSize: 10, textTransform: "uppercase", fontWeight: "600" }),
    UIRow(
      UIText(valueStr).style({
        color: "#ffffff",
        fontSize: 20,
        fontWeight: "bold",
        fontVariantNumeric: "tabular-nums"
      }),
      UIText(" " + unit).style({ color: accentColor, fontSize: 11, marginLeft: 4, alignSelf: "flex-end", marginBottom: 2 })
    ).style({ alignItems: "flex-end", marginTop: 4 }),
    progressBar
  ).style({
    backgroundColor: THEME.bgSurface,
    borderRadius: 12,
    padding: 10,
    borderWidth: 1,
    borderColor: THEME.borderSubtle,
    flex: 1,
    minWidth: 90
  });
}
