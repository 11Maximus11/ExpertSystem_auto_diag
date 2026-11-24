/**
 * Модальное окно авторизации и регистрации мастера (AuthModal).
 * Полное воспроизведение веб-версии:
 * - Вкладки «Вход» и «Регистрация»
 * - Поля: Логин, Email (при регистрации), Пароль
 * - Чекбокс согласия с условиями использования
 * - Баннер ошибок валидации и сервера
 * - Интеграция с Django /api/auth/
 *
 * Лицензия: GPL-3.0
 */

import { apiClient } from "../api/BackendApiClient";
import { AuthUser } from "../types";
import { PrimaryButton, SecondaryButton, THEME } from "./components";

export interface AuthModalCallbacks {
  onAuthSuccess?: (user: AuthUser) => void;
  onClose?: () => void;
}

export function createAuthModal(callbacks?: AuthModalCallbacks): any {
  const authModeSignal = signal<"login" | "register">("login");
  const isSubmittingSignal = signal(false);
  const errorMessageSignal = signal("");
  const termsAcceptedSignal = signal(true);

  // Поля ввода
  const usernameInput = UIInput().style({
    placeholder: "Логин (напр. mechanic_ivan)",
    backgroundColor: THEME.bgBase,
    color: "#ffffff",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 13,
    borderWidth: 1,
    borderColor: THEME.borderSubtle,
    width: "100%",
    marginBottom: 8
  });

  const emailInput = UIInput().style({
    placeholder: "Email (необязательно, ivan@autoservice.ru)",
    backgroundColor: THEME.bgBase,
    color: "#ffffff",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 13,
    borderWidth: 1,
    borderColor: THEME.borderSubtle,
    width: "100%",
    marginBottom: 8,
    display: () => (authModeSignal.value === "register" ? "flex" : "none")
  });

  const passwordInput = UIInput().style({
    placeholder: "Пароль (не менее 6 символов)",
    backgroundColor: THEME.bgBase,
    color: "#ffffff",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 13,
    borderWidth: 1,
    borderColor: THEME.borderSubtle,
    width: "100%",
    marginBottom: 10
  });

  let modal: any = null;

  const handleSubmit = async () => {
    const username = (usernameInput.value || "").trim();
    const password = (passwordInput.value || "").trim();
    const email = (emailInput.value || "").trim();

    if (!username) {
      errorMessageSignal.value = "Введите имя пользователя (логин)";
      return;
    }
    if (!password) {
      errorMessageSignal.value = "Введите пароль";
      return;
    }
    if (authModeSignal.value === "register" && !termsAcceptedSignal.value) {
      errorMessageSignal.value = "Необходимо принять условия обработки данных";
      return;
    }

    errorMessageSignal.value = "";
    isSubmittingSignal.value = true;

    try {
      if (authModeSignal.value === "login") {
        const res = await apiClient.login(username, password);
        if (res.success && res.is_authenticated) {
          modal.hide();
          callbacks?.onAuthSuccess?.({
            username: res.username || username,
            is_staff: res.user?.is_staff,
            is_authenticated: true
          });
        } else {
          errorMessageSignal.value = res.error || "Неверный логин или пароль";
        }
      } else {
        const res = await apiClient.register(username, password, email || undefined);
        if (res.success && res.is_authenticated) {
          modal.hide();
          callbacks?.onAuthSuccess?.({
            username: res.username || username,
            email: email || undefined,
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

  // Переключение вкладок
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
        errorMessageSignal.value = "";
      });
  };

  modal = UIModal(
    UIColumn(
      // Шапка модалки
      UIRow(
        UIText(() => (authModeSignal.value === "login" ? "Вход в ИИдеал Авто" : "Регистрация в ИИдеал Авто")).style({
          color: THEME.textPrimary,
          fontSize: 14,
          fontWeight: "bold",
          flex: 1
        }),
        UIButton(UIText("✕").style({ color: THEME.textMuted, fontSize: 13, fontWeight: "bold" }))
          .style({ padding: 4 })
          .onClick(() => {
            modal.hide();
            callbacks?.onClose?.();
          })
      ).style({ alignItems: "center", marginBottom: 12, width: "100%" }),

      // Вкладки Вход / Регистрация
      UIRow(
        tabButton("Вход", "login"),
        tabButton("Регистрация", "register")
      ).style({
        backgroundColor: THEME.bgElevated,
        borderRadius: 10,
        padding: 3,
        marginBottom: 12,
        width: "100%"
      }),

      // Баннер ошибки
      UIRow(
        UIText(() => errorMessageSignal.value).style({
          color: THEME.statusCrit,
          fontSize: 11,
          lineHeight: 15
        })
      ).style({
        backgroundColor: "rgba(239, 68, 68, 0.15)",
        borderWidth: 1,
        borderColor: "rgba(239, 68, 68, 0.35)",
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 6,
        marginBottom: 10,
        width: "100%",
        display: () => (errorMessageSignal.value ? "flex" : "none")
      }),

      // Поля
      usernameInput,
      emailInput,
      passwordInput,

      // Чекбокс условий для регистрации
      UIRow(
        UIButton(
          UIBox(
            UIText(() => (termsAcceptedSignal.value ? "✓" : "")).style({
              color: "#ffffff",
              fontSize: 10,
              fontWeight: "bold"
            })
          ).style({
            width: 16,
            height: 16,
            borderRadius: 4,
            borderWidth: 1.5,
            borderColor: () => (termsAcceptedSignal.value ? THEME.statusOk : "#475569"),
            backgroundColor: () => (termsAcceptedSignal.value ? THEME.statusOk : "transparent"),
            alignItems: "center",
            justifyContent: "center",
            marginRight: 8
          })
        ).onClick(() => {
          termsAcceptedSignal.value = !termsAcceptedSignal.value;
        }),
        UIText("Согласен с обработкой данных и регламентом сервиса").style({
          color: THEME.textMuted,
          fontSize: 11,
          flex: 1
        })
      ).style({
        alignItems: "center",
        marginBottom: 12,
        width: "100%",
        display: () => (authModeSignal.value === "register" ? "flex" : "none")
      }),

      // Кнопки
      UIRow(
        SecondaryButton("Отмена", () => {
          modal.hide();
          callbacks?.onClose?.();
        }),
        UISpacer(),
        PrimaryButton(
          () => (isSubmittingSignal.value ? "..." : authModeSignal.value === "login" ? "Войти" : "Создать аккаунт"),
          handleSubmit
        )
      ).style({ alignItems: "center", width: "100%" })
    ).style({
      backgroundColor: THEME.bgSurface,
      borderRadius: 14,
      padding: 16,
      borderWidth: 1,
      borderColor: THEME.borderStrong,
      width: "92%",
      maxWidth: 400
    })
  );

  return modal;
}

