// ИИдеал Авто — Инспектор ремонта и оффлайн-справочник 12 141 DTC (2026-11-28)
// Copyright (C) 2026 ИИдеал Авто (LeCodes48 Edition)
// Licensed under the GNU General Public License v3.0 (GPL-3.0).

import { hybridRag } from "../rag/HybridRagEngine";
import {
  appState,
  stageDtcCodes,
  toggleChecklistTask,
  toggleInventoryItemCheck,
} from "../state/appState";
import type { ChatMessageItem, DtcCodeInfo } from "../types";
import {
  AppHeader,
  DtcChip,
  LucideIcon,
  openWorkOrderShareModal,
  PrimaryButton,
  SecondaryButton,
  StatusBadge,
  THEME,
} from "./components";

export interface DtcDictionaryCallbacks {
  onSelectCode?: (code: string) => void;
  onOpenAr?: () => void;

  onOpenSettings?: () => void;
}

const SYSTEM_FILTERS: { id: string; label: string }[] = [
  { id: "all", label: "Все" },
  { id: "engine", label: "Двигатель" },
  { id: "transmission", label: "Трансмиссия" },
  { id: "brakes", label: "Тормоза" },
  { id: "electrical", label: "Электрика" },
  { id: "cooling", label: "Охлаждение" },
  { id: "hybrid", label: "Гибрид" },
  { id: "battery", label: "АКБ" },
  { id: "suspension", label: "Подвеска" },
];

