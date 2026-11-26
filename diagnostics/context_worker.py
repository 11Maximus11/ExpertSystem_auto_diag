"""
Фоновый воркер сжатия контекста и персональной междиалоговой памяти с динамической оптимизацией
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
   - При включенной персональной настройке `cross_dialog_memory_enabled` обновляет строго
     изолированную междиалоговую память конкретного владельца (`UserMemorySettings.global_memory_summary`).
3. ПРИОРИТЕТ ОТВЕТА ПОЛЬЗОВАТЕЛЮ (Zero-Wait Preemption):
   Если пользователь задал новый вопрос или удалил сообщения/сессию/память, пока фоновый воркер
   еще работает, вызывается `preempt_if_running` / `preempt_user_workers`, который мгновенно
   выставляет `cancel_event.set()` и атомарно увеличивает `worker_version` без ожидания.
"""

import logging
import re
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional

from django.contrib.auth import get_user_model
from django.db import close_old_connections, transaction
from django.db.models import Exists, F, OuterRef, Q
from django.utils import timezone

from .models import ChatMessage, DialogSession, SystemSettings, UserMemorySettings

logger = logging.getLogger(__name__)

RECENT_EXCHANGES_TO_KEEP = 5  # 5 вопросов пользователя + 5 ответов модели = 10 сообщений


def estimate_tokens_count(text: str) -> int:
    """Оценка числа токенов для русскоязычного и технического текста (~3.2 символа на токен)."""
    if not text:
        return 0
    return max(1, int(len(text) / 3.2))


def format_assistant_core_memory(msg: ChatMessage, max_chars: int = 1200) -> str:
    """
    Извлекает техническую суть ответа модели (текст + диагноз + статус шагов чеклиста),
    чтобы модель в чате помнила ход диагностики, проверенные гипотезы и выполненные шаги.
    """
    sdata = msg.structured_data if isinstance(msg.structured_data, dict) else {}
    reply = (sdata.get("mentor_reply") or msg.content or "").strip()
    faults = sdata.get("faults") or []
    steps = sdata.get("repair_steps") or []

    meta_parts: List[str] = []
    if faults:
        fault_str = ", ".join(
            f"{f.get('code', 'N/A')}: {f.get('title', '')}" for f in faults[:3] if isinstance(f, dict)
        )
        if fault_str:
            meta_parts.append(f"[Диагноз: {fault_str}]")
    if steps:
        done_steps = [
            f"{s.get('step_number')}. {s.get('title', '')}"
            for s in steps
            if isinstance(s, dict) and s.get("completed")
        ]
        pending_steps = [
            f"{s.get('step_number')}. {s.get('title', '')}"
            for s in steps
            if isinstance(s, dict) and not s.get("completed")
        ]
        if done_steps:
            meta_parts.append(f"[Выполнено пользователем: {'; '.join(done_steps[:5])}]")
        if pending_steps:
            meta_parts.append(f"[Осталось по плану: {'; '.join(pending_steps[:5])}]")

    suffix = (" " + " ".join(meta_parts)).rstrip() if meta_parts else ""
    reply_budget = max(240, max_chars - len(suffix) - 1)
    if reply and len(reply) > reply_budget:
        reply_slice = reply[:reply_budget].rsplit(" ", 1)[0].rstrip(",;:-") + "…"
    else:
        reply_slice = reply

    combined = f"{reply_slice}{suffix}".strip()
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
    user_id: Optional[int] = None


