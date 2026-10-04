"""
Строгие JSON-схемы ответов экспертной системы (Pydantic v2 + JSON Schema) и
реестр инструментов для Function Calling (вызова функций моделью).
Гарантирует, что ответы ИИ всегда приведены к валидному структурированному JSON-виду
с блоками инвентаря, пошаговыми чекбоксами задач, диагностическими кодами и телеметрией.
"""

import json
import re
from typing import Any, Dict, List, Literal, Optional
import jsonschema
from pydantic import BaseModel, Field


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
    """Элемент блока инвентаря (инструмент, запчасть, расходник или СИЗ) с чекбоксом."""

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
    instruction: str = Field(..., description="Подробная пошаговая инструкция как выполнить действие")
    torque_or_spec: str = Field(
        default="",
        description="Эталонный параметр: момент затяжки (Н·м), сопротивление (Ом), давление или напряжение",
    )
    safety_warning: str = Field(
        default="",
        description="Предупреждение по технике безопасности на данном этапе",
    )
    verification_hint: str = Field(
        default="",
        description="Как убедиться, что шаг выполнен правильно",
    )
    estimated_minutes: int = Field(default=10, ge=1, description="Оценка времени выполнения в минутах")
    completed: bool = Field(default=False, description="Чекбокс: выполнен ли шаг пользователем")


class DiagnosticStructuredResponse(BaseModel):
    """
    Строгая JSON-схема полного ответа экспертной системы автодиагностики.
    Используется для GBNF-грамматики llama.cpp, OpenAI Structured Outputs и валидации AirLLM.
    """

    response_type: Literal["diagnosis", "followup", "visual_inspection"] = Field(
        default="diagnosis",
        description="Тип ответа: первичная диагностика, ответ на уточняющий вопрос или осмотр по фото",
    )
    summary_title: str = Field(..., description="Краткий заголовок вердикта экспертной системы")
    mentor_reply: str = Field(
        ...,
        description="Развёрнутый ответ ведущего инженера-диагноста и наставника на русском языке",
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
        description="Важные рекомендации по дальнейшей эксплуатации и профилактике",
    )
    follow_up_question: str = Field(
        default="Нужна ли дополнительная помощь или детализация по какому-либо шагу ремонта?",
        description="Вопрос в конце ответа для продолжения диалога",
    )
    tool_calls: List[ToolCallExecution] = Field(
        default_factory=list,
        description="Список инструментов Function Calling, использованных при формировании ответа",
    )


# JSON Schema для передачи в llama.cpp / OpenAI response_format
DIAGNOSTIC_JSON_SCHEMA: Dict[str, Any] = DiagnosticStructuredResponse.model_json_schema()


# Определения инструментов для Function Calling (OpenAI / Llama.cpp / AirLLM Tool Use)
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
            "description": "Выполнить гибридный RAG-поиск по симптомам неисправности автомобиля в локальной базе знаний и телеметрии.",
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
    и приводит к строгому типизированному объекту DiagnosticStructuredResponse.
    """
    cleaned = raw_output.strip()

    # Убираем markdown-обёртку ```json ... ``` если модель её добавила
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
        # Если модель вернула частичный JSON, дополняем обязательные поля из fallback_response
        if fallback_response is not None and isinstance(parsed, dict):
            fb_dict = fallback_response.model_dump()
            for k, v in fb_dict.items():
                if k not in parsed or parsed[k] in (None, "", []):
                    parsed[k] = v

        validated = DiagnosticStructuredResponse.model_validate(parsed)
        jsonschema.validate(instance=validated.model_dump(), schema=DIAGNOSTIC_JSON_SCHEMA)
        return validated
    except Exception:
        if fallback_response is not None:
            # Если модель сгенерировала полезный свободный текст, сохраняем его в mentor_reply
            plain_text = re.sub(r"```.*?```", "", raw_output, flags=re.DOTALL).strip()
            if plain_text and len(plain_text) > 30 and not plain_text.startswith("{"):
                fallback_response.mentor_reply = plain_text
            return fallback_response

        return DiagnosticStructuredResponse(
            response_type="followup",
            summary_title="Ответ эксперта-диагноста",
            mentor_reply=raw_output.strip() or "Диагностический анализ завершён.",
        )
