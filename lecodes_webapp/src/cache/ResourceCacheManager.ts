/**
 * Менеджер интеллектуального кэширования ресурсов веб-приложения (Cache API + LocalStorage).
 * Кэширует:
 * 1. Полный словарь кодов неисправностей OBD-II (DTC) для мгновенного поиска офлайн (0ms latency).
 * 2. Диагностические сессии, историю переписки, чеклисты и профили автомобилей.
 * 3. Статические ресурсы и медиа-бейджи.
 * 4. Очередь отложенных запросов (Offline Request Queue).
 */

import { DiagnosticSessionItem, DtcCodeInfo } from "../types";

const CACHE_NAME = "aideal-lecodes-cache-v1";
const STORAGE_KEY_DTC = "aideal_cached_dtc_dict";
const STORAGE_KEY_SESSIONS = "aideal_cached_sessions";
const STORAGE_KEY_QUEUE = "aideal_offline_queue";
const STORAGE_KEY_SETTINGS = "aideal_app_settings";

export interface CacheStats {
  dtcCount: number;
  sessionsCount: number;
  queueCount: number;
  lastDtcSync: string;
  cacheApiSupported: boolean;
}

export interface OfflineQueueItem {
  id: string;
  action: string;
  payload: any;
  timestamp: string;
}

export class ResourceCacheManager {
  private inMemoryDtc: Map<string, DtcCodeInfo> = new Map();
  private isLoaded: boolean = false;

  constructor() {
    this.loadDtcFromLocalStorage();
  }

  public isCacheApiSupported(): boolean {
    return typeof caches !== "undefined";
  }

  /**
   * Сохраняет полный словарь DTC кодов в кэш (L1 Memory, L2 LocalStorage, L3 Cache API)
   */
  public async cacheDtcDictionary(dtcList: DtcCodeInfo[]): Promise<void> {
    if (!dtcList || dtcList.length === 0) return;

    this.inMemoryDtc.clear();
    for (const item of dtcList) {
      this.inMemoryDtc.set(item.code.toUpperCase(), item);
    }

    try {
      localStorage.setItem(STORAGE_KEY_DTC, JSON.stringify(dtcList));
      localStorage.setItem(STORAGE_KEY_DTC + "_time", new Date().toISOString());
    } catch (e) {
      console.warn("Превышен лимит localStorage для словаря DTC:", e);
    }

    // Дополнительно кэшируем через Cache API для PWA
    if (this.isCacheApiSupported()) {
      try {
        const cache = await caches.open(CACHE_NAME);
        const targetUrl = typeof window !== "undefined" && window.location?.origin
          ? `${window.location.origin}/api/dtc/cached`
          : "http://localhost/api/dtc/cached";
        const response = new Response(JSON.stringify(dtcList), {
          headers: { "Content-Type": "application/json" }
        });
        await cache.put(targetUrl, response);
      } catch (err) {
        console.warn("Ошибка сохранения в Cache API:", err);
      }
    }
  }

  /**
   * Восстанавливает словарь DTC из Cache API, если localStorage был очищен
   */
  public async loadFromCacheApi(): Promise<boolean> {
    if (!this.isCacheApiSupported()) return false;
    try {
      const cache = await caches.open(CACHE_NAME);
      const targetUrl = typeof window !== "undefined" && window.location?.origin
        ? `${window.location.origin}/api/dtc/cached`
        : "http://localhost/api/dtc/cached";
      const resp = await cache.match(targetUrl);
      if (resp) {
        const list: DtcCodeInfo[] = await resp.json();
        if (Array.isArray(list) && list.length > 0) {
          for (const item of list) {
            this.inMemoryDtc.set(item.code.toUpperCase(), item);
          }
          try {
            localStorage.setItem(STORAGE_KEY_DTC, JSON.stringify(list));
          } catch (_) {}
          return true;
        }
      }
    } catch (e) {
      console.warn("Ошибка восстановления из Cache API:", e);
    }
    return false;
  }

