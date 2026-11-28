// ИИдеал Авто — Multi-Engine Diagnostic Orchestrator (LeCodes AI + Hybrid RAG + BYOK) (2026-11-28)
// Copyright (C) 2026 ИИдеал Авто (LeCodes48 Edition)
// Licensed under the GNU General Public License v3.0 (GPL-3.0).

import {
  diagnoseText,
  diagnoseWithPhoto,
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
  engineUsed: "lecodes_ai" | "byok_custom" | "local_rag";
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
    `Длительность записи: ${ac.durationSec.toFixed(1)} с`,
    `Основная частота: ${Math.round(ac.avgHz)} Гц (пик ${Math.round(ac.peakHz)} Гц), уверенность тона: ${Math.round(ac.clarity * 100)}%`,
    `Пик громкости: ${ac.peakDb.toFixed(0)} dBFS${ac.noteLabel ? `, тон ${ac.noteLabel}` : ""}`,
    `Первичная акустическая оценка: ${ac.acousticHint}`,
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

async function callByokOpenAiCompatible(
  req: ServerDiagnoseTextInput
): Promise<ServerDiagnoseResult> {
  const settings = localDb.getSettings();
  const apiKey = await localDb.getByokApiKey();
  const endpoint = (settings.byok_base_url || "").trim();
  const modelName = (settings.byok_model || "gpt-4o-mini").trim();

  if (!endpoint || !apiKey) {
    return {
      ok: false,
      errorCode: "invalid",
      errorMessage: "BYOK API-ключ или Endpoint не настроен в Настройках.",
      data: null,
      usageInput: 0,
      usageOutput: 0,
    };
  }

  const systemPrompt =
    "Ты «ИИдеал Авто» — автодиагност-эксперт. Отвечай строго в JSON с полями: " +
    'summary (string), confidencePercent (number 10-99), severity ("critical"|"warning"|"info"), ' +
    "causes (string[]), checklistSteps (string[]), safetyWarning (string), " +
    'affectedSystem ("engine"|"transmission"|"brakes"|"cooling"|"electrical"|"suspension"|"battery"|"general"), ' +
    "dtcCodesMentioned (string[]), followUpQuestion (string).";

  const userPrompt = [
    req.query,
    req.vehicleSummary ? `Авто: ${req.vehicleSummary}` : "",
    req.obdSnapshotText ? `OBD-2:\n${req.obdSnapshotText}` : "",
    req.ragContextText ? `RAG:\n${req.ragContextText}` : "",
    req.documentExcerpt ? `Документ:\n${req.documentExcerpt.slice(0, 4000)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelName,
        temperature: 0.2,
        max_tokens: 1400,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
      timeout: 25000,
    });

    if (res.status < 200 || res.status >= 300) {
      return {
        ok: false,
        errorCode: "unavailable",
        errorMessage: `BYOK HTTP ${res.status}`,
        data: null,
        usageInput: 0,
        usageOutput: 0,
      };
    }

    const body = res.json<{
      choices?: { message?: { content?: string } }[];
    }>();
    const rawContent = String(body?.choices?.[0]?.message?.content || "").trim();
    if (!rawContent) {
      return {
        ok: false,
        errorCode: "incomplete",
        errorMessage: "Пустой ответ от BYOK модели.",
        data: null,
        usageInput: 0,
        usageOutput: 0,
      };
    }

    const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]) as Partial<LlmDiagnosticPayload>;
        return {
          ok: true,
          errorCode: "",
          errorMessage: "",
          data: {
            summary: String(parsed.summary || rawContent),
            confidencePercent: Number(parsed.confidencePercent || 78),
            severity:
              parsed.severity === "critical" || parsed.severity === "info"
                ? parsed.severity
                : "warning",
            causes: Array.isArray(parsed.causes) ? parsed.causes.map(String) : [],
            checklistSteps: Array.isArray(parsed.checklistSteps)
              ? parsed.checklistSteps.map(String)
              : [],
            safetyWarning: String(parsed.safetyWarning || ""),
            affectedSystem: parsed.affectedSystem || "general",
            dtcCodesMentioned: Array.isArray(parsed.dtcCodesMentioned)
              ? parsed.dtcCodesMentioned.map((c) => String(c).toUpperCase())
              : [],
            followUpQuestion: String(parsed.followUpQuestion || ""),
          },
          usageInput: 0,
          usageOutput: 0,
        };
      } catch {
        // Fallback below
      }
    }

    return {
      ok: true,
      errorCode: "",
      errorMessage: "",
      data: {
        summary: rawContent,
        confidencePercent: 75,
        severity: "warning",
        causes: [],
        checklistSteps: [],
        safetyWarning: "",
        affectedSystem: "general",
        dtcCodesMentioned: [],
        followUpQuestion: "",
      },
      usageInput: 0,
      usageOutput: 0,
    };
  } catch (err) {
    return {
      ok: false,
      errorCode: "unavailable",
      errorMessage: err instanceof Error ? err.message : String(err),
      data: null,
      usageInput: 0,
      usageOutput: 0,
    };
  }
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
    const settings = localDb.getSettings();
    const mode = settings.llm_mode;

    const allCodes = Array.from(
      new Set([
        ...params.explicitCodes,
        ...(params.obdConnected ? params.sensors.dtcList : []),
      ])
    );

    const rag = hybridRag.retrieveForDiagnosis(
      params.query,
      allCodes,
      params.obdConnected ? params.sensors : undefined,
      6
    );

    const docParts: string[] = [];
    let photoFile: File | null = null;
    let acoustic: AcousticAnalysisMetrics | undefined;

    for (const item of params.stagedItems) {
      if (item.type === "photo" && item.file) {
        photoFile = item.file;
      } else if (item.type === "file" && item.parsedDoc) {
        docParts.push(
          `Файл ${item.parsedDoc.filename}${item.parsedDoc.key_metrics.length ? ` [${item.parsedDoc.key_metrics.join("; ")}]` : ""}:\n${item.parsedDoc.llm_ready_text}`
        );
      } else if (item.type === "audio" && item.acoustic) {
        acoustic = item.acoustic;
      }
    }

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
      acousticSummary: formatAcousticSummary(acoustic),
    };

    let serverRes: ServerDiagnoseResult | null = null;
    let engineSource: "lecodes_ai" | "byok_custom" | "local_rag" = "local_rag";
    let noticeText = "";

    if (mode === "lecodes_ai") {
      try {
        serverRes = photoFile
          ? await diagnoseWithPhoto(reqPayload, photoFile)
          : await diagnoseText(reqPayload);
        if (serverRes.ok && serverRes.data) {
          engineSource = "lecodes_ai";
        } else if (serverRes.errorCode === "credits" || serverRes.errorCode === "budget") {
          noticeText = "Кредиты LeCodes AI исчерпаны — активирован локальный RAG-эксперт.";
        } else if (serverRes.errorCode === "busy" || serverRes.errorCode === "limit") {
          noticeText = "Очередь LeCodes AI занята — применен локальный RAG-эксперт.";
        } else {
          noticeText = "Оффлайн / без облака — применен локальный RAG по 12 141 коду DTC.";
        }
      } catch {
        noticeText = "Нет связи с облаком LeCodes AI — применен локальный RAG-эксперт.";
      }
    } else if (mode === "byok_openai" || mode === "byok_gigachat") {
      serverRes = await callByokOpenAiCompatible(reqPayload);
      if (serverRes.ok && serverRes.data) {
        engineSource = "byok_custom";
      } else {
        noticeText = `BYOK (${serverRes.errorMessage || serverRes.errorCode}) — откат на локальный RAG.`;
      }
    } else {
      noticeText = "Локальный оффлайн-режим (токены = 0).";
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
        diagnosticType: photoFile ? "visual_inspection" : "diagnosis",
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
          ? [payload.followUpQuestion, "Покажи схему проверки датчика", "Пересчитай риски для 3D-модели"]
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

    // Pure offline deterministic synthesis via HybridRagEngine
    const verdict = hybridRag.buildDeterministicVerdict({
      query: params.query,
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
      diagnosticType: photoFile ? "visual_inspection" : "diagnosis",
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

    const mode = localDb.getSettings().llm_mode;
    if (mode === "lecodes_ai") {
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
        // Fallback below
      }
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
