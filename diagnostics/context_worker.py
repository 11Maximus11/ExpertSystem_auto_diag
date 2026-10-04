"""
Фоновый воркер сжатия контекста и междиалоговой памяти (Requirement #3).

Особенности архитектуры под малое окно контекста (8 ГБ VRAM):
1. После каждого ответа ИИ запускается фоновый поток, который обновляет краткую выжимку
   текущего диалога (`DialogSession.summary`), а при включенной настройке
   `cross_dialog_memory_enabled` — и глобальную выжимку между диалогами (`SystemSettings.global_memory_summary`).
2. ПРИОРИТЕТ ОТВЕТА ПОЛЬЗОВАТЕЛЮ (Zero-Wait Preemption):
   Если пользователь задал новый вопрос, а фоновый воркер еще не закончил обновление выжимки —
   система НЕ заставляет пользователя ждать:
   - Вызывается `preempt_worker_for_session(session_id)`, который мгновенно выставляет `cancel_event.set()`
     и увеличивает `worker_version` (поколение).
   - Старый воркер принудительно сбрасывается и не записывает устаревший результат.
   - Система сразу отвечает на вопрос пользователя, используя последнюю готовую выжимку + свежие сообщения.
   - Только после выдачи ответа запускается новый воркер следующего поколения.
"""

import logging
import re
import threading
import time
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional

from django.db import close_old_connections

from .models import ChatMessage, DialogSession, SystemSettings

logger = logging.getLogger(__name__)


@dataclass
class ActiveWorkerHandle:
    session_id: str
    version: int
    cancel_event: threading.Event
    thread: threading.Thread
    started_at: float


