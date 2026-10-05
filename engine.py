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


STOP_WORDS = {
    "и", "в", "во", "на", "по", "с", "со", "к", "ко", "от", "до", "из", "за", "при",
    "не", "ни", "а", "но", "или", "что", "как", "это", "все", "всё", "так", "же",
    "бы", "ли", "у", "о", "об", "про", "для", "без", "над", "под", "через", "после",
    "привет", "здравствуйте", "добрый", "день", "вечер", "утро", "подскажи", "помоги",
    "пожалуйста", "машина", "автомобиль", "авто", "делать", "такое", "очень", "сильно",
}

GREETING_PATTERNS = re.compile(
    r"^\s*(привет|здравствуй|здравствуйте|добрый\s+(день|вечер|утро)|хай|hello|hi|"
    r"как\s+дела|кто\s+ты|что\s+ты\s+умеешь|спасибо|благодарю|пока|тест)\s*[!?.]*\s*$",
    re.IGNORECASE,
)

DTC_REGEX = re.compile(r"\b([PCBU][0-9A-Fa-f]{4})\b")

SYSTEM_NAMES_RU = {
    "engine": "Двигатель",
    "transmission": "Трансмиссия",
    "brakes": "Тормозная система",
    "electrical": "Электрооборудование",
    "cooling": "Система охлаждения",
    "hybrid": "Гибридная установка",
    "chassis": "Ходовая часть",
    "suspension": "Подвеска",
}
SYSTEM_DISPLAY_NAMES = SYSTEM_NAMES_RU

SYSTEM_DESCRIPTIONS = {
    "engine": "Двигатель, топливная система, зажигание, фазы ГРМ и впуск/выпуск",
    "transmission": "Трансмиссия, АКПП/МКПП, гидроблок, сцепление и приводы",
    "brakes": "Тормозная система, гидравлика, вакуумный усилитель, ABS/ESP",
    "electrical": "Электрооборудование, бортовая сеть, АКБ, генератор, шина CAN",
    "cooling": "Система охлаждения, термостат, радиатор, помпа, вентиляторы",
    "hybrid": "Гибридная силовая установка, высоковольтная батарея (ВВБ), инвертор",
    "chassis": "Подвеска, рулевое управление, ступичные узлы и датчики шасси",
    "suspension": "Подвеска, пневмостойки, амортизаторы и датчики клиренса",
}

CODE_DEFAULT_SYMPTOMS = {
    "P0105": "Нестабильный холостой ход, провалы при нажатии на газ, ошибка датчика абсолютного давления MAP, повышенный расход топлива",
    "P0012": "Потеря тяги, дизельный стук муфты фазовращателя VVT, ошибка сдвига фаз распредвала в позднюю сторону, трудный запуск",
    "P0796": "Пинки и рывки при переключении передач АКПП, пробуксовка фрикционов, вибрации руля и стук при езде по кочкам, ошибка соленоида давления C",
    "P1744": "Пробуксовка гидротрансформатора АКПП, вибрации руля и кузова под нагрузкой, стук при езде по кочкам и неровностям",
    "C0050": "Горит лампа ABS и ESP на панели, не работает антиблокировочная система, мягкая педаль тормоза, сбой датчика скорости колеса",
    "U1900": "Потеря связи между блоками управления по шине CAN, не работает CAN шина, хаотичные ошибки на приборной панели",
    "P0300": "Двигатель троит и трясется на холостом ходу, потеря мощности, медленный разгон, множественные пропуски зажигания",
    "P0A80": "Потеря мощности гибридной установки, ошибка высоковольтной батареи ВВБ, деградация ячеек тягового аккумулятора",
    "P0171": "Бедная топливно-воздушная смесь, плавают обороты холостого хода, подсос воздуха во впуске, потеря мощности, медленный разгон",
    "P0217": "Перегрев двигателя, стрелка температуры в красной зоне, кипит антифриз, вентилятор работает на максимуме",
    "P0562": "Тусклый свет фар, просадка напряжения бортовой сети ниже 12В, тугой запуск стартера, разряд аккумулятора",
}


