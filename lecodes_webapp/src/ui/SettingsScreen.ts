/**
 * Экран настроек, аккаунта мастера, междиалоговой памяти и скрытого инженерного меню.
 * Полное соответствие веб-версии + 100% реактивные тёмная и светлая темы:
 * - Вход / Регистрация / Выход / Удаление аккаунта + кликабельные Условия и Политика
 * - Переключение Светлой и Тёмной тем оформления
 * - Междиалоговая память ИИ (переключатель, редактируемая сводка, сохранение, очистка)
 * - Статус аппаратных модулей (Камера, Микрофон, Речь)
 * - Инженерное меню (Dev Mode), скрытое за 10 тапами по блоку версии,
 *   с пресетом Локальный ПК http://localhost:8000 (adb reverse) и диагностикой связи.
 *
 * Лицензия: GPL-3.0
 */

import { apiClient, DEFAULT_BACKEND_URL } from "../api/BackendApiClient";
import { cacheManager } from "../cache/ResourceCacheManager";
import { appState, purgeUserSessionAndMemoryState } from "../state/appState";
import { AuthUser } from "../types";
import {
  AppHeader,
  currentThemeSignal,
  LucideIcon,
  openConfirmModal,
  PrimaryButton,
  SecondaryButton,
  StatusBadge,
  THEME,
  toggleTheme
} from "./components";

export interface SettingsScreenCallbacks {
  onOpenAr?: () => void;
  onServerUrlChanged?: (newUrl: string) => void;
  onAuthChanged?: (user: AuthUser) => void;
}

