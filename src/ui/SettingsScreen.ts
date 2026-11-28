// ИИдеал Авто — Настройки, ИИ-движок (LeCodes AI / BYOK / RAG), память и резервные копии (2026-11-28)
// Copyright (C) 2026 ИИдеал Авто (LeCodes48 Edition)
// Licensed under the GNU General Public License v3.0 (GPL-3.0).

import {
  appState,
  reloadSessionsFromDb,
  saveByokCredentials,
  setLlmMode,
  updateSettingsPatch,
} from "../state/appState";
import { createWelcomeMessage, localDb } from "../storage/LocalDatabase";
import type { LlmProviderMode } from "../types";
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
  onOpen3d?: () => void;
}

const ENGINE_MODES: { id: LlmProviderMode; label: string; desc: string }[] = [
  {
    id: "lecodes_ai",
    label: "LeCodes AI (Встроенный)",
    desc: "Облачный ИИ платформы le.codes (текст + Vision фото) с автоматическим резервом на локальный RAG.",
  },
  {
    id: "byok_openai",
    label: "BYOK OpenAI-совм.",
    desc: "Ваш собственный ключ OpenAI / DeepSeek / OpenRouter в защищенном хранилище устройства.",
  },
  {
    id: "byok_gigachat",
    label: "BYOK GigaChat / РФ API",
    desc: "Подключение совместимого шлюза или отечественного провайдера по вашему ключу.",
  },
  {
    id: "local_only",
    label: "100% Оффлайн RAG",
    desc: "Полностью автономный режим без интернета: Hybrid RAG по 12 141 коду DTC и телеметрии ELM327.",
  },
];

