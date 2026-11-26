/**
 * Экран инспектора ремонта & словаря кодов DTC (100% паритет с мобильной веб-версией).
 * Вкладка 1: Интерактивный пошаговый чеклист и инвентарь из текущего вердикта ИИ
 * (синхронизируется в реальном времени с карточкой чата, AR HUD и сервером).
 * Вкладка 2: Полнотекстовый и системный поиск по базе кодов DTC (Django API + оффлайн кэш).
 *
 * Лицензия: GPL-3.0
 */

import { apiClient } from "../api/BackendApiClient";
import { cacheManager } from "../cache/ResourceCacheManager";
import { appState, createWelcomeMessage, stageDtcCodes } from "../state/appState";
import { DtcCodeInfo } from "../types";
import {
  AppHeader,
  DtcChip,
  LucideIcon,
  PrimaryButton,
  SecondaryButton,
  THEME
} from "./components";

export interface DtcDictionaryCallbacks {
  onSelectCode?: (code: string) => void;
  onOpenAr?: () => void;
  onOpenSettings?: () => void;
}

export function createDtcDictionaryScreen(
  cbOrFn?: DtcDictionaryCallbacks | ((code: string) => void)
): any {
  const callbacks: DtcDictionaryCallbacks =
    typeof cbOrFn === "function" ? { onSelectCode: cbOrFn } : cbOrFn || {};

  const activeSubTabSignal = signal<"checklist" | "dtc">("checklist");
  const searchQuerySignal = signal<string>("");
  const systemFilterSignal = signal<string>("all");
  const initialLocalPage = cacheManager.searchDtcPage("", "all", 0, 80);
  const dtcResultsSignal = signal<DtcCodeInfo[]>(initialLocalPage.items);
  const dtcTotalSignal = signal<number>(initialLocalPage.total);
  const dtcTotalCatalogSignal = signal<number>(cacheManager.getStats().dtcCount);
  const dtcLoadingMoreSignal = signal<boolean>(false);
  const isSyncingSignal = signal<boolean>(false);
  let dtcRequestSeq = 0;

  const header = AppHeader({
    title: "ИИДЕАЛ АВТО",
    onOpenAr: () => callbacks.onOpenAr?.(),
    onOpenSettings: () => callbacks.onOpenSettings?.()
  });

  const subTabButton = (label: string, mode: "checklist" | "dtc", iconName: string) => {
    const active = () => activeSubTabSignal.value === mode;
    return UIButton(
      UIRow(
        LucideIcon(iconName, 14, () => (active() ? "#ffffff" : THEME.textSecondary)),
        UIText(label).style({
          color: () => (active() ? "#ffffff" : THEME.textSecondary),
          fontSize: 12,
          fontWeight: "bold"
        })
      ).style({ alignItems: "center", gap: 6 })
    )
      .style({
        flex: 1,
        paddingVertical: 9,
        borderRadius: 9,
        backgroundColor: () => (active() ? THEME.accentOrange : THEME.bgElevated),
        borderWidth: 1,
        borderColor: () => (active() ? THEME.accentOrange : THEME.borderDefault),
        alignItems: "center",
        justifyContent: "center"
      })
      .onClick(() => {
        activeSubTabSignal.value = mode;
        if (mode === "dtc") {
          void runDtcSearch();
        }
      });
  };

  // =========================================================================
  // ВКЛАДКА 1: ЖИВОЙ ЧЕКЛИСТ & ИНВЕНТАРЬ ТЕКУЩЕЙ ДИАГНОСТИКИ
  // =========================================================================

  const checklistBody = UIColumn().style({ width: "100%", gap: 10 });

  const renderChecklistContent = () => {
    const rawLatest = appState.latestAssistantMessageSignal.value;
    const msg =
      rawLatest && ((rawLatest.tasks && rawLatest.tasks.length > 0) || (rawLatest.inventoryItems && rawLatest.inventoryItems.length > 0))
        ? rawLatest
        : [...(appState.messagesSignal.value || [])]
            .reverse()
            .find(m => m.role === "assistant" && m.tasks && m.tasks.length > 0) ||
          rawLatest ||
          createWelcomeMessage();
    const tasks = msg.tasks || [];
    const inv = msg.inventoryItems || [];
    const doneTasks = tasks.filter(t => t.done).length;
    const totalTasks = tasks.length;
    const pct = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;

    const cards: any[] = [
      // Карточка прогресса и контекста
      UIColumn(
        UIRow(
          LucideIcon("lucide:check-check", 17, () => THEME.accentOrange),
          UIText(msg.summaryTitle || "Чеклист ремонтных работ").style({
            color: () => THEME.textPrimary,
            fontSize: 14,
            fontWeight: "bold",
            flex: 1
          }),
          UIText(`${doneTasks} / ${totalTasks}`).style({
            color: () => THEME.accentCyan,
            fontSize: 12,
            fontWeight: "bold"
          })
        ).style({ alignItems: "center", gap: 7, width: "100%", marginBottom: 6 }),
        UIBox(
          UIBox().style({
            width: `${pct}%`,
            height: 6,
            borderRadius: 3,
            backgroundColor: () => (pct === 100 ? THEME.statusOk : THEME.accentOrange)
          })
        ).style({
          width: "100%",
          height: 6,
          borderRadius: 3,
          backgroundColor: () => THEME.bgElevated,
          marginBottom: 8
        }),
        UIRow(
          UIText(`Прогресс ремонта: ${pct}%`).style({
            color: () => THEME.textMuted,
            fontSize: 11,
            flex: 1
          }),
          ...(callbacks.onOpenAr
            ? [
                SecondaryButton(
                  "Открыть в AR HUD",
                  () => callbacks.onOpenAr?.(),
                  "lucide:glasses"
                )
              ]
            : [])
        ).style({ alignItems: "center", width: "100%" })
      ).style({
        backgroundColor: () => THEME.bgSurface,
        borderWidth: 1,
        borderColor: () => THEME.borderDefault,
        borderRadius: 14,
        padding: 13,
        width: "100%"
      })
    ];

    if (tasks.length > 0) {
      cards.push(
        UIColumn(
          UIText("Пошаговый план проверки и ремонта").style({
            color: () => THEME.accentOrangeLight,
            fontSize: 13,
            fontWeight: "bold",
            marginBottom: 4
          }),
          ...tasks.map((task, idx) => {
            const checkId = task.step_number ?? task.id ?? idx + 1;
            const titleText =
              task.title && task.instruction && task.title !== task.instruction
                ? `${task.title}: ${task.instruction}`
                : task.text || task.instruction || task.title || `Шаг ${idx + 1}`;
            return UIButton(
              UIRow(
                UIBox(
                  LucideIcon("lucide:check", 12, "#ffffff").style({
                    display: task.done ? "flex" : "none"
                  })
                ).style({
                  width: 20,
                  height: 20,
                  borderRadius: 6,
                  borderWidth: 1.5,
                  borderColor: () => (task.done ? THEME.statusOk : THEME.borderStrong),
                  backgroundColor: () => (task.done ? THEME.statusOk : "transparent"),
                  alignItems: "center",
                  justifyContent: "center",
                  marginTop: 1
                }),
                UIColumn(
                  UIText(`${idx + 1}. ${titleText}`).style({
                    color: () => (task.done ? THEME.textMuted : THEME.textPrimary),
                    fontSize: 12,
                    lineHeight: 17,
                    textDecoration: task.done ? "line-through" : "none"
                  }),
                  ...(task.torque_or_spec || task.safety_warning
                    ? [
                        UIText(
                          [task.torque_or_spec, task.safety_warning].filter(Boolean).join(" • ")
                        ).style({
                          color: () => (task.safety_warning ? THEME.statusWarn : THEME.accentCyan),
                          fontSize: 10
                        })
                      ]
                    : [])
                ).style({ flex: 1, gap: 2 })
              ).style({ alignItems: "flex-start", gap: 9, width: "100%" })
            )
              .style({
                width: "100%",
                paddingVertical: 6,
                borderBottomWidth: idx < tasks.length - 1 ? 1 : 0,
                borderBottomColor: () => THEME.borderDefault
              })
              .onClick(() => {
                appState.toggleTaskHandler?.(msg.id, "step", checkId, !task.done);
              });
          })
        ).style({
          backgroundColor: () => THEME.bgSurface,
          borderWidth: 1,
          borderColor: () => THEME.borderDefault,
          borderRadius: 12,
          padding: 12,
          width: "100%",
          gap: 4
        })
      );
    }

    if (inv.length > 0) {
      cards.push(
        UIColumn(
          UIText("Необходимый инструмент и запчасти").style({
            color: () => THEME.statusOk,
            fontSize: 13,
            fontWeight: "bold",
            marginBottom: 4
          }),
          ...inv.map((item, idx) => {
            const checkId = item.id || item.name || String(idx);
            return UIButton(
              UIRow(
                UIBox(
                  LucideIcon("lucide:check", 11, "#ffffff").style({
                    display: item.checked ? "flex" : "none"
                  })
                ).style({
                  width: 19,
                  height: 19,
                  borderRadius: 6,
                  borderWidth: 1.5,
                  borderColor: () => (item.checked ? THEME.statusOk : THEME.borderStrong),
                  backgroundColor: () => (item.checked ? THEME.statusOk : "transparent"),
                  alignItems: "center",
                  justifyContent: "center"
                }),
                UIText(`${item.name}${item.spec ? ` — ${item.spec}` : ""}`).style({
                  color: () => (item.checked ? THEME.textMuted : THEME.textPrimary),
                  fontSize: 12,
                  flex: 1,
                  textDecoration: item.checked ? "line-through" : "none"
                })
              ).style({ alignItems: "center", gap: 8, width: "100%" })
            )
              .style({ width: "100%", paddingVertical: 5 })
              .onClick(() => {
                appState.toggleTaskHandler?.(msg.id, "inventory", checkId, !item.checked);
              });
          })
        ).style({
          backgroundColor: () => THEME.bgSurface,
          borderWidth: 1,
          borderColor: () => THEME.borderDefault,
          borderRadius: 12,
          padding: 12,
          width: "100%",
          gap: 3
        })
      );
    }

    checklistBody.setContent(cards);
  };

  effect(() => {
    const _latest = appState.latestAssistantMessageSignal.value;
    const _all = appState.messagesSignal.value;
    void _latest;
    void _all;
    renderChecklistContent();
  });

  // =========================================================================
  // ВКЛАДКА 2: СЛОВАРЬ КОДОВ ОШИБОК DTC
  // =========================================================================

  let searchDebounce: any = null;
  const runDtcSearch = async (append: boolean = false) => {
    if (append && dtcLoadingMoreSignal.value) return;

    const q = searchQuerySignal.value.trim();
    const sys = systemFilterSignal.value;
    const offset = append ? dtcResultsSignal.value.length : 0;
    const reqId = ++dtcRequestSeq;

    if (!append) {
      const localPage = cacheManager.searchDtcPage(q, sys, 0, 80);
      dtcResultsSignal.value = localPage.items;
      dtcTotalSignal.value = localPage.total;
    } else {
      dtcLoadingMoreSignal.value = true;
    }

    try {
      const page = await apiClient.getDtcPage(q, sys, offset, 80);
      if (reqId !== dtcRequestSeq) return;

      if (!append) {
        dtcResultsSignal.value = page.items;
      } else {
        const existingCodes = new Set(dtcResultsSignal.value.map(x => x.code));
        const nextItems = [...dtcResultsSignal.value];
        for (const item of page.items) {
          if (!existingCodes.has(item.code)) {
            existingCodes.add(item.code);
            nextItems.push(item);
          }
        }
        dtcResultsSignal.value = nextItems;
      }
      dtcTotalSignal.value = Math.max(page.total, dtcResultsSignal.value.length);
      if (page.totalCatalog > 0) {
        dtcTotalCatalogSignal.value = page.totalCatalog;
      }
    } finally {
      if (reqId === dtcRequestSeq) {
        dtcLoadingMoreSignal.value = false;
      }
    }
  };

  const searchInput = UIInput()
    .style({
      placeholder: "Код или симптом (напр. P0300)...",
      placeholderColor: () => THEME.inputPlaceholder,
      backgroundColor: () => THEME.bgInput,
      color: () => THEME.textPrimary,
      borderWidth: 1.5,
      borderColor: () => THEME.borderStrong,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 9,
      fontSize: 13,
      flex: 1
    })
    .onChange((val: string) => {
      searchQuerySignal.value = val;
      if (searchDebounce) clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        void runDtcSearch(false);
      }, 250);
    });

  const filterChip = (label: string, sys: string) => {
    const isAct = () => systemFilterSignal.value === sys;
    return UIButton(
      UIText(label).style({
        color: () => (isAct() ? "#ffffff" : THEME.textSecondary),
        fontSize: 11,
        fontWeight: "bold"
      })
    )
      .style({
        backgroundColor: () => (isAct() ? THEME.accentCyan : THEME.bgElevated),
        borderWidth: 1,
        borderColor: () => (isAct() ? THEME.accentCyan : THEME.borderDefault),
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 6
      })
      .onClick(() => {
        systemFilterSignal.value = sys;
        void runDtcSearch(false);
      });
  };

  const dtcListContainer = UIColumn().style({ width: "100%", gap: 8 });

  const formatOemLine = (oemRaw: any): string => {
    if (!oemRaw) return "";
    const parts: string[] = [];
    if (Array.isArray(oemRaw)) {
      for (let i = 0; i < oemRaw.length && parts.length < 3; i++) {
        const v = oemRaw[i];
        if (!v) continue;
        if (typeof v === "string") parts.push(v.trim());
        else if (typeof v === "object") {
          const make = String(v.make || v.oem || v.brand || "").trim();
          const txt = String(v.description || v.title || v.symptom || v.text || "").trim();
          if (make && txt) parts.push(`${make}: ${txt}`);
          else if (make || txt) parts.push(make || txt);
        }
      }
    } else if (typeof oemRaw === "object") {
      for (const k of Object.keys(oemRaw).slice(0, 3)) {
        const val = oemRaw[k];
        const txt = typeof val === "string" ? val.trim() : val?.description || val?.title || "";
        parts.push(txt ? `${k}: ${txt}` : k);
      }
    }
    return parts.filter(Boolean).join(" • ");
  };

  const renderDtcList = () => {
    const items = dtcResultsSignal.value || [];
    const total = Math.max(dtcTotalSignal.value || 0, items.length);
    if (items.length === 0) {
      dtcListContainer.setContent([
        UIText("Коды не найдены. Попробуйте обновить словарь с сервера или изменить запрос.").style({
          color: () => THEME.textMuted,
          fontSize: 12,
          textAlign: "center",
          padding: 20
        })
      ]);
      return;
    }

    const cards: any[] = items.map(item => {
      const enTitle =
        item.en_title && item.en_title.toLowerCase() !== (item.title || "").toLowerCase()
          ? `EN: ${item.en_title}`
          : "";
      const oemLine = formatOemLine(item.oem_variants);
      const tsbCount =
        item.nhtsa_stats && typeof item.nhtsa_stats === "object"
          ? Number(item.nhtsa_stats.bulletins || item.nhtsa_stats.tsb_count || 0)
          : 0;

      return UIColumn(
        UIRow(
          DtcChip(item.code, () => {
            stageDtcCodes([item.code]);
            callbacks.onSelectCode?.(item.code);
          }),
          UIText(item.title || "Описание ошибки").style({
            color: () => THEME.textPrimary,
            fontSize: 13,
            fontWeight: "bold",
            flex: 1
          }),
          UIButton(
            UIRow(
              LucideIcon("lucide:plus", 12, "#ffffff"),
              UIText("В чат").style({
                color: "#ffffff",
                fontSize: 11,
                fontWeight: "bold"
              })
            ).style({ alignItems: "center", gap: 4 })
          )
            .style({
              backgroundColor: () => THEME.accentOrange,
              paddingHorizontal: 9,
              paddingVertical: 5,
              borderRadius: 7
            })
            .onClick(() => {
              stageDtcCodes([item.code]);
              toast(`Код ${item.code} прикреплён в чат`);
              callbacks.onSelectCode?.(item.code);
            })
        ).style({ alignItems: "center", gap: 8, width: "100%", marginBottom: 4 }),
        ...(item.description && item.description !== item.title
          ? [
              UIText(item.description).style({
                color: () => THEME.textSecondary,
                fontSize: 11,
                lineHeight: 16
              })
            ]
          : []),
        ...(enTitle
          ? [
              UIText(enTitle).style({
                color: () => THEME.textMuted,
                fontSize: 10,
                marginTop: 2
              })
            ]
          : []),
        ...(item.solution
          ? [
              UIText(`Решение: ${item.solution}`).style({
                color: () => THEME.textSecondary,
                fontSize: 11,
                lineHeight: 15,
                marginTop: 2
              })
            ]
          : []),
        ...(oemLine
          ? [
              UIText(`OEM: ${oemLine}`).style({
                color: () => THEME.textMuted,
                fontSize: 10,
                lineHeight: 14,
                marginTop: 2
              })
            ]
          : []),
        ...(tsbCount > 0
          ? [
              UIText(`Сервисные бюллетени: ${tsbCount}`).style({
                color: () => THEME.accentCyan,
                fontSize: 10,
                marginTop: 2
              })
            ]
          : [])
      ).style({
        backgroundColor: () => THEME.bgSurface,
        borderWidth: 1,
        borderColor: () => THEME.borderDefault,
        borderRadius: 11,
        padding: 11,
        width: "100%"
      });
    });

    if (items.length < total) {
      cards.push(
        SecondaryButton(
          () => (dtcLoadingMoreSignal.value ? "Загрузка..." : "Загрузить ещё"),
          () => {
            void runDtcSearch(true);
          },
          "lucide:refresh-cw"
        ).style({ width: "100%", justifyContent: "center", paddingVertical: 10 })
      );
    }

    dtcListContainer.setContent(cards);
  };

  effect(() => {
    const _res = dtcResultsSignal.value;
    const _tot = dtcTotalSignal.value;
    const _more = dtcLoadingMoreSignal.value;
    void _res;
    void _tot;
    void _more;
    renderDtcList();
  });

  const dtcSection = UIColumn(
    UIRow(
      searchInput,
      UIButton(LucideIcon("lucide:refresh-cw", 16, () => THEME.accentCyan))
        .style({
          width: 40,
          height: 40,
          borderRadius: 10,
          backgroundColor: () => THEME.bgElevated,
          borderWidth: 1,
          borderColor: () => THEME.borderDefault,
          alignItems: "center",
          justifyContent: "center"
        })
        .onClick(async () => {
          isSyncingSignal.value = true;
          const cnt = await apiClient.syncDtcDictionary();
          isSyncingSignal.value = false;
          await runDtcSearch(false);
          toast(cnt > 0 ? `Синхронизировано кодов: ${cnt}` : "Словарь актуален");
        })
    ).style({ alignItems: "center", gap: 8, width: "100%" }),

    UIScrollable(
      UIRow(
        filterChip("Все", "all"),
        filterChip("P (ДВС/АКПП)", "P"),
        filterChip("C (Шасси)", "C"),
        filterChip("B (Кузов)", "B"),
        filterChip("U (Сеть CAN)", "U")
      ).style({ gap: 6 })
    ).style({ scrollDirection: "horizontal", showScrollbar: false, width: "100%" }),

    PrimaryButton(
      () => {
        const shown = dtcResultsSignal.value.length;
        const total = Math.max(dtcTotalSignal.value, shown);
        const cat = dtcTotalCatalogSignal.value;
        return cat > total
          ? `Показано ${shown} из ${total} (база: ${cat})`
          : `Показано ${shown} из ${total}`;
      },
      () => {
        void runDtcSearch(false);
      },
      isSyncingSignal
    ).style({ width: "100%" }),

    dtcListContainer
  ).style({
    width: "100%",
    gap: 10,
    display: () => (activeSubTabSignal.value === "dtc" ? "flex" : "none")
  });

  // Инициализация содержимого
  renderChecklistContent();
  renderDtcList();

  return UIColumn(
    header,
    UIRow(
      subTabButton("Чеклист & Инвентарь", "checklist", "lucide:check-check"),
      subTabButton("Словарь DTC", "dtc", "lucide:book-open")
    ).style({
      paddingHorizontal: 12,
      paddingVertical: 8,
      gap: 8,
      backgroundColor: () => THEME.bgSurface,
      borderBottomWidth: 1,
      borderBottomColor: () => THEME.borderDefault,
      width: "100%"
    }),
    UIScrollable(
      UIColumn(
        checklistBody.style({
          display: () => (activeSubTabSignal.value === "checklist" ? "flex" : "none")
        }),
        dtcSection
      ).style({ width: "100%", padding: 12, gap: 10 })
    ).style({ flex: 1, width: "100%", backgroundColor: () => THEME.bgBase })
  ).style({
    flex: 1,
    width: "100%",
    backgroundColor: () => THEME.bgBase
  });
}
