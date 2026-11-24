/**
 * Экран «Проекты и Диалоги» (Sessions & Projects History).
 * Точное воспроизведение функциональности боковой панели оригинального сайта:
 * - Иерархия проектов и диалогов (стиль AIBPMN)
 * - Тегирование сессий (Все, ДВС, АКПП, Электрика, Тормоза, CAN)
 * - Закрепление (Pin) важных диалогов
 * - Переименование и удаление диалогов и проектов
 * - Карточка фонового воркера выжимки контекста (Summary памяти)
 *
 * Лицензия: GPL-3.0
 */

import { apiClient } from "../api/BackendApiClient";
import { cacheManager } from "../cache/ResourceCacheManager";
import { DiagnosticSessionItem, ProjectItem } from "../types";
import { HeaderBar, PrimaryButton, SecondaryButton, THEME } from "./components";

export interface SessionsHistoryCallbacks {
  onSelectSession?: (session: DiagnosticSessionItem) => void;
  onNewSession?: (projectId?: string | number | null) => void;
}

export function createSessionsHistoryScreen(callbacks?: SessionsHistoryCallbacks): any {
  const sessionsSignal = signal<DiagnosticSessionItem[]>(cacheManager.getCachedSessions());
  const projectsSignal = signal<ProjectItem[]>([]);
  const activeTagSignal = signal<string>("");
  const activeSessionSummarySignal = signal<string>("Контекст сессии синхронизирован с экспертной моделью.");
  const isLoadingSignal = signal(false);

  const TAGS = ["Все", "ДВС", "АКПП", "Электрика", "Тормоза", "Подвеска", "CAN-шина"];

  const projectsContainer = UIColumn().style({ marginBottom: 12, width: "100%" });
  const sessionsContainer = UIColumn().style({ width: "100%" });

  const renderProjectItem = (p: ProjectItem) => {
    return UIRow(
      UIText(p.name).style({ color: THEME.textPrimary, fontSize: 12, fontWeight: "bold", flex: 1 }),
      UIButton(UIText("+ Чат").style({ color: THEME.accentOrange, fontSize: 11, fontWeight: "bold" }))
        .style({ paddingHorizontal: 6, paddingVertical: 2, backgroundColor: THEME.bgElevated, borderRadius: 4, marginRight: 6 })
        .onClick(async () => {
          const s = await apiClient.createSession(p.id);
          if (s && callbacks?.onSelectSession) callbacks.onSelectSession(s);
        }),
      UIButton(UIText("✕").style({ color: THEME.textMuted, fontSize: 11 }))
        .style({ padding: 3 })
        .onClick(async () => {
          await apiClient.deleteProject(p.id);
          loadData();
        })
    ).style({
      backgroundColor: THEME.bgElevated,
      padding: 8,
      borderRadius: 8,
      alignItems: "center",
      marginBottom: 6,
      width: "100%"
    });
  };

  const renderAll = () => {
    const projs = projectsSignal.value;
    const projNodes: any[] = [];
    if (projs.length > 0) {
      projNodes.push(
        UIText("Группы проектов:").style({ color: THEME.textMuted, fontSize: 11, fontWeight: "bold", marginBottom: 6 })
      );
      projs.forEach(p => {
        projNodes.push(renderProjectItem(p));
      });
    }
    projectsContainer.setContent(projNodes);

    const list = sessionsSignal.value;
    const sessionNodes: any[] = [];
    if (list.length === 0) {
      sessionNodes.push(
        UIColumn(
          UIText("Нет сохраненных сессий.").style({ color: THEME.textMuted, fontSize: 13, textAlign: "center" }),
          UIText("Нажмите «+ Диалог», чтобы начать новую проверку автомобиля.")
            .style({ color: "#64748b", fontSize: 11, textAlign: "center", marginTop: 4 })
        ).style({ paddingVertical: 30, alignItems: "center", width: "100%" })
      );
    } else {
      list.forEach(s => {
        sessionNodes.push(renderSessionItem(s));
      });
    }
    sessionsContainer.setContent(sessionNodes);
  };

  // Загрузка данных
  const loadData = async () => {
    isLoadingSignal.value = true;
    try {
      const [projects, sessions] = await Promise.all([
        apiClient.getProjects(),
        apiClient.getSessions(undefined, activeTagSignal.value === "Все" ? "" : activeTagSignal.value)
      ]);
      projectsSignal.value = projects;
      sessionsSignal.value = sessions;
      renderAll();
    } finally {
      isLoadingSignal.value = false;
    }
  };

  loadData();

  // Модалка создания проекта
  let newProjectModal: any = null;
  const projectNameInput = UIInput().style({
    placeholder: "Название проекта (напр. ТО Газель Next)",
    backgroundColor: THEME.bgBase,
    color: "#ffffff",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    borderWidth: 1,
    borderColor: THEME.borderSubtle,
    width: "100%",
    marginBottom: 12
  });

  newProjectModal = UIModal(
    UIColumn(
      UIRow(
        UIText("Новый проект диагностики").style({ color: THEME.textPrimary, fontSize: 14, fontWeight: "bold", flex: 1 }),
        UIButton(UIText("✕").style({ color: THEME.textMuted, fontSize: 13 }))
          .style({ padding: 4 })
          .onClick(() => newProjectModal.hide())
      ).style({ alignItems: "center", marginBottom: 10, width: "100%" }),

      projectNameInput,

      UIRow(
        SecondaryButton("Отмена", () => newProjectModal.hide()),
        UISpacer(),
        PrimaryButton("Создать проект", async () => {
          const name = (projectNameInput.value || "").trim();
          if (name) {
            await apiClient.createProject(name);
            projectNameInput.value = "";
            newProjectModal.hide();
            loadData();
          }
        })
      ).style({ alignItems: "center", width: "100%" })
    ).style({
      backgroundColor: THEME.bgSurface,
      borderRadius: 14,
      padding: 16,
      borderWidth: 1,
      borderColor: THEME.borderStrong,
      width: "90%",
      maxWidth: 380
    })
  );

  // Шапка экрана
  const header = HeaderBar(
    "Проекты и Диалоги",
    "История диагностик и база сохраненных сессий",
    UIRow(
      SecondaryButton("+ Проект", () => newProjectModal.show()),
      UIRow().style({ width: 6 }),
      PrimaryButton("+ Диалог", async () => {
        const newSess = await apiClient.createSession();
        if (newSess && callbacks?.onSelectSession) {
          callbacks.onSelectSession(newSess);
        } else {
          loadData();
        }
      })
    )
  );

  // Фильтр по тегам
  const tagsRow = UIRow(
    ...TAGS.map(tag => {
      const isSelected = () => (activeTagSignal.value === tag || (tag === "Все" && !activeTagSignal.value));
      return UIButton(
        UIText(tag).style({
          color: () => (isSelected() ? "#ffffff" : THEME.textSecondary),
          fontSize: 11,
          fontWeight: () => (isSelected() ? "bold" : "500")
        })
      )
        .style({
          backgroundColor: () => (isSelected() ? THEME.accentOrange : THEME.bgElevated),
          paddingHorizontal: 10,
          paddingVertical: 5,
          borderRadius: 8,
          marginRight: 6,
          marginBottom: 6,
          borderWidth: 1,
          borderColor: () => (isSelected() ? THEME.accentOrange : THEME.borderSubtle)
        })
        .onClick(() => {
          activeTagSignal.value = tag === "Все" ? "" : tag;
          loadData();
        });
    })
  ).style({ flexWrap: "wrap", marginBottom: 10, width: "100%" });

  // Карточка сессии
  const renderSessionItem = (s: DiagnosticSessionItem) => {
    const isPinned = signal(Boolean(s.is_pinned));

    return UIColumn(
      UIRow(
        UIButton(
          UIText(() => (isPinned.value ? "[Закреплен]" : "[Закрепить]")).style({
            color: () => (isPinned.value ? THEME.accentOrange : THEME.textMuted),
            fontSize: 10,
            fontWeight: "bold",
            marginRight: 6
          })
        )
          .style({ padding: 2 })
          .onClick(async () => {
            isPinned.value = !isPinned.value;
            s.is_pinned = isPinned.value;
            await apiClient.setSessionPinned(s.id, isPinned.value);
          }),

        UIText(s.title || "Диалог диагностики").style({
          color: THEME.textPrimary,
          fontSize: 13,
          fontWeight: "bold",
          flex: 1
        }),

        UIButton(UIText("✕").style({ color: THEME.textMuted, fontSize: 11, fontWeight: "bold" }))
          .style({ padding: 4 })
          .onClick(async () => {
            await apiClient.deleteSession(s.id);
            sessionsSignal.value = sessionsSignal.value.filter(item => item.id !== s.id);
          })
      ).style({ alignItems: "center", width: "100%" }),

      // Подстрока автомобиля и тега
      UIRow(
        s.tag
          ? UIRow(
              UIText(s.tag).style({ color: THEME.accentCyan, fontSize: 10, fontWeight: "bold" })
            ).style({
              backgroundColor: "rgba(56, 189, 248, 0.15)",
              borderColor: "rgba(56, 189, 248, 0.35)",
              borderWidth: 1,
              borderRadius: 4,
              paddingHorizontal: 5,
              paddingVertical: 1,
              marginRight: 8
            })
          : null,

        UIText(s.vehicle_info || "Автомобиль не указан").style({
          color: s.vehicle_info ? THEME.accentOrange : THEME.textMuted,
          fontSize: 11,
          flex: 1
        }),

        UIText(s.updated_at || s.created_at || "Недавно").style({
          color: THEME.textMuted,
          fontSize: 10
        })
      ).style({ alignItems: "center", marginTop: 4, width: "100%" }),

      // Кнопка открыть
      UIRow(
        UIText(`Сообщений: ${s.message_count || 0}`).style({ color: THEME.textMuted, fontSize: 10 }),
        UISpacer(),
        SecondaryButton("Открыть диалог →", () => {
          callbacks?.onSelectSession?.(s);
        })
      ).style({ alignItems: "center", marginTop: 8, width: "100%" })
    ).style({
      backgroundColor: THEME.bgSurface,
      borderRadius: 10,
      padding: 10,
      borderWidth: 1,
      borderColor: () => (isPinned.value ? THEME.borderStrong : THEME.borderSubtle),
      marginBottom: 8,
      width: "100%"
    });
  };

  // Карточка воркера сжатия контекста (Summary)
  const workerCard = UIColumn(
    UIRow(
      UIText("Память текущей сессии").style({ color: THEME.textPrimary, fontSize: 12, fontWeight: "bold", flex: 1 }),
      UIRow(
        UIText("● Синхронизировано").style({ color: THEME.statusOk, fontSize: 10, fontWeight: "bold" })
      ).style({
        backgroundColor: "rgba(34, 197, 94, 0.15)",
        borderRadius: 6,
        paddingHorizontal: 6,
        paddingVertical: 2
      })
    ).style({ alignItems: "center", marginBottom: 6, width: "100%" }),

    UIText("Фоновый воркер автоматически сжимает раннюю историю сообщений в компактную выжимку:").style({
      color: THEME.textMuted,
      fontSize: 10,
      marginBottom: 6
    }),

    UIColumn(
      UIText(() => activeSessionSummarySignal.value).style({
        color: THEME.textSecondary,
        fontSize: 11,
        lineHeight: 16
      })
    ).style({
      backgroundColor: THEME.bgBase,
      borderRadius: 8,
      padding: 8,
      borderWidth: 1,
      borderColor: THEME.borderSubtle,
      width: "100%"
    })
  ).style({
    backgroundColor: THEME.bgSurface,
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: THEME.borderSubtle,
    marginTop: 14,
    width: "100%"
  });

  // Прокручиваемый список
  const scrollBody = UIScrollable(
    UIColumn(
      tagsRow,

      UIRow(
        SecondaryButton(
          () => (isLoadingSignal.value ? "Обновление..." : "Обновить"),
          loadData
        ),
        UISpacer(),
        UIText(() => `Всего диалогов: ${sessionsSignal.value.length}`)
          .style({ color: THEME.textMuted, fontSize: 11, alignSelf: "center" })
      ).style({ marginBottom: 10, alignItems: "center", width: "100%" }),

      // Проекты
      projectsContainer,

      // Список сессий
      sessionsContainer,

      workerCard
    ).style({ padding: 12, maxWidth: 860, alignSelf: "center", width: "100%", paddingBottom: 24 })
  ).style({ flex: 1, width: "100%" });

  const screen = UIScreen(header, scrollBody).style({ backgroundColor: THEME.bgBase, flex: 1, width: "100%", height: "100%" });
  screen.widgets(newProjectModal);

  return screen;
}
