/**
 * Автономный гибридный RAG-движок в TypeScript (на базе engine.py).
 * Объединяет O(1) словарь всех 12 141 кодов OBD-II (P/C/B/U), курируемую русскоязычную БЗ,
 * эталонную телеметрию, двуязычный RU/EN стеммер, BM25-ранжирование и косинус символьных 3-грамм.
 * Работает 100% на устройстве за миллисекунды, без внешних эмбеддингов и API-ключей.
 *
 * Лицензия: GNU General Public License v3.0 (GPL-3.0).
 */

import {
  AcousticAnalysisMetrics,
  ChatFaultItem,
  ChatInventoryItem,
  ChatRepairTask,
  DtcCodeInfo,
  DtcPageResult,
  DtcSystemCount,
  OBDLiveSensors,
  SystemKey
} from "../types";

interface Tier1EntryRaw {
  id: string;
  c: string;
  s: SystemKey;
  sr: string;
  sv: string;
  h: number;
  sy: string;
  ca: string;
  f: string;
  src: string;
}

interface TelemetryStatRaw {
  c: string;
  s: SystemKey;
  sr: string;
  n: number;
  temp: number;
  volt: number;
  h: number;
  sev: string;
  sym: string;
}

interface Tier1Bundle {
  version: string;
  systems: Record<string, string>;
  default_symptoms: Record<string, string>;
  telemetry_stats: Record<string, TelemetryStatRaw>;
  entries: Tier1EntryRaw[];
}

// Формат строки: [code, sysIdx, sevIdx, health, sym, cause, fix, oemShort, tsbCount]
type ExtRowTuple = [string, number, number, number, string, string, string, string, number];

interface ExtBundle {
  sysKeys: SystemKey[];
  rows: ExtRowTuple[];
}

const STOP_WORDS = new Set([
  "и", "в", "во", "на", "по", "с", "со", "к", "ко", "от", "до", "из", "за", "при",
  "не", "ни", "а", "но", "или", "что", "как", "это", "все", "всё", "так", "же",
  "бы", "ли", "у", "о", "об", "про", "для", "без", "над", "под", "через", "после",
  "привет", "здравствуйте", "подскажи", "помоги", "пожалуйста", "машина", "автомобиль", "авто",
  "the", "and", "for", "with", "from", "that", "this", "are", "was", "were",
  "have", "has", "had", "been", "into", "over", "after", "before", "under",
  "car", "vehicle", "auto", "fault", "code", "codes", "error", "problem", "issue"
]);

const SYSTEM_NAMES_RU: Record<SystemKey, string> = {
  engine: "Двигатель",
  transmission: "Трансмиссия",
  brakes: "Тормозная система",
  electrical: "Электрооборудование",
  cooling: "Система охлаждения",
  hybrid: "Гибридная установка",
  battery: "Тяговая батарея (ВВБ / BMS)",
  chassis: "Ходовая часть",
  suspension: "Подвеска"
};

// Двуязычные синонимы для кросс-языкового поиска по английской части базы (12 128 DTC)
const RU_EN_BRIDGES: Record<string, string[]> = {
  троит: ["misfire", "cylinder", "ignition"],
  пропуск: ["misfire", "ignition"],
  глохнет: ["stall", "idle", "fuel", "crank"],
  бедная: ["lean", "vacuum", "air", "fuel"],
  богатая: ["rich", "fuel", "injector"],
  катализатор: ["catalyst", "efficiency", "o2"],
  акпп: ["transmission", "solenoid", "gear", "shift", "torque"],
  пинки: ["shift", "solenoid", "pressure", "clutch", "transmission"],
  тормоз: ["brake", "abs", "wheel", "speed", "sensor"],
  шина: ["can", "bus", "communication", "lost", "module"],
  перегрев: ["coolant", "overheat", "temperature", "thermostat", "fan"],
  акб: ["battery", "voltage", "charging", "alternator"],
  генератор: ["alternator", "charging", "voltage"],
  батарея: ["battery", "hybrid", "cell", "pack", "bms"],
  подвеск: ["suspension", "air", "compressor", "strut", "ride"],
  датчик: ["sensor", "circuit", "range", "performance"],
  форсунк: ["injector", "fuel", "circuit"],
  катушк: ["coil", "ignition", "primary", "secondary"],
  фаз: ["camshaft", "vvt", "timing", "actuator"],
  руль: ["steering", "eps", "power"]
};

