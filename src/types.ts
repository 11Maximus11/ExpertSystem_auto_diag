/**
 * Модели данных и типы автономного мобильного приложения «ИИдеал Авто» (le.codes).
 * Версия 1.0.0 — 2026-11-28.
 * Лицензия: GNU General Public License v3.0 (GPL-3.0).
 */

export type ThemeMode = "dark" | "light";

export type SystemKey =
  | "engine"
  | "transmission"
  | "brakes"
  | "electrical"
  | "cooling"
  | "hybrid"
  | "battery"
  | "chassis"
  | "suspension";

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

export type DemoEcuScenarioId = "misfire_lean" | "at_overheat" | "can_battery" | "hybrid_hv";

export interface DtcCodeInfo {
  code: string;
  title: string;
  description: string;
  system: SystemKey | "P" | "C" | "B" | "U" | "other";
  system_ru?: string;
  severity: "critical" | "warning" | "info";
  health_index?: number;
  has_telemetry?: boolean;
  symptoms?: string[];
  causes?: string[];
  en_title?: string;
  solution?: string;
  oem_variants?: string;
  nhtsa_bulletins?: number;
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
  id: string | number;
  step_number: number;
  title: string;
  instruction: string;
  text: string;
  torque_or_spec: string;
  estimated_minutes: number;
  safety_warning: string;
  done: boolean;
}

export interface ChatInventoryItem {
  id: string;
  name: string;
  category: "tool" | "part" | "consumable" | "safety";
  spec: string;
  checked: boolean;
}

export interface ChatFaultItem {
  code: string;
  system: string;
  system_ru: string;
  title: string;
  confidence: number;
  description: string;
  root_cause: string;
  severity: "critical" | "warning" | "info";
  health_index: number;
}

export interface ParsedDocInfo {
  filename: string;
  extension: string;
  size_bytes: number;
  char_length: number;
  is_fully_processed: boolean;
  processing_mode: string;
  detected_dtc_codes: string[];
  key_metrics: string[];
  llm_ready_text: string;
  preview_excerpt: string;
}

export interface AcousticAnalysisMetrics {
  durationSec: number;
  avgHz: number;
  peakHz: number;
  clarity: number;
  peakDb: number;
  noteLabel: string;
  acousticHint: string;
}

export interface StagedItem {
  id: string;
  type: "photo" | "audio" | "dtc" | "obd" | "file";
  label: string;
  meta?: string;
  data?: any;
  file?: File;
  mimeType?: string;
  duration?: number;
  transcript?: string;
  acoustic?: AcousticAnalysisMetrics;
  parsedDoc?: ParsedDocInfo;
}

export interface ChatMessageItem {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  diagnosticType?: "diagnosis" | "followup" | "visual_inspection" | "general";
  summaryTitle?: string;
  engineSource?: "lecodes_ai" | "byok_custom" | "local_rag";
  faults?: ChatFaultItem[];
  dtcCodes?: string[];
  tasks?: ChatRepairTask[];
  inventoryItems?: ChatInventoryItem[];
  inventory?: string[];
  telemetryNotes?: string[];
  recommendations?: string[];
  followupSuggestions?: string[];
  attachments?: StagedItem[];
  vehicle?: string;
}

export interface ProjectItem {
  id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
}

export interface DiagnosticSessionItem {
  id: string;
  title: string;
  project_id: string | null;
  tag: string;
  is_pinned: boolean;
  vehicle_info: string;
  summary: string;
  worker_status: "idle" | "running" | "completed" | "error";
  created_at: string;
  updated_at: string;
  message_count: number;
}

export type LlmProviderMode = "lecodes_ai" | "byok_openai" | "byok_gigachat" | "local_only";

export interface LocalSettingsInfo {
  theme_mode: "dark" | "light";
  cross_dialog_memory_enabled: boolean;
  global_memory_summary: string;
  llm_mode: LlmProviderMode;
  byok_base_url: string;
  byok_model: string;
  local_warning_ack: boolean;
  last_backup_at: string;
}

export interface BackupPayloadV1 {
  format: "aideal-auto-backup-v1";
  exported_at: string;
  app_version: string;
  settings: LocalSettingsInfo;
  projects: ProjectItem[];
  sessions: DiagnosticSessionItem[];
  messages_by_session: Record<string, ChatMessageItem[]>;
}
