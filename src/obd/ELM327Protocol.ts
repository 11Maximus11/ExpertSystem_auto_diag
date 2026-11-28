/**
 * Контроллер протокола ELM327 и OBD-II телеметрии (BLE / USB Serial / 4 демо-сценария ЭБУ).
 * Реализует инициализацию адаптера (ATZ, ATE0, ATL0, ATH0, ATSP0), опрос Mode 01 PIDs,
 * чтение и сброс ошибок DTC (Mode 03 / Mode 04), чтение VIN (Mode 09 02) и реалистичную
 * симуляцию 4 типовых неисправностей автомобиля для автономной работы на любом устройстве.
 *
 * Лицензия: GNU General Public License v3.0 (GPL-3.0).
 */

import { DemoEcuScenarioId, OBDConnectionStatus, OBDConnectionType, OBDLiveSensors } from "../types";
import { WebBluetoothOBD } from "./WebBluetoothOBD";
import { WebSerialOBD } from "./WebSerialOBD";

interface PendingCommand {
  cmd: string;
  resolve: (res: string) => void;
  reject: (err: Error) => void;
  lines: string[];
}

export interface DemoScenarioPreset {
  id: DemoEcuScenarioId;
  label: string;
  vehicle: string;
  vin: string;
  baseRpm: number;
  baseSpeed: number;
  targetTemp: number;
  baseVolt: number;
  dtcList: string[];
  mode03Hex: string;
}

export const DEMO_SCENARIOS: DemoScenarioPreset[] = [
  {
    id: "misfire_lean",
    label: "ДВС: троение и подсос (P0300, P0171, C0050)",
    vehicle: "Audi A3 1.4 TFSI (2016)",
    vin: "WAUZZZ8V1GA123456",
    baseRpm: 840,
    baseSpeed: 0,
    targetTemp: 92,
    baseVolt: 14.1,
    dtcList: ["P0300", "P0171", "C0050"],
    mode03Hex: "43 03 00 01 71 40 50"
  },
  {
    id: "at_overheat",
    label: "АКПП и перегрев (P0796, P0217)",
    vehicle: "Toyota Camry XV50 2.5 (2015)",
    vin: "XW7BF4FK60S129841",
    baseRpm: 1180,
    baseSpeed: 42,
    targetTemp: 109,
    baseVolt: 13.7,
    dtcList: ["P0796", "P0217"],
    mode03Hex: "43 07 96 02 17"
  },
  {
    id: "can_battery",
    label: "Шина CAN и просадка АКБ (U1900, P0562)",
    vehicle: "Ford Focus III 1.6 (2014)",
    vin: "Z6FXXXEECXEB44102",
    baseRpm: 760,
    baseSpeed: 0,
    targetTemp: 86,
    baseVolt: 11.4,
    dtcList: ["U1900", "P0562"],
    mode03Hex: "43 D9 00 05 62"
  },
  {
    id: "hybrid_hv",
    label: "Гибрид и ВВБ (P0A80, P0C2A)",
    vehicle: "Toyota Prius ZVW30 1.8 Hybrid (2013)",
    vin: "JTDKN36U805609112",
    baseRpm: 1350,
    baseSpeed: 36,
    targetTemp: 84,
    baseVolt: 13.9,
    dtcList: ["P0A80", "P0C2A"],
    mode03Hex: "43 0A 80 0C 2A"
  }
];

export class ELM327Protocol {
  private status: OBDConnectionStatus = "disconnected";
  private statusMessage: string = "Не подключено";
  private connectionType: OBDConnectionType = "demo";
  private demoScenario: DemoScenarioPreset = DEMO_SCENARIOS[0];

  private bluetoothDriver: WebBluetoothOBD;
  private serialDriver: WebSerialOBD;

  private sensors: OBDLiveSensors = {
    rpm: 0,
    speed: 0,
    coolantTemp: 0,
    throttle: 0,
    voltage: 12.6,
    engineLoad: 0,
    fuelLevel: 65,
    intakeTemp: 22,
    dtcList: []
  };

  private isPolling: boolean = false;
  private pollIntervalTimer: any = null;
  private demoTimer: any = null;
  private commandQueue: { cmd: string; resolve: (res: string) => void; reject: (err: Error) => void }[] = [];
  private currentCommand: PendingCommand | null = null;
  private currentCommandTimeout: any = null;

