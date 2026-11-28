// ИИдеал Авто — Настройки, единая архитектура LeCodes AI + Локальный RAG и бэкапы (2026-11-28)
// Copyright (C) 2026 ИИдеал Авто (LeCodes48 Edition)
// Licensed under the GNU General Public License v3.0 (GPL-3.0).

import { externalDisplayBridge } from "../ar/ExternalDisplayBridge";
import {
  appState,
  reloadSessionsFromDb,
  updateSettingsPatch,
} from "../state/appState";
import { createWelcomeMessage, localDb } from "../storage/LocalDatabase";
import {
  AppHeader,
  currentThemeSignal,
  LucideIcon,
  openBackupRestoreModal,
  openConfirmModal,
  openDataLossWarningModal,
  openTextPromptModal,
  PrimaryButton,
  SecondaryButton,
  StatusBadge,
  THEME,
  toggleTheme,
} from "./components";

export interface SettingsScreenCallbacks {
  onOpenAr?: () => void;
}

export function createSettingsScreen(callbacks?: SettingsScreenCallbacks): any {
  const tapCountSignal = signal<number>(0);
  const statsSignal = signal(localDb.getStorageStats());

  effect(() => {
    void appState.sessionsRefreshCounterSignal.value;
    void appState.messagesSignal.value;
    statsSignal.value = localDb.getStorageStats();
  });

  const scrollBody = UIScrollable(
    UIColumn(
      // 1. Внешний вид и интерфейс
      UIColumn(
        UIRow(
          LucideIcon("lucide:sun", 17, () => THEME.accentOrange),
          UIText("ТЕМА ОФОРМЛЕНИЯ").style({
            color: () => THEME.textPrimary,
            fontSize: 13,
            fontWeight: "bold",
            flex: 1,
          }),
          SecondaryButton(
            () => (currentThemeSignal.value === "dark" ? "Тёмная" : "Светлая"),
            () => toggleTheme(),
            "lucide:refresh-cw"
          ).named("settings-btn-theme")
        ).style({ width: "100%", alignItems: "center", gap: 8 }),
        UIText(
          "Оптимизировано для гаражных условий (OLED Dark) и дневного осмотра авто."
        ).style({
          color: () => THEME.textMuted,
          fontSize: 11,
        })
      ).style({
        backgroundColor: () => THEME.bgSurface,
        borderRadius: 14,
        padding: 12,
        borderWidth: 1,
        borderColor: () => THEME.borderDefault,
        gap: 6,
      }),

      // 2. Единая архитектура ИИ и RAG
      UIColumn(
        UIRow(
          LucideIcon("lucide:sparkles", 17, () => THEME.accentCyan),
          UIText("ДВИЖОК ИИ-ДИАГНОСТИКИ").style({
            color: () => THEME.textPrimary,
            fontSize: 13,
            fontWeight: "bold",
            flex: 1,
          }),
          StatusBadge("ok", "Активен")
        ).style({ width: "100%", alignItems: "center", gap: 8 }),

        UIColumn(
          UIText("• Основная LLM: Встроенный онлайн-ИИ платформы le.codes").style({
            color: () => THEME.textPrimary,
            fontSize: 12,
            fontWeight: "600",
          }),
          UIText(
            "Все текстовые запросы, фотографии (Чат / AR / VR / галерея), голосовые сообщения (ГС), акустика ДВС и документы направляются напрямую в облачную модель le.codes без ручной настройки ключей."
          ).style({
            color: () => THEME.textSecondary,
            fontSize: 11,
            lineHeight: 16,
          }),
          UIText("• RAG-движок: Локальный Hybrid RAG на устройстве (12 141 DTC)").style({
            color: () => THEME.accentCyan,
            fontSize: 12,
            fontWeight: "600",
            marginTop: 4,
          }),
          UIText(
            "Поиск кодов неисправностей, симптомов и эталонов телеметрии выполняется мгновенно локально на телефоне, после чего собранный технический контекст передаётся в онлайн LLM."
          ).style({
            color: () => THEME.textMuted,
            fontSize: 11,
            lineHeight: 16,
          })
        ).style({
          width: "100%",
          backgroundColor: () => THEME.bgInput,
          borderRadius: 10,
          padding: 10,
          borderWidth: 1,
          borderColor: () => THEME.accentCyan,
          gap: 4,
        })
      ).style({
        backgroundColor: () => THEME.bgSurface,
        borderRadius: 14,
        padding: 12,
        borderWidth: 1,
        borderColor: () => THEME.borderDefault,
        gap: 8,
      }),

      // 3. Междиалоговая память
      UIColumn(
        UIRow(
          LucideIcon("lucide:cpu", 17, () => THEME.accentViolet),
          UIText("МЕЖДИАЛОГОВАЯ ПАМЯТЬ ИИ").style({
            color: () => THEME.textPrimary,
            fontSize: 13,
            fontWeight: "bold",
            flex: 1,
          }),
          SecondaryButton(
            () =>
              appState.settingsSignal.value.cross_dialog_memory_enabled
                ? "ВКЛ"
                : "ВЫКЛ",
            () => {
              const cur = appState.settingsSignal.value.cross_dialog_memory_enabled;
              updateSettingsPatch({ cross_dialog_memory_enabled: !cur });
            }
          ).named("settings-btn-crossmem")
        ).style({ width: "100%", alignItems: "center", gap: 8 }),
        UIText(() =>
          appState.settingsSignal.value.global_memory_summary?.trim() ||
          "Глобальная сводка по обслуживанию авто пока пуста."
        ).style({
          color: () => THEME.textSecondary,
          fontSize: 11,
        }),
        UIRow(
          SecondaryButton(
            "Редактировать",
            () => {
              openTextPromptModal({
                title: "Глобальная память по автомобилям",
                initialValue: appState.settingsSignal.value.global_memory_summary || "",
                placeholder:
                  "Например: Основной авто — Skoda Octavia A7 1.4 TSI, свечи менялись 15 тыс. назад...",
                confirmLabel: "Сохранить",
                multiline: true,
                onConfirm: (val) => {
                  updateSettingsPatch({ global_memory_summary: val.trim() });
                  toast("Глобальная память обновлена");
                },
              });
            },
            "lucide:edit-3"
          ),
          SecondaryButton(
            "Очистить",
            () => {
              updateSettingsPatch({ global_memory_summary: "" });
              toast("Глобальная память очищена");
            },
            "lucide:trash-2"
          )
        ).style({ gap: 8 })
      ).style({
        backgroundColor: () => THEME.bgSurface,
        borderRadius: 14,
        padding: 12,
        borderWidth: 1,
        borderColor: () => THEME.borderDefault,
        gap: 8,
      }),

      // 4. Локальная БД, предупреждение и резервные копии
      UIColumn(
        UIRow(
          LucideIcon("lucide:shield-alert", 17, () => THEME.statusWarn),
          UIText("ЛОКАЛЬНОЕ ХРАНИЛИЩЕ И БЭКАП").style({
            color: () => THEME.textPrimary,
            fontSize: 13,
            fontWeight: "bold",
            flex: 1,
          })
        ).style({ width: "100%", alignItems: "center", gap: 8 }),
        UIText(
          () =>
            `Проектов: ${statsSignal.value.projects} • Сессий: ${statsSignal.value.sessions} • Сообщений: ${statsSignal.value.totalMessages}`
        ).style({
          color: () => THEME.accentCyan,
          fontSize: 11,
          fontWeight: "600",
        }),
        UIText(
          "Все переписки и база знаний хранятся в памяти телефона. При удалении приложения локальная база данных будет удалена — регулярно делайте резервную копию."
        ).style({
          color: () => THEME.textMuted,
          fontSize: 11,
        }),
        UIRow(
          PrimaryButton(
            "Резервная копия / Импорт",
            () => openBackupRestoreModal(() => reloadSessionsFromDb())
          ).named("settings-btn-backup"),
          SecondaryButton(
            "Памятка",
            () => openDataLossWarningModal(true),
            "lucide:info"
          )
        ).style({ flexWrap: "wrap", gap: 8 }),
        SecondaryButton(
          "Сбросить все локальные чаты",
          () => {
            openConfirmModal({
              title: "Удалить все сессии и проекты?",
              message:
                "Все локальные переписки будут стерты без возможности восстановления, если нет файла бэкапа.",
              confirmLabel: "Удалить всё",
              danger: true,
              onConfirm: () => {
                localDb.saveProjects([]);
                localDb.saveSessions([]);
                const fresh = localDb.createSession(null, "Первичная проверка", "");
                localDb.saveMessages(fresh.id, [createWelcomeMessage()]);
                reloadSessionsFromDb();
                appState.currentSessionIdSignal.value = fresh.id;
                appState.currentSessionTitleSignal.value = fresh.title;
                appState.messagesSignal.value = [createWelcomeMessage()];
                toast("Локальная база очищена");
              },
            });
          },
          "lucide:trash-2"
        )
      ).style({
        backgroundColor: () => THEME.bgSurface,
        borderRadius: 14,
        padding: 12,
        borderWidth: 1,
        borderColor: () => THEME.borderDefault,
        gap: 8,
      }),

      // 5. Аппаратные модули и версия (скрытое Dev-меню по 10 тапам)
      UIButton(
        UIColumn(
          UIRow(
            UIText("ИИДЕАЛ АВТО • v1.0.0 (LeCodes48)").style({
              color: () => THEME.textPrimary,
              fontSize: 12,
              fontWeight: "bold",
              flex: 1,
            }),
            StatusBadge("ok", "12 141 DTC")
          ).style({ width: "100%", alignItems: "center" }),
          UIText(
            () =>
              `AR HUD: ${
                externalDisplayBridge.connectedSignal.value
                  ? "Внешние очки подключены"
                  : "Телефон AR/VR"
              } • Камера: ${UICameraNode?.supported ? "Нативная OK" : "Выбор фото"} • Запросов ИИ: ${
                appState.aiCallCountSignal.value
              }`
          ).style({
            color: () => THEME.textMuted,
            fontSize: 11,
          }),
          ...(appState.devModeUnlockedSignal.value
            ? [
                UIText(
                  `[DEV MODE] RAG Index: ${appState.ragCatalogCountSignal.value} записей • Воркер: ${appState.workerStatusSignal.value}`
                ).style({
                  color: () => THEME.accentOrange,
                  fontSize: 10,
                  marginTop: 4,
                }),
              ]
            : [])
        ).style({ width: "100%", gap: 4 })
      )
        .named("settings-version-card")
        .style({
          width: "100%",
          backgroundColor: () => THEME.bgSurface,
          borderRadius: 14,
          padding: 12,
          borderWidth: 1,
          borderColor: () => THEME.borderDefault,
        })
        .onClick(() => {
          tapCountSignal.value++;
          if (tapCountSignal.value >= 10 && !appState.devModeUnlockedSignal.value) {
            appState.devModeUnlockedSignal.value = true;
            toast("Инженерное меню активировано");
          }
        })
    ).style({
      width: "100%",
      paddingHorizontal: 12,
      paddingTop: 8,
      paddingBottom: 20,
      gap: 10,
    })
  ).style({ flex: 1, width: "100%" });

  return UIColumn(
    AppHeader({
      title: "НАСТРОЙКИ",
      onOpenAr: callbacks?.onOpenAr,
    }),
    scrollBody
  )
    .named("settings")
    .style({
      flex: 1,
      width: "100%",
      backgroundColor: () => THEME.bgBase,
    });
}
