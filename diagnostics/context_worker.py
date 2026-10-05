"""
Фоновый воркер сжатия контекста и междиалоговой памяти с динамической оптимизацией
относительно свободного размера окна контекста (~5000 токенов).

Архитектура динамического управления контекстом:
1. В живом окне чата модель всегда напрямую видит последние 5 сообщений пользователя
   и свои 5 ответов на них (включая ключевые выводы, коды ошибок и статус шагов ремонта).
2. После каждого ответа ИИ запускается фоновый поток, который:
   - Вычисляет доступный свободный бюджет токенов (`free_context_tokens`) относительно
     настроенного `context_window_tokens` (~5000 токенов) за вычетом системного промпта,
     результатов BERT-RAG, резерва генерации и последних 5 пар «вопрос-ответ».
   - Динамически масштабирует объем выжимки (`DialogSession.summary`) под свободный контекст,
     упаковывая более старые сообщения диалога и накопленные технические факты без потерь.
   - При включенной настройке `cross_dialog_memory_enabled` обновляет глобальную
     междиалоговую память (`SystemSettings.global_memory_summary`).
3. ПРИОРИТЕТ ОТВЕТА ПОЛЬЗОВАТЕЛЮ (Zero-Wait Preemption):
   Если пользователь задал новый вопрос, пока фоновый воркер еще работает,
   вызывается `preempt_if_running(session_id)`, который мгновенно выставляет `cancel_event.set()`
   и увеличивает `worker_version` без ожидания.
"""

import logging
import re
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional

from django.db import close_old_connections

from .models import ChatMessage, DialogSession, SystemSettings

logger = logging.getLogger(__name__)

RECENT_EXCHANGES_TO_KEEP = 5  # 5 вопросов пользователя + 5 ответов модели = 10 сообщений


def estimate_tokens_count(text: str) -> int:
    """Оценка числа токенов для русскоязычного и технического текста (~3.2 символа на токен)."""
    if not text:
        return 0
    return max(1, int(len(text) / 3.2))


def format_assistant_core_memory(msg: ChatMessage, max_chars: int = 380) -> str:
    """
    Извлекает основную техническую суть ответа модели (резюме + коды неисправностей + ключевые шаги),
    чтобы модель в чате гарантированно помнила свои последние 5 ответов.
    """
    sdata = msg.structured_data if isinstance(msg.structured_data, dict) else {}
    reply = (sdata.get("mentor_reply") or msg.content or "").strip()
    faults = sdata.get("faults") or []
    steps = sdata.get("repair_steps") or []

    parts: List[str] = []
    if reply:
        parts.append(reply[:240])
    if faults:
        fault_Str = ", ".join(
            f"{f.get('code', 'N/A')}: {f.get('title', '')}" for f in faults[:3] if isinstance(f, dict)
        )
        if fault_Str:
            parts.append(f"[Диагноз: {fault_Str}]")
    if steps:
        done_cnt = sum(1 for s in steps if isinstance(s, dict) and s.get("completed"))
        step_titles = "; ".join(
            f"{s.get('step_number')}. {s.get('title', '')}" for s in steps[:3] if isinstance(s, dict)
        )
        parts.append(f"[План ({done_cnt}/{len(steps)} выполнено): {step_titles}]")

    combined = " ".join(parts).strip()
    return combined[:max_chars]


def compute_dynamic_context_budget(
    context_window_tokens: int = 32768,
    messages: Optional[List[ChatMessage]] = None,
    system_and_rag_reserve_tokens: int = 1800,
    generation_reserve_tokens: int = 5000,
) -> Dict[str, int]:
    """
    Динамически рассчитывает бюджет свободного контекста относительно `context_window_tokens`
    (по умолчанию 32 768 токенов — в разы больше длины основного ответа модели ~5 000 токенов)
    с учетом последних 5 сообщений пользователя и 5 ответов модели.
    """
    messages = messages or []
    ctx_window = max(16384, int(context_window_tokens or 32768))
    recent_window = messages[-(RECENT_EXCHANGES_TO_KEEP * 2):] if messages else []

    recent_tokens = 0
    for m in recent_window:
        if m.role == "user":
            recent_tokens += estimate_tokens_count(m.content or "") + 16
        else:
            recent_tokens += estimate_tokens_count(format_assistant_core_memory(m, max_chars=900)) + 24

    used_fixed_tokens = system_and_rag_reserve_tokens + generation_reserve_tokens + recent_tokens
    free_context_tokens = max(1000, ctx_window - used_fixed_tokens)
    # Выделяем под фоновую выжимку до 35% свободного окна контекста (в символах ~3.0 симв/токен)
    summary_token_budget = max(400, min(6000, int(free_context_tokens * 0.35)))
    max_summary_chars = max(1200, min(14000, int(summary_token_budget * 3.0)))

    return {
        "context_window_tokens": ctx_window,
        "system_and_rag_reserve_tokens": system_and_rag_reserve_tokens,
        "generation_reserve_tokens": generation_reserve_tokens,
        "recent_messages_count": len(recent_window),
        "recent_messages_tokens": recent_tokens,
        "free_context_tokens": free_context_tokens,
        "summary_token_budget": summary_token_budget,
        "max_summary_chars": max_summary_chars,
    }


