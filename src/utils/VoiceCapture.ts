// ИИдеал Авто — Unified Voice (ГС) & Engine Acoustics Capture (2026-11-28)
// Copyright (C) 2026 ИИдеал Авто (LeCodes48 Edition)
// Licensed under the GNU General Public License v3.0 (GPL-3.0).

import type { AcousticAnalysisMetrics } from "../types";

export interface VoiceCaptureOutcome {
  transcript: string;
  file?: File;
  mimeType?: string;
  durationSec: number;
  acoustic?: AcousticAnalysisMetrics;
  source: "speech" | "recorder";
}

export interface VoiceSessionCallbacks {
  onInterimText?: (text: string) => void;
  onStatus?: (status: string) => void;
  onLevel?: (level: number) => void;
  onAutoCompleted?: (outcome: VoiceCaptureOutcome) => void | Promise<void>;
  onError?: (reason: string) => void;
}

export function computeAcousticMetrics(
  durationMs: number,
  levels: number[],
  pitches: { frequency: number; clarity: number }[]
): AcousticAnalysisMetrics {
  const durationSec = Math.max(0.5, Math.round((durationMs / 1000) * 10) / 10);
  const maxLvl = levels.length > 0 ? Math.max(...levels) : 0.08;
  const avgLvl =
    levels.length > 0 ? levels.reduce((a, b) => a + b, 0) / levels.length : 0.05;
  const peakDb = Math.max(-60, Math.min(0, Math.round(20 * Math.log10(Math.max(0.001, maxLvl)))));

  const validPitches = pitches.filter((p) => p.frequency > 35 && p.clarity >= 0.25);
  let avgHz = 0;
  let peakHz = 0;
  let avgClarity = 0;
  let noteLabel = "";

  if (validPitches.length > 0) {
    avgHz = Math.round(
      validPitches.reduce((acc, p) => acc + p.frequency, 0) / validPitches.length
    );
    peakHz = Math.round(Math.max(...validPitches.map((p) => p.frequency)));
    avgClarity =
      Math.round(
        (validPitches.reduce((acc, p) => acc + p.clarity, 0) / validPitches.length) * 100
      ) / 100;
    try {
      const n = AudioRecorder.note(avgHz);
      if (n) noteLabel = `${n.name}${n.octave}`;
    } catch {}
  }

  // Evaluate amplitude impulsiveness (spikes vs steady hum)
  const crest = avgLvl > 0.005 ? maxLvl / avgLvl : 1.2;
  let acousticHint = "Аудиозапись голоса / работы узла приложена";
  if (peakHz >= 1800) {
    acousticHint = `Высокочастотный писк/свист (~${peakHz} Гц) — возможен ремень, ролик или подсос воздуха`;
  } else if (crest > 2.6 && maxLvl > 0.25) {
    acousticHint = `Импульсные пики (${peakDb} dBFS, пик/средн. ${crest.toFixed(1)}x) — возможен циклический стук/цокот`;
  } else if (avgHz > 0 && avgHz <= 140) {
    acousticHint = `Низкочастотный гул/детонация (~${avgHz} Гц, ${peakDb} dBFS)`;
  }

  return {
    durationSec,
    avgHz,
    peakHz,
    clarity: avgClarity,
    peakDb,
    noteLabel,
    acousticHint,
  };
}

export class UnifiedVoiceSession {
  private speech: any = null;
  private recorder: any = null;
  private active = false;
  private mode: "speech" | "recorder" | null = null;
  private latestTranscript = "";
  private startedAt = 0;
  private levels: number[] = [];
  private pitches: { frequency: number; clarity: number }[] = [];
  private callbacks: VoiceSessionCallbacks = {};
  private manualStopping = false;

  public isActive(): boolean {
    return this.active;
  }

