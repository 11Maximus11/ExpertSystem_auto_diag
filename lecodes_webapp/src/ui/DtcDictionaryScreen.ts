/**
 * Экран «Словарь кодов DTC» (Offline-First база знаний неисправностей).
 * Мгновенный поиск по кэшированной базе кодов (0ms latency, работа без интернета).
 * Фильтрация по системам:
 * P (Двигатель и КПП), C (Шасси, ABS, ESP), B (Кузов и салон), U (Сетевые шины CAN).
 * Адаптирован для вертикальных экранов смартфонов.
 * Лицензия: GPL-3.0
 */

import { cacheManager } from "../cache/ResourceCacheManager";
import { DtcCodeInfo } from "../types";
import { DtcChip, HeaderBar, PrimaryButton, SecondaryButton } from "./components";

export function createDtcDictionaryScreen(onSelectCode?: (code: string) => void): any {
  const searchQuerySignal = signal("");
  const currentFilterSignal = signal("ALL");

  const resultsSignal = signal<DtcCodeInfo[]>(cacheManager.searchDtc("", "ALL"));

  const updateSearch = () => {
    resultsSignal.value = cacheManager.searchDtc(
      searchQuerySignal.value,
      currentFilterSignal.value
    );
  };

  const setFilter = (sys: string) => {
    currentFilterSignal.value = sys;
    updateSearch();
  };

  const header = HeaderBar(
    "Словарь кодов ошибок DTC",
    "Офлайн-база знаний стандартов OBD-II / SAE J2012"
  );

  // Поле поиска
  const searchInput = UIInput()
    .style({
      placeholder: "Поиск по коду (P0300, C0050) или симптому (пропуски, смесь)...",
      backgroundColor: "#131b2e",
      color: "#ffffff",
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 9,
      fontSize: 13,
      borderWidth: 1,
      borderColor: "#334155",
      flex: 1
    })
    .onChange((val: string) => {
      searchQuerySignal.value = val;
      updateSearch();
    });

  const filterBtn = (label: string, id: string) => {
    return UIButton(
      UIText(label).style({
        color: () => (currentFilterSignal.value === id ? "#ffffff" : "#94a3b8"),
        fontSize: 11,
        fontWeight: "bold"
      })
    )
      .style({
        backgroundColor: () => (currentFilterSignal.value === id ? "#2563eb" : "#131b2e"),
        borderRadius: 6,
        paddingHorizontal: 10,
        paddingVertical: 6,
        marginRight: 4,
        marginBottom: 4,
        borderWidth: 1,
        borderColor: () => (currentFilterSignal.value === id ? "#3b82f6" : "#1e293b"),
        $pressed: { opacity: 0.7 }
      })
      .onClick(() => setFilter(id));
  };

  const filterRow = UIRow(
    filterBtn("Все коды", "ALL"),
    filterBtn("P — ДВС", "P"),
    filterBtn("C — Шасси/ABS", "C"),
    filterBtn("B — Кузов", "B"),
    filterBtn("U — CAN/Сеть", "U")
  ).style({ marginTop: 8, flexWrap: "wrap", gap: 4, width: "100%" });

  // Карточка кода ошибки
  const renderDtcCard = (info: DtcCodeInfo) => {
    return UIColumn(
      UIRow(
        DtcChip(info.code),
        UIText(info.title).style({
          color: "#f8fafc",
          fontSize: 13,
          fontWeight: "bold",
          flex: 1,
          marginLeft: 4,
          lineHeight: 18
        })
      ).style({ alignItems: "center", width: "100%", marginBottom: 6 }),

      UIText(info.description).style({
        color: "#cbd5e1",
        fontSize: 12,
        lineHeight: 18,
        marginBottom: 6
      }),

      info.symptoms && info.symptoms.length > 0
        ? UIColumn(
            UIText("Симптомы:").style({ color: "#f59e0b", fontSize: 11, fontWeight: "bold" }),
            UIText(info.symptoms.join(" • ")).style({ color: "#94a3b8", fontSize: 11, lineHeight: 16, marginTop: 2 })
          ).style({ marginTop: 4, marginBottom: 4 })
        : null,

      info.causes && info.causes.length > 0
        ? UIColumn(
            UIText("Возможные причины:").style({ color: "#38bdf8", fontSize: 11, fontWeight: "bold" }),
            UIText(info.causes.join(" • ")).style({ color: "#94a3b8", fontSize: 11, lineHeight: 16, marginTop: 2 })
          ).style({ marginTop: 4, marginBottom: 6 })
        : null,

      onSelectCode
        ? UIRow(
            UISpacer(),
            SecondaryButton("В диагностику →", () => onSelectCode(info.code))
          ).style({ width: "100%", marginTop: 4 })
        : null
    ).style({
      backgroundColor: "#131b2e",
      borderRadius: 12,
      padding: 12,
      borderWidth: 1,
      borderColor: "#1e293b",
      marginBottom: 10,
      width: "100%"
    });
  };

  const scrollBody = UIScrollable(
    UIColumn(
      UIRow(searchInput).style({ width: "100%" }),
      filterRow,
      UIRow().style({ height: 10 }),
      UIColumn(
        () => {
          const list = resultsSignal.value;
          if (list.length === 0) {
            return [
              UIColumn(
                UIText("Кодов не найдено.").style({ color: "#64748b", fontSize: 13, textAlign: "center" }),
                UIText("Попробуйте другой поисковый запрос или сбросьте фильтр систем.")
                  .style({ color: "#475569", fontSize: 11, textAlign: "center", marginTop: 4 }),
                PrimaryButton("Показать все коды", () => {
                  searchQuerySignal.value = "";
                  if (searchInput) searchInput.value = "";
                  setFilter("ALL");
                })
              ).style({ paddingVertical: 30, alignItems: "center", width: "100%" })
            ];
          }
          return list.map(item => renderDtcCard(item));
        }
      ).style({ width: "100%" })
    ).style({ padding: 14, maxWidth: 860, alignSelf: "center", width: "100%", paddingBottom: 24 })
  ).style({ flex: 1, width: "100%" });

  return UIScreen(header, scrollBody).style({ backgroundColor: "#0a0f1d", flex: 1, width: "100%", height: "100%" });
}