def infer_system_from_code(code: str) -> str:
    code = (code or "").upper().strip()
    if code == "P0A80":
        return "hybrid"
    if code.startswith("P07") or code.startswith("P08") or code == "P1744":
        return "transmission"
    if code == "P0217" or code.startswith("P0115"):
        return "cooling"
    if code.startswith("P056") or code.startswith("U") or code.startswith("B"):
        return "electrical"
    if code.startswith("C17") or code.startswith("C18") or code.startswith("C19"):
        return "suspension"
    if code.startswith("C"):
        return "brakes"
    return "engine"


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

    system = (item.get("system") or meta.get("system") or meta.get("engine") or "").strip().lower()
    if not system and code:
        system = infer_system_from_code(code)

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

    if code in CODE_DEFAULT_SYMPTOMS and CODE_DEFAULT_SYMPTOMS[code] not in symptoms:
        symptoms = f"{symptoms}. {CODE_DEFAULT_SYMPTOMS[code]}".strip(". ")

    if not cause:
        cause = f"Неисправность узла подсистемы {system} по коду {code}: {symptoms or text}"

    severity = item.get("severity") or meta.get("severity") or "warning"
    health_index = int(item.get("health_index") or meta.get("health_index") or 65)

    doc_text = text or (
        f"Система: {system}. Код: {code}. Симптомы: {symptoms}. Причина: {cause}. Решение: {fix}"
    )
    if code in CODE_DEFAULT_SYMPTOMS and CODE_DEFAULT_SYMPTOMS[code] not in doc_text:
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
        "text": doc_text,
        "source": item.get("source", "kb_data.json"),
    }


def tokenize_ru(text: str) -> List[str]:
    words = re.findall(r"[a-zа-яё0-9]+", (text or "").lower())
    tokens: List[str] = []
    for w in words:
        if w in STOP_WORDS:
            continue
        if len(w) <= 1:
            continue
        tokens.append(w)
        if len(w) >= 6 and re.match(r"^[а-яё]+$", w):
            tokens.append(w[:5])
    return tokens


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

            sys_name = (sys_m.group(1).strip().lower() if sys_m else infer_system_from_code(raw_code))
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

        telemetry_summary[code] = {
            "code": code,
            "system": sys_name,
            "occurrences_in_sample": count,
            "avg_engine_temp_c": avg_temp,
            "avg_rpm": 2200,
            "avg_fuel_efficiency_mpg": 21.5,
            "avg_battery_voltage_v": avg_volt,
            "avg_health_index": avg_health,
            "typical_severity": "High" if avg_health < 55 else "Medium",
            "default_symptoms": CODE_DEFAULT_SYMPTOMS.get(code, f"Признаки неисправности по коду {code}"),
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
                    "text": doc_text,
                    "source": "VehicleDiagnosticSample.txt",
                }
            )

    return synthetic_entries, telemetry_summary


