/**
 * Экран «Журнал сессий и история проверок».
 * Сохраняет историю проверок автомобилей, позволяет быстро переключаться между сессиями
 * и просматривать прошлые результаты диагностики даже без подключения к сети.
 * Адаптирован для вертикальных экранов смартфонов.
 * Лицензия: GPL-3.0
 */

import { apiClient } from "../api/BackendApiClient";
import { cacheManager } from "../cache/ResourceCacheManager";
import { DiagnosticSessionItem } from "../types";
import { HeaderBar, PrimaryButton, SecondaryButton } from "./components";

export function createSessionsHistoryScreen(onSelectSession?: (session: DiagnosticSessionItem) => void): any {
  const sessionsSignal = signal<DiagnosticSessionItem[]>(cacheManager.getCachedSessions());
  const isLoadingSignal = signal(false);

  const loadSessions = async () => {
    isLoadingSignal.value = true;
    try {
      const list = await apiClient.getSessions();
      sessionsSignal.value = list;
    } finally {
      isLoadingSignal.value = false;
    }
  };

  const header = HeaderBar(
    "Журнал диагностик",
    "История проверок и сохраненные сессии",
    PrimaryButton("+ Новая", () => {
      if (onSelectSession) {
        onSelectSession({
          id: "new-" + Date.now(),
          title: "Новая диагностика",
          vehicle_info: "",
          created_at: new Date().toLocaleDateString("ru-RU"),
          message_count: 0,
          is_pinned: false
        });
      }
    })
  );

  const renderSessionCard = (s: DiagnosticSessionItem) => {
    return UIColumn(
      UIRow(
        UIText(s.title || "Диагностика").style({
          color: "#ffffff",
          fontSize: 14,
          fontWeight: "bold",
          flex: 1
        }),
        UIText(s.created_at || "Недавно").style({ color: "#64748b", fontSize: 11, marginLeft: 6 })
      ).style({ alignItems: "center", width: "100%" }),

      s.vehicle_info
        ? UIText(`🚗 ${s.vehicle_info}`).style({ color: "#38bdf8", fontSize: 12, marginTop: 4 })
        : null,

      UIRow(
        UIText(`Сообщений: ${s.message_count || 0}`).style({ color: "#94a3b8", fontSize: 11 }),
        UISpacer(),
        onSelectSession
          ? SecondaryButton("Открыть →", () => onSelectSession(s))
          : null
      ).style({ alignItems: "center", marginTop: 8, width: "100%" })
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
      UIRow(
        SecondaryButton(
          () => (isLoadingSignal.value ? "Загрузка..." : "Обновить с сервера"),
          loadSessions
        ),
        UISpacer(),
        UIText(() => `Всего: ${sessionsSignal.value.length} сессий`)
          .style({ color: "#94a3b8", fontSize: 11, alignSelf: "center" })
      ).style({ marginBottom: 12, alignItems: "center", width: "100%" }),

      UIColumn(
        () => {
          const list = sessionsSignal.value;
          if (list.length === 0) {
            return [
              UIColumn(
                UIText("Нет сохраненных сессий.").style({ color: "#64748b", fontSize: 13, textAlign: "center" }),
                UIText("Начните диагностику во вкладке «Диагностика», и результаты сохранятся автоматически.")
                  .style({ color: "#475569", fontSize: 11, textAlign: "center", marginTop: 4 })
              ).style({ paddingVertical: 40, alignItems: "center", width: "100%" })
            ];
          }
          return list.map(s => renderSessionCard(s));
        }
      ).style({ width: "100%" })
    ).style({ padding: 14, maxWidth: 860, alignSelf: "center", width: "100%", paddingBottom: 24 })
  ).style({ flex: 1, width: "100%" });

  return UIScreen(header, scrollBody).style({ backgroundColor: "#0a0f1d", flex: 1, width: "100%", height: "100%" });
}
