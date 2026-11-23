/**
 * Драйвер Web Bluetooth API для подключения к беспроводным сканерам ELM327 BLE / Bluetooth 4.0+.
 * Работает непосредственно в современных браузерах (Chrome, Edge, Opera, мобильный Chrome на Android).
 */

export interface OBDTransportCallbacks {
  onLine: (line: string) => void;
  onPrompt?: () => void;
  onStatus: (status: "disconnected" | "connecting" | "connected" | "error", message?: string) => void;
  onError: (error: Error) => void;
}

const COMMON_BLE_SERVICES = [
  "0000ffe0-0000-1000-8000-00805f9b34fb", // Популярный UART/SPP (Viecar, vLinker, клоны ELM327)
  "0000fff0-0000-1000-8000-00805f9b34fb", // Альтернативный SPP сервис
  "6e400001-b5a3-f393-e0a9-e50e24dcca9e", // Nordic UART Service (NUS)
  "000018f0-0000-1000-8000-00805f9b34fb",
  "e7810a71-73ae-499d-8c15-faa9aef0c3f2",
  "0000dfb0-0000-1000-8000-00805f9b34fb", // Bluno / DFRobot BLE
  "0000fee0-0000-1000-8000-00805f9b34fb",
  "49535343-fe7d-4ae5-8fa9-9fafd205e455"  // ISSC Microchip BLE UART
];

export class WebBluetoothOBD {
  private device: any = null;
  private server: any = null;
  private txCharacteristic: any = null;
  private rxCharacteristic: any = null;
  private callbacks: OBDTransportCallbacks;
  private buffer: string = "";
  private decoder = new TextDecoder("ascii");
  private encoder = new TextEncoder();

  constructor(callbacks: OBDTransportCallbacks) {
    this.callbacks = callbacks;
  }

  public static isSupported(): boolean {
    return typeof navigator !== "undefined" && "bluetooth" in navigator;
  }

  public async connect(): Promise<boolean> {
    if (!WebBluetoothOBD.isSupported()) {
      const err = new Error("Web Bluetooth API не поддерживается в данном браузере. Используйте Chrome или Edge.");
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

      // Ищем рабочий UART сервис среди поддерживаемых
      let targetService: any = null;
      for (const uuid of COMMON_BLE_SERVICES) {
        try {
          targetService = await this.server.getPrimaryService(uuid);
          if (targetService) break;
        } catch (_) {
          // Ищем следующий
        }
      }

      if (!targetService) {
        try {
          const services = await this.server.getPrimaryServices();
          if (services && services.length > 0) {
            targetService = services[0];
          }
        } catch (_) {}
      }

      if (!targetService) {
        throw new Error("Не найден совместимый UART/SPP сервис на выбранном Bluetooth устройстве");
      }

      const characteristics = await targetService.getCharacteristics();
      for (const char of characteristics) {
        const props = char.properties;
        const uuid = (char.uuid || "").toLowerCase();

        // Специфичные UUID для Nordic UART Service:
        // 6e400002 - RX (центральное устройство пишет в адаптер)
        // 6e400003 - TX (адаптер шлет уведомления)
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

      if (!this.txCharacteristic && this.rxCharacteristic) {
        this.txCharacteristic = this.rxCharacteristic;
      } else if (!this.rxCharacteristic && this.txCharacteristic) {
        this.rxCharacteristic = this.txCharacteristic;
      }

      if (!this.rxCharacteristic || !this.txCharacteristic) {
        throw new Error("Не удалось инициализировать каналы RX/TX на Bluetooth адаптере");
      }

      // Подписываемся на входящие уведомления от адаптера
      await this.rxCharacteristic.startNotifications();
      this.rxCharacteristic.addEventListener("characteristicvaluechanged", (event: any) => {
        const value = event.target.value;
        const text = this.decoder.decode(value);
        this.handleIncomingChunk(text);
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
    if (!this.txCharacteristic) {
      throw new Error("Bluetooth соединение не установлено");
    }
    const cleanCmd = cmd.trim() + "\r";
    const data = this.encoder.encode(cleanCmd);
    try {
      if (this.txCharacteristic.properties.writeWithoutResponse) {
        await this.txCharacteristic.writeValueWithoutResponse(data);
      } else {
        await this.txCharacteristic.writeValue(data);
      }
    } catch (err: any) {
      this.callbacks.onError(err);
      throw err;
    }
  }

  public async disconnect(): Promise<void> {
    if (this.device && this.device.gatt && this.device.gatt.connected) {
      this.device.gatt.disconnect();
    }
    this.cleanup();
    this.callbacks.onStatus("disconnected", "Отключено пользователем");
  }

  private handleIncomingChunk(chunk: string): void {
    this.buffer += chunk;

    // ELM327 возвращает ответ с символом prompt '>' в конце
    while (this.buffer.includes(">")) {
      const promptIdx = this.buffer.indexOf(">");
      const segment = this.buffer.substring(0, promptIdx);
      this.buffer = this.buffer.substring(promptIdx + 1);

      const lines = segment.split(/[\r\n]+/);
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (line.length > 0) {
          this.callbacks.onLine(line);
        }
      }

      if (this.callbacks.onPrompt) {
        this.callbacks.onPrompt();
      }
    }

    if (this.buffer.includes("\r") || this.buffer.includes("\n")) {
      const lastNl = Math.max(this.buffer.lastIndexOf("\r"), this.buffer.lastIndexOf("\n"));
      const completedText = this.buffer.substring(0, lastNl);
      this.buffer = this.buffer.substring(lastNl + 1);

      const lines = completedText.split(/[\r\n]+/);
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (line.length > 0) {
          this.callbacks.onLine(line);
        }
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