  public async startSpeechFirst(callbacks: VoiceSessionCallbacks): Promise<boolean> {
    if (this.active) return true;
    this.callbacks = callbacks;
    this.latestTranscript = "";
    this.levels = [];
    this.pitches = [];
    this.startedAt = Date.now();
    this.manualStopping = false;

    // 1. Сначала пробовать распознавание речи SpeechRecognizer (ru-RU), чтобы ГС сразу имело точный текст для онлайн LLM
    if (typeof SpeechRecognizer !== "undefined" && SpeechRecognizer.supported) {
      try {
        const sp = new SpeechRecognizer();
        let settled = false;
        this.speech = sp;
        this.mode = "speech";
        this.active = true;

        sp.addEventListener("result", (res: any) => {
          const txt = String(res?.transcript || "").trim();
          if (txt) {
            this.latestTranscript = txt;
            this.callbacks.onInterimText?.(txt);
            this.callbacks.onStatus?.(`Речь: ${txt}`);
          }
        });

        sp.addEventListener("end", () => {
          if (settled) return;
          settled = true;
          const hadManualStop = this.manualStopping;
          const outText = this.latestTranscript.trim();
          const sec = Math.max(0.8, Math.round(((Date.now() - this.startedAt) / 1000) * 10) / 10);
          this.cleanup();
          if (!hadManualStop && this.callbacks.onAutoCompleted) {
            void this.callbacks.onAutoCompleted({
              transcript: outText,
              durationSec: sec,
              source: "speech",
            });
          }
        });

        sp.addEventListener("error", async (_code: any, msg: string) => {
          if (settled) return;
          settled = true;
          this.cleanup();
          // Если распознаватель не сработал и есть AudioRecorder — прозрачно переходим на запись аудиофайла
          if (!this.manualStopping && typeof AudioRecorder !== "undefined" && AudioRecorder.supported) {
            const startedRec = await this.startRecorderOnly(callbacks);
            if (startedRec) return;
          }
          this.callbacks.onError?.(msg || "Ошибка микрофона");
        });

        await sp.start({ language: "ru-RU", continuous: true, interimResults: true });
        this.callbacks.onStatus?.("Говорите ГС по-русски...");
        return true;
      } catch {
        this.cleanup();
      }
    }

    // 2. Резерв или явная запись аудиофайла через AudioRecorder (.m4a + измерение уровня/частоты)
    return this.startRecorderOnly(callbacks);
  }

  public async startRecorderOnly(callbacks: VoiceSessionCallbacks): Promise<boolean> {
    if (this.active) return true;
    if (typeof AudioRecorder === "undefined" || !AudioRecorder.supported) {
      return false;
    }

    this.callbacks = callbacks;
    this.latestTranscript = "";
    this.levels = [];
    this.pitches = [];
    this.startedAt = Date.now();
    this.manualStopping = false;

    try {
      const rec = new AudioRecorder();
      this.recorder = rec;
      this.mode = "recorder";
      this.active = true;

      rec.addEventListener("level", (v: number) => {
        if (typeof v === "number" && Number.isFinite(v)) {
          this.levels.push(v);
          this.callbacks.onLevel?.(v);
        }
      });
      rec.addEventListener("pitch", (p: { frequency: number; clarity: number }) => {
        if (p && typeof p.frequency === "number") {
          this.pitches.push({ frequency: p.frequency, clarity: p.clarity || 0 });
        }
      });
      rec.addEventListener("ended", async () => {
        if (this.manualStopping) return;
        const out = await this.finishRecorderInternal();
        if (out && this.callbacks.onAutoCompleted) {
          void this.callbacks.onAutoCompleted(out);
        }
      });

      await rec.start({ file: true, raw: true, rate: 20, maxDuration: 35000 });
      this.callbacks.onStatus?.("Идет запись звука (.m4a + спектр)...");
      return true;
    } catch (err: any) {
      this.cleanup();
      this.callbacks.onError?.(err?.message || "Не удалось запустить запись звука");
      return false;
    }
  }

  private async finishRecorderInternal(): Promise<VoiceCaptureOutcome | null> {
    const rec = this.recorder;
    if (!rec) {
      this.cleanup();
      return null;
    }
    try {
      const res = await rec.stop();
      const durationMs = Number(res?.duration || Date.now() - this.startedAt || 1200);
      const acoustic = computeAcousticMetrics(durationMs, this.levels, this.pitches);
      this.cleanup();
      return {
        transcript: this.latestTranscript.trim(),
        file: res?.file || undefined,
        mimeType: res?.mimeType || "audio/mp4",
        durationSec: acoustic.durationSec,
        acoustic,
        source: "recorder",
      };
    } catch {
      this.cleanup();
      return null;
    }
  }

  public async stop(): Promise<VoiceCaptureOutcome | null> {
    if (!this.active) return null;
    this.manualStopping = true;

    if (this.mode === "recorder") {
      return this.finishRecorderInternal();
    }

    const sp = this.speech;
    const outText = this.latestTranscript.trim();
    const sec = Math.max(0.8, Math.round(((Date.now() - this.startedAt) / 1000) * 10) / 10);
    try {
      sp?.stop?.();
    } catch {}
    // Allow brief settle for final partial->final event when stopping
    await new Promise<void>((r) => setTimeout(() => r(), 160));
    const settledText = this.latestTranscript.trim() || outText;
    this.cleanup();
    return {
      transcript: settledText,
      durationSec: sec,
      source: "speech",
    };
  }

  public abort(): void {
    this.manualStopping = true;
    try {
      this.speech?.abort?.();
    } catch {}
    try {
      this.recorder?.cancel?.();
    } catch {}
    this.cleanup();
  }

  private cleanup(): void {
    this.active = false;
    this.mode = null;
    this.speech = null;
    this.recorder = null;
  }
}
