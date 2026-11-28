/**
 * Локальная база данных устройства на базе localStorage + secureStorage.
 * Полностью заменяет серверную БД и регистрацию: все проекты, сессии, переписки,
 * чеклисты, междиалоговая память и настройки хранятся на устройстве пользователя,
 * с поддержкой полного экспорта/импорта резервной копии (JSON) и предупреждением
 * о потере локальных данных при удалении приложения.
 *
 * Лицензия: GNU General Public License v3.0 (GPL-3.0).
 */

import {
  BackupPayloadV1,
  ChatMessageItem,
  DiagnosticSessionItem,
  LocalSettingsInfo,
  ProjectItem
} from "../types";
import { formatDateTimeRu, formatTimeRu, generateUuidV4 } from "../utils/polyfills";

const KEY_PROJECTS = "aideal_db_projects_v2";
const KEY_SESSIONS = "aideal_db_sessions_v2";
const KEY_SETTINGS = "aideal_db_settings_v2";
const KEY_ACTIVE_SESSION = "aideal_db_active_session_v2";
const KEY_MSG_PREFIX = "aideal_db_msgs_v2_";

export function createWelcomeMessage(): ChatMessageItem {
  return {
    id: "msg-welcome",
    role: "assistant",
    content:
      "Здравствуйте! Я интеллектуальная система автодиагностики «ИИдеал Авто».\n\n" +
      "Локальный Hybrid RAG-индекс по 12 141 коду OBD-II и история ремонтов хранятся прямо на устройстве, а глубокий синтез, распознавание фото (Чат / AR / VR) и голосовых сообщений (ГС) выполняет встроенный ИИ платформы le.codes.\n" +
      "Опишите симптом, запишите ГС, сделайте фото узла или подключите сканер OBD-II.",
    timestamp: formatTimeRu(),
    diagnosticType: "diagnosis",
    summaryTitle: "Интеллектуальный стенд автодиагностики",
    engineSource: "lecodes_ai",
    followupSuggestions: [
      "Двигатель троит на холостых, мигает Check Engine, ошибка P0300",
      "Жёсткие пинки АКПП при переключении с 1 на 2 передачу, код P0796",
      "Педаль тормоза стала мягкой, горит ABS, ошибка C0050",
      "Потеря связи по шине CAN с блоком управления, ошибка U1900",
      "Ошибка тяговой батареи гибрида P0A80 — как проверить ячейки?"
    ],
    tasks: [
      {
        id: 1,
        step_number: 1,
        title: "Подключить OBD-II сканер или Демо-ЭБУ",
        instruction: "Считать активные коды DTC (Mode 03) и стоп-кадр",
        text: "Подключить OBD-II сканер (или Демо-ЭБУ) и считать активные коды DTC",
        torque_or_spec: "OBD-II Mode 03",
        estimated_minutes: 5,
        safety_warning: "",
        done: false
      },
      {
        id: 2,
        step_number: 2,
        title: "Замерить температуру ОЖ и напряжение АКБ",
        instruction: "Проверить рабочую температуру (85–95°C) и напряжение генератора (13.8–14.4 В)",
        text: "Сверить температуру ОЖ (85–95°C) и напряжение сети (13.8–14.4 В)",
        torque_or_spec: "13.8–14.4 В",
        estimated_minutes: 5,
        safety_warning: "",
        done: false
      }
    ],
    inventoryItems: [
      { id: "inv-init-1", name: "OBD-II адаптер ELM327", category: "tool", spec: "BLE / USB", checked: false },
      { id: "inv-init-2", name: "Цифровой мультиметр", category: "tool", spec: "True RMS", checked: false },
      { id: "inv-init-3", name: "Очиститель контактов", category: "consumable", spec: "Диэлектрик", checked: false }
    ],
    inventory: ["OBD-II адаптер ELM327", "Цифровой мультиметр", "Очиститель контактов"]
  };
}

const DEFAULT_SETTINGS: LocalSettingsInfo = {
  theme_mode: "dark",
  cross_dialog_memory_enabled: true,
  global_memory_summary: "",
  local_warning_ack: false,
  last_backup_at: ""
};

