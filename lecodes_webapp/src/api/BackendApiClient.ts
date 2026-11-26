/**
 * API-клиент для взаимодействия с сервером Django ИИдеал-Авто.
 * 100% соответствие API оригинального веб-сайта:
 * - /api/ask/ (мультимодальная диагностика: текст + фото + голос + документы + DTC + OBD)
 * - /api/cancel/ (принудительная отмена активной генерации)
 * - /api/projects/ (CRUD проектов)
 * - /api/sessions/ (CRUD сессий, pin, tag, rename, vehicle_info, summary, сообщения)
 * - /api/worker-status/<id>/ (опрос фонового воркера выжимки контекста)
 * - /api/messages/delete/ и /api/messages/<id>/delete/
 * - /api/messages/<id>/toggle-task/ (переключение чекбоксов задач и инвентаря)
 * - /api/dtc/ и /api/dtc/<code>/ (справочник кодов ошибок с поиском и фильтром)
 * - /api/preview-document/ (быстрый разбор PDF/DOCX/XLSX/TXT/LOG для LLM)
 * - /api/transcode-audio/ (серверный WAV 16kHz транскодинг голоса)
 * - /api/settings/ (настройки, кросс-диалоговая память, глобальная память)
 * - /api/auth/ (регистрация, вход, статус, выход, удаление аккаунта с пробросом X-Session-Key)
 *
 * Лицензия: GPL-3.0
 */

import { cacheManager } from "../cache/ResourceCacheManager";
import { appState } from "../state/appState";
import {
  AuthResult,
  ChatFaultItem,
  ChatInventoryItem,
  ChatMessageItem,
  ChatRepairTask,
  DiagnosticSessionItem,
  DtcCodeInfo,
  DtcPageResult,
  DtcSystemCount,
  OBDLiveSensors,
  ParsedDocInfo,
  ProjectItem,
  StagedItem,
  SystemSettingsInfo
} from "../types";

export const DEFAULT_BACKEND_URL = "http://localhost:8000";

export interface AskExpertPayload {
  query: string;
  sessionId?: string;
  vehicleInfo?: string;
  dtcCodes?: string[];
  telemetry?: OBDLiveSensors;
  stagedItems?: StagedItem[];
  imagesB64?: string[];
  voiceB64?: string;
  voiceTranscript?: string;
  demoHistory?: { role: string; content: string; structured_data?: any; dtc_codes?: string[] }[];
  isCancelled?: () => boolean;
}

export interface AskExpertResponse {
  answer: string;
  sessionId: string;
  sessionTitle?: string;
  vehicleDetected?: string;
  messageId: string;
  userMessageId?: string;
  diagnosticType: "diagnosis" | "followup" | "visual_inspection" | "general";
  summaryTitle: string;
  faults: ChatFaultItem[];
  tasks: ChatRepairTask[];
  inventoryItems: ChatInventoryItem[];
  inventory: string[];
  telemetryNotes: string[];
  recommendations: string[];
  followupSuggestions: string[];
  dtcDetails: string[];
  userAttachments?: any[];
  assistantRawMessage?: any;
  workerPreempted?: boolean;
  workerVersion?: number;
  workerStatus?: string;
  isDemo?: boolean;
}

export interface SessionDetailResult {
  id: string;
  title: string;
  is_pinned: boolean;
  tag: string;
  project_id?: string | number | null;
  project_name?: string | null;
  vehicle_info: string;
  summary: string;
  worker_status: "idle" | "running" | "aborted_for_priority" | "completed" | "error";
  worker_version: number;
  worker_live?: { is_running: boolean; version: number };
  cross_dialog_memory_enabled: boolean;
  global_memory_summary: string;
  messages: ChatMessageItem[];
  is_demo?: boolean;
}

