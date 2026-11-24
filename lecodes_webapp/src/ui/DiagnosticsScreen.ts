/**
 * Главный экран «ИИ Диагностика» (AI Copilot & Repair Guidance).
 * Точное воспроизведение интерфейса и возможностей оригинального мобильного сайта:
 * - AppHeader (бургер-меню, логотип, кнопка AR, настройки)
 * - VehicleBar (марка, модель, двигатель)
 * - SelectionToolbar (выделение сообщений, пакетное удаление, очистка диалога)
 * - ChatFeed (приветственная карточка с быстрыми сценариями, Markdown, интерактивные чеклисты, инвентарь, DTC)
 * - StagingBar (очередь вложений: фото, аудио, коды ошибок, OBD-телеметрия с удалением [×])
 * - ComposerDock (кнопки Камера, Файл, DTC, OBD, Голос, текстовое поле, кнопка Диагноз)
 * - Модалки: Камера, Редактирование авто, Ввод DTC
 *
 * Лицензия: GPL-3.0
 */

import { apiClient } from "../api/BackendApiClient";
import { obdProtocol } from "../obd/ELM327Protocol";
import { ChatMessageItem, StagedItem } from "../types";
import {
  AppHeader,
  DtcChip,
  LucideIcon,
  MessageCard,
  PrimaryButton,
  SecondaryButton,
  SelectionToolbar,
  StagingBar,
  THEME,
  VehicleBar
} from "./components";

export interface DiagnosticsScreenCallbacks {
  onToggleSidebar?: () => void;
  onNavigateToDtc?: (code?: string) => void;
  onNavigateToObd?: () => void;
  onOpenEngineeringMenu?: () => void;
  onOpenAuth?: () => void;
  onEnterAr?: () => void;
  userSignal?: any;
}

