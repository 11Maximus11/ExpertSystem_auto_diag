// ИИдеал Авто — Server Functions & LeCodes AI Gateway (2026-11-28)
// Copyright (C) 2026 ИИдеал Авто (LeCodes48 Edition)
// Licensed under the GNU General Public License v3.0 (GPL-3.0).

export type AffectedSubsystem =
  | "engine"
  | "transmission"
  | "brakes"
  | "cooling"
  | "electrical"
  | "suspension"
  | "battery"
  | "general";

export interface LlmDiagnosticPayload {
  summary: string;
  confidencePercent: number;
  severity: "critical" | "warning" | "info";
  causes: string[];
  checklistSteps: string[];
  safetyWarning: string;
  affectedSystem: AffectedSubsystem;
  dtcCodesMentioned: string[];
  followUpQuestion: string;
}

export interface ServerDiagnoseTextInput {
  query: string;
  vehicleSummary: string;
  obdSnapshotText: string;
  ragContextText: string;
  sessionMemorySummary: string;
  crossMemoryText: string;
  recentTurnsText: string;
  documentExcerpt: string;
  acousticSummary: string;
}

export interface ServerDiagnoseResult {
  ok: boolean;
  errorCode: string;
  errorMessage: string;
  data: LlmDiagnosticPayload | null;
  usageInput: number;
  usageOutput: number;
}

export interface ServerMemorySummaryResult {
  ok: boolean;
  errorCode: string;
  summary: string;
  keyFindings: string[];
  usageInput: number;
  usageOutput: number;
}

export interface ServerParsedDocumentResult {
  ok: boolean;
  fileName: string;
  sizeBytes: number;
  extractedText: string;
  dtcCodes: string[];
  metricsSummary: string;
  charCount: number;
  isBinaryFallback: boolean;
}

const SYSTEM_PROMPT_DIAGNOSTICS = [
  "Ты — «ИИдеал Авто», профессиональный российский автодиагност-эксперт и инженер OBD-2 (стандарт SAE J2012 / ISO 15031, отечественные и зарубежные ЭБУ).",
  "Отвечай строго на русском языке, кратко, технически точно, без выдуманных фактов и без воды.",
  "Всегда опирайся на переданный контекст локальной базы знаний (Hybrid RAG по 12 141 коду DTC), живую телеметрию OBD-2 и приложенные документы/фото/акустику.",
  "Если уверенность в причине невысока или недостаточно замеров, прямо укажи это и предложи конкретные шаги проверки (мультиметр, дымогенератор, давление топлива, осциллограмма, манометр).",
  "При обнаружении критических неисправностей (перегрев > 108 °C, давление масла, тормоза, ABS, подушки безопасности, просадка АКБ < 11.4 В, высокий HV-разряд гибрида) ставь severity = 'critical' и четкое предупреждение в safetyWarning.",
  "Заполни все поля JSON-схемы строго по сути: summary (структурированный вердикт с разделителями абзацев), causes (3–5 вероятных причин от самой частой к редкой), checklistSteps (4–6 проверяемых шагов ремонта/диагностики), dtcCodesMentioned (упомянутые коды формата P0300 и т.п.), affectedSystem (одна главная подсистема).",
].join("\n");

const SYSTEM_PROMPT_VISION = [
  SYSTEM_PROMPT_DIAGNOSTICS,
  "Дополнительно ты анализируешь приложенное фото от автовладельца или диагноста.",
  "Внимательно рассмотри индикаторы приборной панели (Check Engine, ABS, ESP, АКБ, масло, температура), потеки антифриза/масла/тормозной жидкости, состояние ремней, шлангов, клемм АКБ, свечей зажигания, тормозных дисков, разъемов проводки или экран стороннего сканера.",
  "Сопоставь визуальные признаки на фото с кодами DTC и телеметрией автомобиля.",
].join("\n");

const SYSTEM_PROMPT_MEMORY = [
  "Сожми историю автодиагностической сессии в емкую техническую сводку (до 700 символов) на русском языке.",
  "Сохрани только факты: автомобиль, подтвержденные коды DTC, ключевые отклонения телеметрии, уже выполненные проверки, исключенные гипотезы и актуальный статус проблемы.",
  "Не придумывай новые данные.",
].join("\n");

