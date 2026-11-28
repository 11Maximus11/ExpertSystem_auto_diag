// ИИдеал Авто — Reactive Local Application State (2026-11-28)
// Copyright (C) 2026 ИИдеал Авто (LeCodes48 Edition)
// Licensed under the GNU General Public License v3.0 (GPL-3.0).

import { diagnosticOrchestrator } from "../ai/DiagnosticOrchestrator";
import type { AffectedSubsystem } from "../../expert.server";
import { DEMO_SCENARIOS, obdProtocol } from "../obd/ELM327Protocol";
import { hybridRag } from "../rag/HybridRagEngine";
import { createWelcomeMessage, localDb } from "../storage/LocalDatabase";
export { createWelcomeMessage };
import type {
  AcousticAnalysisMetrics,
  ChatMessageItem,
  DemoEcuScenarioId,
  DiagnosticSessionItem,
  LocalSettingsInfo,
  OBDConnectionStatus,
  OBDLiveSensors,
  ProjectItem,
  StagedItem,
  SystemKey,
} from "../types";
import { analyzeRawTextDocument, parseDocumentFile } from "../utils/DocumentParser";
import { formatTimeRu, generateUuidV4 } from "../utils/polyfills";
import type { VoiceCaptureOutcome } from "../utils/VoiceCapture";

export const DEFAULT_SENSORS: OBDLiveSensors = {
  rpm: 0,
  speed: 0,
  coolantTemp: 0,
  throttle: 0,
  voltage: 0,
  engineLoad: 0,
  fuelLevel: 0,
  intakeTemp: 0,
  dtcList: [],
  vin: "",
};

export const appState = {
  // Active tab & session
  activeTabSignal: signal<number>(0),
  sessionsSignal: signal<DiagnosticSessionItem[]>([]),
  projectsSignal: signal<ProjectItem[]>([]),
  currentSessionIdSignal: signal<string>(""),
  currentSessionTitleSignal: signal<string>("Первичная проверка"),
  messagesSignal: signal<ChatMessageItem[]>([]),
  sessionsRefreshCounterSignal: signal<number>(0),

  // Staging & AI Generation
  stagedItemsSignal: signal<StagedItem[]>([]),
  isGeneratingSignal: signal<boolean>(false),
  workerStatusSignal: signal<"idle" | "running" | "completed" | "error">("idle"),
  statusNoteSignal: signal<string>("Локальный RAG (12 141 DTC) готов"),

  // Vehicle & Settings (100% Local, No Account/Login Required)
  vehicleSignal: signal<string>(""),
  settingsSignal: signal<LocalSettingsInfo>(localDb.getSettings()),

  // Helper aliases for AR and external display bridges
  get isAskingSignal() {
    return this.isGeneratingSignal;
  },
  get obdStateSignal() {
    return this.obdSensorsSignal;
  },
  latestAssistantMessageSignal: computed<ChatMessageItem | null>(() => {
    const msgs = appState.messagesSignal.value || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "assistant") return msgs[i];
    }
    return null;
  }),
  obdConnectedSignal: signal<boolean>(false),
  obdStatusSignal: signal<OBDConnectionStatus>("disconnected"),
  obdStatusMessageSignal: signal<string>("Адаптер не подключен"),
  obdSensorsSignal: signal<OBDLiveSensors>({ ...DEFAULT_SENSORS }),
  activeDemoScenarioSignal: signal<DemoEcuScenarioId>("misfire_lean"),
  obdLogsSignal: signal<{ time: string; dir: "in" | "out" | "info"; text: string }[]>([]),

  // 3D Subsystem Health & Acoustic
  activeSubsystemSignal: signal<AffectedSubsystem>("engine"),
  systemHealthScoresSignal: signal<Record<SystemKey, number>>({
    engine: 100,
    transmission: 100,
    brakes: 100,
    electrical: 100,
    cooling: 100,
    hybrid: 100,
    battery: 100,
    chassis: 100,
    suspension: 100,
  }),
  selectedInspectDtcSignal: signal<string>(""),
  acousticSignal: signal<AcousticAnalysisMetrics | null>(null),

  // Hardware & Dev Diagnostics
  devModeUnlockedSignal: signal<boolean>(false),
  ragCatalogCountSignal: signal<number>(12141),
  aiCallCountSignal: signal<number>(0),
};

let bootstrapped = false;

