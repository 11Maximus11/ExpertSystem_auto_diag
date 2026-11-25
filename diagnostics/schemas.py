"""
Строгие JSON-схемы ответов экспертной системы ИИдеал Авто (AIdeal Auto) (Pydantic v2 + JSON Schema),
реестр инструментов для Function Calling и механизм автообрезки ответа модели по последнему предложению.
"""

import json
import re
from typing import Any, Dict, List, Literal, Optional
import jsonschema
from pydantic import BaseModel, Field


DANGLING_WORDS_RU = {
    "и", "а", "но", "да", "или", "либо", "в", "во", "на", "по", "с", "со", "к", "ко",
    "от", "до", "из", "за", "при", "для", "без", "над", "под", "через", "после",
    "что", "чтобы", "как", "если", "когда", "также", "например", "особенно",
}


def truncate_to_last_sentence(text: str) -> str:
    """
    Автоматически обрезает ответ модели по последнему завершенному предложению,
    чтобы ответы никогда не выглядели оборванными на полуслове.
    """
    cleaned = (text or "").strip()
    if not cleaned:
        return ""

    # Если строка уже заканчивается на знак конца предложения (с возможной закрывающей кавычкой/скобкой)
    if re.search(r"[.!?…][\"'»)\]]*\s*$", cleaned):
        return cleaned

    # Ищем последнюю границу завершенного предложения (не внутри десятичной дроби вида 12.6)
    last_end = -1
    for m in re.finditer(r"(?<![0-9])([.!?…][\"'»)\]]*)(?=\s|$)", cleaned):
        last_end = m.end()

    if last_end != -1 and last_end >= min(25, len(cleaned) // 3):
        return cleaned[:last_end].strip()

    # Если в коротком ответе еще не было ни одной точки, убираем оборванное последнее слово/предлог и ставим точку
    cleaned = re.sub(r"[,:;—–\-]+\s*$", "", cleaned).strip()
    words = cleaned.split()
    if len(words) > 3:
        # Если ответ оборвался ровно на длинном незаконченном слове или висячем союзе/предлоге
        while len(words) > 2 and words[-1].lower().strip(".,:;—–-") in DANGLING_WORDS_RU:
            words.pop()
        cleaned = " ".join(words).rstrip(",:;—–-")

    if cleaned and not re.search(r"[.!?…][\"'»)\]]*$", cleaned):
        cleaned += "."
    return cleaned


class ToolCallExecution(BaseModel):
    """Запись о выполненном вызове инструмента (Function Calling)."""

    tool_name: str = Field(..., description="Имя вызванной функции-инструмента")
    arguments: Dict[str, Any] = Field(default_factory=dict, description="Аргументы вызова функции")
    result_summary: str = Field(..., description="Краткий результат выполнения инструмента")
    status: Literal["success", "warning", "error"] = Field(default="success")


class DetectedFault(BaseModel):
    """Обнаруженная неисправность автомобиля."""

    code: str = Field(..., description="Код ошибки OBD-II / DTC (например, P0300, C0050, U1900)")
    system: str = Field(..., description="Идентификатор системы (engine, transmission, brakes, electrical и др.)")
    system_ru: str = Field(..., description="Название системы на русском языке")
    title: str = Field(..., description="Чёткая формулировка установленной неисправности")
    severity: Literal["critical", "warning", "normal"] = Field(
        default="warning",
        description="Уровень критичности поломки",
    )
    confidence: int = Field(default=90, ge=0, le=100, description="Уверенность диагностики в %")
    health_index: float = Field(default=72.0, ge=0.0, le=100.0, description="Индекс здоровья узла (0-100%)")
    root_cause: str = Field(..., description="Вероятная первопричина неисправности")


class InventoryItem(BaseModel):
    """Элемент блока инвентаря (инструмент, запчасть, расходник) с чекбоксом."""

    id: str = Field(..., description="Уникальный идентификатор позиции инвентаря (например, inv_1)")
    name: str = Field(..., description="Наименование инструмента, детали или расходника")
    category: Literal["tool", "part", "consumable", "safety"] = Field(
        default="tool",
        description="Категория: инструмент, запчасть, расходник или защита",
    )
    spec: str = Field(default="", description="Характеристики, артикул, головка или допуск")
    required: bool = Field(default=True, description="Обязателен ли для выполнения ремонта")
    checked: bool = Field(default=False, description="Отметка пользователя о наличии")


class RepairTaskStep(BaseModel):
    """Пошаговая задача ремонта с чекбоксом выполнения и контрольными параметрами."""

    step_number: int = Field(..., ge=1, description="Порядковый номер шага")
    title: str = Field(..., description="Краткое название этапа работ")
    instruction: str = Field(..., description="Конкретная и понятная инструкция по действию")
    torque_or_spec: str = Field(
        default="",
        description="Эталонный параметр: момент затяжки (Н·м), сопротивление (Ом), давление или напряжение",
    )
    safety_warning: str = Field(
        default="",
        description="Важное техническое примечание (только по делу, без банальностей)",
    )
    verification_hint: str = Field(
        default="",
        description="Как убедиться, что шаг выполнен правильно",
    )
    estimated_minutes: int = Field(default=10, ge=1, description="Оценка времени выполнения в минутах")
    completed: bool = Field(default=False, description="Чекбокс: выполнен ли шаг пользователем")


class DiagnosticStructuredResponse(BaseModel):
    """
    Строгая JSON-схема полного ответа экспертной системы автодиагностики ИИдеал Авто (AIdeal Auto).
    """

    response_type: Literal["diagnosis", "followup", "visual_inspection", "general"] = Field(
        default="diagnosis",
        description="Тип ответа: первичная диагностика, уточняющий вопрос, осмотр по фото или общая консультация",
    )
    summary_title: str = Field(..., description="Краткий заголовок вердикта экспертной системы")
    mentor_reply: str = Field(
        ...,
        description="Понятный, краткий и точный ответ автодиагноста на русском языке",
    )
    faults: List[DetectedFault] = Field(
        default_factory=list,
        description="Список установленных неисправностей с кодами ошибок",
    )
    inventory: List[InventoryItem] = Field(
        default_factory=list,
        description="Блок необходимого инвентаря: инструменты, запчасти и расходники с чекбоксами",
    )
    repair_steps: List[RepairTaskStep] = Field(
        default_factory=list,
        description="Поэтапный чеклист исправления ошибки с чекбоксами задач",
    )
    telemetry_notes: List[str] = Field(
        default_factory=list,
        description="Сверка показателей с эталонной телеметрией базы данных",
    )
    recommendations: List[str] = Field(
        default_factory=list,
        description="Краткие рекомендации по дальнейшей эксплуатации",
    )
    follow_up_question: str = Field(
        default="Подсказать подробнее по какому-то из шагов проверки?",
        description="Вопрос в конце ответа для продолжения диалога",
    )
    tool_calls: List[ToolCallExecution] = Field(
        default_factory=list,
        description="Список инструментов Function Calling, использованных при формировании ответа",
    )
    vehicle_detected: str = Field(
        default="",
        description="Марка, модель, год выпуска или двигатель автомобиля, выявленные из диалога",
    )


DIAGNOSTIC_JSON_SCHEMA: Dict[str, Any] = DiagnosticStructuredResponse.model_json_schema()


DIAGNOSTIC_TOOLS_OPENAI_FORMAT: List[Dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "lookup_dtc_code",
            "description": "Получить расшифровку кода ошибки OBD-II (P/C/B/U), симптомы, методы ремонта и эталонную телеметрию из базы знаний.",
            "parameters": {
                "type": "object",
                "properties": {
                    "code": {
                        "type": "string",
                        "description": "Код ошибки, например P0300, P0796, C0050, U1900, P0A80",
                    }
                },
                "required": ["code"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_knowledge_base",
            "description": "Выполнить гибридный RAG-поиск (BERT + FAISS + BM25 + CrossEncoder) по симптомам неисправности автомобиля.",
            "parameters": {
                "type": "object",
                "properties": {
                    "symptom_query": {
                        "type": "string",
                        "description": "Описание симптома или проблемы (например, 'пинки АКПП при переключении')",
                    },
                    "system": {
                        "type": "string",
                        "enum": [
                            "all", "engine", "cooling", "transmission", "brakes",
                            "electrical", "suspension", "chassis", "hybrid", "battery",
                        ],
                        "description": "Фильтр по автомобильной системе",
                    },
                },
                "required": ["symptom_query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "build_repair_inventory",
            "description": "Сформировать список инструментов, запчастей, расходников и моментов затяжки для указанной системы и кодов ошибок.",
            "parameters": {
                "type": "object",
                "properties": {
                    "system": {
                        "type": "string",
                        "description": "Система автомобиля (engine, cooling, transmission, brakes, electrical, suspension, chassis, hybrid, battery)",
                    },
                    "codes": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Список кодов ошибок",
                    },
                },
                "required": ["system"],
            },
        },
    },
]


def _strip_reasoning_tokens(text: str) -> str:
    """Удаляет скрытые теги рассуждений Gemma / Thinking перед парсингом текста и JSON."""
    cleaned = re.sub(r"<\|channel>thought.*?<channel\|>", "", text or "", flags=re.DOTALL)
    cleaned = re.sub(r"<think>.*?</think>", "", cleaned, flags=re.DOTALL)
    return cleaned.strip()


def extract_prose_and_json_block(raw_output: str) -> tuple[str, Optional[str]]:
    """
    Разделяет гибридный ответ модели на текстовый комментарий диагноста (`prose`)
    и сырой JSON-блок метаданных (включая незакрытый ```json при обрыве по SLA).
    """
    cleaned = _strip_reasoning_tokens(raw_output)
    if not cleaned:
        return "", None

    fence_match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", cleaned, flags=re.DOTALL)
    if fence_match:
        prose_before = cleaned[: fence_match.start()].strip()
        prose_after = cleaned[fence_match.end() :].strip()
        prose = (f"{prose_before}\n\n{prose_after}".strip() if prose_before and prose_after else (prose_before or prose_after))
        return prose, fence_match.group(1)

    # Незакрытый fenced-блок ```json\n{... (если сработал лимит токенов/SLA в самом конце)
    open_fence = re.search(r"```(?:json)?\s*(\{[\s\S]*)$", cleaned)
    if open_fence:
        prose_before = cleaned[: open_fence.start()].strip()
        return prose_before, open_fence.group(1).strip()

    brace_start = cleaned.find("{")
    if brace_start != -1:
        prose_before = cleaned[:brace_start].strip()
        brace_end = cleaned.rfind("}")
        if brace_end > brace_start:
            candidate = cleaned[brace_start : brace_end + 1]
            try:
                json.loads(re.sub(r",\s*([}\]])", r"\1", candidate))
                return prose_before, candidate
            except Exception:
                pass
        return prose_before, cleaned[brace_start:].strip()

    return cleaned, None


def _repair_truncated_json(raw_json: str) -> Optional[Dict[str, Any]]:
    """
    Восстанавливает усечённый JSON-объект LLM (например, при срабатывании 60-секундного SLA):
    откатывается до последней завершённой пары/элемента вне строк и корректно закрывает
    открытые `[` и `{`, сохраняя все успевшие сгенерироваться поля модели.
    """
    s = (raw_json or "").strip()
    if not s.startswith("{"):
        return None

    # 1. Прямая попытка с удалением висячих запятых
    cleaned_full = re.sub(r",\s*([}\]])", r"\1", s)
    try:
        parsed = json.loads(cleaned_full)
        return parsed if isinstance(parsed, dict) else None
    except Exception:
        pass

    # 2. Лексический проход для сбора безопасных точек отсечения вне строковых литералов
    in_str = False
    esc = False
    stack: List[str] = []
    # (cut_index, open_stack_snapshot)
    cutpoints: List[tuple[int, List[str]]] = []

    for i, ch in enumerate(s):
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue

        if ch == '"':
            in_str = True
        elif ch in ("{", "["):
            stack.append(ch)
        elif ch in ("}", "]"):
            if stack and ((ch == "}" and stack[-1] == "{") or (ch == "]" and stack[-1] == "[")):
                stack.pop()
            cutpoints.append((i + 1, list(stack)))
        elif ch == ",":
            # Отрезая ДО запятой, мы отбрасываем незаконченный хвост и сохраняем валидный префикс
            cutpoints.append((i, list(stack)))

    if not in_str:
        cutpoints.append((len(s), list(stack)))

    close_map = {"{": "}", "[": "]"}
    # Перебираем точки от конца к началу (максимум 24 попытки — микросекунды)
    for cut_idx, st_snap in reversed(cutpoints[-24:]):
        prefix = s[:cut_idx].rstrip()
        if not prefix or prefix[-1] in (",", ":"):
            continue
        suffix = "".join(close_map[c] for c in reversed(st_snap))
        candidate = re.sub(r",\s*([}\]])", r"\1", prefix + suffix)
        try:
            obj = json.loads(candidate)
            if isinstance(obj, dict) and len(obj) >= 1:
                return obj
        except Exception:
            continue

    return None


def _normalize_llm_payload(parsed: Dict[str, Any]) -> Dict[str, Any]:
    """Приводит небольшие отклонения полей от LLM к строгой схеме DiagnosticStructuredResponse."""
    valid_types = {"diagnosis", "followup", "visual_inspection", "general"}
    rt = str(parsed.get("response_type") or "diagnosis").strip().lower()
    parsed["response_type"] = rt if rt in valid_types else "diagnosis"

    if parsed.get("follow_up_question") is None:
        parsed["follow_up_question"] = "Подсказать подробнее по результатам проверок?"
    else:
        parsed["follow_up_question"] = str(parsed["follow_up_question"]).strip()

    if isinstance(parsed.get("recommendations"), list):
        parsed["recommendations"] = [str(r).strip() for r in parsed["recommendations"] if str(r).strip()]

    system_ru_map = {
        "engine": "Двигатель",
        "cooling": "Охлаждение",
        "transmission": "Трансмиссия",
        "brakes": "Тормозная система",
        "electrical": "Электрика",
        "suspension": "Подвеска",
        "chassis": "Рулевое и шасси",
        "hybrid": "Гибридная установка",
        "battery": "АКБ и зарядка",
    }
    norm_faults: List[Dict[str, Any]] = []
    for f in parsed.get("faults") or []:
        if not isinstance(f, dict):
            continue
        raw_title = str(f.get("title") or f.get("description") or "").strip()
        raw_cause = str(f.get("root_cause") or f.get("cause") or "").strip()
        # Пропускаем недописанные заглушки после восстановления усечённого JSON (например {"code":"P0171","system":"engine"})
        if not raw_title and not raw_cause:
            continue
        title = raw_title or raw_cause
        sys_key = str(f.get("system") or "engine").strip().lower()
        sev = str(f.get("severity") or "warning").strip().lower()
        if sev not in ("critical", "warning", "normal"):
            sev = "warning"
        try:
            conf = max(0, min(100, int(float(f.get("confidence", 85)))))
        except (TypeError, ValueError):
            conf = 85
        try:
            hi = max(0.0, min(100.0, float(f.get("health_index", 70.0))))
        except (TypeError, ValueError):
            hi = 70.0
        norm_faults.append(
            {
                "code": str(f.get("code") or "OBD-DIAG").strip().upper(),
                "system": sys_key,
                "system_ru": str(f.get("system_ru") or system_ru_map.get(sys_key, "Система автомобиля")).strip(),
                "title": title[:160],
                "severity": sev,
                "confidence": conf,
                "health_index": hi,
                "root_cause": raw_cause or title,
            }
        )
    if "faults" in parsed:
        parsed["faults"] = norm_faults

    norm_inv: List[Dict[str, Any]] = []
    valid_cats = {"tool", "part", "consumable", "safety"}
    for idx, item in enumerate(parsed.get("inventory") or [], start=1):
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        if not name:
            continue
        cat = str(item.get("category") or "tool").strip().lower()
        if cat not in valid_cats:
            cat = "tool"
        norm_inv.append(
            {
                "id": str(item.get("id") or f"inv_llm_{idx}").strip(),
                "name": name,
                "category": cat,
                "spec": str(item.get("spec") or "").strip(),
                "required": bool(item.get("required", True)),
                "checked": bool(item.get("checked", False)),
            }
        )
    if "inventory" in parsed:
        parsed["inventory"] = norm_inv

    norm_steps: List[Dict[str, Any]] = []
    for idx, st in enumerate(parsed.get("repair_steps") or [], start=1):
        if not isinstance(st, dict):
            continue
        title = str(st.get("title") or "").strip()
        instr = str(st.get("instruction") or title).strip()
        if not title and not instr:
            continue
        try:
            step_num = max(1, int(st.get("step_number") or idx))
        except (TypeError, ValueError):
            step_num = idx
        try:
            est_min = max(1, int(st.get("estimated_minutes") or 15))
        except (TypeError, ValueError):
            est_min = 15
        norm_steps.append(
            {
                "step_number": step_num,
                "title": (title or f"Шаг {step_num}")[:140],
                "instruction": instr or title,
                "torque_or_spec": str(st.get("torque_or_spec") or "").strip(),
                "safety_warning": str(st.get("safety_warning") or "").strip(),
                "verification_hint": str(st.get("verification_hint") or "").strip(),
                "estimated_minutes": est_min,
                "completed": bool(st.get("completed", False)),
            }
        )
    if "repair_steps" in parsed:
        parsed["repair_steps"] = norm_steps

    if parsed.get("vehicle_detected") is None:
        parsed["vehicle_detected"] = ""
    else:
        parsed["vehicle_detected"] = str(parsed["vehicle_detected"]).strip()[:120]

    return parsed


def validate_and_coerce_structured_json(
    raw_output: str,
    fallback_response: Optional[DiagnosticStructuredResponse] = None,
) -> DiagnosticStructuredResponse:
    """
    Извлекает JSON и текст диагноста из ответа языковой модели, проверяет через JSON Schema и Pydantic v2,
    сохраняет осознанно пустые списки при `followup`/`general`, и подрезает оборванный текст по предложению.
    """
    prose_part, json_str = extract_prose_and_json_block(raw_output)

    try:
        if not json_str:
            raise ValueError("JSON block not found")
        parsed = _repair_truncated_json(json_str)
        if not isinstance(parsed, dict):
            raise ValueError("Parsed JSON root is not an object")

        if prose_part and not (parsed.get("mentor_reply") or "").strip():
            parsed["mentor_reply"] = prose_part

        parsed = _normalize_llm_payload(parsed)

        if fallback_response is not None:
            fb_dict = fallback_response.model_dump()
            resp_type = parsed.get("response_type") or fb_dict.get("response_type") or "diagnosis"
            allow_scaffold_arrays = resp_type in ("diagnosis", "visual_inspection")
            for k, v in fb_dict.items():
                if k == "vehicle_detected":
                    continue
                if not allow_scaffold_arrays and k in (
                    "faults", "inventory", "repair_steps", "telemetry_notes", "recommendations"
                ):
                    parsed.setdefault(k, [])
                    continue
                if k not in parsed or parsed[k] in (None, "", []):
                    parsed[k] = v

        validated = DiagnosticStructuredResponse.model_validate(parsed)
        validated.mentor_reply = truncate_to_last_sentence(validated.mentor_reply)
        jsonschema.validate(instance=validated.model_dump(), schema=DIAGNOSTIC_JSON_SCHEMA)
        return validated
    except Exception:
        if fallback_response is not None:
            plain_text = _strip_reasoning_tokens(raw_output)
            plain_text = re.sub(r"```.*?```", "", plain_text, flags=re.DOTALL)
            plain_text = re.sub(r"```(?:json)?[\s\S]*$", "", plain_text).strip()
            if plain_text and len(plain_text) > 15 and not plain_text.startswith("{"):
                fallback_response.mentor_reply = truncate_to_last_sentence(plain_text)
            else:
                fallback_response.mentor_reply = truncate_to_last_sentence(fallback_response.mentor_reply)
            return fallback_response

        return DiagnosticStructuredResponse(
            response_type="followup",
            summary_title="Ответ эксперта ИИдеал Авто",
            mentor_reply=truncate_to_last_sentence(prose_part or raw_output) or "Диагностический анализ завершён.",
        )