const WORD_RE = /[a-zа-яё0-9]+/gi;
const CYR_WORD_RE = /^[а-яё]+$/;
const DTC_RE = /\b([PCBU][0-9A-F]{4})\b/gi;

export function tokenizeMultilingual(text: string): string[] {
  const words = (text || "").toLowerCase().match(WORD_RE) || [];
  const tokens: string[] = [];
  for (const w of words) {
    if (w.length <= 1 || STOP_WORDS.has(w)) continue;
    tokens.push(w);
    if (/^[a-z0-9]+$/.test(w)) {
      if (/^[a-z]+$/.test(w) && w.length >= 5) {
        let stem = w;
        if (w.endsWith("ies") && w.length - 3 >= 2) stem = w.slice(0, -3) + "y";
        else if (w.endsWith("ing") && w.length - 3 >= 4) stem = w.slice(0, -3);
        else if (w.endsWith("ed") && w.length - 2 >= 4) stem = w.slice(0, -2);
        else if (w.endsWith("s") && !w.endsWith("ss") && w.length - 1 >= 4) stem = w.slice(0, -1);
        if (stem !== w && !STOP_WORDS.has(stem)) tokens.push(stem);
      }
    } else if (w.length >= 6 && CYR_WORD_RE.test(w)) {
      tokens.push(w.slice(0, 5));
    }
    // Кросс-языковые подсказки для английской базы
    for (const key of Object.keys(RU_EN_BRIDGES)) {
      if (w.includes(key)) {
        for (const en of RU_EN_BRIDGES[key]) tokens.push(en);
      }
    }
  }
  return tokens;
}

function charNgrams(text: string, n: number = 3): Map<string, number> {
  const cleaned = (text || "").toLowerCase().replace(/\s+/g, " ").trim();
  const map = new Map<string, number>();
  if (!cleaned) return map;
  if (cleaned.length < n) {
    map.set(cleaned, 1);
    return map;
  }
  for (let i = 0; i <= cleaned.length - n; i++) {
    const gram = cleaned.slice(i, i + n);
    map.set(gram, (map.get(gram) || 0) + 1);
  }
  return map;
}

function cosineMapSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let num = 0;
  let normA = 0;
  let normB = 0;
  for (const [k, va] of a.entries()) {
    normA += va * va;
    const vb = b.get(k);
    if (vb) num += va * vb;
  }
  if (num === 0) return 0;
  for (const vb of b.values()) normB += vb * vb;
  const den = Math.sqrt(normA) * Math.sqrt(normB);
  return den > 0 ? num / den : 0;
}

export function inferSystemFromCode(code: string): SystemKey {
  const c = (code || "").toUpperCase().trim();
  if (c === "P0A80" || c.startsWith("P0C")) return "hybrid";
  if (c === "P0A1F" || c === "P0AC0" || c.startsWith("P0B") || c.startsWith("P0D")) return "battery";
  if (c.startsWith("P0A")) return "hybrid";
  if (c.startsWith("P07") || c.startsWith("P08") || c === "P1744") return "transmission";
  if (c === "P0217" || c.startsWith("P0115") || c.startsWith("P0128")) return "cooling";
  if (c.startsWith("P056") || c.startsWith("U") || c.startsWith("B")) return "electrical";
  if (c.startsWith("C17") || c.startsWith("C18") || c.startsWith("C19")) return "suspension";
  if (c.startsWith("C04") || c.startsWith("C05")) return "chassis";
  if (c.startsWith("C")) return "brakes";
  return "engine";
}

export interface RagHit {
  code: string;
  system: SystemKey;
  systemRu: string;
  severity: "critical" | "warning" | "info";
  healthIndex: number;
  symptoms: string;
  cause: string;
  fix: string;
  oemVariants?: string;
  nhtsaBulletins?: number;
  tier: 1 | 2 | 3;
  score: number;
}