  /**
   * Быстрый интеллектуальный поиск по словарю кодов (в памяти / из кэша)
   * Поддерживает поиск по коду (P0300), названию, описанию, симптомам и причинам неисправности.
   */
  public searchDtc(query: string, systemFilter?: string): DtcCodeInfo[] {
    const q = query.trim().toUpperCase();
    const results: DtcCodeInfo[] = [];

    // Если словарь в памяти пуст, пробуем загрузить из localStorage
    if (this.inMemoryDtc.size === 0) {
      this.loadDtcFromLocalStorage();
    }

    for (const [code, info] of this.inMemoryDtc.entries()) {
      if (systemFilter && systemFilter !== "ALL") {
        const sf = systemFilter.toUpperCase();
        const infSys = (info.system || "").toUpperCase();
        const matchSys = infSys === sf ||
          (sf === "P" && (infSys.startsWith("P") || infSys.includes("POWER"))) ||
          (sf === "C" && (infSys.startsWith("C") || infSys.includes("CHASSIS"))) ||
          (sf === "B" && (infSys.startsWith("B") || infSys.includes("BODY"))) ||
          (sf === "U" && (infSys.startsWith("U") || infSys.includes("NET")));
        if (!matchSys) {
          continue;
        }
      }

      if (!q) {
        results.push(info);
      } else {
        const hasSymptom = info.symptoms?.some(s => s.toUpperCase().includes(q));
        const hasCause = info.causes?.some(c => c.toUpperCase().includes(q));
        if (
          code.includes(q) ||
          info.title.toUpperCase().includes(q) ||
          info.description.toUpperCase().includes(q) ||
          hasSymptom ||
          hasCause
        ) {
          results.push(info);
        }
      }

      if (results.length >= 80) break; // Ограничение для плавности UI
    }

    // Если ничего не найдено, но запрос похож на код ошибки (например P0300), синтезируем базовую подсказку
    if (results.length === 0 && q.match(/^[PCBU][0-9]{4}$/i)) {
      results.push(this.synthesizeDtcInfo(q));
    }

    return results;
  }

  public getDtc(code: string): DtcCodeInfo | undefined {
    const clean = code.trim().toUpperCase();
    if (this.inMemoryDtc.has(clean)) {
      return this.inMemoryDtc.get(clean);
    }
    return this.synthesizeDtcInfo(clean);
  }

  /**
   * Кэширование списка сессий
   */
  public cacheSessions(sessions: DiagnosticSessionItem[]): void {
    try {
      localStorage.setItem(STORAGE_KEY_SESSIONS, JSON.stringify(sessions));
    } catch (_) {}
  }

