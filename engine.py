# SPDX-License-Identifier: GPL-3.0-or-later
import gzip
import hashlib
import json
import math
import os
import re
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from rank_bm25 import BM25Okapi

from vulkan_backend import BASE_DIR, get_torch_device, init_vulkan_environment


STOP_WORDS_RU = {
    "и", "в", "во", "на", "по", "с", "со", "к", "ко", "от", "до", "из", "за", "при",
    "не", "ни", "а", "но", "или", "что", "как", "это", "все", "всё", "так", "же",
    "бы", "ли", "у", "о", "об", "про", "для", "без", "над", "под", "через", "после",
    "привет", "здравствуйте", "добрый", "день", "вечер", "утро", "подскажи", "помоги",
    "пожалуйста", "машина", "автомобиль", "авто", "делать", "такое", "очень", "сильно",
}

# Английские служебные и общие слова (без диагностических терминов: sensor, circuit,
# high, low, open, short, lean, rich, misfire, pressure, voltage, bank, cylinder,
# clutch, brake, abs, can, sym — они намеренно сохранены для точного поиска!)
STOP_WORDS_EN = {
    "the", "and", "for", "with", "from", "that", "this", "are", "was", "were",
    "have", "has", "had", "been", "into", "over", "after", "before", "under",
    "between", "when", "where", "which", "while", "about", "your", "their", "there",
    "could", "would", "should", "will", "may", "might",
    "car", "vehicle", "auto", "automotive", "fault", "code", "codes",
    "error", "malfunction", "trouble", "problem", "issue",
}

STOP_WORDS = STOP_WORDS_RU | STOP_WORDS_EN

GREETING_PATTERNS = re.compile(
    r"^\s*(привет|здравствуй|здравствуйте|добрый\s+(день|вечер|утро)|хай|hello|hi|"
    r"как\s+дела|кто\s+ты|что\s+ты\s+умеешь|спасибо(\s+большое)?|благодарю|"
    r"понял|понятно|ясно|хорошо|ладно|ок|окей|да|нет|пока|тест)\s*[!?.]*\s*$",
    re.IGNORECASE,
)

DTC_REGEX = re.compile(r"\b([PCBU][0-9A-Fa-f]{4})\b")
_WORD_RE = re.compile(r"[a-zа-яё0-9]+")
_CYR_WORD_RE = re.compile(r"^[а-яё]+$")

SYSTEM_NAMES_RU = {
    "engine": "Двигатель",
    "transmission": "Трансмиссия",
    "brakes": "Тормозная система",
    "electrical": "Электрооборудование",
    "cooling": "Система охлаждения",
    "hybrid": "Гибридная установка",
    "battery": "Тяговая батарея (ВВБ / BMS)",
    "chassis": "Ходовая часть",
    "suspension": "Подвеска",
}
SYSTEM_DISPLAY_NAMES = SYSTEM_NAMES_RU

SYSTEM_DESCRIPTIONS = {
    "engine": "Двигатель, топливная система, зажигание, фазы ГРМ и впуск/выпуск",
    "transmission": "Трансмиссия, АКПП/МКПП/CVT/DSG, гидроблок, сцепление и приводы",
    "brakes": "Тормозная система, гидравлика, вакуумный усилитель, ABS/ESP",
    "electrical": "Электрооборудование, бортовая сеть, АКБ, генератор, шина CAN",
    "cooling": "Система охлаждения, термостат, радиатор, помпа, вентиляторы",
    "hybrid": "Гибридная силовая установка, высоковольтная батарея (ВВБ), инвертор",
    "battery": "Тяговая высоковольтная батарея, система управления BMS, зарядный порт и охлаждение",
    "chassis": "Подвеска, рулевое управление, ЭУР/ГУР, ступичные узлы и датчики шасси",
    "suspension": "Пневмоподвеска, пневмостойки, компрессор, амортизаторы и датчики клиренса",
}

SYSTEM_ALIAS_MAP = {
    "emissions": "engine",
    "exhaust": "engine",
    "diesel": "engine",
    "fuel": "engine",
    "ignition": "engine",
    "intake": "engine",
    "turbo": "engine",
    "thermal": "cooling",
    "radiator": "cooling",
    "thermostat": "cooling",
    "4wd": "transmission",
    "awd": "transmission",
    "drivetrain": "transmission",
    "gearbox": "transmission",
    "clutch": "transmission",
    "tcm": "transmission",
    "air-brakes": "brakes",
    "hydraulics": "brakes",
    "brake": "brakes",
    "abs": "brakes",
    "esp": "brakes",
    "electric-motor": "hybrid",
    "hybrid-control": "hybrid",
    "inverter": "hybrid",
    "ev": "hybrid",
    "charging": "battery",
    "bms": "battery",
    "hv-battery": "battery",
    "hv_battery": "battery",
    "network": "electrical",
    "body": "electrical",
    "communication": "electrical",
    "can": "electrical",
    "lin": "electrical",
    "bcm": "electrical",
    "ipc": "electrical",
    "srs": "electrical",
    "airbag": "electrical",
    "hvac": "electrical",
    "ac": "electrical",
    "lighting": "electrical",
    "steering": "chassis",
    "eps": "chassis",
    "wheel": "chassis",
    "axle": "chassis",
    "air-suspension": "suspension",
    "damping": "suspension",
    "shocks": "suspension",
    "struts": "suspension",
}

CODE_DEFAULT_SYMPTOMS = {
    "P0010": "Неисправность цепи клапана фазорегулятора OCV (VVT) впуск, потеря тяги на низах, плавающий холостой ход",
    "P0012": "Потеря тяги, дизельный стук муфты фазовращателя VVT, ошибка сдвига фаз распредвала в позднюю сторону, трудный запуск",
    "P0105": "Нестабильный холостой ход, провалы при нажатии на газ, ошибка датчика абсолютного давления MAP, повышенный расход топлива",
    "P0171": "Бедная топливно-воздушная смесь, плавают обороты холостого хода, подсос воздуха во впуске, потеря мощности, медленный разгон",
    "P0172": "Богатая топливно-воздушная смесь, черный дым из выхлопа, запах бензина, перерасход топлива, нагар на свечах",
    "P0217": "Перегрев двигателя, стрелка температуры в красной зоне, кипит антифриз, вентилятор работает на максимуме",
    "P0300": "Двигатель троит и трясется на холостом ходу, потеря мощности, медленный разгон, множественные пропуски зажигания",
    "P0420": "Низкая эффективность катализатора, горит Check Engine, вялый разгон при оплавлении сот",
    "P0522": "Низкое напряжение цепи датчика давления масла или падение давления масла, мигает красная лампа давления",
    "P0562": "Тусклый свет фар, просадка напряжения бортовой сети ниже 12В, тугой запуск стартера, разряд аккумулятора",
    "P0606": "Внутренняя ошибка процессора ЭБУ ECM/PCM, двигатель не запускается или уходит в аварийный режим",
    "P0700": "Запрос контрольной лампы MIL от блока управления трансмиссией TCM, ошибка в коробке передач",
    "P0715": "Ошибка датчика оборотов входного вала АКПП ISS, жесткие переключения и толчки",
    "P0720": "Неисправность датчика частоты вращения выходного вала КПП OSS, сбой спидометра и переключений",
    "P0730": "Некорректное передаточное число трансмиссии, пробуксовка АКПП при разгоне, запах горелого ATF",
    "P0741": "Муфта блокировки гидротрансформатора ГДТ заклинила выключенной, вибрации на скорости 60-90 км/ч",
    "P0796": "Пинки и рывки при переключении передач АКПП, пробуксовка фрикционов, вибрации руля и стук при езде по кочкам, ошибка соленоида давления C",
    "P1744": "Пробуксовка гидротрансформатора АКПП, вибрации руля и кузова под нагрузкой, стук при езде по кочкам и неровностям",
    "C0035": "Горит ABS/ESP, ошибка датчика скорости левого переднего колеса",
    "C0040": "Горит ABS/ESP, ошибка датчика скорости правого переднего колеса",
    "C0050": "Горит лампа ABS и ESP на панели, не работает антиблокировочная система, мягкая педаль тормоза, сбой датчика скорости колеса",
    "C0060": "Пульсация педали тормоза, биение дисков, ошибка левого переднего клапана сброса ABS",
    "C0070": "Ошибка правого переднего клапана нагнетания ABS, увод при торможении",
    "C0080": "Сбой правого заднего клапана сброса ABS, подклинивание заднего тормозного контура",
    "U0100": "Потеря связи с блоком управления двигателем ECM/PCM по шине CAN, автомобиль не заводится",
    "U0121": "Потеря связи с модулем ABS/ESP по шине CAN, горят лампы ABS и ESP",
    "U0140": "Потеря связи с блоком кузова BCM по шине CAN, отказ света или центрального замка",
    "U0155": "Потеря связи с комбинацией приборов IPC, падают стрелки, сбой иммобилайзера",
    "U0300": "Несовместимость или сбой ПО внутренних модулей управления на шине CAN",
    "U0401": "Недостоверные данные от ЭБУ двигателя ECM/PCM по шине CAN",
    "U1900": "Потеря связи между блоками управления по шине CAN, не работает CAN шина, хаотичные ошибки на приборной панели",
    "B1000": "Внутренний сбой или просадка питания блока управления кузовом BCM",
    "B1200": "Ошибка кнопок или модуля управления климат-контролем",
    "B1300": "Сбой цепи реле аксессуаров или питания центрального замка BCM",
    "B1400": "Неисправность цепи электростеклоподъемников или дверного модуля",
    "B1500": "Ошибка цепи управления наружным освещением или диммером",
    "B1600": "Сбой считывания транспондера иммобилайзера PATS, блокировка запуска двигателя",
    "P0A80": "Потеря мощности гибридной установки, ошибка высоковольтной батареи ВВБ, деградация ячеек тягового аккумулятора",
    "P0A1F": "Внутренняя ошибка контроллера управления батареей BMS/BECM, запрет включения Ready",
    "P0AC0": "Ошибка датчика тока высоковольтной батареи ВВБ",
    "P0BFA": "Сбой контроля или балансировки ячейки тяговой батареи ВВБ",
    "P0C2A": "Отказ вспомогательного электрического насоса охлаждения инвертора или АКПП",
    "P0D1F": "Ошибка цепи контроля зарядного порта электромобиля EV/PHEV",
}