export function syncObdState(): void {
  const st = obdProtocol.getStatus();
  appState.obdStatusSignal.value = st;
  appState.obdConnectedSignal.value = st === "connected";
  appState.obdStatusMessageSignal.value = obdProtocol.getStatusMessage();
  appState.obdSensorsSignal.value = { ...obdProtocol.getSensors() };
  appState.activeDemoScenarioSignal.value = obdProtocol.getDemoScenario().id;
}

export function bootstrapAppState(): void {
  if (bootstrapped) return;
  bootstrapped = true;

  // 1. Warm up local Hybrid RAG index (12,141 DTC codes)
  appState.ragCatalogCountSignal.value = hybridRag.getCatalogCount();

  // 2. Load local settings
  const settings = localDb.getSettings();
  appState.settingsSignal.value = settings;

  // 3. Load local projects & sessions
  reloadSessionsFromDb();
  let sessions = appState.sessionsSignal.value;
  if (sessions.length === 0) {
    const created = localDb.createSession(null, "Первичная проверка", "");
    localDb.saveMessages(created.id, [createWelcomeMessage()]);
    reloadSessionsFromDb();
    sessions = appState.sessionsSignal.value;
  }

  const activeId = localDb.getActiveSessionId() || sessions[0].id;
  selectSession(activeId);

  // 4. Bind OBD protocol callbacks
  obdProtocol.onSensorsUpdate = (sensors) => {
    appState.obdSensorsSignal.value = { ...sensors };
    // Auto-update 3D subsystem health highlights when live sensors fluctuate
    const scores = { ...appState.systemHealthScoresSignal.value };
    if (sensors.coolantTemp > 103) scores.cooling = Math.min(scores.cooling, 38);
    if (sensors.voltage > 0 && sensors.voltage < 11.7) scores.battery = Math.min(scores.battery, 42);
    if (sensors.dtcList.some((c) => c.startsWith("C"))) scores.brakes = Math.min(scores.brakes, 55);
    if (sensors.dtcList.some((c) => c.startsWith("P07"))) scores.transmission = Math.min(scores.transmission, 48);
    if (sensors.dtcList.some((c) => c.startsWith("P03") || c.startsWith("P01"))) scores.engine = Math.min(scores.engine, 52);
    appState.systemHealthScoresSignal.value = scores;
  };
  obdProtocol.onStatusChange = (status, msg) => {
    appState.obdStatusSignal.value = status;
    appState.obdConnectedSignal.value = status === "connected";
    appState.obdStatusMessageSignal.value = msg;
  };
  obdProtocol.onLog = (dir, text) => {
    const entry = { time: formatTimeRu(Date.now()), dir, text };
    appState.obdLogsSignal.value = [...appState.obdLogsSignal.value.slice(-79), entry];
  };
  syncObdState();
}

export function reloadSessionsFromDb(): void {
  appState.sessionsSignal.value = localDb.getSessions();
  appState.projectsSignal.value = localDb.getProjects();
  appState.sessionsRefreshCounterSignal.value++;
}

export function selectSession(sessionId: string): void {
  const sessions = localDb.getSessions();
  const target = sessions.find((s) => s.id === sessionId) || sessions[0];
  if (!target) return;

  localDb.setActiveSessionId(target.id);
  appState.currentSessionIdSignal.value = target.id;
  appState.currentSessionTitleSignal.value = target.title;
  appState.vehicleSignal.value = target.vehicle_info || appState.vehicleSignal.value;
  appState.messagesSignal.value = localDb.getMessages(target.id);
}

export function createNewSession(
  title: string = "Новая диагностика",
  projectId: string | null = null
): string {
  const created = localDb.createSession(projectId, title, appState.vehicleSignal.value);
  localDb.saveMessages(created.id, [createWelcomeMessage()]);
  reloadSessionsFromDb();
  selectSession(created.id);
  appState.stagedItemsSignal.value = [];
  return created.id;
}

export function deleteSessionById(sessionId: string): void {
  const nextActive = localDb.deleteSession(sessionId);
  reloadSessionsFromDb();
  if (nextActive) {
    selectSession(nextActive);
  }
}

export function stageDtcCodes(codes: string[]): void {
  const cleanList = codes.map((c) => c.trim().toUpperCase()).filter(Boolean);
  if (cleanList.length === 0) return;

  const existing = [...appState.stagedItemsSignal.value];
  let added = 0;
  for (const code of cleanList) {
    if (!existing.some((it) => it.type === "dtc" && it.data === code)) {
      const info = hybridRag.getDtcDetails(code);
      existing.push({
        id: `staged-dtc-${code}-${Date.now()}-${added}`,
        type: "dtc",
        label: code,
        meta: info.title ? info.title.slice(0, 38) : "Код DTC",
        data: code,
      });
      added++;
    }
  }
  appState.stagedItemsSignal.value = existing;
  appState.statusNoteSignal.value =
    added > 0 ? `Добавлен код ${cleanList.join(", ")}` : "Коды уже прикреплены";
}

