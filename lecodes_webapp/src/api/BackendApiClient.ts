/**
 * API-клиент для взаимодействия с сервером Django ИИдеал-Авто.
 * 100% соответствие API оригинального веб-сайта:
 * - /api/ask/ (мультимодальная диагностика: текст + фото + голос + DTC + OBD)
 * - /api/projects/ (CRUD проектов)
 * - /api/sessions/ (CRUD сессий, тегирование, закрепление, vehicle_info, сжатие контекста)
 * - /api/messages/delete/ (одиночное и массовое удаление, очистка диалога)
 * - /api/messages/<id>/toggle-task/ (переключение чекбоксов задач ремонта)
 * - /api/dtc/ (справочник кодов ошибок с поиском и фильтром)
 * - /api/settings/ (настройки, кросс-диалоговая память, глобальная память)
 *
 * Лицензия: GPL-3.0
 */

import { cacheManager } from "../cache/ResourceCacheManager";
import {
  AuthResult,
  AuthUser,
  ChatMessageItem,
  DiagnosticSessionItem,
  DtcCodeInfo,
  OBDLiveSensors,
  ProjectItem,
  StagedItem,
  SystemSettingsInfo
} from "../types";

export interface AskExpertPayload {
  query: string;
  sessionId?: string;
  vehicleInfo?: string;
  dtcCodes?: string[];
  telemetry?: OBDLiveSensors;
  stagedItems?: StagedItem[];
  imagesB64?: string[];
  voiceB64?: string;
}

export interface AskExpertResponse {
  answer: string;
  sessionId: string;
  messageId?: string;
  diagnosticType?: "diagnosis" | "followup" | "visual_inspection" | "general";
  summaryTitle?: string;
  faults?: any[];
  tasks: { text: string; done: boolean }[];
  inventory: string[];
  recommendations?: string[];
  followupSuggestions?: string[];
  dtcDetails: any[];
  sessionSummary?: string;
}

export class BackendApiClient {
  private baseUrl: string = "";

  constructor() {
    this.baseUrl = cacheManager.getSetting("api_base_url", "");
    if (!this.baseUrl && typeof window !== "undefined") {
      if (window.location && window.location.port === "8000") {
        this.baseUrl = "";
      } else {
        // По умолчанию для мобильного клиента на Android эмуляторе 10.0.2.2:8000
        this.baseUrl = "http://10.0.2.2:8000";
      }
    }
  }

  public getBaseUrl(): string {
    return this.baseUrl;
  }

  public setBaseUrl(url: string): void {
    this.baseUrl = url.replace(/\/+$/, "");
    cacheManager.saveSetting("api_base_url", this.baseUrl);
  }

  /**
   * Тестирование связи с сервером стенда (Ping & Health Check)
   */
  public async testConnection(targetUrl?: string): Promise<{ ok: boolean; status: number; latencyMs: number; message: string }> {
    const url = targetUrl !== undefined ? targetUrl.replace(/\/+$/, "") : this.baseUrl;
    const start = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    try {
      const res = await fetch(`${url}/api/settings/`, { method: "GET" });
      const now = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
      const latencyMs = Math.round(now - start);
      if (res.ok) {
        return { ok: true, status: res.status, latencyMs, message: `[OK] Связь установлена (HTTP ${res.status}) за ${latencyMs} мс` };
      }
      return { ok: false, status: res.status, latencyMs, message: `Сервер ответил ошибкой HTTP ${res.status}` };
    } catch (err: any) {
      const now = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
      const latencyMs = Math.round(now - start);
      return { ok: false, status: 0, latencyMs, message: `Ошибка: ${err.message || "Сервер недоступен"}` };
    }
  }

  // =========================================================================
  // 1. Проекты (/api/projects/)
  // =========================================================================

  public async getProjects(): Promise<ProjectItem[]> {
    try {
      const res = await this.fetchJson("/api/projects/");
      if (res.ok) {
        const data = await res.json();
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
        return await res.json();
      }
    } catch (err) {
      console.error("Ошибка создания проекта:", err);
    }
    return null;
  }