def infer_system_from_code(code: str) -> str:
    code = (code or "").upper().strip()
    if code == "P0A80" or code.startswith("P0C"):
        return "hybrid"
    if code in ("P0A1F", "P0AC0") or code.startswith("P0B") or code.startswith("P0D"):
        return "battery"
    if code.startswith("P0A"):
        return "hybrid"
    if code.startswith("P07") or code.startswith("P08") or code == "P1744":
        return "transmission"
    if code == "P0217" or code.startswith("P0115") or code.startswith("P0128"):
        return "cooling"
    if code.startswith("P056") or code.startswith("U") or code.startswith("B"):
        return "electrical"
    if code.startswith("C17") or code.startswith("C18") or code.startswith("C19"):
        return "suspension"
    if code.startswith("C04") or code.startswith("C05"):
        return "chassis"
    if code.startswith("C"):
        return "brakes"
    return "engine"


def coerce_system_key(raw_system: Any, code: str = "") -> str:
    """Строго приводит имя подсистемы к одному из 9 канонических ключей SYSTEM_NAMES_RU."""
    sys_str = str(raw_system or "").strip().lower()
    if sys_str in SYSTEM_NAMES_RU:
        return sys_str
    if sys_str in SYSTEM_ALIAS_MAP:
        return SYSTEM_ALIAS_MAP[sys_str]
    if sys_str == "powertrain" and code:
        return infer_system_from_code(code)
    inferred = infer_system_from_code(code)
    return inferred if inferred in SYSTEM_NAMES_RU else "engine"


def _coerce_str_list(val: Any) -> List[str]:
    if not val:
        return []
    if isinstance(val, str):
        parts = [p.strip() for p in re.split(r"[;\n]+", val) if p.strip()]
        return parts
    if isinstance(val, (list, tuple)):
        out: List[str] = []
        for item in val:
            if isinstance(item, str) and item.strip():
                out.append(item.strip())
            elif isinstance(item, dict):
                label = str(item.get("name") or item.get("title") or item.get("instruction") or item.get("description") or "").strip()
                if label:
                    out.append(label)
        return out
    return []


def normalize_kb_entry(item: Dict[str, Any], index: int = 0) -> Dict[str, Any]:
    """
    Приводит элемент kb_data.json (как в формате {'text': ..., 'meta': {...}} из коммита 4c196ae3,
    так и в плоском формате {'code': ..., 'system': ..., 'symptoms': ...}) к единому словарю.
    """
    meta = item.get("meta") if isinstance(item.get("meta"), dict) else {}
    text = (item.get("text") or "").strip()

    code = (item.get("code") or meta.get("code") or "").strip().upper()
    if not code and text:
        m_code = re.search(r"Код:\s*([PCBU][0-9A-Fa-f]{4})", text)
        if m_code:
            code = m_code.group(1).upper()

    raw_system = (item.get("system") or meta.get("system") or meta.get("engine") or "").strip().lower()
    system = coerce_system_key(raw_system, code) if (raw_system or code) else "engine"

    symptoms = (item.get("symptoms") or meta.get("symptoms") or "").strip()
    fix = (item.get("fix") or meta.get("fix") or "").strip()
    cause = (item.get("cause") or meta.get("cause") or "").strip()

    if text and (not symptoms or not fix):
        m_sym = re.search(r"Симптомы?:\s*([^.]+(?:\.[^.]+)*?)(?:\.\s*Решение:|$)", text, re.IGNORECASE)
        if m_sym and not symptoms:
            symptoms = m_sym.group(1).strip().rstrip(".")
        m_fix = re.search(r"Решение:\s*(.+)$", text, re.IGNORECASE)
        if m_fix and not fix:
            fix = m_fix.group(1).strip()

    if not symptoms and code in CODE_DEFAULT_SYMPTOMS:
        symptoms = CODE_DEFAULT_SYMPTOMS[code]

    if not cause:
        cause = f"Неисправность узла подсистемы {system} по коду {code}: {symptoms or text}"

    severity = item.get("severity") or meta.get("severity") or "warning"
    health_index = int(item.get("health_index") or meta.get("health_index") or 65)
    tier = int(item.get("tier") or meta.get("tier") or 1)
    lang = str(item.get("lang") or meta.get("lang") or "ru").strip().lower() or "ru"
    license_id = str(item.get("license") or meta.get("license") or "GPL-3.0").strip()

    doc_text = text or (
        f"Система: {SYSTEM_NAMES_RU.get(system, system)}. Код: {code}. Симптомы: {symptoms}. Причина: {cause}. Решение: {fix}"
    )
    if not text and code in CODE_DEFAULT_SYMPTOMS and CODE_DEFAULT_SYMPTOMS[code] not in doc_text:
        doc_text = f"{doc_text} ({CODE_DEFAULT_SYMPTOMS[code]})"

    sys_ru = SYSTEM_NAMES_RU.get(system, system.capitalize())
    return {
        "id": item.get("id") or meta.get("id") or f"KB-{code or index}-{index:03d}",
        "code": code,
        "system": system,
        "system_ru": sys_ru,
        "symptoms": symptoms,
        "cause": cause,
        "fix": fix,
        "severity": severity,
        "health_index": health_index,
        "tier": tier,
        "lang": lang,
        "license": license_id,
        "text": doc_text,
        "source": item.get("source", "kb_data.json"),
    }


def tokenize_multilingual(text: str) -> List[str]:
    """
    Двуязычная токенизация (RU + EN) с лёгким стеммингом и сохранением технических кодов:
    - Кириллица >= 6 символов: токен + префикс из 5 символов (совместимость с коммитом 4c196ae3).
    - Английские слова >= 5 символов: токен + лёгкая основа (-ies->-y, -ing, -ed, -s).
    - Буквенно-цифровые и короткие технические коды (p0300, c0050, sym, can, abs, 12v, gdi): как есть.
    """
    words = _WORD_RE.findall((text or "").lower())
    tokens: List[str] = []
    for w in words:
        if len(w) <= 1 or w in STOP_WORDS:
            continue
        tokens.append(w)
        if w.isascii():
            if w.isalpha() and len(w) >= 5:
                stem = w
                if w.endswith("ies") and len(w) - 3 >= 2:
                    stem = w[:-3] + "y"
                elif w.endswith("ing") and len(w) - 3 >= 4:
                    stem = w[:-3]
                elif w.endswith("ed") and len(w) - 2 >= 4:
                    stem = w[:-2]
                elif w.endswith("s") and not w.endswith("ss") and len(w) - 1 >= 4:
                    stem = w[:-1]
                if stem != w and stem not in STOP_WORDS:
                    tokens.append(stem)
        elif len(w) >= 6 and _CYR_WORD_RE.match(w):
            tokens.append(w[:5])
    return tokens


# Обратная совместимость со всеми существующими импортами
tokenize_ru = tokenize_multilingual


def char_ngrams(text: str, n: int = 3) -> Counter:
    cleaned = re.sub(r"\s+", " ", (text or "").lower().strip())
    if len(cleaned) < n:
        return Counter([cleaned]) if cleaned else Counter()
    return Counter(cleaned[i : i + n] for i in range(len(cleaned) - n + 1))


def cosine_counter_similarity(a: Counter, b: Counter) -> float:
    if not a or not b:
        return 0.0
    common = set(a.keys()) & set(b.keys())
    num = sum(a[k] * b[k] for k in common)
    if num == 0:
        return 0.0
    den_a = math.sqrt(sum(v * v for v in a.values()))
    den_b = math.sqrt(sum(v * v for v in b.values()))
    if den_a == 0 or den_b == 0:
        return 0.0
    return num / (den_a * den_b)


