/**
 * Экран приборной панели OBD-II (ELM327 BLE / USB Serial / Demo-режим).
 * Реактивные светлая и тёмная темы, живые показатели RPM/ОЖ/АКБ/Дросселя,
 * чтение и сброс ошибок DTC, определение VIN, отправка снимка в ИИ-диагност
 * и прямой запуск полноэкранного AR HUD.
 *
 * Лицензия: GPL-3.0
 */

import { obdProtocol } from "../obd/ELM327Protocol";
import { WebBluetoothOBD } from "../obd/WebBluetoothOBD";
import { WebSerialOBD } from "../obd/WebSerialOBD";
import { appState, attachObdSnapshotToStaging, stageDtcCodes } from "../state/appState";
import { OBDConnectionStatus, OBDLiveSensors } from "../types";
import {
  AppHeader,
  DtcChip,
  LucideIcon,
  MetricCard,
  openConfirmModal,
  PrimaryButton,
  SecondaryButton,
  StatusBadge,
  THEME
} from "./components";

export interface ObdScannerCallbacks {
  onOpenAr?: () => void;
  onOpenSettings?: () => void;
  onAttachToAi?: () => void;
}

export function createObdScannerScreen(callbacks?: ObdScannerCallbacks): any {
  const connStatusSignal = signal<OBDConnectionStatus>("disconnected");
  const statusTextSignal = signal<string>("ELM327 отключен");
  const rpmSignal = signal<string>("0");
  const speedSignal = signal<string>("0");
  const tempSignal = signal<string>("0");
  const throttleSignal = signal<string>("0");
  const voltSignal = signal<string>("12.6");
  const loadSignal = signal<string>("0");
  const vinSignal = signal<string>("Не определён");
  const dtcListSignal = signal<string[]>([]);
  const logLinesSignal = signal<string[]>([
    "[INFO] OBD-2 ELM327 готов к сопряжению (BLE / USB-OTG / Демо)"
  ]);
  const cmdTextSignal = signal<string>("");

  let pollTimer: any = null;

  const syncSensorsToUi = (s: OBDLiveSensors) => {
    rpmSignal.value = String(s.rpm || 0);
    speedSignal.value = String(s.speed || 0);
    tempSignal.value = String(s.coolantTemp || 0);
    throttleSignal.value = String(s.throttle || 0);
    voltSignal.value = (s.voltage || 12.6).toFixed(1);
    loadSignal.value = String(s.engineLoad || 0);
    if (s.vin) vinSignal.value = s.vin;
    dtcListSignal.value = [...(s.dtcList || [])];

    // Обновляем глобальный сигнал для мини-HUD и AR-HUD
    appState.obdStateSignal.value = {
      ...s,
      status: statusTextSignal.value
    };
  };

  obdProtocol.onStatusChange = (st, msg) => {
    connStatusSignal.value = st;
    statusTextSignal.value = msg;
    appState.obdStateSignal.value = {
      ...appState.obdStateSignal.value,
      status: msg
    };
  };

  obdProtocol.onSensorsUpdate = s => {
    syncSensorsToUi(s);
  };

  obdProtocol.onLog = (dir, text) => {
    const prefix = dir === "out" ? ">" : dir === "in" ? "<" : "*";
    const lines = [...logLinesSignal.value, `${prefix} ${text}`].slice(-30);
    logLinesSignal.value = lines;
  };

  const stopPolling = () => {};

  const startPolling = () => {};

  const handleConnectDemo = async () => {
    const ok = await obdProtocol.connect("demo");
    if (ok) {
      await obdProtocol.readDTC();
      await obdProtocol.readVIN();
      startPolling();
      toast("Демо-эмулятор ELM327 запущен");
    }
  };

  const handleConnectBt = async () => {
    if (!WebBluetoothOBD.isSupported()) {
      toast("WebBluetooth / BLE недоступен — используйте Демо-режим или USB");
      return;
    }
    const ok = await obdProtocol.connect("bluetooth");
    if (ok) {
      await obdProtocol.readDTC();
      await obdProtocol.readVIN();
      startPolling();
    }
  };

  const handleConnectUsb = async () => {
    if (!WebSerialOBD.isSupported()) {
      toast("WebSerial USB-OTG не поддерживается этим устройством");
      return;
    }
    const ok = await obdProtocol.connect("serial", 38400);
    if (ok) {
      await obdProtocol.readDTC();
      await obdProtocol.readVIN();
      startPolling();
    }
  };

  const handleDisconnect = async () => {
    stopPolling();
    await obdProtocol.disconnect();
    toast("Сканер отключён");
  };

  const header = AppHeader({
    title: "ИИДЕАЛ АВТО",
    onOpenAr: () => callbacks?.onOpenAr?.(),
    onOpenSettings: () => callbacks?.onOpenSettings?.()
  });

  // Карточка подключения к адаптеру
  const connectionCard = UIColumn(
    UIColumn(
      UIRow(
        LucideIcon("lucide:gauge", 18, () => THEME.accentCyan),
        UIText("OBD-II Сканер ELM327").style({
          color: () => THEME.textPrimary,
          fontSize: 14,
          fontWeight: "bold",
          flex: 1
        })
      ).style({ alignItems: "center", gap: 8, width: "100%" }),
      UIRow(
        StatusBadge(() => connStatusSignal.value, () => statusTextSignal.value)
      ).style({ width: "100%" })
    ).style({ gap: 6, width: "100%", marginBottom: 8 }),

    UIRow(
      PrimaryButton("BLE Сканер", handleConnectBt),
      SecondaryButton("USB ELM", handleConnectUsb, "lucide:cpu"),
      SecondaryButton("Демо ЭБУ", handleConnectDemo, "lucide:activity"),
      UIButton(
        UIRow(
          LucideIcon("lucide:x", 13, "#ffffff"),
          UIText("Откл.").style({ color: "#ffffff", fontSize: 12, fontWeight: "bold" })
        ).style({ alignItems: "center", gap: 4 })
      )
        .style({
          backgroundColor: () => THEME.statusCrit,
          paddingHorizontal: 10,
          paddingVertical: 8,
          borderRadius: 9,
          display: () => (connStatusSignal.value === "connected" ? "flex" : "none")
        })
        .onClick(handleDisconnect)
    ).style({ flexWrap: "wrap", gap: 7, width: "100%", marginBottom: 8 }),

    // Полоса VIN + кнопка AR HUD
    UIRow(
      UIText(() => `VIN: ${vinSignal.value}`).style({
        color: () => THEME.textSecondary,
        fontSize: 12,
        fontWeight: "600",
        flex: 1
      }),
      SecondaryButton(
        "Определить VIN",
        async () => {
          if (connStatusSignal.value !== "connected") {
            toast("Сначала подключите сканер или Демо ЭБУ");
            return;
          }
          const vin = await obdProtocol.readVIN();
          if (vin) {
            vinSignal.value = vin;
            if (!appState.vehicleSignal.value.includes(vin)) {
              appState.vehicleSignal.value = appState.vehicleSignal.value
                ? `${appState.vehicleSignal.value} (${vin})`
                : `VIN ${vin}`;
            }
            toast(`VIN определён: ${vin}`);
          } else {
            toast("ЭБУ не вернул VIN (Mode 09 PID 02)");
          }
        },
        "lucide:search"
      ),
      UIButton(
        UIRow(
          LucideIcon("lucide:glasses", 14, "#ffffff"),
          UIText("AR HUD").style({ color: "#ffffff", fontSize: 11, fontWeight: "bold" })
        ).style({ alignItems: "center", gap: 4 })
      )
        .style({
          backgroundColor: () => THEME.accentOrange,
          paddingHorizontal: 10,
          paddingVertical: 8,
          borderRadius: 9
        })
        .onClick(() => callbacks?.onOpenAr?.())
    ).style({ alignItems: "center", flexWrap: "wrap", gap: 7, width: "100%" })
  ).style({
    backgroundColor: () => THEME.bgSurface,
    borderWidth: 1,
    borderColor: () => THEME.borderDefault,
    borderRadius: 14,
    padding: 13,
    width: "100%"
  });

  // Сетка приборов 2x3
  const gaugesGrid = UIColumn(
    UIRow(
      MetricCard("Обороты (RPM)", () => rpmSignal.value, "об/мин", () => THEME.statusOk, "lucide:activity"),
      MetricCard("Скорость", () => speedSignal.value, "км/ч", () => THEME.accentCyan, "lucide:gauge")
    ).style({ gap: 8, width: "100%" }),
    UIRow(
      MetricCard("Температура ОЖ", () => tempSignal.value, "°C", () => THEME.statusWarn, "lucide:circle-alert"),
      MetricCard("Напряжение АКБ", () => voltSignal.value, "В", () => THEME.accentCyan, "lucide:zap")
    ).style({ gap: 8, width: "100%" }),
    UIRow(
      MetricCard("Нагрузка ДВС", () => loadSignal.value, "%", () => THEME.accentOrange, "lucide:cpu"),
      MetricCard("Дроссель TPS", () => throttleSignal.value, "%", () => THEME.accentViolet, "lucide:sliders-horizontal")
    ).style({ gap: 8, width: "100%" })
  ).style({ width: "100%", gap: 8 });

  // Секция DTC ошибок ЭБУ
  const dtcChipsRow = UIRow(() => {
    const codes = dtcListSignal.value || [];
    if (codes.length === 0) {
      return [
        UIText("Ошибки ЭБУ не считаны или память неисправностей чиста.").style({
          color: () => THEME.textMuted,
          fontSize: 12
        })
      ];
    }
    return codes.map(c =>
      DtcChip(c, () => {
        stageDtcCodes([c]);
        toast(`Код ${c} добавлен в чат`);
      })
    );
  }).style({ flexWrap: "wrap", gap: 7, width: "100%", marginVertical: 6 });

  const dtcCard = UIColumn(
    UIRow(
      LucideIcon("lucide:shield-alert", 17, () => THEME.statusCrit),
      UIText("Ошибки ЭБУ (Mode 03 / 04)").style({
        color: () => THEME.textPrimary,
        fontSize: 14,
        fontWeight: "bold",
        flex: 1
      })
    ).style({ alignItems: "center", gap: 7, width: "100%" }),
    dtcChipsRow,
    UIRow(
      SecondaryButton(
        "Считать DTC",
        async () => {
          if (connStatusSignal.value !== "connected") {
            toast("Сначала подключите сканер или Демо ЭБУ");
            return;
          }
          const codes = await obdProtocol.readDTC();
          dtcListSignal.value = codes;
          toast(codes.length > 0 ? `Считано ошибок: ${codes.length}` : "Ошибок не найдено");
        },
        "lucide:refresh-cw"
      ),
      SecondaryButton("Сброс (Mode 04)", () => {
        if (connStatusSignal.value !== "connected") {
          toast("Сканер не подключён");
          return;
        }
        openConfirmModal({
          title: "Сбросить коды ошибок ЭБУ?",
          message: "Будет отправлена команда Mode 04 и погашен индикатор Check Engine.",
          confirmLabel: "Сбросить",
          onConfirm: async () => {
            await obdProtocol.clearDTC();
            dtcListSignal.value = [];
            toast("Коды ошибок сброшены");
          }
        });
      }),
      UISpacer(),
      PrimaryButton("В запрос ИИ", () => {
        attachObdSnapshotToStaging();
        callbacks?.onAttachToAi?.();
      })
    ).style({ flexWrap: "wrap", alignItems: "center", gap: 7, width: "100%", marginTop: 4 })
  ).style({
    backgroundColor: () => THEME.bgSurface,
    borderWidth: 1,
    borderColor: () => THEME.borderDefault,
    borderRadius: 14,
    padding: 13,
    width: "100%"
  });

  // AT/PID терминал
  const cmdInput = UIInput()
    .style({
      placeholder: "AT-команда (напр. 010C, ATI, ATZ)...",
      placeholderColor: () => THEME.inputPlaceholder,
      backgroundColor: () => THEME.bgInput,
      color: () => THEME.textPrimary,
      borderWidth: 1.5,
      borderColor: () => THEME.borderStrong,
      borderRadius: 9,
      paddingHorizontal: 10,
      paddingVertical: 8,
      fontSize: 12,
      flex: 1
    })
    .onChange((v: string) => {
      cmdTextSignal.value = v;
    });

  const terminalCard = UIColumn(
    UIText("Терминал ELM327 / Лог команд").style({
      color: () => THEME.textPrimary,
      fontSize: 13,
      fontWeight: "bold",
      marginBottom: 6
    }),
    UIColumn(() =>
      logLinesSignal.value.map(line =>
        UIText(line).style({
          color: () =>
            line.startsWith(">")
              ? THEME.accentCyan
              : line.startsWith("<")
                ? THEME.statusOk
                : THEME.textMuted,
          fontSize: 11
        })
      )
    ).style({
      backgroundColor: () => THEME.bgInput,
      borderWidth: 1,
      borderColor: () => THEME.borderDefault,
      borderRadius: 9,
      padding: 8,
      width: "100%",
      minHeight: 90,
      gap: 2,
      marginBottom: 8
    }),
    UIRow(
      cmdInput,
      PrimaryButton("Отпр.", async () => {
        const cmd = (cmdInput.value || cmdTextSignal.value || "").trim().toUpperCase();
        if (!cmd) return;
        cmdInput.value = "";
        cmdTextSignal.value = "";
        try {
          await obdProtocol.sendCommand(cmd);
        } catch (err: any) {
          toast(`Ошибка команды: ${err?.message || err}`);
        }
      })
    ).style({ alignItems: "center", gap: 8, width: "100%" })
  ).style({
    backgroundColor: () => THEME.bgSurface,
    borderWidth: 1,
    borderColor: () => THEME.borderDefault,
    borderRadius: 14,
    padding: 13,
    width: "100%"
  });

  return UIColumn(
    header,
    UIScrollable(
      UIColumn(connectionCard, gaugesGrid, dtcCard, terminalCard).style({
        width: "100%",
        padding: 12,
        gap: 10
      })
    ).style({ flex: 1, width: "100%", backgroundColor: () => THEME.bgBase })
  ).style({
    flex: 1,
    width: "100%",
    backgroundColor: () => THEME.bgBase
  });
}
