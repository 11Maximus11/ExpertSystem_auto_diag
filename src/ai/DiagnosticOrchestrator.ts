// ИИдеал Авто — Hybrid Diagnostic Orchestrator (Local RAG + Built-in LeCodes AI) (2026-11-28)
// Copyright (C) 2026 ИИдеал Авто (LeCodes48 Edition)
// Licensed under the GNU General Public License v3.0 (GPL-3.0).

import {
  diagnoseText,
  diagnoseWithPhotos,
  summarizeContext,
  type AffectedSubsystem,
  type LlmDiagnosticPayload,
  type ServerDiagnoseResult,
  type ServerDiagnoseTextInput,
} from "../../expert.server";
import { hybridRag, type RagRetrievalResult } from "../rag/HybridRagEngine";
import { localDb } from "../storage/LocalDatabase";
import type {
  AcousticAnalysisMetrics,
  ChatFaultItem,
  ChatInventoryItem,
  ChatMessageItem,
  ChatRepairTask,
  OBDLiveSensors,
  StagedItem,
  SystemKey,
} from "../types";
import { formatTimeRu, generateUuidV4 } from "../utils/polyfills";

export interface DiagnosticRequestParams {
  sessionId: string;
  query: string;
  vehicleInfo: string;
  obdConnected: boolean;
  sensors: OBDLiveSensors;
  explicitCodes: string[];
  stagedItems: StagedItem[];
  recentMessages: ChatMessageItem[];
  crossMemoryEnabled: boolean;
}

export interface DiagnosticOutcome {
  message: ChatMessageItem;
  affectedSystem: AffectedSubsystem;
  systemScores: Record<SystemKey, number>;
  engineUsed: "lecodes_ai" | "local_rag";
  noticeText: string;
}

function formatObdSnapshot(obdConnected: boolean, s: OBDLiveSensors): string {
  const lines = [
    `Статус адаптера: ${obdConnected ? "Подключен (живой поток)" : "Автономный профиль"}`,
    `Обороты ДВС: ${s.rpm} об/мин | Скорость: ${s.speed} км/ч | Нагрузка: ${s.engineLoad}%`,
    `Температура ОЖ: ${s.coolantTemp} °C | Напряжение бортсети: ${s.voltage.toFixed(1)} В`,
    `Дроссель: ${s.throttle}% | Впуск: ${s.intakeTemp} °C | Топливо: ${s.fuelLevel}%`,
  ];
  if (s.vin) lines.push(`VIN ЭБУ: ${s.vin}`);
  if (s.dtcList && s.dtcList.length > 0) {
    lines.push(`Активные коды DTC ЭБУ: ${s.dtcList.join(", ")}`);
  } else {
    lines.push("Активные коды DTC ЭБУ: отсутствуют");
  }
  return lines.join("\n");
}

function formatAcousticSummary(ac: AcousticAnalysisMetrics | undefined): string {
  if (!ac || ac.durationSec <= 0) return "";
  return [
    `Длительность записи звука: ${ac.durationSec.toFixed(1)} с`,
    `Основная частота: ${Math.round(ac.avgHz)} Гц (пик ${Math.round(ac.peakHz)} Гц), ясность тона: ${Math.round(ac.clarity * 100)}%`,
    `Пик громкости: ${ac.peakDb.toFixed(0)} dBFS${ac.noteLabel ? `, тон ${ac.noteLabel}` : ""}`,
    `Акустическая оценка: ${ac.acousticHint}`,
  ].join("\n");
}

function buildCrossMemoryExcerpt(currentSessionId: string, maxChars: number): string {
  const settings = localDb.getSettings();
  const sessions = localDb.getSessions();
  const lines: string[] = [];
  if (settings.global_memory_summary.trim()) {
    lines.push(settings.global_memory_summary.trim());
  }
  for (const s of sessions) {
    if (s.id === currentSessionId) continue;
    if (s.summary && s.summary.trim()) {
      lines.push(`• [${s.title}]: ${s.summary.trim()}`);
    }
    if (lines.join("\n").length >= maxChars) break;
  }
  return lines.join("\n").slice(0, maxChars);
}

function formatPayloadAsMarkdown(payload: LlmDiagnosticPayload): string {
  const parts: string[] = [];
  if (payload.safetyWarning) {
    parts.push(`ВНИМАНИЕ (БЕЗОПАСНОСТЬ):\n${payload.safetyWarning}`);
  }
  parts.push(payload.summary);
  if (payload.causes.length > 0) {
    parts.push(
      "Вероятные причины:\n" +
        payload.causes.map((c, idx) => `${idx + 1}. ${c}`).join("\n")
    );
  }
  if (payload.followUpQuestion) {
    parts.push(`Уточняющий вопрос: ${payload.followUpQuestion}`);
  }
  return parts.join("\n\n");
}