export interface RagRetrievalResult {
  extractedCodes: string[];
  hits: RagHit[];
  telemetryNotes: string[];
  systemScores: Record<SystemKey, number>;
  llmContextText: string;
}

interface UnifiedDoc {
  idx: number;
  code: string;
  system: SystemKey;
  systemRu: string;
  severity: "critical" | "warning" | "info";
  health: number;
  symptoms: string;
  cause: string;
  fix: string;
  oem?: string;
  tsb?: number;
  tier: 1 | 2 | 3;
  searchBlob: string;
}

export class HybridRagEngine {
  private initialized = false;
  private docs: UnifiedDoc[] = [];
  private dtcCatalog: Map<string, DtcCodeInfo> = new Map();
  private dtcOrderedCodes: string[] = [];
  private codeToDocIndices: Map<string, number[]> = new Map();
  private invertedIndex: Map<string, number[]> = new Map();
  private docLengths: number[] = [];
  private avgDocLen = 12;
  private telemetryStats: Record<string, TelemetryStatRaw> = {};
  private defaultSymptoms: Record<string, string> = {};
  private systemCounts: DtcSystemCount[] = [];

  private ensureInit(): void {
    if (this.initialized) return;
    this.initialized = true;

    const t1 = asset("./src/rag/kb_tier1.json") as unknown as Tier1Bundle;
    const ext = asset("./src/rag/kb_external.json") as unknown as ExtBundle;

    this.telemetryStats = t1.telemetry_stats || {};
    this.defaultSymptoms = t1.default_symptoms || {};

    const sysKeys = ext.sysKeys || (Object.keys(SYSTEM_NAMES_RU) as SystemKey[]);
    const sevList: Array<"info" | "warning" | "critical"> = ["info", "warning", "critical"];

    // 1. Загружаем курируемые Tier-1 записи (русский язык + эталонная телеметрия)
    for (const e of t1.entries || []) {
      const code = (e.c || "").toUpperCase();
      const sysKey = e.s || inferSystemFromCode(code);
      const sev: "critical" | "warning" | "info" =
        e.sv === "critical" ? "critical" : e.sv === "info" ? "info" : "warning";
      const idx = this.docs.length;
      const doc: UnifiedDoc = {
        idx,
        code,
        system: sysKey,
        systemRu: SYSTEM_NAMES_RU[sysKey] || e.sr,
        severity: sev,
        health: e.h || 65,
        symptoms: e.sy || "",
        cause: e.ca || "",
        fix: e.f || "",
        tier: 1,
        searchBlob: `${code} ${SYSTEM_NAMES_RU[sysKey]} ${e.sy} ${e.ca} ${e.f}`
      };
      this.docs.push(doc);

      if (code) {
        if (!this.codeToDocIndices.has(code)) this.codeToDocIndices.set(code, []);
        this.codeToDocIndices.get(code)!.push(idx);

        // Приоритет в каталоге для записи из kb_data.json
        const existing = this.dtcCatalog.get(code);
        if (!existing || e.src === "kb_data.json") {
          const ts = this.telemetryStats[code];
          this.dtcCatalog.set(code, {
            code,
            title: (e.sy || this.defaultSymptoms[code] || `Ошибка ${code}`).split(",")[0].slice(0, 90),
            description: e.sy || this.defaultSymptoms[code] || "",
            system: sysKey,
            system_ru: SYSTEM_NAMES_RU[sysKey],
            severity: sev,
            health_index: e.h || 65,
            has_telemetry: Boolean(ts),
            symptoms: e.sy ? e.sy.split(/,\s*/).slice(0, 4) : [],
            causes: e.ca ? [e.ca] : [],
            solution: e.f || "",
            en_title: existing?.en_title,
            oem_variants: existing?.oem_variants,
            nhtsa_bulletins: existing?.nhtsa_bulletins
          });
        }
      }
    }

    // 2. Загружаем 12 262 записи внешней БЗ (12 128 DTC + 134 процедуры)
    for (const row of ext.rows || []) {
      const code = (row[0] || "").toUpperCase();
      const sysKey = sysKeys[row[1]] || inferSystemFromCode(code);
      const sev = sevList[row[2]] || "warning";
      const health = row[3] || 70;
      const sym = row[4] || "";
      const cause = row[5] || "";
      const fix = row[6] || "";
      const oem = row[7] || "";
      const tsb = row[8] || 0;

      const idx = this.docs.length;
      const doc: UnifiedDoc = {
        idx,
        code,
        system: sysKey,
        systemRu: SYSTEM_NAMES_RU[sysKey],
        severity: sev,
        health,
        symptoms: sym,
        cause,
        fix,
        oem: oem || undefined,
        tsb: tsb || undefined,
        tier: oem || tsb > 0 ? 2 : 3,
        searchBlob: `${code} ${sysKey} ${sym} ${cause} ${fix} ${oem}`
      };
      this.docs.push(doc);

      if (code) {
        if (!this.codeToDocIndices.has(code)) this.codeToDocIndices.set(code, []);
        this.codeToDocIndices.get(code)!.push(idx);

        const existing = this.dtcCatalog.get(code);
        if (!existing) {
          this.dtcCatalog.set(code, {
            code,
            title: (this.defaultSymptoms[code] || sym || `Ошибка ${code}`).slice(0, 96),
            description: this.defaultSymptoms[code] || sym,
            system: sysKey,
            system_ru: SYSTEM_NAMES_RU[sysKey],
            severity: sev,
            health_index: health,
            has_telemetry: Boolean(this.telemetryStats[code]),
            symptoms: sym ? [sym] : [],
            causes: cause ? [cause] : [],
            en_title: sym,
            solution: fix,
            oem_variants: oem || undefined,
            nhtsa_bulletins: tsb || undefined
          });
        } else {
          // Обогащаем русскоязычную карточку OEM-вариантами и бюллетенями NHTSA
          if (sym && !existing.en_title) existing.en_title = sym;
          if (oem && !existing.oem_variants) existing.oem_variants = oem;
          if (tsb > 0 && !existing.nhtsa_bulletins) existing.nhtsa_bulletins = tsb;
        }
      }
    }

    // 3. Строим быстрый инвертированный индекс BM25 (без лишнего расхода памяти на триграммы)
    let totalLen = 0;
    for (let i = 0; i < this.docs.length; i++) {
      const toks = tokenizeMultilingual(this.docs[i].searchBlob);
      this.docLengths.push(toks.length);
      totalLen += toks.length;
      const seen = new Set<string>();
      for (const t of toks) {
        if (seen.has(t)) continue;
        seen.add(t);
        let list = this.invertedIndex.get(t);
        if (!list) {
          list = [];
          this.invertedIndex.set(t, list);
        }
        list.push(i);
      }
    }
    this.avgDocLen = this.docs.length > 0 ? totalLen / this.docs.length : 12;

    // 4. Сортировка словаря DTC (приоритет русскоязычным и с телеметрией, затем по коду)
    const entries = Array.from(this.dtcCatalog.values());
    entries.sort((a, b) => {
      const aHasRu = a.symptoms && a.symptoms.length > 0 && /[а-яё]/i.test(a.title) ? 1 : 0;
      const bHasRu = b.symptoms && b.symptoms.length > 0 && /[а-яё]/i.test(b.title) ? 1 : 0;
      if (aHasRu !== bHasRu) return bHasRu - aHasRu;
      return a.code.localeCompare(b.code);
    });
    this.dtcOrderedCodes = entries.map(e => e.code);

    const sysCountMap: Record<string, number> = {};
    for (const k of Object.keys(SYSTEM_NAMES_RU)) sysCountMap[k] = 0;
    for (const item of entries) {
      const sk = String(item.system);
      sysCountMap[sk] = (sysCountMap[sk] || 0) + 1;
    }
    this.systemCounts = (Object.keys(SYSTEM_NAMES_RU) as SystemKey[]).map(id => ({
      id,
      name: SYSTEM_NAMES_RU[id],
      count: sysCountMap[id] || 0
    }));
  }

