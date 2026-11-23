/**
 * Экран «OBD-II Сканнер» (Прямой проброс внешних устройств через браузер).
 * Работает с реальными датчиками через:
 * 1. Web Bluetooth API (ELM327 BLE / Bluetooth 4.0+)
 * 2. Web Serial API (ELM327 USB / FTDI / CH340 COM-порты)
 * 3. Встроенный Демо-симулятор ЭБУ (для тестирования)
 *
 * Отображает живые приборы телеметрии (RPM, скорость, температура ОЖ, напряжение АКБ),
 * считывает и сбрасывает коды неисправностей DTC (Mode 03 / Mode 04),
 * и выводит консоль AT-команд.
 */

import { obdProtocol } from "../obd/ELM327Protocol";
import { WebBluetoothOBD } from "../obd/WebBluetoothOBD";
import { WebSerialOBD } from "../obd/WebSerialOBD";
import { DtcChip, HeaderBar, MetricCard, PrimaryButton, SecondaryButton, StatusBadge } from "./components";

export function createObdScannerScreen(onSendDtcToAi?: (codes: string[]) => void): any {
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

  const addLog = (dir: string, text: string) => {
    const time = new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const line = `[${time}] ${dir === "in" ? "RX <" : dir === "out" ? "TX >" : "•"} ${text}`;
    terminalLogsSignal.value = [...terminalLogsSignal.value.slice(-30), line];
  };

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
    dtcListSignal.value = s.dtcList;
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
    } finally {
      isReadingDtcSignal.value = false;
    }
  };

  const handleClearDTC = async () => {
    const ok = await obdProtocol.clearDTC();
    if (ok) {
      dtcListSignal.value = [];
    }
  };

  const hasBt = WebBluetoothOBD.isSupported();
  const hasSerial = WebSerialOBD.isSupported();

  const header = HeaderBar(
    "OBD-II Телеметрия & Датчики",
    "Прямой доступ к ЭБУ через аппаратные интерфейсы браузера",
    UIRow(
      StatusBadge(
        connStatusSignal.value,
        () => statusMsgSignal.value
      )
    )
  );

  // Панель подключения устройств
  const connectionBar = UIColumn(
    UIRow(
      UIText("Подключение сканера:").style({ color: "#94a3b8", fontSize: 13, alignSelf: "center", marginRight: 12 }),
      hasBt
        ? PrimaryButton("Bluetooth (BLE)", handleConnectBt)
        : null,
      UIRow().style({ width: 8 }),
      hasSerial
        ? PrimaryButton("USB (38.4k)", () => handleConnectSerial(38400))
        : null,
      UIRow().style({ width: 8 }),
      hasSerial
        ? SecondaryButton("USB (115.2k)", () => handleConnectSerial(115200))
        : null,
      UIRow().style({ width: 8 }),
      SecondaryButton("Демо-симулятор", handleConnectDemo),
      UISpacer(),
      () =>
        connStatusSignal.value === "connected"
          ? SecondaryButton("Отключить", handleDisconnect)
          : null
    ).style({ alignItems: "center", flexWrap: "wrap", gap: 8 }),
    (!hasBt && !hasSerial)
      ? UIText(
          "Внимание: Web Bluetooth и Web Serial требуют браузер на базе Chromium (Chrome, Edge, Yandex Browser, мобильный Chrome на Android)."
        ).style({ color: "#f59e0b", fontSize: 12, marginTop: 8 })
      : null
  ).style({
    backgroundColor: "#0d1322",
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#1e293b",
    marginBottom: 16
  });

  // Приборная панель (Gauges Grid)
  const gaugesRow1 = UIRow(
    MetricCard("Обороты двигателя", () => String(rpmSignal.value), "об/мин", "#38bdf8"),
    UIRow().style({ width: 12 }),
    MetricCard("Скорость автомобиля", () => String(speedSignal.value), "км/ч", "#22c55e"),
    UIRow().style({ width: 12 }),
    MetricCard("Температура ОЖ", () => `${coolantSignal.value}°`, "C", "#f59e0b")
  ).style({ marginBottom: 12, flexWrap: "wrap", gap: 12 });

  const gaugesRow2 = UIRow(
    MetricCard("Напряжение АКБ", () => voltageSignal.value.toFixed(1), "В", "#a855f7"),
    UIRow().style({ width: 12 }),
    MetricCard("Нагрузка на двигатель", () => `${loadSignal.value}`, "%", "#ec4899"),
    UIRow().style({ width: 12 }),
    MetricCard("Дроссельная заслонка", () => `${throttleSignal.value}`, "%", "#06b6d4")
  ).style({ marginBottom: 16, flexWrap: "wrap", gap: 12 });

  // Секция кодов ошибок ЭБУ (DTC)
  const dtcSection = UIColumn(
    UIRow(
      UIText("Диагностические коды ЭБУ (DTC)").style({ color: "#f8fafc", fontSize: 16, fontWeight: "bold" }),
      UISpacer(),
      PrimaryButton("Считать ошибки (03)", handleReadDTC),
      UIRow().style({ width: 8 }),
      SecondaryButton("Сбросить ошибки (04)", handleClearDTC)
    ).style({ alignItems: "center", marginBottom: 12 }),
    () => {
      const list = dtcListSignal.value;
      if (list.length === 0) {
        return UIText("Активных кодов неисправностей не обнаружено в памяти ЭБУ.")
          .style({ color: "#10b981", fontSize: 13, paddingVertical: 8 });
      }

      return UIColumn(
        UIRow(
          ...list.map(c => DtcChip(c))
        ).style({ flexWrap: "wrap", marginBottom: 10 }),
        onSendDtcToAi
          ? PrimaryButton("Отправить ошибки в ИИ-диагност →", () => onSendDtcToAi(list))
          : null
      );
    }
  ).style({
    backgroundColor: "#131b2e",
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: "#1e293b",
    marginBottom: 16
  });

  // Терминал AT команд
  const terminalSection = UIColumn(
    UIText("Журнал команд ELM327 / OBD-II").style({ color: "#94a3b8", fontSize: 13, fontWeight: "bold", marginBottom: 8 }),
    UIColumn(
      () =>
        terminalLogsSignal.value.map(line =>
          UIText(line).style({
            color: line.includes("TX") ? "#38bdf8" : line.includes("RX") ? "#34d399" : "#94a3b8",
            fontSize: 12,
            fontFamily: "monospace",
            lineHeight: 18
          })
        )
    ).style({
      backgroundColor: "#050914",
      borderRadius: 8,
      padding: 12,
      maxHeight: 160,
      borderWidth: 1,
      borderColor: "#1e293b"
    })
  ).style({
    backgroundColor: "#0d1322",
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: "#1e293b"
  });

  const scrollBody = UIScrollable(
    UIColumn(
      connectionBar,
      gaugesRow1,
      gaugesRow2,
      dtcSection,
      terminalSection
    ).style({ padding: 20, maxWidth: 960, alignSelf: "center", width: "100%" })
  ).style({ flexGrow: 1 });

  return UIScreen(header, scrollBody).style({ backgroundColor: "#0a0f1d", flex: 1 });
}
