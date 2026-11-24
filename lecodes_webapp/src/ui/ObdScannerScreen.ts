/**
 * Экран «OBD-II Сканнер» (Прямой проброс внешних устройств через браузер/Android).
 * Работает с реальными датчиками через:
 * 1. Web Bluetooth API (ELM327 BLE / Bluetooth 4.0+)
 * 2. Web Serial API (ELM327 USB / FTDI / CH340 COM-порты)
 * 3. Встроенный Демо-симулятор ЭБУ (для тестирования и отладки)
 *
 * Отображает живые приборы телеметрии (RPM, скорость, температура ОЖ, напряжение АКБ),
 * считывает и сбрасывает коды неисправностей DTC (Mode 03 / Mode 04),
 * и выводит консоль AT-команд.
 * Адаптирован для вертикальных экранов смартфонов.
 * Лицензия: GPL-3.0
 */

import { obdProtocol } from "../obd/ELM327Protocol";
import { WebBluetoothOBD } from "../obd/WebBluetoothOBD";
import { WebSerialOBD } from "../obd/WebSerialOBD";
import { DtcChip, HeaderBar, MetricCard, PrimaryButton, SecondaryButton, StatusBadge } from "./components";

export interface ObdScannerCallbacks {
  onSendDtcToAi?: (codes: string[]) => void;
  onOpenEngineeringMenu?: () => void;
}