  public getCatalogCount(): number {
    this.ensureInit();
    return this.dtcCatalog.size;
  }

  public getSystemCounts(): DtcSystemCount[] {
    this.ensureInit();
    return this.systemCounts;
  }

  public extractDtcCodes(text: string): string[] {
    const matches = (text || "").toUpperCase().match(DTC_RE) || [];
    return Array.from(new Set(matches));
  }

  public synthesizeDtcInfo(code: string): DtcCodeInfo {
    const upper = (code || "").trim().toUpperCase();
    const sysKey = inferSystemFromCode(upper);
    const defaultSym = this.defaultSymptoms[upper];
    return {
      code: upper,
      title: defaultSym ? defaultSym.split(",")[0] : `Диагностический код ${upper}`,
      description:
        defaultSym ||
        `Стандартный код OBD-II (${SYSTEM_NAMES_RU[sysKey]}). Рекомендуется проверить датчик, проводку и стоп-кадр ЭБУ.`,
      system: sysKey,
      system_ru: SYSTEM_NAMES_RU[sysKey],
      severity: upper.startsWith("P03") || upper.startsWith("C00") ? "critical" : "warning",
      health_index: 65,
      symptoms: defaultSym ? [defaultSym] : [],
      causes: ["Обрыв или замыкание цепи, сбой датчика или исполнительного механизма"],
      solution: "Считать Freeze Frame, проверить питание/массу разъёма и выполнить проверку узла."
    };
  }

