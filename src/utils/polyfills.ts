/**
 * Полифиллы и безопасные утилиты времени/кодировки для QuickJS, JSC, Wasm и Web.
 * Исправлена многобайтовая UTF-8 кодировка (кириллица) для TextEncoder / TextDecoder,
 * а также добавлено форматирование дат без зависимости от Intl (отсутствует на Android QuickJS).
 *
 * Лицензия: GNU General Public License v3.0 (GPL-3.0).
 */

const g: any =
  typeof globalThis !== "undefined"
    ? globalThis
    : typeof window !== "undefined"
    ? window
    : {};

if (typeof g.TextDecoder === "undefined") {
  g.TextDecoder = class TextDecoder {
    public encoding: string;
    constructor(encoding: string = "utf-8") {
      this.encoding = (encoding || "utf-8").toLowerCase();
    }
    decode(buf?: ArrayBuffer | ArrayBufferView | null): string {
      if (!buf) return "";
      const u8: Uint8Array =
        buf instanceof Uint8Array
          ? buf
          : ArrayBuffer.isView(buf)
          ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
          : new Uint8Array(buf as ArrayBuffer);

      if (this.encoding === "ascii" || this.encoding === "latin1") {
        let out = "";
        for (let i = 0; i < u8.length; i++) out += String.fromCharCode(u8[i]);
        return out;
      }

      // Полноценный декодер UTF-8 (поддерживает кириллицу и 4-байтовые символы)
      let out = "";
      let i = 0;
      while (i < u8.length) {
        const c = u8[i++];
        if (c < 0x80) {
          out += String.fromCharCode(c);
        } else if ((c & 0xe0) === 0xc0 && i < u8.length) {
          const c2 = u8[i++];
          out += String.fromCharCode(((c & 0x1f) << 6) | (c2 & 0x3f));
        } else if ((c & 0xf0) === 0xe0 && i + 1 < u8.length) {
          const c2 = u8[i++];
          const c3 = u8[i++];
          out += String.fromCharCode(((c & 0x0f) << 12) | ((c2 & 0x3f) << 6) | (c3 & 0x3f));
        } else if ((c & 0xf8) === 0xf0 && i + 2 < u8.length) {
          const c2 = u8[i++];
          const c3 = u8[i++];
          const c4 = u8[i++];
          let cp =
            ((c & 0x07) << 18) |
            ((c2 & 0x3f) << 12) |
            ((c3 & 0x3f) << 6) |
            (c4 & 0x3f);
          cp -= 0x10000;
          out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
        } else {
          out += "\uFFFD";
        }
      }
      return out;
    }
  };
}

if (typeof g.TextEncoder === "undefined") {
  g.TextEncoder = class TextEncoder {
    encode(input: string = ""): Uint8Array {
      const str = String(input);
      const bytes: number[] = [];
      for (let i = 0; i < str.length; i++) {
        let code = str.charCodeAt(i);
        if (code < 0x80) {
          bytes.push(code);
        } else if (code < 0x800) {
          bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
        } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
          const next = str.charCodeAt(++i);
          const cp = 0x10000 + (((code - 0xd800) << 10) | (next - 0xdc00));
          bytes.push(
            0xf0 | (cp >> 18),
            0x80 | ((cp >> 12) & 0x3f),
            0x80 | ((cp >> 6) & 0x3f),
            0x80 | (cp & 0x3f)
          );
        } else {
          bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
        }
      }
      return new Uint8Array(bytes);
    }
  };
}

function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

/**
 * Форматирует время ЧЧ:ММ безопасно для QuickJS на Android (без Intl).
 */
export function formatTimeRu(ms?: number): string {
  const d = ms !== undefined ? new Date(ms) : new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * Форматирует дату ДД.ММ.ГГГГ ЧЧ:ММ безопасно для всех платформ le.codes.
 */
export function formatDateTimeRu(ms?: number): string {
  const d = ms !== undefined ? new Date(ms) : new Date();
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()} ${pad2(
    d.getHours()
  )}:${pad2(d.getMinutes())}`;
}

export function generateUuidV4(): string {
  if (typeof crypto !== "undefined" && typeof (crypto as any).randomUUID === "function") {
    try {
      return (crypto as any).randomUUID();
    } catch (_) {}
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export const TextDecoderPolyfill = g.TextDecoder;
export const TextEncoderPolyfill = g.TextEncoder;