export function createSettingsScreen(callbacks?: SettingsScreenCallbacks): any {
  const urlTextSignal = signal<string>(apiClient.getBaseUrl());
  const pingStateSignal = signal<"idle" | "running" | "ok" | "crit">("idle");
  const pingMessageSignal = signal<string>("Связь не проверена");

  // Авторизация / регистрация
  const authModeSignal = signal<"login" | "register">("login");
  const authLoginSignal = signal<string>("");
  const authEmailSignal = signal<string>("");
  const authPasswordSignal = signal<string>("");
  const firstLoginConsentedSignal = signal<boolean>(
    cacheManager.getSetting<boolean>("first_login_legal_accepted", false)
  );
  const termsAcceptedSignal = signal<boolean>(false);
  const needsConsent = () =>
    authModeSignal.value === "register" || !firstLoginConsentedSignal.value;
  const authErrorSignal = signal<string>("");
  const isAuthSubmittingSignal = signal<boolean>(false);

  // Междиалоговая память ИИ
  const memoryEditSignal = signal<string>(appState.globalMemorySummarySignal.value || "");
  const isMemorySavingSignal = signal<boolean>(false);

  // Инженерное меню строго скрыто в обычном режиме до 10 явных нажатий в текущей сессии
  cacheManager.saveSetting("dev_menu_unlocked", false);
  const devUnlockedSignal = signal<boolean>(false);
  const versionTapCountSignal = signal<number>(0);

  const header = AppHeader({
    title: "ИИДЕАЛ АВТО",
    onOpenAr: () => callbacks?.onOpenAr?.()
  });

  // =========================================================================
  // СЕКЦИЯ 1: УЧЕТНАЯ ЗАПИСЬ МАСТЕРА (ВХОД / РЕГИСТРАЦИЯ / ПРОФИЛЬ)
  // =========================================================================

  const authLoginInput = UIInput()
    .style({
      placeholder: "Логин / Имя пользователя (от 3 симв.)",
      placeholderColor: () => THEME.inputPlaceholder,
      backgroundColor: () => THEME.bgInput,
      color: () => THEME.textPrimary,
      borderWidth: 1.5,
      borderColor: () => THEME.borderStrong,
      borderRadius: 9,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 13,
      width: "100%"
    })
    .onChange((v: string) => {
      authLoginSignal.value = v;
    });

  const authEmailInput = UIInput()
    .style({
      placeholder: "Email (необязательно, для облачных отчётов)",
      placeholderColor: () => THEME.inputPlaceholder,
      backgroundColor: () => THEME.bgInput,
      color: () => THEME.textPrimary,
      borderWidth: 1.5,
      borderColor: () => THEME.borderStrong,
      borderRadius: 9,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 13,
      type: "email",
      width: "100%",
      display: () => (authModeSignal.value === "register" ? "flex" : "none")
    })
    .onChange((v: string) => {
      authEmailSignal.value = v;
    });

  const authPasswordInput = UIInput()
    .style({
      placeholder: "Пароль (от 6 символов)",
      placeholderColor: () => THEME.inputPlaceholder,
      backgroundColor: () => THEME.bgInput,
      color: () => THEME.textPrimary,
      borderWidth: 1.5,
      borderColor: () => THEME.borderStrong,
      borderRadius: 9,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 13,
      type: "password",
      width: "100%"
    })
    .onChange((v: string) => {
      authPasswordSignal.value = v;
    });

  const applyAuthenticatedState = async (user: AuthUser) => {
    purgeUserSessionAndMemoryState(false);
    cacheManager.saveSetting("last_auth_username", user.username);
    appState.currentUserSignal.value = user;
    callbacks?.onAuthChanged?.(user);

    // Загружаем облачные настройки и междиалоговую память пользователя
    const srvSettings = await apiClient.getSettings();
    appState.crossMemoryEnabledSignal.value = srvSettings.cross_dialog_memory_enabled;
    appState.globalMemorySummarySignal.value = srvSettings.global_memory_summary || "";
    memoryEditSignal.value = appState.globalMemorySummarySignal.value;
    memoryTextArea.value = memoryEditSignal.value;

    const sessions = await apiClient.getSessions();
    if (sessions.length > 0) {
      const detail = await apiClient.getSessionDetail(sessions[0].id);
      if (detail) {
        appState.currentSessionIdSignal.value = detail.id;
        appState.currentSessionTitleSignal.value = detail.title;
        appState.vehicleSignal.value = detail.vehicle_info || "";
        appState.sessionSummarySignal.value = detail.summary || "";
        if (detail.worker_status) {
          appState.workerStatusSignal.value = detail.worker_status;
        }
        cacheManager.saveSetting("active_session_id", detail.id);
        if (detail.messages.length > 0) {
          appState.messagesSignal.value = detail.messages;
          appState.latestAssistantMessageSignal.value =
            [...detail.messages].reverse().find(m => m.role === "assistant") || detail.messages[0];
        }
      }
    }
    appState.sessionsRefreshCounterSignal.value++;
  };

  const handleAuthSubmit = async () => {
    const username = (authLoginInput.value || authLoginSignal.value || "").trim();
    const email = (authEmailInput.value || authEmailSignal.value || "").trim();
    const password = (authPasswordInput.value || authPasswordSignal.value || "").trim();

    if (username.length < 3) {
      authErrorSignal.value = "Логин должен содержать минимум 3 символа";
      return;
    }
    if (password.length < 6) {
      authErrorSignal.value = "Пароль должен содержать минимум 6 символов";
      return;
    }
    if (needsConsent() && !termsAcceptedSignal.value) {
      authErrorSignal.value =
        "Подтвердите согласие на cookies, Пользовательское соглашение и Политику конфиденциальности";
      return;
    }
    if (authModeSignal.value === "register") {
      if (email && !email.includes("@")) {
        authErrorSignal.value = "Укажите корректный Email или оставьте поле пустым";
        return;
      }
    }

    authErrorSignal.value = "";
    isAuthSubmittingSignal.value = true;
    try {
      const res =
        authModeSignal.value === "login"
          ? await apiClient.login(username, password)
          : await apiClient.register(username, password, email || undefined);

      if (res.success && res.is_authenticated) {
        cacheManager.saveSetting("first_login_legal_accepted", true);
        cacheManager.saveSetting("first_entry_legal_accepted", true);
        firstLoginConsentedSignal.value = true;
        termsAcceptedSignal.value = false;
        authPasswordInput.value = "";
        authPasswordSignal.value = "";
        await applyAuthenticatedState({
          username: res.username || username,
          email: res.email || email || undefined,
          is_staff: res.user?.is_staff,
          is_authenticated: true
        });
        toast(
          authModeSignal.value === "login"
            ? `Добро пожаловать, ${res.username || username}!`
            : `Аккаунт ${res.username || username} создан`
        );
      } else {
        authErrorSignal.value =
          res.error ||
          (authModeSignal.value === "login" ? "Неверный логин или пароль" : "Ошибка регистрации");
      }
    } catch (err: any) {
      authErrorSignal.value = `Ошибка связи: ${err?.message || err}`;
    } finally {
      isAuthSubmittingSignal.value = false;
    }
  };

  const authModeTab = (label: string, mode: "login" | "register") => {
    const active = () => authModeSignal.value === mode;
    return UIButton(
      UIText(label).style({
        color: () => (active() ? "#ffffff" : THEME.textSecondary),
        fontSize: 12,
        fontWeight: "bold"
      })
    )
      .style({
        flex: 1,
        paddingVertical: 8,
        borderRadius: 8,
        backgroundColor: () => (active() ? THEME.accentOrange : "transparent"),
        alignItems: "center",
        justifyContent: "center"
      })
      .onClick(() => {
        authModeSignal.value = mode;
        termsAcceptedSignal.value = false;
        authErrorSignal.value = "";
      });
  };

  const accountCard = UIColumn(
    UIRow(
      LucideIcon("lucide:user", 18, () => THEME.accentOrange),
      UIText("Учётная запись мастера").style({
        color: () => THEME.textPrimary,
        fontSize: 15,
        fontWeight: "bold",
        flex: 1
      }),
      StatusBadge(
        () => (appState.currentUserSignal.value.is_authenticated ? "ok" : "idle"),
        () =>
          appState.currentUserSignal.value.is_authenticated
            ? `В сети: ${appState.currentUserSignal.value.username}`
            : "Гостевой режим"
      )
    ).style({ alignItems: "center", gap: 8, width: "100%" }),

    // Блок авторизованного профиля
    UIColumn(
      UIText(() => {
        const u = appState.currentUserSignal.value;
        return u.email ? `Мастер: ${u.username} (${u.email})` : `Мастер: ${u.username}`;
      }).style({
        color: () => THEME.textSecondary,
        fontSize: 12
      }),
      UIText("Ваши диалоги, проекты и междиалоговая память синхронизируются с сервером.").style({
        color: () => THEME.textMuted,
        fontSize: 11
      }),
      UIRow(
        SecondaryButton(
          "Выйти",
          async () => {
            await apiClient.logout();
            purgeUserSessionAndMemoryState(true);
            cacheManager.saveSetting("last_auth_username", "__guest__");
            appState.currentUserSignal.value = { username: "", is_authenticated: false };
            memoryEditSignal.value = "";
            memoryTextArea.value = "";
            callbacks?.onAuthChanged?.(appState.currentUserSignal.value);
            toast("Вы вышли из аккаунта");
          },
          "lucide:log-out"
        ),
        UISpacer(),
        UIButton(
          UIRow(
            LucideIcon("lucide:trash-2", 14, () => THEME.statusCrit),
            UIText("Удалить аккаунт").style({
              color: () => THEME.statusCrit,
              fontSize: 12,
              fontWeight: "bold"
            })
          ).style({ alignItems: "center", gap: 5 })
        )
          .style({
            backgroundColor: "rgba(239, 68, 68, 0.14)",
            borderWidth: 1,
            borderColor: "rgba(239, 68, 68, 0.35)",
            paddingHorizontal: 10,
            paddingVertical: 8,
            borderRadius: 9
          })
          .onClick(() => {
            openConfirmModal({
              title: "Удалить аккаунт навсегда?",
              message: "Профиль и вся облачная история диагностик будут безвозвратно удалены.",
              confirmLabel: "Удалить",
              onConfirm: async () => {
                const res = await apiClient.deleteAccount();
                if (res.success) {
                  purgeUserSessionAndMemoryState(true);
                  cacheManager.saveSetting("last_auth_username", "__guest__");
                  appState.currentUserSignal.value = { username: "", is_authenticated: false };
                  memoryEditSignal.value = "";
                  memoryTextArea.value = "";
                  callbacks?.onAuthChanged?.(appState.currentUserSignal.value);
                  toast("Аккаунт удалён");
                } else {
                  toast(res.error || "Ошибка удаления аккаунта");
                }
              }
            });
          })
      ).style({ alignItems: "center", width: "100%", marginTop: 4 })
    ).style({
      gap: 8,
      width: "100%",
      display: () => (appState.currentUserSignal.value.is_authenticated ? "flex" : "none")
    }),

    // Блок гостя (форма Входа / Регистрации)
    UIColumn(
      UIText("Войдите или зарегистрируйтесь для облачного хранения проектов, чеклистов и памяти ИИ:").style({
        color: () => THEME.textSecondary,
        fontSize: 12,
        lineHeight: 17
      }),

      UIRow(authModeTab("Вход", "login"), authModeTab("Регистрация", "register")).style({
        backgroundColor: () => THEME.bgElevated,
        borderRadius: 10,
        padding: 3,
        width: "100%"
      }),

      UIRow(
        LucideIcon("lucide:circle-alert", 15, () => THEME.statusCrit),
        UIText(() => authErrorSignal.value).style({
          color: () => THEME.statusCrit,
          fontSize: 11,
          lineHeight: 15,
          flex: 1
        })
      ).style({
        backgroundColor: "rgba(239, 68, 68, 0.14)",
        borderWidth: 1,
        borderColor: "rgba(239, 68, 68, 0.35)",
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 7,
        alignItems: "center",
        gap: 6,
        width: "100%",
        display: () => (authErrorSignal.value ? "flex" : "none")
      }),

      authLoginInput,
      authEmailInput,
      authPasswordInput,

      UIColumn(
        UIRow(
          UIButton(
            UIBox(
              LucideIcon("lucide:check", 12, "#ffffff").style({
                display: () => (termsAcceptedSignal.value ? "flex" : "none")
              })
            ).style({
              width: 18,
              height: 18,
              borderRadius: 5,
              borderWidth: 1.5,
              borderColor: () => (termsAcceptedSignal.value ? THEME.statusOk : THEME.borderStrong),
              backgroundColor: () => (termsAcceptedSignal.value ? THEME.statusOk : "transparent"),
              alignItems: "center",
              justifyContent: "center"
            })
          )
            .style({ padding: 2 })
            .onClick(() => {
              termsAcceptedSignal.value = !termsAcceptedSignal.value;
            }),
          UIText("Принимаю использование cookies и кэша, Пользовательское соглашение и Политику конфиденциальности (152-ФЗ РФ)").style({
            color: () => THEME.textSecondary,
            fontSize: 11,
            lineHeight: 15,
            flex: 1
          })
        ).style({ alignItems: "flex-start", gap: 8, width: "100%" }),

        UIRow(
          UIButton(
            UIText("Пользовательское соглашение").style({
              color: () => THEME.accentCyan,
              fontSize: 10,
              textDecoration: "underline"
            })
          ).onClick(() => {
            try {
              openURL(`${apiClient.getBaseUrl()}/terms/`);
            } catch (_) {}
          }),
          UIText("•").style({ color: () => THEME.textMuted, fontSize: 10 }),
          UIButton(
            UIText("Политика конфиденциальности").style({
              color: () => THEME.accentCyan,
              fontSize: 10,
              textDecoration: "underline"
            })
          ).onClick(() => {
            try {
              openURL(`${apiClient.getBaseUrl()}/privacy/`);
            } catch (_) {}
          })
        ).style({ alignItems: "center", gap: 6, paddingLeft: 26 })
      ).style({
        gap: 4,
        width: "100%",
        display: () => (needsConsent() ? "flex" : "none")
      }),

      PrimaryButton(
        () =>
          isAuthSubmittingSignal.value
            ? "Выполняется..."
            : authModeSignal.value === "login"
              ? "Войти в аккаунт"
              : "Создать аккаунт",
        handleAuthSubmit,
        isAuthSubmittingSignal
      ).style({ width: "100%" })
    ).style({
      gap: 9,
      width: "100%",
      display: () => (appState.currentUserSignal.value.is_authenticated ? "none" : "flex")
    })
  ).style({
    backgroundColor: () => THEME.bgSurface,
    borderWidth: 1,
    borderColor: () => THEME.borderDefault,
    borderRadius: 14,
    padding: 14,
    gap: 10,
    width: "100%"
  });

  // =========================================================================
  // СЕКЦИЯ 2: ТЕМА ОФОРМЛЕНИЯ (ТЁМНАЯ / СВЕТЛАЯ)
  // =========================================================================

  const setTheme = (mode: "dark" | "light") => {
    currentThemeSignal.value = mode;
    cacheManager.saveSetting("theme_mode", mode);
  };

  const themeBtn = (label: string, mode: "dark" | "light", iconName: string) => {
    const active = () => currentThemeSignal.value === mode;
    return UIButton(
      UIRow(
        LucideIcon(iconName, 16, () => (active() ? "#ffffff" : THEME.textSecondary)),
        UIText(label).style({
          color: () => (active() ? "#ffffff" : THEME.textSecondary),
          fontSize: 12,
          fontWeight: "bold"
        })
      ).style({ alignItems: "center", gap: 6 })
    )
      .style({
        flex: 1,
        paddingVertical: 10,
        borderRadius: 9,
        backgroundColor: () => (active() ? THEME.accentOrange : THEME.bgElevated),
        borderWidth: 1,
        borderColor: () => (active() ? THEME.accentOrange : THEME.borderDefault),
        alignItems: "center",
        justifyContent: "center"
      })
      .onClick(() => setTheme(mode));
  };

  const themeCard = UIColumn(
    UIRow(
      LucideIcon("lucide:sun", 17, () => THEME.accentOrange),
      UIText("Оформление интерфейса").style({
        color: () => THEME.textPrimary,
        fontSize: 14,
        fontWeight: "bold",
        flex: 1
      })
    ).style({ alignItems: "center", gap: 8, width: "100%" }),
    UIRow(
      themeBtn("Тёмная (Стенд)", "dark", "lucide:moon"),
      themeBtn("Светлая (Мастерская)", "light", "lucide:sun")
    ).style({ gap: 8, width: "100%" })
  ).style({
    backgroundColor: () => THEME.bgSurface,
    borderWidth: 1,
    borderColor: () => THEME.borderDefault,
    borderRadius: 14,
    padding: 14,
    gap: 10,
    width: "100%"
  });

  // =========================================================================
  // СЕКЦИЯ 3: МЕЖДИАЛОГОВАЯ ПАМЯТЬ И АППАРАТНЫЕ ДАТЧИКИ (ПЕРЕНЕСЕНО С ГЛАВНОЙ)
  // =========================================================================

  const memoryTextArea = UITextArea()
    .style({
      placeholder: "Долгосрочная память об автомобилях, предпочтениях и ремонтах...",
      placeholderColor: () => THEME.inputPlaceholder,
      backgroundColor: () => THEME.bgInput,
      color: () => THEME.textPrimary,
      borderWidth: 1.5,
      borderColor: () => THEME.borderStrong,
      borderRadius: 9,
      padding: 10,
      fontSize: 12,
      minHeight: 74,
      maxHeight: 150,
      width: "100%"
    })
    .onChange((val: string) => {
      memoryEditSignal.value = val;
    });

  effect(() => {
    const val = appState.globalMemorySummarySignal.value || "";
    memoryEditSignal.value = val;
    memoryTextArea.value = val;
  });

  const memoryCard = UIColumn(
    UIRow(
      LucideIcon("lucide:cpu", 17, () => THEME.accentCyan),
      UIText("Междиалоговая память ИИ").style({
        color: () => THEME.textPrimary,
        fontSize: 14,
        fontWeight: "bold",
        flex: 1
      }),
      UIButton(
        UIText(() => (appState.crossMemoryEnabledSignal.value ? "ВКЛ" : "ВЫКЛ")).style({
          color: "#ffffff",
          fontSize: 11,
          fontWeight: "bold"
        })
      )
        .style({
          backgroundColor: () =>
            appState.crossMemoryEnabledSignal.value ? THEME.statusOk : THEME.textMuted,
          paddingHorizontal: 10,
          paddingVertical: 5,
          borderRadius: 8
        })
        .onClick(async () => {
          const next = !appState.crossMemoryEnabledSignal.value;
          appState.crossMemoryEnabledSignal.value = next;
          if (!appState.currentUserSignal.value?.is_authenticated) {
            toast(next ? "Междиалоговая память включена (локально)" : "Междиалоговая память выключена (локально)");
            return;
          }
          await apiClient.saveSettings({ cross_dialog_memory_enabled: next });
          toast(next ? "Междиалоговая память включена" : "Междиалоговая память выключена");
        })
    ).style({ alignItems: "center", gap: 8, width: "100%" }),

    UIText("Позволяет ассистенту помнить параметры вашего автопарка и выполненные работы между разными диалогами.").style({
      color: () => THEME.textMuted,
      fontSize: 11,
      lineHeight: 16
    }),

    memoryTextArea,

    UIRow(
      SecondaryButton(
        "Очистить",
        () => {
          openConfirmModal({
            title: "Очистить глобальную память?",
            message: "Накопленная сводка знаний о прошлых ремонтах будет сброшена.",
            confirmLabel: "Очистить",
            onConfirm: async () => {
              appState.globalMemorySummarySignal.value = "";
              appState.sessionSummarySignal.value = "";
              memoryEditSignal.value = "";
              memoryTextArea.value = "";

              if (!appState.currentUserSignal.value?.is_authenticated) {
                appState.demoSessionsSignal.value = appState.demoSessionsSignal.value.map(s => ({
                  ...s,
                  summary: ""
                }));
                toast("Глобальная память очищена локально");
                return;
              }

              const ok = await apiClient.clearGlobalMemory();
              toast(ok ? "Глобальная память очищена" : "Сброшено локально");
            }
          });
        },
        "lucide:trash-2"
      ),
      UISpacer(),
      PrimaryButton(
        () => (isMemorySavingSignal.value ? "Сохранение..." : "Сохранить память"),
        async () => {
          const txt = (memoryTextArea.value || memoryEditSignal.value || "").trim();
          appState.globalMemorySummarySignal.value = txt;
          if (!appState.currentUserSignal.value?.is_authenticated) {
            toast("Память сохранена локально (Демо-режим)");
            return;
          }
          isMemorySavingSignal.value = true;
          const ok = await apiClient.saveSettings({
            cross_dialog_memory_enabled: appState.crossMemoryEnabledSignal.value,
            global_memory_summary: txt
          });
          isMemorySavingSignal.value = false;
          toast(ok ? "Память синхронизирована с сервером" : "Сохранено локально");
        },
        isMemorySavingSignal
      )
    ).style({ alignItems: "center", width: "100%" }),

    // Статус модулей устройства
    UIRow(
      UIText(
        `Модули: Камера ${UICameraNode.supported ? "OK" : "—"} • Микрофон ${
          AudioRecorder.supported ? "OK" : "—"
        } • Речь ${SpeechRecognizer.supported ? "OK" : "—"}`
      ).style({
        color: () => THEME.textMuted,
        fontSize: 10
      })
    ).style({ marginTop: 4, width: "100%" })
  ).style({
    backgroundColor: () => THEME.bgSurface,
    borderWidth: 1,
    borderColor: () => THEME.borderDefault,
    borderRadius: 13,
    padding: 13,
    gap: 9,
    width: "100%"
  });

  // =========================================================================
  // СЕКЦИЯ 4: СКРЫТОЕ ИНЖЕНЕРНОЕ МЕНЮ (10 НАЖАТИЙ ПО БЛОКУ ВЕРСИИ)
  // =========================================================================

  const urlInput = UIInput()
    .style({
      placeholder: DEFAULT_BACKEND_URL,
      placeholderColor: () => THEME.inputPlaceholder,
      backgroundColor: () => THEME.bgInput,
      color: () => THEME.textPrimary,
      borderWidth: 1.5,
      borderColor: () => THEME.borderStrong,
      borderRadius: 9,
      paddingHorizontal: 11,
      paddingVertical: 9,
      fontSize: 13,
      type: "url",
      width: "100%"
    })
    .onChange((val: string) => {
      urlTextSignal.value = val;
    });
  urlInput.value = apiClient.getBaseUrl();

  const applyServerUrl = (newUrl: string) => {
    const clean = newUrl.trim().replace(/\/+$/, "") || DEFAULT_BACKEND_URL;
    urlTextSignal.value = clean;
    urlInput.value = clean;
    apiClient.setBaseUrl(clean);
    callbacks?.onServerUrlChanged?.(clean);
    toast(`Сервер задан: ${clean}`);
  };

  const runPing = async () => {
    const target = (urlInput.value || urlTextSignal.value || apiClient.getBaseUrl()).trim();
    applyServerUrl(target);
    pingStateSignal.value = "running";
    pingMessageSignal.value = "Подключение...";
    const res = await apiClient.testConnection(target);
    pingStateSignal.value = res.ok ? "ok" : "crit";
    pingMessageSignal.value = res.message;
  };

  const devMenuCard = UIColumn(
    UIColumn(
      UIRow(
        LucideIcon("lucide:sliders-horizontal", 17, () => THEME.accentCyan),
        UIText("Инженерное меню стенда (Dev Mode)").style({
          color: () => THEME.accentCyan,
          fontSize: 14,
          fontWeight: "bold",
          flex: 1
        })
      ).style({ alignItems: "center", gap: 7, width: "100%" }),
      UIRow(
        StatusBadge(() => pingStateSignal.value, () => pingMessageSignal.value)
      ).style({ width: "100%" })
    ).style({ gap: 6, width: "100%" }),

    UIText("Адрес Django бэкенда (для adb reverse по умолчанию http://localhost:8000):").style({
      color: () => THEME.textMuted,
      fontSize: 11
    }),

    UIRow(
      SecondaryButton("Локалхост (:8000)", () => applyServerUrl("http://localhost:8000")),
      SecondaryButton("Эмулятор (10.0.2.2)", () => applyServerUrl("http://10.0.2.2:8000"))
    ).style({ gap: 8, width: "100%" }),

    urlInput,

    UIRow(
      PrimaryButton("Сохранить URL", () => {
        applyServerUrl(urlInput.value || urlTextSignal.value);
      }),
      SecondaryButton("Пинг /api/", () => {
        void runPing();
      }, "lucide:wifi")
    ).style({ gap: 8, width: "100%" }),

    UIRow(
      SecondaryButton(
        "Синхронизировать DTC",
        async () => {
          const cnt = await apiClient.syncDtcDictionary();
          toast(cnt > 0 ? `Загружено кодов: ${cnt}` : "Словарь недоступен или пуст");
        },
        "lucide:refresh-cw"
      ),
      UISpacer(),
      SecondaryButton("Скрыть меню", () => {
        devUnlockedSignal.value = false;
        versionTapCountSignal.value = 0;
        cacheManager.saveSetting("dev_menu_unlocked", false);
        toast("Инженерное меню скрыто");
      })
    ).style({ alignItems: "center", width: "100%", marginTop: 4 })
  ).style({
    backgroundColor: () => THEME.bgSurface,
    borderWidth: 1.5,
    borderColor: () => THEME.accentCyan,
    borderRadius: 13,
    padding: 13,
    gap: 9,
    width: "100%",
    display: () => (devUnlockedSignal.value ? "flex" : "none")
  });

  // =========================================================================
  // СЕКЦИЯ 5: КАРТОЧКА О ПРИЛОЖЕНИИ (10 ТАПОВ ДЛЯ РАЗБЛОКИРОВКИ DEV MODE)
  // =========================================================================

  const versionCard = UIButton(
    UIRow(
      LucideIcon("lucide:lock", 15, () =>
        devUnlockedSignal.value ? THEME.statusOk : THEME.textMuted
      ),
      UIColumn(
        UIText("ИИдеал-Авто Native • Версия 2.2 (GPL-3.0)").style({
          color: () => THEME.textPrimary,
          fontSize: 12,
          fontWeight: "bold"
        }),
        UIText(() => {
          if (devUnlockedSignal.value) {
            return `Инженерный режим активен • ${urlTextSignal.value}`;
          }
          const taps = versionTapCountSignal.value;
          if (taps >= 6) {
            return `Нажмите ещё ${Math.max(1, 10 - taps)} раз для открытия Dev Menu`;
          }
          return `Экспертная система автодиагностики`;
        }).style({
          color: () => THEME.textMuted,
          fontSize: 11
        })
      ).style({ flex: 1, gap: 2 })
    ).style({ alignItems: "center", gap: 9, width: "100%" })
  )
    .style({
      backgroundColor: () => THEME.bgSurface,
      borderWidth: 1,
      borderColor: () => THEME.borderDefault,
      borderRadius: 12,
      padding: 12,
      width: "100%"
    })
    .onClick(() => {
      if (devUnlockedSignal.value) return;
      const next = versionTapCountSignal.value + 1;
      versionTapCountSignal.value = next;
      if (next >= 10) {
        devUnlockedSignal.value = true;
        toast("Инженерное меню разблокировано (до перезапуска)");
      }
    });

  const legalFooterRow = UIRow(
    UIButton(
      UIText("Пользовательское соглашение").style({
        color: () => THEME.accentCyan,
        fontSize: 11,
        textDecoration: "underline"
      })
    ).onClick(() => {
      try {
        openURL(`${apiClient.getBaseUrl()}/terms/`);
      } catch (_) {}
    }),
    UIText("•").style({ color: () => THEME.textMuted, fontSize: 11 }),
    UIButton(
      UIText("Политика (152-ФЗ)").style({
        color: () => THEME.accentCyan,
        fontSize: 11,
        textDecoration: "underline"
      })
    ).onClick(() => {
      try {
        openURL(`${apiClient.getBaseUrl()}/privacy/`);
      } catch (_) {}
    })
  ).style({
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingBottom: 8
  });

  return UIColumn(
    header,
    UIScrollable(
      UIColumn(accountCard, themeCard, memoryCard, devMenuCard, versionCard, legalFooterRow).style({
        width: "100%",
        padding: 12,
        gap: 10
      })
    ).style({ flex: 1, width: "100%", backgroundColor: () => THEME.bgBase })
  ).style({
    flex: 1,
    width: "100%",
    backgroundColor: () => THEME.bgBase
  });
}
