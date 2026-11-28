// ИИдеал Авто — TypeScript Environment Shims for Multi-Host Compilation (2026-11-28)
// Licensed under the GNU General Public License v3.0 (GPL-3.0).

interface TextDecoderCtor {
  new (label?: string): { decode(input?: ArrayBufferView | ArrayBuffer): string };
}

declare var TextDecoder: TextDecoderCtor | undefined;
declare var navigator: any;
declare var window: any;
declare var crypto: any;