function mapSystemKeyToSubsystem(sys?: SystemKey): AffectedSubsystem {
  if (sys === "engine") return "engine";
  if (sys === "transmission") return "transmission";
  if (sys === "brakes") return "brakes";
  if (sys === "cooling") return "cooling";
  if (sys === "electrical") return "electrical";
  if (sys === "battery" || sys === "hybrid") return "battery";
  if (sys === "suspension" || sys === "chassis") return "suspension";
  return "general";
}

function buildFaultsFromCodesAndRag(
  codes: string[],
  rag: RagRetrievalResult,
  baseConfidence: number
): ChatFaultItem[] {
  const result: ChatFaultItem[] = [];
  const seen = new Set<string>();

  for (const h of rag.hits) {
    if (seen.has(h.code)) continue;
    seen.add(h.code);
    result.push({
      code: h.code,
      system: h.system,
      system_ru: h.systemRu,
      title: h.cause || h.symptoms,
      confidence: Math.max(0.45, Math.min(0.98, Math.round(h.score * 100) / 100 || baseConfidence)),
      description: h.symptoms,
      root_cause: h.cause,
      severity: h.severity,
      health_index: h.healthIndex,
    });
    if (result.length >= 5) break;
  }

  for (const c of codes) {
    if (seen.has(c)) continue;
    seen.add(c);
    const info = hybridRag.getDtcDetails(c);
    result.push({
      code: info.code,
      system: info.system,
      system_ru: info.system_ru || "Система OBD-II",
      title: info.title,
      confidence: baseConfidence,
      description: info.description,
      root_cause: (info.causes && info.causes[0]) || info.title,
      severity: info.severity,
      health_index: info.health_index || 70,
    });
    if (result.length >= 5) break;
  }

  return result;
}

function buildTasksFromSteps(
  steps: string[],
  rag: RagRetrievalResult,
  safetyWarning: string,
  msgId: string
): ChatRepairTask[] {
  const tasks: ChatRepairTask[] = [];
  const dedup = new Set<string>();

  for (const raw of steps) {
    const clean = raw.trim();
    if (!clean || dedup.has(clean.toLowerCase())) continue;
    dedup.add(clean.toLowerCase());
    tasks.push({
      id: `task-${msgId}-${tasks.length + 1}`,
      step_number: tasks.length + 1,
      title: clean.length > 64 ? clean.slice(0, 61) + "..." : clean,
      instruction: clean,
      text: clean,
      torque_or_spec: "По регламенту ЭБУ/OEM",
      estimated_minutes: 15,
      safety_warning: tasks.length === 0 ? safetyWarning : "",
      done: false,
    });
  }

  if (tasks.length < 3) {
    for (const h of rag.hits.slice(0, 2)) {
      const step = h.fix.trim();
      if (!step || dedup.has(step.toLowerCase())) continue;
      dedup.add(step.toLowerCase());
      tasks.push({
        id: `task-${msgId}-${tasks.length + 1}`,
        step_number: tasks.length + 1,
        title: `Проверка по ${h.code}`,
        instruction: step,
        text: step,
        torque_or_spec: "Эталон OBD-II",
        estimated_minutes: 20,
        safety_warning: "",
        done: false,
      });
    }
  }

  return tasks.slice(0, 8);
}

function buildDefaultInventory(subsystem: AffectedSubsystem): ChatInventoryItem[] {
  const list: ChatInventoryItem[] = [
    { id: "inv-elm", name: "Сканер OBD-II (ELM327)", category: "tool", spec: "BLE / USB", checked: true },
    { id: "inv-multi", name: "Цифровой мультиметр", category: "tool", spec: "DC 0–20 В / Ом", checked: false },
  ];
  if (subsystem === "battery" || subsystem === "electrical") {
    list.push({ id: "inv-brush", name: "Смазка для клемм и очиститель контактов", category: "consumable", spec: "Диэлектрик", checked: false });
    list.push({ id: "inv-gloves", name: "Перчатки диэлектрические", category: "safety", spec: "Класс 0 / 1000В", checked: false });
  } else if (subsystem === "cooling") {
    list.push({ id: "inv-antifreeze", name: "Антифриз G12+/G12++ (долив)", category: "consumable", spec: "Сверка по OEM", checked: false });
    list.push({ id: "inv-pyro", name: "Инфракрасный пирометр", category: "tool", spec: "Патрубки/радиатор", checked: false });
  } else if (subsystem === "brakes") {
    list.push({ id: "inv-dot", name: "Тормозная жидкость", category: "consumable", spec: "DOT-4", checked: false });
  } else {
    list.push({ id: "inv-clean", name: "Очиститель дросселя / контактов ДМРВ", category: "consumable", spec: "Аэрозоль", checked: false });
  }
  return list;
}

