/**
 * Драйвер Web Serial API для подключения к проводным сканерам ELM327 USB / COM-портам.
 * Поддерживает микросхемы FTDI, CH340, CP2102, Prolific, OpenPort на скоростях 38400, 115200, 9600 бод.
 */

import { OBDTransportCallbacks } from "./WebBluetoothOBD";

export class WebSerialOBD {
  public static readonly SUPPORTED_BAUD_RATES = [38400, 115200, 9600, 230400, 500000];

  private port: any = null;
  private reader: any = null;
  private writer: any = null;
  private keepReading: boolean = false;
  private callbacks: OBDTransportCallbacks;
  private buffer: string = "";
  private decoder = new TextDecoder("ascii");
  private encoder = new TextEncoder();

  constructor(callbacks: OBDTransportCallbacks) {
    this.callbacks = callbacks;
  }

  public static isSupported(): boolean {
    return typeof navigator !== "undefined" && "serial" in navigator;
  }

  public async connect(baudRate: number = 38400): Promise<boolean> {
    if (!WebSerialOBD.isSupported()) {
      const err = new Error("Web Serial API не поддерживается в данном браузере. Используйте Chrome или Edge.");
      this.callbacks.onError(err);
      this.callbacks.onStatus("error", err.message);
      return false;
    }

    try {
      this.callbacks.onStatus("connecting", "Выбор COM-порта сканера...");
      const nav = navigator as any;

      // Запрашиваем у пользователя выбор COM порта
      this.port = await nav.serial.requestPort();
      if (!this.port) {
        this.callbacks.onStatus("disconnected", "Порт не выбран");
        return false;
      }

      this.callbacks.onStatus("connecting", `Открытие порта на скорости ${baudRate} бод...`);
      await this.port.open({
        baudRate: baudRate,
        dataBits: 8,
        stopBits: 1,
        parity: "none",
        bufferSize: 4096
      });

      this.writer = this.port.writable.getWriter();
      this.keepReading = true;
      this.startReadLoop();

      this.callbacks.onStatus("connected", `Подключено: USB/Serial порт (${baudRate} бод)`);
      return true;
    } catch (err: any) {
      this.callbacks.onError(err);
      this.callbacks.onStatus("error", err.message || "Ошибка подключения Serial");
      this.cleanup();
      return false;
    }
  }

  public async sendCommand(cmd: string): Promise<void> {
    if (!this.writer) {
      throw new Error("Serial соединение не открыто");
    }
    const cleanCmd = cmd.trim() + "\r";
    const data = this.encoder.encode(cleanCmd);
    await this.writer.write(data);
  }

  public async disconnect(): Promise<void> {
    this.keepReading = false;
    try {
      if (this.reader) {
        await this.reader.cancel().catch(() => {});
      }
      if (this.writer) {
        await this.writer.close().catch(() => {});
        try {
          this.writer.releaseLock();
        } catch (_) {}
        this.writer = null;
      }
      // Ожидание завершения чтения
      await new Promise(r => setTimeout(r, 50));
      if (this.port) {
        await this.port.close().catch(() => {});
        this.port = null;
      }
    } catch (_) {}
    this.cleanup();
    this.callbacks.onStatus("disconnected", "Порт закрыт");
  }

  private async startReadLoop(): Promise<void> {
    while (this.port && this.port.readable && this.keepReading) {
      try {
        this.reader = this.port.readable.getReader();
        while (this.keepReading) {
          const { value, done } = await this.reader.read();
          if (done) {
            break;
          }
          if (value) {
            const text = this.decoder.decode(value);
            this.handleIncomingChunk(text);
          }
        }
      } catch (err: any) {
        if (this.keepReading) {
          this.callbacks.onError(err);
        }
      } finally {
        if (this.reader) {
          try {
            this.reader.releaseLock();
          } catch (_) {}
          this.reader = null;
        }
      }
    }
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
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.keepReading = false;
    this.buffer = "";
  }
}
