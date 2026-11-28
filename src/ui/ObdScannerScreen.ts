// ИИдеал Авто — Приборная панель OBD-II / ELM327 (2026-11-28)
// Copyright (C) 2026 ИИдеал Авто (LeCodes48 Edition)
// Licensed under the GNU General Public License v3.0 (GPL-3.0).

import { DEMO_SCENARIOS, obdProtocol } from "../obd/ELM327Protocol";
import { WebBluetoothOBD } from "../obd/WebBluetoothOBD";
import { WebSerialOBD } from "../obd/WebSerialOBD";
import {
  appState,
  attachObdSnapshotToStaging,
  stageDtcCodes,
  switchDemoScenario,
  syncObdState,
} from "../state/appState";
import {
  AppHeader,
  DtcChip,
  LucideIcon,
  MetricCard,
  openConfirmModal,
  PrimaryButton,
  SecondaryButton,
  StatusBadge,
  THEME,
} from "./components";

export interface ObdScannerCallbacks {
  onOpenAr?: () => void;

  onOpenSettings?: () => void;
  onAttachToAi?: () => void;
}

export function createObdScannerScreen(callbacks?: ObdScannerCallbacks): any {
  const sensors = () => appState.obdSensorsSignal.value;

  const connectAdapter = async (mode: "bluetooth" | "serial" | "demo") => {
    if (mode === "bluetooth" && !WebBluetoothOBD.isSupported()) {
      toast("WebBluetooth недоступен на этой платформе — используйте Демо ЭБУ");
      return;
    }
    if (mode === "serial" && !WebSerialOBD.isSupported()) {
      toast("USB Serial недоступен на этой платформе — используйте Демо ЭБУ");
      return;
    }
    const ok = await obdProtocol.connect(mode);
    syncObdState();
    if (ok) {
      toast(
        mode === "demo"
          ? "Подключен эмулятор ЭБУ ELM327"
          : "Адаптер ELM327 подключен"
      );
    }
  };

  const dtcContainer = UIRow(() => {
    const s = appState.obdSensorsSignal.value;
    void appState.settingsSignal.value.theme_mode;
    if (!s.dtcList || s.dtcList.length === 0) {
      return [
        UIText("Активных ошибок в памяти ЭБУ нет").style({
          color: () => THEME.statusOk,
          fontSize: 12,
        }),
      ];
    }
    return s.dtcList.map((code) =>
      DtcChip(code, () => {
        stageDtcCodes([code]);
        callbacks?.onAttachToAi?.();
      })
    );
  }).style({ flexWrap: "wrap", gap: 6, width: "100%" });

  const logsContainer = UIColumn(() => {
    const logs = appState.obdLogsSignal.value || [];
    void appState.settingsSignal.value.theme_mode;
    if (logs.length === 0) {
      return [
        UIText("Журнал AT-команд пуст. Подключите адаптер или запустите демо ЭБУ.").style({
          color: () => THEME.textMuted,
          fontSize: 11,
        }),
      ];
    }
    return logs
      .slice(-14)
      .reverse()
      .map((entry) =>
        UIRow(
          UIText(entry.time).style({
            color: () => THEME.textMuted,
            fontSize: 10,
            width: 54,
          }),
          UIText(entry.dir === "out" ? "TX" : entry.dir === "in" ? "RX" : "INFO").style({
            color: () =>
              entry.dir === "out"
                ? THEME.accentOrange
                : entry.dir === "in"
                ? THEME.accentCyan
                : THEME.textMuted,
            fontSize: 10,
            fontWeight: "bold",
            width: 34,
          }),
          UIText(entry.text).style({
            color: () => THEME.textSecondary,
            fontSize: 11,
            flex: 1,
          })
        ).style({ width: "100%", gap: 6, alignItems: "center" })
      );
  }).style({ width: "100%", gap: 3 });

  const scrollBody = UIScrollable(
    UIColumn(
      // Статус подключения
      UIColumn(
        UIRow(
          LucideIcon("lucide:radio", 18, () =>
            appState.obdConnectedSignal.value ? THEME.statusOk : THEME.accentCyan
          ),
          UIText(() => appState.obdStatusMessageSignal.value).style({
            color: () => THEME.textPrimary,
            fontSize: 13,
            fontWeight: "bold",
            flex: 1,
          }),
          StatusBadge(
            () => (appState.obdConnectedSignal.value ? "ok" : "warn"),
            () => (appState.obdConnectedSignal.value ? "ONLINE" : "OFFLINE")
          )
        ).style({ width: "100%", alignItems: "center", gap: 8 }),

        UIText(() =>
          sensors().vin ? `VIN ЭБУ: ${sensors().vin}` : "VIN: не считан (подключите ЭБУ)"
        ).style({
          color: () => THEME.textMuted,
          fontSize: 11,
        }),

        UIRow(
          PrimaryButton(
            "Демо ЭБУ",
            () => void connectAdapter("demo"),
            "lucide:play"
          ).named("obd-btn-demo"),
          SecondaryButton(
            "BLE",
            () => void connectAdapter("bluetooth"),
            "lucide:bluetooth"
          ),
          SecondaryButton(
            "USB",
            () => void connectAdapter("serial"),
            "lucide:usb"
          ),
          SecondaryButton(
            "Откл.",
            () => {
              void obdProtocol.disconnect().then(() => syncObdState());
            },
            "lucide:square"
          )
        ).style({ flexWrap: "wrap", gap: 6, width: "100%", marginTop: 4 })
      ).style({
        backgroundColor: () => THEME.bgSurface,
        borderRadius: 14,
        padding: 12,
        borderWidth: 1,
        borderColor: () => THEME.borderDefault,
        gap: 6,
      }),

      // Сценарии виртуального ЭБУ
      UIColumn(
        UIText("СЦЕНАРИИ СТЕНДА ЭБУ (OFFLINE DEMO)").style({
          color: () => THEME.accentOrange,
          fontSize: 11,
          fontWeight: "bold",
        }),
        UIRow(
          ...DEMO_SCENARIOS.map((sc) =>
            UIButton(
              UIText(sc.label).style({
                color: () =>
                  appState.activeDemoScenarioSignal.value === sc.id
                    ? "#ffffff"
                    : THEME.textSecondary,
                fontSize: 11,
                fontWeight: "600",
              })
            )
              .style({
                backgroundColor: () =>
                  appState.activeDemoScenarioSignal.value === sc.id
                    ? THEME.accentOrange
                    : THEME.bgInput,
                borderWidth: 1,
                borderColor: () =>
                  appState.activeDemoScenarioSignal.value === sc.id
                    ? THEME.accentOrange
                    : THEME.borderDefault,
                borderRadius: 9,
                paddingHorizontal: 10,
                paddingVertical: 6,
              })
              .onClick(() => void switchDemoScenario(sc.id))
          )
        ).style({ flexWrap: "wrap", gap: 6, width: "100%" })
      ).style({
        backgroundColor: () => THEME.bgSurface,
        borderRadius: 14,
        padding: 12,
        borderWidth: 1,
        borderColor: () => THEME.borderDefault,
        gap: 8,
      }),

      // Живая телеметрия датчиков
      UIRow(
        MetricCard(
          "ОБОРОТЫ",
          () => `${sensors().rpm}`,
          "об/мин",
          () => (sensors().rpm > 5000 ? THEME.statusWarn : THEME.accentCyan)
        ),
        MetricCard(
          "СКОРОСТЬ",
          () => `${sensors().speed}`,
          "км/ч",
          () => THEME.textPrimary
        ),
        MetricCard(
          "ТЕМП. ОЖ",
          () => `${sensors().coolantTemp}`,
          "°C",
          () => (sensors().coolantTemp > 103 ? THEME.statusCrit : THEME.statusOk)
        )
      ).style({ width: "100%", gap: 8 }),

      UIRow(
        MetricCard(
          "ДРОССЕЛЬ",
          () => `${sensors().throttle}`,
          "%",
          () => THEME.accentViolet
        ),
        MetricCard(
          "НАГРУЗКА",
          () => `${sensors().engineLoad}`,
          "%",
          () => THEME.accentOrange
        ),
        MetricCard(
          "АКБ",
          () => sensors().voltage.toFixed(1),
          "В",
          () =>
            sensors().voltage > 0 && sensors().voltage < 11.8
              ? THEME.statusCrit
              : THEME.statusOk
        )
      ).style({ width: "100%", gap: 8 }),

      // Коды ошибок ЭБУ и действия
      UIColumn(
        UIRow(
          UIText("КОДЫ ОШИБОК ЭБУ (MODE 03)").style({
            color: () => THEME.textPrimary,
            fontSize: 12,
            fontWeight: "bold",
            flex: 1,
          }),
          SecondaryButton(
            "Считать",
            () => {
              void obdProtocol.readDTC().then(() => syncObdState());
            },
            "lucide:refresh-cw"
          ),
          SecondaryButton(
            "Сбросить",
            () => {
              openConfirmModal({
                title: "Сбросить коды ошибок ЭБУ?",
                message: "Будет отправлена команда ELM327 Mode 04 (Clear DTC). Индикатор Check Engine погаснет.",
                confirmLabel: "Сбросить (Mode 04)",
                danger: true,
                onConfirm: () => {
                  void obdProtocol.clearDTC().then(() => syncObdState());
                  toast("Команда сброса DTC выполнена");
                },
              });
            },
            "lucide:trash-2"
          )
        ).style({ width: "100%", alignItems: "center", gap: 6 }),
        dtcContainer,
        UIRow(
          PrimaryButton(
            "Отправить в ИИ-диагност",
            () => {
              attachObdSnapshotToStaging();
              callbacks?.onAttachToAi?.();
            },
            "lucide:send"
          ).named("obd-btn-send-ai"),

        ).style({ flexWrap: "wrap", gap: 8, width: "100%", marginTop: 4 })
      ).style({
        backgroundColor: () => THEME.bgSurface,
        borderRadius: 14,
        padding: 12,
        borderWidth: 1,
        borderColor: () => THEME.borderDefault,
        gap: 8,
      }),

      // Журнал протокола ELM327
      UIColumn(
        UIText("КОНСОЛЬ ПРОТОКОЛА ELM327").style({
          color: () => THEME.textMuted,
          fontSize: 11,
          fontWeight: "bold",
        }),
        logsContainer
      ).style({
        backgroundColor: () => THEME.bgSurface,
        borderRadius: 14,
        padding: 12,
        borderWidth: 1,
        borderColor: () => THEME.borderDefault,
        gap: 6,
      })
    ).style({
      width: "100%",
      paddingHorizontal: 12,
      paddingTop: 8,
      paddingBottom: 18,
      gap: 10,
    })
  ).style({ flex: 1, width: "100%" });

  return UIColumn(
    AppHeader({
      title: "OBD-2 СКАНЕР",
      onOpenAr: callbacks?.onOpenAr,

      onOpenSettings: callbacks?.onOpenSettings,
    }),
    scrollBody
  )
    .named("obd")
    .style({
      flex: 1,
      width: "100%",
      backgroundColor: () => THEME.bgBase,
    });
}
