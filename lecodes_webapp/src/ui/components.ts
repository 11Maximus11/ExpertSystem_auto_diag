/**
 * Набор переиспользуемых UI-компонентов на базе le.codes SDK.
 * Оптимизированы для вертикальных мобильных экранов (360px - 480px) и десктопа.
 * Лицензия: GPL-3.0
 */

export function HeaderBar(title: string, subtitle?: string, rightNode?: any): any {
  return UIColumn(
    UIRow(
      UIColumn(
        UIText(title).style({ color: "#f8fafc", fontSize: 16, fontWeight: "bold" }),
        subtitle
          ? UIText(subtitle).style({ color: "#94a3b8", fontSize: 11, marginTop: 2 })
          : null
      ).style({ flex: 1, minWidth: 100 }),
      rightNode ? UIRow(rightNode).style({ marginLeft: 8, alignItems: "center", flexShrink: 0 }) : null
    ).style({ alignItems: "center", width: "100%" })
  ).style({
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: "rgba(13, 19, 34, 0.95)",
    borderBottomWidth: 1,
    borderColor: "#1e293b"
  });
}

export function StatusBadge(status: "disconnected" | "connecting" | "connected" | "error" | string, label: string | (() => string)): any {
  const getCol = () => {
    const s = typeof status === "function" ? (status as any)() : status;
    if (s === "connected") return "#10b981";
    if (s === "connecting") return "#f59e0b";
    return "#ef4444";
  };
  const getBg = () => {
    const s = typeof status === "function" ? (status as any)() : status;
    if (s === "connected") return "rgba(16, 185, 129, 0.15)";
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

export function MetricCard(
  title: string,
  valueStr: string | (() => string),
  unit: string,
  accentColor: string = "#38bdf8",
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
      backgroundColor: "#1e293b",
      width: "100%",
      marginTop: 8,
      overflow: "hidden"
    });
  }

  return UIColumn(
    UIText(title).style({ color: "#94a3b8", fontSize: 11, textTransform: "uppercase", fontWeight: "600" }),
    UIRow(
      UIText(valueStr).style({
        color: "#ffffff",
        fontSize: 22,
        fontWeight: "bold",
        fontVariantNumeric: "tabular-nums"
      }),
      UIText(" " + unit).style({ color: accentColor, fontSize: 12, marginLeft: 4, alignSelf: "flex-end", marginBottom: 2 })
    ).style({ alignItems: "flex-end", marginTop: 4 }),
    progressBar
  ).style({
    backgroundColor: "#131b2e",
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: "#1e293b",
    flex: 1,
    minWidth: 100
  });
}

export function PrimaryButton(label: string | (() => string), onClick: () => void, icon?: any): any {
  return UIButton(
    icon ? UIRow(icon).style({ marginRight: 6 }) : null,
    UIText(label).style({ color: "#ffffff", fontSize: 13, fontWeight: "bold" })
  )
    .style({
      backgroundColor: "#2563eb",
      borderRadius: 8,
      paddingHorizontal: 14,
      paddingVertical: 8,
      alignItems: "center",
      justifyContent: "center",
      $hovered: { backgroundColor: "#3b82f6" },
      $pressed: { opacity: 0.8 }
    })
    .onClick(onClick);
}

export function SecondaryButton(label: string | (() => string), onClick: () => void, icon?: any): any {
  return UIButton(
    icon ? UIRow(icon).style({ marginRight: 6 }) : null,
    UIText(label).style({ color: "#cbd5e1", fontSize: 12, fontWeight: "500" })
  )
    .style({
      backgroundColor: "#1e293b",
      borderWidth: 1,
      borderColor: "#334155",
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 7,
      alignItems: "center",
      justifyContent: "center",
      $hovered: { backgroundColor: "#334155" },
      $pressed: { opacity: 0.8 }
    })
    .onClick(onClick);
}

export function DtcChip(code: string, onClick?: () => void): any {
  const isP = code.startsWith("P");
  const isC = code.startsWith("C");
  const isB = code.startsWith("B");
  let color = "#38bdf8";
  let bg = "rgba(56, 189, 248, 0.15)";

  if (isP) {
    color = "#f43f5e";
    bg = "rgba(244, 63, 94, 0.15)";
  } else if (isC) {
    color = "#eab308";
    bg = "rgba(234, 179, 8, 0.15)";
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
