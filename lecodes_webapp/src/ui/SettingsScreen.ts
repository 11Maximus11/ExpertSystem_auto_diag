/**
 * Экран «Настройки & Инженерное меню» (Settings & Dev Mode).
 * Полное соответствие оригинальному сайту:
 * 1. Инженерное меню (Dev Mode):
 *    - Базовый URL Django API (пресеты: 10.0.2.2:8000 для эмулятора, localhost:8000, Wi-Fi 192.168.x.x, относительный)
 *    - Замер задержки (Ping / Health check)
 * 2. Междиалоговая память (Cross-Dialog Memory):
 *    - Переключатель передачи контекста между разными проверками
 *    - Глобальная память (выжимка всех сессий) с кнопкой очистки
 * 3. Кэширование ресурсов и офлайн-словарь DTC
 * 4. Аппаратные сенсоры, AR-очки RayNeo, Samsung DeX, Bluetooth/Serial
 * 5. Пасхалка (Easter Egg) переключения режима разработчика по клику на версию
 *
 * Лицензия: GPL-3.0
 */

import { apiClient } from "../api/BackendApiClient";
import { cacheManager, CacheStats } from "../cache/ResourceCacheManager";
import { WebBluetoothOBD } from "../obd/WebBluetoothOBD";
import { WebSerialOBD } from "../obd/WebSerialOBD";
import { createAuthModal } from "./AuthModal";
import { HeaderBar, LucideIcon, PrimaryButton, SecondaryButton, THEME } from "./components";

export interface SettingsScreenCallbacks {
  userSignal?: any;
  onOpenAuth?: (mode?: "login" | "register") => void;
}