export function attachObdSnapshotToStaging(): void {
  const s = appState.obdSensorsSignal.value;
  const existing = [...appState.stagedItemsSignal.value].filter((it) => it.type !== "obd");
  existing.push({
    id: `staged-obd-${Date.now()}`,
    type: "obd",
    label: `OBD: ${s.rpm} об/м, ${s.speed} км/ч, ОЖ ${s.coolantTemp}°C, ${s.voltage.toFixed(1)}В`,
    meta: "Телеметрия ELM327",
    data: { ...s },
  });
  appState.stagedItemsSignal.value = existing;
  if (s.dtcList && s.dtcList.length > 0) {
    stageDtcCodes(s.dtcList);
  }
  appState.statusNoteSignal.value = "Телеметрия OBD-II прикреплена";
}

export function attachPhotoFileToStaging(file: File, labelHint: string = "Фото узла"): void {
  if (!file) return;
  const current = [...appState.stagedItemsSignal.value];
  const existingPhotos = current.filter((it) => it.type === "photo");
  const others = current.filter((it) => it.type !== "photo");
  // Keep up to 5 photos (AI_MAX_IMAGES limit)
  const keptPhotos = existingPhotos.slice(-4);
  keptPhotos.push({
    id: `staged-photo-${Date.now()}-${Math.round(Math.random() * 999)}`,
    type: "photo",
    label: file.name || labelHint,
    meta: `${Math.max(1, Math.round((file.size || 1024) / 1024))} КБ • Vision`,
    file,
    data: file,
    mimeType: "image/jpeg",
  });
  appState.stagedItemsSignal.value = [...others, ...keptPhotos];
  appState.statusNoteSignal.value = `Фото «${file.name || labelHint}» прикреплено (${keptPhotos.length}/5)`;
}

export async function attachDocumentFileToStaging(file: File): Promise<void> {
  if (!file) return;
  appState.statusNoteSignal.value = `Разбор файла ${file.name}...`;
  const parsed = await parseDocumentFile(file);
  const existing = [...appState.stagedItemsSignal.value];
  existing.push({
    id: `staged-file-${Date.now()}`,
    type: "file",
    label: parsed.filename,
    meta: `${Math.max(1, Math.round(parsed.size_bytes / 1024))} КБ • ${parsed.detected_dtc_codes.length} DTC`,
    file,
    parsedDoc: parsed,
  });
  appState.stagedItemsSignal.value = existing;
  if (parsed.detected_dtc_codes.length > 0) {
    stageDtcCodes(parsed.detected_dtc_codes);
  }
  appState.statusNoteSignal.value = `Документ «${parsed.filename}» прикреплен`;
}

export function attachTextLogToStaging(title: string, rawText: string): void {
  const parsed = analyzeRawTextDocument(title || "Вставленный_лог.txt", rawText);
  if (!parsed.llm_ready_text) return;
  const existing = [...appState.stagedItemsSignal.value];
  existing.push({
    id: `staged-log-${Date.now()}`,
    type: "file",
    label: parsed.filename,
    meta: `${parsed.char_length} симв. • ${parsed.detected_dtc_codes.length} DTC`,
    parsedDoc: parsed,
  });
  appState.stagedItemsSignal.value = existing;
  if (parsed.detected_dtc_codes.length > 0) {
    stageDtcCodes(parsed.detected_dtc_codes);
  }
  appState.statusNoteSignal.value = `Лог «${parsed.filename}» прикреплен`;
}

