/**
 * Экран «ИИ Диагностика» (AI Copilot & Repair Guidance).
 * Обеспечивает интерактивный диалог с экспертной системой, прикрепление телеметрии OBD2,
 * отображение этапов диагностики, интерактивных чекбоксов ремонта и списка запчастей.
 */

import { apiClient } from "../api/BackendApiClient";
import { obdProtocol } from "../obd/ELM327Protocol";
import { ChatMessageItem } from "../types";
import { DtcChip, HeaderBar, PrimaryButton, SecondaryButton } from "./components";

export function createDiagnosticsScreen(): any {
  // Реактивное состояние
  const vehicleSignal = signal("Lada Vesta 1.6 16V (2021)");
  const querySignal = signal("");
  const isAskingSignal = signal(false);
  const statusNoteSignal = signal("Готов к диагностике");

  // Начальные приветственные сообщения
  const messagesSignal = signal<ChatMessageItem[]>([
    {
      id: "msg-welcome",
      role: "assistant",
      content: "Здравствуйте! Я экспертная система автодиагностики «ИИдеал-Авто». Подключите OBD-II сканер во вкладке «OBD-II» для считывания параметров ЭБУ или опишите симптомы неисправности автомобиля (троение, посторонний шум, провалы тяги).",
      timestamp: "Сейчас",
      tasks: [
        { text: "Подключить ELM327 сканер (Bluetooth или USB)", done: false },
        { text: "Считать активные коды неисправностей (DTC)", done: false },
        { text: "Запустить проверку параметров смеси и зажигания", done: false }
      ],
      inventory: ["OBD-II сканер ELM327", "Мультиметр", "Очиститель контактов"]
    }
  ]);

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
    isAskingSignal.value = true;
    statusNoteSignal.value = "ИИдеал анализирует параметры...";

    try {
      // Собираем снимок с подключенного сканера
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
        dtcCodes: currentSensors.dtcList,
        tasks: result.tasks,
        inventory: result.inventory
      };

      addMessage(aiMsg);
      statusNoteSignal.value = "Диагностический план сформирован";
    } catch (err: any) {
      addMessage({
        id: "err-" + Date.now(),
        role: "system",
        content: `Ошибка связи с сервером: ${err.message || err}. Проверьте адрес бэкенда в Настройках или запустите api_server.py на порту 8000.`,
        timestamp: new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })
      });
      statusNoteSignal.value = "Ошибка запроса";
    } finally {
      isAskingSignal.value = false;
    }
  };

  const handleAttachObd = () => {
    const s = obdProtocol.getSensors();
    const obdText = `[Текущая телеметрия: Обороты=${s.rpm} об/мин, Скорость=${s.speed} км/ч, ОЖ=${s.coolantTemp}°C, АКБ=${s.voltage.toFixed(1)}V, Коды ошибок=${s.dtcList.join(", ") || "нет"}] `;
    querySignal.value = obdText + querySignal.value;
  };

  // Поле ввода автомобиля
  const vehicleInput = UIInput(vehicleSignal.value)
    .style({
      backgroundColor: "#131b2e",
      color: "#ffffff",
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 6,
      fontSize: 13,
      borderWidth: 1,
      borderColor: "#1e293b",
      width: 260
    })
    .onChange((val: string) => {
      vehicleSignal.value = val;
    });

  const header = HeaderBar(
    "ИИдеал-Авто • Диагностика",
    "Экспертная RAG-система поиска неисправностей",
    UIRow(
      UIText("Авто: ").style({ color: "#94a3b8", fontSize: 13, alignSelf: "center", marginRight: 6 }),
      vehicleInput
    )
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
      bg = "#1e293b";
      border = "#2563eb";
      title = "Вы (Диагност)";
      titleColor = "#60a5fa";
    } else if (isSystem) {
      bg = "rgba(239, 68, 68, 0.1)";
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
              justifyContent: "center"
            }),
            UIText(task.text).style({
              color: () => (checkboxState.value ? "#94a3b8" : "#f1f5f9"),
              fontSize: 13,
              textDecorationLine: () => (checkboxState.value ? "line-through" : "none")
            })
          ).style({ alignItems: "center" })
        )
          .style({ paddingVertical: 4, $pressed: { opacity: 0.7 } })
          .onClick(() => {
            checkboxState.value = !checkboxState.value;
            task.done = checkboxState.value;
            // Уведомляем сервер при наличии message id
            if (msg.id && !msg.id.startsWith("msg-")) {
              apiClient.toggleTask(msg.id, idx, checkboxState.value);
            }
          });
      });

      tasksBlock = UIColumn(
        UIText("Чеклист проверки и ремонта:").style({ color: "#f59e0b", fontSize: 13, fontWeight: "bold", marginBottom: 6 }),
        ...taskRows
      ).style({
        marginTop: 10,
        backgroundColor: "rgba(0, 0, 0, 0.25)",
        borderRadius: 8,
        padding: 10,
        borderWidth: 1,
        borderColor: "#334155"
      });
    }

    // Блок запчастей
    let inventoryBlock = null;
    if (msg.inventory && msg.inventory.length > 0) {
      inventoryBlock = UIColumn(
        UIText("Необходимые детали и инструмент:").style({ color: "#10b981", fontSize: 12, fontWeight: "bold", marginBottom: 4 }),
        UIText(msg.inventory.join(" • ")).style({ color: "#cbd5e1", fontSize: 12 })
      ).style({
        marginTop: 8,
        backgroundColor: "rgba(16, 185, 129, 0.08)",
        borderRadius: 6,
        padding: 8
      });
    }

    // Блок кодов ошибок
    let dtcBlock = null;
    if (msg.dtcCodes && msg.dtcCodes.length > 0) {
      dtcBlock = UIRow(
        UIText("Коды: ").style({ color: "#94a3b8", fontSize: 12, alignSelf: "center", marginRight: 4 }),
        ...msg.dtcCodes.map(code => DtcChip(code))
      ).style({ marginTop: 6, flexWrap: "wrap" });
    }

    return UIColumn(
      UIRow(
        UIText(title).style({ color: titleColor, fontSize: 12, fontWeight: "bold" }),
        UISpacer(),
        UIText(msg.timestamp).style({ color: "#64748b", fontSize: 11 })
      ),
      UIText(msg.content).style({
        color: "#f8fafc",
        fontSize: 14,
        lineHeight: 22,
        marginTop: 6
      }),
      dtcBlock,
      tasksBlock,
      inventoryBlock
    ).style({
      backgroundColor: bg,
      borderRadius: 14,
      padding: 14,
      borderWidth: 1,
      borderColor: border,
      marginBottom: 12,
      maxWidth: 820
    });
  };

  // Поле ввода сообщения
  const queryInput = UIInput("")
    .style({
      backgroundColor: "#131b2e",
      color: "#ffffff",
      borderRadius: 12,
      paddingHorizontal: 16,
      paddingVertical: 12,
      fontSize: 14,
      borderWidth: 1,
      borderColor: "#334155",
      flex: 1
    })
    .placeholder("Опишите неисправность, код ошибки или поведение авто...")
    .onChange((val: string) => {
      querySignal.value = val;
    })
    .onSubmit(() => {
      handleAsk();
    });

  const sendBtn = PrimaryButton(
    "Отправить",
    () => handleAsk()
  );

  const attachObdBtn = SecondaryButton(
    "+ OBD Телеметрия",
    () => handleAttachObd()
  );

  const bottomComposer = UIColumn(
    UIRow(
      UIText(() => statusNoteSignal.value).style({ color: "#94a3b8", fontSize: 12 }),
      UISpacer(),
      attachObdBtn
    ).style({ marginBottom: 8, alignItems: "center" }),
    UIRow(
      queryInput,
      UIRow().style({ width: 10 }),
      sendBtn
    ).style({ alignItems: "center" })
  ).style({
    backgroundColor: "#0d1322",
    borderTopWidth: 1,
    borderColor: "#1e293b",
    paddingHorizontal: 20,
    paddingVertical: 14
  });

  // Экран с прокручиваемым списком сообщений
  const chatScroll = UIScrollable(
    UIColumn(
      () => messagesSignal.value.map(m => renderMessageCard(m))
    ).style({ padding: 20, maxWidth: 860, alignSelf: "center", width: "100%" })
  ).style({ flexGrow: 1 });

  const screen = UIScreen(
    header,
    chatScroll,
    bottomComposer
  ).style({
    backgroundColor: "#0a0f1d",
    flex: 1
  });

  return screen;
}
