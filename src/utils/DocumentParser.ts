// ИИдеал Авто — Client & Server Document/Log Parser (2026-11-28)
// Copyright (C) 2026 ИИдеал Авто (LeCodes48 Edition)
// Licensed under the GNU General Public License v3.0 (GPL-3.0).

import { parseUploadedDocument } from "../../expert.server";
import type { ParsedDocInfo } from "../types";

export function analyzeRawTextDocument(
  fileName: string,
  rawText: string
): ParsedDocInfo {
  const clean = String(rawText || "").replace(/\r\n/g, "\n").replace(/\0/g, "").trim();
  const maxChars = 24000;
  let sampled = clean;
  let isFully = true;
  if (clean.length > maxChars) {
    isFully = false;
    const half = Math.floor((maxChars - 80) / 2);
    sampled =
      clean.slice(0, half).trimEnd() +
      `\n\n... [пропущено ${clean.length - maxChars} симв. середины отчета] ...\n\n` +
      clean.slice(clean.length - half).trimStart();
  }

  const dtcMatches = sampled.match(/\b[PCBU][0-3][0-9A-F]{3}\b/gi) || [];
  const dtcCodes: string[] = [];
  for (const m of dtcMatches) {
    const up = m.toUpperCase();
    if (!dtcCodes.includes(up)) {
      dtcCodes.push(up);
      if (dtcCodes.length >= 30) break;
    }
  }

  const hints: string[] = [];
  const vinMatch = sampled.match(/\b[A-HJ-NPR-Z0-9]{17}\b/);
  if (vinMatch) hints.push(`VIN: ${vinMatch[0]}`);
  const voltMatch = sampled.match(/(?:voltage|battery|напряж|акб|bat)[:=\s]*([0-9]{1,2}[.,][0-9]{1,2})\s*(?:v|в)?/i);
  if (voltMatch) hints.push(`АКБ: ${voltMatch[1]} В`);
  const coolantMatch = sampled.match(/(?:coolant|ect|ож|темпер)[:=\s]*(-?[0-9]{1,3})\s*(?:c|°c|с)?/i);
  if (coolantMatch) hints.push(`ОЖ: ${coolantMatch[1]} °C`);
  const rpmMatch = sampled.match(/(?:rpm|обороты)[:=\s]*([0-9]{3,5})/i);
  if (rpmMatch) hints.push(`Обороты: ${rpmMatch[1]} об/мин`);

  const dotIdx = fileName.lastIndexOf(".");
  const ext = dotIdx >= 0 ? fileName.slice(dotIdx + 1).toLowerCase() : "txt";

  return {
    filename: fileName,
    extension: ext,
    size_bytes: clean.length,
    char_length: sampled.length,
    is_fully_processed: isFully,
    processing_mode: "Локальный парсер текста/логов",
    detected_dtc_codes: dtcCodes,
    key_metrics: hints,
    llm_ready_text: sampled,
    preview_excerpt: sampled.slice(0, 420),
  };
}

export async function parseDocumentFile(file: File): Promise<ParsedDocInfo> {
  const safeName = String(file?.name || "log.txt");
  const safeSize = Number(file?.size || 0);
  const dotIdx = safeName.lastIndexOf(".");
  const ext = dotIdx >= 0 ? safeName.slice(dotIdx + 1).toLowerCase() : "bin";

  if (!file || safeSize <= 0) {
    return {
      filename: safeName,
      extension: ext,
      size_bytes: 0,
      char_length: 0,
      is_fully_processed: false,
      processing_mode: "Пустой файл",
      detected_dtc_codes: [],
      key_metrics: [],
      llm_ready_text: "",
      preview_excerpt: "",
    };
  }

  try {
    const serverRes = await parseUploadedDocument(file);
    if (serverRes && serverRes.ok) {
      const metrics = serverRes.metricsSummary
        ? serverRes.metricsSummary.split("|").map((s) => s.trim()).filter(Boolean)
        : [];
      return {
        filename: serverRes.fileName,
        extension: ext,
        size_bytes: serverRes.sizeBytes,
        char_length: serverRes.charCount,
        is_fully_processed: !serverRes.isBinaryFallback,
        processing_mode: serverRes.isBinaryFallback
          ? "Извлечение фрагментов / скана"
          : `Парсер ${ext.toUpperCase()}`,
        detected_dtc_codes: serverRes.dtcCodes,
        key_metrics: metrics,
        llm_ready_text: serverRes.extractedText,
        preview_excerpt: serverRes.extractedText.slice(0, 420),
      };
    }
  } catch (err) {
    console.warn("[DocumentParser] Server parse failed, using offline fallback:", err);
  }

  const fromName = analyzeRawTextDocument(safeName, safeName);
  const fallbackText =
    `[Оффлайн-разбор: файл «${safeName}» (${Math.max(1, Math.round(safeSize / 1024))} КБ).` +
    (fromName.detected_dtc_codes.length > 0
      ? ` Найденные в имени коды: ${fromName.detected_dtc_codes.join(", ")}.]`
      : " Для полного анализа документа без сети вставьте текст через «Вставить лог».]");

  return {
    filename: safeName,
    extension: ext,
    size_bytes: safeSize,
    char_length: fallbackText.length,
    is_fully_processed: false,
    processing_mode: "Оффлайн метаданные",
    detected_dtc_codes: fromName.detected_dtc_codes,
    key_metrics: fromName.key_metrics,
    llm_ready_text: fallbackText,
    preview_excerpt: fallbackText,
  };
}