function normalizeStructuredMessage(rawMsg: any): ChatMessageItem {
  const sdata = rawMsg?.structured_data || {};
  const rawSteps = Array.isArray(sdata.repair_steps) ? sdata.repair_steps : Array.isArray(rawMsg?.tasks) ? rawMsg.tasks : [];
  const tasks: ChatRepairTask[] = rawSteps.map((s: any, idx: number) => {
    if (typeof s === "string") {
      return { id: idx + 1, step_number: idx + 1, title: s, text: s, done: false };
    }
    const stepNum = s.step_number !== undefined ? Number(s.step_number) : idx + 1;
    const title = (s.title || "").trim();
    const instruction = (s.instruction || s.description || "").trim();
    const text = title && instruction ? `${title}: ${instruction}` : title || instruction || s.text || String(s);
    return {
      id: stepNum,
      step_number: stepNum,
      title,
      instruction,
      text,
      torque_or_spec: s.torque_or_spec || "",
      estimated_minutes: s.estimated_minutes,
      safety_warning: s.safety_warning || "",
      done: Boolean(s.completed || s.done)
    };
  });

  const rawInv = Array.isArray(sdata.inventory) ? sdata.inventory : Array.isArray(rawMsg?.inventory) ? rawMsg.inventory : [];
  const inventoryItems: ChatInventoryItem[] = rawInv.map((inv: any, idx: number) => {
    if (typeof inv === "string") {
      return { id: String(idx + 1), name: inv, category: "tool", spec: "", checked: false };
    }
    return {
      id: String(inv.id ?? idx + 1),
      name: inv.name || inv.item || String(inv),
      category: inv.category || "tool",
      spec: inv.spec || "",
      checked: Boolean(inv.checked)
    };
  });
  const inventory = inventoryItems.map(i => i.name);

  const faults: ChatFaultItem[] = Array.isArray(sdata.faults)
    ? sdata.faults.map((f: any) => ({
        code: f.code || "",
        title: f.title || "",
        system_ru: f.system_ru || "",
        confidence: f.confidence || 90,
        root_cause: f.root_cause || f.description || f.symptom || "",
        description: f.title || f.root_cause || f.description || f.symptom || "",
        severity: f.severity || "warning",
        health_index: f.health_index ?? 75
      }))
    : [];

  const followups: string[] = [];
  if (typeof sdata.follow_up_question === "string" && sdata.follow_up_question.trim()) {
    followups.push(sdata.follow_up_question.trim());
  }
  if (Array.isArray(sdata.followup_suggestions)) {
    for (const q of sdata.followup_suggestions) {
      if (typeof q === "string" && q.trim() && !followups.includes(q.trim())) {
        followups.push(q.trim());
      }
    }
  }

  return {
    id: String(rawMsg?.id ?? Date.now()),
    role: rawMsg?.role || (rawMsg?.is_user ? "user" : "assistant"),
    content: sdata.mentor_reply || rawMsg?.content || rawMsg?.text || "",
    timestamp: rawMsg?.created_at || rawMsg?.timestamp || new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }),
    diagnosticType: (sdata.response_type || "diagnosis").toLowerCase(),
    summaryTitle: sdata.summary_title || "",
    faults,
    dtcCodes: Array.isArray(rawMsg?.dtc_codes) ? rawMsg.dtc_codes : faults.map(f => f.code).filter(Boolean),
    tasks,
    inventoryItems,
    inventory,
    telemetryNotes: Array.isArray(sdata.telemetry_notes) ? sdata.telemetry_notes : [],
    recommendations: Array.isArray(sdata.recommendations) ? sdata.recommendations : [],
    followupSuggestions: followups,
    rawAttachments: Array.isArray(rawMsg?.attachments) ? rawMsg.attachments : [],
    structuredData: sdata,
    vehicle: rawMsg?.vehicle_info || ""
  };
}

export class BackendApiClient {
  private baseUrl: string = "";
  private sessionKey: string = "";

  constructor() {
    this.sessionKey = cacheManager.getSetting<string>("auth_session_key", "");
    const saved = cacheManager.getSetting<string>("api_base_url", "");
    if (saved) {
      this.baseUrl = saved.replace(/\/+$/, "");
    } else if (typeof window !== "undefined" && window.location?.port === "8000") {
      this.baseUrl = "";
    } else {
      // По умолчанию localhost:8000 (работает через adb reverse tcp:8000 tcp:8000)
      this.baseUrl = DEFAULT_BACKEND_URL;
      cacheManager.saveSetting("api_base_url", this.baseUrl);
    }
  }

  public getBaseUrl(): string {
    return this.baseUrl;
  }

  public setBaseUrl(url: string): void {
    this.baseUrl = url.trim().replace(/\/+$/, "");
    cacheManager.saveSetting("api_base_url", this.baseUrl);
  }

  public getSessionKey(): string {
    return this.sessionKey;
  }

  public clearSessionKey(): void {
    this.setSessionKey("");
  }

  private setSessionKey(key?: string): void {
    this.sessionKey = (key || "").trim();
    cacheManager.saveSetting("auth_session_key", this.sessionKey);
  }

  private buildHeaders(extra?: Record<string, string>, omitContentType: boolean = false): Record<string, string> {
    const headers: Record<string, string> = {};
    if (extra) {
      for (const k of Object.keys(extra)) {
        if (omitContentType && k.toLowerCase() === "content-type") continue;
        headers[k] = extra[k];
      }
    }
    if (this.sessionKey) {
      headers["X-Session-Key"] = this.sessionKey;
    } else {
      headers["X-Demo-Mode"] = "1";
    }
    return headers;
  }

  private async safeParseJson(res: any): Promise<any> {
    if (!res) return {};
    try {
      if (typeof res.json === "function") {
        const val = await res.json();
        return val ?? {};
      }
    } catch (_) {}
    try {
      if (typeof res.text === "function") {
        const raw = await res.text();
        return raw ? JSON.parse(raw) : {};
      }
    } catch (_) {}
    return {};
  }

  private async safeReadText(res: any): Promise<string> {
    if (!res) return "";
    try {
      if (typeof res.text === "function") {
        return String((await res.text()) || "");
      }
    } catch (_) {}
    return "";
  }

  private normalizeResponse(res: any): any {
    if (res && typeof res.status === "number") {
      if (res.ok === undefined) {
        (res as any).ok = res.status >= 200 && res.status < 300;
      }
    }
    return res;
  }

  private updateOnlineState(online: boolean, reason: string = ""): void {
    appState.isOnlineSignal.value = online;
    appState.offlineReasonSignal.value = online ? "" : reason;
  }