  public onSensorsUpdate?: (sensors: OBDLiveSensors) => void;
  public onStatusChange?: (status: OBDConnectionStatus, msg: string) => void;
  public onLog?: (direction: "in" | "out" | "info", text: string) => void;

  constructor() {
    this.bluetoothDriver = new WebBluetoothOBD({
      onLine: line => this.handleIncomingLine(line),
      onPrompt: () => this.handlePrompt(),
      onStatus: (st, msg) => this.handleTransportStatus(st, msg),
      onError: err => this.log("info", "BT Error: " + err.message)
    });

    this.serialDriver = new WebSerialOBD({
      onLine: line => this.handleIncomingLine(line),
      onPrompt: () => this.handlePrompt(),
      onStatus: (st, msg) => this.handleTransportStatus(st, msg),
      onError: err => this.log("info", "Serial Error: " + err.message)
    });
  }

  public getStatus(): OBDConnectionStatus {
    return this.status;
  }

  public getStatusMessage(): string {
    return this.statusMessage;
  }

  public getSensors(): OBDLiveSensors {
    return { ...this.sensors };
  }

  public getDemoScenario(): DemoScenarioPreset {
    return this.demoScenario;
  }

  public setDemoScenario(scenarioId: DemoEcuScenarioId): DemoScenarioPreset {
    const found = DEMO_SCENARIOS.find(s => s.id === scenarioId) || DEMO_SCENARIOS[0];
    this.demoScenario = found;
    if (this.connectionType === "demo" && this.status === "connected") {
      this.sensors.dtcList = [...found.dtcList];
      this.sensors.vin = found.vin;
      this.sensors.coolantTemp = found.targetTemp > 95 ? 96 : 62;
      this.sensors.voltage = found.baseVolt;
      this.statusMessage = `Демо-ЭБУ: ${found.vehicle}`;
      this.notifyStatus();
      this.notifySensors();
      this.log("info", `Выбран профиль ЭБУ: ${found.label}`);
    }
    return found;
  }

  public async connect(type: OBDConnectionType, baudRate: number = 38400): Promise<boolean> {
    await this.disconnect();
    this.connectionType = type;

    if (type === "demo") {
      this.status = "connected";
      this.statusMessage = `Демо-ЭБУ: ${this.demoScenario.vehicle}`;
      this.notifyStatus();
      this.startDemoSimulation();
      return true;
    }

    if (type === "bluetooth") {
      const ok = await this.bluetoothDriver.connect();
      if (ok) {
        await this.initializeELM();
        this.startLiveTelemetry();
        return true;
      }
      return false;
    }

    if (type === "serial") {
      const ok = await this.serialDriver.connect(baudRate);
      if (ok) {
        await this.initializeELM();
        this.startLiveTelemetry();
        return true;
      }
      return false;
    }

    return false;
  }

  public async disconnect(): Promise<void> {
    this.stopPolling();
    this.stopDemoSimulation();
    if (this.currentCommandTimeout) {
      clearTimeout(this.currentCommandTimeout);
      this.currentCommandTimeout = null;
    }
    this.commandQueue = [];
    this.currentCommand = null;

    if (this.connectionType === "bluetooth") {
      await this.bluetoothDriver.disconnect();
    } else if (this.connectionType === "serial") {
      await this.serialDriver.disconnect();
    }
    this.status = "disconnected";
    this.statusMessage = "Отключено";
    this.notifyStatus();
  }

  public async sendCommand(cmd: string, timeoutMs: number = 1800): Promise<string> {
    if (this.connectionType === "demo") {
      const res = this.handleDemoCommand(cmd);
      this.log("in", res);
      return res;
    }

    return new Promise((resolve, reject) => {
      this.commandQueue.push({ cmd, resolve, reject });
      void this.processQueue(timeoutMs);
    });
  }

  public async readDTC(): Promise<string[]> {
    this.log("info", "Запрос кодов ошибок DTC (Mode 03)...");
    try {
      const resp = await this.sendCommand("03", 3000);
      const codes = this.parseDtcResponse(resp);
      this.sensors.dtcList = codes;
      this.notifySensors();
      this.log("info", `Обнаружено ошибок: ${codes.length} [${codes.join(", ") || "Чисто"}]`);
      return codes;
    } catch (e: any) {
      this.log("info", "Ошибка чтения DTC: " + e.message);
      return [];
    }
  }