export class DiagnosticOrchestrator {
  async runDiagnosis(params: DiagnosticRequestParams): Promise<DiagnosticOutcome> {
    const docParts: string[] = [];
    const photoFiles: File[] = [];
    const voiceTranscripts: string[] = [];
    const voiceMetaParts: string[] = [];
    let acoustic: AcousticAnalysisMetrics | undefined;

    for (const item of params.stagedItems) {
      if (item.type === "photo" && item.file) {
        if (photoFiles.length < 5) {
          photoFiles.push(item.file);
        }
      } else if (item.type === "file" && item.parsedDoc) {
        docParts.push(
          `Файл ${item.parsedDoc.filename}${item.parsedDoc.key_metrics.length ? ` [${item.parsedDoc.key_metrics.join("; ")}]` : ""}:\n${item.parsedDoc.llm_ready_text}`
        );
      } else if (item.type === "audio") {
        if (item.transcript && item.transcript.trim()) {
          voiceTranscripts.push(item.transcript.trim());
        }
        if (item.acoustic) {
          acoustic = item.acoustic;
        }
        if (item.file || item.duration || item.meta) {
          const kb = item.file?.size ? `${Math.max(1, Math.round(item.file.size / 1024))} КБ` : "";
          const sec = item.duration ? `${item.duration} с` : acoustic ? `${acoustic.durationSec.toFixed(1)} с` : "";
          voiceMetaParts.push(
            [item.label, item.mimeType || "audio", sec, kb, item.meta].filter(Boolean).join(" • ")
          );
        }
      }
    }

    const combinedVoiceTranscript = voiceTranscripts.join(" ");
    const effectiveRagQuery = [params.query, combinedVoiceTranscript].filter(Boolean).join(" ");

    const allCodes = Array.from(
      new Set([
        ...params.explicitCodes,
        ...hybridRag.extractDtcCodes(effectiveRagQuery),
        ...(params.obdConnected ? params.sensors.dtcList : []),
      ])
    );

    // 1. Локальный Hybrid RAG всегда формирует контекст по 12 141 кодам DTC на устройстве
    const rag = hybridRag.retrieveForDiagnosis(
      effectiveRagQuery,
      allCodes,
      params.obdConnected ? params.sensors : undefined,
      6
    );

    const sessions = localDb.getSessions();
    const activeSess = sessions.find((s) => s.id === params.sessionId);
    const sessionMemorySummary = activeSess?.summary || "";
    const crossMemoryText = params.crossMemoryEnabled
      ? buildCrossMemoryExcerpt(params.sessionId, 1200)
      : "";

    const recentTurns = params.recentMessages
      .slice(-6)
      .map((m) => `${m.role === "user" ? "Водитель" : "ИИдеал"}: ${m.content.slice(0, 320)}`)
      .join("\n");

    const reqPayload: ServerDiagnoseTextInput = {
      query: params.query,
      vehicleSummary: params.vehicleInfo || "Универсальный профиль OBD-II",
      obdSnapshotText: formatObdSnapshot(params.obdConnected, params.sensors),
      ragContextText: rag.llmContextText,
      sessionMemorySummary,
      crossMemoryText,
      recentTurnsText: recentTurns,
      documentExcerpt: docParts.join("\n\n"),
      voiceTranscript: combinedVoiceTranscript,
      voiceFileMeta: voiceMetaParts.join(" | "),
      acousticSummary: formatAcousticSummary(acoustic),
    };

    // 2. Единая главная онлайн-LLM платформы le.codes (с Vision для фото и контекстом ГС/RAG)
    let serverRes: ServerDiagnoseResult | null = null;
    let engineSource: "lecodes_ai" | "local_rag" = "local_rag";
    let noticeText = "";

    try {
      serverRes =
        photoFiles.length > 0
          ? await diagnoseWithPhotos(reqPayload, photoFiles)
          : await diagnoseText(reqPayload);

      if (serverRes.ok && serverRes.data) {
        engineSource = "lecodes_ai";
      } else if (serverRes.errorCode === "credits" || serverRes.errorCode === "budget") {
        noticeText = "Кредиты LeCodes AI исчерпаны — активирован резервный локальный RAG.";
      } else if (serverRes.errorCode === "busy" || serverRes.errorCode === "limit") {
        noticeText = "Очередь LeCodes AI занята — использован резервный локальный RAG.";
      } else {
        noticeText = "Оффлайн / без облака — применен резервный локальный RAG по 12 141 коду.";
      }
    } catch {
      noticeText = "Нет связи с облаком LeCodes AI — применен резервный локальный RAG.";
    }

    const msgId = `msg-${generateUuidV4()}`;
    const timestamp = formatTimeRu(Date.now());

    if (serverRes && serverRes.ok && serverRes.data) {
      const payload = serverRes.data;
      const detectedCodes = Array.from(
        new Set([...allCodes, ...payload.dtcCodesMentioned, ...rag.extractedCodes])
      ).slice(0, 10);

      const faults = buildFaultsFromCodesAndRag(
        detectedCodes,
        rag,
        Math.max(0.3, Math.min(0.99, payload.confidencePercent / 100))
      );
      const tasks = buildTasksFromSteps(
        payload.checklistSteps,
        rag,
        payload.safetyWarning,
        msgId
      );

      const msg: ChatMessageItem = {
        id: msgId,
        role: "assistant",
        content: formatPayloadAsMarkdown(payload),
        timestamp,
        diagnosticType: photoFiles.length > 0 ? "visual_inspection" : "diagnosis",
        summaryTitle:
          detectedCodes.length > 0
            ? `Заключение ИИ (${detectedCodes.slice(0, 3).join(", ")})`
            : "Экспертное заключение ИИ",
        engineSource,
        faults,
        dtcCodes: detectedCodes,
        tasks,
        inventoryItems: buildDefaultInventory(payload.affectedSystem),
        telemetryNotes: rag.telemetryNotes,
        recommendations: payload.causes,
        followupSuggestions: payload.followUpQuestion
          ? [payload.followUpQuestion, "Покажи пошаговую проверку датчика", "Оцени риск дальнейшего движения"]
          : ["Как проверить мультиметром?", "Можно ли ехать своим ходом?"],
        vehicle: params.vehicleInfo,
      };

      return {
        message: msg,
        affectedSystem: payload.affectedSystem,
        systemScores: rag.systemScores,
        engineUsed: engineSource,
        noticeText,
      };
    }

    // 3. Автоматический оффлайн-резерв (Hybrid RAG + правила телеметрии), когда облако недоступно
    const verdict = hybridRag.buildDeterministicVerdict({
      query: effectiveRagQuery || params.query,
      rag,
      vehicleInfo: params.vehicleInfo,
      acoustic,
      reasonNote: noticeText || undefined,
    });

    const topSys = rag.hits[0]?.system || "engine";
    const affectedSystem = mapSystemKeyToSubsystem(topSys);

    const fallbackMsg: ChatMessageItem = {
      id: msgId,
      role: "assistant",
      content: verdict.answer,
      timestamp,
      diagnosticType: photoFiles.length > 0 ? "visual_inspection" : "diagnosis",
      summaryTitle: verdict.summaryTitle,
      engineSource: "local_rag",
      faults: verdict.faults,
      dtcCodes: rag.extractedCodes,
      tasks: verdict.tasks,
      inventoryItems: verdict.inventoryItems,
      telemetryNotes: verdict.telemetryNotes,
      recommendations: verdict.recommendations,
      followupSuggestions: verdict.followupSuggestions,
      vehicle: params.vehicleInfo,
    };

    return {
      message: fallbackMsg,
      affectedSystem,
      systemScores: rag.systemScores,
      engineUsed: "local_rag",
      noticeText,
    };
  }