class ContextSummarizerWorkerManager:
    """Менеджер вытесняемых (preemptible) фоновых воркеров динамической суммаризации контекста."""

    def __init__(self):
        self._lock = threading.Lock()
        self._active_workers: Dict[str, ActiveWorkerHandle] = {}
        self._last_budgets: Dict[str, Dict[str, int]] = {}
        self._llm_summarizer_fn: Optional[Callable[[str, threading.Event], Optional[str]]] = None
        self._user_memory_locks_guard = threading.Lock()
        self._user_memory_locks: Dict[int, threading.RLock] = {}

    def _get_user_memory_lock(self, user_id: int) -> threading.RLock:
        """Возвращает персональную реентерабельную блокировку междиалоговой памяти пользователя."""
        uid = int(user_id)
        with self._user_memory_locks_guard:
            lock = self._user_memory_locks.get(uid)
            if lock is None:
                lock = threading.RLock()
                self._user_memory_locks[uid] = lock
            return lock

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
            if handle:
                handle.cancel_event.set()
                if handle.thread.is_alive():
                    was_running = True
                self._active_workers.pop(sid, None)

        if was_running:
            try:
                close_old_connections()
                DialogSession.objects.filter(pk=session_id).update(
                    worker_version=F("worker_version") + 1,
                    worker_status="aborted_for_priority",
                    updated_at=timezone.now(),
                )
                logger.info(
                    "[CONTEXT WORKER] Принудительный сброс воркера сессии %s: приоритет отдан новому запросу пользователя.",
                    sid,
                )
            except Exception as exc:
                logger.warning("[CONTEXT WORKER] Ошибка обновления статуса при сбросе: %s", exc)

        return was_running

    def preempt_user_workers(self, user_id: Optional[int]) -> int:
        """
        Мгновенно выставляет cancel_event для всех активных воркеров указанного пользователя
        и атомарно увеличивает поколения их сессий.
        """
        if user_id is None:
            return 0
        uid = int(user_id)
        preempted_sids: List[str] = []

        with self._lock:
            for sid, handle in list(self._active_workers.items()):
                if handle.user_id == uid:
                    handle.cancel_event.set()
                    if handle.thread.is_alive():
                        preempted_sids.append(sid)
                    self._active_workers.pop(sid, None)

        try:
            close_old_connections()
            qs = DialogSession.objects.filter(user_id=uid)
            if preempted_sids:
                qs.filter(Q(pk__in=preempted_sids) | Q(worker_status="running")).update(
                    worker_version=F("worker_version") + 1,
                    worker_status="aborted_for_priority",
                    updated_at=timezone.now(),
                )
            else:
                qs.filter(worker_status="running").update(
                    worker_version=F("worker_version") + 1,
                    worker_status="aborted_for_priority",
                    updated_at=timezone.now(),
                )
        except Exception as exc:
            logger.warning("[CONTEXT WORKER] Ошибка при массовом сбросе воркеров пользователя %s: %s", uid, exc)

        return len(preempted_sids)

    def start_background_update(self, session_id: str) -> int:
        """
        Запускает фоновый воркер обновления выжимки диалога (и персональной междиалоговой памяти, если включена).
        """
        sid = str(session_id)
        self.preempt_if_running(sid)

        close_old_connections()
        with transaction.atomic():
            updated = DialogSession.objects.filter(pk=session_id).update(
                worker_version=F("worker_version") + 1,
                worker_status="running",
                updated_at=timezone.now(),
            )
            if not updated:
                return 0
            session = DialogSession.objects.filter(pk=session_id).only("id", "user_id", "worker_version").first()
            if not session:
                return 0
            new_version = int(session.worker_version)
            owner_user_id = session.user_id

        cancel_event = threading.Event()
        worker_thread = threading.Thread(
            target=self._worker_loop,
            args=(sid, new_version, cancel_event, owner_user_id),
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
                user_id=owner_user_id,
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
        allow_llm: bool = True,
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

        if not messages:
            return "", budget

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

        if allow_llm and self._llm_summarizer_fn is not None and not cancel_event.is_set():
            try:
                llm_digest = self._llm_summarizer_fn(base_digest, cancel_event)
                if llm_digest and not cancel_event.is_set():
                    return llm_digest[:max_chars], budget
            except Exception as exc:
                logger.debug("[CONTEXT WORKER] Ошибка пользовательского суммаризатора: %s", exc)

        return base_digest, budget

    def recompute_session_summary_sync(self, session_id: str) -> str:
        """
        Синхронно и мгновенно пересчитывает выжимку `DialogSession.summary` строго
        по актуально оставшимся сообщениям в БД (или очищает до `""`, если сообщений нет)
        и немедленно пересобирает персональную междиалоговую память владельца.
        """
        sid = str(session_id)
        self.preempt_if_running(sid)
        close_old_connections()

        session = DialogSession.objects.filter(pk=session_id).first()
        if not session:
            return ""

        user_id = session.user_id
        settings_obj = SystemSettings.get_active()

        def _do_sync() -> str:
            fresh_session = DialogSession.objects.filter(pk=session_id).first()
            if not fresh_session:
                return ""
            messages = list(ChatMessage.objects.filter(session=fresh_session).order_by("created_at"))
            if not messages:
                digest = ""
                budget = compute_dynamic_context_budget(
                    context_window_tokens=settings_obj.context_window_tokens,
                    messages=[],
                )
            else:
                raw_digest, budget = self._build_dynamic_structured_digest(
                    messages=messages,
                    vehicle_info=fresh_session.vehicle_info,
                    context_window_tokens=settings_obj.context_window_tokens,
                    cancel_event=threading.Event(),
                    allow_llm=False,
                )
                digest = raw_digest or ""

            with self._lock:
                self._last_budgets[sid] = budget

            DialogSession.objects.filter(pk=session_id).update(
                summary=digest,
                worker_status="completed" if digest else "idle",
                worker_version=F("worker_version") + 1,
                updated_at=timezone.now(),
            )
            if user_id is not None:
                self._update_cross_dialog_memory_locked(int(user_id))
            return digest

        if user_id is not None:
            with self._get_user_memory_lock(int(user_id)):
                return _do_sync()
        return _do_sync()

    def _update_cross_dialog_memory_locked(
        self,
        user_id: int,
        cancel_event: Optional[threading.Event] = None,
        force_strip_if_disabled: bool = False,
    ) -> str:
        """
        Пересобирает персональную междиалоговую выжимку строго по актуальным сессиям
        конкретного пользователя `user_id` (требует удержания `_get_user_memory_lock(user_id)`).
        """
        if cancel_event is not None and cancel_event.is_set():
            return ""

        User = get_user_model()
        if not User.objects.filter(pk=user_id).exists():
            return ""

        mem_settings, _ = UserMemorySettings.objects.get_or_create(user_id=user_id)
        manual_lines = [
            ln.strip()
            for ln in (mem_settings.global_memory_summary or "").splitlines()
            if ln.strip() and not ln.strip().startswith("• Сессия «")
        ]

        if not mem_settings.cross_dialog_memory_enabled:
            if force_strip_if_disabled:
                cleaned = "\n".join(manual_lines)
                if cleaned != (mem_settings.global_memory_summary or ""):
                    mem_settings.global_memory_summary = cleaned
                    mem_settings.save(update_fields=["global_memory_summary", "updated_at"])
                return cleaned
            return mem_settings.global_memory_summary or ""

        qs = DialogSession.objects.filter(user_id=user_id).exclude(summary="")
        if mem_settings.memory_cleared_at is not None:
            qs = qs.filter(
                Q(created_at__gt=mem_settings.memory_cleared_at)
                | Exists(
                    ChatMessage.objects.filter(
                        session_id=OuterRef("pk"),
                        created_at__gt=mem_settings.memory_cleared_at,
                    )
                )
            )

        recent_sessions = list(qs.order_by("-updated_at")[:6])
        if cancel_event is not None and cancel_event.is_set():
            return mem_settings.global_memory_summary or ""

        auto_blocks: List[str] = []
        for sess in recent_sessions:
            if cancel_event is not None and cancel_event.is_set():
                return mem_settings.global_memory_summary or ""
            summary_lines = [ln.strip() for ln in (sess.summary or "").splitlines() if ln.strip()]
            compact_summary = " | ".join(summary_lines[:3]) if summary_lines else sess.title
            veh_prefix = f"[{sess.vehicle_info}] " if sess.vehicle_info else ""
            auto_blocks.append(f"• Сессия «{sess.title}» {veh_prefix}: {compact_summary[:280]}")

        global_blocks: List[str] = list(manual_lines) + auto_blocks
        new_global_summary = "\n".join(global_blocks)
        if new_global_summary != (mem_settings.global_memory_summary or ""):
            mem_settings.global_memory_summary = new_global_summary
            mem_settings.save(update_fields=["global_memory_summary", "updated_at"])
        return new_global_summary

    def _update_cross_dialog_memory(
        self,
        user_id: Optional[int],
        cancel_event: Optional[threading.Event] = None,
    ) -> str:
        """Безопасная обёртка обновления персональной междиалоговой памяти (NO-OP для анонимных/демо сессий)."""
        if user_id is None or (cancel_event is not None and cancel_event.is_set()):
            return ""
        with self._get_user_memory_lock(int(user_id)):
            return self._update_cross_dialog_memory_locked(int(user_id), cancel_event=cancel_event)

    def rebuild_user_cross_dialog_memory(
        self,
        user_id: Optional[int],
        force_strip_if_disabled: bool = False,
    ) -> str:
        """Публичный синхронный пересчёт персональной междиалоговой памяти пользователя."""
        if user_id is None:
            return ""
        close_old_connections()
        with self._get_user_memory_lock(int(user_id)):
            return self._update_cross_dialog_memory_locked(
                int(user_id),
                cancel_event=None,
                force_strip_if_disabled=force_strip_if_disabled,
            )

    def clear_user_global_memory(self, user_id: Optional[int]) -> None:
        """
        Полностью очищает персональную междиалоговую память пользователя, останавливает
        все его фоновые воркеры, фиксирует `memory_cleared_at` и сбрасывает `summary`
        существующих сессий пользователя, исключая повторное всплытие старых чатов.
        """
        if user_id is None:
            return
        uid = int(user_id)
        self.preempt_user_workers(uid)
        close_old_connections()
        with self._get_user_memory_lock(uid):
            now_ts = timezone.now()
            mem_settings, _ = UserMemorySettings.objects.get_or_create(user_id=uid)
            mem_settings.global_memory_summary = ""
            mem_settings.memory_cleared_at = now_ts
            mem_settings.save(update_fields=["global_memory_summary", "memory_cleared_at", "updated_at"])
            DialogSession.objects.filter(user_id=uid).update(
                summary="",
                worker_status="idle",
                worker_version=F("worker_version") + 1,
                updated_at=now_ts,
            )

    def _worker_loop(
        self,
        session_id: str,
        version: int,
        cancel_event: threading.Event,
        owner_user_id: Optional[int] = None,
    ):
        start_ts = time.perf_counter()
        try:
            close_old_connections()

            if cancel_event.wait(timeout=0.05):
                return

            session = DialogSession.objects.filter(pk=session_id).first()
            if not session or session.worker_version != version or cancel_event.is_set():
                return

            user_id = session.user_id if session.user_id is not None else owner_user_id
            settings_obj = SystemSettings.get_active()
            messages = list(ChatMessage.objects.filter(session=session).order_by("created_at"))

            if not messages:
                digest: Optional[str] = ""
                budget = compute_dynamic_context_budget(
                    context_window_tokens=settings_obj.context_window_tokens,
                    messages=[],
                )
            else:
                digest, budget = self._build_dynamic_structured_digest(
                    messages=messages,
                    vehicle_info=session.vehicle_info,
                    context_window_tokens=settings_obj.context_window_tokens,
                    cancel_event=cancel_event,
                    allow_llm=True,
                )

            with self._lock:
                self._last_budgets[str(session_id)] = budget

            if digest is None or cancel_event.is_set():
                return

            duration_ms = max(1, int((time.perf_counter() - start_ts) * 1000))

            def _commit_digest() -> bool:
                fresh_session = DialogSession.objects.filter(pk=session_id).first()
                if fresh_session is None or fresh_session.worker_version != version or cancel_event.is_set():
                    return False
                fresh_session.summary = digest
                fresh_session.worker_status = "completed" if digest else "idle"
                fresh_session.worker_last_duration_ms = duration_ms
                fresh_session.save(
                    update_fields=[
                        "summary",
                        "worker_status",
                        "worker_last_duration_ms",
                        "updated_at",
                    ]
                )
                return True

            if user_id is not None:
                with self._get_user_memory_lock(int(user_id)):
                    if not _commit_digest():
                        return
                    self._update_cross_dialog_memory_locked(int(user_id), cancel_event=cancel_event)
            else:
                if not _commit_digest():
                    return

            logger.debug(
                "[CONTEXT WORKER] Сессия %s (v%d) обновлена за %d мс | Окно=%d ток., свободно=%d ток., лимит выжимки=%d симв.",
                session_id,
                version,
                duration_ms,
                budget["context_window_tokens"],
                budget["free_context_tokens"],
                budget["max_summary_chars"],
            )

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