  public async clearDTC(): Promise<boolean> {
    this.log("info", "Очистка кодов ошибок (Mode 04)...");
    try {
      await this.sendCommand("04", 3000);
      this.sensors.dtcList = [];
      this.notifySensors();
      this.log("info", "Коды ошибок очищены (память ЭБУ сброшена)");
      return true;
    } catch (e: any) {
      this.log("info", "Не удалось сбросить ошибки: " + e.message);
      return false;
    }
  }

  private async initializeELM(): Promise<void> {
    this.statusMessage = "Инициализация адаптера ELM327...";
    this.notifyStatus();
    try {
      await this.sendCommand("ATZ");
      await this.sleep(250);
      await this.sendCommand("ATE0");
      await this.sendCommand("ATL0");
      await this.sendCommand("ATH0");
      await this.sendCommand("ATSP0");
      await this.sendCommand("0100");
      this.status = "connected";
      this.statusMessage = "ELM327 готов • ЭБУ подключен";
      this.notifyStatus();
    } catch (e: any) {
      this.log("info", "Предупреждение при инициализации: " + e.message);
      this.status = "connected";
      this.statusMessage = "Подключено (базовый режим)";
      this.notifyStatus();
    }
  }

  private startLiveTelemetry(): void {
    if (this.isPolling) return;
    this.isPolling = true;
    const pids = [
      { cmd: "010C", handler: (v: string) => this.parseRpm(v) },
      { cmd: "010D", handler: (v: string) => this.parseSpeed(v) },
      { cmd: "0105", handler: (v: string) => this.parseCoolant(v) },
      { cmd: "0111", handler: (v: string) => this.parseThrottle(v) },
      { cmd: "0104", handler: (v: string) => this.parseLoad(v) },
      { cmd: "ATRV", handler: (v: string) => this.parseVoltage(v) }
    ];
    let index = 0;
    this.pollIntervalTimer = setInterval(async () => {
      if (!this.isPolling || this.status !== "connected") return;
      if (this.currentCommand || this.commandQueue.length > 0) return;
      const item = pids[index % pids.length];
      index++;
      try {
        const resp = await this.sendCommand(item.cmd, 1200);
        item.handler(resp);
        this.notifySensors();
      } catch (_) {}
    }, 450);
  }

  private stopPolling(): void {
    this.isPolling = false;
    if (this.pollIntervalTimer) {
      clearInterval(this.pollIntervalTimer);
      this.pollIntervalTimer = null;
    }
  }

  private startDemoSimulation(): void {
    let tick = 0;
    const sc = this.demoScenario;
    this.sensors.coolantTemp = sc.targetTemp > 95 ? 96 : 62;
    this.sensors.voltage = sc.baseVolt;
    this.sensors.dtcList = [...sc.dtcList];
    this.sensors.vin = sc.vin;

    this.demoTimer = setInterval(() => {
      tick++;
      const cur = this.demoScenario;
      const wave = Math.sin(tick * 0.16) * 140 + Math.cos(tick * 0.31) * 45;
      this.sensors.rpm = Math.max(700, Math.round(cur.baseRpm + wave + (tick % 20 === 0 ? 1200 : 0)));
      this.sensors.speed =
        cur.baseSpeed > 0
          ? Math.max(0, Math.round(cur.baseSpeed + Math.sin(tick * 0.1) * 16))
          : 0;
      if (this.sensors.coolantTemp < cur.targetTemp) {
        this.sensors.coolantTemp = Math.min(cur.targetTemp, Math.round((this.sensors.coolantTemp + 0.6) * 10) / 10);
      } else if (this.sensors.coolantTemp > cur.targetTemp) {
        this.sensors.coolantTemp = Math.max(cur.targetTemp, Math.round((this.sensors.coolantTemp - 0.5) * 10) / 10);
      }
      this.sensors.throttle = Math.min(100, Math.max(8, Math.round(12 + (this.sensors.rpm - 700) / 38)));
      this.sensors.engineLoad = Math.min(100, Math.max(15, Math.round(22 + (this.sensors.rpm - 700) / 45)));
      this.sensors.voltage = Math.round((cur.baseVolt + Math.sin(tick * 0.5) * 0.12) * 10) / 10;
      this.notifySensors();
    }, 500);
  }

