import json
import logging
import math
import os
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from rank_bm25 import BM25Okapi

from vulkan_backend import BASE_DIR, get_torch_device, init_vulkan_environment

DEFAULT_KB_PATH = BASE_DIR / "kb_data.json"
DEFAULT_SAMPLE_PATH = BASE_DIR / "VehicleDiagnosticSample.txt"
DEFAULT_LOG_PATH = BASE_DIR / "diagnostics_history.log"

SYSTEM_TRANSLATIONS: Dict[str, List[str]] = {
    "engine": [
        "двигатель", "мотор", "двс", "цилиндр", "свеч", "катушк", "форсунк",
        "троит", "трясет", "глохнет", "компресси", "грм", "распредвал", "коленвал",
        "дпкв", "дпрв", "дмрв", "maf", "map", "лямбд", "катализатор", "турбин",
        "наддув", "передув", "смесь", "бедная", "богатая", "мощност", "разгон",
        "детонац", "дроссел", "egr", "егр", "адсорбер", "evap", "масл", "охлажд",
        "антифриз", "перегрев", "дым", "впуск", "выпуск", "пропуск", "зажиган"
    ],
    "transmission": [
        "трансмиссия", "акпп", "кпп", "мкпп", "коробк", "передач", "переключен",
        "пинки", "пинок", "рывки", "пробуксовк", "гидроблок", "соленоид",
        "гидротрансформатор", "сцеплен", "селектор", "атф", "atf", "редуктор",
        "привод", "шрус", "вибрац", "стук", "кочк", "вал", "фрикцион", "кардан"
    ],
    "brakes": [
        "тормоз", "педаль", "мягкая", "abs", "абс", "колодк", "диск", "суппорт",
        "тормозн", "прокачк", "шланг", "колес", "пульсац", "ручник", "esp", "esc"
    ],
    "electrical": [
        "электрика", "электрооборудование", "can", "кан", "шина", "шине", "проводк",
        "эбу", "блок", "аккумулятор", "генератор", "зарядк", "перезарядк",
        "airbag", "подушк", "улитк", "климат", "панел", "check", "чек",
        "предохранител", "реле", "контакт", "связ", "короткое", "замыкан"
    ],
    "suspension": [
        "подвеска", "пневм", "стойк", "амортизатор", "компрессор", "клиренс",
        "высот", "рычаг", "сайлентблок", "шаров", "пружин", "актуатор", "крены"
    ],
    "battery": [
        "батарея", "ввб", "тяговая", "гибрид", "электромобиль", "ячейк",
        "заряд", "емкост", "изоляц", "инвертор", "bms", "supercapacitor", "lithium"
    ],
    "steering": [
        "рул", "гур", "эур", "рейк", "тяг", "наконечник", "люфт"
    ],
    "cooling": [
        "охлажден", "радиатор", "термостат", "помп", "вентилятор", "тосол"
    ],
}

SYSTEM_DISPLAY_NAMES: Dict[str, str] = {
    "engine": "Двигатель (ДВС)",
    "transmission": "Трансмиссия / АКПП",
    "brakes": "Тормозная система / ABS",
    "electrical": "Электрика и шина CAN",
    "suspension": "Подвеска / Пневмосистема",
    "battery": "Высоковольтная батарея / Питание",
    "steering": "Рулевое управление",
    "cooling": "Система охлаждения",
}

SYMPTOM_RU_MAP: Dict[str, str] = {
    "hard shifting": "жёсткое переключение передач (пинки АКПП)",
    "slow charging": "медленная зарядка высоковольтной батареи",
    "soft pedal": "мягкая/проваливающаяся педаль тормоза",
    "engine misfire": "пропуски зажигания, двигатель троит",
    "rough idle": "неровный холостой ход, вибрация",
    "loss of power": "потеря мощности и динамики разгона",
    "overheating": "перегрев узла / повышенная температура",
    "high vibration": "повышенная вибрация и стук при движении",
    "voltage drop": "просадка напряжения бортовой сети",
    "fluid leak": "утечка рабочей жидкости",
    "delayed engagement": "задержка включения передачи",
    "sensor fault": "сбой показаний датчика",
    "communication error": "потеря связи по шине CAN",
    "abs warning": "ошибка системы ABS / датчика скорости колеса",
    "suspension sag": "проседание пневмоподвески",
}