export function createDiagnosticsScreen(callbacks?: DiagnosticsScreenCallbacks): any {
  // Реактивное состояние экрана
  const vehicleSignal = signal("Lada Vesta 1.6 16V (2021)").stored("aideal_vehicle_info");
  const querySignal = signal("");
  const isAskingSignal = signal(false);
  const statusNoteSignal = signal("Готов к диагностике");

  // Очередь прикрепленных файлов (Staging)
  const stagedItemsSignal = signal<StagedItem[]>([]);

  // Выбранные сообщения для мультиудаления
  const selectedMessagesSignal = signal<string[]>([]);

  // Приветственное сообщение
  const welcomeMsg: ChatMessageItem = {
    id: "msg-welcome",
    role: "assistant",
    content: "Здравствуйте! Я экспертная система автодиагностики «ИИдеал-Авто». Задайте вопрос по неисправности автомобиля или выберите готовый сценарий:",
    timestamp: "Сейчас",
    diagnosticType: "diagnosis",
    summaryTitle: "Интеллектуальный стенд автодиагностики",
    followupSuggestions: [
      "P0300 Троит ДВС на холодную",
      "P0796 Пинки АКПП при переключении 2-3",
      "C0050 Ошибка датчика скорости ABS",
      "U1900 Ошибка шины данных CAN"
    ],
    tasks: [
      { text: "Подключить сканер ELM327 в разъем OBD-II", done: false },
      { text: "Считать активные коды неисправностей (DTC)", done: false },
      { text: "Сверить параметры дросселя и температуры ОЖ", done: false }
    ],
    inventory: ["OBD-II сканер ELM327", "Мультиметр цифровой", "Очиститель контактов"]
  };

  const messagesSignal = signal<ChatMessageItem[]>([welcomeMsg]);

  // Добавление сообщения в ленту (объявление)
  let addMessage: (msg: ChatMessageItem) => void;

  // Удаление сообщения
  const handleDeleteMessage = async (msgId: string) => {
    messagesSignal.value = messagesSignal.value.filter(m => m.id !== msgId);
    selectedMessagesSignal.value = selectedMessagesSignal.value.filter(id => id !== msgId);
    if (!msgId.startsWith("msg-") && !msgId.startsWith("user-")) {
      await apiClient.deleteMessages("", [msgId]);
    }
  };

  // Переключение выбора сообщения
  const handleToggleSelect = (msgId: string) => {
    const cur = selectedMessagesSignal.value;
    if (cur.includes(msgId)) {
      selectedMessagesSignal.value = cur.filter(id => id !== msgId);
    } else {
      selectedMessagesSignal.value = [...cur, msgId];
    }
  };

  // Массовые операции
  const handleSelectAll = () => {
    selectedMessagesSignal.value = messagesSignal.value.map(m => m.id);
  };

  const handleDeselectAll = () => {
    selectedMessagesSignal.value = [];
  };

  const handleDeleteSelected = async () => {
    const toDelete = selectedMessagesSignal.value;
    if (toDelete.length === 0) return;
    messagesSignal.value = messagesSignal.value.filter(m => !toDelete.includes(m.id));
    selectedMessagesSignal.value = [];
    await apiClient.deleteMessages("", toDelete);
  };

  const handleClearAll = async () => {
    messagesSignal.value = [welcomeMsg];
    selectedMessagesSignal.value = [];
    stagedItemsSignal.value = [];
    await apiClient.deleteMessages("", [], true);
  };

  // Удаление из Staging
  const handleRemoveStaged = (id: string) => {
    stagedItemsSignal.value = stagedItemsSignal.value.filter(item => item.id !== id);
  };

  // Отправка диагностического запроса
  const handleAsk = async (customQuery?: string) => {
    const q = (customQuery !== undefined ? customQuery : querySignal.value).trim();
    const staged = stagedItemsSignal.value;

    if (!q && staged.length === 0) return;
    if (isAskingSignal.value) return;

    const userMsg: ChatMessageItem = {
      id: "user-" + Date.now(),
      role: "user",
      content: q || "Диагностика по прикрепленным материалам:",
      timestamp: new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }),
      vehicle: vehicleSignal.value,
      attachments: [...staged]
    };

    addMessage(userMsg);
    querySignal.value = "";
    if (queryInput) {
      queryInput.value = "";
    }
    stagedItemsSignal.value = []; // очищаем staging после отправки

    isAskingSignal.value = true;
    statusNoteSignal.value = "Эксперт анализирует параметры и базы данных...";

    try {
      const currentSensors = obdProtocol.getSensors();

      const result = await apiClient.askExpert({
        query: userMsg.content,
        vehicleInfo: vehicleSignal.value,
        telemetry: currentSensors,
        stagedItems: userMsg.attachments,
        dtcCodes: currentSensors.dtcList
      });

      const aiMsg: ChatMessageItem = {
        id: result.messageId || ("ai-" + Date.now()),
        role: "assistant",
        content: result.answer,
        timestamp: new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }),
        diagnosticType: result.diagnosticType || "diagnosis",
        summaryTitle: result.summaryTitle || "Экспертное заключение",
        faults: result.faults,
        dtcCodes: result.dtcDetails && result.dtcDetails.length > 0
          ? result.dtcDetails.map((d: any) => d.code || String(d))
          : (currentSensors.dtcList || []),
        tasks: result.tasks,
        inventory: result.inventory,
        recommendations: result.recommendations,
        followupSuggestions: result.followupSuggestions
      };

      addMessage(aiMsg);
      statusNoteSignal.value = "Диагностический вердикт сформирован";
    } catch (err: any) {
      addMessage({
        id: "err-" + Date.now(),
        role: "system",
        content: `Ошибка связи с сервером: ${err.message || err}. Проверьте адрес бэкенда в Настройках.`,
        timestamp: new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })
      });
      statusNoteSignal.value = "Ошибка запроса к серверу";
    } finally {
      isAskingSignal.value = false;
    }
  };

  // Быстрый прикреп телеметрии OBD
  const handleAttachObd = () => {
    const s = obdProtocol.getSensors();
    const item: StagedItem = {
      id: "staged-obd-" + Date.now(),
      type: "obd",
      label: `OBD: ${s.rpm} об/мин, ${s.speed} км/ч, ОЖ=${s.coolantTemp}°C`,
      meta: "Телеметрия ELM327",
      data: s
    };
    stagedItemsSignal.value = [...stagedItemsSignal.value, item];

    // Если есть ошибки в OBD, добавляем их тоже
    if (s.dtcList && s.dtcList.length > 0) {
      s.dtcList.forEach(code => {
        if (!stagedItemsSignal.value.some(it => it.type === "dtc" && it.data === code)) {
          stagedItemsSignal.value = [
            ...stagedItemsSignal.value,
            { id: "staged-dtc-" + code + "-" + Date.now(), type: "dtc", label: code, data: code }
          ];
        }
      });
    }
    statusNoteSignal.value = "Параметры OBD прикреплены к запросу";
  };

  // Модалка добавления кода ошибки DTC
  let dtcInputModal: any = null;
  const dtcCodeInput = UIInput().style({
    placeholder: "Например: P0300, P0171, C0050",
    backgroundColor: THEME.bgBase,
    color: "#ffffff",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    borderWidth: 1,
    borderColor: THEME.borderSubtle,
    width: "100%",
    marginBottom: 12
  });

  dtcInputModal = UIModal(
    UIColumn(
      UIRow(
        UIText("Прикрепить код ошибки DTC").style({ color: THEME.textPrimary, fontSize: 14, fontWeight: "bold", flex: 1 }),
        UIButton(UIText("✕").style({ color: THEME.textMuted, fontSize: 13 }))
          .style({ padding: 4 })
          .onClick(() => dtcInputModal.hide())
      ).style({ alignItems: "center", marginBottom: 10, width: "100%" }),

      UIText("Введите стандартный код ошибки OBD-II (Powertrain, Chassis, Body, Network):").style({
        color: THEME.textSecondary,
        fontSize: 12,
        marginBottom: 8
      }),

      dtcCodeInput,

      UIRow(
        SecondaryButton("Отмена", () => dtcInputModal.hide()),
        UISpacer(),
        PrimaryButton("Добавить код", () => {
          const val = (dtcCodeInput.value || "").trim().toUpperCase();
          if (val) {
            const item: StagedItem = {
              id: "staged-dtc-" + Date.now(),
              type: "dtc",
              label: val,
              data: val
            };
            stagedItemsSignal.value = [...stagedItemsSignal.value, item];
            dtcCodeInput.value = "";
            dtcInputModal.hide();
          }
        })
      ).style({ alignItems: "center", width: "100%" })
    ).style({
      backgroundColor: THEME.bgSurface,
      borderRadius: 14,
      padding: 16,
      borderWidth: 1,
      borderColor: THEME.borderStrong,
      width: "90%",
      maxWidth: 380
    })
  );

  // Модалка редактирования автомобиля
  let vehicleModal: any = null;
  const vehicleModalInput = UIInput().style({
    placeholder: "Марка, модель, год, двигатель (напр. Lada Vesta 1.6 2021)",
    backgroundColor: THEME.bgBase,
    color: "#ffffff",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    borderWidth: 1,
    borderColor: THEME.borderSubtle,
    width: "100%",
    marginBottom: 12
  });

  vehicleModal = UIModal(
    UIColumn(
      UIRow(
        UIText("Профиль автомобиля").style({ color: THEME.textPrimary, fontSize: 14, fontWeight: "bold", flex: 1 }),
        UIButton(UIText("✕").style({ color: THEME.textMuted, fontSize: 13 }))
          .style({ padding: 4 })
          .onClick(() => vehicleModal.hide())
      ).style({ alignItems: "center", marginBottom: 10, width: "100%" }),

      UIText("Укажите марку, модель, год и двигатель для точной выборки схем и допусков:").style({
        color: THEME.textSecondary,
        fontSize: 12,
        marginBottom: 8
      }),

      vehicleModalInput,

      UIRow(
        SecondaryButton("Отмена", () => vehicleModal.hide()),
        UISpacer(),
        PrimaryButton("Сохранить", () => {
          const val = (vehicleModalInput.value || "").trim();
          if (val) {
            vehicleSignal.value = val;
            apiClient.setSessionVehicle("", val);
            vehicleModal.hide();
          }
        })
      ).style({ alignItems: "center", width: "100%" })
    ).style({
      backgroundColor: THEME.bgSurface,
      borderRadius: 14,
      padding: 16,
      borderWidth: 1,
      borderColor: THEME.borderStrong,
      width: "90%",
      maxWidth: 400
    })
  );

  // Модалка камеры (встроенный захват кадра)
  let cameraModal: any = null;
  const cameraFacingSignal = signal<"environment" | "user">("environment");

  cameraModal = UIModal(
    UIColumn(
      UIRow(
        UIText("Диагностическая камера").style({ color: THEME.textPrimary, fontSize: 14, fontWeight: "bold", flex: 1 }),
        UIButton(
          UIText(() => (cameraFacingSignal.value === "environment" ? "Основная" : "Фронтальная")).style({
            color: THEME.accentCyan,
            fontSize: 11,
            fontWeight: "bold"
          })
        )
          .style({ paddingHorizontal: 8, paddingVertical: 4, backgroundColor: THEME.bgElevated, borderRadius: 6, marginRight: 8 })
          .onClick(() => {
            cameraFacingSignal.value = cameraFacingSignal.value === "environment" ? "user" : "environment";
          }),
        UIButton(UIText("✕").style({ color: THEME.textMuted, fontSize: 13 }))
          .style({ padding: 4 })
          .onClick(() => cameraModal.hide())
      ).style({ alignItems: "center", marginBottom: 10, width: "100%" }),

      // Видоискатель
      UIColumn(
        UIText("Видоискатель камеры узла / эндоскопа").style({ color: THEME.textMuted, fontSize: 11, marginBottom: 8 }),
        UIRow(
          UIText("[ Прицельная рамка узла ]").style({ color: THEME.accentOrange, fontSize: 13, fontWeight: "bold" })
        ).style({
          width: 180,
          height: 120,
          borderRadius: 8,
          borderWidth: 1.5,
          borderColor: THEME.accentOrange,
          borderStyle: "dashed",
          alignItems: "center",
          justifyContent: "center"
        })
      ).style({
        width: "100%",
        height: 220,
        backgroundColor: "#050811",
        borderRadius: 10,
        alignItems: "center",
        justifyContent: "center",
        borderWidth: 1,
        borderColor: THEME.borderSubtle,
        marginBottom: 12
      }),

      UIRow(
        SecondaryButton("Отмена", () => cameraModal.hide()),
        UISpacer(),
        PrimaryButton("Сделать снимок", () => {
          const item: StagedItem = {
            id: "staged-photo-" + Date.now(),
            type: "photo",
            label: `Снимок узла (${cameraFacingSignal.value})`,
            data: "data:image/jpeg;base64,camera_shot_data"
          };
          stagedItemsSignal.value = [...stagedItemsSignal.value, item];
          cameraModal.hide();
          statusNoteSignal.value = "Фотоснимок добавлен во вложения";
        })
      ).style({ alignItems: "center", width: "100%" })
    ).style({
      backgroundColor: THEME.bgSurface,
      borderRadius: 14,
      padding: 16,
      borderWidth: 1,
      borderColor: THEME.borderStrong,
      width: "92%",
      maxWidth: 420
    })
  );

  // Голосовой ввод (запись звука)
  const isRecordingSignal = signal(false);
  const handleToggleVoice = () => {
    isRecordingSignal.value = !isRecordingSignal.value;
    if (isRecordingSignal.value) {
      statusNoteSignal.value = "Запись звука двигателя/симптома...";
    } else {
      const item: StagedItem = {
        id: "staged-voice-" + Date.now(),
        type: "audio",
        label: "Аудиозапись симптома (WAV 16кГц)",
        data: "audio_blob_pcm"
      };
      stagedItemsSignal.value = [...stagedItemsSignal.value, item];
      statusNoteSignal.value = "Голосовая запись добавлена во вложения";
    }
  };

  // Поле ввода сообщения
  let queryInput: any = null;
  queryInput = UIInput()
    .style({
      placeholder: "Опишите неисправность авто, симптомы или код ошибки...",
      backgroundColor: THEME.bgElevated,
      color: "#ffffff",
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 9,
      fontSize: 13,
      borderWidth: 1,
      borderColor: THEME.borderSubtle,
      flex: 1
    })
    .onChange((val: string) => {
      querySignal.value = val;
    })
    .onSubmit(() => {
      handleAsk();
    });

  // Нижняя панель компоновщика (Composer Dock)
  const composerDock = UIColumn(
    StagingBar(stagedItemsSignal, handleRemoveStaged),

    UIRow(
      // Инструменты мультимодального ввода с векторными иконками 1-в-1 как на сайте
      UIButton(LucideIcon("lucide:camera", 18, THEME.accentCyan))
        .style({ padding: 7, backgroundColor: "rgba(56, 189, 248, 0.12)", borderRadius: 7, borderWidth: 1, borderColor: "rgba(56, 189, 248, 0.3)", marginRight: 5 })
        .onClick(() => cameraModal.show()),

      UIButton(LucideIcon("lucide:paperclip", 18, THEME.textSecondary))
        .style({ padding: 7, backgroundColor: THEME.bgElevated, borderRadius: 7, borderWidth: 1, borderColor: THEME.borderSubtle, marginRight: 5 })
        .onClick(() => {
          const item: StagedItem = {
            id: "staged-doc-" + Date.now(),
            type: "file",
            label: "Диагностический отчет (.obd)",
            data: "log_telemetry"
          };
          stagedItemsSignal.value = [...stagedItemsSignal.value, item];
          statusNoteSignal.value = "Файл отчета прикреплен к запросу";
        }),

      UIButton(LucideIcon("lucide:book-open", 18, THEME.statusCrit))
        .style({ padding: 7, backgroundColor: "rgba(239, 68, 68, 0.12)", borderRadius: 7, borderWidth: 1, borderColor: "rgba(239, 68, 68, 0.3)", marginRight: 5 })
        .onClick(() => dtcInputModal.show()),

      UIButton(LucideIcon("lucide:sliders", 18, THEME.statusOk))
        .style({ padding: 7, backgroundColor: "rgba(34, 197, 94, 0.12)", borderRadius: 7, borderWidth: 1, borderColor: "rgba(34, 197, 94, 0.3)", marginRight: 5 })
        .onClick(handleAttachObd),

      UIButton(
        LucideIcon("lucide:mic", 19, () => (isRecordingSignal.value ? "#ffffff" : "#ec4899"))
      )
        .style({
          padding: 7,
          backgroundColor: () => (isRecordingSignal.value ? "#ef4444" : "rgba(236, 72, 153, 0.15)"),
          borderRadius: 7,
          borderWidth: 1,
          borderColor: () => (isRecordingSignal.value ? "#f87171" : "rgba(236, 72, 153, 0.35)"),
          marginRight: 6
        })
        .onClick(handleToggleVoice),

      UISpacer(),

      UIText(() => statusNoteSignal.value).style({ color: THEME.textMuted, fontSize: 10 })
    ).style({ alignItems: "center", width: "100%", marginBottom: 6 }),

    UIRow(
      queryInput,
      UIRow().style({ width: 8 }),
      UIButton(
        UIRow(
          LucideIcon("lucide:send", 14, "#ffffff"),
          UIText(() => (isAskingSignal.value ? "..." : "Диагноз")).style({
            color: "#ffffff",
            fontSize: 13,
            fontWeight: "bold",
            marginLeft: 5
          })
        ).style({ alignItems: "center" })
      )
        .style({
          background: "linear-gradient(135deg, #f97316, #ea580c)",
          borderRadius: 8,
          paddingHorizontal: 13,
          paddingVertical: 9,
          $pressed: { opacity: 0.85 }
        })
        .onClick(() => handleAsk())
    ).style({ alignItems: "center", width: "100%" })
  ).style({
    backgroundColor: THEME.bgSurface,
    borderTopWidth: 1,
    borderColor: THEME.borderSubtle,
    paddingHorizontal: 12,
    paddingVertical: 8,
    width: "100%"
  });

  // Прокручиваемая лента сообщений
  const chatFeedColumn = UIColumn().style({
    padding: 12,
    width: "100%",
    maxWidth: 860,
    alignSelf: "center",
    paddingBottom: 16
  });

  const messageCallbacks = {
    onToggleSelect: handleToggleSelect,
    onDelete: handleDeleteMessage,
    onNavigateDtc: (code: string) => callbacks?.onNavigateToDtc?.(code),
    onToggleTask: (msgId: string, taskIdx: number, done: boolean) => {
      apiClient.toggleTask(msgId, taskIdx, done);
    },
    onFollowupClick: (text: string) => handleAsk(text)
  };

  // Добавляем начальное сообщение
  chatFeedColumn.append(MessageCard(welcomeMsg, messageCallbacks));

  // Добавление сообщения в ленту
  addMessage = (msg: ChatMessageItem) => {
    messagesSignal.value = [...messagesSignal.value, msg];
    chatFeedColumn.append(MessageCard(msg, messageCallbacks));
  };

  const chatScroll = UIScrollable(chatFeedColumn).style({ flex: 1, width: "100%" });

  // Сборка экрана
  const screen = UIScreen(
    AppHeader({
      onToggleSidebar: () => callbacks?.onToggleSidebar?.(),
      onEnterAr: () => callbacks?.onEnterAr?.(),
      onOpenSettings: () => callbacks?.onOpenEngineeringMenu?.(),
      onEditVehicle: () => {
        vehicleModalInput.value = vehicleSignal.value;
        vehicleModal.show();
      },
      vehicleSignal: vehicleSignal
    }),
    VehicleBar(vehicleSignal, () => {
      vehicleModalInput.value = vehicleSignal.value;
      vehicleModal.show();
    }),
    SelectionToolbar(
      signal(() => selectedMessagesSignal.value.length),
      messagesSignal.value.length,
      handleSelectAll,
      handleDeleteSelected,
      handleDeselectAll,
      handleClearAll
    ),
    chatScroll,
    composerDock
  ).style({
    backgroundColor: THEME.bgBase,
    flex: 1,
    width: "100%",
    height: "100%"
  });

  // Монтируем вспомогательные модалки
  screen.widgets(dtcInputModal, vehicleModal, cameraModal);

  return screen;
}
