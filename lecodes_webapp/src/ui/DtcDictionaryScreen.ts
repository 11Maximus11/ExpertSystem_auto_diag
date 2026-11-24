/**
 * Экран «Инспектор: Чеклист ремонта & Словарь DTC» (Inspector Panel).
 * Точное воспроизведение двух вкладок оригинального инспектора:
 * 1. Вкладка «Чеклист & Инвентарь»:
 *    - Сводный список всех шагов диагностики и ремонта
 *    - Прогресс-бар выполнения (N из M шагов)
 *    - Инструменты, динамометрические ключи, спецприспособления и запчасти
 * 2. Вкладка «Словарь кодов DTC»:
 *    - Полнотекстовый поиск (код, симптом, решение)
 *    - Фильтры по системам P (ДВС/КПП), C (Шасси/ABS), B (Кузов), U (Сеть CAN)
 *    - Кнопка «+ В запрос» для мгновенного прикрепления кода в чат
 *
 * Лицензия: GPL-3.0
 */

import { apiClient } from "../api/BackendApiClient";
import { cacheManager } from "../cache/ResourceCacheManager";
import { ChatRepairTask, DtcCodeInfo } from "../types";
import { DtcChip, HeaderBar, PrimaryButton, SecondaryButton, THEME } from "./components";

