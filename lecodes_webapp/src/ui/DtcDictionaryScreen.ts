/**
 * Экран «Словарь кодов DTC» (Offline-First база знаний неисправностей).
 * Мгновенный поиск по кэшированной базе кодов (0ms latency, работа без интернета).
 * Фильтрация по системам:
 * P (Двигатель и КПП), C (Шасси, ABS, ESP), B (Кузов и салон), U (Сетевые шины CAN).
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
  const searchInput = UIInput("")
    .style({
      backgroundColor: "#131b2e",
      color: "#ffffff",
      borderRadius: 12,
      paddingHorizontal: 16,
      paddingVertical: 12,
      fontSize: 14,
      borderWidth: 1,
      borderColor: "#334155",
      flex: 1
    })
    .placeholder("Поиск по коду (P0300, C0050) или ключевым словам (зажигание, лямбда)...")
    .onChange((val: string) => {
      searchQuerySignal.value = val;
      updateSearch();
    });

  const filterBtn = (label: string, id: string) => {
    return UIButton(
      UIText(label).style({
        color: () => (currentFilterSignal.value === id ? "#ffffff" : "#94a3b8"),
        fontSize: 12,
        fontWeight: "bold"
      })
    )
      .style({
        backgroundColor: () => (currentFilterSignal.value === id ? "#2563eb" : "#131b2e"),
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
        marginRight: 6,
        borderWidth: 1,
        borderColor: () => (currentFilterSignal.value === id ? "#3b82f6" : "#1e293b"),
        $pressed: { opacity: 0.7 }
      })
      .onClick(() => setFilter(id));
  };

  const filterRow = UIRow(
    filterBtn("Все коды", "ALL"),
    filterBtn("P — Двигатель", "P"),
    filterBtn("C — Шасси/ABS", "C"),
    filterBtn("B — Кузов", "B"),
    filterBtn("U — CAN/Сеть", "U")
  ).style({ marginTop: 12, flexWrap: "wrap", gap: 6 });

  // Карточка кода ошибки
  const renderDtcCard = (info: DtcCodeInfo) => {
    const isP = info.code.startsWith("P");
    const accent = isP ? "#f43f5e" : "#eab308";

    return UIColumn(
      UIRow(
        DtcChip(info.code),
        UIText(info.title).style({
          color: "#f8fafc",
          fontSize: 15,
          fontWeight: "bold",
          flex: 1,
          marginLeft: 4
        }),
        UISpacer(),
        onSelectCode
          ? SecondaryButton("В диагностику →", () => onSelectCode(info.code))
          : null
      ).style({ alignItems: "center" }),
      UIText(info.description).style({
        color: "#cbd5e1",
        fontSize: 13,
        lineHeight: 20,
        marginTop: 8
      }),
      info.symptoms && info.symptoms.length > 0
        ? UIRow(
            UIText("Симптомы: ").style({ color: "#f59e0b", fontSize: 12, fontWeight: "bold" }),
            UIText(info.symptoms.join(", ")).style({ color: "#94a3b8", fontSize: 12, flex: 1 })
          ).style({ marginTop: 6 })
        : null,
      info.causes && info.causes.length > 0
        ? UIRow(
            UIText("Возможные причины: ").style({ color: "#10b981", fontSize: 12, fontWeight: "bold" }),
            UIText(info.causes.join(", ")).style({ color: "#94a3b8", fontSize: 12, flex: 1 })
          ).style({ marginTop: 4 })
        : null
    ).style({
      backgroundColor: "#131b2e",
      borderRadius: 14,
      padding: 16,
      borderWidth: 1,
      borderColor: "#1e293b",
      marginBottom: 12
    });
  };

  const scrollContent = UIScrollable(
    UIColumn(
      UIColumn(
        searchInput,
        filterRow
      ).style({ marginBottom: 16 }),
      UIColumn(
        () => {
          const list = resultsSignal.value;
          if (list.length === 0) {
            return UIText("По вашему запросу ничего не найдено в словаре.")
              .style({ color: "#64748b", fontSize: 14, textAlign: "center", paddingVertical: 40 });
          }
          return list.map(c => renderDtcCard(c));
        }
      )
    ).style({ padding: 20, maxWidth: 960, alignSelf: "center", width: "100%" })
  ).style({ flexGrow: 1 });

  return UIScreen(header, scrollContent).style({ backgroundColor: "#0a0f1d", flex: 1 });
}
