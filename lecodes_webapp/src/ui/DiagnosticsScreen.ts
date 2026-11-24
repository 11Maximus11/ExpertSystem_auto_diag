/**
 * Экран «ИИ Диагностика» (AI Copilot & Repair Guidance).
 * Обеспечивает интерактивный диалог с экспертной системой, прикрепление телеметрии OBD2,
 * отображение этапов диагностики, интерактивных чекбоксов ремонта и списка запчастей.
 * Адаптирован под вертикальные экраны смартфонов и десктоп.
 * Лицензия: GPL-3.0
 */

import { apiClient } from "../api/BackendApiClient";
import { obdProtocol } from "../obd/ELM327Protocol";
import { ChatMessageItem } from "../types";
import { DtcChip, HeaderBar, PrimaryButton, SecondaryButton } from "./components";

export interface DiagnosticsScreenCallbacks {
  onNavigateToDtc?: (code: string) => void;
  onOpenEngineeringMenu?: () => void;
}

export function createDiagnosticsScreen(callbacks?: DiagnosticsScreenCallbacks): any {
  // Реактивное состояние
  const vehicleSignal = signal("Lada Vesta 1.6 16V (2021)");
  const querySignal = signal("");
  const isAskingSignal = signal(false);
  const statusNoteSignal = signal("Готов к диагностике");

  const welcomeMsg: ChatMessageItem = {
    id: "msg-welcome",
    role: "assistant",
    content: "Здравствуйте! Я экспертная система автодиагностики «ИИдеал-Авто». Задайте вопрос по неисправности автомобиля (например, «троит на холодную», «ошибка P0300», «пропала тяга») или подключите OBD-II сканер для считывания параметров ЭБУ.",
    timestamp: "Сейчас",
    tasks: [
      { text: "Подключить сканер ELM327 во вкладке «Приборы OBD»", done: false },
      { text: "Считать активные коды неисправностей (DTC)", done: false },
      { text: "Проверить показания датчиков температуры ОЖ и дросселя", done: false }
    ],
    inventory: ["OBD-II сканер ELM327", "Мультиметр", "Очиститель дроссельной заслонки"]
  };

  const messagesSignal = signal<ChatMessageItem[]>([welcomeMsg]);

  const addMessage = (msg: ChatMessageItem) => {
    messagesSignal.value = [...messagesSignal.value, msg];
  };

  const handleAsk = async () => {
    const q = querySignal.value.trim();
    if (!q || isAskingSignal.value) return;

    const userMsg: ChatMessageItem = {
      id: "user-" + Date.now(),
      role: "user",
      content: q,
      timestamp: new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }),
      vehicle: vehicleSignal.value
    };

    addMessage(userMsg);
    querySignal.value = "";
    if (queryInput) {
      queryInput.value = "";
    }
    isAskingSignal.value = true;
    statusNoteSignal.value = "ИИдеал анализирует параметры...";

    try {
      const currentSensors = obdProtocol.getSensors();

      const result = await apiClient.askExpert({
        query: q,
        vehicleInfo: vehicleSignal.value,
        telemetry: currentSensors,
        dtcCodes: currentSensors.dtcList
      });

      const aiMsg: ChatMessageItem = {
        id: result.messageId || ("ai-" + Date.now()),
        role: "assistant",
        content: result.answer,
        timestamp: new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }),
        dtcCodes: result.dtcDetails && result.dtcDetails.length > 0
          ? result.dtcDetails.map((d: any) => d.code || String(d))
          : (currentSensors.dtcList || []),
        tasks: result.tasks,
        inventory: result.inventory
      };

      addMessage(aiMsg);
      statusNoteSignal.value = "Диагностический план готов";
    } catch (err: any) {
      addMessage({
        id: "err-" + Date.now(),
        role: "system",
        content: `Ошибка связи с сервером: ${err.message || err}. Проверьте адрес бэкенда в Настройках / Инженерном меню.`,
        timestamp: new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })
      });
      statusNoteSignal.value = "Ошибка запроса к серверу";
    } finally {
      isAskingSignal.value = false;
    }
  };

  const handleAttachObd = () => {
    const s = obdProtocol.getSensors();
    const obdText = `[OBD-II телеметрия: Обороты=${s.rpm} об/мин, Скорость=${s.speed} км/ч, ОЖ=${s.coolantTemp}°C, АКБ=${s.voltage.toFixed(1)}V, Ошибки=${s.dtcList.join(", ") || "нет"}] `;
    querySignal.value = obdText + querySignal.value;
    if (queryInput) {
      queryInput.value = querySignal.value;
    }
    statusNoteSignal.value = "Телеметрия прикреплена к вопросу";
  };

  const handleSimulatePhoto = () => {
    statusNoteSignal.value = "Фото детали прикреплено (Gemma 4 Vision)";
    querySignal.value = querySignal.value + " [📷 Прикреплено фото компонента двигателя] ";
    if (queryInput) {
      queryInput.value = querySignal.value;
    }
  };

  // Поле ввода автомобиля
  const vehicleInput = UIInput()
    .style({
      placeholder: "Модель автомобиля",
      backgroundColor: "#131b2e",
      color: "#f8fafc",
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 4,
      fontSize: 12,
      borderWidth: 1,
      borderColor: "#1e293b",
      flex: 1
    })
    .onChange((val: string) => {
      vehicleSignal.value = val;
    });
  vehicleInput.value = vehicleSignal.value;

  const vehicleBar = UIRow(
    UIText("🚗 Профиль:").style({ color: "#94a3b8", fontSize: 11, marginRight: 6, alignSelf: "center" }),
    vehicleInput,
    UIRow().style({ width: 6 }),
    UIButton(
      UIText("Сброс").style({ color: "#94a3b8", fontSize: 11 })
    )
      .style({
        backgroundColor: "#1e293b",
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 6
      })
      .onClick(() => {
        messagesSignal.value = [welcomeMsg];
        statusNoteSignal.value = "Диалог сброшен";
      })
  ).style({
    paddingHorizontal: 16,
    paddingVertical: 6,
    backgroundColor: "#0c1222",
    borderBottomWidth: 1,
    borderColor: "#1e293b",
    alignItems: "center"
  });

  const header = HeaderBar(
    "ИИдеал-Авто • Диагностика",
    "Экспертная RAG-система поиска неисправностей",
    callbacks?.onOpenEngineeringMenu
      ? UIButton(
          UIText("⚙ Инж. меню").style({ color: "#38bdf8", fontSize: 11, fontWeight: "600" })
        )
          .style({
            backgroundColor: "#1e293b",
            paddingHorizontal: 8,
            paddingVertical: 4,
            borderRadius: 6,
            borderWidth: 1,
            borderColor: "#334155"
          })
          .onClick(() => callbacks.onOpenEngineeringMenu?.())
      : null
  );

  // Отрисовка сообщения чата
  const renderMessageCard = (msg: ChatMessageItem) => {
    const isUser = msg.role === "user";
    const isSystem = msg.role === "system";

    let bg = "#131b2e";
    let border = "#1e293b";
    let title = "ИИдеал Эксперт (Gemma 4 + RAG)";
    let titleColor = "#38bdf8";

    if (isUser) {
      bg = "#1a253c";
      border = "#2563eb";
      title = "Вы (Диагност)";
      titleColor = "#60a5fa";
    } else if (isSystem) {
      bg = "rgba(239, 68, 68, 0.12)";
      border = "#ef4444";
      title = "Системное уведомление";
      titleColor = "#f87171";
    }

    // Блок чеклиста задач
    let tasksBlock = null;
    if (msg.tasks && msg.tasks.length > 0) {
      const taskRows = msg.tasks.map((task, idx) => {
        const checkboxState = signal(task.done);
        return UIButton(
          UIRow(
            UIRow().style({
              width: 16,
              height: 16,
              borderRadius: 4,
              borderWidth: 2,
              borderColor: () => (checkboxState.value ? "#10b981" : "#64748b"),
              backgroundColor: () => (checkboxState.value ? "#10b981" : "transparent"),
              marginRight: 8,
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0
            }),
            UIText(task.text).style({
              color: () => (checkboxState.value ? "#94a3b8" : "#f1f5f9"),
              fontSize: 12,
              lineHeight: 18,
              flex: 1,
              textDecorationLine: () => (checkboxState.value ? "line-through" : "none")
            })
          ).style({ alignItems: "flex-start", width: "100%" })
        )
          .style({ paddingVertical: 4, width: "100%", $pressed: { opacity: 0.7 } })
          .onClick(() => {
            checkboxState.value = !checkboxState.value;
            task.done = checkboxState.value;
            if (msg.id && !msg.id.startsWith("msg-") && !msg.id.startsWith("user-")) {
              apiClient.toggleTask(msg.id, idx, checkboxState.value);
            }
          });
      });

      tasksBlock = UIColumn(
        UIText("Чеклист проверки и ремонта:").style({ color: "#f59e0b", fontSize: 12, fontWeight: "bold", marginBottom: 6 }),
        ...taskRows
      ).style({
        marginTop: 10,
        backgroundColor: "rgba(0, 0, 0, 0.3)",
        borderRadius: 8,
        padding: 10,
        borderWidth: 1,
        borderColor: "#334155",
        width: "100%"
      });
    }

    // Блок запчастей
    let inventoryBlock = null;
    if (msg.inventory && msg.inventory.length > 0) {
      inventoryBlock = UIColumn(
        UIText("Необходимые детали и инструмент:").style({ color: "#10b981", fontSize: 11, fontWeight: "bold", marginBottom: 4 }),
        UIText(msg.inventory.join(" • ")).style({ color: "#cbd5e1", fontSize: 11, lineHeight: 16 })
      ).style({
        marginTop: 8,
        backgroundColor: "rgba(16, 185, 129, 0.08)",
        borderRadius: 6,
        padding: 8,
        width: "100%"
      });
    }

    // Блок кодов ошибок
    let dtcBlock = null;
    if (msg.dtcCodes && msg.dtcCodes.length > 0) {
      dtcBlock = UIRow(
        UIText("Коды: ").style({ color: "#94a3b8", fontSize: 11, alignSelf: "center", marginRight: 4 }),
        ...msg.dtcCodes.map(code => DtcChip(code, () => callbacks?.onNavigateToDtc?.(code)))
      ).style({ marginTop: 6, flexWrap: "wrap" });
    }

    return UIColumn(
      UIRow(
        UIText(title).style({ color: titleColor, fontSize: 12, fontWeight: "bold" }),
        UISpacer(),
        UIText(msg.timestamp).style({ color: "#64748b", fontSize: 10 })
      ).style({ width: "100%" }),
      UIText(msg.content).style({
        color: "#f8fafc",
        fontSize: 13,
        lineHeight: 20,
        marginTop: 6
      }),
      dtcBlock,
      tasksBlock,
      inventoryBlock
    ).style({
      backgroundColor: bg,
      borderRadius: 12,
      padding: 12,
      borderWidth: 1,
      borderColor: border,
      marginBottom: 10,
      width: "100%",
      maxWidth: 820,
      alignSelf: "center"
    });
  };

  // Поле ввода сообщения
  let queryInput: any = null;
  queryInput = UIInput()
    .style({
      placeholder: "Опишите неисправность авто или код ошибки...",
      backgroundColor: "#131b2e",
      color: "#ffffff",
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 9,
      fontSize: 13,
      borderWidth: 1,
      borderColor: "#334155",
      flex: 1
    })
    .onChange((val: string) => {
      querySignal.value = val;
    })
    .onSubmit(() => {
      handleAsk();
    });

  const sendBtn = PrimaryButton(
    () => (isAskingSignal.value ? "..." : "Отправить"),
    () => handleAsk()
  );

  const bottomComposer = UIColumn(
    UIRow(
      UIText(() => statusNoteSignal.value).style({ color: "#94a3b8", fontSize: 11, flex: 1 }),
      UIButton(UIText("+ OBD").style({ color: "#38bdf8", fontSize: 11, fontWeight: "bold" }))
        .style({ backgroundColor: "#1e293b", paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, marginRight: 6 })
        .onClick(handleAttachObd),
      UIButton(UIText("📷 Фото").style({ color: "#cbd5e1", fontSize: 11 }))
        .style({ backgroundColor: "#1e293b", paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 })
        .onClick(handleSimulatePhoto)
    ).style({ marginBottom: 6, alignItems: "center", width: "100%" }),
    UIRow(
      queryInput,
      UIRow().style({ width: 8 }),
      sendBtn
    ).style({ alignItems: "center", width: "100%" })
  ).style({
    backgroundColor: "rgba(13, 19, 34, 0.98)",
    borderTopWidth: 1,
    borderColor: "#1e293b",
    paddingHorizontal: 14,
    paddingVertical: 10,
    width: "100%"
  });

  // Экран с прокручиваемым списком сообщений
  const chatScroll = UIScrollable(
    UIColumn(
      () => messagesSignal.value.map(m => renderMessageCard(m))
    ).style({ padding: 14, width: "100%", maxWidth: 860, alignSelf: "center", paddingBottom: 16 })
  ).style({ flex: 1, width: "100%" });

  const screen = UIScreen(
    header,
    vehicleBar,
    chatScroll,
    bottomComposer
  ).style({
    backgroundColor: "#0a0f1d",
    flex: 1,
    width: "100%",
    height: "100%"
  });

  return screen;
}