export function createSettingsScreen(callbacks?: SettingsScreenCallbacks): any {
  const tapCountSignal = signal<number>(0);
  const byokUrlSignal = signal<string>(appState.settingsSignal.value.byok_base_url || "");
  const byokModelSignal = signal<string>(appState.settingsSignal.value.byok_model || "gpt-4o-mini");
  const byokKeyInputSignal = signal<string>("");

  const statsSignal = signal(localDb.getStorageStats());

  effect(() => {
    void appState.sessionsRefreshCounterSignal.value;
    void appState.messagesSignal.value;
    statsSignal.value = localDb.getStorageStats();
  });

  const byokUrlInput = UIInput()
    .named("settings-byok-url")
    .style({
      width: "100%",
      height: 36,
      backgroundColor: () => THEME.bgInput,
      color: () => THEME.textPrimary,
      borderWidth: 1,
      borderColor: () => THEME.borderDefault,
      borderRadius: 9,
      paddingHorizontal: 10,
      fontSize: 12,
      placeholder: "https://api.openai.com/v1/chat/completions",
      placeholderColor: () => THEME.inputPlaceholder,
    })
    .onChange((val: string) => {
      byokUrlSignal.value = val;
    });
  byokUrlInput.value = byokUrlSignal.value;

  const byokModelInput = UIInput()
    .named("settings-byok-model")
    .style({
      width: "100%",
      height: 36,
      backgroundColor: () => THEME.bgInput,
      color: () => THEME.textPrimary,
      borderWidth: 1,
      borderColor: () => THEME.borderDefault,
      borderRadius: 9,
      paddingHorizontal: 10,
      fontSize: 12,
      placeholder: "gpt-4o-mini",
      placeholderColor: () => THEME.inputPlaceholder,
    })
    .onChange((val: string) => {
      byokModelSignal.value = val;
    });
  byokModelInput.value = byokModelSignal.value;

  const byokKeyInput = UIInput()
    .named("settings-byok-key")
    .style({
      width: "100%",
      height: 36,
      backgroundColor: () => THEME.bgInput,
      color: () => THEME.textPrimary,
      borderWidth: 1,
      borderColor: () => THEME.borderDefault,
      borderRadius: 9,
      paddingHorizontal: 10,
      fontSize: 12,
      placeholder: "sk-... (хранится в secureStorage устройства)",
      placeholderColor: () => THEME.inputPlaceholder,
    })
    .onChange((val: string) => {
      byokKeyInputSignal.value = val;
    });

  const scrollBody = UIScrollable(
    UIColumn(
      // 1. Тема и оформление
      UIColumn(
        UIRow(
          LucideIcon("lucide:sun", 17, () => THEME.accentOrange),
          UIText("ОФОРМЛЕНИЕ И ТЕМА").style({
            color: () => THEME.textPrimary,
            fontSize: 13,
            fontWeight: "bold",
            flex: 1,
          }),
          SecondaryButton(
            () => (currentThemeSignal.value === "dark" ? "Тёмная" : "Светлая"),
            () => toggleTheme(),
            "lucide:moon"
          ).named("settings-btn-theme")
        ).style({ width: "100%", alignItems: "center", gap: 8 }),
        UIText(
          "Автономное приложение для le.store: вход и регистрация не требуются, все данные хранятся на вашем устройстве."
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

      // 2. Выбор ИИ-движка
      UIColumn(
        UIRow(
          LucideIcon("lucide:bot", 17, () => THEME.accentCyan),
          UIText("ДВИЖОК ИИ-ДИАГНОСТИКИ").style({
            color: () => THEME.textPrimary,
            fontSize: 13,
            fontWeight: "bold",
            flex: 1,
          })
        ).style({ width: "100%", alignItems: "center", gap: 8 }),

        ...ENGINE_MODES.map((m) =>
          UIButton(
            UIColumn(
              UIRow(
                UIText(m.label).style({
                  color: () => THEME.textPrimary,
                  fontSize: 12,
                  fontWeight: "bold",
                  flex: 1,
                }),
                StatusBadge(
                  () => (appState.settingsSignal.value.llm_mode === m.id ? "ok" : "info"),
                  () => (appState.settingsSignal.value.llm_mode === m.id ? "Активен" : "Выбрать")
                )
              ).style({ width: "100%", alignItems: "center" }),
              UIText(m.desc).style({
                color: () => THEME.textMuted,
                fontSize: 11,
              })
            ).style({ width: "100%", gap: 3 })
          )
            .named(`settings-engine-${m.id}`)
            .style({
              width: "100%",
              backgroundColor: () => THEME.bgInput,
              borderRadius: 10,
              padding: 10,
              borderWidth: 1,
              borderColor: () =>
                appState.settingsSignal.value.llm_mode === m.id
                  ? THEME.accentCyan
                  : THEME.borderDefault,
            })
            .onClick(() => {
              setLlmMode(m.id);
              toast(`Выбран режим: ${m.label}`);
            })
        ),

        // Настройка BYOK ключей
        UIColumn(
          UIText("ПАРАМЕТРЫ BYOK (ОПЦИОНАЛЬНО)").style({
            color: () => THEME.textMuted,
            fontSize: 10,
            fontWeight: "bold",
            marginTop: 4,
          }),
          byokUrlInput,
          byokModelInput,
          byokKeyInput,
          UIRow(
            UIText(() =>
              appState.hasByokKeySignal.value
                ? "API-ключ сохранён в secureStorage"
                : "API-ключ не задан"
            ).style({
              color: () =>
                appState.hasByokKeySignal.value ? THEME.statusOk : THEME.textMuted,
              fontSize: 11,
              flex: 1,
            }),
            PrimaryButton(
              "Сохранить ключ",
              () => {
                void saveByokCredentials(
                  byokUrlInput.value || byokUrlSignal.value,
                  byokModelInput.value || byokModelSignal.value,
                  byokKeyInput.value || byokKeyInputSignal.value
                ).then(() => {
                  byokKeyInput.value = "";
                  byokKeyInputSignal.value = "";
                  toast("Параметры BYOK сохранены локально");
                });
              },
              "lucide:check"
            )
          ).style({ width: "100%", alignItems: "center", gap: 8 })
        ).style({ width: "100%", gap: 6, marginTop: 4 })
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
                placeholder: "Например: Основной авто — Skoda Octavia A7 1.4 TSI, свечи менялись 15 тыс. назад...",
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
            () => openBackupRestoreModal(() => reloadSessionsFromDb()),
            "lucide:download"
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
              `3D-движок: ${Scene?.supported ? "Filament OK" : "2D Fallback"} • Запросов ИИ: ${appState.aiCallCountSignal.value}`
          ).style({
            color: () => THEME.textMuted,
            fontSize: 11,
          }),
          ...(appState.devModeUnlockedSignal.value
            ? [
                UIText(
                  `[DEV MODE] RAG Index: ${appState.ragCatalogCountSignal.value} записей • Статус воркера: ${appState.workerStatusSignal.value}`
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
      onOpen3d: callbacks?.onOpen3d,
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
