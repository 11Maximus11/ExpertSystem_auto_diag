/**
 * Модальное окно авторизации и регистрации мастера (AuthModal).
 * Полная поддержка тёмной/светлой темы, валидация полей, кликабельные
 * условия использования и интеграция с Django /api/auth/ (через session_key).
 *
 * Лицензия: GPL-3.0
 */

import { apiClient } from "../api/BackendApiClient";
import { cacheManager } from "../cache/ResourceCacheManager";
import { AuthUser } from "../types";
import { LucideIcon, PrimaryButton, SecondaryButton, THEME } from "./components";

export interface AuthModalCallbacks {
  onAuthSuccess?: (user: AuthUser) => void;
  onClose?: () => void;
}

export function createAuthModal(callbacks?: AuthModalCallbacks): any {
  const authModeSignal = signal<"login" | "register">("login");
  const isSubmittingSignal = signal(false);
  const errorMessageSignal = signal("");
  const firstLoginConsentedSignal = signal<boolean>(
    cacheManager.getSetting<boolean>("first_login_legal_accepted", false)
  );
  const termsAcceptedSignal = signal(false);
  const needsConsent = () =>
    authModeSignal.value === "register" || !firstLoginConsentedSignal.value;

  const usernameText = signal("");
  const emailText = signal("");
  const passwordText = signal("");

  const usernameInput = UIInput()
    .style({
      placeholder: "Имя пользователя (логин от 3 симв.)",
      placeholderColor: () => THEME.inputPlaceholder,
      backgroundColor: () => THEME.bgInput,
      color: () => THEME.textPrimary,
      borderRadius: 9,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 13,
      borderWidth: 1.5,
      borderColor: () => THEME.borderStrong,
      width: "100%",
      marginBottom: 8
    })
    .onChange((val: string) => {
      usernameText.value = val;
    });

  const emailInput = UIInput()
    .style({
      placeholder: "Email (необязательно)",
      placeholderColor: () => THEME.inputPlaceholder,
      backgroundColor: () => THEME.bgInput,
      color: () => THEME.textPrimary,
      borderRadius: 9,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 13,
      borderWidth: 1.5,
      borderColor: () => THEME.borderStrong,
      width: "100%",
      marginBottom: 8,
      type: "email",
      display: () => (authModeSignal.value === "register" ? "flex" : "none")
    })
    .onChange((val: string) => {
      emailText.value = val;
    });

  const passwordInput = UIInput()
    .style({
      placeholder: "Пароль (не менее 6 симв.)",
      placeholderColor: () => THEME.inputPlaceholder,
      backgroundColor: () => THEME.bgInput,
      color: () => THEME.textPrimary,
      borderRadius: 9,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 13,
      borderWidth: 1.5,
      borderColor: () => THEME.borderStrong,
      width: "100%",
      marginBottom: 10,
      type: "password"
    })
    .onChange((val: string) => {
      passwordText.value = val;
    });

  let modal: any = null;

  const handleSubmit = async () => {
    const username = (usernameText.value || usernameInput.value || "").trim();
    const password = (passwordText.value || passwordInput.value || "").trim();
    const email = (emailText.value || emailInput.value || "").trim();

    if (!username) {
      errorMessageSignal.value = "Введите имя пользователя (логин)";
      return;
    }
    if (username.length < 3) {
      errorMessageSignal.value = "Логин должен содержать не менее 3 символов";
      return;
    }
    if (!password) {
      errorMessageSignal.value = "Введите пароль";
      return;
    }
    if (password.length < 6) {
      errorMessageSignal.value = "Пароль должен содержать не менее 6 символов";
      return;
    }
    if (needsConsent() && !termsAcceptedSignal.value) {
      errorMessageSignal.value =
        "Подтвердите согласие на cookies, Пользовательское соглашение и Политику конфиденциальности";
      return;
    }
    if (authModeSignal.value === "register") {
      if (email && !email.includes("@")) {
        errorMessageSignal.value = "Введите корректный email (с символом @) или оставьте поле пустым";
        return;
      }
    }

    errorMessageSignal.value = "";
    isSubmittingSignal.value = true;

    try {
      if (authModeSignal.value === "login") {
        const res = await apiClient.login(username, password);
        if (res.success && res.is_authenticated) {
          cacheManager.saveSetting("first_login_legal_accepted", true);
          cacheManager.saveSetting("first_entry_legal_accepted", true);
          firstLoginConsentedSignal.value = true;
          modal.hide();
          callbacks?.onAuthSuccess?.({
            username: res.username || username,
            email: res.email || res.user?.email,
            is_staff: res.user?.is_staff,
            is_authenticated: true
          });
        } else {
          errorMessageSignal.value = res.error || "Неверный логин или пароль";
        }
      } else {
        const res = await apiClient.register(username, password, email || undefined);
        if (res.success && res.is_authenticated) {
          cacheManager.saveSetting("first_login_legal_accepted", true);
          cacheManager.saveSetting("first_entry_legal_accepted", true);
          firstLoginConsentedSignal.value = true;
          modal.hide();
          callbacks?.onAuthSuccess?.({
            username: res.username || username,
            email: res.email || email || undefined,
            is_staff: res.user?.is_staff,
            is_authenticated: true
          });
        } else {
          errorMessageSignal.value = res.error || "Ошибка регистрации";
        }
      }
    } catch (err: any) {
      errorMessageSignal.value = `Ошибка связи с сервером: ${err.message || err}`;
    } finally {
      isSubmittingSignal.value = false;
    }
  };

  const tabButton = (label: string, mode: "login" | "register") => {
    const isActive = () => authModeSignal.value === mode;
    return UIButton(
      UIText(label).style({
        color: () => (isActive() ? "#ffffff" : THEME.textMuted),
        fontSize: 12,
        fontWeight: "bold"
      })
    )
      .style({
        flex: 1,
        paddingVertical: 8,
        borderRadius: 8,
        backgroundColor: () => (isActive() ? THEME.accentOrange : "transparent"),
        alignItems: "center",
        justifyContent: "center"
      })
      .onClick(() => {
        authModeSignal.value = mode;
        termsAcceptedSignal.value = false;
        errorMessageSignal.value = "";
      });
  };

  modal = UIModal(
    UIColumn(
      UIRow(
        LucideIcon("lucide:user", 17, () => THEME.accentOrange),
        UIText(() =>
          authModeSignal.value === "login" ? "Вход в ИИдеал Авто" : "Регистрация в ИИдеал Авто"
        ).style({
          color: () => THEME.textPrimary,
          fontSize: 15,
          fontWeight: "bold",
          flex: 1
        }),
        UIButton(LucideIcon("lucide:x", 18, () => THEME.textMuted))
          .style({ padding: 4 })
          .onClick(() => {
            modal.hide();
            callbacks?.onClose?.();
          })
      ).style({ alignItems: "center", gap: 8, marginBottom: 12, width: "100%" }),

      UIRow(tabButton("Вход", "login"), tabButton("Регистрация", "register")).style({
        backgroundColor: () => THEME.bgElevated,
        borderRadius: 10,
        padding: 3,
        marginBottom: 12,
        width: "100%"
      }),

      UIRow(
        LucideIcon("lucide:circle-alert", 15, () => THEME.statusCrit),
        UIText(() => errorMessageSignal.value).style({
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
        marginBottom: 10,
        alignItems: "center",
        gap: 6,
        width: "100%",
        display: () => (errorMessageSignal.value ? "flex" : "none")
      }),

      usernameInput,
      emailInput,
      passwordInput,

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
        marginBottom: 12,
        width: "100%",
        display: () => (needsConsent() ? "flex" : "none")
      }),

      UIRow(
        SecondaryButton("Отмена", () => {
          modal.hide();
          callbacks?.onClose?.();
        }),
        UISpacer(),
        PrimaryButton(
          () => (isSubmittingSignal.value ? "Подождите..." : authModeSignal.value === "login" ? "Войти" : "Создать аккаунт"),
          handleSubmit,
          isSubmittingSignal
        )
      ).style({ alignItems: "center", width: "100%" })
    ).style({
      backgroundColor: () => THEME.bgSurface,
      borderRadius: 18,
      padding: 18,
      borderWidth: 1,
      borderColor: () => THEME.borderStrong,
      width: "92%"
    })
  ).transition({
    opacity: 0,
    transform: "scale(0.95)",
    duration: 210
  });

  return modal;
}
