/**
 * Драйвер Web Serial API для подключения к проводным сканерам ELM327 USB / COM-портам.
 *
 * Лицензия: GNU General Public License v3.0 (GPL-3.0).
 */

import { OBDTransportCallbacks } from "./WebBluetoothOBD";

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

export class WebSerialOBD {
  public static readonly SUPPORTED_BAUD_RATES = [38400, 115200, 9600, 230400, 500000];

  private port: any = null;
  private reader: any = null;
  private writer: any = null;
  private keepReading: boolean = false;
  private callbacks: OBDTransportCallbacks;
  private buffer: string = "";

  constructor(callbacks: OBDTransportCallbacks) {
    this.callbacks = callbacks;
  }

  public static isSupported(): boolean {
    return typeof navigator !== "undefined" && "serial" in navigator;
  }

  public async connect(baudRate: number = 38400): Promise<boolean> {
    if (!WebSerialOBD.isSupported()) {
      const err = new Error("Web Serial доступен только в десктоп-браузерах Chrome/Edge.");
      this.callbacks.onError(err);
      this.callbacks.onStatus("error", err.message);
      return false;
    }

    try {
      this.callbacks.onStatus("connecting", "Выбор COM-порта сканера...");
      const nav = navigator as any;
      this.port = await nav.serial.requestPort();
      if (!this.port) {
        this.callbacks.onStatus("disconnected", "Порт не выбран");
        return false;
      }

      this.callbacks.onStatus("connecting", `Открытие порта (${baudRate} бод)...`);
      await this.port.open({ baudRate, dataBits: 8, stopBits: 1, parity: "none", bufferSize: 4096 });
      this.writer = this.port.writable.getWriter();
      this.keepReading = true;
      void this.startReadLoop();
      this.callbacks.onStatus("connected", `Подключено: USB/Serial (${baudRate} бод)`);
      return true;
    } catch (err: any) {
      this.callbacks.onError(err);
      this.callbacks.onStatus("error", err.message || "Ошибка подключения Serial");
      this.cleanup();
      return false;
    }
  }

  public async sendCommand(cmd: string): Promise<void> {
    if (!this.writer) throw new Error("Serial соединение не открыто");
    await this.writer.write(encodeAscii(cmd.trim() + "\r"));
  }

  public async disconnect(): Promise<void> {
    this.keepReading = false;
    try {
      if (this.reader) await this.reader.cancel().catch(() => {});
      if (this.writer) {
        await this.writer.close().catch(() => {});
        try {
          this.writer.releaseLock();
        } catch (_) {}
        this.writer = null;
      }
      await new Promise<void>(r => setTimeout(() => r(), 50));
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
          if (done) break;
          if (value) this.handleIncomingChunk(decodeAscii(value));
        }
      } catch (err: any) {
        if (this.keepReading) this.callbacks.onError(err);
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
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.keepReading = false;
    this.buffer = "";
  }
}