function buildDiagnosticUserPrompt(req: ServerDiagnoseTextInput): string {
  const parts: string[] = [];
  parts.push("=== ЗАПРОС ВОДИТЕЛЯ / ДИАГНОСТА ===");
  parts.push(req.query.trim() || "Проведи комплексную диагностику по текущим данным.");

  if (req.vehicleSummary.trim()) {
    parts.push("\n=== ПАРАМЕТРЫ АВТОМОБИЛЯ ===");
    parts.push(req.vehicleSummary.trim());
  }
  if (req.obdSnapshotText.trim()) {
    parts.push("\n=== ЖИВЫЕ ДАННЫЕ OBD-2 / ЭБУ ===");
    parts.push(req.obdSnapshotText.trim());
  }
  if (req.acousticSummary.trim()) {
    parts.push("\n=== АКУСТИЧЕСКИЙ АНАЛИЗ ДВИГАТЕЛЯ И РЕЧЬ ===");
    parts.push(req.acousticSummary.trim());
  }
  if (req.documentExcerpt.trim()) {
    parts.push("\n=== ВЫДЕРЖКА ИЗ ЗАГРУЖЕННОГО ДОКУМЕНТА / ЛОГА ===");
    parts.push(req.documentExcerpt.trim().slice(0, 6000));
  }
  if (req.ragContextText.trim()) {
    parts.push("\n=== КОНТЕКСТ ИЗ БАЗЫ ЗНАНИЙ (HYBRID RAG, 12 141 КОД DTC) ===");
    parts.push(req.ragContextText.trim().slice(0, 7000));
  }
  if (req.sessionMemorySummary.trim()) {
    parts.push("\n=== ПАМЯТЬ ТЕКУЩЕЙ СЕССИИ ===");
    parts.push(req.sessionMemorySummary.trim().slice(0, 1200));
  }
  if (req.crossMemoryText.trim()) {
    parts.push("\n=== ИСТОРИЯ ПРЕДЫДУЩИХ СЕССИЙ ПО ЭТОМУ АВТО ===");
    parts.push(req.crossMemoryText.trim().slice(0, 1500));
  }
  if (req.recentTurnsText.trim()) {
    parts.push("\n=== ПОСЛЕДНИЕ РЕПЛИКИ ДИАЛОГА ===");
    parts.push(req.recentTurnsText.trim().slice(0, 2500));
  }

  return parts.join("\n");
}

function clampConfidence(val: number): number {
  if (!Number.isFinite(val)) return 70;
  return Math.max(5, Math.min(99, Math.round(val)));
}

function sanitizePayload(raw: LlmDiagnosticPayload): LlmDiagnosticPayload {
  const dtcRegex = /^[PCBU][0-3][0-9A-F]{3}$/i;
  const cleanedCodes: string[] = [];
  if (Array.isArray(raw.dtcCodesMentioned)) {
    for (const c of raw.dtcCodesMentioned) {
      const up = String(c || "").trim().toUpperCase();
      if (dtcRegex.test(up) && !cleanedCodes.includes(up)) {
        cleanedCodes.push(up);
      }
    }
  }
  return {
    summary: String(raw.summary || "").trim() || "Анализ выполнен на основе доступных параметров.",
    confidencePercent: clampConfidence(raw.confidencePercent),
    severity: raw.severity === "critical" || raw.severity === "warning" || raw.severity === "info" ? raw.severity : "warning",
    causes: Array.isArray(raw.causes) ? raw.causes.map((s) => String(s || "").trim()).filter(Boolean).slice(0, 6) : [],
    checklistSteps: Array.isArray(raw.checklistSteps)
      ? raw.checklistSteps.map((s) => String(s || "").trim()).filter(Boolean).slice(0, 8)
      : [],
    safetyWarning: String(raw.safetyWarning || "").trim(),
    affectedSystem: raw.affectedSystem || "general",
    dtcCodesMentioned: cleanedCodes.slice(0, 12),
    followUpQuestion: String(raw.followUpQuestion || "").trim(),
  };
}

