/**
 * API-клиент для взаимодействия с существующим сервером Django ИИдеал-Авто.
 * Поддерживает:
 * - Запросы к эксперту диагносту (/api/ask/) с мультимодальным вводом и телеметрией
 * - Загрузку и синхронизацию сессий (/api/sessions/)
 * - Загрузку проектов (/api/projects/)
 * - Получение словаря кодов DTC (/api/dtc/)
 * - Переключение статуса задач ремонта (/api/messages/<id>/toggle-task/)
 * - Автоопределение origin или настройка пользовательского URL (например http://localhost:8000)
 */

import { cacheManager } from "../cache/ResourceCacheManager";
import { ChatMessageItem, DiagnosticSessionItem, DtcCodeInfo, OBDLiveSensors } from "../types";

export interface AskExpertPayload {
  query: string;
  sessionId?: string;
  vehicleInfo?: string;
  dtcCodes?: string[];
  telemetry?: OBDLiveSensors;
  imagesB64?: string[];
  voiceB64?: string;
}

export interface AskExpertResponse {
  answer: string;
  sessionId: string;
  messageId?: string;
  tasks: { text: string; done: boolean }[];
  inventory: string[];
  dtcDetails: any[];
}

export class BackendApiClient {
  private baseUrl: string = "";

  constructor() {
    this.baseUrl = cacheManager.getSetting("api_base_url", "");
    // Если пусто и в браузере запущен сервер на порту 8000, используем относительный путь
    if (!this.baseUrl && typeof window !== "undefined") {
      if (window.location.port === "8000") {
        this.baseUrl = "";
      } else {
        // По умолчанию для standalone web-app используем локальный бэкенд
        this.baseUrl = "http://localhost:8000";
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
        return { ok: true, status: res.status, latencyMs, message: `Связь установлена (HTTP ${res.status}) за ${latencyMs} мс` };
      }
      return { ok: false, status: res.status, latencyMs, message: `Сервер ответил ошибкой HTTP ${res.status}` };
    } catch (err: any) {
      const now = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
      const latencyMs = Math.round(now - start);
      return { ok: false, status: 0, latencyMs, message: `Ошибка: ${err.message || "Сервер стенда недоступен"}` };
    }
  }

  /**
   * Отправка запроса эксперту (AI Диагностика)
   */
  public async askExpert(payload: AskExpertPayload): Promise<AskExpertResponse> {
    let finalQuery = payload.query;

    // Если есть данные телеметрии OBD-II, добавляем краткий снимок в запрос для ИИ
    if (payload.telemetry && (payload.telemetry.rpm > 0 || payload.telemetry.dtcList.length > 0)) {
      const tel = payload.telemetry;
      const snapshot = `\n[OBD-II Телеметрия с датчиков: Обороты=${tel.rpm} об/мин, Скорость=${tel.speed} км/ч, ОЖ=${tel.coolantTemp}°C, АКБ=${tel.voltage.toFixed(1)}V, Дроссель=${tel.throttle}%, Ошибки ЭБУ=${tel.dtcList.join(",") || "нет"}]`;
      finalQuery += snapshot;
    }

    const body: Record<string, any> = {
      query: finalQuery,
      session_id: payload.sessionId || undefined,
      vehicle_info: payload.vehicleInfo || "",
      dtc_codes: payload.dtcCodes || (payload.telemetry ? payload.telemetry.dtcList : []),
      images_b64: payload.imagesB64 || [],
      voice_b64: payload.voiceB64 || ""
    };

    const res = await this.fetchJson("/api/ask/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      throw new Error(`Ошибка сервера (${res.status}): ${await res.text()}`);
    }

    const data = await res.json();
    const ast = data.assistant_message || {};
    const sdata = ast.structured_data || {};

    const answer = ast.content || sdata.mentor_reply || data.answer || data.response || "Ответ сформирован.";
    const messageId = ast.id ? String(ast.id) : undefined;

    // Извлечение пошаговых задач ремонта
    const rawSteps = sdata.repair_steps || data.tasks || [];
    const tasks: { text: string; done: boolean }[] = rawSteps.map((s: any) => {
      if (typeof s === "string") return { text: s, done: false };
      const title = s.title || "";
      const desc = s.description ? `: ${s.description}` : "";
      const text = title ? `${title}${desc}` : (s.text || String(s));
      return { text, done: Boolean(s.completed || s.done) };
    });

    // Извлечение инвентаря / необходимых запчастей
    const rawInv = sdata.inventory || data.inventory || [];
    const inventory: string[] = rawInv.map((inv: any) => {
      if (typeof inv === "string") return inv;
      return inv.name || inv.item || String(inv);
    });

    // Извлечение выявленных кодов и неисправностей
    const dtcDetails = sdata.faults || data.dtc_details || [];

    return {
      answer,
      sessionId: data.session_id || payload.sessionId || "",
      messageId,
      tasks,
      inventory,
      dtcDetails
    };
  }

  /**
   * Получение списка диагностических сессий
   */
  public async getSessions(): Promise<DiagnosticSessionItem[]> {
    try {
      const res = await this.fetchJson("/api/sessions/");
      if (res.ok) {
        const data = await res.json();
        const list: DiagnosticSessionItem[] = data.sessions || (Array.isArray(data) ? data : []);
        // Сохраняем в офлайн кэш
        cacheManager.cacheSessions(list);
        return list;
      }
    } catch (err) {
      console.warn("Бэкенд недоступен, загружаем сессии из кэша:", err);
    }
    return cacheManager.getCachedSessions();
  }

  /**
   * Получение истории сообщений сессии
   */
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

          return {
            id: String(m.id || Math.random()),
            role: m.role || (m.is_user ? "user" : "assistant"),
            content: m.content || m.text || "",
            timestamp: m.created_at || m.timestamp || new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }),
            dtcCodes: m.dtc_codes || [],
            tasks,
            inventory,
            vehicle: m.vehicle_info || ""
          };
        });
      }
    } catch (_) {}
    return [];
  }

  /**
   * Синхронизация словаря кодов ошибок DTC с сервера в локальный кэш
   */
  public async syncDtcDictionary(): Promise<number> {
    try {
      const res = await this.fetchJson("/api/dtc/?limit=150");
      if (res.ok) {
        const data = await res.json();
        const rawList = data.items || data.codes || (Array.isArray(data) ? data : []);
        const formatted: DtcCodeInfo[] = rawList.map((item: any) => {
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

          const title = item.title || item.system_ru ? `${code} — ${item.system_ru || item.title}` : (item.symptom || code);
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

        if (formatted.length > 0) {
          await cacheManager.cacheDtcDictionary(formatted);
          return formatted.length;
        }
      }
    } catch (e) {
      console.warn("Синхронизация DTC с сервером не удалась, используется локальный словарь:", e);
    }
    return cacheManager.getStats().dtcCount;
  }

  /**
   * Переключение чекбокса задачи ремонта
   */
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

  private async fetchJson(path: string, init?: RequestInit): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    return fetch(url, init);
  }
}

export const apiClient = new BackendApiClient();