  public async renameProject(projectId: string | number, name: string): Promise<boolean> {
    try {
      const res = await this.fetchJson(`/api/projects/${projectId}/`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
      });
      return res.ok;
    } catch (_) {
      return false;
    }
  }

  public async deleteProject(projectId: string | number): Promise<boolean> {
    try {
      const res = await this.fetchJson(`/api/projects/${projectId}/`, { method: "DELETE" });
      return res.ok;
    } catch (_) {
      return false;
    }
  }

  // =========================================================================
  // 2. Сессии диагностики (/api/sessions/)
  // =========================================================================

  public async getSessions(projectId?: string | number, tag?: string): Promise<DiagnosticSessionItem[]> {
    try {
      let query = "";
      const params: string[] = [];
      if (projectId) params.push(`project_id=${projectId}`);
      if (tag) params.push(`tag=${encodeURIComponent(tag)}`);
      if (params.length) query = "?" + params.join("&");

      const res = await this.fetchJson(`/api/sessions/${query}`);
      if (res.ok) {
        const data = await res.json();
        const list: DiagnosticSessionItem[] = (data.sessions || []).map((s: any) => ({
          id: String(s.id),
          title: s.title || `Диалог #${s.id}`,
          project_id: s.project_id,
          tag: s.tag || "",
          is_pinned: Boolean(s.is_pinned),
          vehicle_info: s.vehicle_info || "",
          summary: s.summary || "",
          created_at: s.created_at || "",
          updated_at: s.updated_at || "",
          message_count: s.message_count || (s.messages ? s.messages.length : 0)
        }));
        await cacheManager.cacheSessions(list);
        return list;
      }
    } catch (err) {
      console.warn("Ошибка загрузки сессий с бэкенда:", err);
    }
    return cacheManager.getCachedSessions();
  }

  public async createSession(projectId?: string | number | null, title?: string): Promise<DiagnosticSessionItem | null> {
    try {
      const body: any = {};
      if (projectId) body.project_id = projectId;
      if (title) body.title = title;

      const res = await this.fetchJson("/api/sessions/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (res.ok) {
        const data = await res.json();
        return {
          id: String(data.id),
          title: data.title || "Новый диалог",
          project_id: data.project_id || null,
          tag: data.tag || "",
          is_pinned: Boolean(data.is_pinned),
          vehicle_info: data.vehicle_info || "",
          summary: data.summary || "",
          created_at: data.created_at || new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }),
          updated_at: data.updated_at || new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })
        };
      }
    } catch (err) {
      console.error("Ошибка создания сессии:", err);
    }
    return null;
  }

  public async renameSession(sessionId: string, title: string): Promise<boolean> {
    try {
      const res = await this.fetchJson(`/api/sessions/${sessionId}/`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title })
      });
      return res.ok;
    } catch (_) {
      return false;
    }
  }

  public async setSessionTag(sessionId: string, tag: string): Promise<boolean> {
    try {
      const res = await this.fetchJson(`/api/sessions/${sessionId}/`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag })
      });
      return res.ok;
    } catch (_) {
      return false;
    }
  }

  public async setSessionPinned(sessionId: string, is_pinned: boolean): Promise<boolean> {
    try {
      const res = await this.fetchJson(`/api/sessions/${sessionId}/`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_pinned })
      });
      return res.ok;
    } catch (_) {
      return false;
    }
  }

  public async setSessionVehicle(sessionId: string, vehicle_info: string): Promise<boolean> {
    try {
      const res = await this.fetchJson(`/api/sessions/${sessionId}/`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vehicle_info })
      });
      return res.ok;
    } catch (_) {
      return false;
    }
  }

  public async deleteSession(sessionId: string): Promise<boolean> {
    try {
      const res = await this.fetchJson(`/api/sessions/${sessionId}/`, { method: "DELETE" });
      return res.ok;
    } catch (_) {
      return false;
    }
  }

  // =========================================================================
  // 3. Сообщения сессии и массовое удаление (/api/messages/delete/)
  // =========================================================================

  public async getSessionMessages(sessionId: string): Promise<ChatMessageItem[]> {
    try {
      const res = await this.fetchJson(`/api/sessions/${sessionId}/`);
      if (res.ok) {
        const data = await res.json();
        const msgs = data.messages || [];
        return msgs.map((m: any) => {
          const sdata = m.structured_data || {};
          const rawSteps = sdata.repair_steps || m.tasks || [];
          const tasks = rawSteps.map((s: any) => {
            if (typeof s === "string") return { text: s, done: false };
            const title = s.title || "";
            const desc = s.description ? `: ${s.description}` : "";
            const text = title ? `${title}${desc}` : (s.text || String(s));
            return { text, done: Boolean(s.completed || s.done) };
          });
          const rawInv = sdata.inventory || m.inventory || [];
          const inventory = rawInv.map((inv: any) => (typeof inv === "string" ? inv : (inv.name || inv.item || String(inv))));

          const faults = Array.isArray(sdata.faults)
            ? sdata.faults.map((f: any) => ({
                code: f.code,
                description: f.description || f.symptom || "",
                severity: f.severity || "warning",
                health_index: f.health_index || 75
              }))
            : [];

          return {
            id: String(m.id || Math.random()),
            role: m.role || (m.is_user ? "user" : "assistant"),
            content: m.content || m.text || "",
            timestamp: m.created_at || m.timestamp || new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }),
            diagnosticType: sdata.response_type || "diagnosis",
            summaryTitle: sdata.summary_title || "",
            faults,
            dtcCodes: m.dtc_codes || (sdata.dtc_codes || []),
            tasks,
            inventory,
            recommendations: sdata.recommendations || [],
            followupSuggestions: sdata.followup_suggestions || [],
            vehicle: m.vehicle_info || ""
          };
        });
      }
    } catch (_) {}
    return [];
  }

  public async deleteMessages(sessionId: string, messageIds: string[], deleteAll: boolean = false): Promise<boolean> {
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
      return res.ok;
    } catch (_) {
      return false;
    }
  }

  public async toggleTask(
    messageId: string | number,
    taskIndex: number,
    checked: boolean = true,
    itemType: "step" | "inventory" = "step"
  ): Promise<boolean> {
    try {
      const res = await this.fetchJson(`/api/messages/${messageId}/toggle-task/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: itemType,
          id: taskIndex + 1,
          task_index: taskIndex,
          checked
        })
      });
      return res.ok;
    } catch (_) {
      return false;
    }
  }

  // =========================================================================
  // 4. Экспертная диагностика (/api/ask/)
  // =========================================================================

  public async askExpert(payload: AskExpertPayload): Promise<AskExpertResponse> {
    // Собираем коды неисправностей из payload и staged items
    const dtcList: string[] = [...(payload.dtcCodes || [])];
    const images: string[] = [...(payload.imagesB64 || [])];
    let voiceB64: string | undefined = payload.voiceB64;

    if (payload.stagedItems && payload.stagedItems.length > 0) {
      payload.stagedItems.forEach(item => {
        if (item.type === "dtc" && item.data && !dtcList.includes(item.data)) {
          dtcList.push(item.data);
        } else if (item.type === "photo" && item.data) {
          images.push(item.data);
        } else if (item.type === "audio" && item.data) {
          voiceB64 = item.data;
        }
      });
    }

    const bodyObj: any = {
      query: payload.query,
      session_id: payload.sessionId,
      vehicle_info: payload.vehicleInfo || "",
      dtc_codes: dtcList,
      images: images,
      audio: voiceB64,
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

    const res = await this.fetchJson("/api/ask/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bodyObj)
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Ошибка сервера (${res.status}): ${errText}`);
    }

    const data = await res.json();
    const sdata = data.structured_data || {};
    const rawSteps = sdata.repair_steps || data.tasks || [];
    const tasks = rawSteps.map((s: any) => {
      if (typeof s === "string") return { text: s, done: false };
      const title = s.title || "";
      const desc = s.description ? `: ${s.description}` : "";
      const text = title ? `${title}${desc}` : (s.text || String(s));
      return { text, done: Boolean(s.completed || s.done) };
    });

    const rawInv = sdata.inventory || data.inventory || [];
    const inventory = rawInv.map((inv: any) => (typeof inv === "string" ? inv : (inv.name || inv.item || String(inv))));

    const faults = Array.isArray(sdata.faults)
      ? sdata.faults.map((f: any) => ({
          code: f.code,
          description: f.description || "",
          severity: f.severity || "warning",
          health_index: f.health_index || 75
        }))
      : [];

    return {
      answer: sdata.mentor_reply || data.answer || data.reply || "",
      sessionId: String(data.session_id || payload.sessionId || ""),
      messageId: String(data.message_id || Date.now()),
      diagnosticType: sdata.response_type || "diagnosis",
      summaryTitle: sdata.summary_title || "Экспертное заключение",
      faults,
      tasks,
      inventory,
      recommendations: sdata.recommendations || [],
      followupSuggestions: sdata.followup_suggestions || [],
      dtcDetails: data.dtc_details || [],
      sessionSummary: data.session_summary
    };
  }

  // =========================================================================
  // 5. Словарь кодов DTC (/api/dtc/)
  // =========================================================================

  public async getDtcList(query?: string, system?: string): Promise<DtcCodeInfo[]> {
    try {
      const params: string[] = ["limit=200"];
      if (query) params.push(`q=${encodeURIComponent(query)}`);
      if (system && system !== "ALL") params.push(`system=${encodeURIComponent(system)}`);

      const res = await this.fetchJson(`/api/dtc/?${params.join("&")}`);
      if (res.ok) {
        const data = await res.json();
        const rawList = data.items || data.codes || (Array.isArray(data) ? data : []);
        return rawList.map((item: any) => {
          const code = (item.code || item.dtc || "").toUpperCase();
          let sys: any = item.system || (code ? code[0] : "P");
          if (typeof sys === "string") {
            const sLower = sys.toLowerCase();
            if (sLower.includes("power")) sys = "P";
            else if (sLower.includes("chassis")) sys = "C";
            else if (sLower.includes("body")) sys = "B";
            else if (sLower.includes("net")) sys = "U";
            else if (!["P", "C", "B", "U"].includes(sys.toUpperCase())) {
              sys = code ? code[0] : "other";
            } else {
              sys = sys.toUpperCase();
            }
          }

          const title = item.title || (item.system_ru ? `${code} — ${item.system_ru}` : (item.symptom || code));
          const desc = item.description || item.symptom || item.system_description || (item.cause ? `Причина: ${item.cause}` : "");
          const causes = Array.isArray(item.causes) ? item.causes : (item.cause ? [item.cause] : (item.solutions || []));
          const symptoms = Array.isArray(item.symptoms) ? item.symptoms : (item.symptom ? [item.symptom] : []);

          return {
            code,
            title,
            description: desc,
            system: sys,
            severity: item.severity || (item.health_index && item.health_index < 60 ? "critical" : "warning"),
            symptoms,
            causes
          };
        });
      }
    } catch (_) {}
    return cacheManager.searchDtc(query || "");
  }

  // =========================================================================
  // 6. Настройки и междиалоговая память (/api/settings/)
  // =========================================================================

  public async getSettings(): Promise<SystemSettingsInfo> {
    try {
      const res = await this.fetchJson("/api/settings/");
      if (res.ok) {
        return await res.json();
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
    try {
      const res = await this.fetchJson("/api/settings/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings)
      });
      return res.ok;
    } catch (_) {
      return false;
    }
  }

  public async clearGlobalMemory(): Promise<boolean> {
    try {
      const res = await this.fetchJson("/api/settings/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clear_global_memory: true })
      });
      return res.ok;
    } catch (_) {
      return false;
    }
  }

  // =========================================================================
  // 6. Авторизация и Учетные записи (/api/auth/)
  // =========================================================================

  public async getAuthStatus(): Promise<AuthResult> {
    try {
      const res = await this.fetchJson("/api/auth/status/", { method: "GET" });
      if (!res.ok) {
        return { success: false, is_authenticated: false };
      }
      const data = await res.json();
      return {
        success: true,
        is_authenticated: !!data.is_authenticated,
        username: data.username || "",
        user: { username: data.username || "", is_staff: !!data.is_staff }
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
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (!res.ok) {
        return { success: false, is_authenticated: false, error: data.error || "Ошибка авторизации" };
      }
      return {
        success: true,
        is_authenticated: true,
        username: data.username || username,
        user: data.user
      };
    } catch (err: any) {
      return { success: false, is_authenticated: false, error: `Нет связи с сервером: ${err.message || err}` };
    }
  }

  public async register(username: string, password: string, email?: string): Promise<AuthResult> {
    try {
      const payload: Record<string, string> = { username, password };
      if (email) payload.email = email;
      const res = await this.fetchJson("/api/auth/register/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) {
        return { success: false, is_authenticated: false, error: data.error || "Ошибка регистрации" };
      }
      return {
        success: true,
        is_authenticated: true,
        username: data.username || username,
        user: data.user
      };
    } catch (err: any) {
      return { success: false, is_authenticated: false, error: `Нет связи с сервером: ${err.message || err}` };
    }
  }

  public async logout(): Promise<AuthResult> {
    try {
      await this.fetchJson("/api/auth/logout/", { method: "POST" });
      return { success: true, is_authenticated: false };
    } catch (_) {
      return { success: false, is_authenticated: false };
    }
  }

  public async deleteAccount(): Promise<AuthResult> {
    try {
      const res = await this.fetchJson("/api/auth/delete-account/", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        return { success: false, is_authenticated: true, error: data.error || "Ошибка удаления аккаунта" };
      }
      return { success: true, is_authenticated: false };
    } catch (err: any) {
      return { success: false, is_authenticated: true, error: `Ошибка: ${err.message || err}` };
    }
  }

  private async fetchJson(path: string, init?: RequestInit): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    return fetch(url, init);
  }
}

export const apiClient = new BackendApiClient();
