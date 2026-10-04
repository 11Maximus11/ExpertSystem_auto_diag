"""
Единый оркестратор локального ИИ с поддержкой:
1. AirLLM (https://github.com/lyogavin/airllm) — послойная выгрузка мощных моделей (14B–70B)
   между NVMe SSD, ОЗУ и 8 ГБ видеопамяти (4-bit / 8-bit компрессия слоев).
2. Llama.cpp / GGUF с аппаратным ускорением Vulkan (без зависимости от CUDA).
3. Function Calling (вызов диагностических инструментов) и принудительная валидация
   ответов по строгой JSON-схеме (`DiagnosticStructuredResponse`) с блоками инвентаря и чекбоксами задач.
"""

import json
import logging
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import httpx
from openai import OpenAI

from engine import SYSTEM_DISPLAY_NAMES, VehicleExpertEngine
from vulkan_backend import BASE_DIR, get_vulkan_status, init_vulkan_environment

from .schemas import (
    DIAGNOSTIC_JSON_SCHEMA,
    DIAGNOSTIC_TOOLS_OPENAI_FORMAT,
    DetectedFault,
    DiagnosticStructuredResponse,
    InventoryItem,
    RepairTaskStep,
    ToolCallExecution,
    validate_and_coerce_structured_json,
)

logger = logging.getLogger(__name__)


