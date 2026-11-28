/**
 * Реактивный мост между TypeScript-состоянием «ИИдеал Авто» (appState)
 * и нативным внешним AR / VR HUD Presentation (`MainActivity.kt` / `ARHudPresentation.kt`).
 *
 * Когда подключён внешний дисплей (смарт-очки RayNeo / XREAL / Rokid / Viture, Samsung DeX
 * или эмулируемый второй экран Android), полноценный AR HUD работает непосредственно
 * на внешнем экране, а телефон выступает удобным пультом управления и чатом.
 *
 * Лицензия: GPL-3.0
 */

import { appState } from "../state/appState";

export interface ExternalDisplayInfo {
  connected: boolean;
  displayId: number;
  name: string;
  width: number;
  height: number;
  mode: "optical" | "vr";
  facing: "back" | "front";
  hasCustomPhoto: boolean;
}

export interface CapturedExternalPhoto {
  file: File;
  width: number;
  height: number;
  size: number;
  name: string;
  source: string;
}

export interface ExternalArActionEvent {
  action: string;
  mode?: "optical" | "vr";
  facing?: "back" | "front";
  messageId?: string;
  stepId?: string;
  done?: boolean;
  systemId?: number;
  name?: string;
  size?: number;
  width?: number;
  height?: number;
}

const SERVICE_NAME = "app.ar_display";

