/**
 * Экран «Журнал сессий и история проверок».
 * Сохраняет историю проверок автомобилей, позволяет быстро переключаться между сессиями
 * и просматривать прошлые результаты диагностики даже без подключения к сети.
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
    "История проверок, сохраненные сессии и профили автомобилей",
    PrimaryButton("+ Новая сессия", () => {
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
          fontSize: 16,
          fontWeight: "bold",
          flex: 1
        }),
        UISpacer(),
        UIText(s.created_at || "Сегодня").style({ color: "#64748b", fontSize: 12 })
      ),
      s.vehicle_info
        ? UIText(`Авто: ${s.vehicle_info}`).style({ color: "#38bdf8", fontSize: 13, marginTop: 4 })
        : null,
      UIRow(
        UIText(`Сообщений в диалоге: ${s.message_count || 0}`).style({ color: "#94a3b8", fontSize: 12 }),
        UISpacer(),
        onSelectSession
          ? SecondaryButton("Открыть →", () => onSelectSession(s))
          : null
      ).style({ alignItems: "center", marginTop: 10 })
    ).style({
      backgroundColor: "#131b2e",
      borderRadius: 14,
      padding: 16,
      borderWidth: 1,
      borderColor: "#1e293b",
      marginBottom: 12
    });
  };

  const scrollBody = UIScrollable(
    UIColumn(
      UIRow(
        SecondaryButton("Обновить список с сервера", loadSessions),
        UISpacer(),
        UIText(() => (isLoadingSignal.value ? "Загрузка..." : `Всего сессий: ${sessionsSignal.value.length}`))
          .style({ color: "#94a3b8", fontSize: 12, alignSelf: "center" })
      ).style({ marginBottom: 16, alignItems: "center" }),
      UIColumn(
        () => {
          const list = sessionsSignal.value;
          if (list.length === 0) {
            return UIColumn(
              UIText("Нет сохраненных сессий.").style({ color: "#64748b", fontSize: 14, textAlign: "center" }),
              UIText("Начните диагностику во вкладке «Диагностика», и результаты сохранятся автоматически.")
                .style({ color: "#475569", fontSize: 12, textAlign: "center", marginTop: 6 })
            ).style({ paddingVertical: 40 });
          }
          return list.map(s => renderSessionCard(s));
        }
      )
    ).style({ padding: 20, maxWidth: 860, alignSelf: "center", width: "100%" })
  ).style({ flexGrow: 1 });

  return UIScreen(header, scrollBody).style({ backgroundColor: "#0a0f1d", flex: 1 });
}
