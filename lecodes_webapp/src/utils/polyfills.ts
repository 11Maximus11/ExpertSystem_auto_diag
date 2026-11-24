/**
 * Полифиллы базовых браузерных API для встроенного JS-рантайма (QuickJS в lecodes-core на Android).
 * Обеспечивает совместимость с TextDecoder и TextEncoder.
 *
 * Лицензия: GPL-3.0
 */

const g: any =
  typeof globalThis !== "undefined"
    ? globalThis
    : typeof window !== "undefined"
    ? window
    : typeof global !== "undefined"
    ? global
    : {};

if (typeof g.TextDecoder === "undefined") {
  g.TextDecoder = class TextDecoder {
    constructor(public encoding: string = "utf-8") {}
    decode(buf?: ArrayBuffer | ArrayBufferView | null): string {
      if (!buf) return "";
      const u8: Uint8Array =
        buf instanceof Uint8Array
          ? buf
          : ArrayBuffer.isView(buf)
          ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
          : new Uint8Array(buf as ArrayBuffer);
      let s = "";
      for (let i = 0; i < u8.length; i++) {
        s += String.fromCharCode(u8[i]);
      }
      return s;
    }
  };
}

if (typeof g.TextEncoder === "undefined") {
  g.TextEncoder = class TextEncoder {
    encode(input: string = ""): Uint8Array {
      const str = String(input);
      const u8 = new Uint8Array(str.length);
      for (let i = 0; i < str.length; i++) {
        u8[i] = str.charCodeAt(i) & 0xff;
      }
      return u8;
    }
  };
}

export const TextDecoderPolyfill = g.TextDecoder;
export const TextEncoderPolyfill = g.TextEncoder;