export function createObdScannerScreen(callbacks?: ObdScannerCallbacks): any {
  // Реактивные сигналы состояния соединения
  const connStatusSignal = signal(obdProtocol.getStatus());
  const statusMsgSignal = signal(obdProtocol.getStatusMessage());

  // Сигналы живых датчиков
  const rpmSignal = signal(0);
  const speedSignal = signal(0);
  const coolantSignal = signal(0);
  const voltageSignal = signal(12.6);
  const loadSignal = signal(0);
  const throttleSignal = signal(0);
  const dtcListSignal = signal<string[]>([]);
  const isReadingDtcSignal = signal(false);

  // Журнал терминала
  const terminalLogsSignal = signal<string[]>([
    "[SYS] Готов к подключению сканера ELM327 по Web Bluetooth или Web Serial"
  ]);

  const dtcContainer = UIColumn().style({ width: "100%" });
  const terminalLogsContainer = UIColumn().style({
    backgroundColor: "#050914",
    borderRadius: 8,
    padding: 10,
    maxHeight: 140,
    borderWidth: 1,
    borderColor: "#1e293b",
    width: "100%"
  });

  const updateDtcUi = () => {
    const list = dtcListSignal.value;
    const nodes: any[] = [];
    if (list.length === 0) {
      nodes.push(
        UIText("Активных кодов неисправностей не обнаружено в памяти ЭБУ.")
          .style({ color: "#10b981", fontSize: 12, paddingVertical: 4 })
      );
    } else {
      nodes.push(
        UIRow(...list.map(c => DtcChip(c))).style({ flexWrap: "wrap", marginBottom: 8 })
      );
      if (callbacks?.onSendDtcToAi) {
        nodes.push(
          PrimaryButton("Отправить ошибки в ИИ-диагност →", () => callbacks.onSendDtcToAi?.(list))
        );
      }
    }
    dtcContainer.setContent(nodes);
  };

  const addLog = (dir: string, text: string) => {
    const time = new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const line = `[${time}] ${dir === "in" ? "RX <" : dir === "out" ? "TX >" : "•"} ${text}`;
    terminalLogsSignal.value = [...terminalLogsSignal.value.slice(-25), line];

    terminalLogsContainer.append(
      UIText(line).style({
        color: line.includes("TX") ? "#38bdf8" : line.includes("RX") ? "#34d399" : "#94a3b8",
        fontSize: 11,
        fontFamily: "monospace",
        lineHeight: 16
      })
    );
  };

  // Первоначальный рендер
  updateDtcUi();

  // Подписка на события протокола ELM327
  obdProtocol.onStatusChange = (st, msg) => {
    connStatusSignal.value = st;
    statusMsgSignal.value = msg;
    addLog("info", `Статус: ${st} (${msg})`);
  };

  obdProtocol.onSensorsUpdate = (s) => {
    rpmSignal.value = s.rpm;
    speedSignal.value = s.speed;
    coolantSignal.value = s.coolantTemp;
    voltageSignal.value = s.voltage;
    loadSignal.value = s.engineLoad;
    throttleSignal.value = s.throttle;
    if (s.dtcList && s.dtcList.length !== dtcListSignal.value.length) {
      dtcListSignal.value = s.dtcList;
      updateDtcUi();
    }
  };

  obdProtocol.onLog = (dir, text) => {
    addLog(dir, text);
  };

  const handleConnectBt = async () => {
    addLog("info", "Запрос Web Bluetooth устройства...");
    await obdProtocol.connect("bluetooth");
  };

  const handleConnectSerial = async (baud: number = 38400) => {
    addLog("info", `Запрос Web Serial COM-порта (${baud} бод)...`);
    await obdProtocol.connect("serial", baud);
  };

  const handleConnectDemo = async () => {
    addLog("info", "Запуск Демо-симулятора ЭБУ...");
    await obdProtocol.connect("demo");
  };

  const handleDisconnect = async () => {
    await obdProtocol.disconnect();
  };

  const handleReadDTC = async () => {
    if (isReadingDtcSignal.value) return;
    isReadingDtcSignal.value = true;
    try {
      const codes = await obdProtocol.readDTC();
      dtcListSignal.value = codes;
      updateDtcUi();
    } finally {
      isReadingDtcSignal.value = false;
    }
  };

  const handleClearDTC = async () => {
    const ok = await obdProtocol.clearDTC();
    if (ok) {
      dtcListSignal.value = [];
      updateDtcUi();
    }
  };

  const hasBt = WebBluetoothOBD.isSupported();
  const hasSerial = WebSerialOBD.isSupported();
  const isArHudSignal = signal<boolean>(false);

  const header = HeaderBar(
    "OBD-II Приборы & Датчики",
    "Телеметрия ЭБУ и диагностика ELM327",
    UIRow(
      StatusBadge(
        () => connStatusSignal.value,
        () => statusMsgSignal.value
      )
    )
  );

  // Панель подключения устройств
  const connectionBar = UIColumn(
    UIRow(
      UIText("Подключение:").style({ color: "#94a3b8", fontSize: 12, alignSelf: "center", marginRight: 8 }),
      hasBt
        ? PrimaryButton("Bluetooth BLE", handleConnectBt)
        : null,
      hasSerial
        ? PrimaryButton("USB COM", () => handleConnectSerial(38400))
        : null,
        SecondaryButton(
        () => (connStatusSignal.value === "connected" && obdProtocol.getTransportType() === "demo" ? "Демо (Стоп)" : "Демо-тест"),
        () => {
          if (connStatusSignal.value === "connected" && obdProtocol.getTransportType() === "demo") {
            handleDisconnect();
          } else {
            handleConnectDemo();
          }
        }
      ),
      SecondaryButton(
        () => (isArHudSignal.value ? "AR HUD: Вкл" : "AR HUD (Очки / DeX)"),
        () => {
          isArHudSignal.value = !isArHudSignal.value;
        }
      ),
      UISpacer(),
      () =>
        connStatusSignal.value === "connected" && obdProtocol.getTransportType() !== "demo"
          ? SecondaryButton("Отключить", handleDisconnect)
          : null
    ).style({ alignItems: "center", flexWrap: "wrap", gap: 6, width: "100%" })
  ).style({
    backgroundColor: "#0d1322",
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#1e293b",
    marginBottom: 12,
    width: "100%"
  });

  // Приборная панель (Сетка адаптивных датчиков с прогресс-барами)
  // На узком экране (360-400px) карточки с minWidth 140px формируют 2 колонки, на десктопе 3.
  const gaugesGrid = UIRow(
    MetricCard(
      "Обороты ЭБУ",
      () => String(rpmSignal.value),
      "об/мин",
      "#38bdf8",
      () => Math.min(1, rpmSignal.value / 7000)
    ),
    MetricCard(
      "Скорость",
      () => String(speedSignal.value),
      "км/ч",
      "#22c55e",
      () => Math.min(1, speedSignal.value / 220)
    ),
    MetricCard(
      "Температура ОЖ",
      () => `${coolantSignal.value}°`,
      "C",
      coolantSignal.value > 105 ? "#ef4444" : coolantSignal.value < 70 ? "#38bdf8" : "#22c55e",
      () => Math.min(1, coolantSignal.value / 120)
    ),
    MetricCard(
      "Напряжение АКБ",
      () => voltageSignal.value.toFixed(1),
      "В",
      "#a855f7",
      () => Math.min(1, Math.max(0, (voltageSignal.value - 10) / 5))
    ),
    MetricCard(
      "Нагрузка двигателя",
      () => `${loadSignal.value}`,
      "%",
      "#ec4899",
      () => Math.min(1, loadSignal.value / 100)
    ),
    MetricCard(
      "Дроссель",
      () => `${throttleSignal.value}`,
      "%",
      "#06b6d4",
      () => Math.min(1, throttleSignal.value / 100)
    )
  ).style({
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 12,
    width: "100%"
  });

  // Секция кодов ошибок ЭБУ (DTC)
  const dtcSection = UIColumn(
    UIRow(
      UIText("Коды ошибок ЭБУ (DTC)").style({ color: "#f8fafc", fontSize: 14, fontWeight: "bold", flex: 1 }),
      PrimaryButton(
        () => (isReadingDtcSignal.value ? "Чтение..." : "Считать (03)"),
        handleReadDTC
      ),
      UIRow().style({ width: 6 }),
      SecondaryButton("Сброс (04)", handleClearDTC)
    ).style({ alignItems: "center", marginBottom: 10, width: "100%", flexWrap: "wrap", gap: 6 }),

    dtcContainer
  ).style({
    backgroundColor: "#131b2e",
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: "#1e293b",
    marginBottom: 12,
    width: "100%"
  });

  // Терминал AT команд
  const terminalSection = UIColumn(
    UIText("Журнал команд ELM327 / OBD-II").style({ color: "#94a3b8", fontSize: 12, fontWeight: "bold", marginBottom: 6 }),
    terminalLogsContainer
  ).style({
    backgroundColor: "#0d1322",
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: "#1e293b",
    width: "100%"
  });

  // Высококонтрастный AR HUD блок для смарт-очков и внешних дисплеев (AR-очки, внешние экраны, DeX)
  const arHudCard = UIColumn(
    UIRow(
      UIText("AR HUD ПРОЕКЦИЯ • ОЧКИ & ВНЕШНИЙ ЭКРАН")
        .style({ color: "#38bdf8", fontSize: 12, fontWeight: "bold" }),
      UISpacer(),
      UIText("3DoF Tracking активен")
        .style({ color: "#10b981", fontSize: 11, fontWeight: "bold" })
    ).style({ marginBottom: 6 }),
    UIRow(
      UIColumn(
        UIText("СКОРОСТЬ").style({ color: "#6ee7b7", fontSize: 11, fontWeight: "bold" }),
        UIRow(
          UIText(() => `${speedSignal.value}`).style({ color: "#10b981", fontSize: 48, fontWeight: "bold" }),
          UIText(" км/ч").style({ color: "#6ee7b7", fontSize: 14, alignSelf: "flex-end", marginBottom: 8, marginLeft: 4 })
        )
      ).style({ flex: 1, alignItems: "center" }),
      UIColumn(
        UIText("ОБОРОТЫ ДВС").style({ color: "#fcd34d", fontSize: 11, fontWeight: "bold" }),
        UIRow(
          UIText(() => `${rpmSignal.value}`).style({ color: "#f59e0b", fontSize: 48, fontWeight: "bold" }),
          UIText(" RPM").style({ color: "#fcd34d", fontSize: 14, alignSelf: "flex-end", marginBottom: 8, marginLeft: 4 })
        )
      ).style({ flex: 1, alignItems: "center" })
    ).style({ width: "100%", justifyContent: "space-around", paddingVertical: 8 }),
    UIRow(
      UIText(() => `ОЖ: ${coolantSignal.value}°C  |  Нагрузка: ${loadSignal.value}%  |  Дроссель: ${throttleSignal.value}%  |  АКБ: 14.1 В`)
        .style({ color: "#93c5fd", fontSize: 12, textAlign: "center", width: "100%" })
    ).style({ paddingBottom: 4 })
  ).style({
    backgroundColor: "#000000",
    borderRadius: 14,
    padding: 12,
    borderWidth: 2,
    borderColor: "#10b981",
    marginBottom: 12,
    width: "100%"
  });

  const scrollBody = UIScrollable(
    UIColumn(
      connectionBar,
      arHudCard,
      gaugesGrid,
      dtcSection,
      terminalSection
    ).style({ padding: 14, maxWidth: 960, alignSelf: "center", width: "100%", paddingBottom: 24 })
  ).style({ flex: 1, width: "100%" });

  return UIScreen(header, scrollBody).style({ backgroundColor: "#0a0f1d", flex: 1, width: "100%", height: "100%" });
}