  public getDtcDetails(code: string): DtcCodeInfo {
    this.ensureInit();
    const clean = (code || "").trim().toUpperCase();
    return this.dtcCatalog.get(clean) || this.synthesizeDtcInfo(clean);
  }

  public searchDtcPage(
    query: string,
    systemFilter: string = "all",
    offset: number = 0,
    limit: number = 80
  ): DtcPageResult {
    this.ensureInit();
    const q = (query || "").trim().toUpperCase();
    const sf = (systemFilter || "all").trim().toUpperCase();
    const matched: DtcCodeInfo[] = [];

    for (const code of this.dtcOrderedCodes) {
      const info = this.dtcCatalog.get(code)!;
      if (sf !== "ALL") {
        if (sf === "P" || sf === "C" || sf === "B" || sf === "U") {
          if (!code.startsWith(sf)) continue;
        } else if (String(info.system).toUpperCase() !== sf) {
          continue;
        }
      }

      if (!q) {
        matched.push(info);
        continue;
      }

      const hay = `${code} ${info.title} ${info.description} ${info.en_title || ""} ${info.solution || ""} ${info.oem_variants || ""}`.toUpperCase();
      if (hay.includes(q)) matched.push(info);
    }

    if (matched.length === 0 && /^[PCBU][0-9A-F]{4}$/i.test(q)) {
      matched.push(this.synthesizeDtcInfo(q));
    }

    const safeOffset = Math.max(0, Math.floor(offset));
    const safeLimit = Math.max(1, Math.floor(limit));
    return {
      items: matched.slice(safeOffset, safeOffset + safeLimit),
      total: matched.length,
      totalCatalog: this.dtcCatalog.size,
      systems: this.systemCounts
    };
  }