class _LazyDocNgrams(list):
    """
    Ленивый список символьных триграмм документов с прозрачным кэшированием по индексу:
    исключает O(N) накладные расходы при старте на корпусах 12 000+ записей и
    вычисляет триграммы только для реальных кандидатов запроса.
    """

    def __init__(self, raw_data: List[Dict[str, Any]]):
        super().__init__([None] * len(raw_data))
        self._raw_data = raw_data

    def __getitem__(self, index):
        if isinstance(index, slice):
            indices = range(*index.indices(len(self)))
            return [self[i] for i in indices]
        val = super().__getitem__(index)
        if val is None:
            item = self._raw_data[index]
            val = char_ngrams(
                f"{item.get('symptoms', '')} {item.get('cause', '')} {item.get('code', '')} {item.get('text', '')}"
            )
            super().__setitem__(index, val)
        return val


def load_telemetry_sample_entries(
    sample_path: Optional[Path] = None,
    max_per_code: int = 8,
) -> Tuple[List[Dict[str, Any]], Dict[str, Dict[str, Any]]]:
    """
    Парсит файл VehicleDiagnosticSample.txt (формат коммита 4c196ae3d4751845fefce7e8f1cde6f77bdb37ed)
    и агрегирует телеметрию по кодам DTC для пополнения базы знаний и словаря кодов ошибок.
    """
    if sample_path is None:
        sample_path = BASE_DIR / "VehicleDiagnosticSample.txt"
    if not sample_path.exists():
        return [], {}

    records_by_code: Dict[str, List[Dict[str, Any]]] = {}

    try:
        content = sample_path.read_text(encoding="utf-8", errors="ignore")
        blocks = content.split("Input: Generate comprehensive vehicle diagnostic")
        for block in blocks[1:]:
            id_m = re.search(r"Diagnostic ID=([^\n\r]+)", block)
            sys_m = re.search(r"System:\s*([^\n\r]+)", block)
            code_m = re.search(r"Fault Code:\s*([^\n\r]+)", block)
            status_m = re.search(r"Status:\s*([^\n\r]+)", block)
            health_m = re.search(r"health_index=([\d.]+)", block)
            temp_m = re.search(r"temperature=([\d.]+)", block)
            vib_m = re.search(r"vibration=([\d.]+)", block)
            shift_m = re.search(r"shift-time=([\d.]+)", block)
            press_m = re.search(r"pressure=([\d.]+)", block)
            volt_m = re.search(r"voltage=([\d.]+)", block)

            raw_code = code_m.group(1).strip().upper() if code_m else "NONE"
            if not raw_code or raw_code == "NONE":
                continue

            raw_sys = sys_m.group(1).strip().lower() if sys_m else ""
            sys_name = coerce_system_key(raw_sys, raw_code)
            health_val = float(health_m.group(1)) if health_m else 68.0
            temp_val = float(temp_m.group(1)) if temp_m else 85.0
            vib_val = float(vib_m.group(1)) if vib_m else 0.0
            shift_val = float(shift_m.group(1)) if shift_m else 0.0
            press_val = float(press_m.group(1)) if press_m else 0.0
            volt_val = float(volt_m.group(1)) if volt_m else 13.6
            status_str = status_m.group(1).strip() if status_m else "warning"

            # Извлекаем симптомы по пороговым значениям датчиков (точно по логике коммита 4c196ae3)
            sensor_symptoms: List[str] = []
            if vib_val > 5.0:
                sensor_symptoms.append("сильная вибрация, тряска кузова, биение руля и стук при езде по кочкам")
            if shift_val > 0.35:
                sensor_symptoms.append("задержка переключения передач, пинки и рывки коробки")
            if press_m and press_val < 50.0:
                sensor_symptoms.append("низкое давление в тормозной системе, мягкая педаль тормоза")
            if volt_m and volt_val < 12.0:
                sensor_symptoms.append("низкое напряжение бортовой сети, разряд аккумулятора")

            records_by_code.setdefault(raw_code, []).append(
                {
                    "id": id_m.group(1).strip() if id_m else f"SAMPLE-{raw_code}",
                    "system": sys_name,
                    "code": raw_code,
                    "status": status_str,
                    "health_index": health_val,
                    "temperature": temp_val,
                    "vibration": vib_val,
                    "shift_time": shift_val,
                    "pressure": press_val,
                    "voltage": volt_val,
                    "sensor_symptoms": sensor_symptoms,
                }
            )
    except Exception:
        return [], {}

    synthetic_entries: List[Dict[str, Any]] = []
    telemetry_summary: Dict[str, Dict[str, Any]] = {}

    for code, items in records_by_code.items():
        count = len(items)
        avg_temp = round(sum(x["temperature"] for x in items) / count, 1)
        avg_volt = round(sum(x["voltage"] for x in items) / count, 2)
        avg_health = int(round(sum(x["health_index"] for x in items) / count))
        sys_name = items[0]["system"]

        sys_ru = SYSTEM_NAMES_RU.get(sys_name, sys_name.capitalize())
        telemetry_summary[code] = {
            "code": code,
            "system": sys_name,
            "system_ru": sys_ru,
            "occurrences_in_sample": count,
            "avg_engine_temp_c": avg_temp,
            "avg_rpm": 2200,
            "avg_fuel_efficiency_mpg": 21.5,
            "avg_battery_voltage_v": avg_volt,
            "avg_health_index": avg_health,
            "typical_severity": "High" if avg_health < 55 else "Medium",
            "default_symptoms": CODE_DEFAULT_SYMPTOMS.get(code, f"Признаки неисправности по коду {code}"),
            "sample_measurements": {
                "Температура узла": f"{avg_temp} °C",
                "Напряжение бортсети": f"{avg_volt} В",
                "Записей в базе": count,
            },
        }

        for idx, item in enumerate(items[:max_per_code]):
            h_val = int(round(item["health_index"]))
            sev_mapped = "critical" if "critical" in item["status"].lower() or h_val < 50 else "warning"
            extra_sym = ", ".join(item["sensor_symptoms"])
            base_sym = CODE_DEFAULT_SYMPTOMS.get(code, f"Код неисправности {code}")
            full_sym = f"{base_sym}. {extra_sym}".strip(". ")

            doc_text = (
                f"Система: {sys_name}. Код ошибки: {code}. "
                f"Симптомы: {full_sym}. "
                f"Статус узла: {item['status']}."
            )
            synthetic_entries.append(
                {
                    "id": item["id"],
                    "system": sys_name,
                    "system_ru": sys_ru,
                    "symptoms": full_sym,
                    "code": code,
                    "cause": (
                        f"Зафиксирован код {code} в выборке телеметрии ({count} случаев). "
                        f"Индекс ресурса узла {h_val}%, температура {item['temperature']}°C."
                    ),
                    "severity": sev_mapped,
                    "health_index": h_val,
                    "fix": (
                        f"Проверить контур системы {sys_name} по коду {code}, считать стоп-кадр (Freeze Frame) "
                        f"и проверить датчик/исполнительный узел."
                    ),
                    "tier": 1,
                    "lang": "ru",
                    "license": "GPL-3.0",
                    "text": doc_text,
                    "source": "VehicleDiagnosticSample.txt",
                }
            )

    return synthetic_entries, telemetry_summary


def _safe_nonneg_int(val: Any) -> int:
    if val is None:
        return 0
    if isinstance(val, (list, tuple, set)):
        return len(val)
    try:
        return max(0, int(float(val)))
    except (ValueError, TypeError):
        return 0