export function attachVoiceOutcomeToStaging(
  outcome: VoiceCaptureOutcome,
  labelPrefix: string = "ГС"
): void {
  if (outcome.acoustic) {
    appState.acousticSignal.value = outcome.acoustic;
  }
  const hasSpeech = Boolean(outcome.transcript && outcome.transcript.trim().length > 0);
  const label = hasSpeech
    ? `${labelPrefix} (${outcome.durationSec.toFixed(1)}с): ${outcome.transcript.slice(0, 26)}`
    : outcome.acoustic && outcome.acoustic.avgHz > 0
    ? `${labelPrefix} ДВС: ${Math.round(outcome.acoustic.avgHz)} Гц (${outcome.durationSec.toFixed(1)}с)`
    : `${labelPrefix} запись (${outcome.durationSec.toFixed(1)}с)`;

  const metaParts: string[] = [];
  if (hasSpeech) metaParts.push("Речь распознана для ИИ");
  if (outcome.acoustic?.acousticHint) metaParts.push(outcome.acoustic.acousticHint);
  if (outcome.file?.size) metaParts.push(`${Math.max(1, Math.round(outcome.file.size / 1024))} КБ`);

  const existing = [...appState.stagedItemsSignal.value];
  existing.push({
    id: `staged-audio-${Date.now()}`,
    type: "audio",
    label,
    meta: metaParts.join(" • ") || "Голосовое сообщение",
    file: outcome.file,
    data: outcome.file,
    mimeType: outcome.mimeType || "audio/mp4",
    duration: Math.round(outcome.durationSec),
    transcript: outcome.transcript,
    acoustic: outcome.acoustic,
  });
  appState.stagedItemsSignal.value = existing;
  appState.statusNoteSignal.value = "Голосовое сообщение прикреплено к запросу ИИ";
}

export function attachAcousticMetricsToStaging(
  metrics: AcousticAnalysisMetrics,
  transcriptText?: string,
  audioFile?: File,
  mimeType?: string
): void {
  attachVoiceOutcomeToStaging(
    {
      transcript: transcriptText || "",
      file: audioFile,
      mimeType,
      durationSec: metrics.durationSec,
      acoustic: metrics,
      source: "recorder",
    },
    "Звук ДВС"
  );
}

export function removeStagedItem(id: string): void {
  appState.stagedItemsSignal.value = appState.stagedItemsSignal.value.filter(
    (it) => it.id !== id
  );
}

export async function askExpertHandler(rawQuery: string): Promise<void> {
  if (appState.isGeneratingSignal.value) return;

  const trimmed = String(rawQuery || "").trim();
  const staged = [...appState.stagedItemsSignal.value];
  if (!trimmed && staged.length === 0) return;

  let sessionId = appState.currentSessionIdSignal.value;
  if (!sessionId) {
    sessionId = createNewSession("Экспресс-диагностика");
  }

  const explicitCodes: string[] = [];
  let hasPhoto = false;
  const voiceTranscripts: string[] = [];
  for (const item of staged) {
    if (item.type === "dtc" && typeof item.data === "string") {
      explicitCodes.push(item.data);
    } else if (item.type === "file" && item.parsedDoc) {
      for (const c of item.parsedDoc.detected_dtc_codes) {
        if (!explicitCodes.includes(c)) explicitCodes.push(c);
      }
    } else if (item.type === "photo") {
      hasPhoto = true;
    } else if (item.type === "audio" && item.transcript?.trim()) {
      voiceTranscripts.push(item.transcript.trim());
    }
  }

  for (const c of hybridRag.extractDtcCodes(`${trimmed} ${voiceTranscripts.join(" ")}`)) {
    if (!explicitCodes.includes(c)) explicitCodes.push(c);
  }

  const displayQuery =
    trimmed ||
    voiceTranscripts.join(" ") ||
    (hasPhoto
      ? "Проанализируй приложенные фотографии узла / приборной панели автомобиля."
      : explicitCodes.length > 0
      ? `Выполни диагностику кодов: ${explicitCodes.join(", ")}`
      : "Проведи диагностику по приложенным данным.");

  const userMsg: ChatMessageItem = {
    id: `msg-${generateUuidV4()}`,
    role: "user",
    content: displayQuery,
    timestamp: formatTimeRu(Date.now()),
    dtcCodes: explicitCodes,
    attachments: staged,
    vehicle: appState.vehicleSignal.value,
  };

  const nextMsgs = [...appState.messagesSignal.value, userMsg];
  appState.messagesSignal.value = nextMsgs;
  localDb.saveMessages(sessionId, nextMsgs);

  const curTitle = appState.currentSessionTitleSignal.value;
  if (
    curTitle === "Первичная проверка" ||
    curTitle === "Новая диагностика" ||
    curTitle === "Экспресс-диагностика"
  ) {
    const autoTitle =
      explicitCodes.length > 0
        ? `${explicitCodes[0]}: ${displayQuery.slice(0, 24)}`
        : displayQuery.slice(0, 34);
    localDb.updateSession(sessionId, { title: autoTitle });
    appState.currentSessionTitleSignal.value = autoTitle;
  }

  appState.stagedItemsSignal.value = [];
  appState.isGeneratingSignal.value = true;
  appState.workerStatusSignal.value = "running";
  appState.statusNoteSignal.value = "Hybrid RAG (12 141 DTC) + анализ телеметрии...";

  try {
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 35));

    const outcome = await diagnosticOrchestrator.runDiagnosis({
      sessionId,
      query: displayQuery,
      vehicleInfo: appState.vehicleSignal.value,
      obdConnected: appState.obdConnectedSignal.value,
      sensors: appState.obdSensorsSignal.value,
      explicitCodes,
      stagedItems: staged,
      recentMessages: appState.messagesSignal.value,
      crossMemoryEnabled: appState.settingsSignal.value.cross_dialog_memory_enabled,
    });

    const updatedMsgs = [...appState.messagesSignal.value, outcome.message];
    appState.messagesSignal.value = updatedMsgs;
    localDb.saveMessages(sessionId, updatedMsgs);

    appState.activeSubsystemSignal.value = outcome.affectedSystem;
    appState.systemHealthScoresSignal.value = { ...outcome.systemScores };
    appState.aiCallCountSignal.value++;
    appState.workerStatusSignal.value = "completed";

    if (outcome.noticeText) {
      appState.statusNoteSignal.value = outcome.noticeText;
      toast(outcome.noticeText);
    } else {
      appState.statusNoteSignal.value =
        outcome.engineUsed === "lecodes_ai"
          ? "Вердикт готов (LeCodes AI + Локальный RAG)"
          : "Вердикт готов (Резервный Локальный RAG)";
    }

    reloadSessionsFromDb();

    void diagnosticOrchestrator.refreshSessionMemoryInBackground(
      sessionId,
      updatedMsgs,
      appState.vehicleSignal.value
    );
  } catch (err) {
    appState.workerStatusSignal.value = "error";
    const errText = err instanceof Error ? err.message : String(err);
    toast(`Ошибка диагностики: ${errText}`);
    appState.statusNoteSignal.value = "Ошибка выполнения анализа";
  } finally {
    appState.isGeneratingSignal.value = false;
  }
}

