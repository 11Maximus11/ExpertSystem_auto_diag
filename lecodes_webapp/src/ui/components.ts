/**
 * Набор переиспользуемых UI-компонентов на базе le.codes SDK.
 * Использует чистые виджеты UIColumn, UIRow, UIButton, UIText, UISpacer и реактивные сигналы.
 */

export function HeaderBar(title: string, subtitle?: string, rightNode?: any): any {
  return UIRow(
    UIColumn(
      UIText(title).style({ color: "#f8fafc", fontSize: 20, fontWeight: "bold" }),
      subtitle
        ? UIText(subtitle).style({ color: "#94a3b8", fontSize: 13, marginTop: 2 })
        : null
    ),
    UISpacer(),
    rightNode || null
  ).style({
    paddingHorizontal: 20,
    paddingVertical: 14,
    backgroundColor: "#0d1322",
    borderBottomWidth: 1,
    borderColor: "#1e293b",
    alignItems: "center"
  });
}

export function StatusBadge(status: "disconnected" | "connecting" | "connected" | "error", label: string): any {
  let color = "#ef4444";
  let bg = "rgba(239, 68, 68, 0.15)";
  if (status === "connected") {
    color = "#10b981";
    bg = "rgba(16, 185, 129, 0.15)";
  } else if (status === "connecting") {
    color = "#f59e0b";
    bg = "rgba(245, 158, 11, 0.15)";
  }

  return UIRow(
    UIRow().style({
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: color,
      marginRight: 8
    }),
    UIText(label).style({ color: color, fontSize: 12, fontWeight: "bold" })
  ).style({
    backgroundColor: bg,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
    alignItems: "center"
  });
}

export function MetricCard(title: string, valueStr: string | (() => string), unit: string, accentColor: string = "#38bdf8"): any {
  return UIColumn(
    UIText(title).style({ color: "#94a3b8", fontSize: 12, textTransform: "uppercase" }),
    UIRow(
      UIText(valueStr).style({
        color: "#ffffff",
        fontSize: 26,
        fontWeight: "bold",
        fontVariantNumeric: "tabular-nums"
      }),
      UIText(" " + unit).style({ color: accentColor, fontSize: 14, marginLeft: 4, alignSelf: "flex-end", marginBottom: 3 })
    ).style({ alignItems: "flex-end", marginTop: 4 })
  ).style({
    backgroundColor: "#131b2e",
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: "#1e293b",
    flex: 1,
    minWidth: 140
  });
}

export function PrimaryButton(label: string, onClick: () => void, icon?: any): any {
  return UIButton(
    icon ? UIRow(icon).style({ marginRight: 8 }) : null,
    UIText(label).style({ color: "#ffffff", fontSize: 14, fontWeight: "bold" })
  )
    .style({
      backgroundColor: "#2563eb",
      borderRadius: 10,
      paddingHorizontal: 16,
      paddingVertical: 10,
      alignItems: "center",
      justifyContent: "center",
      $hovered: { backgroundColor: "#3b82f6" },
      $pressed: { opacity: 0.8 }
    })
    .onClick(onClick);
}

export function SecondaryButton(label: string, onClick: () => void, icon?: any): any {
  return UIButton(
    icon ? UIRow(icon).style({ marginRight: 8 }) : null,
    UIText(label).style({ color: "#cbd5e1", fontSize: 14 })
  )
    .style({
      backgroundColor: "#1e293b",
      borderWidth: 1,
      borderColor: "#334155",
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 10,
      alignItems: "center",
      justifyContent: "center",
      $hovered: { backgroundColor: "#334155" },
      $pressed: { opacity: 0.8 }
    })
    .onClick(onClick);
}

export function DtcChip(code: string, onClick?: () => void): any {
  const isP = code.startsWith("P");
  const color = isP ? "#f43f5e" : "#eab308";
  const bg = isP ? "rgba(244, 63, 94, 0.15)" : "rgba(234, 179, 8, 0.15)";

  const btn = UIButton(
    UIText(code).style({ color: color, fontSize: 12, fontWeight: "bold" })
  ).style({
    backgroundColor: bg,
    borderWidth: 1,
    borderColor: color,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginRight: 6,
    marginBottom: 6,
    $pressed: { opacity: 0.7 }
  });

  if (onClick) {
    btn.onClick(onClick);
  }
  return btn;
}