def load_external_kb_entries(external_kb_path: Optional[Path] = None) -> List[Dict[str, Any]]:
    """
    Загружает внешнюю открытую базу знаний (Tier 2/3: OBD-II, OEM, NHTSA, регламенты)
    из data/kb_external.jsonl.gz (с откатом на .jsonl). При отсутствии файла тихо возвращает [].
    """
    target_path: Optional[Path] = None
    if external_kb_path is not None:
        candidate = Path(external_kb_path)
        if candidate.exists():
            target_path = candidate
        elif candidate.suffix == ".gz" and candidate.with_suffix("").exists():
            target_path = candidate.with_suffix("")
    else:
        default_gz = BASE_DIR / "data" / "kb_external.jsonl.gz"
        default_jsonl = BASE_DIR / "data" / "kb_external.jsonl"
        if default_gz.exists():
            target_path = default_gz
        elif default_jsonl.exists():
            target_path = default_jsonl

    if target_path is None or not target_path.exists():
        return []

    entries: List[Dict[str, Any]] = []
    opener = (
        (lambda p: gzip.open(p, "rt", encoding="utf-8", errors="ignore"))
        if str(target_path).lower().endswith(".gz")
        else (lambda p: open(p, "r", encoding="utf-8", errors="ignore"))
    )

    try:
        with opener(target_path) as fh:
            for idx, line in enumerate(fh):
                raw_line = line.strip()
                if not raw_line:
                    continue
                try:
                    item = json.loads(raw_line)
                except Exception:
                    continue
                if not isinstance(item, dict):
                    continue

                meta = item.get("meta") if isinstance(item.get("meta"), dict) else {}
                code = str(item.get("code") or meta.get("code") or item.get("dtc") or "").strip().upper()
                raw_sys = item.get("system") or meta.get("system") or ""
                sys_name = coerce_system_key(raw_sys, code)
                sys_ru = SYSTEM_NAMES_RU[sys_name]

                raw_tier = item.get("tier") if item.get("tier") is not None else meta.get("tier")
                try:
                    tier = max(2, int(raw_tier)) if raw_tier is not None else 3
                except (ValueError, TypeError):
                    tier = 3

                lang = str(item.get("lang") or meta.get("lang") or "en").strip().lower() or "en"
                oem_make = str(
                    item.get("oem_make") or meta.get("oem_make") or item.get("make") or meta.get("make") or ""
                ).strip()
                en_title = str(
                    item.get("en_title")
                    or meta.get("en_title")
                    or item.get("title")
                    or meta.get("title")
                    or item.get("description")
                    or meta.get("description")
                    or ""
                ).strip()

                raw_symptoms = item.get("symptoms") if item.get("symptoms") is not None else meta.get("symptoms")
                if isinstance(raw_symptoms, (list, tuple)):
                    symptoms = "; ".join(_coerce_str_list(raw_symptoms))
                else:
                    symptoms = str(raw_symptoms or item.get("symptom") or en_title or "").strip()

                raw_cause = item.get("cause") if item.get("cause") is not None else (item.get("causes") or meta.get("cause"))
                if isinstance(raw_cause, (list, tuple)):
                    cause = "; ".join(_coerce_str_list(raw_cause))
                else:
                    cause = str(raw_cause or "").strip()

                procedures = _coerce_str_list(
                    item.get("procedures") or meta.get("procedures") or item.get("repair_steps")
                )
                parts = _coerce_str_list(item.get("parts") or meta.get("parts"))

                raw_fix = item.get("fix") if item.get("fix") is not None else (item.get("solution") or item.get("solutions") or meta.get("fix"))
                if isinstance(raw_fix, (list, tuple)):
                    fix = "; ".join(_coerce_str_list(raw_fix))
                else:
                    fix = str(raw_fix or "").strip()
                if not fix and procedures:
                    fix = "; ".join(procedures[:4])

                difficulty = str(item.get("difficulty") or meta.get("difficulty") or "").strip()
                raw_hours = (
                    item.get("est_labor_hours")
                    if item.get("est_labor_hours") is not None
                    else meta.get("est_labor_hours")
                )
                try:
                    est_labor_hours = (
                        round(float(raw_hours), 2)
                        if raw_hours is not None and str(raw_hours).strip() != ""
                        else None
                    )
                except (ValueError, TypeError):
                    est_labor_hours = None

                raw_nhtsa_stats = item.get("nhtsa_stats") if isinstance(item.get("nhtsa_stats"), dict) else {}
                nhtsa_bulletins = _safe_nonneg_int(
                    item.get("nhtsa_bulletins")
                    if item.get("nhtsa_bulletins") is not None
                    else (meta.get("nhtsa_bulletins") if meta.get("nhtsa_bulletins") is not None else raw_nhtsa_stats.get("bulletins"))
                )
                nhtsa_owner_reports = _safe_nonneg_int(
                    item.get("nhtsa_owner_reports")
                    if item.get("nhtsa_owner_reports") is not None
                    else (meta.get("nhtsa_owner_reports") if meta.get("nhtsa_owner_reports") is not None else raw_nhtsa_stats.get("owner_reports"))
                )

                source = str(item.get("source") or meta.get("source") or "kb_external").strip()
                license_id = str(item.get("license") or meta.get("license") or "Public Domain / Open Data").strip()

                raw_sev = str(item.get("severity") or meta.get("severity") or "warning").strip().lower()
                severity = "critical" if raw_sev in ("critical", "high", "severe") else ("info" if raw_sev == "info" else "warning")
                raw_hi = item.get("health_index") if item.get("health_index") is not None else meta.get("health_index")
                try:
                    health_index = int(round(float(raw_hi))) if raw_hi is not None else (56 if severity == "critical" else 70)
                except (ValueError, TypeError):
                    health_index = 56 if severity == "critical" else 70

                raw_text = str(item.get("text") or "").strip()
                if raw_text:
                    doc_text = raw_text
                    if len(doc_text) < 220:
                        extras: List[str] = []
                        if cause and cause not in doc_text:
                            extras.append(f"Cause: {cause}")
                        if fix and fix not in doc_text:
                            extras.append(f"Fix: {fix}")
                        if extras:
                            doc_text = f"{doc_text}. {'. '.join(extras)}"
                else:
                    header_parts = [f"System: {sys_name} ({sys_ru})"]
                    if code:
                        header_parts.append(f"Code: {code}")
                    if oem_make:
                        header_parts.append(f"OEM: {oem_make}")
                    if en_title and en_title != symptoms:
                        header_parts.append(f"Title: {en_title}")
                    if symptoms:
                        header_parts.append(f"Symptoms: {symptoms}")
                    if cause:
                        header_parts.append(f"Cause: {cause}")
                    if fix:
                        header_parts.append(f"Fix: {fix}")
                    doc_text = ". ".join(header_parts)

                raw_oem_variants = item.get("oem_variants") if isinstance(item.get("oem_variants"), list) else []

                entries.append(
                    {
                        "id": item.get("id") or meta.get("id") or f"EXT-{code or 'DOC'}-{idx:05d}",
                        "code": code,
                        "system": sys_name,
                        "system_ru": sys_ru,
                        "symptoms": symptoms,
                        "cause": cause,
                        "fix": fix,
                        "severity": severity,
                        "health_index": health_index,
                        "tier": tier,
                        "lang": lang,
                        "oem_make": oem_make,
                        "en_title": en_title,
                        "oem_variants": raw_oem_variants,
                        "procedures": procedures,
                        "parts": parts,
                        "difficulty": difficulty,
                        "est_labor_hours": est_labor_hours,
                        "nhtsa_bulletins": nhtsa_bulletins,
                        "nhtsa_owner_reports": nhtsa_owner_reports,
                        "source": source,
                        "license": license_id,
                        "text": doc_text,
                    }
                )
    except Exception:
        return []

    return entries


