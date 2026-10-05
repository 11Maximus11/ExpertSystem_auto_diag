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
                        "enum": ["all", "engine", "transmission", "brakes", "electrical", "suspension", "battery"],
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
                        "description": "Система автомобиля (engine, transmission, brakes, electrical, suspension, battery)",
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


def validate_and_coerce_structured_json(
    raw_output: str,
    fallback_response: Optional[DiagnosticStructuredResponse] = None,
) -> DiagnosticStructuredResponse:
    """
    Извлекает JSON из ответа языковой модели, проверяет его через JSON Schema и Pydantic v2,
    применяет автообрезку по последнему предложению и возвращает валидный DiagnosticStructuredResponse.
    """
    cleaned = (raw_output or "").strip()

    fence_match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", cleaned, flags=re.DOTALL)
    if fence_match:
        cleaned = fence_match.group(1)
    else:
        brace_start = cleaned.find("{")
        brace_end = cleaned.rfind("}")
        if brace_start != -1 and brace_end != -1 and brace_end > brace_start:
            cleaned = cleaned[brace_start : brace_end + 1]

    try:
        parsed = json.loads(cleaned)
        if fallback_response is not None and isinstance(parsed, dict):
            fb_dict = fallback_response.model_dump()
            for k, v in fb_dict.items():
                if k not in parsed or parsed[k] in (None, "", []):
                    parsed[k] = v

        validated = DiagnosticStructuredResponse.model_validate(parsed)
        validated.mentor_reply = truncate_to_last_sentence(validated.mentor_reply)
        jsonschema.validate(instance=validated.model_dump(), schema=DIAGNOSTIC_JSON_SCHEMA)
        return validated
    except Exception:
        if fallback_response is not None:
            plain_text = re.sub(r"```.*?```", "", raw_output or "", flags=re.DOTALL).strip()
            if plain_text and len(plain_text) > 15 and not plain_text.startswith("{"):
                fallback_response.mentor_reply = truncate_to_last_sentence(plain_text)
            else:
                fallback_response.mentor_reply = truncate_to_last_sentence(fallback_response.mentor_reply)
            return fallback_response

        return DiagnosticStructuredResponse(
            response_type="followup",
            summary_title="Ответ эксперта ИИдеал Авто",
            mentor_reply=truncate_to_last_sentence(raw_output) or "Диагностический анализ завершён.",
        )