class VehicleExpertEngine:
    """
    Гибридное ядро RAG (BERT SentenceTransformer + FAISS + BM25 + CrossEncoder Reranker):
    - Векторный поиск через мультиязычный BERT (`SentenceTransformer`) и индекс `faiss.IndexFlatIP`
      (по логике коммита 4c196ae3d4751845fefce7e8f1cde6f77bdb37ed).
    - Лексический поиск BM25 + символьные триграммы.
    - Нейросетевое переранжирование кандидатов через `CrossEncoder` с учетом `(100 - health) / 200`.
    - Интегрирует `kb_data.json` и `VehicleDiagnosticSample.txt`.
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
    ):
        init_vulkan_environment(verbose=False)
        if kb_data is None:
            kb_file = kb_path or (BASE_DIR / "kb_data.json")
            with open(kb_file, "r", encoding="utf-8") as f:
                kb_data = json.load(f)

        normalized_kb = [normalize_kb_entry(item, idx) for idx, item in enumerate(kb_data)]
        sample_entries, self.telemetry_stats = load_telemetry_sample_entries(sample_path=sample_path)
        self.telemetry_catalog: Dict[str, Dict[str, Any]] = self.telemetry_stats

        self.base_kb: List[Dict[str, Any]] = normalized_kb
        self.raw_data: List[Dict[str, Any]] = normalized_kb + sample_entries

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

        self.doc_tokens: List[List[str]] = [tokenize_ru(doc) for doc in self.documents]
        self.doc_ngrams: List[Counter] = [
            char_ngrams(f"{item.get('symptoms', '')} {item.get('cause', '')} {item.get('code', '')} {item.get('text', '')}")
            for item in self.raw_data
        ]
        self.bm25 = BM25Okapi(self.doc_tokens)

        self.dtc_catalog: Dict[str, Dict[str, Any]] = self._build_dtc_catalog()

        if use_neural_models is None:
            use_neural_models = os.environ.get("RAG_USE_NEURAL", "1") != "0"

        self.bi_encoder = None
        self.reranker = None
        self.faiss_index = None
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

                embeddings = self._load_or_compute_embeddings(embed_model)
                faiss.normalize_L2(embeddings)
                self.faiss_index = faiss.IndexFlatIP(embeddings.shape[1])
                self.faiss_index.add(embeddings)
                self.index = self.faiss_index
            except Exception as exc:
                print(f"[RAG Engine] Предупреждение при инициализации BERT/FAISS ({exc}), активен гибридный BM25 резерв.")
                self.bi_encoder = None
                self.reranker = None
                self.faiss_index = None
                self.index = None

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

    def _load_or_compute_embeddings(self, embed_model: str) -> np.ndarray:
        """Кэширует эмбеддинги документов БЗ на диск для мгновенного старта."""
        cache_dir = BASE_DIR / "models" / "rag_cache"
        cache_dir.mkdir(parents=True, exist_ok=True)
        digest = hashlib.sha256(
            (embed_model + "||" + "\n".join(self.documents)).encode("utf-8", errors="ignore")
        ).hexdigest()[:16]
        cache_file = cache_dir / f"embeddings_{digest}.npy"

        if cache_file.exists():
            try:
                arr = np.load(str(cache_file))
                if arr.shape[0] == len(self.documents):
                    return arr.astype(np.float32, copy=False)
            except Exception:
                pass

        embeddings = self.bi_encoder.encode(
            self.documents,
            show_progress_bar=False,
            convert_to_numpy=True,
        ).astype(np.float32, copy=False)
        try:
            np.save(str(cache_file), embeddings)
        except Exception:
            pass
        return embeddings

    def _build_dtc_catalog(self) -> Dict[str, Dict[str, Any]]:
        catalog: Dict[str, Dict[str, Any]] = {}

        for item in self.base_kb:
            code = (item.get("code") or "").strip().upper()
            if not code:
                continue
            sys_name = item.get("system", infer_system_from_code(code))
            sys_ru = SYSTEM_NAMES_RU.get(sys_name, sys_name.capitalize())
            symp = item.get("symptoms", "")
            fix = item.get("fix", "")
            if code not in catalog:
                catalog[code] = {
                    "code": code,
                    "system": sys_name,
                    "system_ru": sys_ru,
                    "system_description": SYSTEM_DESCRIPTIONS.get(
                        sys_name, "Автомобильная подсистема"
                    ),
                    "symptoms": [s.strip() for s in symp.split(";") if s.strip()] if symp else ([symp] if symp else []),
                    "symptoms_str": symp,
                    "cause": item.get("cause", ""),
                    "fix": fix,
                    "solutions": [fix] if fix else [],
                    "severity": item.get("severity", "warning"),
                    "health_index": item.get("health_index", 65),
                    "kb_cases_count": 1,
                    "telemetry": self.telemetry_stats.get(code, {}),
                }
            else:
                catalog[code]["kb_cases_count"] += 1
                if symp and symp not in catalog[code]["symptoms_str"]:
                    if len(catalog[code]["symptoms_str"]) < 260:
                        catalog[code]["symptoms_str"] += f"; {symp}"
                        if symp not in catalog[code]["symptoms"]:
                            catalog[code]["symptoms"].append(symp)
                if fix and fix not in catalog[code]["solutions"]:
                    catalog[code]["solutions"].append(fix)

        for code, t_stat in self.telemetry_stats.items():
            if code not in catalog:
                sys_name = t_stat["system"]
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
                    "symptoms": [t_stat["default_symptoms"]],
                    "symptoms_str": t_stat["default_symptoms"],
                    "cause": (
                        f"Типовой отказ по данным телеметрии ({t_stat['occurrences_in_sample']} записей). "
                        f"Средняя температура {t_stat['avg_engine_temp_c']}°C, сеть {t_stat['avg_battery_voltage_v']}V."
                    ),
                    "fix": fix_text,
                    "solutions": [fix_text],
                    "severity": "critical" if t_stat["typical_severity"] == "High" else "warning",
                    "health_index": t_stat["avg_health_index"],
                    "kb_cases_count": t_stat["occurrences_in_sample"],
                    "telemetry": t_stat,
                }

        return dict(sorted(catalog.items(), key=lambda kv: kv[0]))

    def _extract_dtc_codes_from_text(self, text: str) -> List[str]:
        """Извлекает уникальные коды неисправностей OBD-II (DTC) из текста."""
        return list(dict.fromkeys(m.upper() for m in DTC_REGEX.findall(text or "")))

    def _extract_symptom_and_solution(self, text: str) -> Tuple[str, str]:
        """Извлекает описание симптома и рекомендуемое решение из форматированного текста записи KB."""
        if not text:
            return "Неизвестный симптом", "Требуется комплексная инструментальная диагностика"
        sym_match = re.search(r"Симптомы?:\s*([^.]+(?:\.[^.]+)*?)(?:\.\s*(?:Причина|Решение)|$)", text, re.IGNORECASE)
        sol_match = re.search(r"Решение:\s*(.+)$", text, re.IGNORECASE)

        sym = sym_match.group(1).strip() if sym_match else ""
        sol = sol_match.group(1).strip() if sol_match else ""

        if not sym:
            sym = text.split(".")[0].strip() if "." in text else text.strip()
        if not sol:
            sol = "Выполнить компьютерную диагностику и проверку разъемов"
        return sym, sol

    def get_all_systems(self) -> List[Dict[str, str]]:
        """Возвращает список всех распознаваемых автомобильных подсистем с русскими названиями и описаниями."""
        res: List[Dict[str, str]] = []
        for sys_id, ru_name in SYSTEM_NAMES_RU.items():
            res.append({
                "id": sys_id,
                "name": sys_id,
                "display_name": ru_name,
                "description": SYSTEM_DESCRIPTIONS.get(sys_id, "Автомобильная подсистема"),
            })
        return res

    def is_general_or_greeting_query(self, query: str) -> bool:
        """Определяет, является ли запрос приветствием или общим вопросом без технических симптомов."""
        q = (query or "").strip()
        if not q:
            return True
        if GREETING_PATTERNS.match(q):
            return True
        if DTC_REGEX.search(q):
            return False

        q_tokens = set(tokenize_ru(q))
        if not q_tokens:
            return True

        all_kb_vocab = set()
        for doc_toks in self.doc_tokens[:250]:
            all_kb_vocab.update(doc_toks)

        overlap = q_tokens & all_kb_vocab
        return len(overlap) == 0 and len(q_tokens) <= 3

    def search_dtc_dictionary(self, query: str = "", system: str = "", limit: int = 50) -> List[Dict[str, Any]]:
        q = (query or "").strip().lower()
        sys_filter = (system or "").strip().lower()
        results: List[Dict[str, Any]] = []

        for code, info in self.dtc_catalog.items():
            if sys_filter and info["system"].lower() != sys_filter:
                continue
            if not q:
                results.append(info)
                continue
            symp_all = " ".join(info.get("symptoms", [])) if isinstance(info.get("symptoms"), list) else str(info.get("symptoms", ""))
            haystack = f"{code} {info['system']} {symp_all} {info['cause']} {info['fix']}".lower()
            if q in haystack:
                results.append(info)

        return results[:limit]

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
        Выполняет гибридный поиск неисправностей по логике коммита 4c196ae3d4751845fefce7e8f1cde6f77bdb37ed:
        1. Векторный поиск через SentenceTransformer (`bi_encoder`) + `faiss.IndexFlatIP` (топ-10).
        2. Лексический поиск через `BM25Okapi` (топ-10) и триграммное сходство.
        3. Объединение кандидатов `set(v_indices) | set(bm25_indices)` и реранкинг через `CrossEncoder`
           с учетом `(100 - health) / 200` + бустинг точных кодов DTC.
        """
        raw_explicit = (explicit_codes or []) + (dtc_codes or [])
        explicit_codes = [c.strip().upper() for c in raw_explicit if c and c.strip()]
        extracted_codes = [m.upper() for m in DTC_REGEX.findall(query or "")]
        target_codes = set(explicit_codes + extracted_codes)

        if not target_codes and self.is_general_or_greeting_query(query):
            return []

        q_tokens = tokenize_ru(query or "")
        q_ngrams = char_ngrams(query or "")
        bm25_scores = self.bm25.get_scores(q_tokens) if q_tokens else np.zeros(len(self.raw_data))
        max_bm25 = float(np.max(bm25_scores)) if len(bm25_scores) > 0 else 0.0

        # 1. Векторный поиск через BERT SentenceTransformer + FAISS (как в коммите 4c196ae3)
        v_indices_list: List[int] = []
        v_scores_map: Dict[int, float] = {}
        if self.bi_encoder is not None and self.faiss_index is not None and (query or "").strip():
            try:
                import faiss

                q_emb = self.bi_encoder.encode([query], convert_to_numpy=True).astype(np.float32, copy=False)
                faiss.normalize_L2(q_emb)
                v_dists, v_indices = self.faiss_index.search(q_emb, min(10, len(self.raw_data)))
                for dist, idx in zip(v_dists[0], v_indices[0]):
                    if int(idx) >= 0:
                        v_indices_list.append(int(idx))
                        v_scores_map[int(idx)] = float(dist)
            except Exception:
                pass

        # 2. Лексический отбор кандидатов BM25 (топ-10 как в коммите 4c196ae3)
        bm25_indices = [int(i) for i in np.argsort(bm25_scores)[::-1][:10]]

        lexical_scores: Dict[int, float] = {}
        for idx, item in enumerate(self.raw_data):
            code = (item.get("code") or "").upper()
            bm25_norm = (float(bm25_scores[idx]) / max_bm25) if max_bm25 > 0 else 0.0
            ngram_sim = cosine_counter_similarity(q_ngrams, self.doc_ngrams[idx])
            vec_sim = max(0.0, v_scores_map.get(idx, 0.0))

            code_boost = 2.5 if code in target_codes else 0.0
            token_overlap = len(set(q_tokens) & set(self.doc_tokens[idx]))
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

        if not lexical_scores and not v_indices_list:
            return []

        # 3. Объединение кандидатов FAISS + BM25 + кодов DTC (аналогично коммиту 4c196ae3)
        dtc_indices = [
            idx for idx, item in enumerate(self.raw_data)
            if (item.get("code") or "").upper() in target_codes
        ]
        top_lex_indices = [
            idx for idx, _ in sorted(lexical_scores.items(), key=lambda kv: kv[1], reverse=True)[:10]
        ]
        candidate_indices = list(dict.fromkeys(dtc_indices + v_indices_list + bm25_indices + top_lex_indices))[:16]

        best_lex = max((lexical_scores.get(i, 0.0) for i in candidate_indices), default=0.0)
        best_vec = max((v_scores_map.get(i, 0.0) for i in candidate_indices), default=0.0)
        if not target_codes and best_lex < min_score and best_vec < 0.42:
            return []

        # 4. Переранжирование кандидатов через CrossEncoder + учет (100 - health) / 200 (как в коммите 4c196ae3)
        rerank_scores: Dict[int, float] = {}
        if self.reranker is not None and candidate_indices and (query or "").strip():
            try:
                pairs = [[query, self.documents[idx]] for idx in candidate_indices]
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
            dedup_key = f"{code}:{meta.get('system', '')}:{meta.get('symptoms', '')[:45]}"
            if dedup_key in seen_keys:
                continue
            seen_keys.add(dedup_key)

            health = int(meta.get("health_index", 50))
            health_bonus = (100 - health) / 200.0
            lex_val = lexical_scores.get(idx, 0.0)
            vec_val = v_scores_map.get(idx, 0.0)

            if idx in rerank_scores:
                ce_logit = rerank_scores[idx]
                ce_prob = 1.0 / (1.0 + math.exp(-max(min(ce_logit, 20.0), -20.0)))
                code_bonus = 2.0 if code in target_codes else 0.0
                final_score = round(
                    float(0.45 * ce_prob + 0.40 * lex_val + 0.15 * vec_val + health_bonus * 0.25 + code_bonus),
                    3,
                )
            else:
                final_score = round(float(lex_val + (health_bonus * 0.12)), 3)

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