class VehicleExpertEngine:
    """
    Масштабируемое гибридное ядро RAG (BERT SentenceTransformer + FAISS + BM25 + CrossEncoder Reranker):
    - Векторный поиск через мультиязычный BERT (`SentenceTransformer`) и индекс `faiss.IndexFlatIP` (топ-30).
    - Лексический поиск BM25 (топ-30 среди `score > 0`) + O(1) индекс кодов DTC + триграммы только по кандидатам.
    - Нейросетевое переранжирование пула из 20 кандидатов через `CrossEncoder` с контекстом 480 символов.
    - Многоуровневое объединение курируемой русской БЗ (Tier 1) и внешних справочников OBD/OEM/NHTSA (Tier 2/3).
    """

    def __init__(
        self,
        kb_data: Optional[List[Dict[str, Any]]] = None,
        kb_path: Optional[Path] = None,
        sample_path: Optional[Path] = None,
        embed_model: str = os.environ.get(
            "RAG_EMBED_MODEL",
            "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
        ),
        rerank_model: str = os.environ.get(
            "RAG_RERANK_MODEL",
            "cross-encoder/mmarco-mMiniLMv2-L12-H384-v1",
        ),
        use_neural_models: Optional[bool] = None,
        external_kb_path: Optional[Path] = None,
        include_external_kb: Optional[bool] = None,
    ):
        init_vulkan_environment(verbose=False)
        if kb_data is None:
            kb_file = kb_path or (BASE_DIR / "kb_data.json")
            with open(kb_file, "r", encoding="utf-8") as f:
                kb_data = json.load(f)

        if include_external_kb is None:
            include_external_kb = os.environ.get("RAG_INCLUDE_EXTERNAL", "1").strip().lower() not in (
                "0",
                "false",
                "no",
            )
        self.include_external_kb: bool = bool(include_external_kb)

        normalized_kb = [normalize_kb_entry(item, idx) for idx, item in enumerate(kb_data)]
        sample_entries, self.telemetry_stats = load_telemetry_sample_entries(sample_path=sample_path)
        self.telemetry_catalog: Dict[str, Dict[str, Any]] = self.telemetry_stats
        self.external_kb: List[Dict[str, Any]] = (
            load_external_kb_entries(external_kb_path=external_kb_path)
            if self.include_external_kb
            else []
        )

        self.base_kb: List[Dict[str, Any]] = normalized_kb
        self.raw_data: List[Dict[str, Any]] = normalized_kb + sample_entries + self.external_kb

        self.documents: List[str] = [
            item.get("text")
            or (
                f"Система: {item.get('system', '')}. "
                f"Код: {item.get('code', '')}. "
                f"Симптомы: {item.get('symptoms', '')}. "
                f"Причина: {item.get('cause', '')}"
            )
            for item in self.raw_data
        ]

        self.doc_tokens: List[List[str]] = [tokenize_multilingual(doc) for doc in self.documents]
        self._doc_token_sets: List[set[str]] = [set(t) for t in self.doc_tokens]
        self._all_kb_vocab: set[str] = set().union(*self._doc_token_sets) if self._doc_token_sets else set()

        # O(1) индекс: код DTC -> список индексов документов (с приоритетом Tier 1 / русскоязычных записей)
        raw_code_map: Dict[str, List[int]] = {}
        for doc_idx, item in enumerate(self.raw_data):
            c = (item.get("code") or "").strip().upper()
            if c:
                raw_code_map.setdefault(c, []).append(doc_idx)
        self._code_to_doc_indices: Dict[str, List[int]] = {
            c: sorted(
                idxs,
                key=lambda i: (
                    int(self.raw_data[i].get("tier") or 1),
                    0 if self.raw_data[i].get("source") == "kb_data.json" else 1,
                    0 if (self.raw_data[i].get("lang") or "ru") == "ru" else 1,
                    i,
                ),
            )
            for c, idxs in raw_code_map.items()
        }

        self.doc_ngrams: List[Counter] = _LazyDocNgrams(self.raw_data)
        self.bm25 = BM25Okapi(self.doc_tokens) if (self.doc_tokens and any(self.doc_tokens)) else None

        self._dtc_search_blobs: Dict[str, str] = {}
        self._dtc_base_rank_key: Dict[str, Tuple[int, int, int, int, str]] = {}
        self._dtc_default_sorted_codes: List[str] = []
        self.dtc_catalog: Dict[str, Dict[str, Any]] = self._build_dtc_catalog()

        if use_neural_models is None:
            use_neural_models = os.environ.get("RAG_USE_NEURAL", "1") != "0"

        self.bi_encoder = None
        self.reranker = None
        self.faiss_index = None
        self.vector_index = None
        self.index = None
        self.embed_model_name = embed_model
        self.rerank_model_name = rerank_model

        rag_device_env = os.environ.get("RAG_DEVICE", "cpu").strip().lower()
        if rag_device_env in ("cuda", "gpu", "auto"):
            self.device = get_torch_device(prefer_gpu=True)
        else:
            self.device = rag_device_env or "cpu"

        if use_neural_models:
            try:
                import faiss
                from sentence_transformers import CrossEncoder, SentenceTransformer

                try:
                    self.bi_encoder = SentenceTransformer(embed_model, device=self.device, local_files_only=True)
                except Exception:
                    self.bi_encoder = SentenceTransformer(embed_model, device=self.device)
                try:
                    self.reranker = CrossEncoder(rerank_model, device=self.device, local_files_only=True)
                except Exception:
                    self.reranker = CrossEncoder(rerank_model, device=self.device)

                if self.documents:
                    embeddings = self._load_or_compute_embeddings(embed_model)
                    if (
                        embeddings.ndim == 2
                        and embeddings.shape[0] == len(self.documents)
                        and embeddings.shape[0] > 0
                        and embeddings.shape[1] > 0
                    ):
                        embeddings = np.ascontiguousarray(embeddings, dtype=np.float32)
                        faiss.normalize_L2(embeddings)
                        self.faiss_index = faiss.IndexFlatIP(embeddings.shape[1])
                        self.faiss_index.add(embeddings)
                        self.vector_index = self.faiss_index
                        self.index = self.faiss_index
            except Exception as exc:
                print(f"[RAG Engine] Предупреждение при инициализации BERT/FAISS ({exc}), активен гибридный BM25 резерв.")
                self.bi_encoder = None
                self.reranker = None
                self.faiss_index = None
                self.vector_index = None
                self.index = None

    @property
    def cross_encoder(self):
        return self.reranker

    @cross_encoder.setter
    def cross_encoder(self, value):
        self.reranker = value

    @staticmethod
    def load_txt_to_json(txt_path: str) -> List[Dict[str, Any]]:
        """Метод парсинга логов VehicleDiagnosticSample.txt из коммита 4c196ae3d4751845fefce7e8f1cde6f77bdb37ed."""
        entries, _ = load_telemetry_sample_entries(Path(txt_path), max_per_code=500)
        return [
            {
                "id": e["id"],
                "text": e["text"],
                "meta": {
                    "system": e["system"],
                    "code": e["code"],
                    "health": float(e["health_index"]),
                    "severity": e["severity"],
                },
            }
            for e in entries
        ]

    def _compute_embeddings_digest(self, embed_model: str) -> str:
        """Вычисляет детерминированный SHA-256 дайджест модели и полного набора документов."""
        return hashlib.sha256(
            (embed_model + "||" + "\n".join(self.documents)).encode("utf-8", errors="ignore")
        ).hexdigest()[:16]

    def _load_or_compute_embeddings(self, embed_model: str) -> np.ndarray:
        """Кэширует эмбеддинги документов БЗ на диск для мгновенного старта."""
        if not self.documents:
            return np.empty((0, 0), dtype=np.float32)

        cache_dir = BASE_DIR / "models" / "rag_cache"
        cache_dir.mkdir(parents=True, exist_ok=True)
        digest = self._compute_embeddings_digest(embed_model)
        cache_file = cache_dir / f"embeddings_{digest}.npy"

        if cache_file.exists():
            try:
                arr = np.load(str(cache_file))
                if arr.ndim == 2 and arr.shape[0] == len(self.documents):
                    return np.ascontiguousarray(arr, dtype=np.float32)
            except Exception:
                pass

        raw_emb = self.bi_encoder.encode(
            self.documents,
            show_progress_bar=False,
            convert_to_numpy=True,
        )
        embeddings = np.ascontiguousarray(raw_emb, dtype=np.float32)
        if embeddings.ndim == 1 and len(self.documents) == 1:
            embeddings = embeddings.reshape(1, -1)
        try:
            np.save(str(cache_file), embeddings)
        except Exception:
            pass
        return embeddings

    @staticmethod
    def _merge_oem_variants(existing: List[Any], ext: Dict[str, Any], limit: int = 15) -> List[Any]:
        out = list(existing)
        seen = {json.dumps(v, sort_keys=True, ensure_ascii=False) if isinstance(v, dict) else str(v).lower() for v in out}

        candidates: List[Any] = []
        oem_make = (ext.get("oem_make") or "").strip()
        if oem_make:
            desc = (ext.get("en_title") or ext.get("symptoms") or ext.get("cause") or "").strip()
            candidates.append(
                {
                    "make": oem_make,
                    "title": desc,
                    "description": desc,
                    "source": ext.get("source", ""),
                }
            )
        for v in ext.get("oem_variants") or []:
            candidates.append(v)

        for cand in candidates:
            if len(out) >= limit:
                break
            key = json.dumps(cand, sort_keys=True, ensure_ascii=False) if isinstance(cand, dict) else str(cand).lower()
            if key not in seen:
                seen.add(key)
                out.append(cand)
        return out

    @staticmethod
    def _merge_nhtsa_stats(existing: Optional[Dict[str, int]], ext: Dict[str, Any]) -> Optional[Dict[str, int]]:
        b_cnt = _safe_nonneg_int(ext.get("nhtsa_bulletins"))
        o_cnt = _safe_nonneg_int(ext.get("nhtsa_owner_reports"))
        if b_cnt <= 0 and o_cnt <= 0:
            return existing
        if existing is None:
            return {"bulletins": b_cnt, "owner_reports": o_cnt}
        return {
            "bulletins": max(existing.get("bulletins", 0), b_cnt),
            "owner_reports": max(existing.get("owner_reports", 0), o_cnt),
        }

    def _build_dtc_catalog(self) -> Dict[str, Dict[str, Any]]:
        catalog: Dict[str, Dict[str, Any]] = {}

        # 1. Индексация курируемой русской базы знаний Tier 1 (kb_data.json)
        for item in self.base_kb:
            code = (item.get("code") or "").strip().upper()
            if not code:
                continue
            sys_name = coerce_system_key(item.get("system"), code)
            sys_ru = SYSTEM_NAMES_RU.get(sys_name, sys_name.capitalize())
            symp = item.get("symptoms", "")
            fix = item.get("fix", "")
            has_tel = bool(self.telemetry_stats.get(code))
            if code not in catalog:
                catalog[code] = {
                    "code": code,
                    "system": sys_name,
                    "system_ru": sys_ru,
                    "system_description": SYSTEM_DESCRIPTIONS.get(
                        sys_name, "Автомобильная подсистема"
                    ),
                    "symptom": symp or "Отклонение параметров узла",
                    "symptoms": [s.strip() for s in symp.split(";") if s.strip()] if symp else [],
                    "symptoms_str": symp,
                    "cause": item.get("cause", ""),
                    "fix": fix,
                    "solution": fix or "Выполнить инструментальную диагностику узла",
                    "solutions": [fix] if fix else [],
                    "severity": item.get("severity", "warning"),
                    "health_index": item.get("health_index", 65),
                    "kb_cases_count": 1,
                    "has_telemetry": has_tel,
                    "telemetry": self.telemetry_stats.get(code, {}),
                    "tier": 1,
                    "lang": item.get("lang", "ru"),
                    "en_title": "",
                    "oem_variants": [],
                    "nhtsa_stats": None,
                    "procedures": [],
                    "parts": [],
                    "difficulty": "",
                    "est_labor_hours": None,
                    "external_sources": [],
                }
            else:
                catalog[code]["kb_cases_count"] += 1
                if symp and symp not in catalog[code]["symptoms_str"]:
                    if len(catalog[code]["symptoms_str"]) < 260:
                        catalog[code]["symptoms_str"] += f"; {symp}"
                        catalog[code]["symptom"] = catalog[code]["symptoms_str"]
                        if symp not in catalog[code]["symptoms"]:
                            catalog[code]["symptoms"].append(symp)
                if fix and fix not in catalog[code]["solutions"]:
                    catalog[code]["solutions"].append(fix)

        # 2. Индексация эталонной телеметрии Tier 1 (VehicleDiagnosticSample.txt)
        for code, t_stat in self.telemetry_stats.items():
            if code not in catalog:
                sys_name = coerce_system_key(t_stat["system"], code)
                sys_ru = SYSTEM_NAMES_RU.get(sys_name, sys_name.capitalize())
                fix_text = (
                    f"Проверить контур системы {sys_name} по коду {code}, считать Freeze Frame, "
                    f"выполнить проверку проводки, разъемов и исполнительного узла."
                )
                catalog[code] = {
                    "code": code,
                    "system": sys_name,
                    "system_ru": sys_ru,
                    "system_description": SYSTEM_DESCRIPTIONS.get(sys_name, "Автомобильная подсистема"),
                    "symptom": t_stat["default_symptoms"],
                    "symptoms": [t_stat["default_symptoms"]],
                    "symptoms_str": t_stat["default_symptoms"],
                    "cause": (
                        f"Типовой отказ по данным телеметрии ({t_stat['occurrences_in_sample']} записей). "
                        f"Средняя температура {t_stat['avg_engine_temp_c']}°C, сеть {t_stat['avg_battery_voltage_v']}V."
                    ),
                    "fix": fix_text,
                    "solution": fix_text,
                    "solutions": [fix_text],
                    "severity": "critical" if t_stat["typical_severity"] == "High" else "warning",
                    "health_index": t_stat["avg_health_index"],
                    "kb_cases_count": t_stat["occurrences_in_sample"],
                    "has_telemetry": True,
                    "telemetry": t_stat,
                    "tier": 1,
                    "lang": "ru",
                    "en_title": "",
                    "oem_variants": [],
                    "nhtsa_stats": None,
                    "procedures": [],
                    "parts": [],
                    "difficulty": "",
                    "est_labor_hours": None,
                    "external_sources": [],
                }

        # 3. Обогащение и пополнение словаря внешними источниками Tier 2 / Tier 3
        sorted_external = sorted(
            self.external_kb,
            key=lambda x: (int(x.get("tier") or 3), 1 if (x.get("oem_make") or "").strip() else 0),
        )
        for ext in sorted_external:
            code = (ext.get("code") or "").strip().upper()
            if not code:
                # Общие регламенты без конкретного кода остаются в self.raw_data для RAG-поиска
                continue

            ext_title = (ext.get("en_title") or "").strip()
            ext_source = (ext.get("source") or "").strip()
            ext_procs = [p for p in (ext.get("procedures") or []) if p]
            ext_parts = [p for p in (ext.get("parts") or []) if p]

            if code in catalog:
                entry = catalog[code]
                # НИКОГДА не перезаписываем русские курируемые поля Tier 1!
                if ext_title and not entry["en_title"]:
                    entry["en_title"] = ext_title
                entry["oem_variants"] = self._merge_oem_variants(entry["oem_variants"], ext, limit=15)
                entry["nhtsa_stats"] = self._merge_nhtsa_stats(entry["nhtsa_stats"], ext)

                if ext_procs:
                    merged_procs = list(dict.fromkeys(entry["procedures"] + ext_procs))
                    entry["procedures"] = merged_procs[:8]
                if ext_parts:
                    merged_parts = list(dict.fromkeys(entry["parts"] + ext_parts))
                    entry["parts"] = merged_parts[:10]
                if not entry["difficulty"] and ext.get("difficulty"):
                    entry["difficulty"] = ext["difficulty"]
                if entry["est_labor_hours"] is None and ext.get("est_labor_hours") is not None:
                    entry["est_labor_hours"] = ext["est_labor_hours"]
                entry["kb_cases_count"] += 1
                if ext_source and ext_source not in entry["external_sources"]:
                    entry["external_sources"].append(ext_source)

                # Для внешних записей (tier >= 2) можно дополнить пустые fix/solutions при слиянии
                if entry["tier"] >= 2:
                    ext_fix = (ext.get("fix") or "").strip()
                    if ext_fix and ext_fix not in entry["solutions"]:
                        entry["solutions"].append(ext_fix)
            else:
                sys_name = coerce_system_key(ext.get("system"), code)
                sys_ru = SYSTEM_NAMES_RU[sys_name]
                symp = (ext.get("symptoms") or ext_title or f"Diagnostic trouble code {code}").strip()
                symp_list = [s.strip() for s in symp.split(";") if s.strip()] if symp else [f"DTC {code}"]
                procs_capped = list(dict.fromkeys(ext_procs))[:8]
                parts_capped = list(dict.fromkeys(ext_parts))[:10]
                raw_fix = (ext.get("fix") or "").strip()
                sol_str = (
                    raw_fix
                    or ("; ".join(procs_capped[:3]) if procs_capped else f"Проверить контур системы «{sys_ru}» по коду {code} и считать Freeze Frame")
                )
                sol_list = [raw_fix] if raw_fix else (procs_capped[:4] if procs_capped else [sol_str])
                cause_str = (
                    (ext.get("cause") or "").strip()
                    or (f"{ext_title} ({sys_ru})" if ext_title else f"Неисправность узла «{sys_ru}» по коду {code}")
                )
                catalog[code] = {
                    "code": code,
                    "system": sys_name,
                    "system_ru": sys_ru,
                    "system_description": SYSTEM_DESCRIPTIONS.get(sys_name, "Автомобильная подсистема"),
                    "symptom": symp,
                    "symptoms": symp_list,
                    "symptoms_str": symp,
                    "cause": cause_str,
                    "fix": raw_fix or sol_str,
                    "solution": sol_str,
                    "solutions": sol_list,
                    "severity": ext.get("severity", "warning"),
                    "health_index": int(ext.get("health_index", 70)),
                    "kb_cases_count": 1,
                    "has_telemetry": False,
                    "telemetry": {},
                    "tier": int(ext.get("tier") or 3),
                    "lang": ext.get("lang", "en"),
                    "en_title": ext_title,
                    "oem_variants": self._merge_oem_variants([], ext, limit=15),
                    "nhtsa_stats": self._merge_nhtsa_stats(None, ext),
                    "procedures": procs_capped,
                    "parts": parts_capped,
                    "difficulty": ext.get("difficulty", ""),
                    "est_labor_hours": ext.get("est_labor_hours"),
                    "external_sources": [ext_source] if ext_source else [],
                }

        sorted_catalog = dict(sorted(catalog.items(), key=lambda kv: kv[0]))

        # Предвычисляем поисковые строки и базовые ключи ранжирования (<5 мс на 12 000+ кодов)
        blobs: Dict[str, str] = {}
        rank_keys: Dict[str, Tuple[int, int, int, int, str]] = {}
        for code, info in sorted_catalog.items():
            symp_str = info.get("symptoms_str") or (
                " ".join(info.get("symptoms", []))
                if isinstance(info.get("symptoms"), list)
                else str(info.get("symptoms", ""))
            )
            oem_parts: List[str] = []
            for ov in info.get("oem_variants") or []:
                if isinstance(ov, dict):
                    oem_parts.append(f"{ov.get('make', '')} {ov.get('description', '')} {ov.get('title', '')}")
                else:
                    oem_parts.append(str(ov))
            oem_txt = " ".join(oem_parts)
            proc_txt = " ".join(info.get("procedures") or [])
            part_txt = " ".join(info.get("parts") or [])

            blobs[code] = (
                f"{code} {info.get('system', '')} {info.get('system_ru', '')} "
                f"{symp_str} {info.get('cause', '')} {info.get('fix', '')} "
                f"{info.get('en_title', '')} {oem_txt} {proc_txt} {part_txt}"
            ).lower()

            detail_score = (
                min(len(symp_str), 200)
                + min(len(info.get("cause") or ""), 200)
                + min(len(info.get("fix") or ""), 200)
                + (40 * len(info.get("procedures") or []))
                + (25 * len(info.get("parts") or []))
                + (30 * len(info.get("oem_variants") or []))
                + (50 if info.get("nhtsa_stats") else 0)
                + (20 if info.get("en_title") else 0)
            )
            tier_val = int(info.get("tier") or 1)
            tel_rank = 0 if info.get("has_telemetry") else 1
            lang_rank = 0 if (info.get("lang") or "ru") == "ru" else 1
            rank_keys[code] = (tier_val, tel_rank, lang_rank, -detail_score, code)

        self._dtc_search_blobs = blobs
        self._dtc_base_rank_key = rank_keys
        self._dtc_default_sorted_codes = sorted(sorted_catalog.keys(), key=lambda c: rank_keys[c])
        return sorted_catalog

    def _extract_dtc_codes_from_text(self, text: str) -> List[str]:
        """Извлекает уникальные коды неисправностей OBD-II (DTC) из текста."""
        return list(dict.fromkeys(m.upper() for m in DTC_REGEX.findall(text or "")))

    def _extract_symptom_and_solution(self, text: str) -> Tuple[str, str]:
        """Извлекает описание симптома и рекомендуемое решение из форматированного текста записи KB."""
        if not text:
            return "Неизвестный симптом", "Требуется комплексная инструментальная диагностика"
        sym_match = re.search(
            r"(?:Симптомы?|Symptoms?|Title):\s*([^.]+(?:\.[^.]+)*?)(?:\.\s*(?:Причина|Решение|Cause|Fix|Solution)|$)",
            text,
            re.IGNORECASE,
        )
        sol_match = re.search(r"(?:Решение|Fix|Solution):\s*(.+)$", text, re.IGNORECASE)

        sym = sym_match.group(1).strip() if sym_match else ""
        sol = sol_match.group(1).strip() if sol_match else ""

        if not sym:
            sym = text.split(".")[0].strip() if "." in text else text.strip()
        if not sol:
            sol = "Выполнить компьютерную диагностику и проверку разъемов"
        return sym, sol

    def get_all_systems(self) -> List[Dict[str, Any]]:
        """Возвращает список всех распознаваемых автомобильных подсистем с русскими названиями и количеством кодов."""
        counts: Dict[str, int] = {}
        for info in self.dtc_catalog.values():
            s = info.get("system", "")
            counts[s] = counts.get(s, 0) + 1
        res: List[Dict[str, Any]] = []
        for sys_id, ru_name in SYSTEM_NAMES_RU.items():
            res.append({
                "id": sys_id,
                "name": ru_name,
                "display_name": ru_name,
                "count": counts.get(sys_id, 0),
                "description": SYSTEM_DESCRIPTIONS.get(sys_id, "Автомобильная подсистема"),
            })
        return res

    def is_general_or_greeting_query(self, query: str) -> bool:
        """Определяет, является ли запрос приветствием или общим вопросом за O(|q_tokens|) через _all_kb_vocab."""
        q = (query or "").strip()
        if not q:
            return True
        if GREETING_PATTERNS.match(q):
            return True
        if DTC_REGEX.search(q):
            return False

        raw_words = [
            w for w in re.findall(r"[a-zа-яё0-9]+", q.lower())
            if len(w) > 1 and w not in STOP_WORDS
        ]
        q_tokens = set(tokenize_multilingual(q))
        if not q_tokens:
            return True

        overlap = q_tokens & self._all_kb_vocab
        # Используем число исходных значимых слов, чтобы дублирование стемм не искажало порог длины
        return len(overlap) == 0 and len(raw_words) <= 4

    def search_dtc_dictionary_paginated(
        self,
        query: str = "",
        system: str = "all",
        limit: int = 80,
        offset: int = 0,
        search_term: Optional[str] = None,
        system_filter: Optional[str] = None,
    ) -> Tuple[List[Dict[str, Any]], int]:
        """
        Быстрый пагинированный поиск по словарю DTC (12 000+ кодов за <5 мс)
        с детерминированным приоритетом точных совпадений кода, Tier 1 и телеметрии.
        """
        try:
            safe_limit = max(1, int(limit)) if limit is not None else 80
        except (ValueError, TypeError):
            safe_limit = 80

        try:
            safe_offset = max(0, int(offset)) if offset is not None else 0
        except (ValueError, TypeError):
            safe_offset = 0

        raw_q = search_term if search_term is not None else (query or "")
        q = str(raw_q).strip().lower()
        q_up = q.upper()

        raw_sys = system_filter if system_filter is not None else (system or "")
        sys_filter = str(raw_sys).strip().lower()
        if sys_filter == "all":
            sys_filter = ""

        if not self.dtc_catalog:
            return [], 0

        if not q:
            if not sys_filter:
                matched_codes = self._dtc_default_sorted_codes
            else:
                matched_codes = [
                    c for c in self._dtc_default_sorted_codes
                    if self.dtc_catalog[c]["system"].lower() == sys_filter
                ]
            total = len(matched_codes)
            page_codes = matched_codes[safe_offset : safe_offset + safe_limit]
            return [self.dtc_catalog[c] for c in page_codes], total

        scored_matches: List[Tuple[Tuple[int, int, int, int, int, str], str]] = []
        blobs = self._dtc_search_blobs
        base_keys = self._dtc_base_rank_key
        catalog = self.dtc_catalog

        for code, blob in blobs.items():
            if sys_filter and catalog[code]["system"].lower() != sys_filter:
                continue
            if q not in blob:
                continue
            if code == q_up:
                match_rank = 0
            elif code.startswith(q_up):
                match_rank = 1
            elif q_up in code:
                match_rank = 2
            else:
                match_rank = 3
            scored_matches.append(((match_rank, *base_keys[code]), code))

        scored_matches.sort(key=lambda pair: pair[0])
        total = len(scored_matches)
        page = [catalog[code] for _, code in scored_matches[safe_offset : safe_offset + safe_limit]]
        return page, total

    def search_dtc_dictionary(
        self,
        query: str = "",
        system: str = "",
        limit: int = 50,
        search_term: Optional[str] = None,
        system_filter: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        items, _ = self.search_dtc_dictionary_paginated(
            query=query,
            system=system,
            limit=limit,
            offset=0,
            search_term=search_term,
            system_filter=system_filter,
        )
        return items

    def get_dtc_details(self, code: str) -> Optional[Dict[str, Any]]:
        clean = (code or "").strip().upper()
        return self.dtc_catalog.get(clean)

    def diagnose(
        self,
        query: str,
        top_n: int = 3,
        dtc_codes: Optional[List[str]] = None,
        explicit_codes: Optional[List[str]] = None,
        min_score: float = 0.22,
    ) -> List[Dict[str, Any]]:
        """
        Масштабируемый гибридный поиск неисправностей (O(1) по триграммам/пересечению относительно размера БЗ):
        1. Векторный поиск через SentenceTransformer (`bi_encoder`) + `faiss.IndexFlatIP` (топ-30).
        2. Лексический отбор BM25 (топ-30 строго с `bm25_scores > 0`) + O(1) выборка по кодам DTC.
        3. Символьные триграммы и пересечение токенов только по `candidate_union`.
        4. Сбалансированный пул из 20 кандидатов для `CrossEncoder` (контекст 480 символов) + бонус уровня Tier.
        """
        if not self.raw_data:
            return []

        raw_explicit = (explicit_codes or []) + (dtc_codes or [])
        clean_explicit = [c.strip().upper() for c in raw_explicit if c and c.strip()]
        extracted_codes = [m.upper() for m in DTC_REGEX.findall(query or "")]
        ordered_target_codes = list(dict.fromkeys(clean_explicit + extracted_codes))
        target_codes = set(ordered_target_codes)

        if not target_codes and self.is_general_or_greeting_query(query):
            return []

        q_tokens = tokenize_multilingual(query or "")
        q_token_set = set(q_tokens)
        q_ngrams = char_ngrams(query or "")

        # 1. Векторный поиск через BERT SentenceTransformer + FAISS (топ-30)
        v_indices_list: List[int] = []
        v_scores_map: Dict[int, float] = {}
        active_vec_index = self.vector_index if self.vector_index is not None else self.faiss_index
        if self.bi_encoder is not None and active_vec_index is not None and (query or "").strip():
            try:
                import faiss

                raw_q_emb = self.bi_encoder.encode([query], show_progress_bar=False, convert_to_numpy=True)
                q_emb = np.ascontiguousarray(raw_q_emb, dtype=np.float32)
                if q_emb.ndim == 1:
                    q_emb = q_emb.reshape(1, -1)
                faiss.normalize_L2(q_emb)
                v_dists, v_indices = active_vec_index.search(q_emb, min(30, len(self.raw_data)))
                for dist, idx in zip(v_dists[0], v_indices[0]):
                    if int(idx) >= 0:
                        v_indices_list.append(int(idx))
                        v_scores_map[int(idx)] = float(dist)
            except Exception:
                pass

        # 2. Лексический отбор BM25 (топ-30 строго среди документов с положительным весом > 0)
        bm25_scores: Optional[np.ndarray] = None
        max_bm25 = 0.0
        bm25_indices: List[int] = []
        if self.bm25 is not None and q_tokens:
            bm25_scores = np.asarray(self.bm25.get_scores(q_tokens), dtype=np.float64)
            if bm25_scores.size > 0:
                max_bm25 = float(np.max(bm25_scores))
                pos_idx = np.flatnonzero(bm25_scores > 0.0)
                if pos_idx.size > 30:
                    part = np.argpartition(bm25_scores[pos_idx], -30)[-30:]
                    top_pos = pos_idx[part]
                    bm25_indices = [int(i) for i in top_pos[np.argsort(bm25_scores[top_pos])[::-1]]]
                elif pos_idx.size > 0:
                    bm25_indices = [int(i) for i in pos_idx[np.argsort(bm25_scores[pos_idx])[::-1]]]

        # 3. O(1) выборка индексов по кодам DTC (все записи Tier 1 + до 8 внешних/OEM записей на код)
        dtc_indices: List[int] = []
        for c in ordered_target_codes:
            ext_count = 0
            for doc_idx in self._code_to_doc_indices.get(c, []):
                tier_val = int(self.raw_data[doc_idx].get("tier") or 1)
                if tier_val <= 1:
                    dtc_indices.append(doc_idx)
                elif ext_count < 8:
                    dtc_indices.append(doc_idx)
                    ext_count += 1
        if dtc_indices:
            dtc_indices = list(dict.fromkeys(dtc_indices))

        # 4. Расчёт триграмм и пересечения токенов ТОЛЬКО по объединённому пулу кандидатов — O(1) по размеру БЗ
        candidate_union = list(dict.fromkeys(dtc_indices + v_indices_list + bm25_indices))
        if not candidate_union:
            return []

        lexical_scores: Dict[int, float] = {}
        for idx in candidate_union:
            item = self.raw_data[idx]
            code = (item.get("code") or "").upper()
            bm25_val = float(bm25_scores[idx]) if (bm25_scores is not None and idx < bm25_scores.size) else 0.0
            bm25_norm = (bm25_val / max_bm25) if max_bm25 > 0 else 0.0
            ngram_sim = cosine_counter_similarity(q_ngrams, self.doc_ngrams[idx])
            vec_sim = max(0.0, v_scores_map.get(idx, 0.0))

            code_boost = 2.5 if code in target_codes else 0.0
            token_overlap = len(q_token_set & self._doc_token_sets[idx])
            overlap_boost = min(token_overlap * 0.18, 0.72)

            combined_lex = (
                (0.45 * bm25_norm)
                + (0.25 * ngram_sim)
                + (0.30 * vec_sim)
                + overlap_boost
                + code_boost
            )
            if combined_lex >= min_score or code in target_codes or idx in v_scores_map:
                lexical_scores[idx] = combined_lex

        if not lexical_scores and not v_indices_list and not dtc_indices:
            return []

        top_lex_indices = [
            idx for idx, _ in sorted(lexical_scores.items(), key=lambda kv: kv[1], reverse=True)
        ]

        # Сбалансированный пул из 20 кандидатов: 30 векторных хитов не вытесняют сильные BM25/лексические совпадения
        candidate_indices = list(
            dict.fromkeys(
                dtc_indices
                + top_lex_indices[:10]
                + v_indices_list[:10]
                + top_lex_indices[10:]
                + v_indices_list[10:]
                + bm25_indices
            )
        )[:20]

        best_lex = max((lexical_scores.get(i, 0.0) for i in candidate_indices), default=0.0)
        best_vec = max((v_scores_map.get(i, 0.0) for i in candidate_indices), default=0.0)
        if not target_codes and best_lex < min_score and best_vec < 0.42:
            return []

        # 5. Переранжирование кандидатов через CrossEncoder с расширенным окном 480 символов
        rerank_scores: Dict[int, float] = {}
        if self.reranker is not None and candidate_indices and (query or "").strip():
            try:
                pairs = [[query, self.documents[idx][:480]] for idx in candidate_indices]
                ce_preds = self.reranker.predict(pairs)
                for idx, s in zip(candidate_indices, ce_preds):
                    rerank_scores[idx] = float(s)
            except Exception:
                rerank_scores = {}

        results: List[Dict[str, Any]] = []
        seen_keys = set()

        for idx in candidate_indices:
            meta = self.raw_data[idx]
            code = (meta.get("code") or "").upper()
            sym_prefix = (meta.get("symptoms") or meta.get("text") or "")[:45]
            oem_tag = (meta.get("oem_make") or "").upper()
            dedup_key = (
                f"{code}:{meta.get('system', '')}:{oem_tag}:{sym_prefix}"
                if oem_tag
                else f"{code}:{meta.get('system', '')}:{sym_prefix}"
            )
            if dedup_key in seen_keys:
                continue
            seen_keys.add(dedup_key)

            health = int(meta.get("health_index", 50))
            health_bonus = (100 - health) / 200.0
            lex_val = lexical_scores.get(idx, 0.0)
            vec_val = v_scores_map.get(idx, 0.0)

            src = meta.get("source", "")
            tier_val = int(meta.get("tier") or 1)
            if src == "kb_data.json":
                tier_bonus = 0.09
            elif tier_val == 1:
                tier_bonus = 0.07
            elif tier_val == 2:
                tier_bonus = 0.02
            else:
                tier_bonus = 0.0

            if idx in rerank_scores:
                ce_logit = rerank_scores[idx]
                ce_prob = 1.0 / (1.0 + math.exp(-max(min(ce_logit, 20.0), -20.0)))
                code_bonus = 2.0 if code in target_codes else 0.0
                final_score = round(
                    float(
                        0.45 * ce_prob
                        + 0.40 * lex_val
                        + 0.15 * vec_val
                        + health_bonus * 0.25
                        + code_bonus
                        + tier_bonus
                    ),
                    3,
                )
            else:
                final_score = round(float(lex_val + (health_bonus * 0.12) + tier_bonus), 3)

            results.append(
                {
                    "id": meta.get("id", f"KB-{idx}"),
                    "text": self.documents[idx],
                    "score": final_score,
                    "meta": meta,
                }
            )

        results.sort(key=lambda x: x["score"], reverse=True)
        return results[:top_n]

    search = diagnose

    def prepare_llm_context(
        self,
        query: str,
        top_n: int = 3,
        dtc_codes: Optional[List[str]] = None,
        extra_docs_text: Optional[str] = None,
        dialog_summary: Optional[str] = None,
        global_summary: Optional[str] = None,
        vehicle_info: Optional[str] = None,
        precomputed_hits: Optional[List[Dict[str, Any]]] = None,
    ) -> str:
        """
        Формирует структурированный контекст базы знаний и памяти для промпта LLM (Google Gemma 4 12B).
        """
        hits = (
            list(precomputed_hits[:top_n])
            if precomputed_hits is not None
            else self.diagnose(query=query, top_n=top_n, dtc_codes=dtc_codes)
        )
        # Если в запросе есть явные коды DTC и найдены точные совпадения, отсекаем шумные посторонние коды
        if dtc_codes and hits:
            dtc_set = {c.strip().upper() for c in dtc_codes if c and c.strip()}
            exact_hits = [h for h in hits if ((h.get("meta") or {}).get("code") or "").upper() in dtc_set]
            if exact_hits:
                primary_systems = {((h.get("meta") or {}).get("system") or "").lower() for h in exact_hits}
                filtered = list(exact_hits)
                for h in hits:
                    if h in filtered:
                        continue
                    h_sys = ((h.get("meta") or {}).get("system") or "").lower()
                    if h_sys in primary_systems or float(h.get("score", 0.0)) >= 1.5:
                        filtered.append(h)
                hits = filtered[:top_n]
        parts: List[str] = []

        if vehicle_info and vehicle_info.strip():
            parts.append(f"[Автомобиль в сессии]: {vehicle_info.strip()}")
        if global_summary:
            parts.append(f"[Глобальный профиль и накопленная память клиента]:\n{global_summary.strip()}")
        if dialog_summary:
            parts.append(f"[Сжатая сводка ранней истории диалога]:\n{dialog_summary.strip()}")

        if hits:
            kb_lines = ["[Релевантные прецеденты из экспертной базы знаний (BERT + BM25 + CrossEncoder)]:"]
            for i, h in enumerate(hits, 1):
                meta = h.get("meta") or {}
                code = meta.get("code") or "N/A"
                sys_name = meta.get("system_ru") or meta.get("system") or "Система"
                tel_str = ""
                t_info = self.telemetry_stats.get(code)
                if t_info and t_info.get("sample_measurements"):
                    meas = ", ".join(f"{k}: {v}" for k, v in list(t_info["sample_measurements"].items())[:4])
                    tel_str = f"\n   Эталон телеметрии ({t_info.get('avg_health_index')}% HI): {meas}"
                sym_txt = str(meta.get("symptoms", "") or "")[:180]
                cause_txt = str(meta.get("cause", meta.get("reason", "")) or "")[:180]
                fix_txt = str(meta.get("fix", meta.get("recommendation", "")) or "")[:240]
                kb_lines.append(
                    f"{i}. Код: {code} ({sys_name}) | Релевантность: {h.get('score', 0):.3f}\n"
                    f"   Симптомы: {sym_txt}\n"
                    f"   Причина: {cause_txt}\n"
                    f"   Проверка и ремонт: {fix_txt}{tel_str}"
                )
            parts.append("\n".join(kb_lines))

        if extra_docs_text:
            parts.append(f"[Вложенные диагностические логи и документы]:\n{extra_docs_text.strip()}")

        parts.append(f"[Текущий запрос мастера / симптомы]:\n{(query or '').strip()}")
        return "\n\n".join(parts)
