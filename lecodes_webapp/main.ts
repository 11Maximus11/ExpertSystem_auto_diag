/**
 * Главная точка входа Android-оболочки ИИдеал-Авто на базе библиотеки le.codes.
 *
 * Назначение:
 * - Полноценная нативная Android-оболочка для существующего PWA-приложения.
 * - Полный аппаратный проброс OBD-II (Web Bluetooth, Web Serial, BLE).
 * - Скрытое Инженерное Меню (Dev Mode) для динамической смены базового адреса (IP и порт)
 *   тестового стенда (эмулятор Visual Studio .NET Android SDK 10.0.2.2:8000 / Wi-Fi стенд).
 * - Нативный автомобильный HUD-оверлей с датчиками телеметрии (RPM, Speed, Temp, Voltage).
 * - Двунаправленный мост между PWA и оболочкой le.codes через UIWebViewNode bridge.
 *
 * Лицензия: GPL-3.0
 */

// 1. Конфигурация темы приложения le.codes
theme({
  bg: "#0a0f1d",
  surface: "#121a2d",
  accent: "#2563eb",
  text: "#f8fafc",
  textMuted: "#94a3b8",
  border: "#1e293b",
  colorScheme: "dark"
});

// 2. Реактивное состояние оболочки
// Адрес сервера по умолчанию для Android-эмулятора (loopback к хосту ПК)
const DEFAULT_URL = "http://10.0.2.2:8000";

// Постоянно хранимый в памяти устройства адрес сервера
const serverUrl = signal<string>(DEFAULT_URL).stored("pwa_server_url");

// Состояния диалогов и оверлеев
const isDevMenuOpen = signal<boolean>(false);
const isHudVisible = signal<boolean>(false);
const statusText = signal<string>("Оболочка активна");
const isConnected = signal<boolean>(true);
const toastText = signal<string>("");

// Диагностика сети в инженерном меню
const pingLatency = signal<string>("не проверялась");
const isPinging = signal<boolean>(false);
const urlInputValue = signal<string>(serverUrl.value || DEFAULT_URL);

// Состояние телеметрии OBD-II для native HUD
const obdState = signal({
  rpm: 0,
  speed: 0,
  coolantTemp: 88,
  batteryVoltage: 12.6,
  status: "ELM327 BLE готов"
});

let simInterval: any = null;

// Счётчик кликов для скрытого инженерного меню (нужно 7 кликов)
let clickCount = 0;
let lastClickTime = 0;

function handleSecretClick() {
  const now = Date.now();
  if (now - lastClickTime > 2500) {
    clickCount = 0;
  }
  lastClickTime = now;
  clickCount++;

  if (clickCount >= 7) {
    clickCount = 0;
    urlInputValue.value = serverUrl.value;
    toastText.value = "Режим разработчика активирован!";
    devMenuModal.show();
  } else if (clickCount >= 3) {
    const left = 7 - clickCount;
    toastText.value = `Инженерное меню: осталось кликов: ${left}`;
  }
}

// 3. Создание узла UIWebViewNode для отображения PWA
const webNode = UIWebViewNode({
  url: serverUrl.value || DEFAULT_URL,
  bridge: true,
  externalLinks: "open"
}).style({
  flex: 1,
  width: "100%",
  height: "100%",
  backgroundColor: "#0a0f1d"
});

// Обработчики событий WebView
webNode.onLoad((ev) => {
  isConnected.value = true;
  statusText.value = `Стенд подключен (${ev.title || "PWA"})`;
  toastText.value = "";
});

webNode.onError((ev) => {
  isConnected.value = false;
  statusText.value = `Ошибка стенда: ${ev.message}`;
  toastText.value = `Не удалось связаться с ${serverUrl.value}. Проверьте инженерное меню (⚙)`;
});

webNode.onMessage((ev) => {
  const data = ev.data as any;
  if (data && typeof data === "object") {
    if (data.action === "open_engineering_menu") {
      urlInputValue.value = serverUrl.value;
      devMenuModal.show();
    } else if (data.action === "toggle_hud") {
      isHudVisible.value = !isHudVisible.value;
    } else if (data.action === "obd_data" && data.payload) {
      obdState.value = { ...obdState.value, ...data.payload };
    }
  }
});