function mapAiErrorResult(err: unknown): ServerDiagnoseResult {
  if (err instanceof AiError) {
    console.warn(`[expert.server] AiError (${err.code}): ${err.message}`);
    return {
      ok: false,
      errorCode: err.code,
      errorMessage: err.message,
      data: null,
      usageInput: 0,
      usageOutput: 0,
    };
  }
  const msg = err instanceof Error ? err.message : String(err || "Unknown AI error");
  console.warn(`[expert.server] Non-AiError: ${msg}`);
  return {
    ok: false,
    errorCode: "unavailable",
    errorMessage: msg,
    data: null,
    usageInput: 0,
    usageOutput: 0,
  };
}

export async function diagnoseText(req: ServerDiagnoseTextInput): Promise<ServerDiagnoseResult> {
  if (!req || (!req.query.trim() && !req.obdSnapshotText.trim() && !req.documentExcerpt.trim())) {
    return {
      ok: false,
      errorCode: "invalid",
      errorMessage: "Пустой запрос на диагностику.",
      data: null,
      usageInput: 0,
      usageOutput: 0,
    };
  }

  try {
    const reply = await ai.send<LlmDiagnosticPayload>({
      system: SYSTEM_PROMPT_DIAGNOSTICS,
      text: buildDiagnosticUserPrompt(req),
      maxTokens: 1800,
    });
    return {
      ok: true,
      errorCode: "",
      errorMessage: "",
      data: sanitizePayload(reply.data),
      usageInput: reply.usage.input,
      usageOutput: reply.usage.output,
    };
  } catch (err) {
    return mapAiErrorResult(err);
  }
}

export async function diagnoseWithPhoto(
  req: ServerDiagnoseTextInput,
  photo: File
): Promise<ServerDiagnoseResult> {
  if (!photo || photo.size <= 0) {
    return diagnoseText(req);
  }
  const maxBytes = 6 * 1024 * 1024;
  if (photo.size > maxBytes) {
    return {
      ok: false,
      errorCode: "invalid",
      errorMessage: "Изображение превышает лимит 6 МБ. Уменьшите разрешение или обрежьте фото.",
      data: null,
      usageInput: 0,
      usageOutput: 0,
    };
  }

  try {
    const basePrompt = buildDiagnosticUserPrompt({
      ...req,
      query: req.query.trim() || "Проанализируй это фото приборной панели / подкапотного пространства / узла автомобиля.",
    });
    const reply = await ai.send<LlmDiagnosticPayload>({
      system: SYSTEM_PROMPT_VISION,
      text: basePrompt,
      images: [photo],
      maxTokens: 1800,
    });
    return {
      ok: true,
      errorCode: "",
      errorMessage: "",
      data: sanitizePayload(reply.data),
      usageInput: reply.usage.input,
      usageOutput: reply.usage.output,
    };
  } catch (err) {
    return mapAiErrorResult(err);
  }
}