  private stopDemoSimulation(): void {
    if (this.demoTimer) {
      clearInterval(this.demoTimer);
      this.demoTimer = null;
    }
  }

  private handleDemoCommand(cmd: string): string {
    const clean = cmd.trim().toUpperCase();
    this.log("out", clean);
    if (clean === "ATZ") return "ELM327 v1.5 (AIdeal Demo Simulator)";
    if (clean.startsWith("AT")) {
      if (clean === "ATRV") return `${this.sensors.voltage.toFixed(1)}V`;
      return "OK";
    }
    if (clean === "0100") return "41 00 BE 3F B8 13";
    if (clean === "010C") {
      const hex = Math.round(this.sensors.rpm * 4).toString(16).padStart(4, "0");
      return `41 0C ${hex.substring(0, 2)} ${hex.substring(2, 4)}`;
    }
    if (clean === "010D") {
      return `41 0D ${Math.round(this.sensors.speed).toString(16).padStart(2, "0")}`;
    }
    if (clean === "0105") {
      return `41 05 ${Math.round(this.sensors.coolantTemp + 40).toString(16).padStart(2, "0")}`;
    }
    if (clean === "0111") {
      return `41 11 ${Math.round((this.sensors.throttle * 255) / 100).toString(16).padStart(2, "0")}`;
    }
    if (clean === "0104") {
      return `41 04 ${Math.round((this.sensors.engineLoad * 255) / 100).toString(16).padStart(2, "0")}`;
    }
    if (clean === "03") {
      return this.sensors.dtcList.length > 0 ? this.demoScenario.mode03Hex : "43 00 00";
    }
    if (clean === "04") {
      this.sensors.dtcList = [];
      this.notifySensors();
      return "44 OK";
    }
    if (clean === "0902") {
      const hexVin = this.demoScenario.vin
        .split("")
        .map(ch => ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"))
        .join(" ");
      return `49 02 01 ${hexVin}`;
    }
    return "41 00 00";
  }

  public async readVIN(): Promise<string> {
    if (this.connectionType === "demo") {
      this.sensors.vin = this.demoScenario.vin;
      this.notifySensors();
      return this.sensors.vin;
    }
    if (this.status !== "connected") return "";
    try {
      const resp = await this.sendCommand("0902", 2500);
      const clean = resp.replace(/\d+:/g, "").replace(/\s+/g, "").toUpperCase();
      const idx = clean.indexOf("4902");
      if (idx === -1) return "";
      const hexData = clean.substring(idx + 6);
      let vin = "";
      for (let i = 0; i + 1 < hexData.length; i += 2) {
        const code = parseInt(hexData.substring(i, i + 2), 16);
        if (code >= 48 && code <= 90) vin += String.fromCharCode(code);
      }
      if (vin.length >= 11) {
        this.sensors.vin = vin.slice(0, 17);
        this.notifySensors();
        return this.sensors.vin;
      }
    } catch (_) {}
    return "";
  }

  private parseRpm(hexStr: string): void {
    const b = this.extractDataBytes(hexStr, "41 0C");
    if (b.length >= 2) this.sensors.rpm = Math.round((b[0] * 256 + b[1]) / 4);
  }

  private parseSpeed(hexStr: string): void {
    const b = this.extractDataBytes(hexStr, "41 0D");
    if (b.length >= 1) this.sensors.speed = b[0];
  }

  private parseCoolant(hexStr: string): void {
    const b = this.extractDataBytes(hexStr, "41 05");
    if (b.length >= 1) this.sensors.coolantTemp = b[0] - 40;
  }

  private parseThrottle(hexStr: string): void {
    const b = this.extractDataBytes(hexStr, "41 11");
    if (b.length >= 1) this.sensors.throttle = Math.round((b[0] * 100) / 255);
  }

  private parseLoad(hexStr: string): void {
    const b = this.extractDataBytes(hexStr, "41 04");
    if (b.length >= 1) this.sensors.engineLoad = Math.round((b[0] * 100) / 255);
  }

  private parseVoltage(val: string): void {
    const m = val.match(/([0-9]+\.?[0-9]*)\s*V?/i);
    if (m) this.sensors.voltage = parseFloat(m[1]);
  }

  public parseDtcResponse(raw: string): string[] {
    const clean = raw.replace(/\d+:/g, "").replace(/\s+/g, "").toUpperCase();
    const codes: string[] = [];
    const idx = clean.indexOf("43");
    if (idx === -1) return codes;
    let data = clean.substring(idx + 2);
    if (data.length % 4 === 2) data = data.substring(2);
    for (let i = 0; i + 3 < data.length; i += 4) {
      const b1 = parseInt(data.substring(i, i + 2), 16);
      const b2 = parseInt(data.substring(i + 2, i + 4), 16);
      if (isNaN(b1) || isNaN(b2) || (b1 === 0 && b2 === 0)) continue;
      const sysType = (b1 >> 6) & 0x03;
      const prefix = sysType === 1 ? "C" : sysType === 2 ? "B" : sysType === 3 ? "U" : "P";
      const d1 = (b1 >> 4) & 0x03;
      const d2 = b1 & 0x0f;
      const d3 = (b2 >> 4) & 0x0f;
      const d4 = b2 & 0x0f;
      const dtc = `${prefix}${d1}${d2.toString(16)}${d3.toString(16)}${d4.toString(16)}`.toUpperCase();
      if (!codes.includes(dtc)) codes.push(dtc);
    }
    return codes;
  }

  private extractDataBytes(str: string, prefix: string): number[] {
    const parts = str.replace(/[\r\n>]/g, " ").trim().split(/\s+/);
    const prefParts = prefix.split(/\s+/);
    let startIdx = -1;
    for (let i = 0; i <= parts.length - prefParts.length; i++) {
      let match = true;
      for (let j = 0; j < prefParts.length; j++) {
        if (parts[i + j].toUpperCase() !== prefParts[j].toUpperCase()) {
          match = false;
          break;
        }
      }
      if (match) {
        startIdx = i + prefParts.length;
        break;
      }
    }
    if (startIdx === -1) return [];
    return parts.slice(startIdx).map(p => parseInt(p, 16)).filter(n => !isNaN(n));
  }

  private async processQueue(timeoutMs: number): Promise<void> {
    if (this.currentCommand || this.commandQueue.length === 0) return;
    const item = this.commandQueue.shift()!;
    this.currentCommand = {
      cmd: item.cmd,
      resolve: item.resolve,
      reject: item.reject,
      lines: []
    };
    this.log("out", item.cmd);
    let finished = false;
    this.currentCommandTimeout = setTimeout(() => {
      if (!finished && this.currentCommand) {
        finished = true;
        const cur = this.currentCommand;
        this.currentCommand = null;
        if (cur.lines.length > 0) cur.resolve(cur.lines.join(" "));
        else cur.reject(new Error(`Таймаут команды ${cur.cmd}`));
        void this.processQueue(timeoutMs);
      }
    }, timeoutMs);

    try {
      if (this.connectionType === "bluetooth") await this.bluetoothDriver.sendCommand(item.cmd);
      else if (this.connectionType === "serial") await this.serialDriver.sendCommand(item.cmd);
    } catch (err: any) {
      if (!finished) {
        finished = true;
        if (this.currentCommandTimeout) clearTimeout(this.currentCommandTimeout);
        this.currentCommand = null;
        item.reject(err);
        void this.processQueue(timeoutMs);
      }
    }
  }

  private handleIncomingLine(line: string): void {
    this.log("in", line);
    if (this.currentCommand) this.currentCommand.lines.push(line);
  }

  private handlePrompt(): void {
    if (this.currentCommand) {
      if (this.currentCommandTimeout) {
        clearTimeout(this.currentCommandTimeout);
        this.currentCommandTimeout = null;
      }
      const cur = this.currentCommand;
      this.currentCommand = null;
      cur.resolve(cur.lines.join(" "));
      void this.processQueue(1500);
    }
  }

  private handleTransportStatus(st: OBDConnectionStatus, msg?: string): void {
    this.status = st;
    if (msg) this.statusMessage = msg;
    this.notifyStatus();
  }

  private notifyStatus(): void {
    this.onStatusChange?.(this.status, this.statusMessage);
  }

  private notifySensors(): void {
    this.onSensorsUpdate?.({ ...this.sensors });
  }

  private log(dir: "in" | "out" | "info", text: string): void {
    this.onLog?.(dir, text);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }
}

export const obdProtocol = new ELM327Protocol();
