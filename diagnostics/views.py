"""
Представления (Views) и API-эндпоинты Django для экспертной системы автодиагностики.
Обеспечивают работу:
- Основного Mobile-First / Desktop интерфейса и PWA (manifest.json, sw.js)
- Специального режима для AR-очков типа RayNeo (плавающие окна + чисто черный фон #000000)
- Мультимодального ввода (текст, фото с камеры/галереи, документы, коды ошибок DTC, голос Gemma 4 Native Audio / Direct)
- Неблокирующего фонового воркера выжимки контекста с принудительным сбросом при новом запросе
- Интерактивных чекбоксов задач ремонта и инвентаря
"""

import base64
import json
import logging
import mimetypes
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from django.conf import settings
from django.contrib.auth import authenticate, get_user_model, login, logout
from django.db import models
from django.http import HttpRequest, HttpResponse, JsonResponse
from django.shortcuts import render
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods

logger = logging.getLogger(__name__)

from .airllm_vulkan_service import orchestrator
from .context_worker import context_worker_manager
from .document_service import (
    AUDIO_EXTENSIONS,
    IMAGE_EXTENSIONS,
    analyze_image_bytes,
    extract_dtc_codes,
    parse_uploaded_document,
)
from .models import ChatMessage, DialogSession, DiagnosticProject, SystemSettings
from .voice_service import process_voice_input


# Временный in-memory буфер ответов для демо-режима (без записи в БД SQLite)
_DEMO_RAM_MESSAGES: Dict[int, Dict[str, Any]] = {}
_DEMO_NEXT_MSG_ID: int = 900000


def _ensure_default_session(user=None) -> DialogSession:
    """
    Гарантирует наличие диагностической сессии для авторизованного пользователя.
    В демо-режиме (без авторизации) возвращает несохраненный объект в памяти, не записывая ничего в БД.
    """
    if user and user.is_authenticated:
        session = DialogSession.objects.filter(user=user).first()
        if not session:
            session = DialogSession.objects.create(
                user=user,
                title="Диагностика #1",
                vehicle_info="",
            )
        return session
    # Демо-режим: не сохраняем сессию в базу данных
    return DialogSession(
        id=uuid.uuid4(),
        title="Демо-диагностика",
        vehicle_info="",
    )


def _bytes_to_base64_data_uri(
    raw_bytes: bytes, filename: str, fallback_mime: str = "application/octet-stream"
) -> Tuple[str, str, str]:
    """
    Кодирует бинарные данные в data: URI base64 для хранения в БД без сохранения файлов на диск сервера.
    Возвращает (data_uri, b64_str, mime_type).
    """
    safe_name = filename or "file.bin"
    mime, _ = mimetypes.guess_type(safe_name)
    if not mime:
        ext = Path(safe_name).suffix.lower()
        if ext in {".webm", ".ogg"}:
            mime = "audio/webm"
        elif ext in {".wav"}:
            mime = "audio/wav"
        elif ext in {".mp3"}:
            mime = "audio/mpeg"
        elif ext in {".m4a"}:
            mime = "audio/mp4"
        elif ext in {".jpg", ".jpeg"}:
            mime = "image/jpeg"
        elif ext in {".png"}:
            mime = "image/png"
        elif ext in {".webp"}:
            mime = "image/webp"
        elif ext in {".gif"}:
            mime = "image/gif"
        elif ext in {".pdf"}:
            mime = "application/pdf"
        elif ext in {".txt", ".log", ".obd", ".ini", ".cfg", ".md"}:
            mime = "text/plain"
        elif ext in {".csv", ".tsv"}:
            mime = "text/csv"
        elif ext in {".json"}:
            mime = "application/json"
        elif ext in {".docx"}:
            mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        elif ext in {".xlsx"}:
            mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        else:
            mime = fallback_mime
    b64_str = base64.b64encode(raw_bytes).decode("utf-8")
    data_uri = f"data:{mime};base64,{b64_str}"
    return data_uri, b64_str, mime


def _save_media_file(raw_bytes: bytes, subdir: str, filename: str) -> Tuple[str, str]:
    """
    Сохраняет вложение напрямую в base64 data URI для хранения в SQLite БД.
    Файлы на диск сервера НЕ сохраняются.
    """
    data_uri, _, _ = _bytes_to_base64_data_uri(raw_bytes, filename)
    return data_uri, ""


def _save_media_bytes(raw_bytes: bytes, subdir: str, filename: str) -> str:
    """Возвращает base64 Data URI для хранения вложения."""
    url, _ = _save_media_file(raw_bytes, subdir, filename)
    return url