  async refreshSessionMemoryInBackground(
    sessionId: string,
    messages: ChatMessageItem[],
    vehicleInfo: string
  ): Promise<void> {
    if (messages.length < 4) return;
    const sessions = localDb.getSessions();
    const sess = sessions.find((s) => s.id === sessionId);
    const prevSummary = sess?.summary || "";
    const recentText = messages
      .slice(-6)
      .map((m) => `${m.role === "user" ? "Водитель" : "Эксперт"}: ${m.content.slice(0, 280)}`)
      .join("\n");

    try {
      const res = await summarizeContext({
        prevSummary,
        recentTurnsText: recentText,
        vehicleSummary: vehicleInfo || "Авто",
      });
      if (res.ok && res.summary) {
        localDb.updateSession(sessionId, { summary: res.summary });
        return;
      }
    } catch {
      // Fallback silently to local compression below
    }

    const codes = Array.from(new Set(messages.flatMap((m) => m.dtcCodes || []))).slice(0, 8);
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const summary = [
      vehicleInfo,
      codes.length > 0 ? `DTC: ${codes.join(", ")}` : "",
      lastUser ? `Запрос: ${lastUser.content.slice(0, 140)}` : "",
    ]
      .filter(Boolean)
      .join(" | ")
      .slice(0, 600);

    if (summary) {
      localDb.updateSession(sessionId, { summary });
    }
  }
}

export const diagnosticOrchestrator = new DiagnosticOrchestrator();