@dataclass
class ActiveWorkerHandle:
    session_id: str
    version: int
    cancel_event: threading.Event
    thread: threading.Thread
    started_at: float


class ContextSummarizerWorkerManager:
    """Менеджер вытесняемых (preemptible) фоновых воркеров динамической суммаризации контекста."""

    def __init__(self):
        self._lock = threading.Lock()
        self._active_workers: Dict[str, ActiveWorkerHandle] = {}
        self._last_budgets: Dict[str, Dict[str, int]] = {}
        self._llm_summarizer_fn: Optional[Callable[[str, threading.Event], Optional[str]]] = None

    def register_llm_summarizer(self, fn: Optional[Callable[[str, threading.Event], Optional[str]]]):
        """Регистрирует опциональную функцию LLM-суммаризации с поддержкой прерывания по cancel_event."""
        self._llm_summarizer_fn = fn

    def preempt_if_running(self, session_id: str) -> bool:
        """
        Принудительно сбрасывает активный фоновый воркер для данной сессии (если он работает),
        не блокируя поток обработки нового вопроса пользователя.
        """
        sid = str(session_id)
        was_running = False

        with self._lock:
            handle = self._active_workers.get(sid)
            if handle and handle.thread.is_alive():
                handle.cancel_event.set()
                was_running = True
                self._active_workers.pop(sid, None)

        if was_running:
            try:
                close_old_connections()
                session = DialogSession.objects.filter(pk=session_id).first()
                if session:
                    session.worker_version += 1
                    session.worker_status = "aborted_for_priority"
                    session.save(update_fields=["worker_version", "worker_status", "updated_at"])
                logger.info(
                    "[CONTEXT WORKER] Принудительный сброс воркера сессии %s: приоритет отдан новому запросу пользователя.",
                    sid,
                )
            except Exception as exc:
                logger.warning("[CONTEXT WORKER] Ошибка обновления статуса при сбросе: %s", exc)

        return was_running

    def start_background_update(self, session_id: str) -> int:
        """
        Запускает фоновый воркер обновления выжимки диалога (и междиалоговой памяти, если включена).
        """
        sid = str(session_id)
        self.preempt_if_running(sid)

        close_old_connections()
        session = DialogSession.objects.filter(pk=session_id).first()
        if not session:
            return 0

        session.worker_version += 1
        new_version = session.worker_version
        session.worker_status = "running"
        session.save(update_fields=["worker_version", "worker_status", "updated_at"])

        cancel_event = threading.Event()
        worker_thread = threading.Thread(
            target=self._worker_loop,
            args=(sid, new_version, cancel_event),
            name=f"ContextWorker-{sid[:8]}-v{new_version}",
            daemon=True,
        )

        with self._lock:
            self._active_workers[sid] = ActiveWorkerHandle(
                session_id=sid,
                version=new_version,
                cancel_event=cancel_event,
                thread=worker_thread,
                started_at=time.perf_counter(),
            )

        logger.debug("[CONTEXT WORKER] Запущен фоновый воркер сессии %s (версия v%d).", sid, new_version)
        worker_thread.start()
        return new_version

    def get_worker_state(self, session_id: str) -> Dict[str, Any]:
        sid = str(session_id)
        with self._lock:
            handle = self._active_workers.get(sid)
            is_alive = bool(handle and handle.thread.is_alive() and not handle.cancel_event.is_set())
            budget = self._last_budgets.get(sid, {})
        return {
            "is_running": is_alive,
            "version": handle.version if handle else 0,
            "dynamic_budget": budget,
        }

    def _build_dynamic_structured_digest(
        self,
        messages: List[ChatMessage],
        vehicle_info: str,
        context_window_tokens: int,
        cancel_event: threading.Event,
    ) -> tuple[Optional[str], Dict[str, int]]:
        """
        Формирует динамически масштабируемую техническую выжимку диалога
        относительно свободного размера контекстного окна (`free_context_tokens`).
        """
        budget = compute_dynamic_context_budget(
            context_window_tokens=context_window_tokens,
            messages=messages,
        )
        if cancel_event.is_set():
            return None, budget

        max_chars = budget["max_summary_chars"]
        dtc_codes: List[str] = []
        user_symptoms: List[str] = []
        diagnosed_faults: List[str] = []
        completed_steps: List[str] = []
        pending_steps: List[str] = []
        checked_inventory: List[str] = []
        older_history_notes: List[str] = []

        cutoff_idx = max(0, len(messages) - (RECENT_EXCHANGES_TO_KEEP * 2))

        for idx, msg in enumerate(messages):
            if cancel_event.is_set():
                return None, budget

            for code in msg.dtc_codes or []:
                if code not in dtc_codes:
                    dtc_codes.append(code)

            found_in_text = re.findall(r"\b([PCBU][0-9A-F]{4})\b", (msg.content or "").upper())
            for c in found_in_text:
                if c not in dtc_codes:
                    dtc_codes.append(c)

            if msg.role == "user":
                clean_q = (msg.content or "").strip()
                if clean_q:
                    user_symptoms.append(clean_q[:160])
                    if idx < cutoff_idx:
                        older_history_notes.append(f"Запрос #{idx // 2 + 1}: {clean_q[:110]}")
            elif msg.role == "assistant" and isinstance(msg.structured_data, dict):
                sdata = msg.structured_data
                for fault in sdata.get("faults", []):
                    if isinstance(fault, dict):
                        f_str = f"{fault.get('code', 'N/A')} ({fault.get('title', '')})"
                        if f_str not in diagnosed_faults:
                            diagnosed_faults.append(f_str)

                for step in sdata.get("repair_steps", []):
                    if isinstance(step, dict):
                        s_title = f"Шаг {step.get('step_number')}: {step.get('title')}"
                        if step.get("completed"):
                            if s_title not in completed_steps:
                                completed_steps.append(s_title)
                            if s_title in pending_steps:
                                pending_steps.remove(s_title)
                        else:
                            if s_title not in pending_steps and s_title not in completed_steps:
                                pending_steps.append(s_title)

                for inv in sdata.get("inventory", []):
                    if isinstance(inv, dict) and inv.get("checked"):
                        inv_name = inv.get("name", "")
                        if inv_name and inv_name not in checked_inventory:
                            checked_inventory.append(inv_name)

                if idx < cutoff_idx:
                    core_ans = format_assistant_core_memory(msg, max_chars=130)
                    if core_ans:
                        older_history_notes.append(f"Ответ ИИ: {core_ans}")

        if cancel_event.is_set():
            return None, budget

        # Масштабируем число сохраняемых элементов пропорционально свободному контексту
        scale_factor = max(1, min(3, budget["free_context_tokens"] // 1100))

        parts: List[str] = []
        if vehicle_info:
            parts.append(f"Автомобиль: {vehicle_info}.")
        if dtc_codes:
            parts.append(f"Коды ошибок (DTC): {', '.join(dtc_codes[:6 * scale_factor])}.")
        if user_symptoms:
            parts.append(f"Обращения и симптомы: {' | '.join(user_symptoms[-(3 * scale_factor):])}.")
        if diagnosed_faults:
            parts.append(f"Установленные неисправности: {'; '.join(diagnosed_faults[:4 * scale_factor])}.")
        if completed_steps:
            parts.append(f"Выполнено по чеклисту: {', '.join(completed_steps[:5 * scale_factor])}.")
        if pending_steps:
            parts.append(f"Ожидает выполнения: {', '.join(pending_steps[:4 * scale_factor])}.")
        if checked_inventory:
            parts.append(f"Подготовлен инструмент/запчасти: {', '.join(checked_inventory[:5 * scale_factor])}.")
        if older_history_notes:
            parts.append(
                f"Архив ранних сообщений (до последних {RECENT_EXCHANGES_TO_KEEP} пар): "
                f"{' // '.join(older_history_notes[-(4 * scale_factor):])}."
            )

        base_digest = "\n".join(parts) if parts else "Диалог начат, симптомы уточняются."
        if len(base_digest) > max_chars:
            base_digest = base_digest[:max_chars].rsplit(".", 1)[0] + "."

        if self._llm_summarizer_fn is not None and not cancel_event.is_set():
            try:
                llm_digest = self._llm_summarizer_fn(base_digest, cancel_event)
                if llm_digest and not cancel_event.is_set():
                    return llm_digest[:max_chars], budget
            except Exception as exc:
                logger.debug("[CONTEXT WORKER] Ошибка пользовательского суммаризатора: %s", exc)

        return base_digest, budget

    def _update_cross_dialog_memory(self, cancel_event: threading.Event):
        """
        Обновляет единую междиалоговую выжимку по всем сессиям пользователя,
        если активирована настройка `cross_dialog_memory_enabled`.
        """
        if cancel_event.is_set():
            return

        settings_obj = SystemSettings.get_active()
        if not settings_obj.cross_dialog_memory_enabled:
            return

        recent_sessions = list(
            DialogSession.objects.exclude(summary="").order_by("-updated_at")[:6]
        )
        if not recent_sessions or cancel_event.is_set():
            return

        global_blocks: List[str] = []
        for sess in recent_sessions:
            if cancel_event.is_set():
                return
            summary_lines = [ln.strip() for ln in sess.summary.splitlines() if ln.strip()]
            compact_summary = " | ".join(summary_lines[:3]) if summary_lines else sess.title
            veh_prefix = f"[{sess.vehicle_info}] " if sess.vehicle_info else ""
            global_blocks.append(f"• Сессия «{sess.title}» {veh_prefix}: {compact_summary[:280]}")

        if cancel_event.is_set():
            return

        settings_obj.global_memory_summary = "\n".join(global_blocks)
        settings_obj.save(update_fields=["global_memory_summary", "updated_at"])

    def _worker_loop(self, session_id: str, version: int, cancel_event: threading.Event):
        start_ts = time.perf_counter()
        try:
            close_old_connections()

            if cancel_event.wait(timeout=0.05):
                return

            session = DialogSession.objects.filter(pk=session_id).first()
            if not session or session.worker_version != version or cancel_event.is_set():
                return

            settings_obj = SystemSettings.get_active()
            messages = list(session.messages.order_by("created_at"))
            digest, budget = self._build_dynamic_structured_digest(
                messages=messages,
                vehicle_info=session.vehicle_info,
                context_window_tokens=settings_obj.context_window_tokens,
                cancel_event=cancel_event,
            )

            with self._lock:
                self._last_budgets[str(session_id)] = budget

            if digest is None or cancel_event.is_set():
                return

            session.refresh_from_db(fields=["worker_version"])
            if session.worker_version != version or cancel_event.is_set():
                return

            duration_ms = int((time.perf_counter() - start_ts) * 1000)
            session.summary = digest
            session.worker_status = "completed"
            session.worker_last_duration_ms = max(1, duration_ms)
            session.save(
                update_fields=[
                    "summary",
                    "worker_status",
                    "worker_last_duration_ms",
                    "updated_at",
                ]
            )

            logger.debug(
                "[CONTEXT WORKER] Сессия %s (v%d) обновлена за %d мс | Окно=%d ток., свободно=%d ток., лимит выжимки=%d симв.",
                session_id,
                version,
                duration_ms,
                budget["context_window_tokens"],
                budget["free_context_tokens"],
                budget["max_summary_chars"],
            )

            self._update_cross_dialog_memory(cancel_event)

        except Exception as exc:
            logger.error("[CONTEXT WORKER] Ошибка в фоновом воркере сессии %s: %s", session_id, exc)
            try:
                close_old_connections()
                DialogSession.objects.filter(pk=session_id, worker_version=version).update(
                    worker_status="error"
                )
            except Exception:
                pass
        finally:
            with self._lock:
                current = self._active_workers.get(str(session_id))
                if current and current.version == version:
                    self._active_workers.pop(str(session_id), None)
            close_old_connections()


# Глобальный синглтон менеджера фоновых воркеров контекста
context_worker_manager = ContextSummarizerWorkerManager()