export function createDtcDictionaryScreen(onSelectCode?: (code: string) => void): any {
  const activeTabSignal = signal<"checklist" | "dtc">("dtc");

  // Состояние словаря DTC
  const searchQuerySignal = signal("");
  const currentFilterSignal = signal("ALL");
  const resultsSignal = signal<DtcCodeInfo[]>(cacheManager.searchDtc("", "ALL"));

  // Состояние общего чеклиста текущего ремонта
  const checklistTasksSignal = signal<ChatRepairTask[]>([
    { text: "Подключить сканер ELM327 в диагностический разъем OBD-II", done: true },
    { text: "Считать подтвержденные и ожидающие коды ошибок (Mode 03/07)", done: true },
    { text: "Проверить показания датчиков температуры ОЖ и положения дросселя", done: false },
    { text: "Проверить давление топлива в рампе манометром (норма 3.8-4.2 бар)", done: false },
    { text: "Осмотреть высоковольтные провода и индивидуальные катушки зажигания", done: false }
  ]);

  const inventoryItemsSignal = signal<string[]>([
    "Сканер OBD-II ELM327 Bluetooth/USB",
    "Мультиметр цифровой с токовыми клещами",
    "Манометр давления топлива со штуцерами",
    "Свечной ключ 16 мм с резиновым фиксатором",
    "Очиститель дроссельной заслонки и ДМРВ"
  ]);

  const dtcCardsContainer = UIColumn().style({ width: "100%" });

  const renderDtcCards = () => {
    const list = resultsSignal.value;
    const cards: any[] = [];
    if (list.length === 0) {
      cards.push(
        UIColumn(
          UIText("Кодов не найдено.").style({ color: THEME.textMuted, fontSize: 13, textAlign: "center" }),
          UIText("Попробуйте другой поисковый запрос или сбросьте фильтр систем.")
            .style({ color: "#64748b", fontSize: 11, textAlign: "center", marginTop: 4 }),
          PrimaryButton("Сбросить фильтр", () => {
            searchQuerySignal.value = "";
            if (searchInput) searchInput.value = "";
            setFilter("ALL");
          })
        ).style({ paddingVertical: 30, alignItems: "center", width: "100%" })
      );
    } else {
      list.forEach(item => {
        cards.push(renderDtcCard(item));
      });
    }
    dtcCardsContainer.setContent(cards);
  };

  const updateSearch = () => {
    resultsSignal.value = cacheManager.searchDtc(
      searchQuerySignal.value,
      currentFilterSignal.value
    );
    renderDtcCards();
  };

  const setFilter = (sys: string) => {
    currentFilterSignal.value = sys;
    updateSearch();
  };

  // Шапка экрана с переключателем режимов Инспектора
  const tabBtn = (label: string, id: "checklist" | "dtc") => {
    const isSelected = () => activeTabSignal.value === id;
    return UIButton(
      UIText(label).style({
        color: () => (isSelected() ? "#ffffff" : THEME.textMuted),
        fontSize: 12,
        fontWeight: "bold"
      })
    )
      .style({
        backgroundColor: () => (isSelected() ? THEME.accentOrange : "transparent"),
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 8,
        marginRight: 6
      })
      .onClick(() => {
        activeTabSignal.value = id;
      });
  };

  const inspectorTabsRow = UIRow(
    tabBtn("Словарь DTC", "dtc"),
    tabBtn("Чеклист & Инвентарь", "checklist")
  ).style({
    backgroundColor: THEME.bgElevated,
    padding: 3,
    borderRadius: 10,
    alignItems: "center"
  });

  const header = HeaderBar(
    "Инспектор диагностики",
    "Чеклисты ремонта, база кодов DTC и нормативы",
    inspectorTabsRow
  );

  // =========================================================================
  // Режим 1: Чеклист & Инвентарь
  // =========================================================================
  const renderChecklistPane = () => {
    const tasks = checklistTasksSignal.value;
    const doneCount = tasks.filter(t => t.done).length;
    const totalCount = tasks.length;
    const progressPercent = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

    const taskRows = tasks.map((task, idx) => {
      const isDone = signal(Boolean(task.done));

      return UIButton(
        UIRow(
          UIRow(
            UIText(() => (isDone.value ? "✓" : "")).style({
              color: "#ffffff",
              fontSize: 12,
              fontWeight: "bold"
            })
          ).style({
            width: 20,
            height: 20,
            borderRadius: 5,
            backgroundColor: () => (isDone.value ? THEME.statusOk : "transparent"),
            borderWidth: 1.5,
            borderColor: () => (isDone.value ? THEME.statusOk : THEME.textMuted),
            alignItems: "center",
            justifyContent: "center",
            marginRight: 10
          }),
          UIText(task.text).style({
            color: () => (isDone.value ? THEME.textMuted : THEME.textPrimary),
            fontSize: 13,
            textDecorationLine: () => (isDone.value ? "line-through" : "none"),
            flex: 1
          })
        ).style({ alignItems: "flex-start", width: "100%" })
      )
        .style({ paddingVertical: 6, width: "100%", $pressed: { opacity: 0.7 } })
        .onClick(() => {
          isDone.value = !isDone.value;
          task.done = isDone.value;
        });
    });

    const inventoryChips = inventoryItemsSignal.value.map(item =>
      UIRow(
        UIText(`• ${item}`).style({ color: THEME.textPrimary, fontSize: 11, fontWeight: "500" })
      ).style({
        backgroundColor: "rgba(34, 197, 94, 0.12)",
        borderColor: "rgba(34, 197, 94, 0.35)",
        borderWidth: 1,
        borderRadius: 6,
        paddingHorizontal: 8,
        paddingVertical: 5,
        marginRight: 6,
        marginBottom: 6
      })
    );

    return UIColumn(
      // Прогресс
      UIColumn(
        UIRow(
          UIText("Выполнение плана проверки:").style({ color: THEME.textPrimary, fontSize: 13, fontWeight: "bold", flex: 1 }),
          UIText(`${doneCount} из ${totalCount} (${progressPercent}%)`).style({ color: THEME.accentOrange, fontSize: 12, fontWeight: "bold" })
        ).style({ alignItems: "center", width: "100%", marginBottom: 8 }),

        UIRow(
          UIRow().style({
            height: 6,
            borderRadius: 3,
            backgroundColor: THEME.statusOk,
            width: `${progressPercent}%`
          })
        ).style({
          height: 6,
          borderRadius: 3,
          backgroundColor: THEME.bgBase,
          width: "100%",
          overflow: "hidden"
        })
      ).style({
        backgroundColor: THEME.bgSurface,
        borderRadius: 12,
        padding: 12,
        borderWidth: 1,
        borderColor: THEME.borderSubtle,
        marginBottom: 12,
        width: "100%"
      }),

      // Список задач
      UIColumn(
        UIText("Диагностические и ремонтные манипуляции:").style({ color: THEME.statusWarn, fontSize: 12, fontWeight: "bold", marginBottom: 8 }),
        ...taskRows
      ).style({
        backgroundColor: THEME.bgSurface,
        borderRadius: 12,
        padding: 14,
        borderWidth: 1,
        borderColor: THEME.borderSubtle,
        marginBottom: 12,
        width: "100%"
      }),

      // Инструменты и запчасти
      UIColumn(
        UIText("Необходимый инструмент и запчасти:").style({ color: THEME.statusOk, fontSize: 12, fontWeight: "bold", marginBottom: 8 }),
        UIRow(...inventoryChips).style({ flexWrap: "wrap", width: "100%" })
      ).style({
        backgroundColor: THEME.bgSurface,
        borderRadius: 12,
        padding: 14,
        borderWidth: 1,
        borderColor: THEME.borderSubtle,
        width: "100%"
      })
    );
  };

  // =========================================================================
  // Режим 2: Словарь кодов DTC
  // =========================================================================
  const searchInput = UIInput()
    .style({
      placeholder: "Поиск по коду (P0300, C0050) или симптому (пропуски, смесь)...",
      backgroundColor: THEME.bgElevated,
      color: "#ffffff",
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 9,
      fontSize: 13,
      borderWidth: 1,
      borderColor: THEME.borderSubtle,
      flex: 1
    })
    .onChange((val: string) => {
      searchQuerySignal.value = val;
      updateSearch();
    });

  const filterBtn = (label: string, id: string) => {
    const isSelected = () => currentFilterSignal.value === id;
    return UIButton(
      UIText(label).style({
        color: () => (isSelected() ? "#ffffff" : THEME.textMuted),
        fontSize: 11,
        fontWeight: "bold"
      })
    )
      .style({
        backgroundColor: () => (isSelected() ? THEME.accentOrange : THEME.bgElevated),
        borderRadius: 6,
        paddingHorizontal: 10,
        paddingVertical: 6,
        marginRight: 4,
        marginBottom: 4,
        borderWidth: 1,
        borderColor: () => (isSelected() ? THEME.accentOrange : THEME.borderSubtle),
        $pressed: { opacity: 0.7 }
      })
      .onClick(() => setFilter(id));
  };

  const filterRow = UIRow(
    filterBtn("Все коды", "ALL"),
    filterBtn("P — ДВС/КПП", "P"),
    filterBtn("C — Шасси/ABS", "C"),
    filterBtn("B — Кузов", "B"),
    filterBtn("U — Сеть CAN", "U")
  ).style({ marginTop: 8, flexWrap: "wrap", width: "100%" });

  const renderDtcCard = (info: DtcCodeInfo) => {
    return UIColumn(
      UIRow(
        DtcChip(info.code),
        UIText(info.title).style({
          color: THEME.textPrimary,
          fontSize: 13,
          fontWeight: "bold",
          flex: 1,
          marginLeft: 4,
          lineHeight: 18
        })
      ).style({ alignItems: "center", width: "100%", marginBottom: 6 }),

      UIText(info.description).style({
        color: THEME.textSecondary,
        fontSize: 12,
        lineHeight: 18,
        marginBottom: 6
      }),

      info.symptoms && info.symptoms.length > 0
        ? UIColumn(
            UIText("Симптомы:").style({ color: THEME.statusWarn, fontSize: 11, fontWeight: "bold" }),
            UIText(info.symptoms.join(" • ")).style({ color: THEME.textMuted, fontSize: 11, lineHeight: 16, marginTop: 2 })
          ).style({ marginTop: 4, marginBottom: 4 })
        : null,

      info.causes && info.causes.length > 0
        ? UIColumn(
            UIText("Возможные причины:").style({ color: THEME.accentCyan, fontSize: 11, fontWeight: "bold" }),
            UIText(info.causes.join(" • ")).style({ color: THEME.textMuted, fontSize: 11, lineHeight: 16, marginTop: 2 })
          ).style({ marginTop: 4, marginBottom: 6 })
        : null,

      UIRow(
        UISpacer(),
        SecondaryButton("+ В запрос чата", () => {
          onSelectCode?.(info.code);
        })
      ).style({ width: "100%", marginTop: 4 })
    ).style({
      backgroundColor: THEME.bgSurface,
      borderRadius: 12,
      padding: 12,
      borderWidth: 1,
      borderColor: THEME.borderSubtle,
      marginBottom: 10,
      width: "100%"
    });
  };

  const renderDtcPane = () => {
    return UIColumn(
      UIRow(searchInput).style({ width: "100%" }),
      filterRow,
      UIRow().style({ height: 10 }),
      dtcCardsContainer
    );
  };

  const checklistPane = renderChecklistPane().style({
    display: () => (activeTabSignal.value === "checklist" ? "flex" : "none"),
    width: "100%"
  });

  const dtcPane = renderDtcPane().style({
    display: () => (activeTabSignal.value === "dtc" ? "flex" : "none"),
    width: "100%"
  });

  // Первоначальный рендер карточек
  renderDtcCards();

  const scrollBody = UIScrollable(
    UIColumn(
      checklistPane,
      dtcPane
    ).style({ padding: 12, maxWidth: 860, alignSelf: "center", width: "100%", paddingBottom: 24 })
  ).style({ flex: 1, width: "100%" });

  return UIScreen(header, scrollBody).style({ backgroundColor: THEME.bgBase, flex: 1, width: "100%", height: "100%" });
}
