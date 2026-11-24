/**
 * Модели данных и типы клиентской подсистемы ИИдеал-Авто (le.codes Native Client).
 * Полное соответствие веб-версии: сессии, проекты, мультимодальные вложения,
 * интерактивные чеклисты задач ремонта, справочник DTC и телеметрия OBD2.
 * Лицензия: GPL-3.0
 */

export interface OBDLiveSensors {
  rpm: number;
  speed: number;
  coolantTemp: number;
  throttle: number;
  voltage: number;
  engineLoad: number;
  fuelLevel: number;
  intakeTemp: number;
  dtcList: string[];
}

export type OBDConnectionStatus = "disconnected" | "connecting" | "connected" | "error";
export type OBDConnectionType = "bluetooth" | "serial" | "demo";

export interface DtcCodeInfo {
  code: string;
  title: string;
  description: string;
  system: "P" | "C" | "B" | "U" | "other";
  severity: "critical" | "warning" | "info";
  symptoms?: string[];
  causes?: string[];
}

export interface ChatRepairTask {
  text: string;
  done: boolean;
  category?: string;
}

export interface ChatFaultItem {
  code: string;
  description?: string;
  severity?: "critical" | "warning" | "info";
  health_index?: number;
}

export interface StagedItem {
  id: string;
  type: "photo" | "audio" | "dtc" | "obd" | "file";
  label: string;
  meta?: string;
  data?: any; // base64, blob, or text
}

export interface ChatMessageItem {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  diagnosticType?: "diagnosis" | "followup" | "visual_inspection" | "general";
  summaryTitle?: string;
  faults?: ChatFaultItem[];
  dtcCodes?: string[];
  tasks?: ChatRepairTask[];
  inventory?: string[];
  recommendations?: string[];
  followupSuggestions?: string[];
  attachments?: StagedItem[];
  vehicle?: string;
  selected?: boolean;
}

export interface ProjectItem {
  id: string | number;
  name: string;
  description?: string;
  session_count?: number;
}

export interface DiagnosticSessionItem {
  id: string;
  title: string;
  project_id?: string | number | null;
  tag?: string;
  is_pinned?: boolean;
  vehicle_info?: string;
  summary?: string;
  created_at?: string;
  updated_at?: string;
  message_count?: number;
}

export interface SystemSettingsInfo {
  cross_dialog_memory_enabled: boolean;
  global_memory_summary: string;
  vulkan_available?: boolean;
  model_name?: string;
  rag_enabled?: boolean;
  context_compression?: boolean;
}

export interface AuthUser {
  username: string;
  email?: string;
  is_staff?: boolean;
  is_authenticated: boolean;
}

export interface AuthResult {
  success: boolean;
  is_authenticated: boolean;
  username?: string;
  error?: string;
  user?: {
    username: string;
    is_staff?: boolean;
  };
}