def _sanitize_attachment(att: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(att, dict):
        return att
    att = dict(att)
    if "mode" in att:
        mode_val = str(att["mode"])
        if "ggml" in mode_val.lower():
            att["mode"] = "Gemma 4 Native Audio"
    return att


def _sanitize_attachments(attachments: List[Any]) -> List[Any]:
    if not isinstance(attachments, list):
        return attachments or []
    return [_sanitize_attachment(a) for a in attachments]


def index_view(request: HttpRequest) -> HttpResponse:
    """Главная страница экспертной системы (Mobile-First PWA + Desktop + RayNeo AR HUD)."""
    active_settings = SystemSettings.get_active()
    current_user = request.user if request.user.is_authenticated else None
    current_session = _ensure_default_session(user=current_user)

    if current_user:
        sessions = list(DialogSession.objects.filter(user=current_user).select_related("project").all()[:60])
        projects = [
            p.to_dict(include_sessions=True)
            for p in DiagnosticProject.objects.filter(user=current_user).prefetch_related("sessions")
        ]
        all_tags = list(
            DialogSession.objects.filter(user=current_user)
            .exclude(tag="")
            .values_list("tag", flat=True)
            .distinct()
        )
    else:
        # В демо-режиме ничего не храним на сервере и очищаем возможные анонимные записи
        DialogSession.objects.filter(user__isnull=True).delete()
        DiagnosticProject.objects.filter(user__isnull=True).delete()
        sessions = []
        projects = []
        all_tags = []

    systems_list = orchestrator.rag_engine.get_all_systems()
    hw_telemetry = orchestrator.get_hardware_and_model_telemetry(active_settings)
    ar_mode_initial = request.GET.get("mode", "").lower() == "ar"

    context = {
        "active_settings": active_settings,
        "current_session": current_session,
        "sessions": sessions,
        "projects": projects,
        "all_tags": all_tags,
        "systems_list": systems_list,
        "hw_telemetry": hw_telemetry,
        "hw_telemetry_json": json.dumps(hw_telemetry, ensure_ascii=False),
        "ar_mode_initial": ar_mode_initial,
        "current_user": current_user,
        "is_demo": current_user is None,
    }
    return render(request, "diagnostics/index.html", context)


def ar_mode_view(request: HttpRequest) -> HttpResponse:
    """Прямая точка входа в режим AR-очков типа RayNeo (чисто черный прозрачный фон + плавающие окна)."""
    request.GET = request.GET.copy()
    request.GET["mode"] = "ar"
    return index_view(request)


def pwa_manifest_view(request: HttpRequest) -> JsonResponse:
    """Манифест Progressive Web App (PWA) для ИИДЕАЛ АВТО с поддержкой мобильных устройств и AR-очков."""
    manifest = {
        "name": "ИИДЕАЛ АВТО — Экспертная автодиагностика",
        "short_name": "ИИДЕАЛ АВТО",
        "description": "Экспертная ИИ-система диагностики и ремонта автомобилей с режимом AR/VR",
        "start_url": "/",
        "scope": "/",
        "display": "standalone",
        "orientation": "any",
        "background_color": "#090D16",
        "theme_color": "#F97316",
        "lang": "ru-RU",
        "categories": ["automotive", "utilities", "productivity"],
        "icons": [
            {
                "src": "/static/icons/icon-192.svg",
                "sizes": "192x192",
                "type": "image/svg+xml",
                "purpose": "any maskable",
            },
            {
                "src": "/static/icons/icon-512.svg",
                "sizes": "512x512",
                "type": "image/svg+xml",
                "purpose": "any maskable",
            },
        ],
        "shortcuts": [
            {
                "name": "Новая диагностика",
                "short_name": "Диагностика",
                "url": "/",
            },
            {
                "name": "Режим AR HUD",
                "short_name": "AR HUD",
                "url": "/ar/",
            },
        ],
    }
    return JsonResponse(manifest, content_type="application/manifest+json")


def service_worker_view(request: HttpRequest) -> HttpResponse:
    """Service Worker для офлайн-работы PWA и кэширования словаря ошибок и интерфейса."""
    sw_path = Path(settings.BASE_DIR) / "static" / "js" / "sw.js"
    if sw_path.exists():
        content = sw_path.read_text(encoding="utf-8")
    else:
        content = "self.addEventListener('fetch', () => {});"
    response = HttpResponse(content, content_type="application/javascript")
    response["Service-Worker-Allowed"] = "/"
    return response


# =========================================================================
# REST API: Управление проектами диагностики (по образцу AIBPMN)
# =========================================================================
@csrf_exempt
@require_http_methods(["GET", "POST"])
def api_projects(request: HttpRequest) -> JsonResponse:
    """Список проектов диагностики с их чатами и создание нового проекта."""
    user = request.user if request.user.is_authenticated else None
    if request.method == "GET":
        if user:
            projects = DiagnosticProject.objects.filter(user=user).prefetch_related("sessions").all()
            unassigned = DialogSession.objects.filter(user=user, project__isnull=True).all()[:60]
            return JsonResponse({
                "projects": [p.to_dict(include_sessions=True) for p in projects],
                "unassigned_sessions": [s.to_dict() for s in unassigned],
                "is_demo": False,
            })
        return JsonResponse({"projects": [], "unassigned_sessions": [], "is_demo": True})

    try:
        payload = json.loads(request.body.decode("utf-8") or "{}")
    except Exception:
        payload = {}

    name = str(payload.get("name", "")).strip()
    description = str(payload.get("description", "")).strip()

    if not user:
        # В демо-режиме не сохраняем проект в БД
        demo_id = int(uuid.uuid4().int % 900000 + 100000)
        return JsonResponse(
            {
                "id": demo_id,
                "name": name or "Демо-проект",
                "description": description,
                "sessions_count": 0,
                "sessions": [],
                "is_demo": True,
            },
            status=201,
        )

    if not name:
        base_count = DiagnosticProject.objects.filter(user=user).count()
        name = f"Проект #{base_count + 1}"

    proj = DiagnosticProject.objects.create(user=user, name=name, description=description)
    return JsonResponse(proj.to_dict(include_sessions=True), status=201)


@csrf_exempt
@require_http_methods(["GET", "POST", "PATCH", "DELETE"])
def api_project_detail(request: HttpRequest, project_id: int) -> JsonResponse:
    """Детали проекта, переименование (POST/PATCH) или удаление (DELETE) вместе с сессиями."""
    user = request.user if request.user.is_authenticated else None
    if not user:
        if request.method == "DELETE":
            return JsonResponse({"success": True, "deleted_id": project_id, "is_demo": True})
        try:
            payload = json.loads(request.body.decode("utf-8") or "{}")
        except Exception:
            payload = {}
        return JsonResponse({
            "success": True,
            "project": {
                "id": project_id,
                "name": str(payload.get("name", "Демо-проект")).strip()[:200],
                "description": str(payload.get("description", "")).strip(),
                "sessions": [],
                "is_demo": True,
            },
        })

    proj = DiagnosticProject.objects.filter(pk=project_id, user=user).first()
    if not proj:
        return JsonResponse({"error": "Проект не найден"}, status=404)

    if request.method == "GET":
        return JsonResponse({"project": proj.to_dict(include_sessions=True)})

    if request.method == "DELETE":
        for sess in proj.sessions.all():
            context_worker_manager.preempt_if_running(str(sess.id))
        proj.sessions.all().delete()
        proj.delete()
        next_sess = _ensure_default_session(user=user)
        return JsonResponse({
            "success": True,
            "deleted_id": project_id,
            "active_session_id": str(next_sess.id),
        })

    if request.method in ("PATCH", "POST"):
        try:
            payload = json.loads(request.body.decode("utf-8") or "{}")
        except Exception:
            payload = {}
        if "name" in payload:
            proj.name = str(payload["name"]).strip()[:200] or proj.name
        if "description" in payload:
            proj.description = str(payload["description"]).strip()
        proj.save()
        return JsonResponse({"success": True, "project": proj.to_dict(include_sessions=True)})


# =========================================================================
# REST API: Управление сессиями диалогов (Проекты, Теги, Закрепление, Поиск)
# =========================================================================
@csrf_exempt
@require_http_methods(["GET", "POST"])
def api_sessions(request: HttpRequest) -> JsonResponse:
    user = request.user if request.user.is_authenticated else None
    if request.method == "GET":
        if not user:
            return JsonResponse({
                "sessions": [],
                "all_tags": [],
                "projects": [],
                "is_demo": True,
            })

        qs = DialogSession.objects.filter(user=user).select_related("project")
        all_tags = list(
            DialogSession.objects.filter(user=user)
            .exclude(tag="")
            .values_list("tag", flat=True)
            .distinct()
        )
        projects = [
            p.to_dict(include_sessions=True)
            for p in DiagnosticProject.objects.filter(user=user).prefetch_related("sessions")
        ]

        project_id = request.GET.get("project_id")
        if project_id:
            if project_id == "none":
                qs = qs.filter(project__isnull=True)
            elif project_id.isdigit():
                qs = qs.filter(project_id=int(project_id))

        tag = request.GET.get("tag")
        if tag and tag.strip():
            qs = qs.filter(tag__iexact=tag.strip())

        q = request.GET.get("q")
        if q and q.strip():
            qs = qs.filter(
                models.Q(title__icontains=q.strip())
                | models.Q(tag__icontains=q.strip())
                | models.Q(vehicle_info__icontains=q.strip())
            )

        sessions = qs[:60]
        return JsonResponse({
            "sessions": [s.to_dict() for s in sessions],
            "all_tags": all_tags,
            "projects": projects,
            "is_demo": False,
        })

    try:
        payload = json.loads(request.body.decode("utf-8") or "{}")
    except Exception:
        payload = {}

    vehicle_info = str(payload.get("vehicle_info", "")).strip()
    tag = str(payload.get("tag", "")).strip()[:60]
    project_id = payload.get("project_id")

    if not user:
        # Демо-режим: создаем несохраненную сессию только в памяти
        demo_title = str(payload.get("title", "")).strip() or "Демо-диагностика"
        demo_sess = DialogSession(
            id=uuid.uuid4(),
            title=demo_title,
            vehicle_info=vehicle_info,
            tag=tag,
        )
        res = demo_sess.to_dict()
        res["project_id"] = int(project_id) if (project_id and str(project_id).isdigit()) else (project_id or None)
        res["is_demo"] = True
        return JsonResponse(res, status=201)

    count = DialogSession.objects.filter(user=user).count() + 1
    title = str(payload.get("title", "")).strip() or f"Диагностика #{count}"

    project = None
    if project_id and str(project_id).isdigit():
        project = DiagnosticProject.objects.filter(pk=int(project_id), user=user).first()

    session = DialogSession.objects.create(
        user=user,
        title=title,
        vehicle_info=vehicle_info,
        tag=tag,
        project=project,
    )
    return JsonResponse(session.to_dict(), status=201)


@csrf_exempt
@require_http_methods(["GET", "PATCH", "DELETE"])
def api_session_detail(request: HttpRequest, session_id: uuid.UUID) -> JsonResponse:
    user = request.user if request.user.is_authenticated else None
    if user:
        session = DialogSession.objects.select_related("project").filter(pk=session_id, user=user).first()
    else:
        session = DialogSession.objects.select_related("project").filter(pk=session_id).first()

    if not session:
        if not user:
            # Демо-режим: сессия хранится только в браузере клиента
            if request.method == "DELETE":
                return JsonResponse({"deleted": True, "active_session_id": str(uuid.uuid4()), "is_demo": True})
            if request.method == "PATCH":
                try:
                    payload = json.loads(request.body.decode("utf-8") or "{}")
                except Exception:
                    payload = {}
                return JsonResponse({
                    "success": True,
                    "session": {
                        "id": str(session_id),
                        "title": str(payload.get("title", "Демо-диагностика")).strip()[:200],
                        "is_pinned": bool(payload.get("is_pinned", False)),
                        "tag": str(payload.get("tag", "")).strip()[:60],
                        "project_id": payload.get("project_id"),
                        "vehicle_info": str(payload.get("vehicle_info", "")).strip()[:200],
                        "summary": "",
                        "messages": [],
                        "is_demo": True,
                    },
                })
            active_settings = SystemSettings.get_active()
            return JsonResponse({
                "id": str(session_id),
                "title": "Демо-диагностика",
                "is_pinned": False,
                "tag": "",
                "project_id": None,
                "project_name": None,
                "vehicle_info": "",
                "summary": "",
                "worker_status": "idle",
                "worker_version": 0,
                "worker_last_duration_ms": 0,
                "worker_live": {"is_running": False, "version": 0, "dynamic_budget": {}},
                "cross_dialog_memory_enabled": active_settings.cross_dialog_memory_enabled,
                "global_memory_summary": active_settings.global_memory_summary,
                "messages": [],
                "is_demo": True,
            })
        return JsonResponse({"error": "Сессия не найдена"}, status=404)

    if request.method == "DELETE":
        context_worker_manager.preempt_if_running(str(session.id))
        session.delete()
        next_sess = _ensure_default_session(user=user)
        return JsonResponse({"deleted": True, "active_session_id": str(next_sess.id)})

    if request.method == "PATCH":
        try:
            payload = json.loads(request.body.decode("utf-8") or "{}")
        except Exception:
            payload = {}
        if "title" in payload:
            session.title = str(payload["title"]).strip()[:200] or session.title
        if "is_pinned" in payload:
            session.is_pinned = bool(payload["is_pinned"])
        if "tag" in payload:
            session.tag = str(payload["tag"]).strip()[:60]
        if "project_id" in payload:
            p_id = payload["project_id"]
            if p_id is None or p_id == "" or p_id == 0 or p_id == "none":
                session.project = None
            elif str(p_id).isdigit():
                session.project = DiagnosticProject.objects.filter(pk=int(p_id), user=user).first()
        if "vehicle_info" in payload:
            session.vehicle_info = str(payload["vehicle_info"]).strip()[:200]
        if "summary" in payload:
            session.summary = str(payload["summary"]).strip()
        session.save()
        return JsonResponse({"success": True, "session": session.to_dict()})

    # Обработка GET-запроса: детали сессии и список всех сообщений
    messages_data = [
        {
            "id": m.id,
            "role": m.role,
            "content": m.content,
            "structured_data": m.structured_data,
            "attachments": _sanitize_attachments(m.attachments),
            "dtc_codes": m.dtc_codes,
            "created_at": m.created_at.strftime("%H:%M"),
        }
        for m in session.messages.all()
    ]

    active_settings = SystemSettings.get_active()
    worker_live = context_worker_manager.get_worker_state(str(session.id))

    return JsonResponse(
        {
            "id": str(session.id),
            "title": session.title,
            "is_pinned": session.is_pinned,
            "tag": session.tag,
            "project_id": session.project_id,
            "project_name": session.project.name if session.project else None,
            "vehicle_info": session.vehicle_info,
            "summary": session.summary,
            "worker_status": session.worker_status,
            "worker_version": session.worker_version,
            "worker_last_duration_ms": session.worker_last_duration_ms,
            "worker_live": worker_live,
            "cross_dialog_memory_enabled": active_settings.cross_dialog_memory_enabled,
            "global_memory_summary": active_settings.global_memory_summary,
            "messages": messages_data,
        }
    )


@csrf_exempt
@require_http_methods(["POST"])
def api_session_pin(request: HttpRequest, session_id: uuid.UUID) -> JsonResponse:
    """Переключение закрепления чата (Pin/Unpin)."""
    user = request.user if request.user.is_authenticated else None
    session = DialogSession.objects.filter(pk=session_id, user=user).first() if user else DialogSession.objects.filter(pk=session_id).first()
    if not session:
        if not user:
            return JsonResponse({"id": str(session_id), "is_pinned": True, "is_demo": True})
        return JsonResponse({"error": "Сессия не найдена"}, status=404)
    session.is_pinned = not session.is_pinned
    session.save(update_fields=["is_pinned", "updated_at"])
    return JsonResponse({"id": str(session.id), "is_pinned": session.is_pinned})


@csrf_exempt
@require_http_methods(["POST"])
def api_session_tag(request: HttpRequest, session_id: uuid.UUID) -> JsonResponse:
    """Установка или очистка тега чата."""
    user = request.user if request.user.is_authenticated else None
    session = DialogSession.objects.filter(pk=session_id, user=user).first() if user else DialogSession.objects.filter(pk=session_id).first()
    try:
        payload = json.loads(request.body.decode("utf-8") or "{}")
    except Exception:
        payload = {}
    tag = str(payload.get("tag", request.POST.get("tag", ""))).strip()[:60]
    if not session:
        if not user:
            return JsonResponse({"id": str(session_id), "tag": tag, "is_demo": True})
        return JsonResponse({"error": "Сессия не найдена"}, status=404)
    session.tag = tag
    session.save(update_fields=["tag", "updated_at"])
    return JsonResponse({"id": str(session.id), "tag": session.tag})


@csrf_exempt
@require_http_methods(["POST"])
def api_session_rename(request: HttpRequest, session_id: uuid.UUID) -> JsonResponse:
    """Переименование названия чата."""
    user = request.user if request.user.is_authenticated else None
    session = DialogSession.objects.filter(pk=session_id, user=user).first() if user else DialogSession.objects.filter(pk=session_id).first()
    try:
        payload = json.loads(request.body.decode("utf-8") or "{}")
    except Exception:
        payload = {}
    title = str(payload.get("title", request.POST.get("title", ""))).strip()[:200]
    if not session:
        if not user:
            return JsonResponse({"id": str(session_id), "title": title or "Демо-диагностика", "is_demo": True})
        return JsonResponse({"error": "Сессия не найдена"}, status=404)
    if title:
        session.title = title
        session.save(update_fields=["title", "updated_at"])
    return JsonResponse({"id": str(session.id), "title": session.title})


# =========================================================================
# REST API: Статус фонового воркера контекста
# =========================================================================
@require_http_methods(["GET"])
def api_worker_status(request: HttpRequest, session_id: uuid.UUID) -> JsonResponse:
    session = DialogSession.objects.filter(pk=session_id).first()
    if not session:
        return JsonResponse({"error": "Сессия не найдена"}, status=404)

    active_settings = SystemSettings.get_active()
    live = context_worker_manager.get_worker_state(str(session.id))

    return JsonResponse(
        {
            "session_id": str(session.id),
            "worker_status": session.worker_status,
            "worker_version": session.worker_version,
            "worker_last_duration_ms": session.worker_last_duration_ms,
            "is_running": live["is_running"],
            "summary": session.summary,
            "cross_dialog_memory_enabled": active_settings.cross_dialog_memory_enabled,
            "global_memory_summary": active_settings.global_memory_summary,
        }
    )


# =========================================================================
# REST API: Быстрый предпросмотр содержимого технического документа для модели
# =========================================================================
@csrf_exempt
@require_http_methods(["POST"])
def api_preview_document(request: HttpRequest) -> JsonResponse:
    """
    Быстрый предпросмотр извлечённых данных технического документа:
    возвращает текст для модели, режим обработки (full/smart_sampled),
    коды ошибок DTC и миниатюры извлечённых схем/фотографий без создания сообщений в БД.
    """
    uploaded_file = request.FILES.get("file")
    if not uploaded_file:
        return JsonResponse({"error": "Файл не передан"}, status=400)

    f_bytes = uploaded_file.read()
    f_name = uploaded_file.name or "document.txt"
    parsed = parse_uploaded_document(f_bytes, filename=f_name)

    return JsonResponse(
        {
            "filename": f_name,
            "extension": parsed.get("extension", ""),
            "size_bytes": len(f_bytes),
            "char_length": parsed.get("char_length", len(f_bytes)),
            "is_fully_processed": parsed.get("is_fully_processed", True),
            "processing_mode": parsed.get("processing_mode", "full"),
            "detected_dtc_codes": parsed.get("detected_dtc_codes", []),
            "key_metrics": parsed.get("key_metrics", []),
            "llm_ready_text": parsed.get("llm_ready_text", parsed.get("extracted_text", "")),
            "preview_excerpt": parsed.get("preview_excerpt", ""),
            "embedded_images_count": len(parsed.get("embedded_images_data_urls", [])),
            "embedded_images": parsed.get("embedded_images_data_urls", []),
        }
    )


@csrf_exempt
@require_http_methods(["POST"])
def api_transcode_audio(request: HttpRequest) -> JsonResponse:
    """
    Транскодирует любой аудиофайл или запись (WebM, OGG, MP3, WAV, AAC, M4A)
    в чистый стандартный 16-битный PCM WAV моно (16 кГц) для гарантированного
    воспроизведения в любом браузере и точного отображения длительности.
    """
    audio_bytes = None
    filename = "audio.wav"

    if request.FILES.get("file"):
        uploaded = request.FILES["file"]
        audio_bytes = uploaded.read()
        filename = uploaded.name or "audio.wav"
    elif request.FILES.get("audio"):
        uploaded = request.FILES["audio"]
        audio_bytes = uploaded.read()
        filename = uploaded.name or "audio.wav"
    else:
        b64_raw = request.POST.get("audio_b64") or request.POST.get("voice_b64")
        if not b64_raw and request.content_type and "application/json" in request.content_type:
            try:
                body = json.loads(request.body.decode("utf-8") or "{}")
                b64_raw = body.get("audio_b64") or body.get("voice_b64")
                filename = body.get("filename") or filename
            except Exception:
                pass
        if b64_raw:
            raw = b64_raw.split(",", 1)[-1] if "," in b64_raw else b64_raw
            try:
                audio_bytes = base64.b64decode(raw)
            except Exception:
                pass

    if not audio_bytes:
        return JsonResponse({"error": "Аудиофайл не передан"}, status=400)

    voice_res = process_voice_input(
        audio_bytes=audio_bytes,
        filename=filename,
        voice_mode="direct_audio",
    )
    wav_bytes = voice_res.get("wav_bytes") or b""
    duration_sec = voice_res.get("duration_sec", 0.0)
    wav_b64 = base64.b64encode(wav_bytes).decode("ascii") if wav_bytes else ""
    wav_data_url = f"data:audio/wav;base64,{wav_b64}" if wav_b64 else ""

    return JsonResponse(
        {
            "ok": bool(wav_bytes),
            "filename": filename,
            "duration": duration_sec,
            "size_bytes": len(wav_bytes),
            "wav_data_url": wav_data_url,
            "transcript": voice_res.get("transcript", ""),
        }
    )


# =========================================================================
# REST API: Главный эндпоинт диагностики (Текст + Фото + Камера + Документы + DTC + Голос)
# =========================================================================
@csrf_exempt
@require_http_methods(["POST"])
def api_ask_expert(request: HttpRequest) -> JsonResponse:
    """
    Обрабатывает запрос пользователя:
    1. Мгновенно сбрасывает фоновый воркер суммаризации контекста, если тот еще выполняется.
    2. Принимает как multipart/form-data, так и application/json.
    3. В демо-режиме (без авторизации) выполняет полный анализ ИИ и возвращает ответ,
       НЕ сохраняя диалог, сообщения и файлы в БД.
    """
    global _DEMO_NEXT_MSG_ID
    content_type = request.content_type or ""
    demo_history_raw = []
    if "application/json" in content_type:
        try:
            body = json.loads(request.body.decode("utf-8") or "{}")
        except Exception:
            body = {}
        session_id = body.get("session_id")
        query = str(body.get("query", "")).strip()
        vehicle_info = str(body.get("vehicle_info", "")).strip()
        dtc_codes_raw = body.get("dtc_codes", [])
        camera_b64_list = body.get("images_b64", [])
        if body.get("image"):
            camera_b64_list.append(body["image"])
        voice_b64 = body.get("voice_b64", "")
        client_transcript = str(body.get("voice_transcript", "")).strip()
        demo_history_raw = body.get("demo_history", [])
        uploaded_files = []
    else:
        session_id = request.POST.get("session_id")
        query = request.POST.get("query", "").strip()
        vehicle_info = request.POST.get("vehicle_info", "").strip()
        dtc_raw_str = request.POST.get("dtc_codes", "[]")
        try:
            dtc_codes_raw = json.loads(dtc_raw_str) if dtc_raw_str.startswith("[") else [
                c.strip() for c in dtc_raw_str.split(",") if c.strip()
            ]
        except Exception:
            dtc_codes_raw = []
        camera_b64_list = request.POST.getlist("camera_image_b64")
        if not camera_b64_list:
            camera_b64_str = request.POST.get("camera_image_b64", "")
            camera_b64_list = [camera_b64_str] if camera_b64_str else []
        voice_b64 = request.POST.get("voice_b64", "")
        client_transcript = request.POST.get("voice_transcript", "").strip()
        demo_hist_str = request.POST.get("demo_history", "[]")
        try:
            demo_history_raw = json.loads(demo_hist_str) if demo_hist_str else []
        except Exception:
            demo_history_raw = []
        uploaded_files = request.FILES.getlist("attachments")

    user = request.user if request.user.is_authenticated else None
    session = DialogSession.objects.filter(pk=session_id).first() if session_id else None
    if session and user and session.user is None:
        session.user = user
        session.save(update_fields=["user"])

    # Если пользователь не авторизован и сессии нет в БД — работаем в чистом демо-режиме без записи в БД
    is_demo_request = (user is None) and (session is None)

    if not session:
        session = _ensure_default_session(user=user)
        if session_id and is_demo_request:
            try:
                session.id = uuid.UUID(str(session_id))
            except Exception:
                pass

    # ШАГ 1: Мгновенный принудительный сброс старого воркера контекста без ожидания!
    worker_was_preempted = False if is_demo_request else context_worker_manager.preempt_if_running(str(session.id))

    if vehicle_info and vehicle_info != session.vehicle_info:
        session.vehicle_info = vehicle_info
        if not is_demo_request:
            session.save(update_fields=["vehicle_info", "updated_at"])

    active_settings = SystemSettings.get_active()

    # ШАГ 2: Обработка вложений (фото, кадры с камеры, документы, аудио)
    saved_attachments: List[Dict[str, Any]] = []
    image_analyses: List[Dict[str, Any]] = []
    doc_analyses: List[Dict[str, Any]] = []
    voice_info = None

    # 2a. Кадры с встроенной камеры или base64 изображения
    for idx, b64_item in enumerate(camera_b64_list):
        if not b64_item:
            continue
        raw_b64 = b64_item.split(",", 1)[-1] if "," in b64_item else b64_item
        try:
            img_bytes = base64.b64decode(raw_b64)
            fname = f"camera_shot_{idx + 1}.jpg"
            img_analysis = analyze_image_bytes(img_bytes, filename=fname)
            image_analyses.append(img_analysis)
            data_url = img_analysis.get("data_url") or f"data:image/jpeg;base64,{raw_b64}"
            saved_attachments.append(
                {
                    "type": "image",
                    "name": "Снимок камеры",
                    "url": data_url,
                    "base64": raw_b64,
                    "mime_type": "image/jpeg",
                    "size_bytes": len(img_bytes),
                    "clues": img_analysis.get("visual_clues", []),
                }
            )
        except Exception:
            pass

    # 2b. Загруженные файлы (фотографии, документы, логи OBD-II, голосовые файлы)
    for up_file in uploaded_files:
        f_bytes = up_file.read()
        f_name = up_file.name
        ext = Path(f_name).suffix.lower()
        content_type = getattr(up_file, "content_type", "") or ""

        if ext in IMAGE_EXTENSIONS or content_type.startswith("image/"):
            img_analysis = analyze_image_bytes(f_bytes, filename=f_name)
            image_analyses.append(img_analysis)
            data_url = img_analysis.get("data_url")
            if not data_url:
                data_url, b64, mime = _bytes_to_base64_data_uri(f_bytes, f_name, fallback_mime="image/jpeg")
            else:
                b64 = data_url.split(",", 1)[-1] if "," in data_url else base64.b64encode(f_bytes).decode("utf-8")
                mime = "image/jpeg"
            saved_attachments.append(
                {
                    "type": "image",
                    "name": f_name,
                    "url": data_url,
                    "base64": b64,
                    "mime_type": mime,
                    "size_bytes": len(f_bytes),
                    "clues": img_analysis.get("visual_clues", []),
                }
            )
        elif ext in AUDIO_EXTENSIONS or content_type.startswith("audio/"):
            model_name = (
                active_settings.airllm_model_id
                if active_settings.llm_backend == "airllm_vulkan"
                else active_settings.gguf_model_rel_path
            )
            voice_info = process_voice_input(
                audio_bytes=f_bytes,
                filename=f_name,
                voice_mode=active_settings.voice_mode,
                model_name=model_name,
                backend=active_settings.llm_backend,
                client_transcript=client_transcript,
            )
            wav_bytes = voice_info.get("wav_bytes") or f_bytes
            wav_b64 = base64.b64encode(wav_bytes).decode("ascii") if wav_bytes else ""
            wav_data_url = f"data:audio/wav;base64,{wav_b64}" if wav_b64 else ""
            saved_attachments.append(
                {
                    "type": "audio",
                    "name": f_name,
                    "url": wav_data_url,
                    "base64": wav_b64,
                    "mime_type": "audio/wav",
                    "size_bytes": len(wav_bytes),
                    "duration": voice_info.get("duration_sec", 0.0),
                    "mode": voice_info["mode_label"],
                    "transcript": voice_info["transcript"] or f"Прямой аудиовход Gemma 4 ({voice_info.get('duration_sec', 0.0):.1f} с)",
                }
            )
        else:
            doc_analysis = parse_uploaded_document(f_bytes, filename=f_name)
            doc_analyses.append(doc_analysis)
            for idx_emb, emb_b in enumerate(doc_analysis.get("embedded_images_bytes", [])):
                emb_info = analyze_image_bytes(emb_b, filename=f"рис_{idx_emb+1}_{f_name}.jpg")
                image_analyses.append(emb_info)
            data_url, b64, mime = _bytes_to_base64_data_uri(f_bytes, f_name, fallback_mime="application/octet-stream")
            saved_attachments.append(
                {
                    "type": "document",
                    "name": f_name,
                    "url": data_url,
                    "base64": b64,
                    "mime_type": mime,
                    "size_bytes": len(f_bytes),
                    "detected_codes": doc_analysis.get("detected_dtc_codes", []),
                    "metrics": doc_analysis.get("key_metrics", []),
                    "is_fully_processed": doc_analysis.get("is_fully_processed", True),
                    "processing_mode": doc_analysis.get("processing_mode", "full"),
                    "char_length": doc_analysis.get("char_length", len(f_bytes)),
                    "preview_excerpt": doc_analysis.get("preview_excerpt", ""),
                    "extracted_images": doc_analysis.get("embedded_images_data_urls", []),
                }
            )

    # 2c. Голосовой ввод в формате base64 из браузерного диктофона
    if voice_b64:
        raw_vb64 = voice_b64.split(",", 1)[-1] if "," in voice_b64 else voice_b64
        try:
            v_bytes = base64.b64decode(raw_vb64)
            model_name = (
                active_settings.airllm_model_id
                if active_settings.llm_backend == "airllm_vulkan"
                else active_settings.gguf_model_rel_path
            )
            voice_info = process_voice_input(
                audio_bytes=v_bytes,
                filename="voice_query.webm",
                voice_mode=active_settings.voice_mode,
                model_name=model_name,
                backend=active_settings.llm_backend,
                client_transcript=client_transcript,
            )
            wav_bytes = voice_info.get("wav_bytes") or v_bytes
            wav_b64 = base64.b64encode(wav_bytes).decode("ascii") if wav_bytes else raw_vb64
            wav_data_url = f"data:audio/wav;base64,{wav_b64}" if wav_b64 else ""
            saved_attachments.append(
                {
                    "type": "audio",
                    "name": "Голосовой запрос",
                    "url": wav_data_url,
                    "base64": wav_b64,
                    "mime_type": "audio/wav",
                    "size_bytes": len(wav_bytes),
                    "duration": voice_info.get("duration_sec", 0.0),
                    "mode": voice_info["mode_label"],
                    "transcript": voice_info["transcript"] or f"Прямой аудиовход Gemma 4 ({voice_info.get('duration_sec', 0.0):.1f} с)",
                }
            )
        except Exception:
            pass

    # Нормализуем список кодов ошибок DTC
    attached_codes: List[str] = []
    for c in dtc_codes_raw:
        c_up = str(c).strip().upper()
        if c_up and c_up not in attached_codes:
            attached_codes.append(c_up)
    for doc in doc_analyses:
        for c in doc.get("detected_dtc_codes", []):
            if c not in attached_codes:
                attached_codes.append(c)

    # Формируем итоговый текст запроса
    if not query and voice_info and voice_info.get("transcript"):
        query = voice_info["transcript"]
    elif not query and client_transcript:
        query = client_transcript
    if not query and attached_codes:
        query = f"Диагностика и план устранения кодов ошибок: {', '.join(attached_codes)}"
    if not query and voice_info:
        dur = voice_info.get("duration_sec") or 0.0
        query = f"Голосовой запрос мастера ({dur:.1f} с)"
    if not query and image_analyses:
        query = "Визуальная диагностика неисправности автомобиля по прикреплённому фото"
    if not query and doc_analyses:
        query = f"Анализ прикреплённого диагностического документа {doc_analyses[0]['filename']}"

    if not query:
        return JsonResponse({"error": "Пустой запрос. Введите описание, выберите код ошибки или прикрепите фото/голос."}, status=400)

    from django.utils import timezone
    now_hm = timezone.now().strftime("%H:%M")

    if is_demo_request:
        # Демо-режим: собираем несохраненные сообщения контекста из demo_history_raw
        recent_msgs = []
        if isinstance(demo_history_raw, list):
            for h_item in demo_history_raw[-10:]:
                if isinstance(h_item, dict):
                    recent_msgs.append(
                        ChatMessage(
                            session=session,
                            role=str(h_item.get("role", "user")),
                            content=str(h_item.get("content", "")),
                            structured_data=h_item.get("structured_data"),
                            dtc_codes=h_item.get("dtc_codes") or [],
                        )
                    )
        short_title = query[:48] + ("..." if len(query) > 48 else "")
        session.title = short_title

        structured_response = orchestrator.diagnose_and_respond(
            query=query,
            session=session,
            settings_obj=active_settings,
            recent_messages=recent_msgs,
            attached_codes=attached_codes,
            image_analyses=image_analyses,
            doc_analyses=doc_analyses,
            voice_info=voice_info,
        )
        structured_dict = structured_response.model_dump()
        for tc in structured_response.tool_calls:
            logger.debug(f"[Function Calling Debug] fn {tc.tool_name}({tc.arguments}) -> {tc.result_summary}")

        _DEMO_NEXT_MSG_ID += 1
        user_msg_id = _DEMO_NEXT_MSG_ID
        _DEMO_NEXT_MSG_ID += 1
        assistant_msg_id = _DEMO_NEXT_MSG_ID

        assistant_payload = {
            "id": assistant_msg_id,
            "role": "assistant",
            "content": structured_response.mentor_reply,
            "structured_data": structured_dict,
            "dtc_codes": [f.code for f in structured_response.faults],
            "created_at": now_hm,
        }
        # Храним максимум 60 демо-сообщений в оперативной памяти для работы чекбоксов без записи в БД
        if len(_DEMO_RAM_MESSAGES) > 60:
            oldest_key = next(iter(_DEMO_RAM_MESSAGES))
            _DEMO_RAM_MESSAGES.pop(oldest_key, None)
        _DEMO_RAM_MESSAGES[assistant_msg_id] = assistant_payload

        return JsonResponse(
            {
                "session_id": str(session.id),
                "session_title": session.title,
                "worker_preempted": False,
                "worker_version": 0,
                "worker_status": "idle",
                "is_demo": True,
                "user_message": {
                    "id": user_msg_id,
                    "role": "user",
                    "content": query,
                    "attachments": _sanitize_attachments(saved_attachments),
                    "dtc_codes": attached_codes,
                    "created_at": now_hm,
                },
                "assistant_message": assistant_payload,
            }
        )

    # Обновляем заголовок новой сессии по первому осмысленному запросу
    if session.messages.count() == 0 and session.title.startswith("Диагностика #"):
        short_title = query[:48] + ("..." if len(query) > 48 else "")
        session.title = short_title
        session.save(update_fields=["title", "updated_at"])

    # Сохраняем сообщение пользователя
    recent_msgs = list(session.messages.order_by("created_at"))
    user_msg = ChatMessage.objects.create(
        session=session,
        role="user",
        content=query,
        attachments=saved_attachments,
        dtc_codes=attached_codes,
    )

    # ШАГ 3: Генерация строгого JSON ответа через AirLLM / Vulkan + Function Calling
    structured_response = orchestrator.diagnose_and_respond(
        query=query,
        session=session,
        settings_obj=active_settings,
        recent_messages=recent_msgs,
        attached_codes=attached_codes,
        image_analyses=image_analyses,
        doc_analyses=doc_analyses,
        voice_info=voice_info,
    )

    structured_dict = structured_response.model_dump()
    for tc in structured_response.tool_calls:
        logger.debug(f"[Function Calling Debug] fn {tc.tool_name}({tc.arguments}) -> {tc.result_summary}")

    assistant_msg = ChatMessage.objects.create(
        session=session,
        role="assistant",
        content=structured_response.mentor_reply,
        structured_data=structured_dict,
        dtc_codes=[f.code for f in structured_response.faults],
    )

    # ШАГ 4: После ответа пользователю запускаем новый фоновый воркер выжимки контекста!
    new_worker_version = context_worker_manager.start_background_update(str(session.id))

    return JsonResponse(
        {
            "session_id": str(session.id),
            "session_title": session.title,
            "worker_preempted": worker_was_preempted,
            "worker_version": new_worker_version,
            "worker_status": "running",
            "is_demo": False,
            "user_message": {
                "id": user_msg.id,
                "role": "user",
                "content": user_msg.content,
                "attachments": _sanitize_attachments(user_msg.attachments),
                "dtc_codes": user_msg.dtc_codes,
                "created_at": user_msg.created_at.strftime("%H:%M"),
            },
            "assistant_message": {
                "id": assistant_msg.id,
                "role": "assistant",
                "content": assistant_msg.content,
                "structured_data": assistant_msg.structured_data,
                "dtc_codes": assistant_msg.dtc_codes,
                "created_at": assistant_msg.created_at.strftime("%H:%M"),
            },
        }
    )


# =========================================================================
# REST API: Интерактивные чекбоксы задач ремонта и инвентаря (Requirement #8)
# =========================================================================
@csrf_exempt
@require_http_methods(["POST"])
def api_toggle_task(request: HttpRequest, message_id: int) -> JsonResponse:
    """
    Переключает состояние чекбокса пошагового плана ремонта (`step_number`)
    или позиции инвентаря (`inventory_id`) в сообщении эксперта и запускает
    фоновое обновление выжимки диалога, чтобы ИИ знал текущий прогресс ремонта.
    Поддерживает как сообщения в БД, так и in-memory сообщения демо-режима.
    """
    try:
        payload = json.loads(request.body.decode("utf-8") or "{}")
    except Exception:
        payload = {}

    item_type = payload.get("type", "step")  # "step" | "inventory"
    target_id = payload.get("id")
    checked = bool(payload.get("checked", False))

    msg = ChatMessage.objects.filter(pk=message_id).select_related("session").first()
    if not msg or not isinstance(msg.structured_data, dict):
        # Проверяем in-memory буфер демо-режима
        demo_msg = _DEMO_RAM_MESSAGES.get(message_id)
        if demo_msg and isinstance(demo_msg.get("structured_data"), dict):
            sdata = dict(demo_msg["structured_data"])
            if item_type == "step":
                steps = sdata.get("repair_steps", [])
                for step in steps:
                    if str(step.get("step_number")) == str(target_id):
                        step["completed"] = checked
                sdata["repair_steps"] = steps
            elif item_type == "inventory":
                inv_list = sdata.get("inventory", [])
                for inv in inv_list:
                    if str(inv.get("id")) == str(target_id):
                        inv["checked"] = checked
                sdata["inventory"] = inv_list
            demo_msg["structured_data"] = sdata
            total_steps = len(sdata.get("repair_steps", []))
            done_steps = sum(1 for s in sdata.get("repair_steps", []) if s.get("completed"))
            total_inv = len(sdata.get("inventory", []))
            done_inv = sum(1 for i in sdata.get("inventory", []) if i.get("checked"))
            return JsonResponse(
                {
                    "message_id": message_id,
                    "type": item_type,
                    "id": target_id,
                    "checked": checked,
                    "is_demo": True,
                    "progress": {
                        "steps_done": done_steps,
                        "steps_total": total_steps,
                        "inventory_done": done_inv,
                        "inventory_total": total_inv,
                    },
                }
            )
        return JsonResponse({"error": "Сообщение или чеклист не найдены"}, status=404)

    sdata = dict(msg.structured_data)
    if item_type == "step":
        steps = sdata.get("repair_steps", [])
        for step in steps:
            if str(step.get("step_number")) == str(target_id):
                step["completed"] = checked
        sdata["repair_steps"] = steps
    elif item_type == "inventory":
        inv_list = sdata.get("inventory", [])
        for inv in inv_list:
            if str(inv.get("id")) == str(target_id):
                inv["checked"] = checked
        sdata["inventory"] = inv_list

    msg.structured_data = sdata
    msg.save(update_fields=["structured_data"])

    # Запускаем фоновый воркер выжимки, чтобы обновить прогресс чеклиста в памяти диалога
    context_worker_manager.start_background_update(str(msg.session.id))

    total_steps = len(sdata.get("repair_steps", []))
    done_steps = sum(1 for s in sdata.get("repair_steps", []) if s.get("completed"))
    total_inv = len(sdata.get("inventory", []))
    done_inv = sum(1 for i in sdata.get("inventory", []) if i.get("checked"))

    return JsonResponse(
        {
            "message_id": msg.id,
            "type": item_type,
            "id": target_id,
            "checked": checked,
            "progress": {
                "steps_done": done_steps,
                "steps_total": total_steps,
                "inventory_done": done_inv,
                "inventory_total": total_inv,
            },
        }
    )


# =========================================================================
# REST API: Словарь кодов ошибок DTC и эталонная телеметрия (Requirement #6)
# =========================================================================
@require_http_methods(["GET"])
def api_dtc_dictionary(request: HttpRequest) -> JsonResponse:
    q = request.GET.get("q", "").strip()
    system_filter = request.GET.get("system", "all").strip()
    limit = min(150, int(request.GET.get("limit", "80")))

    items = orchestrator.rag_engine.search_dtc_dictionary(
        search_term=q,
        system_filter=system_filter,
        limit=limit,
    )
    systems = orchestrator.rag_engine.get_all_systems()
    return JsonResponse({"items": items, "systems": systems, "total_catalog": len(orchestrator.rag_engine.dtc_catalog)})


@require_http_methods(["GET"])
def api_dtc_detail(request: HttpRequest, code: str) -> JsonResponse:
    details = orchestrator.rag_engine.get_dtc_details(code)
    if not details:
        return JsonResponse({"error": f"Код {code} не найден в словаре"}, status=404)
    return JsonResponse(details)


# =========================================================================
# REST API: Настройки AirLLM, Vulkan, окна контекста и междиалоговой памяти
# =========================================================================
@csrf_exempt
@require_http_methods(["GET", "POST"])
def api_system_settings(request: HttpRequest) -> JsonResponse:
    active = SystemSettings.get_active()

    if request.method == "POST":
        try:
            payload = json.loads(request.body.decode("utf-8") or "{}")
        except Exception:
            payload = {}

        is_demo_req = bool(
            (not request.user.is_authenticated)
            and (payload.get("is_demo") or request.headers.get("X-Demo-Mode") == "1")
        )

        if "llm_backend" in payload:
            active.llm_backend = str(payload["llm_backend"])
        if "airllm_model_id" in payload:
            active.airllm_model_id = str(payload["airllm_model_id"]).strip()
        if "airllm_compression" in payload:
            active.airllm_compression = str(payload["airllm_compression"])
        if "gguf_model_rel_path" in payload:
            active.gguf_model_rel_path = str(payload["gguf_model_rel_path"]).strip()
        if "vulkan_gpu_layers" in payload:
            active.vulkan_gpu_layers = int(payload["vulkan_gpu_layers"])
        if "context_window_tokens" in payload:
            active.context_window_tokens = max(512, min(65536, int(payload["context_window_tokens"])))
        if "cross_dialog_memory_enabled" in payload:
            active.cross_dialog_memory_enabled = bool(payload["cross_dialog_memory_enabled"])
        if "global_memory_summary" in payload:
            active.global_memory_summary = str(payload["global_memory_summary"])
        if "voice_mode" in payload:
            active.voice_mode = str(payload["voice_mode"])
        if "strict_json_mode" in payload:
            active.strict_json_mode = bool(payload["strict_json_mode"])

        if not is_demo_req:
            active.save()

    hw_telemetry = orchestrator.get_hardware_and_model_telemetry(active)
    settings_dict = {
        "llm_backend": active.llm_backend,
        "airllm_model_id": active.airllm_model_id,
        "airllm_compression": active.airllm_compression,
        "gguf_model_rel_path": active.gguf_model_rel_path,
        "llama_server_url": active.llama_server_url,
        "vulkan_gpu_layers": active.vulkan_gpu_layers,
        "context_window_tokens": active.context_window_tokens,
        "cross_dialog_memory_enabled": active.cross_dialog_memory_enabled,
        "global_memory_summary": active.global_memory_summary,
        "voice_mode": active.voice_mode,
        "strict_json_mode": active.strict_json_mode,
    }
    return JsonResponse(
        {
            "success": True,
            "cross_dialog_memory_enabled": active.cross_dialog_memory_enabled,
            "global_memory_summary": active.global_memory_summary,
            "settings": settings_dict,
            "hardware": hw_telemetry,
        }
    )


# =========================================================================
# REST API: Удаление сообщений и очистка контекста LLM (Requirement #5)
# =========================================================================
@csrf_exempt
@require_http_methods(["POST"])
def api_delete_messages(request: HttpRequest) -> JsonResponse:
    """
    Удаляет выбранные сообщения (пользователя и/или модели) из базы данных
    и немедленно исключает их из контекста LLM.
    При delete_all=True полностью очищает историю сессии и сбрасывает summary диалога.
    """
    try:
        payload = json.loads(request.body.decode("utf-8") or "{}")
    except Exception:
        payload = {}

    session_id = payload.get("session_id") or request.POST.get("session_id")
    message_ids = payload.get("message_ids") or request.POST.getlist("message_ids")
    if isinstance(message_ids, str):
        message_ids = [int(m.strip()) for m in message_ids.split(",") if m.strip().isdigit()]
    elif isinstance(message_ids, list):
        message_ids = [int(m) for m in message_ids if str(m).isdigit()]
    else:
        message_ids = []

    delete_all = bool(payload.get("delete_all") or request.POST.get("delete_all") in ("1", "true", "True"))

    session = None
    if session_id:
        session = DialogSession.objects.filter(pk=session_id).first()
    elif message_ids:
        first_msg = ChatMessage.objects.filter(id__in=message_ids).select_related("session").first()
        if first_msg:
            session = first_msg.session

    if not session:
        if not request.user.is_authenticated:
            for mid in message_ids:
                _DEMO_RAM_MESSAGES.pop(mid, None)
            return JsonResponse({
                "success": True,
                "is_demo": True,
                "session_id": str(session_id or ""),
                "deleted_count": len(message_ids),
                "remaining_count": 0,
                "summary": "",
                "session_summary": "",
            })
        return JsonResponse({"error": "Сессия не найдена"}, status=404)

    # Принудительно останавливаем фоновый воркер суммаризации, чтобы исключить конфликты
    context_worker_manager.preempt_if_running(str(session.id))

    deleted_count = 0
    if delete_all:
        deleted_count = session.messages.count()
        session.messages.all().delete()
        session.summary = ""
        session.attached_dtc_codes = []
        session.worker_status = "idle"
        session.save(update_fields=["summary", "attached_dtc_codes", "worker_status", "updated_at"])
    elif message_ids:
        qs = session.messages.filter(id__in=message_ids)
        deleted_count = qs.count()
        qs.delete()

        remaining_count = session.messages.count()
        if remaining_count == 0:
            session.summary = ""
            session.attached_dtc_codes = []
            session.worker_status = "idle"
            session.save(update_fields=["summary", "attached_dtc_codes", "worker_status", "updated_at"])
        else:
            # Немедленно запускаем пересчет выжимки контекста по оставшимся сообщениям
            context_worker_manager.start_background_update(str(session.id))

    return JsonResponse(
        {
            "success": True,
            "session_id": str(session.id),
            "deleted_count": deleted_count,
            "remaining_count": session.messages.count(),
            "summary": session.summary,
            "session_summary": session.summary,
        }
    )


@csrf_exempt
@require_http_methods(["DELETE", "POST"])
def api_delete_single_message(request: HttpRequest, message_id: int) -> JsonResponse:
    """Удаляет одиночное сообщение по ID и немедленно пересчитывает контекст сессии."""
    msg = ChatMessage.objects.filter(pk=message_id).select_related("session").first()
    if not msg:
        if not request.user.is_authenticated:
            _DEMO_RAM_MESSAGES.pop(message_id, None)
            return JsonResponse({
                "success": True,
                "is_demo": True,
                "deleted_id": message_id,
                "remaining_count": 0,
                "summary": "",
                "session_summary": "",
            })
        return JsonResponse({"error": "Сообщение не найдено"}, status=404)

    session = msg.session
    context_worker_manager.preempt_if_running(str(session.id))
    msg.delete()

    remaining_count = session.messages.count()
    if remaining_count == 0:
        session.summary = ""
        session.attached_dtc_codes = []
        session.worker_status = "idle"
        session.save(update_fields=["summary", "attached_dtc_codes", "worker_status", "updated_at"])
    else:
        context_worker_manager.start_background_update(str(session.id))

    return JsonResponse(
        {
            "success": True,
            "deleted_id": message_id,
            "session_id": str(session.id),
            "remaining_count": remaining_count,
            "summary": session.summary,
            "session_summary": session.summary,
        }
    )


# =========================================================================
# REST API: Аутентификация, Регистрация и Профиль пользователя (Requirement #4)
# =========================================================================
@csrf_exempt
@require_http_methods(["POST"])
def api_auth_register(request: HttpRequest) -> JsonResponse:
    """Регистрация нового пользователя (Requirement #4)."""
    try:
        payload = json.loads(request.body.decode("utf-8") or "{}")
    except Exception:
        payload = {}
    username = str(payload.get("username", "")).strip()
    password = str(payload.get("password", "")).strip()
    email = str(payload.get("email", "")).strip()

    if not username or len(username) < 3:
        return JsonResponse({"error": "Логин должен содержать не менее 3 символов"}, status=400)
    if not password or len(password) < 6:
        return JsonResponse({"error": "Пароль должен содержать не менее 6 символов"}, status=400)

    User = get_user_model()
    if User.objects.filter(username__iexact=username).exists():
        return JsonResponse({"error": f"Пользователь с логином '{username}' уже существует"}, status=400)

    try:
        user = User.objects.create_user(username=username, password=password, email=email)
        login(request, user)
        # Создаем для нового пользователя персональный первый диалог
        _ensure_default_session(user=user)
        return JsonResponse({
            "success": True,
            "is_authenticated": True,
            "username": user.username,
            "is_staff": user.is_staff,
            "user": {
                "username": user.username,
                "is_staff": user.is_staff,
            },
        }, status=201)
    except Exception as exc:
        logger.error("Ошибка регистрации пользователя: %s", exc)
        return JsonResponse({"error": f"Ошибка регистрации: {exc}"}, status=500)


@csrf_exempt
@require_http_methods(["POST"])
def api_auth_login(request: HttpRequest) -> JsonResponse:
    """Вход пользователя в систему (Requirement #4)."""
    try:
        payload = json.loads(request.body.decode("utf-8") or "{}")
    except Exception:
        payload = {}
    username = str(payload.get("username", "")).strip()
    password = str(payload.get("password", "")).strip()

    if not username or not password:
        return JsonResponse({"error": "Введите имя пользователя и пароль"}, status=400)

    user = authenticate(request, username=username, password=password)
    if user is None:
        return JsonResponse({"error": "Неверное имя пользователя или пароль"}, status=401)

    login(request, user)
    _ensure_default_session(user=user)
    return JsonResponse({
        "success": True,
        "is_authenticated": True,
        "username": user.username,
        "is_staff": user.is_staff,
        "user": {
            "username": user.username,
            "is_staff": user.is_staff,
        },
    })


@csrf_exempt
@require_http_methods(["POST"])
def api_auth_logout(request: HttpRequest) -> JsonResponse:
    """Выход из аккаунта (Requirement #4)."""
    logout(request)
    return JsonResponse({"success": True, "is_authenticated": False})


@require_http_methods(["GET"])
def api_auth_status(request: HttpRequest) -> JsonResponse:
    """Текущий статус авторизации пользователя."""
    is_auth = request.user.is_authenticated
    return JsonResponse({
        "is_authenticated": is_auth,
        "username": request.user.username if is_auth else "",
        "is_staff": request.user.is_staff if is_auth else False,
    })


@csrf_exempt
@require_http_methods(["POST", "DELETE"])
def api_auth_delete_account(request: HttpRequest) -> JsonResponse:
    """Удаление аккаунта текущего пользователя вместе со всеми его проектами и диалогами."""
    if not request.user.is_authenticated:
        return JsonResponse({"error": "Необходима авторизация для удаления аккаунта"}, status=401)

    user = request.user
    username = user.username
    for sess in DialogSession.objects.filter(user=user):
        context_worker_manager.preempt_if_running(str(sess.id))
    DialogSession.objects.filter(user=user).delete()
    DiagnosticProject.objects.filter(user=user).delete()
    logout(request)
    user.delete()
    logger.info("Аккаунт пользователя '%s' и все его данные успешно удалены.", username)
    return JsonResponse({"success": True, "is_authenticated": False, "deleted_username": username})