// Симуляция OBD для тестирования HUD
function toggleObdSimulation() {
  if (simInterval) {
    clearInterval(simInterval);
    simInterval = null;
    obdState.value = {
      rpm: 0,
      speed: 0,
      coolantTemp: 88,
      batteryVoltage: 12.6,
      status: "ELM327 BLE отключен"
    };
    return;
  }
  let step = 0;
  simInterval = setInterval(() => {
    step++;
    const simRpm = 800 + Math.floor(Math.sin(step * 0.2) * 1200 + Math.random() * 80);
    const simSpeed = Math.max(0, Math.floor(Math.sin(step * 0.1) * 60 + 20));
    obdState.value = {
      rpm: Math.max(700, simRpm),
      speed: simSpeed,
      coolantTemp: 90 + Math.floor(Math.sin(step * 0.05) * 4),
      batteryVoltage: 14.1,
      status: "ELM327 BLE • Данные передаются"
    };
  }, 300);
}

// 4. Плавающая панель управления и статуса (Automotive Header Bar)
const headerBar = UIRow(
  // Левая колонка: бренд и статус
  UIColumn(
    UIRow(
      UIText("ИИдеал-Авто").style({
        fontSize: 14,
        fontWeight: "bold",
        color: "#f8fafc"
      }),
      UIText("• le.codes").style({
        fontSize: 12,
        color: "#38bdf8",
        marginLeft: 4
      })
    ).style({ alignItems: "center" }),

    UIText(() => statusText.value).style({
      fontSize: 10,
      color: () => (isConnected.value ? "#10b981" : "#ef4444"),
      marginTop: 2
    })
  ).style({ flex: 1 }),

  // Кнопка переключения OBD-II HUD
  UIButton(
    UIText(() => (isHudVisible.value ? "✕ HUD" : "⚡ HUD")).style({
      fontSize: 11,
      fontWeight: "600",
      color: () => (isHudVisible.value ? "#38bdf8" : "#94a3b8")
    })
  )
    .style({
      backgroundColor: "#1e293b",
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 6,
      marginRight: 8
    })
    .onClick(() => {
      isHudVisible.value = !isHudVisible.value;
    }),

  // Кнопка версии (секретный триггер: 7 кликов открывают Инженерное меню)
  UIButton(
    UIText("v1.0.0 ⚙").style({
      fontSize: 11,
      color: "#cbd5e1"
    })
  )
    .style({
      backgroundColor: "#1e293b",
      paddingHorizontal: 8,
      paddingVertical: 6,
      borderRadius: 6,
      borderColor: "#334155",
      borderWidth: 1
    })
    .onClick(() => {
      handleSecretClick();
    })
).style({
  height: 48,
  backgroundColor: "rgba(10, 15, 29, 0.92)",
  paddingHorizontal: 14,
  alignItems: "center",
  borderBottomWidth: 1,
  borderColor: "#1e293b"
});

// Всплывающее уведомление-подсказка при кликах
const toastBar = UIRow(
  UIText(() => toastText.value).style({
    fontSize: 11,
    color: "#f59e0b",
    textAlign: "center",
    flex: 1
  })
).style({
  backgroundColor: "rgba(30, 41, 59, 0.95)",
  paddingVertical: 4,
  paddingHorizontal: 12,
  display: () => (toastText.value ? "flex" : "none")
});