export class LocalDatabase {
  private readJson<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw) as T;
    } catch (_) {
      return fallback;
    }
  }

  private writeJson(key: string, val: any): void {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch (e) {
      console.warn("[LocalDatabase] write error:", key, e);
    }
  }

  public getSettings(): LocalSettingsInfo {
    const stored = this.readJson<Partial<LocalSettingsInfo>>(KEY_SETTINGS, {});
    return {
      theme_mode: stored.theme_mode === "light" ? "light" : "dark",
      cross_dialog_memory_enabled:
        typeof stored.cross_dialog_memory_enabled === "boolean"
          ? stored.cross_dialog_memory_enabled
          : DEFAULT_SETTINGS.cross_dialog_memory_enabled,
      global_memory_summary: String(stored.global_memory_summary || ""),
      local_warning_ack: Boolean(stored.local_warning_ack),
      last_backup_at: String(stored.last_backup_at || "")
    };
  }

  public saveSettings(patch: Partial<LocalSettingsInfo>): LocalSettingsInfo {
    const next: LocalSettingsInfo = {
      ...this.getSettings(),
      ...patch
    };
    this.writeJson(KEY_SETTINGS, next);
    return next;
  }

  public getProjects(): ProjectItem[] {
    return this.readJson<ProjectItem[]>(KEY_PROJECTS, []);
  }

  public saveProjects(list: ProjectItem[]): void {
    this.writeJson(KEY_PROJECTS, list);
  }

  public createProject(name: string, description: string = ""): ProjectItem {
    const now = formatDateTimeRu();
    const item: ProjectItem = {
      id: "proj-" + generateUuidV4().slice(0, 8),
      name: name.trim(),
      description: description.trim(),
      created_at: now,
      updated_at: now
    };
    const next = [item, ...this.getProjects()];
    this.saveProjects(next);
    return item;
  }

  public renameProject(id: string, name: string): void {
    const next = this.getProjects().map(p =>
      p.id === id ? { ...p, name: name.trim(), updated_at: formatDateTimeRu() } : p
    );
    this.saveProjects(next);
  }

  public deleteProject(id: string): void {
    this.saveProjects(this.getProjects().filter(p => p.id !== id));
    const sessions = this.getSessions().map(s => (s.project_id === id ? { ...s, project_id: null } : s));
    this.saveSessions(sessions);
  }

  public getSessions(): DiagnosticSessionItem[] {
    let list = this.readJson<DiagnosticSessionItem[]>(KEY_SESSIONS, []);
    if (list.length === 0) {
      const initial = this.createSession(null, "Диагностика #1", "");
      list = [initial];
    }
    return list;
  }

  public saveSessions(list: DiagnosticSessionItem[]): void {
    this.writeJson(KEY_SESSIONS, list);
  }

  public getActiveSessionId(): string {
    const saved = localStorage.getItem(KEY_ACTIVE_SESSION) || "";
    const sessions = this.getSessions();
    if (saved && sessions.some(s => s.id === saved)) return saved;
    const firstId = sessions[0].id;
    localStorage.setItem(KEY_ACTIVE_SESSION, firstId);
    return firstId;
  }

  public setActiveSessionId(id: string): void {
    localStorage.setItem(KEY_ACTIVE_SESSION, id);
  }

  public createSession(
    projectId: string | null,
    title: string,
    vehicleInfo: string = ""
  ): DiagnosticSessionItem {
    const id = generateUuidV4();
    const now = formatDateTimeRu();
    const sess: DiagnosticSessionItem = {
      id,
      title: title.trim() || "Новая диагностика",
      project_id: projectId,
      tag: "",
      is_pinned: false,
      vehicle_info: vehicleInfo,
      summary: "",
      worker_status: "idle",
      created_at: now,
      updated_at: now,
      message_count: 0
    };
    const existing = this.readJson<DiagnosticSessionItem[]>(KEY_SESSIONS, []);
    this.saveSessions([sess, ...existing]);
    this.saveMessages(id, [createWelcomeMessage()]);
    this.setActiveSessionId(id);
    return sess;
  }

  public updateSession(id: string, patch: Partial<DiagnosticSessionItem>): void {
    const next = this.getSessions().map(s =>
      s.id === id ? { ...s, ...patch, updated_at: patch.updated_at || formatDateTimeRu() } : s
    );
    this.saveSessions(next);
  }

  public deleteSession(id: string): string {
    try {
      localStorage.removeItem(KEY_MSG_PREFIX + id);
    } catch (_) {}
    const remaining = this.getSessions().filter(s => s.id !== id);
    if (remaining.length === 0) {
      this.saveSessions([]);
      const fresh = this.createSession(null, "Диагностика #1", "");
      return fresh.id;
    }
    this.saveSessions(remaining);
    const nextActive = remaining[0].id;
    this.setActiveSessionId(nextActive);
    return nextActive;
  }

  public getMessages(sessionId: string): ChatMessageItem[] {
    const msgs = this.readJson<ChatMessageItem[]>(KEY_MSG_PREFIX + sessionId, []);
    return msgs.length > 0 ? msgs : [createWelcomeMessage()];
  }

  public saveMessages(sessionId: string, messages: ChatMessageItem[]): void {
    // Очищаем несериализуемые handle-поля File из staged attachments перед сохранением в localStorage
    const sanitized: ChatMessageItem[] = messages.map(m => ({
      ...m,
      attachments: m.attachments
        ? m.attachments.map(att => ({
            id: att.id,
            type: att.type,
            label: att.label,
            meta: att.meta,
            mimeType: att.mimeType,
            duration: att.duration,
            transcript: att.transcript,
            acoustic: att.acoustic,
            parsedDoc: att.parsedDoc
          }))
        : undefined
    }));
    this.writeJson(KEY_MSG_PREFIX + sessionId, sanitized);
    const nonWelcomeCount = sanitized.filter(m => m.id !== "msg-welcome").length;
    this.updateSession(sessionId, { message_count: nonWelcomeCount });
  }

  public exportBackupJson(): string {
    const projects = this.getProjects();
    const sessions = this.getSessions();
    const messages_by_session: Record<string, ChatMessageItem[]> = {};
    for (const s of sessions) {
      messages_by_session[s.id] = this.getMessages(s.id);
    }
    const now = formatDateTimeRu();
    const settings = this.saveSettings({ last_backup_at: now });
    const payload: BackupPayloadV1 = {
      format: "aideal-auto-backup-v1",
      exported_at: now,
      app_version: "1.0.0",
      settings,
      projects,
      sessions,
      messages_by_session
    };
    return JSON.stringify(payload, null, 2);
  }

  public importBackupJson(rawText: string): {
    ok: boolean;
    projects: number;
    sessions: number;
    messages: number;
    error?: string;
  } {
    try {
      const parsed = JSON.parse((rawText || "").trim()) as BackupPayloadV1;
      if (!parsed || parsed.format !== "aideal-auto-backup-v1" || !Array.isArray(parsed.sessions)) {
        return {
          ok: false,
          projects: 0,
          sessions: 0,
          messages: 0,
          error: "Неверный формат резервной копии (ожидается JSON aideal-auto-backup-v1)"
        };
      }

      // Удаляем старые сообщения
      for (const old of this.getSessions()) {
        try {
          localStorage.removeItem(KEY_MSG_PREFIX + old.id);
        } catch (_) {}
      }

      const projects = Array.isArray(parsed.projects) ? parsed.projects : [];
      const sessions = parsed.sessions;
      this.saveProjects(projects);
      this.saveSessions(sessions);

      let msgCount = 0;
      const msgMap = parsed.messages_by_session || {};
      for (const s of sessions) {
        const list = Array.isArray(msgMap[s.id]) && msgMap[s.id].length > 0 ? msgMap[s.id] : [createWelcomeMessage()];
        this.saveMessages(s.id, list);
        msgCount += list.filter(m => m.id !== "msg-welcome").length;
      }

      if (parsed.settings) {
        this.saveSettings({
          ...parsed.settings,
          local_warning_ack: true
        });
      }
      if (sessions.length > 0) {
        this.setActiveSessionId(sessions[0].id);
      }
      return {
        ok: true,
        projects: projects.length,
        sessions: sessions.length,
        messages: msgCount
      };
    } catch (err: any) {
      return {
        ok: false,
        projects: 0,
        sessions: 0,
        messages: 0,
        error: `Ошибка разбора JSON: ${err?.message || err}`
      };
    }
  }

  public clearAllData(): string {
    for (const s of this.getSessions()) {
      try {
        localStorage.removeItem(KEY_MSG_PREFIX + s.id);
      } catch (_) {}
    }
    localStorage.removeItem(KEY_PROJECTS);
    localStorage.removeItem(KEY_SESSIONS);
    localStorage.removeItem(KEY_ACTIVE_SESSION);
    this.saveSettings({ global_memory_summary: "" });
    const fresh = this.createSession(null, "Диагностика #1", "");
    return fresh.id;
  }

  public getStorageStats(): { projects: number; sessions: number; totalMessages: number } {
    const projects = this.getProjects();
    const sessions = this.getSessions();
    let totalMessages = 0;
    for (const s of sessions) {
      totalMessages += s.message_count || 0;
    }
    return { projects: projects.length, sessions: sessions.length, totalMessages };
  }
}

export const localDb = new LocalDatabase();