class ContextSummarizerWorkerManager:
    """Менеджер вытесняемых (preemptible) фоновых воркеров суммаризации контекста."""

    def __init__(self):
        self._lock = threading.Lock()
        self._active_workers: Dict[str, ActiveWorkerHandle] = {}
        self._llm_summarizer_fn: Optional[Callable[[str, threading.Event], Optional[str]]] = None

    def register_llm_summarizer(self, fn: Callable[[str, threading.Event], Optional[str]]):
        """Регистрирует опциональную функцию LLM-суммаризации с поддержкой прерывания по cancel_event."""
        self._llm_summarizer_fn = fn

    def preempt_if_running(self, session_id: str) -> bool:
        """
        Принудительно сбрасывает активный фоновый воркер для данной сессии (если он работает),
        не блокируя поток обработки нового вопроса пользователя.
        Возвращает True, если воркер был в процессе работы и принудительно сброшен.
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
                    f"[CONTEXT WORKER] Принудительный сброс воркера сессии {sid}: "
                    "приоритет отдан новому запросу пользователя."
                )
            except Exception as exc:
                logger.warning(f"[CONTEXT WORKER] Ошибка обновления статуса при сбросе: {exc}")

        return was_running

    def start_background_update(self, session_id: str) -> int:
        """
        Запускает фоновый воркер обновления выжимки диалога (и междиалоговой памяти, если включена).
        Если предыдущий воркер еще работал, он сначала принудительно сбрасывается.
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

        worker_thread.start()
        return new_version

    def get_worker_state(self, session_id: str) -> Dict[str, object]:
        sid = str(session_id)
        with self._lock:
            handle = self._active_workers.get(sid)
            is_alive = bool(handle and handle.thread.is_alive() and not handle.cancel_event.is_set())
        return {
            "is_running": is_alive,
            "version": handle.version if handle else 0,
        }

    def _build_fast_structured_digest(
        self,
        messages: List[ChatMessage],
        vehicle_info: str,
        cancel_event: threading.Event,
    ) -> Optional[str]:
        """
        Формирует сверхкомпактную структурированную техническую выжимку диалога
        (автомобиль, жалобы/симптомы, коды DTC, выявленные узлы, прогресс чеклиста).
        На каждом этапе проверяет `cancel_event`, чтобы мгновенно остановиться при новом запросе.
        """
        if cancel_event.is_set():
            return None

        dtc_codes: List[str] = []
        user_symptoms: List[str] = []
        diagnosed_faults: List[str] = []
        completed_steps: List[str] = []
        pending_steps: List[str] = []
        checked_inventory: List[str] = []

        for msg in messages:
            if cancel_event.is_set():
                return None

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
                    user_symptoms.append(clean_q[:140])
            elif msg.role == "assistant" and isinstance(msg.structured_data, dict):
                sdata = msg.structured_data
                for fault in sdata.get("faults", []):
                    f_str = f"{fault.get('code', 'N/A')} ({fault.get('title', '')})"
                    if f_str not in diagnosed_faults:
                        diagnosed_faults.append(f_str)

                for step in sdata.get("repair_steps", []):
                    s_title = f"Шаг {step.get('step_number')}: {step.get('title')}"
                    if step.get("completed"):
                        if s_title not in completed_steps:
                            completed_steps.append(s_title)
                    else:
                        if s_title not in pending_steps:
                            pending_steps.append(s_title)

                for inv in sdata.get("inventory", []):
                    if inv.get("checked"):
                        checked_inventory.append(inv.get("name", ""))

        if cancel_event.is_set():
            return None

        parts: List[str] = []
        if vehicle_info:
            parts.append(f"Автомобиль: {vehicle_info}.")
        if dtc_codes:
            parts.append(f"Коды ошибок (DTC): {', '.join(dtc_codes[:8])}.")
        if user_symptoms:
            parts.append(f"Обращения и симптомы: {' | '.join(user_symptoms[-4:])}.")
        if diagnosed_faults:
            parts.append(f"Установленные неисправности: {'; '.join(diagnosed_faults[:4])}.")
        if completed_steps:
            parts.append(f"Выполнено по чеклисту: {', '.join(completed_steps[:5])}.")
        if pending_steps:
            parts.append(f"Ожидает выполнения: {', '.join(pending_steps[:4])}.")
        if checked_inventory:
            parts.append(f"Подготовлен инструмент/запчасти: {', '.join(checked_inventory[:5])}.")

        base_digest = "\n".join(parts) if parts else "Диалог начат, симптомы уточняются."

        # Если зарегистрирован LLM-суммаризатор и он не заблокирован — можем дополнить выжимку
        if self._llm_summarizer_fn is not None and not cancel_event.is_set():
            try:
                llm_digest = self._llm_summarizer_fn(base_digest, cancel_event)
                if llm_digest and not cancel_event.is_set():
                    return llm_digest
            except Exception:
                pass

        return base_digest

    def _update_cross_dialog_memory(self, cancel_event: threading.Event):
        """
        Обновляет единую междиалоговую выжимку по всем сессиям пользователя,
        если активирована соответствующая настройка `cross_dialog_memory_enabled`.
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
            global_blocks.append(f"• Сессия «{sess.title}» {veh_prefix}: {compact_summary[:260]}")

        if cancel_event.is_set():
            return

        settings_obj.global_memory_summary = "\n".join(global_blocks)
        settings_obj.save(update_fields=["global_memory_summary", "updated_at"])

    def _worker_loop(self, session_id: str, version: int, cancel_event: threading.Event):
        start_ts = time.perf_counter()
        try:
            close_old_connections()

            # Небольшая пауза уступки (50 мс), чтобы отправка HTTP-ответа клиенту завершилась первой
            if cancel_event.wait(timeout=0.05):
                return

            session = DialogSession.objects.filter(pk=session_id).first()
            if not session or session.worker_version != version or cancel_event.is_set():
                return

            messages = list(session.messages.order_by("created_at"))
            digest = self._build_fast_structured_digest(
                messages=messages,
                vehicle_info=session.vehicle_info,
                cancel_event=cancel_event,
            )

            if digest is None or cancel_event.is_set():
                return

            # Повторно проверяем версию перед записью в БД (защита от гонки при новом вопросе)
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

            # Если включена междиалоговая память — обновляем и её
            self._update_cross_dialog_memory(cancel_event)

        except Exception as exc:
            logger.error(f"[CONTEXT WORKER] Ошибка в фоновом воркере сессии {session_id}: {exc}")
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