SYSTEM_INVENTORY_TEMPLATES: Dict[str, List[Dict[str, Any]]] = {
    "engine": [
        {
            "name": "Диагностический сканер OBD-II (ELM327 / Launch / Autel)",
            "category": "tool",
            "spec": "Чтение Freeze Frame и топливных коррекций STFT/LTFT",
            "required": True,
        },
        {
            "name": "Динамометрический ключ 5–60 Н·м и свечная головка 14/16 мм",
            "category": "tool",
            "spec": "Момент затяжки свечей: 20–25 Н·м",
            "required": True,
        },
        {
            "name": "Цифровой мультиметр и компрессометр",
            "category": "tool",
            "spec": "Проверка катушек (0.5–1.5 Ом первичная обмотка) и компрессии (11–14 бар)",
            "required": True,
        },
        {
            "name": "Комплект свечей зажигания / катушка / датчик по коду DTC",
            "category": "part",
            "spec": "Согласно OEM-каталогу по VIN",
            "required": True,
        },
        {
            "name": "Очиститель электрических контактов и диэлектрическая смазка",
            "category": "consumable",
            "spec": "Аэрозоль 400 мл для разъёмов ДПКВ/ДПРВ/ДМРВ/форсунок",
            "required": False,
        },
        {
            "name": "Термостойкие перчатки и защитные очки",
            "category": "safety",
            "spec": "Работы выполнять после остывания ГБЦ ниже 45 °C",
            "required": True,
        },
    ],
    "transmission": [
        {
            "name": "Дилерский/мультимарочный сканер с поддержкой блока TCM (АКПП)",
            "category": "tool",
            "spec": "Контроль температуры ATF (35–45 °C) и токов соленоидов",
            "required": True,
        },
        {
            "name": "Набор торцевых головок Torx/Hex и динамометрический ключ",
            "category": "tool",
            "spec": "Момент затяжки болтов поддона АКПП: 8–12 Н·м, гидроблока: 7–10 Н·м",
            "required": True,
        },
        {
            "name": "Манометр давления линии АКПП и мультиметр",
            "category": "tool",
            "spec": "Проверка сопротивления соленоидов (обычно 5–16 Ом в зависимости от типа)",
            "required": True,
        },
        {
            "name": "Фильтр АКПП, прокладка поддона и комплект соленоидов",
            "category": "part",
            "spec": "Оригинальный ремкомплект гидроблока",
            "required": True,
        },
        {
            "name": "Трансмиссионная жидкость ATF соответствующего допуска",
            "category": "consumable",
            "spec": "Объём частичной замены 4.5–6 л (полной — 8–10 л)",
            "required": True,
        },
        {
            "name": "Маслостойкие нитриловые перчатки и приёмная ёмкость",
            "category": "safety",
            "spec": "Осторожно: горячая жидкость ATF (до 90 °C)",
            "required": True,
        },
    ],
    "brakes": [
        {
            "name": "Сканер с функцией активации насоса и клапанов ABS/ESP",
            "category": "tool",
            "spec": "Чтение скорости каждого колеса в реальном времени",
            "required": True,
        },
        {
            "name": "Устройство для вакуумной или нагнетательной прокачки тормозов",
            "category": "tool",
            "spec": "Давление прокачки до 1.5–2.0 бар",
            "required": True,
        },
        {
            "name": "Штангенциркуль, микрометр биения диска и тестер влажности ТЖ",
            "category": "tool",
            "spec": "Допустимая влажность тормозной жидкости < 1.5–2.0%",
            "required": True,
        },
        {
            "name": "Датчик АБС / тормозные шланги / ремкомплект суппорта",
            "category": "part",
            "spec": "По коду неисправного контура или колеса",
            "required": True,
        },
        {
            "name": "Тормозная жидкость DOT 4 Class 6 (LV) и очиститель тормозов",
            "category": "consumable",
            "spec": "1.0 л на полную замену",
            "required": True,
        },
        {
            "name": "Противооткатные упоры и страховочные подставки под кузов",
            "category": "safety",
            "spec": "Категорически запрещено работать только на домкрате",
            "required": True,
        },
    ],
    "electrical": [
        {
            "name": "Двухканальный осциллограф и мультиметр True RMS",
            "category": "tool",
            "spec": "Проверка дифференциального сигнала CAN-High (2.5–3.5 В) и CAN-Low (1.5–2.5 В)",
            "required": True,
        },
        {
            "name": "Диагностический сканер всех блоков топологии шины",
            "category": "tool",
            "spec": "Опрос всех ЭБУ: ECM, TCM, ABS, BCM, SRS",
            "required": True,
        },
        {
            "name": "Набор игольчатых щупов, паяльная станция и клещи для обжима пинов",
            "category": "tool",
            "spec": "Терминальное сопротивление шины CAN: 60 Ом (два резистора по 120 Ом)",
            "required": True,
        },
        {
            "name": "Ремонтный жгут проводки / разъём / блок или регулятор напряжения",
            "category": "part",
            "spec": "Проверка на отсутствие окисления пинов",
            "required": True,
        },
        {
            "name": "Термоусадочные трубки с клеевым слоем и очиститель контактов",
            "category": "consumable",
            "spec": "Герметизация соединений по стандарту IP67",
            "required": True,
        },
        {
            "name": "Ключ на 10 мм для снятия минусовой клеммы АКБ",
            "category": "safety",
            "spec": "При работах с SRS/Airbag выждать не менее 10 минут после отключения АКБ",
            "required": True,
        },
    ],
    "suspension": [
        {
            "name": "Диагностический сканер с функцией калибровки датчиков уровня кузова",
            "category": "tool",
            "spec": "Контроль давления ресивера пневмосистемы (до 15–17 бар)",
            "required": True,
        },
        {
            "name": "Детектор утечек воздуха / манометр пневмомагистралей",
            "category": "tool",
            "spec": "Проверка фитингов, блока клапанов и пневмобаллонов",
            "required": True,
        },
        {
            "name": "Ремкомплект компрессора пневмоподвески / датчик высоты / стойка",
            "category": "part",
            "spec": "С силикагелем осушителя и уплотнительными кольцами",
            "required": True,
        },
        {
            "name": "Мыльный пенный индикатор утечек и силиконовая смазка",
            "category": "consumable",
            "spec": "Для безопасного поиска микротрещин пневморукава",
            "required": False,
        },
        {
            "name": "Подъёмник или страховочные опоры (режим Домкрат активирован)",
            "category": "safety",
            "spec": "Обязательно перевести пневмоподвеску в сервисный режим перед подъёмом",
            "required": True,
        },
    ],
    "battery": [
        {
            "name": "Мегаомметр (тестер сопротивления изоляции 500 В) и сканер BMS",
            "category": "tool",
            "spec": "Норма сопротивления изоляции ВВБ: > 50–100 МОм",
            "required": True,
        },
        {
            "name": "Изолированный инструмент до 1000 В (стандарт IEC 60900)",
            "category": "tool",
            "spec": "Контроль разбаланса ячеек (< 0.03–0.05 В)",
            "required": True,
        },
        {
            "name": "Модуль/ячейка ВВБ, контактор или насос охлаждения инвертора",
            "category": "part",
            "spec": "Подбор по внутреннему сопротивлению (IR)",
            "required": True,
        },
        {
            "name": "Диэлектрические перчатки класса 0 (до 1000 В) и защитный щиток",
            "category": "safety",
            "spec": "Обязательно извлечь сервисную чеку (Service Plug) и выждать 10 минут",
            "required": True,
        },
    ],
}