// 5. Автомобильный оверлей OBD-II HUD (выдвигается сверху/снизу)
const obdHudOverlay = UIBox(
  UIRow(
    // Датчик Обороты
    UIColumn(
      UIText("ОБОРОТЫ").style({ fontSize: 9, color: "#64748b", fontWeight: "bold" }),
      UIText(() => `${obdState.value.rpm}`).style({ fontSize: 20, fontWeight: "bold", color: "#38bdf8" }),
      UIText("об/мин").style({ fontSize: 9, color: "#94a3b8" })
    ).style({ flex: 1, alignItems: "center" }),

    // Датчик Скорость
    UIColumn(
      UIText("СКОРОСТЬ").style({ fontSize: 9, color: "#64748b", fontWeight: "bold" }),
      UIText(() => `${obdState.value.speed}`).style({ fontSize: 20, fontWeight: "bold", color: "#10b981" }),
      UIText("км/ч").style({ fontSize: 9, color: "#94a3b8" })
    ).style({ flex: 1, alignItems: "center" }),

    // Датчик ОЖ
    UIColumn(
      UIText("ТЕМП. ОЖ").style({ fontSize: 9, color: "#64748b", fontWeight: "bold" }),
      UIText(() => `${obdState.value.coolantTemp}°`).style({ fontSize: 20, fontWeight: "bold", color: "#f59e0b" }),
      UIText("Cels").style({ fontSize: 9, color: "#94a3b8" })
    ).style({ flex: 1, alignItems: "center" }),

    // Датчик АКБ
    UIColumn(
      UIText("АКБ").style({ fontSize: 9, color: "#64748b", fontWeight: "bold" }),
      UIText(() => `${obdState.value.batteryVoltage}`).style({ fontSize: 20, fontWeight: "bold", color: "#a855f7" }),
      UIText("Вольт").style({ fontSize: 9, color: "#94a3b8" })
    ).style({ flex: 1, alignItems: "center" })
  ).style({
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: "rgba(18, 26, 45, 0.95)",
    borderBottomWidth: 1,
    borderColor: "#2563eb"
  }),

  UIRow(
    UIText(() => `Статус: ${obdState.value.status}`).style({
      fontSize: 10,
      color: "#94a3b8",
      flex: 1
    }),
    UIButton(
      UIText(() => (simInterval ? "Остановить тест" : "Тест датчиков")).style({
        fontSize: 10,
        color: "#ffffff"
      })
    )
      .style({
        backgroundColor: "#2563eb",
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 4
      })
      .onClick(() => {
        toggleObdSimulation();
      })
  ).style({
    paddingHorizontal: 12,
    paddingVertical: 4,
    backgroundColor: "rgba(10, 15, 29, 0.95)",
    alignItems: "center"
  })
).style({
  display: () => (isHudVisible.value ? "flex" : "none")
});

// 6. Скрытое Инженерное Меню (Dev Mode) — реализовано через UIModal библиотеки le.codes
const devUrlInput = UIInput({
  placeholder: "http://10.0.2.2:8000",
  type: "url",
  enterKey: "done"
}).style({
  backgroundColor: "#0a0f1d",
  borderColor: "#2563eb",
  borderWidth: 1,
  borderRadius: 8,
  paddingHorizontal: 12,
  paddingVertical: 10,
  color: "#f8fafc",
  fontSize: 14,
  marginTop: 8
});

// Связываем изменение текста в поле ввода
devUrlInput.onChange((val) => {
  urlInputValue.value = val;
});

// Вспомогательная функция проверки связи со стендом (Ping)
async function testServerConnection(targetUrl: string) {
  isPinging.value = true;
  pingLatency.value = "Запрос отправлен...";
  const startTime = Date.now();
  try {
    const cleanUrl = targetUrl.replace(/\/+$/, "");
    const res = await fetch(`${cleanUrl}/api/settings/`, {
      method: "GET",
      headers: { Accept: "application/json" }
    });
    const elapsed = Date.now() - startTime;
    if (res.ok) {
      pingLatency.value = `✓ Связь есть! HTTP ${res.status} (${elapsed} мс)`;
    } else {
      pingLatency.value = `⚠️ Ответ стенда HTTP ${res.status} (${elapsed} мс)`;
    }
  } catch (err: any) {
    const elapsed = Date.now() - startTime;
    pingLatency.value = `✗ Стенд недоступен (${elapsed} мс): ${err?.message || "Ошибка сети"}`;
  } finally {
    isPinging.value = false;
  }
}

// Пресетные кнопки быстрого выбора адреса
function createPresetButton(title: string, presetUrl: string) {
  return UIButton(
    UIText(title).style({
      fontSize: 11,
      color: "#38bdf8",
      fontWeight: "500"
    })
  )
    .style({
      backgroundColor: "#131b2e",
      borderColor: "#1e293b",
      borderWidth: 1,
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 6,
      marginRight: 6
    })
    .onClick(() => {
      urlInputValue.value = presetUrl;
      devUrlInput.value = presetUrl;
    });
}