export async function summarizeContext(req: {
  prevSummary: string;
  recentTurnsText: string;
  vehicleSummary: string;
}): Promise<ServerMemorySummaryResult> {
  if (!req.recentTurnsText.trim()) {
    return {
      ok: true,
      errorCode: "",
      summary: req.prevSummary.trim(),
      keyFindings: [],
      usageInput: 0,
      usageOutput: 0,
    };
  }

  try {
    const prompt = [
      req.vehicleSummary.trim() ? `Автомобиль: ${req.vehicleSummary.trim()}` : "",
      req.prevSummary.trim() ? `Предыдущая сводка:\n${req.prevSummary.trim()}` : "",
      `Новые сообщения:\n${req.recentTurnsText.trim().slice(0, 4500)}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    const reply = await ai.send<{ summary: string; keyFindings: string[] }>({
      system: SYSTEM_PROMPT_MEMORY,
      text: prompt,
      maxTokens: 500,
    });
    return {
      ok: true,
      errorCode: "",
      summary: String(reply.data.summary || req.prevSummary || "").trim().slice(0, 900),
      keyFindings: Array.isArray(reply.data.keyFindings)
        ? reply.data.keyFindings.map((k) => String(k || "").trim()).filter(Boolean).slice(0, 6)
        : [],
      usageInput: reply.usage.input,
      usageOutput: reply.usage.output,
    };
  } catch (err) {
    const code = err instanceof AiError ? err.code : "unavailable";
    return {
      ok: false,
      errorCode: code,
      summary: req.prevSummary.trim(),
      keyFindings: [],
      usageInput: 0,
      usageOutput: 0,
    };
  }
}

function decodeBytesLatin1(bytes: Uint8Array): string {
  if (typeof TextDecoder === "function") {
    return new TextDecoder("latin1").decode(bytes);
  }
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}

function decodeBytesUtf8(bytes: Uint8Array): string {
  if (typeof TextDecoder === "function") {
    return new TextDecoder("utf-8").decode(bytes);
  }
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const b1 = bytes[i++];
    if (b1 < 0x80) {
      out += String.fromCharCode(b1);
    } else if ((b1 & 0xe0) === 0xc0 && i < bytes.length) {
      const b2 = bytes[i++];
      out += String.fromCharCode(((b1 & 0x1f) << 6) | (b2 & 0x3f));
    } else if ((b1 & 0xf0) === 0xe0 && i + 1 < bytes.length) {
      const b2 = bytes[i++];
      const b3 = bytes[i++];
      out += String.fromCharCode(((b1 & 0x0f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f));
    } else if ((b1 & 0xf8) === 0xf0 && i + 2 < bytes.length) {
      const b2 = bytes[i++];
      const b3 = bytes[i++];
      const b4 = bytes[i++];
      let cp = ((b1 & 0x07) << 18) | ((b2 & 0x3f) << 12) | ((b3 & 0x3f) << 6) | (b4 & 0x3f);
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else {
      out += "\ufffd";
    }
  }
  return out;
}

function extractPdfStringsFromBytes(bytes: Uint8Array): string {
  const raw = decodeBytesLatin1(bytes);
  const chunks: string[] = [];

  // Extract parenthesized literal PDF text strings in content streams
  const literalRegex = /\(([^()\\]{2,320}(?:\\.[^()\\]*)*)\)\s*(?:Tj|'|")/g;
  let match: RegExpExecArray | null;
  while ((match = literalRegex.exec(raw)) !== null) {
    const cleaned = match[1]
      .replace(/\\n/g, " ")
      .replace(/\\r/g, " ")
      .replace(/\\t/g, " ")
      .replace(/\\([()\\])/g, "$1")
      .replace(/[^\x20-\x7E\u0400-\u04FF]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned.length >= 2 && /[A-Za-z0-9\u0400-\u04FF]/.test(cleaned)) {
      chunks.push(cleaned);
    }
    if (chunks.length > 2500) break;
  }

  // Fallback: collect readable lines (e.g. uncompressed PDF metadata/DTC tables)
  if (chunks.length < 15) {
    const textLines = raw
      .split(/[\r\n]+/)
      .map((l) => l.replace(/[^\x20-\x7E\u0400-\u04FF]/g, " ").replace(/\s+/g, " ").trim())
      .filter((l) => l.length >= 5 && !l.startsWith("%") && /[PCBU][0-3][0-9A-F]{3}|VIN|RPM|OBD|DTC|Ошиб|Код/i.test(l));
    for (const line of textLines.slice(0, 400)) {
      chunks.push(line);
    }
  }

  return chunks.join(" ").replace(/\s+/g, " ").trim();
}

function smartSampleText(fullText: string, maxChars: number): string {
  const clean = fullText.replace(/\r\n/g, "\n").replace(/\0/g, "").trim();
  if (clean.length <= maxChars) return clean;
  const half = Math.floor((maxChars - 80) / 2);
  return (
    clean.slice(0, half).trimEnd() +
    `\n\n... [пропущено ${clean.length - maxChars} симв. середины отчета] ...\n\n` +
    clean.slice(clean.length - half).trimStart()
  );
}

function extractMetricsFromDocument(text: string): { dtcCodes: string[]; metricsSummary: string } {
  const dtcMatches = text.match(/\b[PCBU][0-3][0-9A-F]{3}\b/gi) || [];
  const dtcCodes: string[] = [];
  for (const m of dtcMatches) {
    const up = m.toUpperCase();
    if (!dtcCodes.includes(up)) {
      dtcCodes.push(up);
      if (dtcCodes.length >= 30) break;
    }
  }

  const metricHints: string[] = [];
  const vinMatch = text.match(/\b[A-HJ-NPR-Z0-9]{17}\b/);
  if (vinMatch) metricHints.push(`VIN: ${vinMatch[0]}`);
  const voltMatch = text.match(/(?:voltage|battery|напряж|акб|bat)[:=\s]*([0-9]{1,2}[.,][0-9]{1,2})\s*(?:v|в)?/i);
  if (voltMatch) metricHints.push(`АКБ: ${voltMatch[1]} В`);
  const coolantMatch = text.match(/(?:coolant|ect|ож|темпер)[:=\s]*(-?[0-9]{1,3})\s*(?:c|°c|с)?/i);
  if (coolantMatch) metricHints.push(`ОЖ: ${coolantMatch[1]} °C`);
  const rpmMatch = text.match(/(?:rpm|обороты)[:=\s]*([0-9]{3,5})/i);
  if (rpmMatch) metricHints.push(`Обороты: ${rpmMatch[1]} об/мин`);

  return {
    dtcCodes,
    metricsSummary: metricHints.join(" | "),
  };
}

export async function parseUploadedDocument(doc: File): Promise<ServerParsedDocumentResult> {
  const fileName = String(doc?.name || "document.txt");
  const sizeBytes = Number(doc?.size || 0);
  if (!doc || sizeBytes <= 0) {
    return {
      ok: false,
      fileName,
      sizeBytes: 0,
      extractedText: "",
      dtcCodes: [],
      metricsSummary: "",
      charCount: 0,
      isBinaryFallback: false,
    };
  }

  const webFile = doc as unknown as {
    name?: string;
    size?: number;
    arrayBuffer?: () => Promise<ArrayBuffer>;
    text?: () => Promise<string>;
  };

  let buf: Uint8Array;
  if (typeof webFile.arrayBuffer === "function") {
    buf = new Uint8Array(await webFile.arrayBuffer());
  } else if (typeof webFile.text === "function") {
    const txt = await webFile.text();
    const arr = new Uint8Array(txt.length);
    for (let i = 0; i < txt.length; i++) arr[i] = txt.charCodeAt(i) & 0xff;
    buf = arr;
  } else {
    return {
      ok: false,
      fileName,
      sizeBytes,
      extractedText: "",
      dtcCodes: [],
      metricsSummary: "",
      charCount: 0,
      isBinaryFallback: true,
    };
  }

  const lowerName = fileName.toLowerCase();
  const isPdf = lowerName.endsWith(".pdf") || (buf.length >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46);

  let rawText = "";
  let isBinaryFallback = false;

  if (isPdf) {
    rawText = extractPdfStringsFromBytes(buf);
    if (!rawText) {
      isBinaryFallback = true;
      rawText =
        `[PDF-файл «${fileName}» (${Math.round(sizeBytes / 1024)} КБ) содержит сжатый поток или сканированное изображение. ` +
        "Для анализа скана/фото отчета прикрепите снимок экрана через кнопку Фото/Камера.]";
    }
  } else {
    const decoded = decodeBytesUtf8(buf);
    // Count replacement/control characters to detect unsupported binary files (e.g. compressed ZIP/DOCX/XLSX without unzip)
    let suspicious = 0;
    const sampleLen = Math.min(decoded.length, 2000);
    for (let i = 0; i < sampleLen; i++) {
      const code = decoded.charCodeAt(i);
      if (code === 0xfffd || (code < 32 && code !== 9 && code !== 10 && code !== 13)) {
        suspicious++;
      }
    }
    if (sampleLen > 40 && suspicious / sampleLen > 0.12) {
      isBinaryFallback = true;
      // Pull readable ASCII + UTF-8 fragments so any embedded DTCs/VINs are still rescued
      rawText = decoded
        .replace(/[^\x20-\x7E\u0400-\u04FF\n]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (rawText.length < 40) {
        rawText =
          `[Бинарный файл «${fileName}» (${Math.round(sizeBytes / 1024)} КБ). ` +
          "Экспортируйте отчет сканера в .TXT, .CSV, .LOG или .JSON для полного текстового разбора.]";
      }
    } else {
      rawText = decoded;
    }
  }

  const sampled = smartSampleText(rawText, 24000);
  const { dtcCodes, metricsSummary } = extractMetricsFromDocument(sampled);

  return {
    ok: true,
    fileName,
    sizeBytes,
    extractedText: sampled,
    dtcCodes,
    metricsSummary,
    charCount: sampled.length,
    isBinaryFallback,
  };
}
