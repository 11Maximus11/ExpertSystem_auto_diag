/**
 * Высокоуровневый контроллер протокола ELM327 и OBD-II телеметрии.
 * Объединяет Web Bluetooth, Web Serial и виртуальный Демо-режим (симулятор ЭБУ).
 * Реализует:
 * - Инициализацию адаптера (ATZ, ATE0, ATL0, ATH0, ATSP0)
 * - Чтение PIDs Mode 01 (RPM, скорость, температура ОЖ, дроссель, нагрузка, напряжение АКБ)
 * - Чтение и сброс ошибок DTC Mode 03 / Mode 07 / Mode 04 (P0300, C0050, P0171 и т.д.)
 * - Фоновый опрос датчиков в реальном времени
 */

import { OBDConnectionStatus, OBDConnectionType, OBDLiveSensors } from "../types";
import { WebBluetoothOBD } from "./WebBluetoothOBD";
import { WebSerialOBD } from "./WebSerialOBD";

interface PendingCommand {
  cmd: string;
  resolve: (res: string) => void;
  reject: (err: Error) => void;
  lines: string[];
}

export class ELM327Protocol {
  private status: OBDConnectionStatus = "disconnected";
  private statusMessage: string = "Не подключено";
  private connectionType: OBDConnectionType = "bluetooth";
  
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
      onLine: (line) => this.handleIncomingLine(line),
      onPrompt: () => this.handlePrompt(),
      onStatus: (st, msg) => this.handleTransportStatus(st, msg),
      onError: (err) => this.log("info", "BT Error: " + err.message)
    });

    this.serialDriver = new WebSerialOBD({
      onLine: (line) => this.handleIncomingLine(line),
      onPrompt: () => this.handlePrompt(),
      onStatus: (st, msg) => this.handleTransportStatus(st, msg),
      onError: (err) => this.log("info", "Serial Error: " + err.message)
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

  /**
   * Подключение через выбранный транспорт (Bluetooth, Serial или Demo)
   */
  public async connect(type: OBDConnectionType, baudRate: number = 38400): Promise<boolean> {
    await this.disconnect();
    this.connectionType = type;

    if (type === "demo") {
      this.status = "connected";
      this.statusMessage = "Демо-режим (Виртуальный симулятор ЭБУ)";
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

  /**
   * Отправка команды адаптеру с ожиданием ответа
   */
  public async sendCommand(cmd: string, timeoutMs: number = 1800): Promise<string> {
    if (this.connectionType === "demo") {
      return this.handleDemoCommand(cmd);
    }

    return new Promise((resolve, reject) => {
      this.commandQueue.push({ cmd, resolve, reject });
      this.processQueue(timeoutMs);
    });
  }

  /**
   * Чтение сохраненных диагностических кодов неисправностей (Mode 03)
   */
  public async readDTC(): Promise<string[]> {
    this.log("info", "Запрос кодов ошибок DTC (Mode 03)...");
    try {
      const resp = await this.sendCommand("03", 3000);
      const codes = this.parseDtcResponse(resp);
      this.sensors.dtcList = codes;
      this.notifySensors();
      this.log("info", `Обнаружено кодов неисправностей: ${codes.length} [${codes.join(", ") || "Нет ошибок"}]`);
      return codes;
    } catch (e: any) {
      this.log("info", "Ошибка чтения DTC: " + e.message);
      return [];
    }
  }

  /**
   * Сброс кодов неисправностей (Mode 04 - Clear Trouble Codes)
   */
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

  /**
   * Инициализация ELM327 по стандарту OBD-II
   */
  private async initializeELM(): Promise<void> {
    this.statusMessage = "Инициализация адаптера ELM327...";
    this.notifyStatus();

    try {
      await this.sendCommand("ATZ");     // Сброс всех настроек адаптера
      await this.sleep(250);
      await this.sendCommand("ATE0");    // Эхо выкл (Echo Off)
      await this.sendCommand("ATL0");    // Linefeed выкл
      await this.sendCommand("ATH0");    // Заголовки выкл (Headers Off)
      await this.sendCommand("ATSP0");   // Автоматический протокол шины (Auto Protocol)
      await this.sendCommand("0100");    // Проверка связи с ЭБУ (поддерживаемые PIDs)
      
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

  /**
   * Цикл опроса телеметрии в реальном времени (PIDs Mode 01)
   */
  private startLiveTelemetry(): void {
    if (this.isPolling) return;
    this.isPolling = true;

    const pids = [
      { cmd: "010C", handler: (val: string) => this.parseRpm(val) },
      { cmd: "010D", handler: (val: string) => this.parseSpeed(val) },
      { cmd: "0105", handler: (val: string) => this.parseCoolant(val) },
      { cmd: "0111", handler: (val: string) => this.parseThrottle(val) },
      { cmd: "0104", handler: (val: string) => this.parseLoad(val) },
      { cmd: "ATRV", handler: (val: string) => this.parseVoltage(val) },
    ];

    let index = 0;
    this.pollIntervalTimer = setInterval(async () => {
      if (!this.isPolling || this.status !== "connected") return;
      if (this.currentCommand || this.commandQueue.length > 0) return; // Не мешаем ручным запросам или чтению DTC

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

  /**
   * Виртуальный симулятор для демонстрации и отладки без автомобиля
   */
  private startDemoSimulation(): void {
    let tick = 0;
    this.sensors.coolantTemp = 45;
    this.sensors.voltage = 14.1;
    this.sensors.dtcList = ["P0300", "P0171", "C0050"];

    this.demoTimer = setInterval(() => {
      tick++;
      // Реалистичная имитация оборотов ХХ + периодическая перегазовка
      const baseRpm = 820;
      const wave = Math.sin(tick * 0.15) * 160 + Math.cos(tick * 0.3) * 50;
      this.sensors.rpm = Math.max(750, Math.round(baseRpm + wave + (tick % 24 === 0 ? 1350 : 0)));
      this.sensors.speed = Math.max(0, Math.round(Math.sin(tick * 0.08) * 45 + 30));
      if (this.sensors.coolantTemp < 92) {
        this.sensors.coolantTemp += 0.5;
      }
      this.sensors.throttle = Math.min(100, Math.max(8, Math.round(12 + (this.sensors.rpm - 750) / 40)));
      this.sensors.engineLoad = Math.min(100, Math.max(15, Math.round(22 + (this.sensors.rpm - 750) / 50)));
      this.sensors.voltage = 14.0 + (Math.sin(tick) * 0.15);
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
    if (clean === "ATZ") return "ELM327 v1.5 (Demo Simulator)";
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
      const hex = this.sensors.speed.toString(16).padStart(2, "0");
      return `41 0D ${hex}`;
    }
    if (clean === "0105") {
      const hex = Math.round(this.sensors.coolantTemp + 40).toString(16).padStart(2, "0");
      return `41 05 ${hex}`;
    }
    if (clean === "0111") {
      const hex = Math.round((this.sensors.throttle * 255) / 100).toString(16).padStart(2, "0");
      return `41 11 ${hex}`;
    }
    if (clean === "0104") {
      const hex = Math.round((this.sensors.engineLoad * 255) / 100).toString(16).padStart(2, "0");
      return `41 04 ${hex}`;
    }
    if (clean === "03") return "43 03 00 01 71 40 50";
    if (clean === "04") {
      this.sensors.dtcList = [];
      this.notifySensors();
      return "44 OK";
    }
    return "41 00 00";
  }

  // --- Парсеры PIDs OBD-II (SAE J1979) ---

  private parseRpm(hexStr: string): void {
    const bytes = this.extractDataBytes(hexStr, "41 0C");
    if (bytes.length >= 2) {
      this.sensors.rpm = Math.round(((bytes[0] * 256) + bytes[1]) / 4);
    }
  }

  private parseSpeed(hexStr: string): void {
    const bytes = this.extractDataBytes(hexStr, "41 0D");
    if (bytes.length >= 1) {
      this.sensors.speed = bytes[0];
    }
  }

  private parseCoolant(hexStr: string): void {
    const bytes = this.extractDataBytes(hexStr, "41 05");
    if (bytes.length >= 1) {
      this.sensors.coolantTemp = bytes[0] - 40;
    }
  }

  private parseThrottle(hexStr: string): void {
    const bytes = this.extractDataBytes(hexStr, "41 11");
    if (bytes.length >= 1) {
      this.sensors.throttle = Math.round((bytes[0] * 100) / 255);
    }
  }

  private parseLoad(hexStr: string): void {
    const bytes = this.extractDataBytes(hexStr, "41 04");
    if (bytes.length >= 1) {
      this.sensors.engineLoad = Math.round((bytes[0] * 100) / 255);
    }
  }

  private parseVoltage(val: string): void {
    const m = val.match(/([0-9]+\.?[0-9]*)\s*V?/i);
    if (m) {
      this.sensors.voltage = parseFloat(m[1]);
    }
  }

  /**
   * Парсер кодов DTC стандарта SAE J1979 / ISO 15031-5.
   * Поддерживает одиночные и множественные коды неисправностей (Powertrain, Chassis, Body, Network).
   */
  public parseDtcResponse(raw: string): string[] {
    // Удаляем префиксы строк CAN-кадров (0:, 1: и т.д.) и пробелы
    const clean = raw.replace(/\d+:/g, "").replace(/\s+/g, "").toUpperCase();
    const codes: string[] = [];
    const idx = clean.indexOf("43");
    if (idx === -1) return codes;

    let data = clean.substring(idx + 2);
    // Если в ответе CAN нечетное количество 2-байтовых блоков (например, байт счетчика кодов)
    if (data.length % 4 === 2) {
      data = data.substring(2); // Пропускаем байт количества кодов
    }

    for (let i = 0; i + 3 < data.length; i += 4) {
      const b1 = parseInt(data.substring(i, i + 2), 16);
      const b2 = parseInt(data.substring(i + 2, i + 4), 16);
      if (isNaN(b1) || isNaN(b2) || (b1 === 0 && b2 === 0)) continue;

      let prefix = "P";
      const sysType = (b1 >> 6) & 0x03;
      if (sysType === 1) prefix = "C";
      else if (sysType === 2) prefix = "B";
      else if (sysType === 3) prefix = "U";

      const digit1 = (b1 >> 4) & 0x03;
      const digit2 = b1 & 0x0F;
      const digit3 = (b2 >> 4) & 0x0F;
      const digit4 = b2 & 0x0F;

      const dtc = `${prefix}${digit1}${digit2.toString(16)}${digit3.toString(16)}${digit4.toString(16)}`.toUpperCase();
      if (!codes.includes(dtc)) {
        codes.push(dtc);
      }
    }
    return codes;
  }

  private extractDataBytes(str: string, prefix: string): number[] {
    const clean = str.replace(/[\r\n>]/g, " ").trim();
    const parts = clean.split(/\s+/);
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
        if (cur.lines.length > 0) {
          cur.resolve(cur.lines.join(" "));
        } else {
          cur.reject(new Error(`Таймаут ответа на команду ${cur.cmd}`));
        }
        this.processQueue(timeoutMs);
      }
    }, timeoutMs);

    try {
      if (this.connectionType === "bluetooth") {
        await this.bluetoothDriver.sendCommand(item.cmd);
      } else if (this.connectionType === "serial") {
        await this.serialDriver.sendCommand(item.cmd);
      }
    } catch (err: any) {
      if (!finished && this.currentCommand) {
        finished = true;
        clearTimeout(this.currentCommandTimeout);
        const cur = this.currentCommand;
        this.currentCommand = null;
        cur.reject(err);
        this.processQueue(timeoutMs);
      }
    }
  }

  private handleIncomingLine(line: string): void {
    this.log("in", line);
    if (this.currentCommand) {
      // Игнорируем эхо отправленной команды
      if (line.replace(/\s+/g, "").toUpperCase() === this.currentCommand.cmd.replace(/\s+/g, "").toUpperCase()) {
        return;
      }
      this.currentCommand.lines.push(line);
    }
  }

  private handlePrompt(): void {
    if (this.currentCommand) {
      clearTimeout(this.currentCommandTimeout);
      const cur = this.currentCommand;
      this.currentCommand = null;
      const fullResponse = cur.lines.join(" ");
      cur.resolve(fullResponse);
      setTimeout(() => this.processQueue(1500), 10);
    }
  }

  private handleTransportStatus(st: OBDConnectionStatus, msg?: string): void {
    this.status = st;
    if (msg) this.statusMessage = msg;
    this.notifyStatus();
  }

  private notifyStatus(): void {
    if (this.onStatusChange) {
      this.onStatusChange(this.status, this.statusMessage);
    }
  }

  private notifySensors(): void {
    if (this.onSensorsUpdate) {
      this.onSensorsUpdate({ ...this.sensors });
    }
  }

  private log(direction: "in" | "out" | "info", text: string): void {
    if (this.onLog) {
      this.onLog(direction, text);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }
}

export const obdProtocol = new ELM327Protocol();