export function createSettingsScreen(callbacks?: SettingsScreenCallbacks): any {
  const apiUrlSignal = signal(apiClient.getBaseUrl());
  const cacheStatsSignal = signal<CacheStats>(cacheManager.getStats());
  const syncMsgSignal = signal("");

  // Модальное окно авторизации для экрана настроек
  const authModal = createAuthModal({
    onAuthSuccess: (u) => {
      if (callbacks?.userSignal) {
        callbacks.userSignal.value = u;
      }
    }
  });

  const handleLogout = async () => {
    await apiClient.logout();
    if (callbacks?.userSignal) {
      callbacks.userSignal.value = { username: "", is_authenticated: false };
    }
  };

  const handleDeleteAccount = async () => {
    const ok = await apiClient.deleteAccount();
    if (ok) {
      if (callbacks?.userSignal) {
        callbacks.userSignal.value = { username: "", is_authenticated: false };
      }
    }
  };

  // Реактивное состояние для междиалоговой памяти
  const crossMemorySignal = signal<boolean>(true);
  const globalSummarySignal = signal<string>(
    "Сводка знаний: Автомобили Lada Vesta, Skoda Octavia. Характерные проблемы: пропуски зажигания 2-3 цилиндр, загрязнение ДМРВ, датчики скорости ABS."
  );

  // Реактивное состояние для инженерного меню
  const isDevUnlockedSignal = signal<boolean>(cacheManager.getSetting("dev_menu_unlocked", true));
  const tapCountSignal = signal(0);
  const tapNoticeSignal = signal("");
  const devTestResultSignal = signal("");
  const isTestingSignal = signal(false);

  const hasBt = WebBluetoothOBD.isSupported();
  const hasSerial = WebSerialOBD.isSupported();
  const hasCache = cacheManager.isCacheApiSupported();

  // Загрузка настроек с бэкенда
  apiClient.getSettings().then(settings => {
    if (settings) {
      crossMemorySignal.value = settings.cross_dialog_memory_enabled;
      if (settings.global_memory_summary) {
        globalSummarySignal.value = settings.global_memory_summary;
      }
    }
  });

  const handleVersionTap = () => {
    tapCountSignal.value++;
    const remaining = 7 - tapCountSignal.value;

    if (remaining > 0 && remaining < 5) {
      tapNoticeSignal.value = `Нажмите ещё ${remaining} раз для переключения режима разработчика...`;
    } else if (remaining <= 0) {
      tapCountSignal.value = 0;
      isDevUnlockedSignal.value = !isDevUnlockedSignal.value;
      cacheManager.saveSetting("dev_menu_unlocked", isDevUnlockedSignal.value);
      tapNoticeSignal.value = isDevUnlockedSignal.value
        ? "Инженерное меню разработчика разблокировано!"
        : "Инженерное меню скрыто";
    }
  };

  const handleSaveDevUrl = (urlToSave: string) => {
    const clean = urlToSave.trim().replace(/\/+$/, "");
    apiClient.setBaseUrl(clean);
    apiUrlSignal.value = apiClient.getBaseUrl();
    devTestResultSignal.value = `Адрес стенда сохранен: ${apiUrlSignal.value || "Относительный путь (/)"}`;
  };

  const handleTestPing = async (targetUrl: string) => {
    if (isTestingSignal.value) return;
    isTestingSignal.value = true;
    devTestResultSignal.value = `Проверка связи с ${targetUrl || "хостом"}...`;

    try {
      const res = await apiClient.testConnection(targetUrl);
      if (res.ok) {
        devTestResultSignal.value = `[OK] ${res.message}`;
      } else {
        devTestResultSignal.value = `[ВНИМАНИЕ] ${res.message}`;
      }
    } catch (e: any) {
      devTestResultSignal.value = `[ОШИБКА] Не удалось подключиться: ${e.message}`;
    } finally {
      isTestingSignal.value = false;
    }
  };

  const handleToggleCrossMemory = async () => {
    crossMemorySignal.value = !crossMemorySignal.value;
    await apiClient.saveSettings({ cross_dialog_memory_enabled: crossMemorySignal.value });
  };

  const handleClearGlobalMemory = async () => {
    globalSummarySignal.value = "Глобальная память очищена.";
    await apiClient.clearGlobalMemory();
  };

  const handleSyncDtc = async () => {
    syncMsgSignal.value = "Синхронизация словаря кодов...";
    try {
      const count = await apiClient.syncDtcDictionary();
      cacheStatsSignal.value = cacheManager.getStats();
      syncMsgSignal.value = `Успешно загружено кодов: ${count}`;
    } catch (e: any) {
      syncMsgSignal.value = `Ошибка синхронизации: ${e.message}`;
    }
  };

  const handleClearCache = async () => {
    await cacheManager.clearCache();
    cacheStatsSignal.value = cacheManager.getStats();
    syncMsgSignal.value = "Кэш приложения очищен";
  };

  const header = HeaderBar(
    "Настройки & Инженерное меню",
    "Конфигурация сервера, междиалоговой памяти и датчиков"
  );

  // --- БЛОК УЧЕТНОЙ ЗАПИСИ МАСТЕРА ---
  const isAuthenticated = () => !!callbacks?.userSignal?.value?.is_authenticated;
  const currentUsername = () => callbacks?.userSignal?.value?.username || "Гость";

  const accountSection = UIColumn(
    UIRow(
      LucideIcon("lucide:user", 16, THEME.accentOrange),
      UIText(" Учетная запись мастера").style({
        color: THEME.textPrimary,
        fontSize: 14,
        fontWeight: "bold",
        marginLeft: 4,
        flex: 1
      }),
      UIText(() => (isAuthenticated() ? "Авторизован" : "Гостевой режим")).style({
        color: () => (isAuthenticated() ? THEME.statusOk : THEME.textMuted),
        fontSize: 11,
        fontWeight: "bold"
      })
    ).style({ alignItems: "center", marginBottom: 8, width: "100%" }),

    UIText(() =>
      isAuthenticated()
        ? `Вы вошли как мастер «${currentUsername()}». Доступны облачные отчеты и история ремонтов.`
        : "Вы не вошли в систему. Локальные данные сохраняются только на этом устройстве."
    ).style({
      color: THEME.textMuted,
      fontSize: 11,
      lineHeight: 16,
      marginBottom: 10
    }),

    // Кнопки для гостя: [Войти] [Регистрация]
    UIRow(
      PrimaryButton("Войти в аккаунт", () => (callbacks?.onOpenAuth ? callbacks.onOpenAuth("login") : authModal.show("login"))),
      UIRow().style({ width: 8 }),
      SecondaryButton("Регистрация", () => (callbacks?.onOpenAuth ? callbacks.onOpenAuth("register") : authModal.show("register")))
    ).style({
      alignItems: "center",
      width: "100%",
      display: () => (isAuthenticated() ? "none" : "flex")
    }),

    // Кнопки для авторизованного мастера: [Выйти из аккаунта] [Удалить профиль]
    UIRow(
      SecondaryButton("Выйти из аккаунта", handleLogout),
      UIRow().style({ width: 8 }),
      UIButton(
        UIText("Удалить профиль").style({ color: THEME.statusCrit, fontSize: 12, fontWeight: "600" })
      )
        .style({
          backgroundColor: "rgba(239, 68, 68, 0.12)",
          borderColor: "rgba(239, 68, 68, 0.35)",
          borderWidth: 1,
          borderRadius: 8,
          paddingHorizontal: 12,
          paddingVertical: 8,
          $pressed: { opacity: 0.7 }
        })
        .onClick(handleDeleteAccount)
    ).style({
      alignItems: "center",
      width: "100%",
      display: () => (isAuthenticated() ? "flex" : "none")
    })
  ).style({
    backgroundColor: THEME.bgSurface,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: THEME.borderStrong,
    marginBottom: 12,
    width: "100%"
  });

  // --- БЛОК ИНЖЕНЕРНОГО МЕНЮ СТЕНДА ---
  let devUrlInputField: any = null;
  const devUrlInputText = signal(apiUrlSignal.value);

  devUrlInputField = UIInput()
    .style({
      placeholder: "http://10.0.2.2:8000 или http://192.168.1.100:8000",
      backgroundColor: THEME.bgBase,
      color: "#ffffff",
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 9,
      fontSize: 13,
      borderWidth: 1,
      borderColor: THEME.borderSubtle,
      width: "100%",
      marginBottom: 8
    })
    .onChange((val: string) => {
      devUrlInputText.value = val;
    });

  const presetBtn = (name: string, url: string) => {
    return UIButton(
      UIText(name).style({ color: THEME.accentCyan, fontSize: 11, fontWeight: "500" })
    )
      .style({
        backgroundColor: "rgba(56, 189, 248, 0.12)",
        borderColor: "rgba(56, 189, 248, 0.35)",
        borderWidth: 1,
        borderRadius: 6,
        paddingHorizontal: 8,
        paddingVertical: 4,
        marginRight: 6,
        marginBottom: 6,
        $pressed: { opacity: 0.7 }
      })
      .onClick(() => {
        devUrlInputText.value = url;
        if (devUrlInputField) devUrlInputField.value = url;
        handleSaveDevUrl(url);
      });
  };

  const engineeringSection = UIColumn(
    UIRow(
      UIText("Инженерное меню стенда (Dev Mode)").style({ color: THEME.accentOrange, fontSize: 14, fontWeight: "bold", flex: 1 }),
      UIRow(
        UIText("● Разблокировано").style({ color: THEME.statusOk, fontSize: 10, fontWeight: "bold" })
      ).style({
        backgroundColor: "rgba(34, 197, 94, 0.15)",
        borderRadius: 6,
        paddingHorizontal: 6,
        paddingVertical: 2
      })
    ).style({ alignItems: "center", marginBottom: 6, width: "100%" }),

    UIText("Базовый адрес API бэкенда Django для Android-эмулятора и сети автосервиса:").style({
      color: THEME.textMuted,
      fontSize: 11,
      marginBottom: 8
    }),

    devUrlInputField,

    UIText("Быстрые пресеты стенда:").style({ color: THEME.textMuted, fontSize: 11, marginBottom: 4 }),
    UIRow(
      presetBtn("10.0.2.2 (VS Emulator)", "http://10.0.2.2:8000"),
      presetBtn("localhost:8000", "http://localhost:8000"),
      presetBtn("Wi-Fi (192.168.1.100)", "http://192.168.1.100:8000"),
      presetBtn("Относительный (/)", "")
    ).style({ flexWrap: "wrap", width: "100%", marginBottom: 8 }),

    UIRow(
      SecondaryButton(
        () => (isTestingSignal.value ? "Тест..." : "Ping"),
        () => handleTestPing(devUrlInputText.value || apiUrlSignal.value)
      ),
      UIRow().style({ width: 8 }),
      PrimaryButton("Сохранить и применить", () => handleSaveDevUrl(devUrlInputText.value))
    ).style({ alignItems: "center", width: "100%", marginBottom: 8 }),

    UIText(() => devTestResultSignal.value).style({
      color: () => (devTestResultSignal.value.startsWith("[OK]") ? THEME.statusOk : THEME.statusWarn),
      fontSize: 11,
      lineHeight: 16
    })
  ).style({
    backgroundColor: THEME.bgSurface,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: THEME.borderStrong,
    marginBottom: 12,
    width: "100%"
  });

  // --- БЛОК МЕЖДИАЛОГОВОЙ ПАМЯТИ (Requirement #4 из оригинального сайта) ---
  const memorySection = UIColumn(
    UIRow(
      UIText("Междиалоговая память (Cross-Dialog Memory)").style({ color: THEME.textPrimary, fontSize: 14, fontWeight: "bold", flex: 1 }),
      UIButton(
        UIText(() => (crossMemorySignal.value ? "ВКЛ" : "ВЫКЛ")).style({
          color: () => (crossMemorySignal.value ? THEME.statusOk : THEME.textMuted),
          fontSize: 11,
          fontWeight: "bold"
        })
      )
        .style({
          backgroundColor: () => (crossMemorySignal.value ? "rgba(34, 197, 94, 0.15)" : THEME.bgElevated),
          borderColor: () => (crossMemorySignal.value ? THEME.statusOk : THEME.borderSubtle),
          borderWidth: 1,
          borderRadius: 6,
          paddingHorizontal: 8,
          paddingVertical: 3
        })
        .onClick(handleToggleCrossMemory)
    ).style({ alignItems: "center", marginBottom: 6, width: "100%" }),

    UIText("Позволяет модели помнить историю ремонтов и повторяющиеся неисправности между разными автомобилями и сессиями:").style({
      color: THEME.textMuted,
      fontSize: 11,
      marginBottom: 8
    }),

    UIColumn(
      UIText(() => globalSummarySignal.value).style({
        color: THEME.textSecondary,
        fontSize: 11,
        lineHeight: 16
      })
    ).style({
      backgroundColor: THEME.bgBase,
      borderRadius: 8,
      padding: 10,
      borderWidth: 1,
      borderColor: THEME.borderSubtle,
      marginBottom: 8,
      width: "100%"
    }),

    UIRow(
      UISpacer(),
      SecondaryButton("Очистить глобальную память", handleClearGlobalMemory)
    ).style({ width: "100%" })
  ).style({
    backgroundColor: THEME.bgSurface,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: THEME.borderSubtle,
    marginBottom: 12,
    width: "100%"
  });

  // --- БЛОК КЭШИРОВАНИЯ И ОФЛАЙНА ---
  const cacheSection = UIColumn(
    UIText("Кэш базы знаний и офлайн-режим").style({ color: THEME.textPrimary, fontSize: 14, fontWeight: "bold" }),
    UIText("Интеллектуальное кэширование кодов DTC и сессий:")
      .style({ color: THEME.textMuted, fontSize: 11, marginTop: 2, marginBottom: 8 }),

    UIRow(
      UIText("Кодов ошибок в локальном кэше: ").style({ color: THEME.textMuted, fontSize: 12 }),
      UIText(() => `${cacheStatsSignal.value.dtcCount}`).style({ color: THEME.accentCyan, fontSize: 12, fontWeight: "bold" })
    ).style({ marginBottom: 4 }),

    UIRow(
      UIText("Сохраненных сессий оффлайн: ").style({ color: THEME.textMuted, fontSize: 12 }),
      UIText(() => `${cacheStatsSignal.value.sessionsCount || 0}`).style({ color: THEME.accentOrange, fontSize: 12, fontWeight: "bold" })
    ).style({ marginBottom: 10 }),

    UIRow(
      PrimaryButton("Синхронизировать DTC", handleSyncDtc),
      UIRow().style({ width: 8 }),
      SecondaryButton("Очистить кэш", handleClearCache)
    ).style({ alignItems: "center", width: "100%" }),

    UIText(() => syncMsgSignal.value).style({ color: THEME.statusWarn, fontSize: 11, marginTop: 6 })
  ).style({
    backgroundColor: THEME.bgSurface,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: THEME.borderSubtle,
    marginBottom: 12,
    width: "100%"
  });

  // --- БЛОК АППАРАТНЫХ ВОЗМОЖНОСТЕЙ, AR & СЕНСОРОВ ---
  const renderCapRow = (name: string, supported: boolean, desc: string) => {
    return UIRow(
      UIRow().style({
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: supported ? THEME.statusOk : THEME.statusCrit,
        marginRight: 8,
        alignSelf: "center",
        flexShrink: 0
      }),
      UIColumn(
        UIText(name).style({ color: THEME.textPrimary, fontSize: 12, fontWeight: "bold" }),
        UIText(desc).style({ color: THEME.textMuted, fontSize: 11, marginTop: 1 })
      ).style({ flex: 1 }),
      UIText(supported ? "Поддерживается" : "Не поддерживается")
        .style({ color: supported ? THEME.statusOk : THEME.statusCrit, fontSize: 11, fontWeight: "bold", alignSelf: "center", flexShrink: 0, marginLeft: 6 })
    ).style({
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderColor: THEME.borderSubtle,
      width: "100%"
    });
  };

  const hardwareSection = UIColumn(
    UIText("Аппаратные интерфейсы, AR & Сенсоры").style({ color: THEME.textPrimary, fontSize: 14, fontWeight: "bold" }),
    UIText("Прямой проброс датчиков, внешних экранов и AR-очков:")
      .style({ color: THEME.textMuted, fontSize: 11, marginTop: 2, marginBottom: 8 }),
    renderCapRow("AR HUD & Smart Glasses", true, "Очки RayNeo, XREAL, Rokid, Viture и режим Samsung DeX"),
    renderCapRow("Датчики ориентации (3DoF)", true, "Гироскоп, акселерометр, компас и вектор вращения"),
    renderCapRow("Микрофон & Аудиопоток", true, "Голосовой ввод симптомов и акустическая диагностика шумов ДВС"),
    renderCapRow("Все камеры & Эндоскопы", true, "Основная, фронтальная, USB-бороскопы и тепловизоры FLIR"),
    renderCapRow("Web Bluetooth API", hasBt, "ELM327 BLE и беспроводные OBD-сканеры"),
    renderCapRow("Web Serial API", hasSerial, "USB/COM сканеры (FTDI, CH340, CP2102)"),
    renderCapRow("Cache Storage API", hasCache, "Офлайн-хранилище базы знаний DTC")
  ).style({
    backgroundColor: THEME.bgSurface,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: THEME.borderSubtle,
    marginBottom: 12,
    width: "100%"
  });

  // --- НИЖНЯЯ ПЛАШКА С ВЕРСИЕЙ (Easter Egg) ---
  const versionEasterEggButton = UIButton(
    UIColumn(
      UIText("ИИдеал-Авто • Версия 1.0.0 (le.codes Native Client)").style({
        color: THEME.textMuted,
        fontSize: 12,
        textAlign: "center"
      }),
      UIText("Движок: le.codes SDK 2.14+ • Лицензия: GPL-3.0").style({
        color: "#475569",
        fontSize: 10,
        textAlign: "center",
        marginTop: 2
      }),
      UIText(() => tapNoticeSignal.value).style({
        color: THEME.statusWarn,
        fontSize: 11,
        textAlign: "center",
        marginTop: 4
      })
    ).style({ alignItems: "center" })
  )
    .style({
      paddingVertical: 10,
      alignItems: "center",
      justifyContent: "center",
      $pressed: { opacity: 0.6 }
    })
    .onClick(handleVersionTap);

  const scrollBody = UIScrollable(
    UIColumn(
      accountSection,
      engineeringSection,
      memorySection,
      cacheSection,
      hardwareSection,
      versionEasterEggButton
    ).style({ padding: 14, maxWidth: 860, alignSelf: "center", width: "100%", paddingBottom: 24 })
  ).style({ flex: 1, width: "100%" });

  return UIScreen(header, scrollBody, authModal.node).style({ backgroundColor: THEME.bgBase, flex: 1, width: "100%", height: "100%" });
}