class AirLLMVulkanOrchestrator:
    """
    Сервис управления локальными моделями (AirLLM послойная выгрузка + Vulkan GGUF),
    RAG-поиском и исполнением инструментов Function Calling.
    """

    def __init__(self):
        self.vulkan_status = init_vulkan_environment(verbose=False)
        self.rag_engine = VehicleExpertEngine()
        self._airllm_instance = None
        self._airllm_loaded_model_id: Optional[str] = None
        self._llamacpp_instance = None
        self._http_client = httpx.Client(trust_env=False, timeout=25.0)

    def get_hardware_and_model_telemetry(self, settings_obj) -> Dict[str, Any]:
        """Возвращает живую телеметрию по Vulkan, видеопамяти (8 ГБ), AirLLM и базе знаний."""
        vk = get_vulkan_status()
        gguf_path = BASE_DIR / settings_obj.gguf_model_rel_path
        gguf_exists = gguf_path.exists()
        gguf_size_gb = round(gguf_path.stat().st_size / (1024**3), 2) if gguf_exists else 0.0

        airllm_installed = False
        try:
            import airllm  # type: ignore  # noqa: F401

            airllm_installed = True
        except Exception:
            pass

        return {
            "vulkan": vk.to_dict(),
            "airllm": {
                "installed": airllm_installed,
                "active_model_id": settings_obj.airllm_model_id,
                "compression": settings_obj.airllm_compression,
                "shards_dir": str((BASE_DIR / "models" / "airllm_shards").relative_to(BASE_DIR)),
                "layer_wise_mode": True,
                "vram_budget_gb": 8,
            },
            "gguf": {
                "rel_path": settings_obj.gguf_model_rel_path,
                "exists": gguf_exists,
                "size_gb": gguf_size_gb,
                "gpu_layers": settings_obj.vulkan_gpu_layers,
            },
            "rag": {
                "total_documents": len(self.rag_engine.raw_data),
                "total_dtc_codes": len(self.rag_engine.dtc_catalog),
                "telemetry_profiles": len(self.rag_engine.telemetry_catalog),
            },
            "context_window": settings_obj.context_window_tokens,
            "backend_selected": settings_obj.llm_backend,
        }

    # =========================================================================
    # Выполнение инструментов Function Calling
    # =========================================================================
    def execute_function_calls(
        self,
        query: str,
        attached_codes: List[str],
        image_analyses: List[Dict[str, Any]],
        doc_analyses: List[Dict[str, Any]],
    ) -> Tuple[List[ToolCallExecution], List[Dict[str, Any]], Dict[str, Dict[str, Any]]]:
        """
        Автоматически вызывает релевантные диагностические функции (Function Calling)
        и собирает их структурированные результаты.
        """
        executed_calls: List[ToolCallExecution] = []
        dtc_cards: Dict[str, Dict[str, Any]] = {}

        # Собираем все коды ошибок из текста, словаря и прикрепленных документов
        all_codes = list(attached_codes)
        for c in self.rag_engine._extract_dtc_codes_from_text(query):
            if c not in all_codes:
                all_codes.append(c)
        for doc in doc_analyses:
            for c in doc.get("detected_dtc_codes", []):
                if c not in all_codes:
                    all_codes.append(c)

        # 1. Инструмент lookup_dtc_code для каждого кода ошибки
        for code in all_codes:
            details = self.rag_engine.get_dtc_details(code)
            if details:
                dtc_cards[code] = details
                sym_str = "; ".join(details.get("symptoms", [])[:2])
                sol_str = "; ".join(details.get("solutions", [])[:2])
                executed_calls.append(
                    ToolCallExecution(
                        tool_name="lookup_dtc_code",
                        arguments={"code": code},
                        result_summary=(
                            f"Код {code} ({details['system_ru']}): Симптом — {sym_str}. "
                            f"Решение — {sol_str}. Индекс здоровья: {details['health_index']}%."
                        ),
                        status="success",
                    )
                )
            else:
                executed_calls.append(
                    ToolCallExecution(
                        tool_name="lookup_dtc_code",
                        arguments={"code": code},
                        result_summary=f"Код {code}: точной карточки в локальном словаре нет, применён семантический поиск по семейству OBD-II.",
                        status="warning",
                    )
                )

        # 2. Инструмент search_knowledge_base (гибридный RAG)
        search_q = query.strip() or (" ".join(all_codes) if all_codes else "диагностика неисправности автомобиля")
        rag_hits = self.rag_engine.diagnose(search_q, top_n=4, dtc_codes=all_codes)
        if rag_hits:
            top_hit = rag_hits[0]
            top_code = top_hit["meta"].get("code", "")
            if top_code and top_code not in dtc_cards:
                card = self.rag_engine.get_dtc_details(top_code)
                if card:
                    dtc_cards[top_code] = card

            executed_calls.append(
                ToolCallExecution(
                    tool_name="search_knowledge_base",
                    arguments={"symptom_query": search_q, "top_n": 4},
                    result_summary=(
                        f"Найдено {len(rag_hits)} релевантных тех. регламентов. "
                        f"Лучшее совпадение: [{top_hit['meta'].get('code', 'N/A')}] "
                        f"({top_hit['meta'].get('system_ru', 'Система')}, score={top_hit['score']:.2f})."
                    ),
                    status="success",
                )
            )

        # 3. Инструмент inspect_attached_image при наличии фотографий или кадров с камеры/AR-очков
        for img_info in image_analyses:
            clues = "; ".join(img_info.get("visual_clues", []))
            executed_calls.append(
                ToolCallExecution(
                    tool_name="inspect_attached_image",
                    arguments={
                        "filename": img_info.get("filename", "photo.jpg"),
                        "resolution": f"{img_info.get('width', 0)}x{img_info.get('height', 0)}",
                    },
                    result_summary=f"Визуальная инспекция кадра: {clues}",
                    status="success",
                )
            )

        # 4. Инструмент build_repair_inventory
        primary_system = "engine"
        if rag_hits:
            primary_system = rag_hits[0]["meta"].get("system", "engine")
        elif dtc_cards:
            first_card = next(iter(dtc_cards.values()))
            primary_system = first_card.get("system", "engine")

        executed_calls.append(
            ToolCallExecution(
                tool_name="build_repair_inventory",
                arguments={"system": primary_system, "codes": list(dtc_cards.keys())[:4]},
                result_summary=(
                    f"Сформирован специфицированный набор инструментов, запчастей и моментов затяжки "
                    f"для узла «{SYSTEM_DISPLAY_NAMES.get(primary_system, primary_system)}»."
                ),
                status="success",
            )
        )

        return executed_calls, rag_hits, dtc_cards

    # =========================================================================
    # Построение эталонного структурированного ответа по данным RAG + Function Calling
    # =========================================================================
    def _build_expert_baseline_response(
        self,
        query: str,
        rag_hits: List[Dict[str, Any]],
        dtc_cards: Dict[str, Dict[str, Any]],
        tool_calls: List[ToolCallExecution],
        image_analyses: List[Dict[str, Any]],
        doc_analyses: List[Dict[str, Any]],
        dialog_summary: str,
        global_summary: str,
    ) -> DiagnosticStructuredResponse:
        """
        Создаёт полный, технически выверенный структурированный ответ `DiagnosticStructuredResponse`
        на основе найденных в БД документов, карточек ошибок, телеметрии и вложений.
        Используется как строгий каркас и гарантированный резерв при работе в условиях 8 ГБ VRAM.
        """
        q_lower = query.lower()
        is_followup = any(
            phrase in q_lower
            for phrase in (
                "как открутить",
                "почему это",
                "ты помнишь",
                "а если",
                "что дальше",
                "подскажи подробнее",
                "какой момент",
                "можно ли ехать",
            )
        ) and bool(dialog_summary)

        response_type = (
            "visual_inspection"
            if image_analyses and not dtc_cards
            else ("followup" if is_followup else "diagnosis")
        )

        # 1. Формируем список установленных неисправностей (faults)
        faults: List[DetectedFault] = []
        seen_codes = set()

        for code, card in dtc_cards.items():
            seen_codes.add(code)
            health = float(card.get("health_index", 75.0))
            severity = "critical" if health < 65 or code.startswith(("C", "U")) else "warning"
            sym = card["symptoms"][0] if card.get("symptoms") else "Отклонение рабочих параметров узла"
            sol = card["solutions"][0] if card.get("solutions") else "Требуется инструментальная проверка"
            faults.append(
                DetectedFault(
                    code=code,
                    system=card["system"],
                    system_ru=card["system_ru"],
                    title=f"{sym} ({card['system_ru']})",
                    severity=severity,
                    confidence=94,
                    health_index=health,
                    root_cause=f"Вероятная причина по базе знаний: {sym}. Рекомендованный регламент: {sol}.",
                )
            )

        for hit in rag_hits[:3]:
            meta = hit["meta"]
            code = meta.get("code", "N/A")
            if code in seen_codes or len(faults) >= 3:
                continue
            seen_codes.add(code)
            sym, sol = self.rag_engine._extract_symptom_and_solution(hit["text"])
            health = float(meta.get("health_index", 78.0))
            severity = "critical" if health < 65 else "warning"
            faults.append(
                DetectedFault(
                    code=code,
                    system=meta.get("system", "engine"),
                    system_ru=meta.get("system_ru", "Двигатель"),
                    title=sym[:110],
                    severity=severity,
                    confidence=max(75, min(96, int(hit["score"] * 22))),
                    health_index=health,
                    root_cause=sol or hit["text"],
                )
            )

        primary_system = faults[0].system if faults else "engine"
        primary_system_ru = SYSTEM_DISPLAY_NAMES.get(primary_system, "Двигатель (ДВС)")
        primary_code = faults[0].code if faults else "OBD-DIAG"

        # 2. Формируем блок инвентаря с чекбоксами
        raw_inv = SYSTEM_INVENTORY_TEMPLATES.get(primary_system, SYSTEM_INVENTORY_TEMPLATES["engine"])
        inventory: List[InventoryItem] = []
        for idx, item in enumerate(raw_inv, start=1):
            inventory.append(
                InventoryItem(
                    id=f"inv_{primary_system}_{idx}",
                    name=item["name"],
                    category=item["category"],
                    spec=item["spec"],
                    required=item["required"],
                    checked=False,
                )
            )

        # 3. Формируем пошаговый чеклист ремонта (repair_steps)
        repair_steps: List[RepairTaskStep] = []

        # Шаг 1: Безопасность и подготовка
        repair_steps.append(
            RepairTaskStep(
                step_number=1,
                title="Подготовка рабочего места и фиксация исходных параметров",
                instruction=(
                    f"Зафиксируйте автомобиль на ровной площадке, установите противооткатные упоры. "
                    f"Подключите сканер OBD-II, сохраните стоп-кадр (Freeze Frame) ошибки {primary_code} "
                    f"по узлу «{primary_system_ru}». Перед разборкой электрических разъёмов отсоедините минусовую клемму АКБ."
                ),
                torque_or_spec="Напряжение АКБ в покое: 12.5–12.8 В",
                safety_warning="Не проводите работы на горячем агрегате и без надёжной фиксации кузова.",
                verification_hint="Коды ошибок и стоп-кадр сохранены в лог, зажигание выключено.",
                estimated_minutes=10,
                completed=False,
            )
        )

        # Шаги из найденных решений базы знаний
        step_idx = 2
        collected_actions: List[str] = []
        for f_obj in faults:
            card = self.rag_engine.get_dtc_details(f_obj.code)
            if card:
                for sol in card.get("solutions", []):
                    for sub_act in re.split(r"[,;.]", sol):
                        clean_act = sub_act.strip()
                        if len(clean_act) > 4 and clean_act.lower() not in [a.lower() for a in collected_actions]:
                            collected_actions.append(clean_act)

        if not collected_actions and rag_hits:
            _, sol = self.rag_engine._extract_symptom_and_solution(rag_hits[0]["text"])
            for sub_act in re.split(r"[,;.]", sol):
                if sub_act.strip():
                    collected_actions.append(sub_act.strip())

        for act in collected_actions[:4]:
            act_cap = act[0].upper() + act[1:] if act else "Инструментальная проверка узла"
            spec_str = "Сверка с заводским допуском OEM"
            if "свеч" in act.lower() or "катушк" in act.lower():
                spec_str = "Зазор свечи: 0.8–1.1 мм | Момент затяжки: 22–25 Н·м"
            elif "компресс" in act.lower():
                spec_str = "Номинальная компрессия: 11.5–14.0 бар (разброс по цилиндрам ≤ 1.0 бар)"
            elif "тормоз" in act.lower() or "прокачк" in act.lower() or "шланг" in act.lower():
                spec_str = "Давление в контуре: 500–1100 psi | Остаток колодок ≥ 4.0 мм"
            elif "соленоид" in act.lower() or "гидроблок" in act.lower() or "масл" in act.lower():
                spec_str = "Температура проверки ATF: 40 °C | Время переключения: 0.12–0.18 с"
            elif "проводк" in act.lower() or "can" in act.lower() or "датчик" in act.lower():
                spec_str = "Сопротивление линии: < 0.5 Ом | Отсутствие КЗ на массу и +12 В"

            repair_steps.append(
                RepairTaskStep(
                    step_number=step_idx,
                    title=act_cap,
                    instruction=(
                        f"Выполните операцию: «{act_cap}» для устранения первопричины кода {primary_code}. "
                        f"Осмотрите разъёмы, уплотнения и сопряжённые элементы на отсутствие механического износа, "
                        f"нагара, следов перегрева или подсоса/утечки рабочей среды."
                    ),
                    torque_or_spec=spec_str,
                    safety_warning="Используйте динамометрический инструмент и избегайте попадания грязи в открытые полости.",
                    verification_hint=f"Операция «{act_cap}» завершена, показатели в пределах нормы.",
                    estimated_minutes=20,
                    completed=False,
                )
            )
            step_idx += 1

        # Финальный шаг: Сброс адаптаций и контрольный тест-драйв
        repair_steps.append(
            RepairTaskStep(
                step_number=step_idx,
                title="Сброс кодов DTC, адаптация и контрольное тестирование",
                instruction=(
                    f"Подключите клемму АКБ, выполните сброс кодов ошибок ({', '.join(seen_codes)}) через сканер. "
                    f"Запустите двигатель, прогрейте до рабочей температуры и проверьте параметры в режиме Live Data "
                    f"(отсутствие повторной регистрации {primary_code} в блоке «{primary_system_ru}»)."
                ),
                torque_or_spec="Код ошибки в статусе Pending/Confirmed: Отсутствует",
                safety_warning="Первые торможения и переключения на тест-драйве выполняйте на малой скорости.",
                verification_hint="Индикатор неисправности погас, телеметрия в зелёной зоне.",
                estimated_minutes=15,
                completed=False,
            )
        )

        # 4. Телеметрические заметки из VehicleDiagnosticSample.txt
        telemetry_notes: List[str] = []
        for code in seen_codes:
            t_info = self.rag_engine.telemetry_catalog.get(code)
            if t_info:
                meas = ", ".join(f"{k}: {v}" for k, v in t_info.get("sample_measurements", {}).items())
                params = ", ".join(f"{k}: {v}" for k, v in t_info.get("sample_parameters", {}).items())
                telemetry_notes.append(
                    f"Эталонный профиль телеметрии [{code} | {t_info.get('system_ru')}]: "
                    f"Измерения ({meas}) | Параметры ({params}) | Средний Health Index: {t_info.get('avg_health_index')}%."
                )

        for doc in doc_analyses:
            if doc.get("key_metrics"):
                telemetry_notes.append(
                    f"Из прикреплённого файла «{doc['filename']}» извлечены метрики: {', '.join(doc['key_metrics'][:6])}."
                )

        if image_analyses:
            for img in image_analyses:
                telemetry_notes.append(
                    f"Фотоанализ ({img.get('filename')}): {'; '.join(img.get('visual_clues', []))}."
                )

        if not telemetry_notes:
            telemetry_notes.append(
                f"Рекомендуется проконтролировать параметры узла «{primary_system_ru}» в динамике под нагрузкой."
            )

        # 5. Рекомендации и текстовый вердикт наставника
        recommendations = [
            f"Обязательно проверьте состояние разъёмов и жгута проводки узла «{primary_system_ru}» перед заменой дорогостоящих агрегатов.",
            "Используйте только профильные расходные материалы и соблюдайте моменты затяжки резьбовых соединений.",
            "После завершения ремонта сохраните лог контрольной поездки для сравнения динамики Health Index.",
        ]

        fault_summary_lines = [
            f"• **{f.code}** ({f.system_ru}): {f.title} — *Индекс здоровья: {f.health_index}%*"
            for f in faults
        ]
        memory_note = ""
        if dialog_summary:
            memory_note = f"\n\nУчтён контекст текущей беседы: *{dialog_summary.splitlines()[0]}*"
        elif global_summary:
            memory_note = f"\n\nУчтена история из междиалоговой памяти автомобиля."

        mentor_reply = (
            f"Проведён комплексный анализ вашего запроса по системе **«{primary_system_ru}»** "
            f"с использованием локальной базы знаний и эталонной телеметрии.\n\n"
            f"**Установленные неисправности:**\n"
            + ("\n".join(fault_summary_lines) if fault_summary_lines else "• Требуется инструментальная локализация узла.")
            + f"\n\nНиже подготовлен **интерактивный список необходимого инвентаря** и **пошаговый чеклист ремонта** "
            f"с контрольными допусками. Отмечайте галочками подготовленные инструменты и выполненные этапы работ прямо в карточке ответа."
            + memory_note
        )

        summary_title = (
            f"Диагностика {primary_code}: {faults[0].title}"
            if faults
            else f"Экспертное заключение: {primary_system_ru}"
        )

        return DiagnosticStructuredResponse(
            response_type=response_type,
            summary_title=summary_title[:120],
            mentor_reply=mentor_reply,
            faults=faults,
            inventory=inventory,
            repair_steps=repair_steps,
            telemetry_notes=telemetry_notes,
            recommendations=recommendations,
            follow_up_question="Какой шаг чеклиста вы выполняете сейчас? Нужна ли схема прозвонки или подсказка по демонтажу?",
            tool_calls=tool_calls,
        )

    # =========================================================================
    # Попытка вызова AirLLM (послойная выгрузка на 8 ГБ VRAM) или Vulkan llama.cpp
    # =========================================================================
    def _try_airllm_generation(
        self,
        prompt: str,
        settings_obj,
    ) -> Optional[str]:
        """
        Выполняет генерацию через библиотеку AirLLM (https://github.com/lyogavin/airllm)
        с послойной подгрузкой весов, если веса модели скачаны локально или разрешена автозагрузка.
        """
        if os.environ.get("AIRLLM_LIVE_INFERENCE", "0") != "1":
            # По умолчанию не блокируем веб-поток многогигабайтным скачиванием с HuggingFace,
            # если пользователь явно не включил AIRLLM_LIVE_INFERENCE=1 или локальные шарды еще не подготовлены.
            shards_dir = BASE_DIR / "models" / "airllm_shards"
            if not shards_dir.exists() or not any(shards_dir.iterdir()):
                return None

        try:
            from airllm import AutoModel as AirLLMAutoModel  # type: ignore

            model_id = settings_obj.airllm_model_id
            compression = settings_obj.airllm_compression
            if compression == "none":
                compression = None

            shards_path = BASE_DIR / "models" / "airllm_shards"
            shards_path.mkdir(parents=True, exist_ok=True)

            if self._airllm_instance is None or self._airllm_loaded_model_id != model_id:
                logger.info(f"[AirLLM] Инициализация послойной модели {model_id} (compression={compression})...")
                self._airllm_instance = AirLLMAutoModel.from_pretrained(
                    model_id,
                    compression=compression,
                    prefetching=True,
                    layer_shards_saving_path=str(shards_path),
                    max_seq_len=settings_obj.context_window_tokens,
                )
                self._airllm_loaded_model_id = model_id

            input_tokens = self._airllm_instance.tokenizer(
                [prompt],
                return_tensors="pt",
                return_attention_mask=False,
                truncation=True,
                max_length=settings_obj.context_window_tokens - 512,
                padding=False,
            )
            generation_output = self._airllm_instance.generate(
                input_tokens["input_ids"],
                max_new_tokens=600,
                use_cache=True,
                return_dict_in_generate=True,
            )
            output_text = self._airllm_instance.tokenizer.decode(
                generation_output.sequences[0],
                skip_special_tokens=True,
            )
            return output_text
        except Exception as exc:
            logger.warning(f"[AirLLM] Пропуск live-вызова AirLLM ({exc}), используется гибридный конвейер.")
            return None

    def _try_vulkan_llama_server(
        self,
        messages: List[Dict[str, Any]],
        settings_obj,
    ) -> Optional[str]:
        """
        Отправляет запрос в локальный Vulkan сервер llama.cpp со строгой JSON-схемой
        (`response_format` с JSON Schema / GBNF-грамматикой).
        """
        try:
            client = OpenAI(
                base_url=settings_obj.llama_server_url,
                api_key="not-needed",
                http_client=self._http_client,
            )
            response = client.chat.completions.create(
                model="local",
                messages=messages,
                max_tokens=1400,
                temperature=0.15,
                response_format={
                    "type": "json_object",
                    "schema": DIAGNOSTIC_JSON_SCHEMA,
                },
                extra_body={"chat_template_kwargs": {"enable_thinking": False}},
            )
            return response.choices[0].message.content
        except Exception:
            return None

    def diagnose_and_respond(
        self,
        query: str,
        session,
        settings_obj,
        recent_messages: List[Any],
        attached_codes: List[str],
        image_analyses: List[Dict[str, Any]],
        doc_analyses: List[Dict[str, Any]],
        voice_info: Optional[Dict[str, Any]] = None,
    ) -> DiagnosticStructuredResponse:
        """
        Полный цикл обработки запроса пользователя:
        1. Выполняет Function Calling (инструменты поиска по словарю DTC, базе знаний, телеметрии, фото).
        2. Собирает компактный контекст с учетом фоновой выжимки текущего диалога (`session.summary`)
           и междиалоговой памяти (`settings_obj.global_memory_summary`).
        3. Генерирует ответ через выбранный бэкенд (AirLLM / Vulkan Llama.cpp / Экспертный синтезатор)
           и приводит его к строгому валидированному виду `DiagnosticStructuredResponse`.
        """
        tool_calls, rag_hits, dtc_cards = self.execute_function_calls(
            query=query,
            attached_codes=attached_codes,
            image_analyses=image_analyses,
            doc_analyses=doc_analyses,
        )

        extra_docs_blocks: List[str] = []
        for doc in doc_analyses:
            extra_docs_blocks.append(f"Файл {doc['filename']}:\n{doc['text_snippet']}")
        extra_docs_text = "\n\n".join(extra_docs_blocks) if extra_docs_blocks else None

        global_summary = (
            settings_obj.global_memory_summary
            if settings_obj.cross_dialog_memory_enabled
            else None
        )

        # Формируем эталонный структурированный ответ на базе RAG и вызванных инструментов
        baseline_structured = self._build_expert_baseline_response(
            query=query,
            rag_hits=rag_hits,
            dtc_cards=dtc_cards,
            tool_calls=tool_calls,
            image_analyses=image_analyses,
            doc_analyses=doc_analyses,
            dialog_summary=session.summary,
            global_summary=global_summary or "",
        )

        # Подготавливаем промпт для LLM со строгой инструкцией возврата JSON по схеме
        rag_context_prompt = self.rag_engine.prepare_llm_context(
            query=query,
            top_n=3,
            dtc_codes=attached_codes,
            extra_docs_text=extra_docs_text,
            dialog_summary=session.summary,
            global_summary=global_summary,
        )

        system_prompt = (
            "Ты — ведущий инженер-диагност и наставник автосервиса. "
            "Отвечай СТРОГО в формате валидного JSON, соответствующего схеме DiagnosticStructuredResponse. "
            "Все текстовые поля должны быть на русском языке. "
            "Обязательно заполняй массивы faults, inventory (с чекбоксами инструментов/запчастей) "
            "и repair_steps (пошаговый чеклист ремонта с моментами затяжки и техникой безопасности)."
        )

        llm_messages: List[Dict[str, Any]] = [{"role": "system", "content": system_prompt}]

        # Включаем только последние 4 сообщения диалога (так как остальная история сжата в session.summary фоновым воркером!)
        for msg in recent_messages[-4:]:
            if msg.role in ("user", "assistant"):
                llm_messages.append({"role": msg.role, "content": (msg.content or "")[:600]})

        user_content: List[Dict[str, Any]] = [{"type": "text", "text": rag_context_prompt}]
        for img in image_analyses:
            if img.get("data_url"):
                user_content.append({"type": "image_url", "image_url": {"url": img["data_url"]}})
        if voice_info and voice_info.get("audio_payload"):
            user_content.append(voice_info["audio_payload"])

        llm_messages.append({"role": "user", "content": user_content})

        raw_llm_output: Optional[str] = None
        if settings_obj.llm_backend == "airllm_vulkan":
            raw_llm_output = self._try_airllm_generation(rag_context_prompt, settings_obj)
            if not raw_llm_output:
                raw_llm_output = self._try_vulkan_llama_server(llm_messages, settings_obj)
        elif settings_obj.llm_backend == "llamacpp_vulkan":
            raw_llm_output = self._try_vulkan_llama_server(llm_messages, settings_obj)
        else:
            raw_llm_output = self._try_vulkan_llama_server(llm_messages, settings_obj)
            if not raw_llm_output:
                raw_llm_output = self._try_airllm_generation(rag_context_prompt, settings_obj)

        if raw_llm_output:
            validated = validate_and_coerce_structured_json(
                raw_output=raw_llm_output,
                fallback_response=baseline_structured,
            )
            if not validated.tool_calls:
                validated.tool_calls = tool_calls
            return validated

        return baseline_structured


# Глобальный экземпляр оркестратора ИИ
orchestrator = AirLLMVulkanOrchestrator()