  public retrieveForDiagnosis(
    query: string,
    explicitDtcCodes: string[] = [],
    telemetry?: OBDLiveSensors,
    topK: number = 6
  ): RagRetrievalResult {
    this.ensureInit();
    const extracted = Array.from(
      new Set([
        ...explicitDtcCodes.map(c => c.trim().toUpperCase()),
        ...(telemetry?.dtcList || []).map(c => c.trim().toUpperCase()),
        ...this.extractDtcCodes(query)
      ])
    ).filter(Boolean);

    const qTokens = tokenizeMultilingual(`${query} ${extracted.join(" ")}`);
    const qNgrams = charNgrams(query);

    // 1. Собираем пул кандидатов через O(1) DTC-индекс + BM25 по инвертированному индексу
    const candidateScores = new Map<number, number>();
    const nDocs = Math.max(1, this.docs.length);

    for (const code of extracted) {
      const docIds = this.codeToDocIndices.get(code) || [];
      for (const id of docIds.slice(0, 4)) {
        candidateScores.set(id, (candidateScores.get(id) || 0) + 4.5);
      }
    }

    const k1 = 1.5;
    const b = 0.75;
    for (const tok of qTokens) {
      const postings = this.invertedIndex.get(tok);
      if (!postings) continue;
      const idf = Math.log(1 + (nDocs - postings.length + 0.5) / (postings.length + 0.5));
      for (let p = 0; p < postings.length; p++) {
        const docIdx = postings[p];
        const dl = this.docLengths[docIdx] || 12;
        const bm25Part = idf * ((k1 + 1) / (1 + k1 * (1 - b + b * (dl / this.avgDocLen))));
        candidateScores.set(docIdx, (candidateScores.get(docIdx) || 0) + bm25Part);
      }
    }

    // Если запрос короткий и точных токенов мало — берём первые Tier-1 записи для проверки триграмм
    if (candidateScores.size < 15) {
      for (let i = 0; i < Math.min(120, this.docs.length); i++) {
        if (!candidateScores.has(i)) candidateScores.set(i, 0.01);
      }
    }

    // 2. Ранжируем топ-60 кандидатов по гибридной формуле (BM25 + char 3-grams + code bonus + tier bonus)
    const topCandidates = Array.from(candidateScores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 60);

    const maxBm25 = topCandidates.length > 0 ? Math.max(1e-6, topCandidates[0][1]) : 1;
    const scored: RagHit[] = [];

    for (const [docIdx, bm25Raw] of topCandidates) {
      const doc = this.docs[docIdx];
      const bm25Norm = bm25Raw / maxBm25;
      const ngSim = cosineMapSimilarity(qNgrams, charNgrams(`${doc.code} ${doc.symptoms} ${doc.cause}`));
      const codeMatch = doc.code && extracted.includes(doc.code) ? 2.2 : 0;
      const tierBonus = doc.tier === 1 ? 0.25 : doc.tier === 2 ? 0.08 : 0;
      const healthBonus = ((100 - doc.health) / 200) * 0.15;
      const finalScore = 0.55 * bm25Norm + 0.30 * ngSim + codeMatch + tierBonus + healthBonus;

      scored.push({
        code: doc.code,
        system: doc.system,
        systemRu: doc.systemRu,
        severity: doc.severity,
        healthIndex: doc.health,
        symptoms: doc.symptoms,
        cause: doc.cause,
        fix: doc.fix,
        oemVariants: doc.oem,
        nhtsaBulletins: doc.tsb,
        tier: doc.tier,
        score: Math.round(finalScore * 1000) / 1000
      });
    }

    scored.sort((a, b) => b.score - a.score);
    const hits = scored.slice(0, topK);

    // Если указан код DTC, которого нет в kb_tier1/ext, синтезируем его карточку
    for (const code of extracted) {
      if (!hits.some(h => h.code === code) && /^[PCBU][0-9A-F]{4}$/i.test(code)) {
        const synth = this.synthesizeDtcInfo(code);
        hits.unshift({
          code,
          system: synth.system as SystemKey,
          systemRu: synth.system_ru || SYSTEM_NAMES_RU.engine,
          severity: synth.severity,
          healthIndex: synth.health_index || 65,
          symptoms: synth.description,
          cause: (synth.causes || [])[0] || "",
          fix: synth.solution || "",
          tier: 2,
          score: 3.0
        });
      }
    }

    // 3. Анализируем телеметрию и эталоны
    const telemetryNotes: string[] = [];
    const systemScores: Record<SystemKey, number> = {
      engine: 95,
      transmission: 96,
      brakes: 98,
      electrical: 97,
      cooling: 96,
      hybrid: 98,
      battery: 97,
      chassis: 98,
      suspension: 98
    };

    for (const h of hits.slice(0, 5)) {
      systemScores[h.system] = Math.min(systemScores[h.system], Math.max(20, h.healthIndex));
    }

    if (telemetry) {
      if (telemetry.coolantTemp > 102) {
        telemetryNotes.push(`Критическая температура ОЖ: ${telemetry.coolantTemp}°C (норма 85–95°C)`);
        systemScores.cooling = Math.min(systemScores.cooling, 38);
      } else if (telemetry.coolantTemp > 0) {
        telemetryNotes.push(`Температура ОЖ: ${telemetry.coolantTemp}°C`);
      }
      if (telemetry.voltage > 0 && telemetry.voltage < 12.1) {
        telemetryNotes.push(`Низкое напряжение бортсети: ${telemetry.voltage.toFixed(1)} В (норма 13.6–14.5 В при запущенном ДВС)`);
        systemScores.electrical = Math.min(systemScores.electrical, 42);
      } else if (telemetry.voltage > 14.9) {
        telemetryNotes.push(`Перезаряд генератора: ${telemetry.voltage.toFixed(1)} В (риск повреждения ЭБУ/АКБ)`);
        systemScores.electrical = Math.min(systemScores.electrical, 45);
      }
      if (telemetry.rpm > 0) {
        telemetryNotes.push(
          `OBD Live: ${telemetry.rpm} об/мин • ${telemetry.speed} км/ч • Нагрузка ${telemetry.engineLoad}% • Дроссель ${telemetry.throttle}%`
        );
      }
    }

    for (const code of extracted.slice(0, 3)) {
      const ts = this.telemetryStats[code];
      if (ts) {
        telemetryNotes.push(
          `Эталон БЗ для ${code} (${ts.n} замеров): ср. темп. ${ts.temp}°C, сеть ${ts.volt} В, ресурс ${ts.h}%`
        );
      }
    }

    const contextLines = hits.slice(0, topK).map((h, i) => {
      const codeStr = h.code ? `[${h.code}] ` : "";
      return `${i + 1}. ${codeStr}${h.systemRu} (риск=${h.severity}, здоровье=${h.healthIndex}%): Симптомы: ${h.symptoms}. Причина: ${h.cause}. Ремонт: ${h.fix}${
        h.oemVariants ? `. OEM: ${h.oemVariants}` : ""
      }`;
    });

    const llmContextText =
      (contextLines.length > 0 ? contextLines.join("\n") : "Прямых совпадений в БЗ нет, проанализируй по общей методике OBD-II.") +
      (telemetryNotes.length > 0 ? `\n\nТелеметрия:\n- ${telemetryNotes.join("\n- ")}` : "");

    return {
      extractedCodes: extracted,
      hits: hits.slice(0, topK),
      telemetryNotes,
      systemScores,
      llmContextText
    };
  }

