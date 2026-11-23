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
}

export interface ChatMessageItem {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  dtcCodes?: string[];
  tasks?: ChatRepairTask[];
  inventory?: string[];
  vehicle?: string;
}

export interface DiagnosticSessionItem {
  id: string;
  title: string;
  vehicle_info: string;
  created_at: string;
  message_count: number;
  is_pinned: boolean;
  tags?: string[];
}

export interface SystemSettingsInfo {
  vulkan_available: boolean;
  model_name: string;
  rag_enabled: boolean;
  context_compression: boolean;
}