ACTION_RU_MAP: Dict[str, str] = {
    "filter replacement": "замена фильтра",
    "fluid change": "замена рабочей жидкости / масла",
    "seal inspection": "проверка сальников и уплотнений на герметичность",
    "charge test": "тест нагрузочной способности и заряда батареи",
    "fluid flush": "полная прокачка и замена тормозной жидкости",
    "caliper inspection": "ревизия тормозных суппортов и направляющих",
    "sensor replacement": "замена неисправного датчика",
    "wiring inspection": "прозвонка жгута проводки и разъёмов",
    "ecu diagnostics": "диагностика и проверка ЭБУ",
    "spark plug replacement": "замена свечей зажигания",
    "coil inspection": "проверка катушек зажигания",
    "solenoid replacement": "замена электромагнитного соленоида",
    "compressor repair": "ремонт или замена компрессора",
    "alignment check": "проверка углов установки и калибровка датчиков",
}


def parse_diagnostic_sample_file(
    sample_path: Path = DEFAULT_SAMPLE_PATH,
    max_unique_records: int = 300,
) -> Tuple[List[Dict[str, Any]], Dict[str, Dict[str, Any]]]:
    """
    Парсит файл телеметрии VehicleDiagnosticSample.txt (относительный путь),
    формируя обогащённые записи для RAG и эталонные телеметрические профили по кодам ошибок.
    """
    if not sample_path.exists():
        return [], {}

    raw_text = sample_path.read_text(encoding="utf-8", errors="replace")
    blocks = re.split(r"(?=^Input:\s)", raw_text, flags=re.MULTILINE)

    parsed_records: List[Dict[str, Any]] = []
    telemetry_by_code: Dict[str, Dict[str, Any]] = {}
    seen_signatures = set()

    for block in blocks:
        block = block.strip()
        if not block:
            continue

        record: Dict[str, Any] = {
            "measurements": {},
            "parameters": {},
            "sensors": {},
            "temporal": {},
        }
        current_section: Optional[str] = None

        for line in block.splitlines():
            stripped = line.strip()
            if not stripped:
                continue

            if stripped.startswith("Measurements:"):
                current_section = "measurements"
                continue
            elif stripped.startswith("Parameters:"):
                current_section = "parameters"
                continue
            elif stripped.startswith("Sensors:"):
                current_section = "sensors"
                continue
            elif stripped.startswith("Temporal Data:"):
                current_section = "temporal"
                continue
            elif ":" in stripped and not line.startswith("  "):
                current_section = None
                key, val = stripped.split(":", 1)
                key_norm = key.strip().lower().replace(" ", "_")
                record[key_norm] = val.strip()
            elif current_section and "=" in stripped:
                k, v = stripped.split("=", 1)
                record[current_section][k.strip()] = v.strip()

        code = record.get("fault_code", "").strip().upper()
        system = record.get("system", "engine").strip().lower()
        if not code:
            continue

        health_raw = record.get("parameters", {}).get("health_index", "80")
        health_match = re.search(r"([0-9]+(?:\.[0-9]+)?)", str(health_raw))
        health_index = float(health_match.group(1)) if health_match else 80.0

        notes = record.get("notes", "")
        symptom_en = ""
        sym_match = re.search(r"Observed symptoms:\s*([^.]+)", notes, re.IGNORECASE)
        if sym_match:
            symptom_en = sym_match.group(1).strip().lower()
        symptom_ru = SYMPTOM_RU_MAP.get(symptom_en, symptom_en or "отклонение параметров телеметрии")

        maint_raw = record.get("maintenance_recommendations", "")
        actions_en = [a.strip().lower() for a in maint_raw.split(",") if a.strip()]
        actions_ru = [ACTION_RU_MAP.get(a, a) for a in actions_en]
        actions_str = ", ".join(actions_ru) if actions_ru else maint_raw

        vehicle_type = record.get("vehicle_type", "standard")
        config_type = record.get("configuration", "standard")
        status_str = record.get("status", "normal")

        # Сохраняем агрегированную телеметрию по коду ошибки
        if code not in telemetry_by_code:
            telemetry_by_code[code] = {
                "code": code,
                "system": system,
                "system_ru": SYSTEM_DISPLAY_NAMES.get(system, system),
                "vehicle_types": set(),
                "configurations": set(),
                "statuses": set(),
                "symptoms_ru": set(),
                "actions_ru": set(),
                "sample_measurements": record["measurements"],
                "sample_parameters": record["parameters"],
                "sample_sensors": record["sensors"],
                "sample_temporal": record["temporal"],
                "health_indices": [],
                "occurrences": 0,
            }

        t_entry = telemetry_by_code[code]
        t_entry["vehicle_types"].add(vehicle_type)
        t_entry["configurations"].add(config_type)
        t_entry["statuses"].add(status_str)
        if symptom_ru:
            t_entry["symptoms_ru"].add(symptom_ru)
        for act in actions_ru:
            t_entry["actions_ru"].add(act)
        t_entry["health_indices"].append(health_index)
        t_entry["occurrences"] += 1

        sig = (code, system, config_type, symptom_en)
        if sig not in seen_signatures and len(parsed_records) < max_unique_records:
            seen_signatures.add(sig)
            meas_summary = "; ".join(f"{k}={v}" for k, v in list(record["measurements"].items())[:4])
            sens_summary = "; ".join(f"{k}={v}" for k, v in list(record["sensors"].items())[:3])
            sys_ru = SYSTEM_DISPLAY_NAMES.get(system, system)

            doc_text = (
                f"Система: {sys_ru} ({system}, {vehicle_type}, конфигурация: {config_type}). "
                f"Код: {code}. Статус: {status_str}. "
                f"Симптом: {symptom_ru} ({symptom_en}). "
                f"Измерения: {meas_summary}. "
                f"{'Датчики: ' + sens_summary + '. ' if sens_summary else ''}"
                f"Индекс здоровья узла: {health_index:.1f}%. "
                f"Решение и регламент ТО: {actions_str}."
            )
            parsed_records.append(
                {
                    "text": doc_text,
                    "meta": {
                        "code": code,
                        "system": system,
                        "vehicle_type": vehicle_type,
                        "configuration": config_type,
                        "status": status_str,
                        "health_index": round(health_index, 1),
                        "measurements": record["measurements"],
                        "parameters": record["parameters"],
                        "sensors": record["sensors"],
                        "temporal": record["temporal"],
                        "source": "VehicleDiagnosticSample.txt",
                    },
                }
            )

    # Сериализация множеств в списки
    serialized_telemetry: Dict[str, Dict[str, Any]] = {}
    for code, info in telemetry_by_code.items():
        avg_health = (
            round(sum(info["health_indices"]) / len(info["health_indices"]), 1)
            if info["health_indices"]
            else 80.0
        )
        serialized_telemetry[code] = {
            "code": info["code"],
            "system": info["system"],
            "system_ru": info["system_ru"],
            "vehicle_types": sorted(info["vehicle_types"]),
            "configurations": sorted(info["configurations"]),
            "statuses": sorted(info["statuses"]),
            "symptoms_ru": sorted(info["symptoms_ru"]),
            "actions_ru": sorted(info["actions_ru"]),
            "sample_measurements": info["sample_measurements"],
            "sample_parameters": info["sample_parameters"],
            "sample_sensors": info["sample_sensors"],
            "sample_temporal": info["sample_temporal"],
            "avg_health_index": avg_health,
            "occurrences": info["occurrences"],
        }

    return parsed_records, serialized_telemetry