const devMenuModal = UIModal(
  UIColumn(
    // Заголовок модального окна
    UIRow(
      UIText("🛠️ Инженерное меню (Dev Mode)").style({
        fontSize: 16,
        fontWeight: "bold",
        color: "#f8fafc",
        flex: 1
      }),
      UIButton(
        UIText("✕").style({
          fontSize: 16,
          color: "#94a3b8"
        })
      )
        .style({
          padding: 4
        })
        .onClick(() => {
          devMenuModal.hide();
        })
    ).style({ alignItems: "center", marginBottom: 6 }),

    UIText("Настройка базового адреса PWA для эмулятора и локальной сети:").style({
      fontSize: 12,
      color: "#94a3b8",
      marginBottom: 6
    }),

    // Поле ввода адреса
    devUrlInput,

    // Пресеты быстрого переключения
    UIText("Быстрые пресеты стенда:").style({
      fontSize: 11,
      color: "#64748b",
      marginTop: 10,
      marginBottom: 6
    }),
    UIRow(
      createPresetButton("10.0.2.2 (VS Emulator)", "http://10.0.2.2:8000"),
      createPresetButton("localhost", "http://localhost:8000"),
      createPresetButton("Wi-Fi стенд", "http://192.168.1.100:8000")
    ).style({ flexWrap: "wrap", marginBottom: 12 }),

    // Диагностика связи
    UIRow(
      UIText("Статус сети: ").style({ fontSize: 11, color: "#64748b" }),
      UIText(() => pingLatency.value).style({
        fontSize: 11,
        color: () => (pingLatency.value.startsWith("✓") ? "#10b981" : "#f59e0b"),
        flex: 1
      })
    ).style({ alignItems: "center", marginBottom: 14 }),

    // Кнопки действий
    UIRow(
      // Сброс кэша
      UIButton(
        UIText("Сброс кэша").style({
          fontSize: 12,
          color: "#94a3b8"
        })
      )
        .style({
          backgroundColor: "#1e293b",
          paddingHorizontal: 12,
          paddingVertical: 10,
          borderRadius: 8,
          marginRight: 8
        })
        .onClick(() => {
          webNode.clearData();
          pingLatency.value = "Кэш браузера очищен";
        }),

      // Проверка связи (Ping)
      UIButton(
        UIText(() => (isPinging.value ? "Тест..." : "Ping")).style({
          fontSize: 12,
          color: "#ffffff",
          fontWeight: "600"
        })
      )
        .style({
          backgroundColor: "#334155",
          paddingHorizontal: 14,
          paddingVertical: 10,
          borderRadius: 8,
          marginRight: 8
        })
        .onClick(() => {
          testServerConnection(urlInputValue.value || serverUrl.value);
        }),

      // Сохранить и применить
      UIButton(
        UIText("Сохранить и загрузить").style({
          fontSize: 12,
          color: "#ffffff",
          fontWeight: "bold"
        })
      )
        .style({
          backgroundColor: "#2563eb",
          paddingHorizontal: 14,
          paddingVertical: 10,
          borderRadius: 8,
          flex: 1
        })
        .onClick(() => {
          const newUrl = (urlInputValue.value || serverUrl.value).trim().replace(/\/+$/, "");
          if (newUrl) {
            serverUrl.value = newUrl;
            webNode.url = newUrl;
            webNode.load(newUrl);
            statusText.value = `Загрузка: ${newUrl}`;
            devMenuModal.hide();
          }
        })
    ).style({ alignItems: "center" })
  ).style({
    backgroundColor: "#121a2d",
    borderColor: "#1e293b",
    borderWidth: 1,
    borderRadius: 16,
    padding: 18,
    width: "92%",
    maxWidth: 480
  })
);

// 7. Сборка главного экрана приложения le.codes
const mainScreen = UIScreen(
  headerBar,
  toastBar,
  obdHudOverlay,
  webNode
).style({
  flex: 1,
  backgroundColor: "#0a0f1d"
});

// Регистрируем виджет модального окна в экране
mainScreen.widgets(devMenuModal);

// 8. Инициализация роутера приложения
Router.init(mainScreen);

console.log("Оболочка le.codes успешно инициализирована. Базовый адрес:", serverUrl.value);
