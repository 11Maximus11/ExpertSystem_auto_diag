/**
 * Модели данных и типы клиентской подсистемы ИИдеал-Авто (le.codes Native Client).
 * Полное соответствие веб-версии и Django JSON/Schema API: сессии, проекты,
 * мультимодальные вложения, интерактивные чеклисты задач ремонта и инвентаря,
 * справочник DTC, авторизация и телеметрия OBD-II.
 *
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
  vin?: string;
}

export type OBDConnectionStatus = "disconnected" | "connecting" | "connected" | "error";
export type OBDConnectionType = "bluetooth" | "serial" | "demo";

export interface DtcCodeInfo {
  code: string;
  title: string;
  description: string;
  system: "P" | "C" | "B" | "U" | "other";
  severity: "critical" | "warning" | "info";
  health_index?: number;
  has_telemetry?: boolean;
  symptoms?: string[];
  causes?: string[];
  en_title?: string;
  solution?: string;
  system_ru?: string;
  lang?: string;
  oem_variants?: any;
  nhtsa_stats?: any;
}

export interface DtcSystemCount {
  id: string;
  name: string;
  count: number;
}

export interface DtcPageResult {
  items: DtcCodeInfo[];
  total: number;
  totalCatalog: number;
  systems: DtcSystemCount[];
}

export interface ChatRepairTask {
  id?: string | number;
  step_number?: number;
  title?: string;
  instruction?: string;
  text: string;
  torque_or_spec?: string;
  estimated_minutes?: number;
  safety_warning?: string;
  done: boolean;
  category?: string;
}

export interface ChatInventoryItem {
  id: string;
  name: string;
  category: string;
  spec?: string;
  checked: boolean;
}

export interface ChatFaultItem {
  code: string;
  title?: string;
  system_ru?: string;
  confidence?: number;
  description?: string;
  root_cause?: string;
  severity?: "critical" | "warning" | "info";
  health_index?: number;
}

export interface ParsedDocInfo {
  filename: string;
  extension?: string;
  size_bytes?: number;
  char_length?: number;
  is_fully_processed?: boolean;
  processing_mode?: string;
  detected_dtc_codes?: string[];
  detected_codes?: string[];
  key_metrics?: string[];
  llm_ready_text?: string;
  preview_excerpt?: string;
  embedded_images_count?: number;
  embedded_images?: string[];
}

export interface StagedItem {
  id: string;
  type: "photo" | "audio" | "dtc" | "obd" | "file";
  label: string;
  meta?: string;
  data?: any; // base64, File handle, JSON object
  file?: any; // ле.codes File handle для multipart FormData и UIImage
  mimeType?: string;
  duration?: number;
  transcript?: string;
  parsedDoc?: ParsedDocInfo;
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
  inventoryItems?: ChatInventoryItem[];
  inventory?: string[];
  telemetryNotes?: string[];
  recommendations?: string[];
  followupSuggestions?: string[];
  attachments?: StagedItem[];
  rawAttachments?: any[];
  structuredData?: any;
  vehicle?: string;
  selected?: boolean;
}

export interface ProjectItem {
  id: string | number;
  name: string;
  description?: string;
  sessions_count?: number;
  sessions?: DiagnosticSessionItem[];
}

export interface DiagnosticSessionItem {
  id: string;
  title: string;
  project_id?: string | number | null;
  project_name?: string | null;
  tag?: string;
  is_pinned?: boolean;
  vehicle_info?: string;
  summary?: string;
  worker_status?: "idle" | "running" | "aborted_for_priority" | "completed" | "error";
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
  email?: string;
  session_key?: string;
  error?: string;
  user?: {
    username: string;
    email?: string;
    is_staff?: boolean;
  };
}