  private hasBrowserNetwork(): boolean {
    try {
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        return false;
      }
    } catch (_) {}
    return true;
  }

  /**
   * Быстрая проверка доступности интернета и API-сервера для индикатора оффлайна
   */
  public async checkConnectivity(): Promise<boolean> {
    if (!this.hasBrowserNetwork()) {
      this.updateOnlineState(false, "Нет подключения к интернету (Wi-Fi / мобильная сеть отключены)");
      return false;
    }
    const res = await this.testConnection();
    this.updateOnlineState(res.ok, res.ok ? "" : res.message);
    return res.ok;
  }

  /**
   * Тестирование связи с сервером стенда (Ping & Health Check)
   */
  public async testConnection(targetUrl?: string): Promise<{ ok: boolean; status: number; latencyMs: number; message: string }> {
    const url = (targetUrl !== undefined ? targetUrl : this.baseUrl).trim().replace(/\/+$/, "");
    if (!this.hasBrowserNetwork()) {
      this.updateOnlineState(false, "Нет подключения к интернету");
      return { ok: false, status: 0, latencyMs: 0, message: "Нет подключения к интернету" };
    }
    const start = typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
    try {
      const res = this.normalizeResponse(
        await fetch(`${url}/api/settings/`, {
          method: "GET",
          headers: this.buildHeaders(),
          cache: "no-store",
          timeout: 6000
        } as any)
      );
      const now = typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
      const latencyMs = Math.round(now - start);
      const status = res.status || 0;
      const isOk = res.ok === true || (status >= 200 && status < 300);
      if (isOk) {
        this.updateOnlineState(true);
        return { ok: true, status, latencyMs, message: `Связь установлена (HTTP ${status}) за ${latencyMs} мс` };
      }
      const isGatewayDown = status === 0 || status === 502 || status === 503 || status === 504;
      if (isGatewayDown) {
        this.updateOnlineState(false, `Сервер временно недоступен (HTTP ${status})`);
      } else {
        this.updateOnlineState(true);
      }
      return { ok: false, status, latencyMs, message: `Сервер ответил ошибкой HTTP ${status}` };
    } catch (err: any) {
      const now = typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
      const latencyMs = Math.round(now - start);
      const msg = `${err?.message || "Сервер недоступен"}`;
      this.updateOnlineState(false, msg);
      return { ok: false, status: 0, latencyMs, message: msg };
    }
  }

  // =========================================================================
  // 1. Проекты (/api/projects/)
  // =========================================================================

  public async getProjects(): Promise<ProjectItem[]> {
    try {
      const res = await this.fetchJson("/api/projects/");
      if (res.ok) {
        const data = await this.safeParseJson(res);
        return data.projects || [];
      }
    } catch (err) {
      console.warn("Ошибка загрузки проектов:", err);
    }
    return [];
  }

  public async createProject(name: string, description?: string): Promise<ProjectItem | null> {
    try {
      const res = await this.fetchJson("/api/projects/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description: description || "" })
      });
      if (res.ok) {
        return await this.safeParseJson(res);
      }
    } catch (err) {
      console.error("Ошибка создания проекта:", err);
    }
    return null;
  }

  public async renameProject(projectId: string | number, name: string): Promise<boolean> {
    try {
      const res = await this.fetchJson(`/api/projects/${projectId}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
      });
      return !!res.ok;
    } catch (_) {
      return false;
    }
  }

  public async deleteProject(projectId: string | number): Promise<boolean> {
    try {
      const res = await this.fetchJson(`/api/projects/${projectId}/`, { method: "DELETE" });
      return !!res.ok;
    } catch (_) {
      return false;
    }
  }

  // =========================================================================
  // 2. Сессии диагностики (/api/sessions/)
  // =========================================================================

  public async getSessions(projectId?: string | number, tag?: string, query?: string): Promise<DiagnosticSessionItem[]> {
    try {
      const params: string[] = [];
      if (projectId) params.push(`project_id=${encodeURIComponent(String(projectId))}`);
      if (tag) params.push(`tag=${encodeURIComponent(tag)}`);
      if (query) params.push(`q=${encodeURIComponent(query)}`);
      const qStr = params.length ? "?" + params.join("&") : "";

      const res = await this.fetchJson(`/api/sessions/${qStr}`);
      if (res.ok) {
        const data = await this.safeParseJson(res);
        const list: DiagnosticSessionItem[] = (data.sessions || []).map((s: any) => ({
          id: String(s.id),
          title: s.title || `Диалог #${s.id}`,
          project_id: s.project_id,
          project_name: s.project_name || null,
          tag: s.tag || "",
          is_pinned: Boolean(s.is_pinned),
          vehicle_info: s.vehicle_info || "",
          summary: s.summary || "",
          worker_status: s.worker_status || "idle",
          created_at: s.created_at || "",
          updated_at: s.updated_at || "",
          message_count: s.message_count ?? (Array.isArray(s.messages) ? s.messages.length : 0)
        }));
        cacheManager.cacheSessions(list);
        return list;
      }
    } catch (err) {
      console.warn("Ошибка загрузки сессий с бэкенда:", err);
    }
    return cacheManager.getCachedSessions();
  }

  public async createSession(
    projectId?: string | number | null,
    title?: string,
    vehicleInfo?: string
  ): Promise<DiagnosticSessionItem | null> {
    try {
      const body: any = {};
      if (projectId !== undefined && projectId !== null && projectId !== "") body.project_id = projectId;
      if (title) body.title = title;
      if (vehicleInfo) body.vehicle_info = vehicleInfo;

      const res = await this.fetchJson("/api/sessions/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (res.ok) {
        const data = await this.safeParseJson(res);
        return {
          id: String(data.id),
          title: data.title || "Новый диалог",
          project_id: data.project_id ?? null,
          project_name: data.project_name ?? null,
          tag: data.tag || "",
          is_pinned: Boolean(data.is_pinned),
          vehicle_info: data.vehicle_info || "",
          summary: data.summary || "",
          worker_status: data.worker_status || "idle",
          created_at: data.created_at || new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }),
          updated_at: data.updated_at || new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }),
          message_count: data.message_count || 0
        };
      }
    } catch (err) {
      console.error("Ошибка создания сессии:", err);
    }
    return null;
  }

  public async getSessionDetail(sessionId: string): Promise<SessionDetailResult | null> {
    try {
      const res = await this.fetchJson(`/api/sessions/${sessionId}/`);
      if (res.ok) {
        const data = await this.safeParseJson(res);
        const msgs = Array.isArray(data.messages) ? data.messages.map((m: any) => normalizeStructuredMessage(m)) : [];
        return {
          id: String(data.id || sessionId),
          title: data.title || "Диалог",
          is_pinned: Boolean(data.is_pinned),
          tag: data.tag || "",
          project_id: data.project_id ?? null,
          project_name: data.project_name ?? null,
          vehicle_info: data.vehicle_info || "",
          summary: data.summary || "",
          worker_status: data.worker_live?.is_running ? "running" : data.worker_status || "idle",
          worker_version: data.worker_version || 0,
          worker_live: data.worker_live,
          cross_dialog_memory_enabled: Boolean(data.cross_dialog_memory_enabled ?? true),
          global_memory_summary: data.global_memory_summary || "",
          messages: msgs,
          is_demo: Boolean(data.is_demo)
        };
      }
    } catch (err) {
      console.warn("Ошибка загрузки деталей сессии:", err);
    }
    return null;
  }

  public async renameSession(sessionId: string, title: string): Promise<boolean> {
    try {
      const res = await this.fetchJson(`/api/sessions/${sessionId}/rename/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title })
      });
      return !!res.ok;
    } catch (_) {
      return false;
    }
  }

  public async setSessionTag(sessionId: string, tag: string): Promise<boolean> {
    try {
      const res = await this.fetchJson(`/api/sessions/${sessionId}/tag/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag })
      });
      return !!res.ok;
    } catch (_) {
      return false;
    }
  }

  public async setSessionPinned(sessionId: string, _is_pinned?: boolean): Promise<boolean> {
    try {
      const res = await this.fetchJson(`/api/sessions/${sessionId}/pin/`, { method: "POST" });
      return !!res.ok;
    } catch (_) {
      return false;
    }
  }

  public async setSessionVehicle(sessionId: string, vehicle_info: string): Promise<boolean> {
    if (!sessionId) return false;
    try {
      const res = await this.fetchJson(`/api/sessions/${sessionId}/`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vehicle_info })
      });
      return !!res.ok;
    } catch (_) {
      return false;
    }
  }

  public async setSessionSummary(sessionId: string, summary: string): Promise<boolean> {
    if (!sessionId) return false;
    try {
      const res = await this.fetchJson(`/api/sessions/${sessionId}/`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summary })
      });
      return !!res.ok;
    } catch (_) {
      return false;
    }
  }

  public async deleteSession(sessionId: string): Promise<{ deleted: boolean; active_session_id?: string }> {
    try {
      const res = await this.fetchJson(`/api/sessions/${sessionId}/`, { method: "DELETE" });
      if (res.ok) {
        const data = await this.safeParseJson(res);
        return { deleted: true, active_session_id: data.active_session_id };
      }
    } catch (_) {}
    return { deleted: false };
  }

  public async getWorkerStatus(sessionId: string): Promise<any | null> {
    if (!sessionId) return null;
    try {
      const res = await this.fetchJson(`/api/worker-status/${sessionId}/`, { timeout: 6000 });
      if (res.ok) {
        return await this.safeParseJson(res);
      }
    } catch (_) {}
    return null;
  }

  // =========================================================================
  // 3. Сообщения, удаление, задачи и отмена генерации
  // =========================================================================

  public async getSessionMessages(sessionId: string): Promise<ChatMessageItem[]> {
    const detail = await this.getSessionDetail(sessionId);
    return detail ? detail.messages : [];
  }

  public async deleteSingleMessage(messageId: string): Promise<{ ok: boolean; session_summary?: string }> {
    try {
      const res = await this.fetchJson(`/api/messages/${messageId}/delete/`, { method: "POST" });
      if (res.ok) {
        const data = await this.safeParseJson(res);
        return { ok: true, session_summary: data.session_summary };
      }
    } catch (_) {}
    return { ok: false };
  }

  public async deleteMessages(
    sessionId: string,
    messageIds: (string | number)[],
    deleteAll: boolean = false
  ): Promise<{ ok: boolean; session_summary?: string }> {
    try {
      const res = await this.fetchJson("/api/messages/delete/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          message_ids: messageIds,
          delete_all: deleteAll
        })
      });
      if (res.ok) {
        const data = await this.safeParseJson(res);
        return { ok: true, session_summary: data.session_summary };
      }
    } catch (_) {}
    return { ok: false };
  }

  public async toggleTask(
    messageId: string | number,
    checkId: string | number,
    checked: boolean = true,
    itemType: "step" | "inventory" = "step"
  ): Promise<{ ok: boolean; progress?: any }> {
    try {
      const res = await this.fetchJson(`/api/messages/${messageId}/toggle-task/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: itemType,
          id: checkId,
          checked
        })
      });
      if (res.ok) {
        const data = await this.safeParseJson(res);
        return { ok: true, progress: data.progress };
      }
    } catch (_) {}
    return { ok: false };
  }

  public async cancelGeneration(sessionId?: string): Promise<boolean> {
    try {
      const res = await this.fetchJson("/api/cancel/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId || "" }),
        timeout: 8000
      });
      return !!res.ok;
    } catch (_) {
      return false;
    }
  }

  // =========================================================================
  // 4. Предпросмотр документов & Транскодинг аудио
  // =========================================================================

  public async previewDocument(file: any): Promise<ParsedDocInfo | null> {
    if (!file || typeof FormData === "undefined") return null;
    try {
      const fd = new FormData();
      fd.append("file", file, file.name || "document.txt");
      const res = this.normalizeResponse(
        await fetch(`${this.baseUrl}/api/preview-document/`, {
          method: "POST",
          headers: this.buildHeaders(undefined, true),
          body: fd as any,
          cache: "no-store",
          timeout: 30000
        } as any)
      );
      if (res.ok) {
        return await this.safeParseJson(res);
      }
    } catch (err) {
      console.warn("Ошибка предпросмотра документа:", err);
    }
    return null;
  }

  public async transcodeAudio(fileOrB64: any, filename: string = "voice_input.m4a"): Promise<{
    ok: boolean;
    duration?: number;
    wav_data_url?: string;
    transcript?: string;
  } | null> {
    try {
      if (fileOrB64 && typeof fileOrB64 === "object" && ("_id" in fileOrB64 || "_h" in fileOrB64) && typeof FormData !== "undefined") {
        const fd = new FormData();
        fd.append("file", fileOrB64, filename);
        const res = this.normalizeResponse(
          await fetch(`${this.baseUrl}/api/transcode-audio/`, {
            method: "POST",
            headers: this.buildHeaders(undefined, true),
            body: fd as any,
            cache: "no-store",
            timeout: 30000
          } as any)
        );
        if (res.ok) return await this.safeParseJson(res);
      } else if (typeof fileOrB64 === "string" && fileOrB64) {
        const res = await this.fetchJson("/api/transcode-audio/", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ audio_b64: fileOrB64, filename }),
          timeout: 30000
        });
        if (res.ok) return await this.safeParseJson(res);
      }
    } catch (err) {
      console.warn("Ошибка транскодинга аудио:", err);
    }
    return null;
  }

  // =========================================================================
  // 5. Экспертная диагностика (/api/ask/)
  // =========================================================================

  public async askExpert(payload: AskExpertPayload): Promise<AskExpertResponse> {
    const dtcList: string[] = [...(payload.dtcCodes || [])];
    const images: string[] = [...(payload.imagesB64 || [])];
    const nativeFiles: { file: any; name?: string }[] = [];
    let voiceB64: string | undefined = payload.voiceB64;
    let voiceTranscript = payload.voiceTranscript || "";
    let obdNote = "";

    if (payload.stagedItems && payload.stagedItems.length > 0) {
      for (const item of payload.stagedItems) {
        if (item.type === "dtc" && item.data && !dtcList.includes(item.data)) {
          dtcList.push(String(item.data).toUpperCase());
        } else if (item.type === "obd" && item.data) {
          const s = item.data;
          obdNote = `[OBD-II телеметрия: ${s.rpm ?? 0} об/мин, скорость ${s.speed ?? 0} км/ч, ОЖ ${s.coolantTemp ?? 0}°C, дроссель ${s.throttle ?? 0}%, нагрузка ${s.engineLoad ?? 0}%, АКБ ${(s.voltage ?? 12.6).toFixed(1)}В${s.vin ? `, VIN ${s.vin}` : ""}]`;
        } else if (item.file && typeof item.file === "object" && ("_id" in item.file || "_h" in item.file)) {
          if (item.type === "audio" && item.transcript && !voiceTranscript) {
            voiceTranscript = item.transcript;
          }
          const fallbackExtName =
            item.type === "audio"
              ? "voice_input.m4a"
              : item.type === "photo"
                ? "node_photo.jpg"
                : item.parsedDoc?.filename || "attachment.bin";
          nativeFiles.push({
            file: item.file,
            name: item.file.name || fallbackExtName
          });
        } else if (item.type === "photo" && typeof item.data === "string" && item.data) {
          images.push(item.data);
        } else if (item.type === "audio") {
          if (item.transcript && !voiceTranscript) voiceTranscript = item.transcript;
          if (typeof item.data === "string" && item.data) voiceB64 = item.data;
        }
      }
    }

    let queryText = (payload.query || "").trim();
    if (obdNote && !queryText.includes("OBD-II телеметрия")) {
      queryText = queryText ? `${queryText}\n${obdNote}` : `Проведи диагностику по показателям: ${obdNote}`;
    }

    let res: any;
    const shortTimeout = 20000;

    if (nativeFiles.length > 0 && typeof FormData !== "undefined") {
      // Отправляем реальный multipart/form-data в асинхронную очередь (без таймаута сокета OkHttp)
      const fd = new FormData();
      if (payload.sessionId) fd.append("session_id", String(payload.sessionId));
      fd.append("query", queryText);
      fd.append("vehicle_info", payload.vehicleInfo || "");
      fd.append("dtc_codes", JSON.stringify(dtcList));
      if (voiceTranscript) fd.append("voice_transcript", voiceTranscript);
      if (voiceB64) fd.append("voice_b64", voiceB64);
      if (payload.demoHistory && payload.demoHistory.length > 0) {
        fd.append("demo_history", JSON.stringify(payload.demoHistory));
      }
      for (const b64 of images) {
        fd.append("camera_image_b64", b64);
      }
      for (const nf of nativeFiles) {
        fd.append("attachments", nf.file, nf.file.name || nf.name || "attachment.bin");
      }

      try {
        res = this.normalizeResponse(
          await fetch(`${this.baseUrl}/api/ask/?async=1`, {
            method: "POST",
            headers: this.buildHeaders(undefined, true),
            body: fd as any,
            cache: "no-store",
            timeout: shortTimeout
          } as any)
        );
        if (res.status > 0 && res.status !== 502 && res.status !== 503 && res.status !== 504) {
          this.updateOnlineState(true);
        } else {
          this.updateOnlineState(false, `Сервер недоступен (HTTP ${res.status})`);
        }
      } catch (netErr: any) {
        this.updateOnlineState(false, netErr?.message || "Нет подключения к интернету или серверу");
        throw netErr;
      }
    } else {
      const bodyObj: any = {
        query: queryText,
        session_id: payload.sessionId,
        vehicle_info: payload.vehicleInfo || "",
        dtc_codes: dtcList,
        images_b64: images,
        voice_b64: voiceB64 || "",
        voice_transcript: voiceTranscript,
        demo_history: payload.demoHistory || [],
        telemetry: payload.telemetry
          ? {
              rpm: payload.telemetry.rpm,
              speed: payload.telemetry.speed,
              coolant_temp: payload.telemetry.coolantTemp,
              throttle: payload.telemetry.throttle,
              battery_voltage: payload.telemetry.voltage
            }
          : undefined
      };

      res = await this.fetchJson("/api/ask/?async=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyObj),
        timeout: shortTimeout
      });
    }

    if (!res.ok) {
      const errData = await this.safeParseJson(res);
      const errRaw = errData?.error || (await this.safeReadText(res));
      throw new Error(errRaw || `Ошибка сервера (HTTP ${res.status})`);
    }

    let data = await this.safeParseJson(res);

    // Если сервер принял задание в фоновую обработку (HTTP 202 + job_id) — опрашиваем до готовности
    if (data && data.job_id && data.status === "running") {
      const jobId = String(data.job_id);
      const deadline = Date.now() + 900000;
      let finishedResult: any = null;
      while (Date.now() < deadline) {
        if (payload.isCancelled?.()) {
          throw new Error("Отменено пользователем");
        }
        await new Promise(r => setTimeout(r, 1500));
        if (payload.isCancelled?.()) {
          throw new Error("Отменено пользователем");
        }
        const pollRes = await this.fetchJson(`/api/ask/job/${jobId}/`, {
          method: "GET",
          timeout: 12000
        });
        if (!pollRes.ok) {
          if (pollRes.status === 404) {
            throw new Error("Задание генерации не найдено на сервере");
          }
          continue;
        }
        const jobData = await this.safeParseJson(pollRes);
        if (jobData.status === "done" && jobData.result) {
          finishedResult = jobData.result;
          break;
        }
        if (jobData.status === "error") {
          throw new Error(jobData.error || jobData.result?.error || "Ошибка генерации ответа ИИ");
        }
      }
      if (!finishedResult) {
        throw new Error("Превышено время ожидания ответа модели");
      }
      data = finishedResult;
    }
    // Django возвращает { session_id, session_title, vehicle_info, worker_preempted, user_message, assistant_message }
    const assistantRaw = data.assistant_message || data;
    const normalized = normalizeStructuredMessage(assistantRaw);

    return {
      answer: normalized.content,
      sessionId: String(data.session_id || payload.sessionId || ""),
      sessionTitle: data.session_title,
      vehicleDetected: data.vehicle_info,
      messageId: String(assistantRaw.id || data.message_id || Date.now()),
      userMessageId: data.user_message?.id ? String(data.user_message.id) : undefined,
      diagnosticType: normalized.diagnosticType || "diagnosis",
      summaryTitle: normalized.summaryTitle || "Экспертное заключение",
      faults: normalized.faults || [],
      tasks: normalized.tasks || [],
      inventoryItems: normalized.inventoryItems || [],
      inventory: normalized.inventory || [],
      telemetryNotes: normalized.telemetryNotes || [],
      recommendations: normalized.recommendations || [],
      followupSuggestions: normalized.followupSuggestions || [],
      dtcDetails: normalized.dtcCodes || [],
      userAttachments: data.user_message?.attachments || [],
      assistantRawMessage: assistantRaw,
      workerPreempted: Boolean(data.worker_preempted),
      workerVersion: data.worker_version,
      workerStatus: data.worker_status,
      isDemo: Boolean(data.is_demo)
    };
  }

  // =========================================================================
  // 6. Словарь кодов DTC (/api/dtc/)
  // =========================================================================

  private mapDtcItem(item: any): DtcCodeInfo {
    const code = (item.code || item.dtc || "").toUpperCase();
    let sys: any = item.system || (code ? code[0] : "P");
    if (typeof sys === "string") {
      const sLower = sys.toLowerCase();
      if (sLower.includes("power") || sLower.includes("engine") || sLower.includes("trans") || sLower === "p") sys = "P";
      else if (sLower.includes("chassis") || sLower.includes("brake") || sLower.includes("abs") || sLower.includes("susp") || sLower === "c") sys = "C";
      else if (sLower.includes("body") || sLower === "b") sys = "B";
      else if (sLower.includes("net") || sLower.includes("can") || sLower === "u") sys = "U";
      else sys = ["P", "C", "B", "U"].includes(code[0]) ? code[0] : "other";
    }
    const title = item.title || (item.system_ru ? `${item.system_ru}` : item.symptom || code);
    const desc = item.description || item.symptom || item.system_description || "";
    const causes = Array.isArray(item.causes)
      ? item.causes
      : item.solution
      ? [item.solution]
      : item.cause
      ? [item.cause]
      : Array.isArray(item.solutions)
      ? item.solutions
      : [];
    const symptoms = Array.isArray(item.symptoms) ? item.symptoms : item.symptom ? [item.symptom] : [];

    return {
      code,
      title,
      description: desc,
      system: sys,
      severity: item.severity || (item.health_index && item.health_index < 65 ? "critical" : "warning"),
      health_index: item.health_index,
      has_telemetry: Boolean(item.has_telemetry),
      symptoms,
      causes,
      en_title: typeof item.en_title === "string" ? item.en_title : undefined,
      solution: typeof item.solution === "string" ? item.solution : undefined,
      system_ru: typeof item.system_ru === "string" ? item.system_ru : undefined,
      lang: typeof item.lang === "string" ? item.lang : undefined,
      oem_variants: item.oem_variants,
      nhtsa_stats: item.nhtsa_stats
    };
  }

  public async syncDtcDictionary(): Promise<number> {
    const collected: DtcCodeInfo[] = [];
    const seen = new Set<string>();
    const pageSize = 500;
    const maxItems = 1000;

    for (let offset = 0; offset < maxItems; offset += pageSize) {
      const res = await this.fetchJson(`/api/dtc/?limit=${pageSize}&offset=${offset}`, { timeout: 15000 });
      if (!res.ok) {
        if (offset === 0) {
          throw new Error(`HTTP ${res.status}`);
        }
        break;
      }
      const data = await this.safeParseJson(res);
      const rawList = data.items || data.codes || (Array.isArray(data) ? data : []);
      if (!Array.isArray(rawList) || rawList.length === 0) break;

      for (const raw of rawList) {
        const mapped = this.mapDtcItem(raw);
        if (mapped.code && !seen.has(mapped.code)) {
          seen.add(mapped.code);
          collected.push(mapped);
        }
      }
      const total = typeof data.total === "number" ? data.total : collected.length;
      if (rawList.length < pageSize || offset + rawList.length >= total || collected.length >= maxItems) {
        break;
      }
    }

    if (collected.length > 0) {
      await cacheManager.cacheDtcDictionary(collected);
    }
    return collected.length;
  }

  public async getDtcPage(
    query: string = "",
    system: string = "all",
    offset: number = 0,
    limit: number = 80
  ): Promise<DtcPageResult> {
    const cleanQ = (query || "").trim();
    const sysParam = !system || system === "ALL" ? "all" : system;
    const safeOffset = Math.max(0, Math.floor(offset));
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    try {
      const params: string[] = [
        `limit=${safeLimit}`,
        `offset=${safeOffset}`,
        `system=${encodeURIComponent(sysParam)}`
      ];
      if (cleanQ) params.push(`q=${encodeURIComponent(cleanQ)}`);

      const res = await this.fetchJson(`/api/dtc/?${params.join("&")}`, { timeout: 10000 });
      if (res.ok) {
        const data = await this.safeParseJson(res);
        const rawList = data.items || data.codes || (Array.isArray(data) ? data : []);
        const items: DtcCodeInfo[] = rawList.map((item: any) => this.mapDtcItem(item));
        const total = typeof data.total === "number" ? data.total : items.length;
        const totalCatalog = typeof data.total_catalog === "number" ? data.total_catalog : total;
        const systems: DtcSystemCount[] = Array.isArray(data.systems) ? data.systems : [];
        return { items, total, totalCatalog, systems };
      }
    } catch (_) {}

    const localPage = cacheManager.searchDtcPage(cleanQ, sysParam, safeOffset, safeLimit);
    return {
      items: localPage.items,
      total: localPage.total,
      totalCatalog: cacheManager.getStats().dtcCount,
      systems: []
    };
  }

  public async getDtcList(query?: string, system?: string): Promise<DtcCodeInfo[]> {
    const page = await this.getDtcPage(query || "", system || "all", 0, 120);
    return page.items;
  }

  // =========================================================================
  // 7. Настройки и междиалоговая память (/api/settings/)
  // =========================================================================

  public async getSettings(): Promise<SystemSettingsInfo> {
    try {
      const res = await this.fetchJson("/api/settings/", { timeout: 8000 });
      if (res.ok) {
        return await this.safeParseJson(res);
      }
    } catch (_) {}
    return {
      cross_dialog_memory_enabled: true,
      global_memory_summary: "",
      vulkan_available: false,
      model_name: "Google Gemma 4 (AirLLM)"
    };
  }

  public async saveSettings(settings: Partial<SystemSettingsInfo>): Promise<boolean> {
    if (!this.sessionKey) {
      return false;
    }
    try {
      const res = await this.fetchJson("/api/settings/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings)
      });
      return !!res.ok;
    } catch (_) {
      return false;
    }
  }

  public async clearGlobalMemory(): Promise<boolean> {
    if (!this.sessionKey) {
      return true;
    }
    try {
      const res = await this.fetchJson("/api/settings/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          global_memory_summary: "",
          clear_global_memory: true
        })
      });
      return !!res.ok;
    } catch (_) {
      return false;
    }
  }

  // =========================================================================
  // 8. Авторизация и Учетные записи (/api/auth/)
  // =========================================================================

  public async getAuthStatus(): Promise<AuthResult> {
    try {
      const res = await this.fetchJson("/api/auth/status/", { method: "GET", timeout: 8000 });
      if (!res.ok) {
        return { success: false, is_authenticated: false };
      }
      const data = await this.safeParseJson(res);
      return {
        success: true,
        is_authenticated: !!data.is_authenticated,
        username: data.username || "",
        email: data.email || "",
        user: { username: data.username || "", email: data.email || "", is_staff: !!data.is_staff }
      };
    } catch (_) {
      return { success: false, is_authenticated: false };
    }
  }

  public async login(username: string, password: string): Promise<AuthResult> {
    try {
      const res = await this.fetchJson("/api/auth/login/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
        timeout: 15000
      });
      const data = await this.safeParseJson(res);
      if (!res.ok) {
        return { success: false, is_authenticated: false, error: data.error || "Ошибка авторизации" };
      }
      if (data.session_key) {
        this.setSessionKey(data.session_key);
      }
      return {
        success: true,
        is_authenticated: true,
        username: data.username || username,
        email: data.email || "",
        session_key: data.session_key,
        user: data.user
      };
    } catch (err: any) {
      return { success: false, is_authenticated: false, error: `Нет связи с сервером: ${err?.message || err}` };
    }
  }

  public async register(username: string, password: string, email?: string): Promise<AuthResult> {
    try {
      const payload: Record<string, string> = { username, password };
      if (email && email.trim()) payload.email = email.trim();
      const res = await this.fetchJson("/api/auth/register/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        timeout: 20000
      });
      const data = await this.safeParseJson(res);
      if (!res.ok) {
        return { success: false, is_authenticated: false, error: data.error || `Ошибка регистрации (HTTP ${res.status})` };
      }
      if (data.session_key) {
        this.setSessionKey(data.session_key);
      }
      return {
        success: true,
        is_authenticated: true,
        username: data.username || username,
        email: data.email || email || "",
        session_key: data.session_key,
        user: data.user
      };
    } catch (err: any) {
      return { success: false, is_authenticated: false, error: `Нет связи с сервером: ${err?.message || err}` };
    }
  }

  public async logout(): Promise<AuthResult> {
    try {
      await this.fetchJson("/api/auth/logout/", { method: "POST", timeout: 10000 });
    } catch (_) {}
    this.setSessionKey("");
    return { success: true, is_authenticated: false };
  }

  public async deleteAccount(): Promise<AuthResult> {
    try {
      const res = await this.fetchJson("/api/auth/delete-account/", { method: "POST", timeout: 15000 });
      const data = await this.safeParseJson(res);
      if (!res.ok) {
        return { success: false, is_authenticated: true, error: data.error || "Ошибка удаления аккаунта" };
      }
      this.setSessionKey("");
      return { success: true, is_authenticated: false };
    } catch (err: any) {
      return { success: false, is_authenticated: true, error: `Ошибка: ${err?.message || err}` };
    }
  }

  private async fetchJson(path: string, init?: any): Promise<any> {
    if (!this.hasBrowserNetwork()) {
      this.updateOnlineState(false, "Нет подключения к интернету");
      throw new Error("Нет подключения к интернету");
    }
    const url = `${this.baseUrl}${path}`;
    const timeoutMs = init?.timeout || 120000;
    const { headers: rawHeaders, ...rest } = init || {};

    try {
      // Нативный fetch в le.codes SDK принимает поле `timeout` (мс) и `cache` напрямую!
      const rawRes = await fetch(url, {
        ...rest,
        headers: this.buildHeaders(rawHeaders),
        cache: init?.cache ?? "no-store",
        timeout: timeoutMs
      } as any);
      const res = this.normalizeResponse(rawRes);
      if (res && typeof res.status === "number") {
        if (res.status === 0 || res.status === 502 || res.status === 503 || res.status === 504) {
          this.updateOnlineState(false, `Сервер временно недоступен (HTTP ${res.status})`);
        } else {
          this.updateOnlineState(true);
        }
      }
      return res;
    } catch (err: any) {
      this.updateOnlineState(false, err?.message || "Нет подключения к интернету или серверу");
      throw err;
    }
  }
}

export const apiClient = new BackendApiClient();