  public getCachedSessions(): DiagnosticSessionItem[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_SESSIONS);
      return raw ? JSON.parse(raw) : [];
    } catch (_) {
      return [];
    }
  }

  /**
   * Очередь отложенных запросов (Offline Request Queue)
   */
  public enqueueOfflineRequest(action: string, payload: any): void {
    try {
      const queue = this.getOfflineQueue();
      queue.push({
        id: "req-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
        action,
        payload,
        timestamp: new Date().toISOString()
      });
      localStorage.setItem(STORAGE_KEY_QUEUE, JSON.stringify(queue));
    } catch (e) {
      console.warn("Ошибка добавления в офлайн-очередь:", e);
    }
  }

  public getOfflineQueue(): OfflineQueueItem[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_QUEUE);
      return raw ? JSON.parse(raw) : [];
    } catch (_) {
      return [];
    }
  }

  public clearOfflineQueue(): void {
    try {
      localStorage.removeItem(STORAGE_KEY_QUEUE);
    } catch (_) {}
  }

  /**
   * Статистика кэша
   */
  public getStats(): CacheStats {
    let lastTime = "Не синхронизировано";
    try {
      const t = localStorage.getItem(STORAGE_KEY_DTC + "_time");
      if (t) lastTime = new Date(t).toLocaleString("ru-RU");
    } catch (_) {}

    return {
      dtcCount: this.inMemoryDtc.size,
      sessionsCount: this.getCachedSessions().length,
      queueCount: this.getOfflineQueue().length,
      lastDtcSync: lastTime,
      cacheApiSupported: this.isCacheApiSupported()
    };
  }

  /**
   * Полная очистка локального кэша
   */
  public async clearCache(): Promise<void> {
    this.inMemoryDtc.clear();
    localStorage.removeItem(STORAGE_KEY_DTC);
    localStorage.removeItem(STORAGE_KEY_DTC + "_time");
    localStorage.removeItem(STORAGE_KEY_SESSIONS);
    localStorage.removeItem(STORAGE_KEY_QUEUE);

    if (this.isCacheApiSupported()) {
      try {
        await caches.delete(CACHE_NAME);
      } catch (_) {}
    }
  }

  public saveSetting(key: string, value: any): void {
    try {
      const settings = this.getSettings();
      settings[key] = value;
      localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(settings));
    } catch (_) {}
  }

  public getSetting<T>(key: string, defaultValue: T): T {
    const settings = this.getSettings();
    return settings[key] !== undefined ? settings[key] : defaultValue;
  }

  public getSettings(): Record<string, any> {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_SETTINGS);
      return raw ? JSON.parse(raw) : {};
    } catch (_) {
      return {};
    }
  }

  private loadDtcFromLocalStorage(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_DTC);
      if (raw) {
        const list: DtcCodeInfo[] = JSON.parse(raw);
        for (const item of list) {
          this.inMemoryDtc.set(item.code.toUpperCase(), item);
        }
      }
    } catch (_) {}

    // Добавляем встроенные эталонные коды, если кэш пуст
    if (this.inMemoryDtc.size === 0) {
      this.populateFallbackDtc();
    }
  }

  private populateFallbackDtc(): void {
    const fallback: DtcCodeInfo[] = [
      {
        code: "P0300",
        title: "Случайные / множественные пропуски зажигания",
        description: "ЭБУ зафиксировал пропуски воспламенения смеси в нескольких цилиндрах двигателя.",
        system: "P",
        severity: "critical",
        symptoms: ["Троение двигателя", "Потеря тяги", "Мигающий Check Engine", "Повышенный расход"],
        causes: ["Свечи зажигания", "Катушки зажигания (модуль)", "Форсунки", "Подсос воздуха во впускной коллектор"]
      },
      {
        code: "P0171",
        title: "Слишком бедная смесь (Банк 1)",
        description: "Датчик кислорода фиксирует избыток кислорода в выхлопных газах первого банка цилиндров.",
        system: "P",
        severity: "warning",
        symptoms: ["Провалы при разгоне", "Неровный холостой ход", "Черный нагар или детонация"],
        causes: ["Подсос воздуха за ДМРВ", "Загрязнение ДМРВ/MAP", "Низкое давление топлива (насос/фильтр)"]
      },
      {
        code: "P0420",
        title: "Эффективность катализатора ниже порога (Банк 1)",
        description: "Каталитический нейтрализатор не справляется с дожигом выхлопных газов.",
        system: "P",
        severity: "warning",
        symptoms: ["Горит лампа Check Engine", "Возможен запах сероводорода", "Снижение динамики"],
        causes: ["Естественный износ катализатора", "Неисправность второго лямбда-зонда", "Пропуски зажигания"]
      },
      {
        code: "P0115",
        title: "Неисправность датчика температуры ОЖ (ДТОЖ)",
        description: "Сигнал датчика температуры охлаждающей жидкости выходит за допустимые пределы.",
        system: "P",
        severity: "warning",
        symptoms: ["Постоянно включенный вентилятор", "Затрудненный пуск на холодную", "Ошибочные показания на приборке"],
        causes: ["Обрыв проводки ДТОЖ", "Окисление контактов разъема", "Выход из строя терморезистора датчика"]
      },
      {
        code: "C0050",
        title: "Датчик скорости правого заднего колеса (ABS/ESP)",
        description: "Система ABS не получает корректный частотный сигнал от ступичного датчика.",
        system: "C",
        severity: "warning",
        symptoms: ["Горят лампы ABS и ESP", "Не работает система стабилизации", "Отказ круиз-контроля"],
        causes: ["Обрыв провода в арке колеса", "Загрязнение магнитной полосы ступицы", "Люфт ступичного подшипника"]
      },
      {
        code: "U0100",
        title: "Потеря связи с блоком управления двигателем (ECM/PCM)",
        description: "Блоки салона или ABS потеряли связь с ЭБУ по шине CAN (Timeout).",
        system: "U",
        severity: "critical",
        symptoms: ["Двигатель не заводится", "Гирлянда ошибок на панели приборов", "Отказ электроусилителя"],
        causes: ["Замыкание или обрыв шины CAN High/Low", "Окисление главного реле ЭБУ", "Просадка массы двигателя"]
      }
    ];

    for (const item of fallback) {
      this.inMemoryDtc.set(item.code, item);
    }
  }

  private synthesizeDtcInfo(code: string): DtcCodeInfo {
    const c = code.toUpperCase();
    const p = c[0];
    let sysName: "P" | "C" | "B" | "U" | "other" = "other";
    let sysDesc = "Электронная система";
    if (p === "P") { sysName = "P"; sysDesc = "Двигатель / Трансмиссия (Powertrain)"; }
    else if (p === "C") { sysName = "C"; sysDesc = "Шасси / Тормозная система ABS/ESP (Chassis)"; }
    else if (p === "B") { sysName = "B"; sysDesc = "Кузовная электроника / Климат (Body)"; }
    else if (p === "U") { sysName = "U"; sysDesc = "Сетевые шины CAN / FlexRay (Network)"; }

    return {
      code: c,
      title: `Стандартный код ошибки ${c} (${sysDesc})`,
      description: `Код неисправности стандарта OBD-II / SAE J2012 для подсистемы ${sysDesc}.`,
      system: sysName,
      severity: p === "P" || p === "U" ? "warning" : "info",
      symptoms: ["Запись ошибки в память ЭБУ", "Возможна индикация Check Engine"],
      causes: ["Сбой датчика", "Нарушение проводки", "Отклонение рабочего параметра от нормы"]
    };
  }
}

export const cacheManager = new ResourceCacheManager();