export function createDtcDictionaryScreen(callbacks?: DtcDictionaryCallbacks): any {
  const activeSubTabSignal = signal<"checklist" | "dtc">("checklist");
  const searchQuerySignal = signal<string>("");
  const systemFilterSignal = signal<string>("all");

  const initialPage = hybridRag.searchDtcPage("", "all", 0, 60);
  const dtcResultsSignal = signal<DtcCodeInfo[]>(initialPage.items);
  const dtcTotalSignal = signal<number>(initialPage.total);
  const dtcCatalogTotalSignal = signal<number>(initialPage.totalCatalog);

  const runDtcSearch = () => {
    const page = hybridRag.searchDtcPage(
      searchQuerySignal.value,
      systemFilterSignal.value,
      0,
      60
    );
    dtcResultsSignal.value = page.items;
    dtcTotalSignal.value = page.total;
    dtcCatalogTotalSignal.value = page.totalCatalog;
  };

  const getLatestDiagnosisMessage = (): ChatMessageItem | null => {
    const msgs = appState.messagesSignal.value || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (
        msgs[i].role === "assistant" &&
        ((msgs[i].tasks && msgs[i].tasks!.length > 0) ||
          (msgs[i].inventoryItems && msgs[i].inventoryItems!.length > 0))
      ) {
        return msgs[i];
      }
    }
    return null;
  };

  // =========================================================================
  // ВКЛАДКА 1: ИНТЕРАКТИВНЫЙ ЧЕКЛИСТ РЕМОНТА И ИНВЕНТАРЬ
  // =========================================================================
  const buildChecklistChildren = (): any[] => {
    void appState.messagesSignal.value;
    void appState.settingsSignal.value.theme_mode;
    const latest = getLatestDiagnosisMessage();
    if (!latest) {
      return [
        UIColumn(
          LucideIcon("lucide:wrench", 28, () => THEME.accentOrange),
          UIText("Чеклист ремонта пока пуст").style({
            color: () => THEME.textPrimary,
            fontSize: 15,
            fontWeight: "bold",
            marginTop: 8,
          }),
          UIText(
            "Задайте вопрос ИИ-диагносту или выберите код DTC во второй вкладке, чтобы сформировать пошаговый план проверки и список инструментов."
          ).style({
            color: () => THEME.textMuted,
            fontSize: 12,
            textAlign: "center",
          }),
          SecondaryButton(
            "Открыть базу 12 141 DTC",
            () => {
              activeSubTabSignal.value = "dtc";
            },
            "lucide:search"
          )
        ).style({
          backgroundColor: () => THEME.bgSurface,
          borderRadius: 16,
          padding: 20,
          borderWidth: 1,
          borderColor: () => THEME.borderDefault,
          alignItems: "center",
          gap: 8,
        }),
      ];
    }

    const tasks = latest.tasks || [];
    const inv = latest.inventoryItems || [];
    const doneTasks = tasks.filter((t) => t.done).length;
    const progressRatio = tasks.length > 0 ? Math.round((doneTasks / tasks.length) * 100) : 0;

    const children: any[] = [
      // Карточка сводки заказ-наряда
      UIColumn(
        UIRow(
          UIText(latest.summaryTitle || "Активный план диагностики").style({
            color: () => THEME.textPrimary,
            fontSize: 14,
            fontWeight: "bold",
            flex: 1,
          }),
          StatusBadge(progressRatio === 100 ? "ok" : "warn", `${doneTasks}/${tasks.length}`)
        ).style({ width: "100%", alignItems: "center", gap: 8 }),
        UIText(`Прогресс выполнения: ${progressRatio}%`).style({
          color: () => THEME.textMuted,
          fontSize: 11,
        }),
        UIRow(
          SecondaryButton(
            "Заказ-наряд",
            () => void openWorkOrderShareModal(latest),
            "lucide:share-2"
          ),

        ).style({ gap: 8, marginTop: 4 })
      ).style({
        backgroundColor: () => THEME.bgSurface,
        borderRadius: 14,
        padding: 12,
        borderWidth: 1,
        borderColor: () => THEME.borderDefault,
        gap: 6,
      }),
    ];

    if (tasks.length > 0) {
      children.push(
        UIText("ПОШАГОВЫЙ РЕГЛАМЕНТ ПРОВЕРКИ").style({
          color: () => THEME.accentOrange,
          fontSize: 11,
          fontWeight: "bold",
          marginTop: 4,
        })
      );

      for (const task of tasks) {
        children.push(
          UIButton(
            UIRow(
              UIBox(
                task.done
                  ? LucideIcon("lucide:check", 13, () => "#ffffff")
                  : UIText(String(task.step_number)).style({
                      color: () => THEME.textMuted,
                      fontSize: 10,
                      fontWeight: "bold",
                    })
              ).style({
                width: 24,
                height: 24,
                borderRadius: 7,
                backgroundColor: task.done ? THEME.statusOk : THEME.bgInput,
                borderWidth: 1,
                borderColor: task.done ? THEME.statusOk : THEME.borderStrong,
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }),
              UIColumn(
                UIText(task.title).style({
                  color: () => (task.done ? THEME.textMuted : THEME.textPrimary),
                  fontSize: 13,
                  fontWeight: "bold",
                }),
                UIText(task.instruction).style({
                  color: () => THEME.textSecondary,
                  fontSize: 12,
                }),
                ...(task.torque_or_spec
                  ? [
                      UIText(`Допуск / норма: ${task.torque_or_spec}`).style({
                        color: () => THEME.accentCyan,
                        fontSize: 11,
                        fontWeight: "600",
                      }),
                    ]
                  : [])
              ).style({ flex: 1, gap: 3 })
            ).style({ width: "100%", alignItems: "flex-start", gap: 10 })
          )
            .style({
              width: "100%",
              backgroundColor: () => THEME.bgSurface,
              borderRadius: 12,
              padding: 12,
              borderWidth: 1,
              borderColor: task.done ? THEME.statusOk : THEME.borderDefault,
            })
            .onClick(() => toggleChecklistTask(latest.id, task.id))
        );
      }
    }

    if (inv.length > 0) {
      children.push(
        UIText("ИНСТРУМЕНТ И ПРИБОРЫ").style({
          color: () => THEME.accentCyan,
          fontSize: 11,
          fontWeight: "bold",
          marginTop: 6,
        })
      );
      for (const item of inv) {
        children.push(
          UIButton(
            UIRow(
              UIBox(
                item.checked ? LucideIcon("lucide:check", 12, () => "#ffffff") : undefined
              ).style({
                width: 20,
                height: 20,
                borderRadius: 6,
                backgroundColor: item.checked ? THEME.accentCyan : THEME.bgInput,
                borderWidth: 1,
                borderColor: item.checked ? THEME.accentCyan : THEME.borderStrong,
                alignItems: "center",
                justifyContent: "center",
              }),
              UIColumn(
                UIText(item.name).style({
                  color: () => THEME.textPrimary,
                  fontSize: 12,
                  fontWeight: "600",
                }),
                ...(item.spec
                  ? [
                      UIText(item.spec).style({
                        color: () => THEME.textMuted,
                        fontSize: 10,
                      }),
                    ]
                  : [])
              ).style({ flex: 1, gap: 2 })
            ).style({ width: "100%", alignItems: "center", gap: 10 })
          )
            .style({
              width: "100%",
              backgroundColor: () => THEME.bgSurface,
              borderRadius: 10,
              padding: 10,
              borderWidth: 1,
              borderColor: () => THEME.borderDefault,
            })
            .onClick(() => toggleInventoryItemCheck(latest.id, item.id))
        );
      }
    }

    return children;
  };

  const checklistContentContainer = UIColumn(() => buildChecklistChildren()).style({
    width: "100%",
    gap: 10,
    paddingHorizontal: 12,
    paddingBottom: 18,
  });

  // =========================================================================
  // ВКЛАДКА 2: ОФФЛАЙН-СПРАВОЧНИК HYBRID RAG (12 141 DTC)
  // =========================================================================
  const searchInput = UIInput()
    .named("dtc-search-input")
    .style({
      flex: 1,
      height: 38,
      backgroundColor: () => THEME.bgInput,
      color: () => THEME.textPrimary,
      borderWidth: 1,
      borderColor: () => THEME.borderDefault,
      borderRadius: 10,
      paddingHorizontal: 12,
      fontSize: 13,
      placeholder: "Поиск кода (P0300) или симптома (троит, перегрев)...",
      placeholderColor: () => THEME.inputPlaceholder,
    })
    .onChange((val: string) => {
      searchQuerySignal.value = val;
      runDtcSearch();
    });

  const buildDtcCards = (): any[] => {
    void appState.settingsSignal.value.theme_mode;
    const items = dtcResultsSignal.value || [];
    if (items.length === 0) {
      return [
        UIText("По вашему запросу коды DTC не найдены.").style({
          color: () => THEME.textMuted,
          fontSize: 12,
          padding: 16,
          textAlign: "center",
        }),
      ];
    }

    return items.map((item) =>
      UIColumn(
        UIRow(
          DtcChip(item.code, () => {
            stageDtcCodes([item.code]);
            callbacks?.onSelectCode?.(item.code);
          }),
          UIText(item.system_ru || String(item.system)).style({
            color: () => THEME.accentCyan,
            fontSize: 11,
            fontWeight: "600",
            flex: 1,
          }),
          StatusBadge(
            item.severity === "critical" ? "crit" : item.severity === "warning" ? "warn" : "ok",
            item.severity === "critical" ? "Критично" : item.severity === "warning" ? "Внимание" : "Инфо"
          )
        ).style({ width: "100%", alignItems: "center", gap: 8 }),
        UIText(item.title).style({
          color: () => THEME.textPrimary,
          fontSize: 13,
          fontWeight: "bold",
        }),
        ...(item.description
          ? [
              UIText(item.description).style({
                color: () => THEME.textSecondary,
                fontSize: 12,
                lineClamp: 3,
              }),
            ]
          : []),
        ...(item.solution
          ? [
              UIText(`Решение: ${item.solution}`).style({
                color: () => THEME.textMuted,
                fontSize: 11,
                lineClamp: 3,
              }),
            ]
          : []),
        UIRow(
          PrimaryButton(
            "В ИИ-диагност",
            () => {
              stageDtcCodes([item.code]);
              callbacks?.onSelectCode?.(item.code);
            },
            "lucide:send"
          )
        ).style({ justifyContent: "flex-end", width: "100%", marginTop: 4 })
      ).style({
        backgroundColor: () => THEME.bgSurface,
        borderRadius: 12,
        padding: 12,
        borderWidth: 1,
        borderColor: () => THEME.borderDefault,
        gap: 6,
      })
    );
  };

  const dtcListContainer = UIColumn(() => buildDtcCards()).style({
    width: "100%",
    gap: 8,
    paddingHorizontal: 12,
    paddingBottom: 18,
  });

  const dtcSearchPane = UIColumn(
    UIRow(
      searchInput,
      UIButton(LucideIcon("lucide:x", 16, () => THEME.textMuted))
        .style({
          width: 36,
          height: 36,
          borderRadius: 10,
          backgroundColor: () => THEME.bgSurface,
          borderWidth: 1,
          borderColor: () => THEME.borderDefault,
          alignItems: "center",
          justifyContent: "center",
        })
        .onClick(() => {
          searchInput.value = "";
          searchQuerySignal.value = "";
          runDtcSearch();
        })
    ).style({ paddingHorizontal: 12, gap: 6, alignItems: "center", width: "100%" }),

    UIScrollable(
      UIRow(
        ...SYSTEM_FILTERS.map((f) =>
          UIButton(
            UIText(f.label).style({
              color: () =>
                systemFilterSignal.value === f.id ? "#ffffff" : THEME.textSecondary,
              fontSize: 11,
              fontWeight: "600",
            })
          )
            .style({
              backgroundColor: () =>
                systemFilterSignal.value === f.id ? THEME.accentOrange : THEME.bgSurface,
              borderWidth: 1,
              borderColor: () =>
                systemFilterSignal.value === f.id ? THEME.accentOrange : THEME.borderDefault,
              borderRadius: 9,
              paddingHorizontal: 10,
              paddingVertical: 5,
            })
            .onClick(() => {
              systemFilterSignal.value = f.id;
              runDtcSearch();
            })
        )
      ).style({ gap: 6, paddingHorizontal: 12 })
    ).style({ scrollDirection: "horizontal", width: "100%", height: 34 }),

    UIText(() => `Найдено: ${dtcTotalSignal.value} из ${dtcCatalogTotalSignal.value} кодов (оффлайн)`).style({
      color: () => THEME.textMuted,
      fontSize: 11,
      paddingHorizontal: 12,
    }),

    UIScrollable(dtcListContainer).style({ flex: 1, width: "100%" })
  ).style({ flex: 1, width: "100%", gap: 8 });

  // Переключатель под-вкладок экрана
  const subTabBar = UIRow(
    UIButton(
      UIText("Чеклист ремонта").style({
        color: () =>
          activeSubTabSignal.value === "checklist" ? "#ffffff" : THEME.textSecondary,
        fontSize: 12,
        fontWeight: "bold",
      })
    )
      .named("dtc-tab-checklist")
      .style({
        flex: 1,
        backgroundColor: () =>
          activeSubTabSignal.value === "checklist" ? THEME.accentOrange : THEME.bgSurface,
        borderWidth: 1,
        borderColor: () =>
          activeSubTabSignal.value === "checklist" ? THEME.accentOrange : THEME.borderDefault,
        borderRadius: 10,
        paddingVertical: 8,
        alignItems: "center",
      })
      .onClick(() => {
        activeSubTabSignal.value = "checklist";
      }),

    UIButton(
      UIText(() => `База ${dtcCatalogTotalSignal.value} DTC`).style({
        color: () =>
          activeSubTabSignal.value === "dtc" ? "#ffffff" : THEME.textSecondary,
        fontSize: 12,
        fontWeight: "bold",
      })
    )
      .named("dtc-tab-catalog")
      .style({
        flex: 1,
        backgroundColor: () =>
          activeSubTabSignal.value === "dtc" ? THEME.accentCyan : THEME.bgSurface,
        borderWidth: 1,
        borderColor: () =>
          activeSubTabSignal.value === "dtc" ? THEME.accentCyan : THEME.borderDefault,
        borderRadius: 10,
        paddingVertical: 8,
        alignItems: "center",
      })
      .onClick(() => {
        activeSubTabSignal.value = "dtc";
      })
  ).style({ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 6, gap: 8, width: "100%" });

  const checklistScroll = UIScrollable(checklistContentContainer).style({ flex: 1, width: "100%" });
  const bodyHost = UIColumn(() => [
    activeSubTabSignal.value === "checklist" ? checklistScroll : dtcSearchPane,
  ]).style({ flex: 1, width: "100%" });

  return UIColumn(
    AppHeader({
      title: "ЧЕКЛИСТ & DTC",
      onOpenAr: callbacks?.onOpenAr,

      onOpenSettings: callbacks?.onOpenSettings,
    }),
    subTabBar,
    bodyHost
  )
    .named("dtc")
    .style({
      flex: 1,
      width: "100%",
      backgroundColor: () => THEME.bgBase,
    });
}
