/**
 * Единое реактивное хранилище состояния клиента ИИдеал-Авто.
 * Связывает экраны «Диагноз», «Чеклист & DTC», «OBD-2», «Сессии»,
 * «Настройки» и оверлей «AR HUD» в единый живой контур (100% паритет с сайтом).
 *
 * Лицензия: GPL-3.0
 */

import { cacheManager } from "../cache/ResourceCacheManager";
import {
  AuthUser,
  ChatMessageItem,
  DiagnosticSessionItem,
  OBDLiveSensors,
  ProjectItem,
  StagedItem
} from "../types";

export function generateUuidV4(): string {
  if (typeof crypto !== "undefined" && typeof (crypto as any).randomUUID === "function") {
    try {
      return (crypto as any).randomUUID();
    } catch (_) {}
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function createWelcomeMessage(): ChatMessageItem {
  return {
    id: "msg-welcome",
    role: "assistant",
    content:
      "Здравствуйте! Я экспертная система автодиагностики «ИИдеал Авто». Готов помочь локализовать поломку, расшифровать ошибки ЭБУ и составить пошаговый план ремонта.\n\nОпишите симптом своими словами, выберите код ошибки OBD-II из словаря, прикрепите лог сканера или фото неисправного узла, либо запишите голосовой вопрос.",
    timestamp: "Сейчас",
    diagnosticType: "diagnosis",
    summaryTitle: "Интеллектуальный стенд автодиагностики и пошагового ремонта",
    followupSuggestions: [
      "Двигатель троит на холостых, мигает Check Engine, ошибка P0300",
      "Жёсткие пинки АКПП при переключении с 1 на 2 передачу, код P0796",
      "Педаль тормоза стала мягкой и проваливается, ошибка C0050",
      "Потеря связи по шине CAN с блоком управления, ошибка U1900",
      "Пневмоподвеска не поднимает кузов, ошибка компрессора C1731"
    ],
    tasks: [
      { id: 1, step_number: 1, title: "Подключить сканер ELM327 в разъем OBD-II", text: "Подключить сканер ELM327 в разъем OBD-II", done: false },
      { id: 2, step_number: 2, title: "Считать активные коды неисправностей (DTC)", text: "Считать активные коды неисправностей (DTC)", done: false },
      { id: 3, step_number: 3, title: "Сверить параметры дросселя и температуры ОЖ", text: "Сверить параметры дросселя и температуры ОЖ", done: false }
    ],
    inventoryItems: [
      { id: "inv-init-1", name: "OBD-II сканер ELM327", category: "tool", spec: "Bluetooth / USB", checked: false },
      { id: "inv-init-2", name: "Мультиметр цифровой", category: "tool", spec: "True RMS", checked: false },
      { id: "inv-init-3", name: "Очиститель контактов", category: "consumable", spec: "Диэлектрик", checked: false }
    ],
    inventory: ["OBD-II сканер ELM327", "Мультиметр цифровой", "Очиститель контактов"]
  };
}

// Инициализируем дефолтную демо-сессию (совпадает с web state)
const initialSessionId = cacheManager.getSetting<string>("active_session_id", "") || generateUuidV4();

export const appState = {
  // Пользователь и режим (авторизован или Демо-режим)
  currentUserSignal: signal<AuthUser>({
    username: "",
    is_authenticated: false
  }),

  // Активная сессия диагностики
  currentSessionIdSignal: signal<string>(initialSessionId),
  currentSessionTitleSignal: signal<string>("Диагностика #1"),
  vehicleSignal: signal<string>("").stored("aideal_vehicle_info"),
  sessionSummarySignal: signal<string>(""),

  // Статус фонового воркера контекста и глобальной памяти
  workerStatusSignal: signal<"idle" | "running" | "aborted_for_priority" | "completed" | "error">("idle"),
  crossMemoryEnabledSignal: signal<boolean>(true),
  globalMemorySummarySignal: signal<string>(""),

  // Сообщения текущего диалога + последнее сообщение ИИ для Инспектора & AR HUD
  messagesSignal: signal<ChatMessageItem[]>([createWelcomeMessage()]),
  latestAssistantMessageSignal: signal<ChatMessageItem | null>(null),
  selectedMessageIdsSignal: signal<string[]>([]),

  // Кэш демо-истории по сессиям (для неавторизованного режима без сохранения в SQLite БД)
  demoProjectsSignal: signal<ProjectItem[]>([]),
  demoSessionsSignal: signal<DiagnosticSessionItem[]>([
    {
      id: initialSessionId,
      title: "Демо-диагностика",
      is_pinned: false,
      tag: "",
      project_id: null,
      vehicle_info: "",
      summary: "",
      updated_at: "Сейчас",
      message_count: 0
    }
  ]),
  demoMessagesBySession: {} as Record<string, ChatMessageItem[]>,

  // Очередь прикрепленных материалов (Staging Bar)
  stagedItemsSignal: signal<StagedItem[]>([]),

  // Статус генерации, запроса отмены и доступности сети/сервера
  isAskingSignal: signal<boolean>(false),
  statusNoteSignal: signal<string>("Готов"),
  pendingCancelFn: null as (() => void) | null,
  isOnlineSignal: signal<boolean>(true),
  offlineReasonSignal: signal<string>(""),

  // OBD-II телеметрия для мини-HUD и AR HUD
  obdStateSignal: signal<OBDLiveSensors & { status: string }>({
    rpm: 0,
    speed: 0,
    coolantTemp: 0,
    throttle: 0,
    voltage: 12.6,
    engineLoad: 0,
    fuelLevel: 65,
    intakeTemp: 22,
    dtcList: [],
    status: "ELM327 готов"
  }),

  // Событие перезагрузки списка сессий
  sessionsRefreshCounterSignal: signal<number>(0),

  // Обратный вызов постановки диагностического запроса из любого экрана (напр. AR HUD)
  askHandler: null as ((customQuery?: string, fromAr?: boolean) => Promise<void>) | null,
  toggleTaskHandler: null as ((msgId: string, itemType: "step" | "inventory", checkId: string | number, checked: boolean) => Promise<void>) | null,
  switchTabFn: null as ((tabId: string) => void) | null
};

export function purgeUserSessionAndMemoryState(clearAuthKey: boolean = false): void {
  const freshSessionId = generateUuidV4();

  appState.globalMemorySummarySignal.value = "";
  appState.sessionSummarySignal.value = "";
  appState.latestAssistantMessageSignal.value = null;
  appState.vehicleSignal.value = "";
  appState.selectedMessageIdsSignal.value = [];
  appState.messagesSignal.value = [createWelcomeMessage()];
  appState.demoProjectsSignal.value = [];
  appState.demoSessionsSignal.value = [
    {
      id: freshSessionId,
      title: "Демо-диагностика",
      is_pinned: false,
      tag: "",
      project_id: null,
      vehicle_info: "",
      summary: "",
      updated_at: "Сейчас",
      message_count: 0
    }
  ];
  appState.demoMessagesBySession = {};
  appState.stagedItemsSignal.value = [];
  appState.currentSessionIdSignal.value = freshSessionId;
  appState.currentSessionTitleSignal.value = "Демо-диагностика";
  appState.workerStatusSignal.value = "idle";

  cacheManager.clearUserScopedCache(clearAuthKey);
  appState.sessionsRefreshCounterSignal.value++;
}

export function stageDtcCodes(codes: string[]): void {
  const cleanList = codes.map(c => c.trim().toUpperCase()).filter(Boolean);
  if (cleanList.length === 0) return;

  const existing = [...appState.stagedItemsSignal.value];
  let added = 0;
  for (const code of cleanList) {
    if (!existing.some(it => it.type === "dtc" && it.data === code)) {
      existing.push({
        id: "staged-dtc-" + code + "-" + Date.now() + "-" + added,
        type: "dtc",
        label: code,
        meta: "Код ошибки",
        data: code
      });
      added++;
    }
  }
  appState.stagedItemsSignal.value = existing;
  appState.statusNoteSignal.value = added > 0 ? `Добавлен код ${cleanList.join(", ")}` : "Коды уже прикреплены";
}

export function attachObdSnapshotToStaging(): void {
  const s = appState.obdStateSignal.value;
  const existing = [...appState.stagedItemsSignal.value];
  existing.push({
    id: "staged-obd-" + Date.now(),
    type: "obd",
    label: `OBD: ${s.rpm} об/м, ${s.speed} км/ч, ОЖ ${s.coolantTemp}°C`,
    meta: "Телеметрия ELM327",
    data: { ...s }
  });
  appState.stagedItemsSignal.value = existing;
  if (s.dtcList && s.dtcList.length > 0) {
    stageDtcCodes(s.dtcList);
  }
  appState.statusNoteSignal.value = "Телеметрия OBD-II прикреплена";
}
