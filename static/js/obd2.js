/**
 * ============================================================================
 * ИИдеал Авто (AIdeal Auto) — Модуль интеграции OBD-II / ELM327
 * ============================================================================
 * Поддерживает:
 *  1. Web Serial API (USB/Type-C адаптеры CH340, FTDI, CP2102 на 38400, 115200, 9600 бод)
 *  2. Web Bluetooth API (BLE и SPP адаптеры ELM327)
 *  3. Виртуальный демо-симулятор (для тестирования диагностами без авто)
 *  4. Протокол инициализации: ATZ, ATE0, ATL0, ATH0, ATSP0
 *  5. Живые параметры (Live PID): RPM, Скорость, ОЖ, Дроссель, Нагрузка, Впуск
 *  6. Чтение кодов неисправностей (DTC): Mode 03 (активные), 07 (pending), 0A (permanent)
 *  7. Определение VIN: Mode 09 02 (17-значный номер кузова)
 *  8. Сброс кодов ошибок: Mode 04 (с подтверждением механика)
 *  9. Живая телеметрия (Live Polling) и шина событий on('connected'|'live_data'|'dtc_found'|'error')
 * 
 * Без внешних NPM-зависимостей. Все ошибки на понятном автомеханику русском языке.
 * ============================================================================
 */

