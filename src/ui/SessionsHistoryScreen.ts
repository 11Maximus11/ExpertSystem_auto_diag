// ИИдеал Авто — Локальные проекты, история сессий и память диалогов (2026-11-28)
// Copyright (C) 2026 ИИдеал Авто (LeCodes48 Edition)
// Licensed under the GNU General Public License v3.0 (GPL-3.0).

import {
  appState,
  createNewSession,
  deleteSessionById,
  reloadSessionsFromDb,
  selectSession,
} from "../state/appState";
import { localDb } from "../storage/LocalDatabase";
import type { DiagnosticSessionItem, ProjectItem } from "../types";
import {
  AppHeader,
  LucideIcon,
  openBackupRestoreModal,
  openConfirmModal,
  openTextPromptModal,
  PrimaryButton,
  SecondaryButton,
  StatusBadge,
  THEME,
} from "./components";

export interface SessionsHistoryCallbacks {
  onOpenSession?: (sessionId: string) => void;
  onOpenAr?: () => void;

  onOpenSettings?: () => void;
}

const SESSION_TAGS = ["all", "ДВС", "АКПП", "Электрика", "Тормоза", "Подвеска"];

export function createSessionsHistoryScreen(callbacks?: SessionsHistoryCallbacks): any {
  const filterQuerySignal = signal<string>("");
  const filterTagSignal = signal<string>("all");
  const filterProjectIdSignal = signal<string>("all");

  const searchInput = UIInput()
    .named("sessions-search-input")
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
      placeholder: "Поиск по названию, авто или тегу...",
      placeholderColor: () => THEME.inputPlaceholder,
    })
    .onChange((val: string) => {
      filterQuerySignal.value = val;
    });

  const projectsContainer = UIRow(() => {
    const projects: ProjectItem[] = appState.projectsSignal.value || [];
    const sessions: DiagnosticSessionItem[] = appState.sessionsSignal.value || [];
    const projId = filterProjectIdSignal.value;
    void appState.settingsSignal.value.theme_mode;

    const projChips: any[] = [
      UIButton(
        UIText(`Все (${sessions.length})`).style({
          color: () => (projId === "all" ? "#ffffff" : THEME.textSecondary),
          fontSize: 11,
          fontWeight: "600",
        })
      )
        .style({
          backgroundColor: () => (projId === "all" ? THEME.accentCyan : THEME.bgInput),
          borderWidth: 1,
          borderColor: () => (projId === "all" ? THEME.accentCyan : THEME.borderDefault),
          borderRadius: 9,
          paddingHorizontal: 10,
          paddingVertical: 5,
        })
        .onClick(() => {
          filterProjectIdSignal.value = "all";
        }),
    ];

    for (const p of projects) {
      const isSelected = projId === p.id;
      projChips.push(
        UIRow(
          UIButton(
            UIText(p.name).style({
              color: () => (isSelected ? "#ffffff" : THEME.textSecondary),
              fontSize: 11,
              fontWeight: "600",
            })
          )
            .style({ paddingHorizontal: 8, paddingVertical: 5 })
            .onClick(() => {
              filterProjectIdSignal.value = isSelected ? "all" : p.id;
            }),
          UIButton(LucideIcon("lucide:x", 11, () => (isSelected ? "#ffffff" : THEME.textMuted)))
            .style({ paddingRight: 6, paddingVertical: 5 })
            .onClick(() => {
              openConfirmModal({
                title: `Удалить проект «${p.name}»?`,
                message: "Сессии внутри останутся в общем списке без привязки к проекту.",
                confirmLabel: "Удалить",
                danger: true,
                onConfirm: () => {
                  localDb.deleteProject(p.id);
                  if (filterProjectIdSignal.value === p.id) filterProjectIdSignal.value = "all";
                  reloadSessionsFromDb();
                },
              });
            })
        ).style({
          backgroundColor: () => (isSelected ? THEME.accentOrange : THEME.bgInput),
          borderWidth: 1,
          borderColor: () => (isSelected ? THEME.accentOrange : THEME.borderDefault),
          borderRadius: 9,
          alignItems: "center",
        })
      );
    }
    return projChips;
  }).style({ flexWrap: "wrap", gap: 6, width: "100%" });

  const summaryCardHost = UIColumn(() => {
    const sessions: DiagnosticSessionItem[] = appState.sessionsSignal.value || [];
    const activeSid = appState.currentSessionIdSignal.value;
    void appState.settingsSignal.value.theme_mode;
    const curSession = sessions.find((s) => s.id === activeSid);
    if (!curSession) return [];
    return [
      UIColumn(
        UIRow(
          LucideIcon("lucide:cpu", 15, () => THEME.accentCyan),
          UIText("ПАМЯТЬ АКТИВНОЙ СЕССИИ").style({
            color: () => THEME.accentCyan,
            fontSize: 11,
            fontWeight: "bold",
            flex: 1,
          }),
          SecondaryButton(
            "Править",
            () => {
              openTextPromptModal({
                title: "Сводка памяти текущей сессии",
                initialValue: curSession.summary || "",
                placeholder: "Краткие факты: автомобиль, коды DTC, что уже проверено...",
                confirmLabel: "Сохранить",
                multiline: true,
                onConfirm: (val) => {
                  localDb.updateSession(curSession.id, { summary: val.trim() });
                  reloadSessionsFromDb();
                  toast("Память сессии обновлена");
                },
              });
            },
            "lucide:edit-3"
          )
        ).style({ width: "100%", alignItems: "center", gap: 6 }),
        UIText(
          curSession.summary?.trim() ||
            "Сводка формируется автоматически после диагностических ответов ИИ."
        ).style({
          color: () => (curSession.summary?.trim() ? THEME.textSecondary : THEME.textMuted),
          fontSize: 12,
        })
      ).style({
        backgroundColor: () => THEME.bgSurface,
        borderRadius: 14,
        padding: 12,
        borderWidth: 1,
        borderColor: () => THEME.borderDefault,
        gap: 6,
      }),
    ];
  }).style({ width: "100%" });

  const sessionsContainer = UIColumn(() => {
    const sessions: DiagnosticSessionItem[] = appState.sessionsSignal.value || [];
    const activeSid = appState.currentSessionIdSignal.value;
    const q = filterQuerySignal.value.trim().toLowerCase();
    const tag = filterTagSignal.value;
    const projId = filterProjectIdSignal.value;
    void appState.sessionsRefreshCounterSignal.value;
    void appState.settingsSignal.value.theme_mode;

    const filtered = sessions
      .filter((s) => {
        if (projId !== "all" && s.project_id !== projId) return false;
        if (tag !== "all" && (s.tag || "") !== tag) return false;
        if (q) {
          const hay = `${s.title} ${s.vehicle_info} ${s.tag} ${s.summary}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => Number(Boolean(b.is_pinned)) - Number(Boolean(a.is_pinned)));

    if (filtered.length === 0) {
      return [
        UIText("Сессии по выбранным фильтрам не найдены.").style({
          color: () => THEME.textMuted,
          fontSize: 12,
          padding: 16,
          textAlign: "center",
        }),
      ];
    }

    return filtered.map((s) => {
      const isCurrent = s.id === activeSid;
      return UIColumn(
        UIRow(
          ...(s.is_pinned ? [LucideIcon("lucide:pin", 14, () => THEME.accentOrange)] : []),
          UIText(s.title || "Диагностика").style({
            color: () => THEME.textPrimary,
            fontSize: 13,
            fontWeight: "bold",
            flex: 1,
          }),
          ...(isCurrent ? [StatusBadge("ok", "Активна")] : []),
          ...(s.tag ? [StatusBadge("info", s.tag)] : [])
        ).style({ width: "100%", alignItems: "center", gap: 6 }),

        UIText(
          `${s.vehicle_info || "Авто не указано"} • Сообщений: ${s.message_count || 0}`
        ).style({
          color: () => THEME.textMuted,
          fontSize: 11,
        }),

        UIRow(
          PrimaryButton(
            isCurrent ? "Открыть чат" : "Выбрать",
            () => {
              selectSession(s.id);
              callbacks?.onOpenSession?.(s.id);
            },
            "lucide:message-square"
          ),
          UIButton(
            LucideIcon("lucide:pin", 14, () =>
              s.is_pinned ? THEME.accentOrange : THEME.textMuted
            )
          )
            .style({
              width: 34,
              height: 34,
              borderRadius: 9,
              backgroundColor: () => THEME.bgInput,
              borderWidth: 1,
              borderColor: () => THEME.borderDefault,
              alignItems: "center",
              justifyContent: "center",
            })
            .onClick(() => {
              localDb.updateSession(s.id, { is_pinned: !s.is_pinned });
              reloadSessionsFromDb();
            }),
          UIButton(LucideIcon("lucide:edit-3", 14, () => THEME.accentCyan))
            .style({
              width: 34,
              height: 34,
              borderRadius: 9,
              backgroundColor: () => THEME.bgInput,
              borderWidth: 1,
              borderColor: () => THEME.borderDefault,
              alignItems: "center",
              justifyContent: "center",
            })
            .onClick(() => {
              openTextPromptModal({
                title: "Переименовать сессию",
                initialValue: s.title,
                confirmLabel: "Сохранить",
                onConfirm: (nextTitle) => {
                  if (nextTitle.trim()) {
                    localDb.updateSession(s.id, { title: nextTitle.trim() });
                    if (s.id === appState.currentSessionIdSignal.value) {
                      appState.currentSessionTitleSignal.value = nextTitle.trim();
                    }
                    reloadSessionsFromDb();
                  }
                },
              });
            }),
          UIButton(LucideIcon("lucide:trash-2", 14, () => THEME.statusCrit))
            .style({
              width: 34,
              height: 34,
              borderRadius: 9,
              backgroundColor: () => THEME.bgInput,
              borderWidth: 1,
              borderColor: () => THEME.borderDefault,
              alignItems: "center",
              justifyContent: "center",
            })
            .onClick(() => {
              openConfirmModal({
                title: `Удалить сессию «${s.title}»?`,
                message: "Вся переписка и чеклисты этой сессии будут удалены с устройства.",
                confirmLabel: "Удалить",
                danger: true,
                onConfirm: () => deleteSessionById(s.id),
              });
            })
        ).style({ width: "100%", gap: 6, alignItems: "center", marginTop: 4 })
      ).style({
        backgroundColor: () => THEME.bgSurface,
        borderRadius: 14,
        padding: 12,
        borderWidth: 1,
        borderColor: () => (isCurrent ? THEME.accentOrange : THEME.borderDefault),
        gap: 6,
      });
    });
  }).style({ width: "100%", gap: 8 });

  const scrollBody = UIScrollable(
    UIColumn(
      // Верхние действия: Новая сессия, Новый проект, Бэкап БД
      UIRow(
        PrimaryButton(
          "Новая сессия",
          () => {
            const proj =
              filterProjectIdSignal.value !== "all" ? filterProjectIdSignal.value : null;
            const sid = createNewSession("Новая диагностика", proj);
            callbacks?.onOpenSession?.(sid);
          },
          "lucide:plus"
        ).named("sessions-btn-new"),
        SecondaryButton(
          "Проект",
          () => {
            openTextPromptModal({
              title: "Новый проект / автомобиль",
              placeholder: "Например: Skoda Octavia A7 • Клиент Алексей",
              confirmLabel: "Создать",
              onConfirm: (name) => {
                if (name.trim()) {
                  localDb.createProject(name.trim());
                  reloadSessionsFromDb();
                  toast(`Проект «${name.trim()}» создан`);
                }
              },
            });
          },
          "lucide:folder-plus"
        ),
        SecondaryButton(
          "Бэкап",
          () => openBackupRestoreModal(() => reloadSessionsFromDb()),
          "lucide:download"
        )
      ).style({ flexWrap: "wrap", gap: 6, width: "100%" }),

      searchInput,

      // Проекты
      UIColumn(
        UIText("ПРОЕКТЫ И АВТОМОБИЛИ").style({
          color: () => THEME.textMuted,
          fontSize: 10,
          fontWeight: "bold",
        }),
        projectsContainer
      ).style({ gap: 6, width: "100%" }),

      // Теги
      UIScrollable(
        UIRow(
          ...SESSION_TAGS.map((t) =>
            UIButton(
              UIText(t === "all" ? "Все теги" : t).style({
                color: () => (filterTagSignal.value === t ? "#ffffff" : THEME.textSecondary),
                fontSize: 11,
                fontWeight: "600",
              })
            )
              .style({
                backgroundColor: () =>
                  filterTagSignal.value === t ? THEME.accentOrange : THEME.bgSurface,
                borderWidth: 1,
                borderColor: () =>
                  filterTagSignal.value === t ? THEME.accentOrange : THEME.borderDefault,
                borderRadius: 9,
                paddingHorizontal: 10,
                paddingVertical: 5,
              })
              .onClick(() => {
                filterTagSignal.value = t;
              })
          )
        ).style({ gap: 6 })
      ).style({ scrollDirection: "horizontal", width: "100%", height: 34 }),

      summaryCardHost,
      sessionsContainer
    ).style({
      width: "100%",
      paddingHorizontal: 12,
      paddingTop: 8,
      paddingBottom: 18,
      gap: 10,
    })
  ).style({ flex: 1, width: "100%" });

  return UIColumn(
    AppHeader({
      title: "ПРОЕКТЫ И СЕССИИ",
      onOpenAr: callbacks?.onOpenAr,

      onOpenSettings: callbacks?.onOpenSettings,
    }),
    scrollBody
  )
    .named("sessions")
    .style({
      flex: 1,
      width: "100%",
      backgroundColor: () => THEME.bgBase,
    });
}
