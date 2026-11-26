/**
 * Экран проектов, сессий диагностики и памяти текущей сессии.
 * 100% паритет с боковым меню сайта:
 * - Создание / переименование / удаление проектов
 * - Создание / открытие / переименование / закрепление / тегирование / удаление сессий
 * - Поиск и фильтрация сессий по тегам ("ДВС", "АКПП", "Электрика", и т.д.)
 * - Работа как с облачным сервером (авторизован), так и локально в Демо-режиме
 * - Просмотр и редактирование сжатой памяти текущей сессии (worker summary)
 *
 * Лицензия: GPL-3.0
 */

import { apiClient } from "../api/BackendApiClient";
import { cacheManager } from "../cache/ResourceCacheManager";
import { appState, createWelcomeMessage, generateUuidV4 } from "../state/appState";
import { DiagnosticSessionItem, ProjectItem } from "../types";
import {
  AppHeader,
  LucideIcon,
  openConfirmModal,
  openTextPromptModal,
  PrimaryButton,
  SecondaryButton,
  StatusBadge,
  THEME
} from "./components";

export interface SessionsHistoryCallbacks {
  onOpenSession?: (sessionId: string) => void;
  onOpenAr?: () => void;
  onOpenSettings?: () => void;
}

export function createSessionsHistoryScreen(callbacks?: SessionsHistoryCallbacks): any {
  const projectsSignal = signal<ProjectItem[]>([]);
  const sessionsSignal = signal<DiagnosticSessionItem[]>([]);
  const filterTagSignal = signal<string>("all");
  const filterQuerySignal = signal<string>("");
  const summaryEditSignal = signal<string>(appState.sessionSummarySignal.value || "");
  const isLoadingSignal = signal<boolean>(false);

  const TAG_OPTIONS = ["all", "ДВС", "АКПП", "Электрика", "Тормоза", "Подвеска", "CAN-шина"];

  const header = AppHeader({
    title: "ИИДЕАЛ АВТО",
    onOpenAr: () => callbacks?.onOpenAr?.(),
    onOpenSettings: () => callbacks?.onOpenSettings?.()
  });

  const summaryInput = UITextArea()
    .style({
      placeholder: "Здесь сохраняется автоматическая сжатая выжимка контекста текущего диалога...",
      placeholderColor: () => THEME.inputPlaceholder,
      backgroundColor: () => THEME.bgInput,
      color: () => THEME.textPrimary,
      borderWidth: 1.5,
      borderColor: () => THEME.borderStrong,
      borderRadius: 9,
      padding: 10,
      fontSize: 12,
      minHeight: 72,
      maxHeight: 150,
      width: "100%"
    })
    .onChange((val: string) => {
      summaryEditSignal.value = val;
    });

  effect(() => {
    const s = appState.sessionSummarySignal.value || "";
    summaryEditSignal.value = s;
    summaryInput.value = s;
  });

  const refreshData = async () => {
    isLoadingSignal.value = true;
    try {
      if (!appState.currentUserSignal.value.is_authenticated) {
        projectsSignal.value = appState.demoProjectsSignal.value;
        sessionsSignal.value = appState.demoSessionsSignal.value;
        return;
      }
      const [projs, sess] = await Promise.all([
        apiClient.getProjects(),
        apiClient.getSessions()
      ]);
      projectsSignal.value = projs;
      sessionsSignal.value = sess;
    } finally {
      isLoadingSignal.value = false;
    }
  };

  effect(() => {
    const _tick = appState.sessionsRefreshCounterSignal.value;
    const _auth = appState.currentUserSignal.value.is_authenticated;
    const _user = appState.currentUserSignal.value.username;
    void _tick;
    void _auth;
    void _user;
    void refreshData();
  });

  const openSessionDialog = async (session: DiagnosticSessionItem) => {
    appState.currentSessionIdSignal.value = session.id;
    appState.currentSessionTitleSignal.value = session.title;
    appState.selectedMessageIdsSignal.value = [];
    cacheManager.saveSetting("active_session_id", session.id);

    if (!appState.currentUserSignal.value.is_authenticated) {
      const savedMsgs = appState.demoMessagesBySession[session.id] || [createWelcomeMessage()];
      appState.messagesSignal.value = savedMsgs;
      const lastAi = [...savedMsgs].reverse().find(m => m.role === "assistant") || savedMsgs[0];
      appState.latestAssistantMessageSignal.value = lastAi;
      appState.vehicleSignal.value = session.vehicle_info || appState.vehicleSignal.value;
      appState.sessionSummarySignal.value = session.summary || "";
      callbacks?.onOpenSession?.(session.id);
      return;
    }

    toast("Загрузка диалога...");
    const detail = await apiClient.getSessionDetail(session.id);
    if (detail) {
      appState.currentSessionTitleSignal.value = detail.title;
      appState.vehicleSignal.value = detail.vehicle_info || "";
      appState.sessionSummarySignal.value = detail.summary || "";
      if (detail.worker_status) {
        appState.workerStatusSignal.value = detail.worker_status;
      }
      const msgs = detail.messages.length > 0 ? detail.messages : [createWelcomeMessage()];
      appState.messagesSignal.value = msgs;
      const lastAi = [...msgs].reverse().find(m => m.role === "assistant") || msgs[0];
      appState.latestAssistantMessageSignal.value = lastAi;
      callbacks?.onOpenSession?.(session.id);
    } else {
      const msgs = await apiClient.getSessionMessages(session.id);
      appState.messagesSignal.value = msgs.length > 0 ? msgs : [createWelcomeMessage()];
      callbacks?.onOpenSession?.(session.id);
    }
  };

  const handleCreateProject = () => {
    openTextPromptModal({
      title: "Новый проект / автомобиль",
      subtitle: "Группируйте диагностики по одному автомобилю или заказ-наряду",
      placeholder: "Например: BMW E60 M54 — капремонт",
      confirmLabel: "Создать",
      onConfirm: async name => {
        if (!name) return;
        if (!appState.currentUserSignal.value.is_authenticated) {
          const p: ProjectItem = { id: "demo-p-" + Date.now(), name };
          appState.demoProjectsSignal.value = [p, ...appState.demoProjectsSignal.value];
          await refreshData();
          return;
        }
        const created = await apiClient.createProject(name);
        if (created) {
          await refreshData();
          toast("Проект создан");
        } else {
          toast("Не удалось создать проект");
        }
      }
    });
  };

  const handleCreateSession = async (projectId: string | number | null = null) => {
    const title = "Диагностика #" + (sessionsSignal.value.length + 1);
    const welcome = createWelcomeMessage();
    if (!appState.currentUserSignal.value.is_authenticated) {
      const id = generateUuidV4();
      const s: DiagnosticSessionItem = {
        id,
        title,
        project_id: projectId,
        tag: "",
        is_pinned: false,
        vehicle_info: appState.vehicleSignal.value,
        summary: "",
        updated_at: "Сейчас",
        message_count: 0
      };
      appState.demoMessagesBySession[id] = [welcome];
      appState.demoSessionsSignal.value = [s, ...appState.demoSessionsSignal.value];
      await refreshData();
      await openSessionDialog(s);
      return;
    }

    const created = await apiClient.createSession(projectId, title, appState.vehicleSignal.value);
    if (created) {
      await refreshData();
      await openSessionDialog(created);
    } else {
      toast("Ошибка создания диалога");
    }
  };

  const searchInput = UIInput()
    .style({
      placeholder: "Поиск диалога или авто...",
      placeholderColor: () => THEME.inputPlaceholder,
      backgroundColor: () => THEME.bgInput,
      color: () => THEME.textPrimary,
      borderWidth: 1.5,
      borderColor: () => THEME.borderStrong,
      borderRadius: 9,
      paddingHorizontal: 11,
      paddingVertical: 8,
      fontSize: 12,
      flex: 1
    })
    .onChange((val: string) => {
      filterQuerySignal.value = val;
    });

  const contentListContainer = UIColumn().style({ width: "100%", gap: 10 });

  const renderSessionRow = (s: DiagnosticSessionItem) => {
    const isActive = s.id === appState.currentSessionIdSignal.value;
    return UIColumn(
      UIRow(
        LucideIcon(s.is_pinned ? "lucide:pin" : "lucide:message-square-plus", 15, () =>
          s.is_pinned ? THEME.accentOrange : THEME.accentCyan
        ),
        UIColumn(
          UIText(s.title || "Диагностика").style({
            color: () => THEME.textPrimary,
            fontSize: 13,
            fontWeight: "bold",
            lineClamp: 1
          }),
          UIText(
            [
              s.vehicle_info || "",
              s.tag ? `#${s.tag}` : "",
              s.updated_at || ""
            ]
              .filter(Boolean)
              .join(" • ")
          ).style({
            color: () => THEME.textMuted,
            fontSize: 10,
            lineClamp: 1
          })
        ).style({ flex: 1, gap: 2 }),
        ...(isActive
          ? [
              UIBox(
                UIText("Активен").style({
                  color: "#ffffff",
                  fontSize: 9,
                  fontWeight: "bold"
                })
              ).style({
                backgroundColor: () => THEME.statusOk,
                paddingHorizontal: 6,
                paddingVertical: 2,
                borderRadius: 5
              })
            ]
          : [])
      ).style({ alignItems: "center", gap: 8, width: "100%", marginBottom: 6 }),

      UIRow(
        PrimaryButton("Открыть", () => {
          void openSessionDialog(s);
        }),
        UIButton(LucideIcon("lucide:pin", 14, () => (s.is_pinned ? THEME.accentOrange : THEME.textSecondary)))
          .style({
            width: 32,
            height: 32,
            borderRadius: 8,
            backgroundColor: () => THEME.bgElevated,
            borderWidth: 1,
            borderColor: () => THEME.borderDefault,
            alignItems: "center",
            justifyContent: "center"
          })
          .onClick(async () => {
            if (!appState.currentUserSignal.value.is_authenticated) {
              appState.demoSessionsSignal.value = appState.demoSessionsSignal.value.map(d =>
                d.id === s.id ? { ...d, is_pinned: !d.is_pinned } : d
              );
            } else {
              await apiClient.setSessionPinned(s.id, !s.is_pinned);
            }
            await refreshData();
          }),
        UIButton(LucideIcon("lucide:pencil", 14, () => THEME.textSecondary))
          .style({
            width: 32,
            height: 32,
            borderRadius: 8,
            backgroundColor: () => THEME.bgElevated,
            borderWidth: 1,
            borderColor: () => THEME.borderDefault,
            alignItems: "center",
            justifyContent: "center"
          })
          .onClick(() => {
            openTextPromptModal({
              title: "Переименовать диалог",
              initialValue: s.title,
              onConfirm: async val => {
                if (!val) return;
                if (!appState.currentUserSignal.value.is_authenticated) {
                  appState.demoSessionsSignal.value = appState.demoSessionsSignal.value.map(d =>
                    d.id === s.id ? { ...d, title: val } : d
                  );
                } else {
                  await apiClient.renameSession(s.id, val);
                }
                if (isActive) appState.currentSessionTitleSignal.value = val;
                await refreshData();
              }
            });
          }),
        UIButton(LucideIcon("lucide:tag", 14, () => THEME.accentCyan))
          .style({
            width: 32,
            height: 32,
            borderRadius: 8,
            backgroundColor: () => THEME.bgElevated,
            borderWidth: 1,
            borderColor: () => THEME.borderDefault,
            alignItems: "center",
            justifyContent: "center"
          })
          .onClick(() => {
            openTextPromptModal({
              title: "Тег диалога",
              initialValue: s.tag || "",
              quickChips: ["ДВС", "АКПП", "Электрика", "Тормоза", "Подвеска", "CAN-шина"],
              onConfirm: async val => {
                if (!appState.currentUserSignal.value.is_authenticated) {
                  appState.demoSessionsSignal.value = appState.demoSessionsSignal.value.map(d =>
                    d.id === s.id ? { ...d, tag: val } : d
                  );
                } else {
                  await apiClient.setSessionTag(s.id, val);
                }
                await refreshData();
              }
            });
          }),
        UIButton(LucideIcon("lucide:trash-2", 14, () => THEME.statusCrit))
          .style({
            width: 32,
            height: 32,
            borderRadius: 8,
            backgroundColor: "rgba(239, 68, 68, 0.14)",
            borderWidth: 1,
            borderColor: "rgba(239, 68, 68, 0.35)",
            alignItems: "center",
            justifyContent: "center"
          })
          .onClick(() => {
            openConfirmModal({
              title: "Удалить диалог?",
              message: `Диалог «${s.title}» будет удалён без возможности восстановления.`,
              confirmLabel: "Удалить",
              onConfirm: async () => {
                const wasActive = s.id === appState.currentSessionIdSignal.value;
                if (!appState.currentUserSignal.value.is_authenticated) {
                  delete appState.demoMessagesBySession[s.id];
                  const remaining = appState.demoSessionsSignal.value.filter(d => d.id !== s.id);
                  if (remaining.length === 0) {
                    const freshId = generateUuidV4();
                    const freshSession: DiagnosticSessionItem = {
                      id: freshId,
                      title: "Демо-диагностика",
                      is_pinned: false,
                      tag: "",
                      project_id: null,
                      vehicle_info: "",
                      summary: "",
                      updated_at: "Сейчас",
                      message_count: 0
                    };
                    appState.demoSessionsSignal.value = [freshSession];
                    appState.currentSessionIdSignal.value = freshId;
                    appState.currentSessionTitleSignal.value = freshSession.title;
                    appState.sessionSummarySignal.value = "";
                    appState.messagesSignal.value = [createWelcomeMessage()];
                    appState.latestAssistantMessageSignal.value = null;
                  } else {
                    appState.demoSessionsSignal.value = remaining;
                    if (wasActive) {
                      const nextSess = remaining[0];
                      const nextMsgs = appState.demoMessagesBySession[nextSess.id] || [createWelcomeMessage()];
                      appState.currentSessionIdSignal.value = nextSess.id;
                      appState.currentSessionTitleSignal.value = nextSess.title;
                      appState.sessionSummarySignal.value = nextSess.summary || "";
                      appState.messagesSignal.value = nextMsgs;
                      appState.latestAssistantMessageSignal.value =
                        [...nextMsgs].reverse().find(m => m.role === "assistant") || null;
                    }
                  }
                } else {
                  const res = await apiClient.deleteSession(s.id);
                  if (res.active_session_id) {
                    appState.currentSessionIdSignal.value = res.active_session_id;
                    cacheManager.saveSetting("active_session_id", res.active_session_id);
                    if (wasActive) {
                      const detail = await apiClient.getSessionDetail(res.active_session_id);
                      if (detail) {
                        appState.currentSessionTitleSignal.value = detail.title;
                        appState.vehicleSignal.value = detail.vehicle_info || "";
                        appState.sessionSummarySignal.value = detail.summary || "";
                        const msgs = detail.messages.length > 0 ? detail.messages : [createWelcomeMessage()];
                        appState.messagesSignal.value = msgs;
                        appState.latestAssistantMessageSignal.value =
                          [...msgs].reverse().find(m => m.role === "assistant") || msgs[0];
                      }
                    }
                  } else if (wasActive) {
                    appState.sessionSummarySignal.value = "";
                    appState.messagesSignal.value = [createWelcomeMessage()];
                    appState.latestAssistantMessageSignal.value = null;
                  }
                }
                await refreshData();
                toast("Диалог удалён");
              }
            });
          })
      ).style({ alignItems: "center", gap: 6, width: "100%" })
    ).style({
      backgroundColor: () => THEME.bgSurface,
      borderWidth: isActive ? 1.5 : 1,
      borderColor: () => (isActive ? THEME.accentOrange : THEME.borderDefault),
      borderRadius: 11,
      padding: 10,
      width: "100%"
    });
  };

  const renderLists = () => {
    const q = filterQuerySignal.value.trim().toLowerCase();
    const t = filterTagSignal.value;

    const filteredSessions = [...sessionsSignal.value]
      .sort((a, b) => Number(Boolean(b.is_pinned)) - Number(Boolean(a.is_pinned)))
      .filter(s => {
        if (t !== "all" && (s.tag || "").toLowerCase() !== t.toLowerCase()) return false;
        if (q) {
          const hay = `${s.title} ${s.vehicle_info || ""} ${s.tag || ""}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });

    const blocks: any[] = [];

    // Секция проектов (папки)
    if (projectsSignal.value.length > 0) {
      blocks.push(
        UIText("Проекты (Группы авто)").style({
          color: () => THEME.accentCyan,
          fontSize: 12,
          fontWeight: "bold"
        })
      );

      for (const proj of projectsSignal.value) {
        const projSessions = filteredSessions.filter(s => String(s.project_id) === String(proj.id));
        blocks.push(
          UIColumn(
            UIRow(
              LucideIcon("lucide:folder-clock", 16, () => THEME.accentOrange),
              UIText(proj.name).style({
                color: () => THEME.textPrimary,
                fontSize: 13,
                fontWeight: "bold",
                flex: 1
              }),
              UIButton(LucideIcon("lucide:plus", 15, () => THEME.accentCyan))
                .style({ padding: 4 })
                .onClick(() => {
                  void handleCreateSession(proj.id);
                }),
              UIButton(LucideIcon("lucide:pencil", 14, () => THEME.textMuted))
                .style({ padding: 4 })
                .onClick(() => {
                  openTextPromptModal({
                    title: "Переименовать проект",
                    initialValue: proj.name,
                    onConfirm: async val => {
                      if (!val) return;
                      if (!appState.currentUserSignal.value.is_authenticated) {
                        appState.demoProjectsSignal.value = appState.demoProjectsSignal.value.map(p =>
                          p.id === proj.id ? { ...p, name: val } : p
                        );
                      } else {
                        await apiClient.renameProject(proj.id, val);
                      }
                      await refreshData();
                    }
                  });
                }),
              UIButton(LucideIcon("lucide:trash-2", 14, () => THEME.statusCrit))
                .style({ padding: 4 })
                .onClick(() => {
                  openConfirmModal({
                    title: "Удалить проект?",
                    message: `Проект «${proj.name}» будет удалён.`,
                    confirmLabel: "Удалить",
                    onConfirm: async () => {
                      if (!appState.currentUserSignal.value.is_authenticated) {
                        appState.demoProjectsSignal.value = appState.demoProjectsSignal.value.filter(
                          p => p.id !== proj.id
                        );
                      } else {
                        await apiClient.deleteProject(proj.id);
                      }
                      await refreshData();
                    }
                  });
                })
            ).style({ alignItems: "center", gap: 6, width: "100%" }),
            ...(projSessions.length > 0
              ? projSessions.map(renderSessionRow)
              : [
                  UIText("В проекте пока нет диалогов — нажмите + чтобы создать").style({
                    color: () => THEME.textMuted,
                    fontSize: 11,
                    paddingLeft: 4
                  })
                ])
          ).style({
            backgroundColor: () => THEME.bgElevated,
            borderWidth: 1,
            borderColor: () => THEME.borderDefault,
            borderRadius: 12,
            padding: 10,
            gap: 8,
            width: "100%"
          })
        );
      }
    }

    // Одиночные сессии
    const standalone = filteredSessions.filter(s => !s.project_id);
    blocks.push(
      UIText("Диалоги диагностики").style({
        color: () => THEME.textPrimary,
        fontSize: 13,
        fontWeight: "bold",
        marginTop: 2
      })
    );

    if (standalone.length === 0) {
      blocks.push(
        UIText("Диалоги не найдены. Нажмите «+ Чат» чтобы начать новую диагностику.").style({
          color: () => THEME.textMuted,
          fontSize: 12,
          paddingVertical: 10
        })
      );
    } else {
      for (const s of standalone) {
        blocks.push(renderSessionRow(s));
      }
    }

    contentListContainer.setContent(blocks);
  };

  effect(() => {
    const _p = projectsSignal.value;
    const _s = sessionsSignal.value;
    const _t = filterTagSignal.value;
    const _q = filterQuerySignal.value;
    const _cur = appState.currentSessionIdSignal.value;
    void _p;
    void _s;
    void _t;
    void _q;
    void _cur;
    renderLists();
  });

  // Карточка сжатой памяти текущей сессии
  const sessionMemoryCard = UIColumn(
    UIRow(
      LucideIcon("lucide:cpu", 16, () => THEME.accentCyan),
      UIText("Память текущей сессии").style({
        color: () => THEME.textPrimary,
        fontSize: 13,
        fontWeight: "bold",
        flex: 1
      }),
      StatusBadge(
        () =>
          appState.workerStatusSignal.value === "running"
            ? "warn"
            : appState.workerStatusSignal.value === "completed"
              ? "ok"
              : "idle",
        () =>
          appState.workerStatusSignal.value === "running"
            ? "Сжатие..."
            : appState.workerStatusSignal.value === "completed"
              ? "Актуально"
              : "Готов"
      )
    ).style({ alignItems: "center", gap: 6, width: "100%", marginBottom: 6 }),
    summaryInput,
    UIRow(
      UISpacer(),
      SecondaryButton(
        "Сохранить выжимку",
        async () => {
          const val = (summaryInput.value || summaryEditSignal.value || "").trim();
          appState.sessionSummarySignal.value = val;
          if (appState.currentUserSignal.value.is_authenticated) {
            const ok = await apiClient.setSessionSummary(
              appState.currentSessionIdSignal.value,
              val
            );
            toast(ok ? "Память сессии сохранена" : "Ошибка сохранения");
          } else {
            toast("Сохранено локально");
          }
        },
        "lucide:check"
      )
    ).style({ width: "100%", marginTop: 8 })
  ).style({
    backgroundColor: () => THEME.bgSurface,
    borderWidth: 1,
    borderColor: () => THEME.borderDefault,
    borderRadius: 14,
    padding: 13,
    width: "100%"
  });

  renderLists();

  return UIColumn(
    header,
    UIScrollable(
      UIColumn(
        // Инфобаннер гостевого режима
        UIRow(
          LucideIcon("lucide:user", 15, () => THEME.accentOrange),
          UIText("Гостевой режим: войти для облачного хранения можно в Настройках").style({
            color: () => THEME.textSecondary,
            fontSize: 11,
            flex: 1
          }),
          SecondaryButton("Войти", () => callbacks?.onOpenSettings?.())
        ).style({
          backgroundColor: "rgba(234, 88, 12, 0.1)",
          borderWidth: 1,
          borderColor: "rgba(234, 88, 12, 0.35)",
          borderRadius: 11,
          paddingHorizontal: 10,
          paddingVertical: 8,
          alignItems: "center",
          gap: 8,
          width: "100%",
          display: () => (!appState.currentUserSignal.value.is_authenticated ? "flex" : "none")
        }),

        // Панель создания и обновления
        UIRow(
          PrimaryButton("+ Чат", () => {
            void handleCreateSession(null);
          }),
          SecondaryButton("+ Проект", handleCreateProject, "lucide:folder-plus"),
          UISpacer(),
          UIButton(LucideIcon("lucide:refresh-cw", 16, () => THEME.accentCyan))
            .style({
              width: 36,
              height: 36,
              borderRadius: 9,
              backgroundColor: () => THEME.bgElevated,
              borderWidth: 1,
              borderColor: () => THEME.borderDefault,
              alignItems: "center",
              justifyContent: "center"
            })
            .onClick(() => {
              void refreshData();
            })
        ).style({ alignItems: "center", gap: 8, width: "100%" }),

        // Поиск + фильтры по тегам
        UIRow(searchInput).style({ width: "100%" }),

        UIScrollable(
          UIRow(
            ...TAG_OPTIONS.map(tag => {
              const label = tag === "all" ? "Все теги" : `#${tag}`;
              const act = () => filterTagSignal.value === tag;
              return UIButton(
                UIText(label).style({
                  color: () => (act() ? "#ffffff" : THEME.textSecondary),
                  fontSize: 11,
                  fontWeight: "600"
                })
              )
                .style({
                  backgroundColor: () => (act() ? THEME.accentOrange : THEME.bgElevated),
                  borderWidth: 1,
                  borderColor: () => (act() ? THEME.accentOrange : THEME.borderDefault),
                  borderRadius: 8,
                  paddingHorizontal: 9,
                  paddingVertical: 5
                })
                .onClick(() => {
                  filterTagSignal.value = tag;
                });
            })
          ).style({ gap: 6 })
        ).style({ scrollDirection: "horizontal", showScrollbar: false, width: "100%" }),

        contentListContainer,
        sessionMemoryCard
      ).style({ width: "100%", padding: 12, gap: 10 })
    ).style({ flex: 1, width: "100%", backgroundColor: () => THEME.bgBase })
  ).style({
    flex: 1,
    width: "100%",
    backgroundColor: () => THEME.bgBase
  });
}