  /**
   * Локальный детерминированный синтез полного экспертного заключения (работает офлайн и при исчерпании кредитов ИИ).
   */
  public buildDeterministicVerdict(params: {
    query: string;
    rag: RagRetrievalResult;
    vehicleInfo?: string;
    acoustic?: AcousticAnalysisMetrics;
    reasonNote?: string;
  }): {
    summaryTitle: string;
    answer: string;
    faults: ChatFaultItem[];
    tasks: ChatRepairTask[];
    inventoryItems: ChatInventoryItem[];
    telemetryNotes: string[];
    recommendations: string[];
    followupSuggestions: string[];
  } {
    const { rag, query, vehicleInfo, acoustic, reasonNote } = params;
    const topHits = rag.hits.slice(0, 3);
    const faults: ChatFaultItem[] = topHits
      .filter(h => Boolean(h.code) || h.score > 0.35)
      .map(h => ({
        code: h.code || "DIAG",
        system: h.system,
        system_ru: h.systemRu,
        title: (h.symptoms || `Неисправность узла (${h.systemRu})`).slice(0, 95),
        confidence: Math.min(96, Math.max(62, Math.round(h.score * 28 + 52))),
        description: h.symptoms,
        root_cause: h.cause || "Требуется инструментальная проверка контура",
        severity: h.severity,
        health_index: h.healthIndex
      }));

    const lead = topHits[0];
    const codesLabel = rag.extractedCodes.length > 0 ? rag.extractedCodes.join(", ") : lead?.code || "симптомам";
    const summaryTitle = lead
      ? `Локальный RAG-диагноз (${codesLabel}): ${lead.systemRu}`
      : "Предварительная диагностика по базе знаний";

    const lines: string[] = [];
    if (reasonNote) lines.push(`[${reasonNote}]`);
    if (vehicleInfo) lines.push(`Автомобиль: ${vehicleInfo}.`);
    if (lead) {
      lines.push(
        `По локальной базе знаний (12 141 код OBD-II) выявлена ключевая проблема в системе «${lead.systemRu}»: ${lead.symptoms}.`
      );
      if (lead.cause) lines.push(`Вероятная первопричина: ${lead.cause}.`);
      if (lead.fix) lines.push(`Рекомендуемое решение: ${lead.fix}.`);
    } else {
      lines.push(`Проанализирован запрос: «${query.slice(0, 120)}». Ниже сформирован базовый план проверки.`);
    }

    if (acoustic) {
      lines.push(
        `Акустический замер (${acoustic.durationSec}с): доминирующая частота ${acoustic.avgHz} Гц (пик ${acoustic.peakHz} Гц, уровень ${acoustic.peakDb} дБ) — ${acoustic.acousticHint}.`
      );
    }

    const tasks: ChatRepairTask[] = [];
    topHits.forEach((h, idx) => {
      const fixText = h.fix || `Проверить узел системы «${h.systemRu}» и контактные разъёмы`;
      tasks.push({
        id: idx + 1,
        step_number: idx + 1,
        title: h.code ? `Проверка по коду ${h.code} (${h.systemRu})` : `Проверка: ${h.systemRu}`,
        instruction: fixText,
        text: fixText,
        torque_or_spec: h.system === "electrical" ? "12.4–14.5 В" : h.system === "cooling" ? "85–95 °C" : "См. мануал OEM",
        estimated_minutes: 15,
        safety_warning:
          h.system === "battery" || h.system === "hybrid"
            ? "Высокое напряжение ВВБ: используйте диэлектрические перчатки 1000В!"
            : h.system === "cooling"
              ? "Не открывайте крышку расширительного бачка на горячем ДВС!"
              : "",
        done: false
      });
    });
    if (tasks.length === 0) {
      tasks.push({
        id: 1,
        step_number: 1,
        title: "Считать коды ЭБУ и Freeze Frame",
        instruction: "Подключите сканер ELM327 или выполните визуальный осмотр разъёмов и предохранителей",
        text: "Считать коды ЭБУ и Freeze Frame",
        torque_or_spec: "OBD-II Mode 03",
        estimated_minutes: 10,
        safety_warning: "",
        done: false
      });
    }

    const inventoryItems: ChatInventoryItem[] = [
      { id: "inv-1", name: "OBD-II сканер ELM327", category: "tool", spec: "BLE / USB", checked: false },
      { id: "inv-2", name: "Цифровой мультиметр", category: "tool", spec: "True RMS", checked: false },
      { id: "inv-3", name: "Очиститель контактов", category: "consumable", spec: "Диэлектрик", checked: false }
    ];
    if (topHits.some(h => h.system === "engine")) {
      inventoryItems.push({ id: "inv-4", name: "Свечной ключ / компрессометр", category: "tool", spec: "16 мм / 14 мм", checked: false });
    }
    if (topHits.some(h => h.system === "brakes")) {
      inventoryItems.push({ id: "inv-5", name: "Тормозная жидкость DOT 4", category: "consumable", spec: "ISO 4925", checked: false });
    }

    const recommendations = [
      "Перед заменой деталей проверьте питание, массу и целостность проводки разъёмов.",
      "После устранения неисправности сбросьте коды DTC (Mode 04) и совершите контрольную поездку."
    ];

    const followupSuggestions = [
      "Какое давление/напряжение считать нормой при проверке на холодную?",
      "Какие ещё симптомы подтверждают эту неисправность?"
    ];

    return {
      summaryTitle,
      answer: lines.join("\n\n"),
      faults,
      tasks,
      inventoryItems,
      telemetryNotes: rag.telemetryNotes,
      recommendations,
      followupSuggestions
    };
  }
}

export const hybridRag = new HybridRagEngine();