class VehicleExpertEngine:
    """
    Поисково-аналитическое ядро экспертной системы автодиагностики (RAG + DTC + Telemetry).
    Использует относительные пути и стек ускорения Vulkan (без жесткой привязки к CUDA).
    Экономит видеопамять (8 ГБ VRAM), выполняя гибридный BM25 + символьно-лексический TF-IDF
    и доменный реранкинг, с опциональным подключением нейросетевых эмбеддеров на Vulkan/CPU.
    """

    def __init__(
        self,
        kb_data: Optional[List[Dict[str, Any]]] = None,
        kb_path: Optional[Path] = None,
        sample_path: Optional[Path] = None,
        include_telemetry_sample: bool = True,
        use_neural_models: Optional[bool] = None,
    ):
        self.vulkan_info = init_vulkan_environment(verbose=False)
        self.device = "vulkan" if self.vulkan_info.available else get_torch_device(prefer_vulkan=True)

        self.cfg = {
            "embedder": "Qwen/Qwen3-Embedding-0.6B",
            "reranker": "BAAI/bge-reranker-v2-m3",
            "backend": "Vulkan Hybrid RAG",
        }

        logging.basicConfig(
            filename=str(DEFAULT_LOG_PATH),
            level=logging.INFO,
            format="%(asctime)s - %(levelname)s - %(message)s",
            encoding="utf-8",
        )

        if use_neural_models is None:
            use_neural_models = os.environ.get("RAG_USE_NEURAL", "0") == "1"
        self.use_neural_models = use_neural_models
        self.bi_encoder = None
        self.reranker = None
        self.faiss_index = None

        if self.use_neural_models:
            try:
                import faiss  # type: ignore
                from sentence_transformers import CrossEncoder, SentenceTransformer  # type: ignore

                torch_dev = get_torch_device(prefer_vulkan=True)
                self.bi_encoder = SentenceTransformer(self.cfg["embedder"], device=torch_dev)
                self.reranker = CrossEncoder(self.cfg["reranker"], device=torch_dev)
                self._faiss_module = faiss
            except Exception as exc:
                logging.warning(f"Переключение RAG на легковесный гибридный режим (экономия VRAM): {exc}")
                self.use_neural_models = False

        self.documents: List[str] = []
        self.raw_data: List[Dict[str, Any]] = []
        self.bm25: Optional[BM25Okapi] = None
        self.doc_char_vectors: List[Counter] = []
        self.doc_norms: List[float] = []
        self.dtc_catalog: Dict[str, Dict[str, Any]] = {}
        self.telemetry_catalog: Dict[str, Dict[str, Any]] = {}

        resolved_sample_path = Path(sample_path) if sample_path else DEFAULT_SAMPLE_PATH
        sample_records: List[Dict[str, Any]] = []
        if include_telemetry_sample and resolved_sample_path.exists():
            sample_records, self.telemetry_catalog = parse_diagnostic_sample_file(resolved_sample_path)

        if kb_data is None:
            resolved_kb_path = Path(kb_path) if kb_path else DEFAULT_KB_PATH
            if resolved_kb_path.exists():
                with open(resolved_kb_path, "r", encoding="utf-8") as f:
                    kb_data = json.load(f)

        if kb_data:
            combined_data = list(kb_data)
            if sample_records:
                combined_data.extend(sample_records)
            self.add_knowledge_base(combined_data)

    def _validate_data(self, data: List[Dict[str, Any]]) -> bool:
        if not data or not isinstance(data, list):
            return False
        return all("text" in d and "meta" in d for d in data)

    def _normalize_meta(self, meta: Dict[str, Any], text: str) -> Dict[str, Any]:
        normalized = dict(meta)
        # Исправление опечаток в исходном kb_data.json (например, "engine": "engine" вместо "system": "engine")
        if "system" not in normalized:
            if "engine" in normalized:
                normalized["system"] = normalized["engine"]
            else:
                text_lower = text.lower()
                if "двигатель" in text_lower:
                    normalized["system"] = "engine"
                elif "трансмиссия" in text_lower:
                    normalized["system"] = "transmission"
                elif "тормоз" in text_lower:
                    normalized["system"] = "brakes"
                elif "электрик" in text_lower:
                    normalized["system"] = "electrical"
                elif "подвеск" in text_lower:
                    normalized["system"] = "suspension"
                else:
                    normalized["system"] = "engine"

        code = str(normalized.get("code", "")).strip().upper()
        normalized["code"] = code
        system = str(normalized.get("system", "engine")).strip().lower()
        normalized["system"] = system
        normalized["system_ru"] = SYSTEM_DISPLAY_NAMES.get(system, system)
        if "source" not in normalized:
            normalized["source"] = "kb_data.json"
        return normalized

    def _extract_symptom_and_solution(self, text: str) -> Tuple[str, str]:
        sym_match = re.search(r"Симптом:\s*(.+?)(?:\.\s*Решение:|$)", text, re.IGNORECASE)
        sol_match = re.search(r"Решение(?:\s*и\s*регламент\s*ТО)?:\s*(.+)$", text, re.IGNORECASE)
        symptom = sym_match.group(1).strip().rstrip(".") if sym_match else text
        solution = sol_match.group(1).strip().rstrip(".") if sol_match else ""
        return symptom, solution

    def _char_ngrams(self, text: str, n: int = 4) -> Counter:
        cleaned = re.sub(r"[^a-zа-яё0-9]+", " ", text.lower()).strip()
        padded = f" {cleaned} "
        if len(padded) < n:
            return Counter([padded])
        grams = [padded[i : i + n] for i in range(len(padded) - n + 1)]
        return Counter(grams)

    def _cosine_counter(self, c1: Counter, norm1: float, c2: Counter, norm2: float) -> float:
        if norm1 == 0.0 or norm2 == 0.0:
            return 0.0
        common = set(c1.keys()) & set(c2.keys())
        dot = sum(c1[k] * c2[k] for k in common)
        return dot / (norm1 * norm2)

    def add_knowledge_base(self, data: List[Dict[str, Any]]):
        if not self._validate_data(data):
            raise ValueError("Ошибка структуры данных: отсутствуют обязательные поля 'text' или 'meta'")

        self.raw_data = []
        self.documents = []
        self.doc_char_vectors = []
        self.doc_norms = []
        self.dtc_catalog = {}

        for item in data:
            text = str(item["text"]).strip()
            meta = self._normalize_meta(item.get("meta", {}), text)
            normalized_item = {"text": text, "meta": meta}
            self.raw_data.append(normalized_item)

            # Расширяем индексный текст русскими и английскими ключевыми словами системы
            sys_keywords = " ".join(SYSTEM_TRANSLATIONS.get(meta["system"], [])[:10])
            enriched_doc = f"{text} {meta['code']} {meta['system']} {sys_keywords}"
            self.documents.append(text)

            vec = self._char_ngrams(enriched_doc, n=4)
            norm = math.sqrt(sum(v * v for v in vec.values()))
            self.doc_char_vectors.append(vec)
            self.doc_norms.append(norm)

            # Наполняем сводный каталог кодов ошибок (DTC)
            code = meta.get("code", "")
            if code:
                symptom, solution = self._extract_symptom_and_solution(text)
                if code not in self.dtc_catalog:
                    telemetry = self.telemetry_catalog.get(code, {})
                    self.dtc_catalog[code] = {
                        "code": code,
                        "system": meta["system"],
                        "system_ru": meta["system_ru"],
                        "symptoms": [],
                        "solutions": [],
                        "descriptions": [],
                        "health_index": meta.get(
                            "health_index",
                            telemetry.get("avg_health_index", 85.0),
                        ),
                        "telemetry": telemetry,
                    }
                cat = self.dtc_catalog[code]
                if symptom and symptom not in cat["symptoms"]:
                    cat["symptoms"].append(symptom)
                if solution and solution not in cat["solutions"]:
                    cat["solutions"].append(solution)
                if text not in cat["descriptions"]:
                    cat["descriptions"].append(text)

        tokenized_docs = [self._tokenize(d["text"] + " " + d["meta"].get("system", "")) for d in self.raw_data]
        self.bm25 = BM25Okapi(tokenized_docs)

        if self.use_neural_models and self.bi_encoder is not None:
            embeddings = self.bi_encoder.encode(self.documents, normalize_embeddings=True)
            self.faiss_index = self._faiss_module.IndexFlatIP(embeddings.shape[1])
            self.faiss_index.add(embeddings.astype("float32"))

    def _tokenize(self, text: str) -> List[str]:
        tokens = re.findall(r"[a-zа-яё0-9]+", text.lower())
        stemmed = []
        for t in tokens:
            stemmed.append(t)
            if len(t) >= 5 and re.match(r"^[а-яё]+$", t):
                stemmed.append(t[:5])
        return stemmed

    def _infer_query_systems(self, query: str) -> Dict[str, float]:
        q_lower = query.lower()
        scores: Dict[str, float] = defaultdict(float)
        for sys_name, keywords in SYSTEM_TRANSLATIONS.items():
            for kw in keywords:
                if kw in q_lower:
                    scores[sys_name] += 1.0
        return scores

    def _extract_dtc_codes_from_text(self, text: str) -> List[str]:
        matches = re.findall(r"\b([PCBU][0-9A-F]{4})\b", text.upper())
        return list(dict.fromkeys(matches))

    def diagnose(
        self,
        query: str,
        top_n: int = 5,
        system_filter: Optional[str] = None,
        dtc_codes: Optional[List[str]] = None,
    ) -> List[Dict[str, Any]]:
        if not self.raw_data or self.bm25 is None:
            return []

        extracted_codes = self._extract_dtc_codes_from_text(query)
        if dtc_codes:
            for c in dtc_codes:
                c_up = c.strip().upper()
                if c_up and c_up not in extracted_codes:
                    extracted_codes.append(c_up)

        q_tokens = self._tokenize(query)
        bm25_scores = self.bm25.get_scores(q_tokens)
        max_bm25 = float(np.max(bm25_scores)) if len(bm25_scores) > 0 and np.max(bm25_scores) > 0 else 1.0

        q_vec = self._char_ngrams(query, n=4)
        q_norm = math.sqrt(sum(v * v for v in q_vec.values()))
        inferred_systems = self._infer_query_systems(query)

        # Выбираем топ кандидатов
        bm25_top = np.argsort(bm25_scores)[::-1][:25]
        char_sims = [
            self._cosine_counter(q_vec, q_norm, self.doc_char_vectors[i], self.doc_norms[i])
            for i in range(len(self.raw_data))
        ]
        char_top = np.argsort(char_sims)[::-1][:25]

        candidate_set = set(bm25_top) | set(char_top)

        # Включаем репрезентативные документы из определенной по ключевым словам системы
        if inferred_systems:
            top_sys = max(inferred_systems.items(), key=lambda x: x[1])[0]
            sys_added = 0
            for idx, item in enumerate(self.raw_data):
                if item["meta"].get("system") == top_sys:
                    candidate_set.add(idx)
                    sys_added += 1
                    if sys_added >= 8:
                        break

        # Обязательно включаем точные совпадения по коду ошибки
        if extracted_codes:
            for idx, item in enumerate(self.raw_data):
                if item["meta"].get("code") in extracted_codes:
                    candidate_set.add(idx)

        candidates = list(candidate_set)

        if self.use_neural_models and self.reranker is not None and candidates:
            pairs = [[query, self.documents[i]] for i in candidates]
            neural_scores = self.reranker.predict(pairs)
        else:
            neural_scores = None

        results: List[Dict[str, Any]] = []
        for pos, idx in enumerate(candidates):
            meta = self.raw_data[idx]["meta"]
            doc_sys = meta.get("system", "")
            doc_code = meta.get("code", "")

            if system_filter and system_filter != "all" and doc_sys != system_filter:
                continue

            norm_bm25 = float(bm25_scores[idx]) / max_bm25
            char_score = float(char_sims[idx])
            sys_boost = min(2.0, inferred_systems.get(doc_sys, 0.0) * 0.65)
            code_boost = 2.5 if doc_code in extracted_codes else 0.0

            # Отсекаем нерелевантные совпадения на общих фразах/приветствиях («привет» и т.д.)
            if norm_bm25 <= 0.01 and char_score < 0.14 and sys_boost <= 0.0 and code_boost <= 0.0:
                continue

            kb_priority = 0.25 if meta.get("source") == "kb_data.json" else 0.0

            health = float(meta.get("health_index", 100.0))
            health_factor = (100.0 - health) / 200.0

            if neural_scores is not None:
                base_score = float(neural_scores[pos]) + code_boost + sys_boost
            else:
                base_score = (norm_bm25 * 1.4) + (char_score * 1.8) + sys_boost + code_boost + kb_priority

            final_score = base_score + health_factor
            results.append(
                {
                    "text": self.documents[idx],
                    "score": round(float(final_score), 4),
                    "meta": meta,
                }
            )

        sorted_results = sorted(results, key=lambda x: x["score"], reverse=True)[:top_n]

        if sorted_results:
            best_match = sorted_results[0]
            logging.info(
                f"Query: '{query}' | "
                f"Code: {best_match['meta'].get('code', 'N/A')} | "
                f"System: {best_match['meta'].get('system', 'N/A')} | "
                f"Score: {best_match['score']:.2f}"
            )

        return sorted_results

    def search_dtc_dictionary(
        self,
        search_term: str = "",
        system_filter: str = "",
        limit: int = 60,
    ) -> List[Dict[str, Any]]:
        """Поиск по словарю кодов ошибок (DTC) и телеметрии для интерфейса и ИИ-инструментов."""
        term = search_term.strip().lower()
        sys_f = system_filter.strip().lower()

        matched: List[Dict[str, Any]] = []
        for code, entry in sorted(self.dtc_catalog.items()):
            if sys_f and sys_f != "all" and entry["system"] != sys_f:
                continue

            if term:
                haystack = (
                    f"{code} {entry['system']} {entry['system_ru']} "
                    f"{' '.join(entry['symptoms'])} {' '.join(entry['solutions'])}"
                ).lower()
                if term not in haystack:
                    continue

            matched.append(
                {
                    "code": entry["code"],
                    "system": entry["system"],
                    "system_ru": entry["system_ru"],
                    "symptom": entry["symptoms"][0] if entry["symptoms"] else "Не указано",
                    "all_symptoms": entry["symptoms"][:4],
                    "solution": entry["solutions"][0] if entry["solutions"] else "Требуется диагностика",
                    "all_solutions": entry["solutions"][:4],
                    "health_index": entry["health_index"],
                    "has_telemetry": bool(entry.get("telemetry")),
                    "telemetry": entry.get("telemetry", {}),
                }
            )
            if len(matched) >= limit:
                break

        return matched

    def get_dtc_details(self, code: str) -> Optional[Dict[str, Any]]:
        """Возвращает подробную карточку кода ошибки включая эталонную телеметрию."""
        code_up = code.strip().upper()
        entry = self.dtc_catalog.get(code_up)
        if not entry:
            return None
        return entry

    def get_all_systems(self) -> List[Dict[str, Any]]:
        """Возвращает список систем автомобиля с количеством кодов ошибок."""
        counts: Counter = Counter()
        for entry in self.dtc_catalog.values():
            counts[entry["system"]] += 1
        return [
            {
                "id": sys_id,
                "name": SYSTEM_DISPLAY_NAMES.get(sys_id, sys_id),
                "count": count,
            }
            for sys_id, count in sorted(counts.items(), key=lambda x: x[1], reverse=True)
        ]

    def prepare_llm_context(
        self,
        query: str,
        top_n: int = 3,
        dtc_codes: Optional[List[str]] = None,
        extra_docs_text: Optional[str] = None,
        dialog_summary: Optional[str] = None,
        global_summary: Optional[str] = None,
    ) -> str:
        results = self.diagnose(query, top_n=top_n, dtc_codes=dtc_codes)

        context_blocks: List[str] = []
        for i, res in enumerate(results):
            meta = res["meta"]
            code = meta.get("code", "N/A")
            telemetry = self.telemetry_catalog.get(code, {})
            telemetry_line = ""
            if telemetry:
                meas = telemetry.get("sample_measurements", {})
                sens = telemetry.get("sample_sensors", {})
                meas_str = ", ".join(f"{k}={v}" for k, v in meas.items())
                sens_str = ", ".join(f"{k}={v}" for k, v in sens.items())
                telemetry_line = (
                    f"Эталонная телеметрия ({code}): Измерения [{meas_str}] | "
                    f"Датчики [{sens_str}] | Средний Health Index: {telemetry.get('avg_health_index', 80)}%\n"
                )

            block = (
                f"ДОКУМЕНТ #{i + 1} (Релевантность: {res['score']:.2f})\n"
                f"Система: {meta.get('system_ru', meta.get('system', 'N/A'))} ({meta.get('system', 'N/A')})\n"
                f"Код ошибки: {code}\n"
                f"Техническое описание: {res['text']}\n"
                f"{telemetry_line}"
            )
            context_blocks.append(block)

        context_str = (
            "\n".join(context_blocks)
            if context_blocks
            else "Техническая информация по данному запросу в локальной базе не найдена."
        )

        memory_section = ""
        if global_summary:
            memory_section += f"\n[МЕЖДИАЛОГОВАЯ ПАМЯТЬ / ПРОФИЛЬ АВТОМОБИЛЯ]:\n{global_summary}\n"
        if dialog_summary:
            memory_section += f"\n[КРАТКАЯ ВЫЖИМКА ТЕКУЩЕГО ДИАЛОГА]:\n{dialog_summary}\n"
        if extra_docs_text:
            memory_section += f"\n[ПРИКРЕПЛЕННЫЕ ПОЛЬЗОВАТЕЛЕМ ДОКУМЕНТЫ / ЛОГИ]:\n{extra_docs_text}\n"

        return (
            "Используй следующие технические документы, телеметрию и выжимку памяти для ответа на вопрос пользователя.\n"
            f"{memory_section}\n"
            "=== ТЕХНИЧЕСКИЙ КОНТЕКСТ БАЗЫ ЗНАНИЙ (RAG) ===\n"
            f"{context_str}\n"
            f"Вопрос пользователя: {query}"
        )