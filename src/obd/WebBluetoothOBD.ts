/**
 * Драйвер Web Bluetooth API для подключения к беспроводным сканерам ELM327 BLE / Bluetooth 4.0+.
 * Поддерживается в браузерах на базе Chromium (Chrome, Edge, Opera); на мобильном раннере
 * автоматически дополняется встроенным симулятором ЭБУ.
 *
 * Лицензия: GNU General Public License v3.0 (GPL-3.0).
 */

function decodeAscii(buf?: ArrayBuffer | ArrayBufferView | null): string {
  if (!buf) return "";
  const u8 =
    buf instanceof Uint8Array
      ? buf
      : ArrayBuffer.isView(buf)
      ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
      : new Uint8Array(buf as ArrayBuffer);
  let s = "";
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return s;
}

function encodeAscii(str: string = ""): Uint8Array {
  const u8 = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) u8[i] = str.charCodeAt(i) & 0xff;
  return u8;
}

export interface OBDTransportCallbacks {
  onLine: (line: string) => void;
  onPrompt?: () => void;
  onStatus: (status: "disconnected" | "connecting" | "connected" | "error", message?: string) => void;
  onError: (error: Error) => void;
}

const COMMON_BLE_SERVICES = [
  "0000ffe0-0000-1000-8000-00805f9b34fb",
  "0000fff0-0000-1000-8000-00805f9b34fb",
  "6e400001-b5a3-f393-e0a9-e50e24dcca9e",
  "000018f0-0000-1000-8000-00805f9b34fb",
  "e7810a71-73ae-499d-8c15-faa9aef0c3f2",
  "0000dfb0-0000-1000-8000-00805f9b34fb",
  "0000fee0-0000-1000-8000-00805f9b34fb",
  "49535343-fe7d-4ae5-8fa9-9fafd205e455"
];

export class WebBluetoothOBD {
  private device: any = null;
  private server: any = null;
  private txCharacteristic: any = null;
  private rxCharacteristic: any = null;
  private callbacks: OBDTransportCallbacks;
  private buffer: string = "";

  constructor(callbacks: OBDTransportCallbacks) {
    this.callbacks = callbacks;
  }

  public static isSupported(): boolean {
    return typeof navigator !== "undefined" && "bluetooth" in navigator;
  }

  public async connect(): Promise<boolean> {
    if (!WebBluetoothOBD.isSupported()) {
      const err = new Error("Web Bluetooth доступен в Chrome/Edge. На мобильном раннере используйте Демо-ЭБУ.");
      this.callbacks.onError(err);
      this.callbacks.onStatus("error", err.message);
      return false;
    }

    try {
      this.callbacks.onStatus("connecting", "Поиск Bluetooth OBD2 устройства...");
      const nav = navigator as any;
      this.device = await nav.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: COMMON_BLE_SERVICES
      });

      if (!this.device) {
        this.callbacks.onStatus("disconnected", "Устройство не выбрано");
        return false;
      }

      this.device.addEventListener("gattserverdisconnected", () => {
        this.callbacks.onStatus("disconnected", "Связь с Bluetooth адаптером разорвана");
        this.cleanup();
      });

      this.callbacks.onStatus("connecting", `Подключение к ${this.device.name || "OBDII Адаптер"}...`);
      this.server = await this.device.gatt.connect();

      let targetService: any = null;
      for (const uuid of COMMON_BLE_SERVICES) {
        try {
          targetService = await this.server.getPrimaryService(uuid);
          if (targetService) break;
        } catch (_) {}
      }

      if (!targetService) {
        try {
          const services = await this.server.getPrimaryServices();
          if (services && services.length > 0) targetService = services[0];
        } catch (_) {}
      }

      if (!targetService) {
        throw new Error("Не найден совместимый UART/SPP сервис на выбранном Bluetooth устройстве");
      }

      const characteristics = await targetService.getCharacteristics();
      for (const char of characteristics) {
        const props = char.properties;
        const uuid = (char.uuid || "").toLowerCase();
        if (uuid.includes("6e400002")) {
          this.txCharacteristic = char;
        } else if (uuid.includes("6e400003")) {
          this.rxCharacteristic = char;
        } else {
          if ((props.write || props.writeWithoutResponse) && !this.txCharacteristic) {
            this.txCharacteristic = char;
          }
          if ((props.notify || props.indicate || props.read) && !this.rxCharacteristic) {
            this.rxCharacteristic = char;
          }
        }
      }

      if (!this.txCharacteristic && this.rxCharacteristic) this.txCharacteristic = this.rxCharacteristic;
      if (!this.rxCharacteristic && this.txCharacteristic) this.rxCharacteristic = this.txCharacteristic;

      if (!this.rxCharacteristic || !this.txCharacteristic) {
        throw new Error("Не удалось инициализировать каналы RX/TX на Bluetooth адаптере");
      }

      await this.rxCharacteristic.startNotifications();
      this.rxCharacteristic.addEventListener("characteristicvaluechanged", (event: any) => {
        this.handleIncomingChunk(decodeAscii(event.target.value));
      });

      this.callbacks.onStatus("connected", `Подключено: ${this.device.name || "ELM327 BLE"}`);
      return true;
    } catch (err: any) {
      this.callbacks.onError(err);
      this.callbacks.onStatus("error", err.message || "Ошибка подключения Bluetooth");
      this.cleanup();
      return false;
    }
  }

  public async sendCommand(cmd: string): Promise<void> {
    if (!this.txCharacteristic) throw new Error("Bluetooth соединение не установлено");
    const data = encodeAscii(cmd.trim() + "\r");
    if (this.txCharacteristic.properties.writeWithoutResponse) {
      await this.txCharacteristic.writeValueWithoutResponse(data);
    } else {
      await this.txCharacteristic.writeValue(data);
    }
  }

  public async disconnect(): Promise<void> {
    if (this.device && this.device.gatt && this.device.gatt.connected) {
      this.device.gatt.disconnect();
    }
    this.cleanup();
    this.callbacks.onStatus("disconnected", "Отключено");
  }

  private handleIncomingChunk(chunk: string): void {
    this.buffer += chunk;
    while (this.buffer.includes(">")) {
      const promptIdx = this.buffer.indexOf(">");
      const segment = this.buffer.substring(0, promptIdx);
      this.buffer = this.buffer.substring(promptIdx + 1);
      for (const rawLine of segment.split(/[\r\n]+/)) {
        const line = rawLine.trim();
        if (line.length > 0) this.callbacks.onLine(line);
      }
      this.callbacks.onPrompt?.();
    }
    if (this.buffer.includes("\r") || this.buffer.includes("\n")) {
      const lastNl = Math.max(this.buffer.lastIndexOf("\r"), this.buffer.lastIndexOf("\n"));
      const completedText = this.buffer.substring(0, lastNl);
      this.buffer = this.buffer.substring(lastNl + 1);
      for (const rawLine of completedText.split(/[\r\n]+/)) {
        const line = rawLine.trim();
        if (line.length > 0) this.callbacks.onLine(line);
      }
    }
  }

  private cleanup(): void {
    this.server = null;
    this.txCharacteristic = null;
    this.rxCharacteristic = null;
    this.device = null;
    this.buffer = "";
  }
}