(function (global) {
  'use strict';

  // --------------------------------------------------------------------------
  // Таблица известных кодов DTC и их описаний на русском языке (для диагноста)
  // --------------------------------------------------------------------------
  const DTC_DICTIONARY_RU = {
    'P0100': 'Неисправность в цепи расходомера воздуха (MAF / VAF)',
    'P0101': 'Выход сигнала расходомера воздуха (MAF) за допустимый диапазон',
    'P0102': 'Низкий уровень входного сигнала расходомера воздуха (MAF)',
    'P0103': 'Высокий уровень входного сигнала расходомера воздуха (MAF)',
    'P0110': 'Неисправность датчика температуры впускного воздуха (IAT)',
    'P0115': 'Неисправность датчика температуры охлаждающей жидкости (ECT)',
    'P0116': 'Выход сигнала датчика температуры ОЖ за допустимый диапазон',
    'P0117': 'Низкий уровень сигнала датчика температуры ОЖ (замыкание на массу)',
    'P0118': 'Высокий уровень сигнала датчика температуры ОЖ (обрыв цепи)',
    'P0120': 'Неисправность датчика положения дроссельной заслонки (TPS) "A"',
    'P0121': 'Диапазон/рабочие характеристики датчика положения дросселя (TPS) "A"',
    'P0122': 'Низкий уровень сигнала датчика положения дроссельной заслонки',
    'P0123': 'Высокий уровень сигнала датчика положения дроссельной заслонки',
    'P0130': 'Неисправность цепи датчика кислорода (Банк 1, Датчик 1)',
    'P0131': 'Низкое напряжение цепи датчика кислорода (Банк 1, Датчик 1)',
    'P0132': 'Высокое напряжение цепи датчика кислорода (Банк 1, Датчик 1)',
    'P0133': 'Медленный отклик датчика кислорода (Банк 1, Датчик 1)',
    'P0134': 'Нет активности выходного сигнала датчика кислорода (Банк 1, Датчик 1)',
    'P0135': 'Неисправность нагревателя датчика кислорода (Банк 1, Датчик 1)',
    'P0140': 'Нет активности выходного сигнала датчика кислорода (Банк 1, Датчик 2)',
    'P0141': 'Неисправность нагревателя датчика кислорода (Банк 1, Датчик 2)',
    'P0171': 'Слишком бедная смесь (Банк 1) — возможен подсос воздуха или падение давления топлива',
    'P0172': 'Слишком богатая смесь (Банк 1) — перелив форсунок, утечка регулятора давления',
    'P0174': 'Слишком бедная смесь (Банк 2)',
    'P0175': 'Слишком богатая смесь (Банк 2)',
    'P0200': 'Неисправность цепи управления форсунками',
    'P0300': 'Обнаружены случайные/множественные пропуски воспламенения (Misfire)',
    'P0301': 'Пропуски воспламенения в 1-м цилиндре (Misfire Cylinder 1)',
    'P0302': 'Пропуски воспламенения во 2-м цилиндре (Misfire Cylinder 2)',
    'P0303': 'Пропуски воспламенения в 3-м цилиндре (Misfire Cylinder 3)',
    'P0304': 'Пропуски воспламенения в 4-м цилиндре (Misfire Cylinder 4)',
    'P0305': 'Пропуски воспламенения в 5-м цилиндре (Misfire Cylinder 5)',
    'P0306': 'Пропуски воспламенения в 6-м цилиндре (Misfire Cylinder 6)',
    'P0325': 'Неисправность в цепи датчика детонации (Банк 1)',
    'P0335': 'Неисправность в цепи датчика положения коленчатого вала (CKP)',
    'P0336': 'Ошибка диапазона/синхронизации датчика положения коленвала',
    'P0340': 'Неисправность цепи датчика положения распределительного вала (CMP)',
    'P0400': 'Неисправность системы рециркуляции отработавших газов (EGR)',
    'P0401': 'Недостаточный поток в системе рециркуляции ОГ (EGR)',
    'P0420': 'Эффективность каталитического нейтрализатора ниже порога (Банк 1)',
    'P0430': 'Эффективность каталитического нейтрализатора ниже порога (Банк 2)',
    'P0440': 'Неисправность системы контроля улавливания паров топлива (EVAP)',
    'P0442': 'Небольшая утечка в системе улавливания паров топлива (EVAP)',
    'P0455': 'Крупная утечка в системе улавливания паров топлива (EVAP) / открыта крышка бака',
    'P0500': 'Неисправность датчика скорости автомобиля (VSS)',
    'P0505': 'Неисправность регулятора холостого хода (РХХ / IAC)',
    'P0506': 'Обороты холостого хода ниже нормы',
    'P0507': 'Обороты холостого хода выше нормы',
    'P0562': 'Низкое напряжение бортовой сети автомобиля',
    'P0563': 'Высокое напряжение бортовой сети автомобиля',
    'P0600': 'Сбой последовательного канала связи ЭБУ',
    'P0606': 'Внутренняя неисправность процессора ЭБУ (ECU Processor Fault)',
    'P0700': 'Неисправность в системе управления коробкой передач (АКПП / TCM)',
    'U0001': 'Высокоскоростная шина связи CAN отключена или закорочена',
    'U0100': 'Потеря связи с блоком управления двигателем (ECM/PCM)',
    'U0101': 'Потеря связи с блоком управления коробкой передач (TCM)',
    'U0121': 'Потеря связи с блоком управления тормозной системой (ABS/ESP)',
    'U0140': 'Потеря связи с центральным блоком кузовной электроники (BCM)',
    'U0155': 'Потеря связи с блоком управления комбинацией приборов (IPC)',
    'C0035': 'Неисправность цепи датчика скорости переднего левого колеса (ABS)',
    'C0040': 'Неисправность цепи датчика скорости переднего правого колеса (ABS)',
    'C0200': 'Неисправность сигнала датчика угловой скорости правого переднего колеса',
    'B0001': 'Разрыв в цепи подушки безопасности водителя (Driver Airbag Stage 1)',
    'B1000': 'Внутренняя неисправность блока управления подушками безопасности (SRS)'
  };

  // --------------------------------------------------------------------------
  // Константы Bluetooth сервисов и характеристик для ELM327 BLE / SPP
  // --------------------------------------------------------------------------
  const BLE_OBD_SERVICES = [
    '0000fff0-0000-1000-8000-00805f9b34fb', // Veepeak, Carista, многие китайские BLE
    '0000ffe0-0000-1000-8000-00805f9b34fb', // V-Linker, CC2541, HM-10 BLE
    '6e400001-b5a3-f393-e0a9-e50e24dcca9e', // Nordic UART Service (NUS)
    '000018f0-0000-1000-8000-00805f9b34fb', // OBDLink CX / OBD BLE
    0xfff0,
    0xffe0
  ];

  // --------------------------------------------------------------------------
  // Описания Live Data PIDs (Mode 01)
  // --------------------------------------------------------------------------
  const LIVE_PIDS = {
    '010C': {
      id: 'rpm',
      title: 'Обороты двигателя',
      unit: 'об/мин',
      min: 0,
      max: 8000,
      decode: (a, b) => Math.round(((a * 256) + b) / 4)
    },
    '010D': {
      id: 'speed',
      title: 'Скорость автомобиля',
      unit: 'км/ч',
      min: 0,
      max: 260,
      decode: (a) => a
    },
    '0105': {
      id: 'coolantTemp',
      title: 'Температура ОЖ',
      unit: '°C',
      min: -40,
      max: 150,
      decode: (a) => a - 40
    },
    '0111': {
      id: 'throttle',
      title: 'Положение дросселя',
      unit: '%',
      min: 0,
      max: 100,
      decode: (a) => Math.round((a * 100 / 255) * 10) / 10
    },
    '0104': {
      id: 'engineLoad',
      title: 'Нагрузка на двигатель',
      unit: '%',
      min: 0,
      max: 100,
      decode: (a) => Math.round((a * 100 / 255) * 10) / 10
    },
    '010F': {
      id: 'intakeTemp',
      title: 'Температура впуска',
      unit: '°C',
      min: -40,
      max: 120,
      decode: (a) => a - 40
    },
    '0142': {
      id: 'voltage',
      title: 'Напряжение бортсети',
      unit: 'В',
      min: 0,
      max: 18,
      decode: (a, b) => Math.round(((a * 256 + b) / 1000) * 10) / 10
    }
  };

  /**
   * Класс клиента ELM327 / OBD-II
   */
  class OBD2ClientClass {
    constructor() {
      // Состояние подключения
      this._transport = null; // 'serial' | 'bluetooth' | 'demo' | null
      this._isConnected = false;
      this._deviceName = '';
      this._protocol = '';
      this._vin = null;

      // Специфика Web Serial
      this._serialPort = null;
      this._serialReader = null;
      this._serialWriter = null;
      this._serialReadLoopPromise = null;
      this._serialAbortController = null;

      // Специфика Web Bluetooth
      this._btDevice = null;
      this._btServer = null;
      this._btWriteChar = null;
      this._btNotifyChar = null;

      // Очередь команд и буфер приема
      this._commandQueue = [];
      this._isProcessingCommand = false;
      this._incomingBuffer = '';
      this._pendingCommandResolve = null;
      this._pendingCommandReject = null;
      this._commandTimer = null;

      // Опрос живых параметров (Live Polling)
      this._livePollingTimer = null;
      this._isPollingActive = false;
      this._isPollingCycleRunning = false;
      this._lastLiveSample = null;

      // Состояние демо-симулятора
      this._demoState = {
        tick: 0,
        rpm: 850,
        speed: 0,
        coolantTemp: 91.5,
        throttle: 13.5,
        engineLoad: 21.0,
        intakeTemp: 29.0,
        voltage: 14.1,
        vin: 'WAUZZZ8V1GA123456',
        dtcList: ['P0300', 'P0171'],
        pendingDtcList: ['P0420'],
        permanentDtcList: []
      };

      // Слушатели событий
      this._listeners = {
        connected: [],
        disconnected: [],
        dtc_found: [],
        live_data: [],
        error: [],
        raw_data: []
      };
    }

    // ========================================================================
    // Геттеры состояния
    // ========================================================================
    get isConnected() {
      return this._isConnected;
    }

    get transportType() {
      return this._transport;
    }

    get isPolling() {
      return this._isPollingActive;
    }

    get deviceName() {
      return this._deviceName;
    }

    get detectedProtocol() {
      return this._protocol;
    }

    get vehicleVin() {
      return this._vin;
    }

    get lastTelemetry() {
      return this._lastLiveSample ? { ...this._lastLiveSample } : null;
    }

    /**
     * Сводная информация о текущем статусе
     */
    getStatus() {
      return {
        isConnected: this._isConnected,
        transport: this._transport,
        isPolling: this._isPollingActive,
        deviceName: this._deviceName,
        protocol: this._protocol,
        vin: this._vin,
        lastSample: this._lastLiveSample
      };
    }

    // ========================================================================
    // Система событий: on, off, emit
    // ========================================================================
    on(event, handler) {
      if (typeof handler !== 'function') return this;
      if (!this._listeners[event]) {
        this._listeners[event] = [];
      }
      this._listeners[event].push(handler);
      return this;
    }

    off(event, handler) {
      if (!this._listeners[event]) return this;
      if (!handler) {
        this._listeners[event] = [];
      } else {
        this._listeners[event] = this._listeners[event].filter(h => h !== handler);
      }
      return this;
    }

    _emit(event, data) {
      const handlers = this._listeners[event] || [];
      for (let i = 0; i < handlers.length; i++) {
        try {
          handlers[i](data);
        } catch (err) {
          console.error(`[OBD2Client] Ошибка в обработчике события '${event}':`, err);
        }
      }
    }

    // ========================================================================
    // 1. ПОДКЛЮЧЕНИЕ: Web Serial API (USB / Type-C)
    // ========================================================================
    /**
     * Подключение через Web Serial API
     * @param {Object} [options]
     * @param {number} [options.baudRate=38400] Скорость (38400, 115200, 9600)
     * @param {Array} [options.filters] Фильтры USB Vendor/Product
     */
    async connectSerial(options = {}) {
      if (this._isConnected) {
        await this.disconnect();
      }

      if (typeof navigator === 'undefined' || !navigator.serial) {
        const errorMsg = 'Web Serial API не поддерживается вашим браузером. ' +
          'Для прямого кабельного подключения используйте Google Chrome, Microsoft Edge или Яндекс.Браузер на ПК или Android.';
        this._emit('error', { error: new Error(errorMsg), message: errorMsg, stage: 'connect_serial' });
        throw new Error(errorMsg);
      }

      const baudRate = options.baudRate || 38400;

      try {
        // Запрос выбора порта у пользователя
        const requestOptions = {};
        if (options.filters && Array.isArray(options.filters) && options.filters.length > 0) {
          requestOptions.filters = options.filters;
        }

        const port = await navigator.serial.requestPort(requestOptions);
        if (!port) {
          throw new Error('Порт не был выбран.');
        }

        this._serialPort = port;

        // Открываем последовательный порт
        try {
          await this._serialPort.open({
            baudRate: baudRate,
            dataBits: 8,
            stopBits: 1,
            parity: 'none',
            bufferSize: 8192,
            flowControl: 'none'
          });
        } catch (openErr) {
          if (openErr.name === 'InvalidStateError' || (openErr.message && openErr.message.includes('already open'))) {
            throw new Error('Порт уже открыт или занят другой вкладкой/программой диагностики.');
          }
          throw new Error('Не удалось открыть COM/USB-порт: ' + openErr.message + 
            '. Убедитесь, что закрыты другие программы (ScanMaster, FORScan, PuTTY).');
        }

        this._transport = 'serial';
        this._deviceName = 'ELM327 USB (Serial)';
        this._isConnected = true;

        // Запуск фонового цикла чтения потока
        this._startSerialReadLoop();

        // Первичная инициализация адаптера по протоколу ELM327
        await this._initializeElm327();

        this._emit('connected', {
          transport: 'serial',
          deviceName: this._deviceName,
          baudRate: baudRate,
          protocol: this._protocol
        });

        return { success: true, transport: 'serial', baudRate };
      } catch (err) {
        await this._cleanupConnection();
        let mechanicMsg = err.message || 'Ошибка подключения к USB сканеру';
        if (err.name === 'NotFoundError') {
          mechanicMsg = 'Выбор USB-адаптера отменен пользователем.';
        } else if (err.name === 'SecurityError') {
          mechanicMsg = 'Доступ к USB-портам заблокирован политикой безопасности браузера.';
        }
        this._emit('error', { error: err, message: mechanicMsg, stage: 'connect_serial' });
        throw new Error(mechanicMsg);
      }
    }

    _startSerialReadLoop() {
      const decoder = new TextDecoder();
      const port = this._serialPort;

      const readLoop = async () => {
        while (port && port.readable && this._isConnected) {
          try {
            this._serialReader = port.readable.getReader();
            while (true) {
              const { value, done } = await this._serialReader.read();
              if (done) break;
              if (value) {
                const chunk = decoder.decode(value);
                this._handleIncomingDataChunk(chunk);
              }
            }
          } catch (readErr) {
            if (this._isConnected) {
              console.warn('[OBD2Client] Ошибка потока чтения Serial:', readErr);
            }
            break;
          } finally {
            if (this._serialReader) {
              try {
                this._serialReader.releaseLock();
              } catch (e) {}
              this._serialReader = null;
            }
          }
        }
      };

      this._serialReadLoopPromise = readLoop();
    }

    // ========================================================================
    // 2. ПОДКЛЮЧЕНИЕ: Web Bluetooth API
    // ========================================================================
    /**
     * Беспроводное подключение через Web Bluetooth API
     * @param {Object} [options]
     */
    async connectBluetooth(options = {}) {
      if (this._isConnected) {
        await this.disconnect();
      }

      if (typeof navigator === 'undefined' || !navigator.bluetooth) {
        const errorMsg = 'Web Bluetooth API не поддерживается данным браузером. ' +
          'Включите Bluetooth в системе и используйте Chrome, Edge или Яндекс.Браузер с поддержкой Bluetooth.';
        this._emit('error', { error: new Error(errorMsg), message: errorMsg, stage: 'connect_bluetooth' });
        throw new Error(errorMsg);
      }

      try {
        const device = await navigator.bluetooth.requestDevice({
          acceptAllDevices: true,
          optionalServices: BLE_OBD_SERVICES
        });

        if (!device) {
          throw new Error('Bluetooth-устройство не выбрано.');
        }

        this._btDevice = device;
        this._deviceName = device.name || 'ELM327 Bluetooth';

        // Слушатель аварийного отключения
        this._btDevice.addEventListener('gattserverdisconnected', () => {
          this._handleGattDisconnect();
        });

        // Подключаемся к GATT-серверу
        const server = await device.gatt.connect();
        this._btServer = server;

        // Поиск сервиса и характеристик приема/передачи
        let writeChar = null;
        let notifyChar = null;

        for (const sUuid of BLE_OBD_SERVICES) {
          try {
            const service = await server.getPrimaryService(sUuid);
            const chars = await service.getCharacteristics();

            for (const ch of chars) {
              const props = ch.properties;
              if (props.write || props.writeWithoutResponse) {
                if (!writeChar) writeChar = ch;
              }
              if (props.notify || props.indicate) {
                if (!notifyChar) notifyChar = ch;
              }
            }

            if (writeChar && notifyChar) {
              break;
            }
          } catch (e) {
            // Переходим к следующему возможному сервису
          }
        }

        if (!writeChar || !notifyChar) {
          throw new Error('Не удалось обнаружить характеристику приема/передачи OBD-II. ' +
            'Убедитесь, что выбранный адаптер поддерживает BLE 4.0/SPP GATT.');
        }

        this._btWriteChar = writeChar;
        this._btNotifyChar = notifyChar;

        // Включаем уведомления от адаптера
        await this._btNotifyChar.startNotifications();
        this._btNotifyChar.addEventListener('characteristicvaluechanged', (e) => {
          const val = e.target.value;
          const decoder = new TextDecoder();
          const chunk = decoder.decode(val);
          this._handleIncomingDataChunk(chunk);
        });

        this._transport = 'bluetooth';
        this._isConnected = true;

        // Первичная инициализация ELM327
        await this._initializeElm327();

        this._emit('connected', {
          transport: 'bluetooth',
          deviceName: this._deviceName,
          protocol: this._protocol
        });

        return { success: true, transport: 'bluetooth', deviceName: this._deviceName };
      } catch (err) {
        await this._cleanupConnection();
        let mechanicMsg = err.message || 'Ошибка подключения к Bluetooth адаптеру';
        if (err.name === 'NotFoundError') {
          mechanicMsg = 'Поиск устройств Bluetooth отменен пользователем.';
        } else if (err.name === 'SecurityError') {
          mechanicMsg = 'Доступ к Bluetooth заблокирован политикой безопасности браузера.';
        }
        this._emit('error', { error: err, message: mechanicMsg, stage: 'connect_bluetooth' });
        throw new Error(mechanicMsg);
      }
    }

    _handleGattDisconnect() {
      if (this._isConnected) {
        const msg = 'Беспроводная связь с адаптером ELM327 прервана (GATT disconnected).';
        this._cleanupConnection();
        this._emit('disconnected', { reason: msg, transport: 'bluetooth' });
        this._emit('error', { error: new Error(msg), message: msg, stage: 'bluetooth_disconnect' });
      }
    }

    // ========================================================================
    // 3. ПОДКЛЮЧЕНИЕ: ДЕМО-СИМУЛЯТОР (Виртуальный ELM327)
    // ========================================================================
    /**
     * Подключение виртуального демо-адаптера для мастерской
     */
    async connectDemo() {
      if (this._isConnected) {
        await this.disconnect();
      }

      this._transport = 'demo';
      this._deviceName = 'Виртуальный ELM327 (Демо-стенд ИИдеал Авто)';
      this._protocol = 'ISO 15765-4 (CAN 11/500)';
      this._isConnected = true;
      this._vin = 'WAUZZZ8V1GA123456';

      // Сброс демо параметров к эталону
      this._demoState.tick = 0;
      this._demoState.rpm = 848;
      this._demoState.speed = 0;
      this._demoState.coolantTemp = 91.5;
      this._demoState.throttle = 13.8;
      this._demoState.engineLoad = 21.2;
      this._demoState.intakeTemp = 29.5;
      this._demoState.voltage = 14.1;
      this._demoState.dtcList = ['P0300', 'P0171'];
      this._demoState.pendingDtcList = ['P0420'];
      this._demoState.permanentDtcList = [];

      // Эмулируем задержку рукопожатия ATZ
      await new Promise(r => setTimeout(r, 250));

      this._emit('connected', {
        transport: 'demo',
        deviceName: this._deviceName,
        protocol: this._protocol,
        isDemo: true
      });

      return {
        success: true,
        transport: 'demo',
        deviceName: this._deviceName,
        protocol: this._protocol
      };
    }

    // ========================================================================
    // 4. ПРОТОКОЛ ИНИЦИАЛИЗАЦИИ ELM327
    // ========================================================================
    /**
     * Последовательность AT-команд для надежной настройки ELM327
     */
    async _initializeElm327() {
      // 1. Сброс адаптера ATZ
      try {
        const atzResp = await this.sendCommand('ATZ', 3000);
        // Небольшая технологическая пауза для перезагрузки чипа PIC18F25K80
        await new Promise(r => setTimeout(r, 400));
      } catch (e) {
        console.warn('[OBD2Client] ATZ не ответил вовремя, пробуем продолжить...');
      }

      // 2. ATE0: Отключаем эхо
      await this.sendCommand('ATE0', 2000);

      // 3. ATL0: Отключаем перевод строки (Linefeeds Off)
      await this.sendCommand('ATL0', 2000);

      // 4. ATH0: Отключаем заголовки шины (Headers Off)
      await this.sendCommand('ATH0', 2000);

      // 5. ATSP0: Автоматический выбор протокола OBD-II
      await this.sendCommand('ATSP0', 2000);

      // 6. Проверка связи с ЭБУ автомобиля (Mode 01 PID 00)
      try {
        const ecuCheck = await this.sendCommand('0100', 5000);
        if (ecuCheck.includes('UNABLE TO CONNECT') || ecuCheck.includes('BUS INIT: ERROR')) {
          throw new Error('Адаптер ELM327 подключен, но нет связи с ЭБУ двигателя! ' +
            'Включите зажигание автомобиля (положение ON / ACC).');
        }
      } catch (ecuErr) {
        if (ecuErr.message && ecuErr.message.includes('Включите зажигание')) {
          throw ecuErr;
        }
        // Если таймаут или нет ответа — предупреждаем механика
        console.warn('[OBD2Client] Проверка зажигания 0100:', ecuErr.message);
      }

      // 7. Определение установленного протокола
      try {
        const protoResp = await this.sendCommand('ATDP', 1500);
        this._protocol = protoResp.replace(/[\r\n>]/g, '').trim() || 'ISO 15765-4 (CAN)';
      } catch (e) {
        this._protocol = 'Auto Protocol (OBD-II)';
      }
    }

    // ========================================================================
    // 5. ОТПРАВКА КОМАНД И ОБРАБОТКА БУФЕРА ПРИЕМА
    // ========================================================================
    /**
     * Потокобезопасная отправка команды ELM327
     * @param {string} command Команда (например '010C', 'ATZ', '03')
     * @param {number} [timeoutMs=3500] Таймаут ответа
     * @returns {Promise<string>}
     */
    sendCommand(command, timeoutMs = 3500) {
      if (!this._isConnected) {
        return Promise.reject(new Error('Адаптер ELM327 не подключен. Сначала выполните connectSerial() или connectBluetooth().'));
      }

      return new Promise((resolve, reject) => {
        this._commandQueue.push({
          cmd: command.trim(),
          timeoutMs: timeoutMs,
          resolve: resolve,
          reject: reject
        });

        this._processNextInQueue();
      });
    }

    async _processNextInQueue() {
      if (this._isProcessingCommand || this._commandQueue.length === 0) {
        return;
      }

      this._isProcessingCommand = true;
      const item = this._commandQueue.shift();

      this._pendingCommandResolve = item.resolve;
      this._pendingCommandReject = item.reject;
      this._incomingBuffer = '';

      const cmdStr = item.cmd;
      this._emit('raw_data', { direction: 'send', data: cmdStr });

      // Устанавливаем таймер таймаута
      this._commandTimer = setTimeout(() => {
        const err = new Error(`Таймаут ожидания ответа от ELM327 на команду '${cmdStr}' (${item.timeoutMs} мс). ` +
          `Проверьте надежность кабеля или беспроводного подключения.`);
        this._finishCurrentCommand(null, err);
      }, item.timeoutMs);

      try {
        if (this._transport === 'demo') {
          // Имитируем ответ виртуального стенда
          this._respondDemoCommand(cmdStr);
        } else if (this._transport === 'serial') {
          // Запись в Web Serial
          const encoder = new TextEncoder();
          const writer = this._serialPort.writable.getWriter();
          try {
            await writer.write(encoder.encode(cmdStr + '\r'));
          } finally {
            writer.releaseLock();
          }
        } else if (this._transport === 'bluetooth') {
          // Запись в Web Bluetooth
          const encoder = new TextEncoder();
          const data = encoder.encode(cmdStr + '\r');

          // Если размер превышает 20 байт, отправляем фрагментами по MTU
          if (data.length <= 20) {
            await this._btWriteChar.writeValue(data);
          } else {
            for (let i = 0; i < data.length; i += 20) {
              const slice = data.slice(i, i + 20);
              await this._btWriteChar.writeValue(slice);
              await new Promise(r => setTimeout(r, 15));
            }
          }
        }
      } catch (writeErr) {
        this._finishCurrentCommand(null, new Error(`Ошибка передачи данных в адаптер: ${writeErr.message}`));
      }
    }

    /**
     * Обработка входящего куска данных из UART / Bluetooth потока
     */
    _handleIncomingDataChunk(chunk) {
      this._incomingBuffer += chunk;
      this._emit('raw_data', { direction: 'recv', data: chunk });

      // Маркером завершения команды ELM327 всегда является символ '>' (Prompt)
      const promptIdx = this._incomingBuffer.indexOf('>');
      if (promptIdx !== -1) {
        const fullResponse = this._incomingBuffer.slice(0, promptIdx);
        this._incomingBuffer = this._incomingBuffer.slice(promptIdx + 1);
        this._finishCurrentCommand(fullResponse, null);
      }
    }

    _finishCurrentCommand(response, error) {
      if (this._commandTimer) {
        clearTimeout(this._commandTimer);
        this._commandTimer = null;
      }

      const resolve = this._pendingCommandResolve;
      const reject = this._pendingCommandReject;
      this._pendingCommandResolve = null;
      this._pendingCommandReject = null;
      this._isProcessingCommand = false;

      if (error) {
        if (reject) reject(error);
      } else {
        const cleaned = (response || '').trim();
        // Диагностика типовых ошибок чипа ELM327
        if (cleaned.includes('UNABLE TO CONNECT')) {
          const err = new Error('ЭБУ не отвечает (UNABLE TO CONNECT). Проверьте зажигание автомобиля.');
          if (reject) reject(err);
        } else if (cleaned.includes('BUS INIT: ERROR') || cleaned.includes('BUS INIT: ...ERROR')) {
          const err = new Error('Ошибка инициализации шины CAN/K-Line (BUS INIT ERROR). Проверьте разъем OBD2.');
          if (reject) reject(err);
        } else {
          if (resolve) resolve(cleaned);
        }
      }

      // Запускаем следующую команду из очереди
      setTimeout(() => this._processNextInQueue(), 10);
    }

    // ========================================================================
    // 6. ОТВЕТЫ ДЕМО-СИМУЛЯТОРА
    // ========================================================================
    _respondDemoCommand(cmd) {
      const c = cmd.toUpperCase().replace(/\s+/g, '');
      let delay = 35 + Math.random() * 25; // 35-60 мс реальной физики UART
      let response = '';

      if (c === 'ATZ') {
        delay = 180;
        response = 'ELM327 v1.5\r\r>';
      } else if (c === 'ATE0' || c === 'ATL0' || c === 'ATH0' || c === 'ATSP0') {
        response = 'OK\r\r>';
      } else if (c === 'ATDP') {
        response = 'ISO 15765-4 (CAN 11/500)\r\r>';
      } else if (c === '0100') {
        // Поддерживаемые PID 01-20
        response = '41 00 BE 3F B8 11\r\r>';
      } else if (c === '010C') {
        // Обороты двигателя (RPM)
        this._demoState.tick++;
        const idleWave = Math.sin(this._demoState.tick * 0.4) * 25;
        const currentRpm = Math.max(650, Math.min(6500, Math.round(this._demoState.rpm + idleWave)));
        const raw = Math.round(currentRpm * 4);
        const a = (raw >> 8) & 0xFF;
        const b = raw & 0xFF;
        response = `41 0C ${a.toString(16).padStart(2, '0').toUpperCase()} ${b.toString(16).padStart(2, '0').toUpperCase()}\r\r>`;
      } else if (c === '010D') {
        // Скорость автомобиля (Speed)
        // Плавное ускорение и замедление 0..65 км/ч
        const speedCycle = Math.round((Math.sin(this._demoState.tick * 0.1) + 1) * 28);
        this._demoState.speed = speedCycle;
        response = `41 0D ${speedCycle.toString(16).padStart(2, '0').toUpperCase()}\r\r>`;
      } else if (c === '0105') {
        // Температура ОЖ: 90..93°C
        const temp = Math.round(92 + Math.sin(this._demoState.tick * 0.15) * 1.5);
        const a = temp + 40;
        response = `41 05 ${a.toString(16).padStart(2, '0').toUpperCase()}\r\r>`;
      } else if (c === '0111') {
        // Дроссельная заслонка (Throttle)
        const throttlePercent = this._demoState.speed > 5 ? 24.5 : 13.8;
        const a = Math.round((throttlePercent * 255) / 100);
        response = `41 11 ${a.toString(16).padStart(2, '0').toUpperCase()}\r\r>`;
      } else if (c === '0104') {
        // Расчетная нагрузка на двигатель (Load)
        const loadPercent = this._demoState.speed > 5 ? 38.0 : 21.5;
        const a = Math.round((loadPercent * 255) / 100);
        response = `41 04 ${a.toString(16).padStart(2, '0').toUpperCase()}\r\r>`;
      } else if (c === '010F') {
        // Температура воздуха во впускном коллекторе (IAT): ~29-31°C
        const temp = 30;
        const a = temp + 40;
        response = `41 0F ${a.toString(16).padStart(2, '0').toUpperCase()}\r\r>`;
      } else if (c === '0142') {
        // Напряжение бортсети: 14.1 В
        const raw = 14100;
        const a = (raw >> 8) & 0xFF;
        const b = raw & 0xFF;
        response = `41 42 ${a.toString(16).padStart(2, '0').toUpperCase()} ${b.toString(16).padStart(2, '0').toUpperCase()}\r\r>`;
      } else if (c === '03') {
        // Mode 03: Активные сохраненные ошибки
        if (this._demoState.dtcList.length === 0) {
          response = 'NO DATA\r\r>';
        } else {
          // Эмулируем стандартный ответ CAN: 43 02 03 00 01 71 (P0300, P0171)
          response = '43 02 03 00 01 71\r\r>';
        }
      } else if (c === '07') {
        // Mode 07: Pending DTCs
        if (this._demoState.pendingDtcList.length === 0) {
          response = 'NO DATA\r\r>';
        } else {
          response = '47 01 04 20\r\r>'; // P0420
        }
      } else if (c === '0A') {
        // Mode 0A: Permanent DTCs
        response = 'NO DATA\r\r>';
      } else if (c === '0902' || c === '09 02') {
        // VIN: WAUZZZ8V1GA123456
        // Мультифреймовый ответ CAN
        response = '0: 49 02 01 57 41 55\r' +
                   '1: 5A 5A 5A 38 56 31 47\r' +
                   '2: 41 31 32 33 34 35 36\r\r>';
      } else if (c === '04') {
        // Сброс кодов ошибок
        this._demoState.dtcList = [];
        this._demoState.pendingDtcList = [];
        this._demoState.permanentDtcList = [];
        response = '44\r\r>';
      } else {
        response = 'NO DATA\r\r>';
      }

      setTimeout(() => {
        this._handleIncomingDataChunk(response);
      }, delay);
    }

    // ========================================================================
    // 7. СЧИТЫВАНИЕ КОДОВ НЕИСПРАВНОСТЕЙ (DTC: Mode 03, 07, 0A)
    // ========================================================================
    /**
     * Считывание кодов неисправностей автомобиля
     * @param {Object} [options]
     * @param {boolean} [options.includePending=true] Считать ожидающие (Mode 07)
     * @param {boolean} [options.includePermanent=true] Считать постоянные (Mode 0A)
     * @param {boolean} [options.detailed=false] Возвращать массив объектов с описанием
     * @returns {Promise<Array<string>|Array<Object>>}
     */
    async readDtcCodes(options = {}) {
      if (!this._isConnected) {
        throw new Error('Для чтения кодов ошибок подключите адаптер ELM327.');
      }

      const includePending = options.includePending !== false;
      const includePermanent = options.includePermanent !== false;
      const detailed = options.detailed === true;

      const codeMap = new Map(); // код -> { code, type: 'active'|'pending'|'permanent', description }

      // 1. Чтение сохраненных кодов (Mode 03)
      try {
        const resp03 = await this.sendCommand('03', 4500);
        const codes03 = this._parseDtcResponse(resp03, '43');
        for (const code of codes03) {
          codeMap.set(code, {
            code: code,
            category: this._getDtcCategory(code),
            type: 'active',
            typeLabel: 'Активная (сохраненная)',
            description: DTC_DICTIONARY_RU[code] || 'Описание кода отсутствует в базе'
          });
        }
      } catch (err) {
        console.warn('[OBD2Client] Ошибка чтения Mode 03:', err.message);
      }

      // 2. Чтение ожидающих кодов (Mode 07)
      if (includePending) {
        try {
          const resp07 = await this.sendCommand('07', 4000);
          const codes07 = this._parseDtcResponse(resp07, '47');
          for (const code of codes07) {
            if (!codeMap.has(code)) {
              codeMap.set(code, {
                code: code,
                category: this._getDtcCategory(code),
                type: 'pending',
                typeLabel: 'Ожидающая (Pending)',
                description: DTC_DICTIONARY_RU[code] || 'Описание кода отсутствует в базе'
              });
            }
          }
        } catch (err) {
          console.warn('[OBD2Client] Ошибка чтения Mode 07:', err.message);
        }
      }

      // 3. Чтение постоянных кодов (Mode 0A)
      if (includePermanent) {
        try {
          const resp0A = await this.sendCommand('0A', 4000);
          const codes0A = this._parseDtcResponse(resp0A, '4A');
          for (const code of codes0A) {
            if (!codeMap.has(code)) {
              codeMap.set(code, {
                code: code,
                category: this._getDtcCategory(code),
                type: 'permanent',
                typeLabel: 'Постоянная (Permanent)',
                description: DTC_DICTIONARY_RU[code] || 'Описание кода отсутствует в базе'
              });
            }
          }
        } catch (err) {
          console.warn('[OBD2Client] Ошибка чтения Mode 0A:', err.message);
        }
      }

      const detailedArray = Array.from(codeMap.values());
      const simpleArray = Array.from(codeMap.keys());

      // Генерируем событие для интерфейса
      this._emit('dtc_found', {
        codes: simpleArray,
        items: detailedArray,
        count: simpleArray.length,
        timestamp: Date.now()
      });

      return detailed ? detailedArray : simpleArray;
    }

    /**
     * Парсер ответов Mode 03, 07, 0A по стандарту SAE J1979 / ISO 15031-5
     */
    _parseDtcResponse(rawText, expectedEchoHeader) {
      if (!rawText || rawText.includes('NO DATA') || rawText.includes('NODATA')) {
        return [];
      }

      // 1. Очищаем от номеров строк CAN (0:, 1:, 2:) и служебных символов
      const cleaned = rawText
        .replace(/^[0-9A-Fa-f]:/gm, '')
        .replace(/[\r\n>]/g, ' ')
        .trim();

      // 2. Разбиваем на байты
      const tokens = cleaned.split(/\s+/).filter(t => t.length > 0);
      const hexBytes = [];

      for (const tok of tokens) {
        if (/^[0-9A-Fa-f]{2}$/.test(tok)) {
          hexBytes.push(tok.toUpperCase());
        } else if (/^[0-9A-Fa-f]{4,}$/.test(tok)) {
          // Если байты слиплись
          for (let i = 0; i < tok.length; i += 2) {
            hexBytes.push(tok.slice(i, i + 2).toUpperCase());
          }
        }
      }

      if (hexBytes.length === 0) {
        return [];
      }

      // 3. Ищем заголовок ответа (43, 47 или 4A)
      let startIdx = hexBytes.indexOf(expectedEchoHeader.toUpperCase());
      if (startIdx === -1) {
        return [];
      }

      // Байты после заголовка ответа
      let dataBytes = hexBytes.slice(startIdx + 1);
      if (dataBytes.length === 0) return [];

      // Проверяем: первый байт может быть количеством ошибок (DTC count)
      // Если остаток байт делится на 2 (2 байта на код), а первый байт задает кол-во кодов
      if (dataBytes.length % 2 === 1) {
        dataBytes = dataBytes.slice(1);
      } else {
        const firstByteVal = parseInt(dataBytes[0], 16);
        if (firstByteVal > 0 && firstByteVal <= (dataBytes.length - 1) / 2) {
          dataBytes = dataBytes.slice(1);
        }
      }

      const codes = [];
      const prefixLetters = ['P', 'C', 'B', 'U'];

      for (let i = 0; i + 1 < dataBytes.length; i += 2) {
        const b1 = parseInt(dataBytes[i], 16);
        const b2 = parseInt(dataBytes[i + 1], 16);

        // 00 00 — заполнитель (нет кода)
        if (b1 === 0 && b2 === 0) continue;

        // Биты b1:
        // Биты 7-6: Тип системы (00=P, 01=C, 10=B, 11=U)
        const prefix = prefixLetters[(b1 >> 6) & 0x03];
        // Биты 5-4: Первая цифра (0, 1, 2, 3)
        const d1 = (b1 >> 4) & 0x03;
        // Биты 3-0: Вторая цифра (HEX 0-F)
        const d2 = (b1 & 0x0F).toString(16).toUpperCase();
        // Байт b2: Третья и четвертая цифры (HEX 00-FF)
        const d34 = b2.toString(16).padStart(2, '0').toUpperCase();

        const fullCode = `${prefix}${d1}${d2}${d34}`;
        if (!codes.includes(fullCode)) {
          codes.push(fullCode);
        }
      }

      return codes;
    }

    _getDtcCategory(code) {
      if (!code || code.length === 0) return 'Неизвестно';
      const c = code.charAt(0).toUpperCase();
      switch (c) {
        case 'P': return 'Двигатель и трансмиссия (Powertrain)';
        case 'C': return 'Шасси, тормоза и подвеска (Chassis)';
        case 'B': return 'Кузовная электроника и безопасность (Body)';
        case 'U': return 'Сетевые коммуникации и шина CAN (Network)';
        default: return 'Общая система';
      }
    }

    /**
     * Получить русское описание любого кода DTC
     */
    getDtcDescription(code) {
      const upper = (code || '').toUpperCase().trim();
      return DTC_DICTIONARY_RU[upper] || 'Описание кода отсутствует в стандартной базе OBD-II';
    }

    // ========================================================================
    // 8. СЧИТЫВАНИЕ VIN НОМЕРА (Mode 09 02)
    // ========================================================================
    /**
     * Считывание 17-значного VIN номера автомобиля
     * @returns {Promise<string>}
     */
    async readVin() {
      if (!this._isConnected) {
        throw new Error('Для чтения VIN подключите адаптер ELM327.');
      }

      try {
        const resp = await this.sendCommand('0902', 4500);
        const vin = this._parseVinResponse(resp);
        if (vin) {
          this._vin = vin;
          return vin;
        }
        throw new Error('Автомобиль не передал VIN номер или протокол не поддерживается блоком.');
      } catch (err) {
        console.warn('[OBD2Client] Ошибка считывания VIN:', err.message);
        throw err;
      }
    }

    /**
     * Парсер мультифреймового ответа VIN (Mode 09 PID 02)
     */
    _parseVinResponse(rawText) {
      if (!rawText || rawText.includes('NO DATA')) {
        return null;
      }

      const lines = rawText.split(/[\r\n]+/).map(l => l.trim()).filter(Boolean);
      const asciiCodes = [];

      for (let line of lines) {
        // Удаляем CAN-префиксы вида '0:', '1:', '2:'
        line = line.replace(/^[0-9A-Fa-f]:/, '').trim();
        const tokens = line.split(/\s+/).filter(Boolean);

        // Ищем в строке маркер '49' '02'
        let startIndex = -1;
        for (let i = 0; i < tokens.length - 1; i++) {
          if (tokens[i].toUpperCase() === '49' && tokens[i + 1] === '02') {
            startIndex = i + 2;
            break;
          }
        }

        let payloadTokens = [];
        if (startIndex !== -1) {
          payloadTokens = tokens.slice(startIndex);
          // Если первый байт — порядковый номер пакета (01, 02), пропускаем его
          if (payloadTokens.length > 0 && /^[0-9A-Fa-f]{2}$/.test(payloadTokens[0])) {
            const firstByte = parseInt(payloadTokens[0], 16);
            if (firstByte >= 1 && firstByte <= 5) {
              payloadTokens = payloadTokens.slice(1);
            }
          }
        } else {
          // Продолжение мультифрейма без повтора 49 02
          payloadTokens = tokens;
        }

        for (const hex of payloadTokens) {
          if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
            const code = parseInt(hex, 16);
            // Печатные символы ASCII (0-9, A-Z)
            if (code >= 32 && code <= 126) {
              asciiCodes.push(String.fromCharCode(code));
            }
          }
        }
      }

      const reconstructed = asciiCodes.join('').trim();

      // По стандарту ISO 3779 VIN состоит из 17 символов без букв I, O, Q
      const vinMatch = reconstructed.match(/[A-HJ-NPR-Z0-9]{17}/i);
      if (vinMatch) {
        return vinMatch[0].toUpperCase();
      }

      // Если в строке 17 любых буквенно-цифровых символов
      const fallbackMatch = reconstructed.match(/[A-Z0-9]{17}/i);
      if (fallbackMatch) {
        return fallbackMatch[0].toUpperCase();
      }

      return reconstructed.length >= 11 ? reconstructed : null;
    }

    // ========================================================================
    // 9. СБРОС КОДОВ ОШИБОК (Clear DTCs: Mode 04)
    // ========================================================================
    /**
     * Сброс кодов неисправностей в блоке управления
     * ВНИМАНИЕ: Требует явного подтверждения механика!
     * @param {Object} options
     * @param {boolean} options.confirmed Подтверждение операции
     */
    async clearDtcCodes(options = {}) {
      if (!this._isConnected) {
        throw new Error('Для сброса кодов ошибок подключите адаптер ELM327.');
      }

      if (!options || options.confirmed !== true) {
        throw new Error('Для сброса кодов ошибок требуется явное подтверждение автомеханика! ' +
          'Передайте { confirmed: true } для выполнения команды.');
      }

      try {
        const resp = await this.sendCommand('04', 5000);
        // Ответ на команду 04 обычно '44', 'OK' или пустой prompt '>'
        if (resp.includes('44') || resp.includes('OK') || resp === '') {
          this._emit('dtc_found', { codes: [], items: [], count: 0, timestamp: Date.now() });
          return {
            success: true,
            message: 'Коды неисправностей (DTC) и данные Freeze Frame успешно очищены в ЭБУ автомобиля.'
          };
        } else {
          return {
            success: true,
            message: `Команда сброса отправлена. Ответ адаптера: ${resp}`
          };
        }
      } catch (err) {
        const msg = `Не удалось выполнить сброс кодов ошибок: ${err.message}`;
        this._emit('error', { error: err, message: msg, stage: 'clear_dtc' });
        throw new Error(msg);
      }
    }

    // ========================================================================
    // 10. ОПРОС ЖИВЫХ ПАРАМЕТРОВ (LIVE POLLING)
    // ========================================================================
    /**
     * Однократное чтение основных параметров реального времени
     */
    async readLiveData() {
      if (!this._isConnected) {
        throw new Error('Адаптер ELM327 не подключен.');
      }

      const sample = {
        rpm: null,
        speed: null,
        coolantTemp: null,
        throttle: null,
        engineLoad: null,
        intakeTemp: null,
        voltage: null,
        timestamp: Date.now()
      };

      const pids = ['010C', '010D', '0105', '0111', '0104', '010F'];

      for (const pid of pids) {
        if (!this._isConnected) break;
        try {
          const resp = await this.sendCommand(pid, 1800);
          const val = this._decodeLivePid(pid, resp);
          if (val !== null) {
            const def = LIVE_PIDS[pid];
            if (def) sample[def.id] = val;
          }
        } catch (e) {
          // Пропускаем отдельный сбойный PID, чтобы не ломать весь кадр
        }
      }

      this._lastLiveSample = sample;
      return sample;
    }

    /**
     * Декодирование ответа Mode 01 PID
     */
    _decodeLivePid(pid, rawText) {
      if (!rawText || rawText.includes('NO DATA')) return null;

      const cleaned = rawText.replace(/[\r\n>]/g, ' ').trim();
      const tokens = cleaned.split(/\s+/).filter(Boolean);

      const targetHeader = '41';
      const targetPidHex = pid.slice(2).toUpperCase();

      let pIdx = -1;
      for (let i = 0; i < tokens.length - 1; i++) {
        if (tokens[i].toUpperCase() === targetHeader && tokens[i + 1].toUpperCase() === targetPidHex) {
          pIdx = i + 2;
          break;
        }
      }

      if (pIdx === -1) {
        // Если ответ компактный без пробелов
        const compact = cleaned.replace(/\s+/g, '').toUpperCase();
        const needle = '41' + targetPidHex;
        const nIdx = compact.indexOf(needle);
        if (nIdx !== -1) {
          const dataStr = compact.slice(nIdx + needle.length);
          const a = parseInt(dataStr.slice(0, 2), 16);
          const b = parseInt(dataStr.slice(2, 4), 16);
          const def = LIVE_PIDS[pid];
          if (def && !isNaN(a)) {
            return def.decode(a, isNaN(b) ? 0 : b);
          }
        }
        return null;
      }

      const aHex = tokens[pIdx];
      const bHex = tokens[pIdx + 1];
      const a = aHex ? parseInt(aHex, 16) : NaN;
      const b = bHex ? parseInt(bHex, 16) : 0;

      const def = LIVE_PIDS[pid];
      if (def && !isNaN(a)) {
        return def.decode(a, isNaN(b) ? 0 : b);
      }

      return null;
    }

    /**
     * Запуск циклического опроса телеметрии (Live Polling)
     * @param {Function} [callback] Функция обратного вызова (data) => void
     * @param {number} [intervalMs=500] Интервал опроса в миллисекундах
     */
    startLivePolling(callback, intervalMs = 500) {
      if (this._isPollingActive) {
        this.stopLivePolling();
      }

      if (typeof callback === 'function') {
        this.on('live_data', callback);
      }

      this._isPollingActive = true;
      const effectiveInterval = Math.max(100, intervalMs);

      const pollCycle = async () => {
        if (!this._isPollingActive || !this._isConnected) return;
        if (this._isPollingCycleRunning) return; // предотвращаем наложение циклов

        this._isPollingCycleRunning = true;
        try {
          const sample = await this.readLiveData();
          if (this._isPollingActive && this._isConnected) {
            this._emit('live_data', sample);
          }
        } catch (pollErr) {
          if (this._isConnected) {
            console.warn('[OBD2Client] Ошибка цикла live_data:', pollErr.message);
          }
        } finally {
          this._isPollingCycleRunning = false;
          if (this._isPollingActive && this._isConnected) {
            this._livePollingTimer = setTimeout(pollCycle, effectiveInterval);
          }
        }
      };

      // Первый опрос сразу
      pollCycle();
    }

    /**
     * Остановка циклического опроса
     */
    stopLivePolling() {
      this._isPollingActive = false;
      if (this._livePollingTimer) {
        clearTimeout(this._livePollingTimer);
        this._livePollingTimer = null;
      }
    }

    // ========================================================================
    // 11. ОТКЛЮЧЕНИЕ И ОСВОБОЖДЕНИЕ РЕСУРСОВ
    // ========================================================================
    /**
     * Корректный разрыв соединения с адаптером
     */
    async disconnect() {
      this.stopLivePolling();

      const prevTransport = this._transport;
      await this._cleanupConnection();

      if (prevTransport) {
        this._emit('disconnected', {
          transport: prevTransport,
          reason: 'Соединение разорвано пользователем.'
        });
      }

      return { success: true };
    }

    async _cleanupConnection() {
      this.stopLivePolling();

      // Сброс очереди команд
      if (this._commandTimer) {
        clearTimeout(this._commandTimer);
        this._commandTimer = null;
      }
      while (this._commandQueue.length > 0) {
        const item = this._commandQueue.shift();
        if (item.reject) {
          item.reject(new Error('Операция отменена из-за отключения устройства.'));
        }
      }
      if (this._pendingCommandReject) {
        this._pendingCommandReject(new Error('Устройство отключено.'));
      }
      this._pendingCommandResolve = null;
      this._pendingCommandReject = null;
      this._isProcessingCommand = false;
      this._incomingBuffer = '';

      // Закрытие Web Serial
      if (this._serialReader) {
        try {
          await this._serialReader.cancel();
        } catch (e) {}
        try {
          this._serialReader.releaseLock();
        } catch (e) {}
        this._serialReader = null;
      }

      if (this._serialPort) {
        try {
          await this._serialPort.close();
        } catch (e) {}
        this._serialPort = null;
      }

      // Закрытие Web Bluetooth
      if (this._btNotifyChar) {
        try {
          await this._btNotifyChar.stopNotifications();
        } catch (e) {}
        this._btNotifyChar = null;
      }
      this._btWriteChar = null;

      if (this._btServer && this._btServer.connected) {
        try {
          this._btServer.disconnect();
        } catch (e) {}
      }
      this._btServer = null;
      this._btDevice = null;

      this._transport = null;
      this._isConnected = false;
      this._deviceName = '';
      this._protocol = '';
    }
  }

  // Создаем глобальный синглтон-клиент для прямого вызова
  const defaultClient = new OBD2ClientClass();

  // Прикрепляем ссылку на конструктор для расширения
  defaultClient.OBD2Client = OBD2ClientClass;

  // Экспорт в глобальную область видимости (window / globalThis / self)
  if (typeof global !== 'undefined') {
    global.OBD2Client = defaultClient;
  }
  if (typeof window !== 'undefined') {
    window.OBD2Client = defaultClient;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = defaultClient;
  }

})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