function stripMarkdownBasic(text: string): string {
  return (text || "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .trim();
}

function makeNativeFile(systemId: number, name: string, size: number): any {
  const FileCtor = File as any;
  return new FileCtor(systemId, name, size);
}

class ExternalDisplayBridge {
  private svc: any = null;
  private initialized = false;
  private syncTimer: any = null;
  private statusText = "AR-HUD готов к работе";
  private listeningFlag = false;
  private actionListeners: Array<(ev: ExternalArActionEvent) => void> = [];

  public readonly connectedSignal = signal<boolean>(false);
  public readonly infoSignal = signal<ExternalDisplayInfo>({
    connected: false,
    displayId: -1,
    name: "",
    width: 0,
    height: 0,
    mode: "optical",
    facing: "back",
    hasCustomPhoto: false
  });
  public readonly customPhotoFileSignal = signal<File | null>(null);
  public readonly customPhotoNameSignal = signal<string>("");
  public readonly attitudeSignal = signal<{ yaw: number; pitch: number; roll: number }>({
    yaw: 0,
    pitch: 0,
    roll: 0
  });

  public isSupported(): boolean {
    try {
      return typeof Service !== "undefined" && Service.supported(SERVICE_NAME);
    } catch (_) {
      return false;
    }
  }

  public init(): void {
    if (this.initialized) return;
    this.initialized = true;
    if (!this.isSupported()) return;

    try {
      this.svc = Service(SERVICE_NAME);

      this.svc.on("displayChanged", (raw: any) => {
        const info = this.normalizeInfo(raw);
        this.applyDisplayInfo(info);
        if (info.connected) {
          this.scheduleSync(true);
        }
      });

      this.svc.on("arAction", (raw: any) => {
        const ev = this.parsePayload(raw) as ExternalArActionEvent;
        if (!ev || !ev.action) return;
        if (ev.action === "setMode" && (ev.mode === "optical" || ev.mode === "vr")) {
          this.infoSignal.value = { ...this.infoSignal.value, mode: ev.mode };
        } else if (ev.action === "switchCamera" && (ev.facing === "back" || ev.facing === "front")) {
          this.infoSignal.value = { ...this.infoSignal.value, facing: ev.facing };
        } else if (ev.action === "clearGalleryPhoto") {
          this.customPhotoFileSignal.value = null;
          this.customPhotoNameSignal.value = "";
          this.infoSignal.value = { ...this.infoSignal.value, hasCustomPhoto: false };
        } else if (ev.action === "galleryPhotoPicked" && typeof ev.systemId === "number") {
          const fname = ev.name || "engine_photo.jpg";
          const fsize = ev.size || 0;
          const fileObj = makeNativeFile(ev.systemId, fname, fsize);
          this.customPhotoFileSignal.value = fileObj;
          this.customPhotoNameSignal.value = fname;
          this.infoSignal.value = { ...this.infoSignal.value, hasCustomPhoto: true };
        }
        this.actionListeners.forEach(fn => {
          try {
            fn(ev);
          } catch (_) {}
        });
      });

      this.svc.on("attitude", (raw: any) => {
        const att = this.parsePayload(raw);
        if (att && typeof att.yaw === "number") {
          this.attitudeSignal.value = {
            yaw: Math.round(att.yaw),
            pitch: Math.round(att.pitch || 0),
            roll: Math.round(att.roll || 0)
          };
        }
      });

      // Запрашиваем стартовое состояние внешнего дисплея (одновременно открывает сессию сервиса)
      void this.refreshDisplayInfo();

      // Реактивная синхронизация состояния приложения с внешним AR HUD
      effect(() => {
        const _m = appState.messagesSignal.value;
        const _l = appState.latestAssistantMessageSignal.value;
        const _a = appState.isAskingSignal.value;
        const _s = appState.currentSessionTitleSignal.value;
        const _v = appState.vehicleSignal.value;
        const _o = appState.obdStateSignal.value;
        void _m;
        void _l;
        void _a;
        void _s;
        void _v;
        void _o;
        if (this.connectedSignal.value) {
          this.scheduleSync(false);
        }
      });
    } catch (err) {
      console.warn("[ExternalDisplayBridge] init failed:", err);
    }
  }

  public onAction(listener: (ev: ExternalArActionEvent) => void): () => void {
    this.actionListeners.push(listener);
    return () => {
      this.actionListeners = this.actionListeners.filter(fn => fn !== listener);
    };
  }

  public setStatus(text: string): void {
    this.statusText = text || "AR-HUD готов к работе";
    if (this.connectedSignal.value) {
      this.scheduleSync(false);
    }
  }

  public setListening(listening: boolean): void {
    this.listeningFlag = listening;
    if (this.connectedSignal.value) {
      this.scheduleSync(false);
    }
  }

  public async refreshDisplayInfo(): Promise<ExternalDisplayInfo> {
    if (!this.svc) return this.infoSignal.value;
    try {
      const res = await this.svc.call("getDisplayInfo");
      const info = this.normalizeInfo(res);
      this.applyDisplayInfo(info);
      if (info.connected) {
        this.scheduleSync(true);
      }
      return info;
    } catch (_) {
      return this.infoSignal.value;
    }
  }

  public async setMode(mode: "optical" | "vr"): Promise<void> {
    if (!this.svc) return;
    try {
      const res = await this.svc.call("setMode", mode);
      this.applyDisplayInfo(this.normalizeInfo(res));
    } catch (_) {}
  }

  public async setCameraFacing(facing: "back" | "front"): Promise<void> {
    if (!this.svc) return;
    try {
      const res = await this.svc.call("setCameraFacing", facing);
      this.applyDisplayInfo(this.normalizeInfo(res));
    } catch (_) {}
  }

  public async setCameraEnabled(enabled: boolean): Promise<void> {
    if (!this.svc) return;
    try {
      await this.svc.call("setCameraEnabled", enabled);
    } catch (_) {}
  }

  public async pickGalleryPhoto(): Promise<CapturedExternalPhoto | null> {
    if (!this.svc) return null;
    try {
      const res = this.parsePayload(await this.svc.call("pickGalleryPhoto"));
      if (!res || res.cancelled || typeof res.systemId !== "number") {
        return null;
      }
      const name = res.name || "engine_photo.jpg";
      const size = Number(res.size || 0);
      const file = makeNativeFile(res.systemId, name, size);
      this.customPhotoFileSignal.value = file;
      this.customPhotoNameSignal.value = name;
      this.infoSignal.value = { ...this.infoSignal.value, hasCustomPhoto: true };
      return {
        file,
        width: Number(res.width || 0),
        height: Number(res.height || 0),
        size,
        name,
        source: "gallery"
      };
    } catch (_) {
      return null;
    }
  }

  public async clearCustomPhoto(): Promise<void> {
    this.customPhotoFileSignal.value = null;
    this.customPhotoNameSignal.value = "";
    if (!this.svc) return;
    try {
      const res = await this.svc.call("setCustomPhoto", "");
      this.applyDisplayInfo(this.normalizeInfo(res));
    } catch (_) {}
  }

  public async capturePhoto(): Promise<CapturedExternalPhoto | null> {
    if (!this.svc) return null;
    try {
      const res = this.parsePayload(await this.svc.call("capturePhoto"));
      if (!res || typeof res.systemId !== "number") return null;
      const name = res.name || "ar_external_frame.jpg";
      const size = Number(res.size || 0);
      const file = makeNativeFile(res.systemId, name, size);
      return {
        file,
        width: Number(res.width || 0),
        height: Number(res.height || 0),
        size,
        name,
        source: String(res.source || "camera")
      };
    } catch (_) {
      return null;
    }
  }

  public async moveWindow(target: "camera" | "assistant", dxPx: number, dyPx: number): Promise<void> {
    if (!this.svc || !this.connectedSignal.value) return;
    try {
      await this.svc.call("moveWindow", target, Math.round(dxPx), Math.round(dyPx));
    } catch (_) {}
  }

  public async resetLayout(): Promise<void> {
    if (!this.svc || !this.connectedSignal.value) return;
    try {
      await this.svc.call("resetLayout");
    } catch (_) {}
  }

  public scheduleSync(immediate: boolean = false): void {
    if (!this.svc || !this.connectedSignal.value) return;
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    if (immediate) {
      void this.pushCurrentState();
      return;
    }
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      void this.pushCurrentState();
    }, 90);
  }

  private async pushCurrentState(): Promise<void> {
    if (!this.svc || !this.connectedSignal.value) return;
    try {
      const msgs = appState.messagesSignal.value || [];
      const latestUser = [...msgs].reverse().find(m => m.role === "user");
      const latest = appState.latestAssistantMessageSignal.value;
      const checklistSource =
        latest && latest.tasks && latest.tasks.length > 0
          ? latest
          : [...msgs].reverse().find(m => m.role === "assistant" && m.tasks && m.tasks.length > 0) || latest;
      const faults =
        latest && latest.faults && latest.faults.length > 0
          ? latest.faults
          : checklistSource?.faults || [];
      const obd = appState.obdStateSignal.value;

      const payload = {
        mode: this.infoSignal.value.mode,
        sessionTitle: appState.currentSessionTitleSignal.value || "Диагностика #1",
        vehicle: appState.vehicleSignal.value || "",
        status: this.statusText,
        isAsking: !!appState.isAskingSignal.value,
        isListening: this.listeningFlag,
        obd: {
          rpm: Math.round(obd.rpm || 0),
          speed: Math.round(obd.speed || 0),
          coolantTemp: Math.round(obd.coolantTemp || 0),
          voltage: Number((obd.voltage || 12.6).toFixed(1)),
          throttle: Math.round(obd.throttle || 0)
        },
        latestUser: latestUser ? (latestUser.content || "").slice(0, 260) : "",
        isWelcome: !latest || latest.id === "msg-welcome",
        summaryTitle: latest?.summaryTitle || "",
        replyText: latest?.content ? stripMarkdownBasic(latest.content).slice(0, 1400) : "",
        followups: (latest?.followupSuggestions || []).slice(0, 2),
        faults: faults.slice(0, 4).map(f => ({
          code: f.code || "DTC",
          severity: f.severity || "warning",
          confidence: Math.round(f.confidence || 0)
        })),
        tasksMessageId: checklistSource?.id || "",
        tasks: (checklistSource?.tasks || []).slice(0, 10).map((t, idx) => ({
          id: String(t.step_number ?? t.id ?? idx + 1),
          text: t.text || "",
          done: !!t.done
        }))
      };

      await this.svc.call("syncState", payload);
    } catch (_) {}
  }

  private parsePayload(raw: any): any {
    if (typeof raw === "string") {
      try {
        return JSON.parse(raw);
      } catch (_) {
        return {};
      }
    }
    return raw || {};
  }

  private normalizeInfo(raw: any): ExternalDisplayInfo {
    const p = this.parsePayload(raw);
    return {
      connected: !!p.connected,
      displayId: typeof p.displayId === "number" ? p.displayId : -1,
      name: String(p.name || ""),
      width: Number(p.width || 0),
      height: Number(p.height || 0),
      mode: p.mode === "vr" ? "vr" : "optical",
      facing: p.facing === "front" ? "front" : "back",
      hasCustomPhoto: !!p.hasCustomPhoto
    };
  }

  private applyDisplayInfo(info: ExternalDisplayInfo): void {
    this.infoSignal.value = info;
    this.connectedSignal.value = info.connected;
  }
}

export const externalDisplayBridge = new ExternalDisplayBridge();