export function toggleChecklistTask(messageId: string, taskId: string | number): void {
  const sessionId = appState.currentSessionIdSignal.value;
  if (!sessionId) return;
  const targetStr = String(taskId);
  const updated = appState.messagesSignal.value.map((m) => {
    if (m.id !== messageId || !m.tasks) return m;
    return {
      ...m,
      tasks: m.tasks.map((t) =>
        String(t.id) === targetStr || String(t.step_number) === targetStr
          ? { ...t, done: !t.done }
          : t
      ),
    };
  });
  appState.messagesSignal.value = updated;
  localDb.saveMessages(sessionId, updated);
}

export function toggleInventoryItemCheck(messageId: string, itemId: string): void {
  const sessionId = appState.currentSessionIdSignal.value;
  if (!sessionId) return;
  const updated = appState.messagesSignal.value.map((m) => {
    if (m.id !== messageId || !m.inventoryItems) return m;
    return {
      ...m,
      inventoryItems: m.inventoryItems.map((it) =>
        it.id === itemId ? { ...it, checked: !it.checked } : it
      ),
    };
  });
  appState.messagesSignal.value = updated;
  localDb.saveMessages(sessionId, updated);
}

export async function switchDemoScenario(scenarioId: DemoEcuScenarioId): Promise<void> {
  obdProtocol.setDemoScenario(scenarioId);
  await obdProtocol.connect("demo");
  syncObdState();
  const meta = DEMO_SCENARIOS.find((s) => s.id === scenarioId);
  if (meta) {
    appState.vehicleSignal.value = meta.vehicle;
    const sessId = appState.currentSessionIdSignal.value;
    if (sessId) localDb.updateSession(sessId, { vehicle_info: meta.vehicle });
    appState.statusNoteSignal.value = `Демо-сценарий: ${meta.label}`;
    toast(`Подключен демо ЭБУ: ${meta.label}`);
  }
}

export function updateSettingsPatch(patch: Partial<LocalSettingsInfo>): void {
  const next = localDb.saveSettings(patch);
  appState.settingsSignal.value = next;
}

export function updateVehicleInfo(vehicle: string): void {
  const clean = vehicle.trim();
  appState.vehicleSignal.value = clean;
  const sid = appState.currentSessionIdSignal.value;
  if (sid) {
    localDb.updateSession(sid, { vehicle_info: clean });
    reloadSessionsFromDb();
  }
}
