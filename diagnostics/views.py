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


def _ensure_default_session(user=None) -> DialogSession:
    """Гарантирует наличие хотя бы одной диагностической сессии для пользователя."""
    if user and user.is_authenticated:
        session = DialogSession.objects.filter(user=user).first()
        if not session:
            session = DialogSession.objects.create(
                user=user,
                title="Диагностика #1",
                vehicle_info="",
            )
        return session
    session = DialogSession.objects.filter(user__isnull=True).first()
    if not session:
        session = DialogSession.objects.create(
            title="Диагностика #1",
            vehicle_info="",
        )
    return session


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
        sessions = list(DialogSession.objects.filter(user=current_user).select_related("project").all()[:40])
        projects = [p.to_dict() for p in DiagnosticProject.objects.filter(user=current_user)]
        all_tags = list(DialogSession.objects.filter(user=current_user).exclude(tag="").values_list("tag", flat=True).distinct())
    else:
        sessions = list(DialogSession.objects.filter(user__isnull=True).select_related("project").all()[:40])
        projects = [p.to_dict() for p in DiagnosticProject.objects.filter(user__isnull=True)]
        all_tags = list(DialogSession.objects.filter(user__isnull=True).exclude(tag="").values_list("tag", flat=True).distinct())

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
    }
    return render(request, "diagnostics/index.html", context)


def ar_mode_view(request: HttpRequest) -> HttpResponse:
    """Прямая точка входа в режим AR-очков типа RayNeo (чисто черный прозрачный фон + плавающие окна)."""
    request.GET = request.GET.copy()
    request.GET["mode"] = "ar"
    return index_view(request)


def pwa_manifest_view(request: HttpRequest) -> JsonResponse:
    """Манифест Progressive Web App (PWA) для ИИдеал Авто с поддержкой мобильных устройств и AR-очков."""
    manifest = {
        "name": "ИИдеал Авто (AIdeal Auto) — Экспертная автодиагностика (Vulkan + AirLLM Gemma 4 12B)",
        "short_name": "ИИдеал Авто",
        "description": "Экспертная ИИ-система диагностики и ремонта автомобилей на базе Gemma 4 12B с режимом AR-очков",
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
                "name": "Режим AR-очков RayNeo",
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
# REST API: Управление проектами диагностики (Requirement #2)
# =========================================================================
@csrf_exempt
@require_http_methods(["GET", "POST"])
def api_projects(request: HttpRequest) -> JsonResponse:
    """Список проектов диагностики и создание нового проекта."""
    user = request.user if request.user.is_authenticated else None
    if request.method == "GET":
        if user:
            projects = DiagnosticProject.objects.filter(user=user).prefetch_related("sessions").all()
        else:
            projects = DiagnosticProject.objects.filter(user__isnull=True).prefetch_related("sessions").all()
        return JsonResponse({"projects": [p.to_dict() for p in projects]})

    try:
        payload = json.loads(request.body.decode("utf-8") or "{}")
    except Exception:
        payload = {}

    name = str(payload.get("name", "")).strip()
    if not name:
        base_count = DiagnosticProject.objects.filter(user=user).count() if user else DiagnosticProject.objects.count()
        name = f"Проект #{base_count + 1}"
    description = str(payload.get("description", "")).strip()

    proj = DiagnosticProject.objects.create(user=user, name=name, description=description)
    return JsonResponse(proj.to_dict(), status=201)


@csrf_exempt
@require_http_methods(["GET", "PATCH", "DELETE"])
def api_project_detail(request: HttpRequest, project_id: int) -> JsonResponse:
    """Детали проекта, переименование или удаление."""
    user = request.user if request.user.is_authenticated else None
    if user:
        proj = DiagnosticProject.objects.filter(pk=project_id, user=user).first()
    else:
        proj = DiagnosticProject.objects.filter(pk=project_id).first()
    if not proj:
        return JsonResponse({"error": "Проект не найден"}, status=404)

    if request.method == "GET":
        data = proj.to_dict()
        data["sessions"] = [s.to_dict() for s in proj.sessions.all()]
        return JsonResponse({"project": data})

    if request.method == "DELETE":
        proj.delete()
        return JsonResponse({"success": True, "deleted_id": project_id})

    if request.method == "PATCH":
        try:
            payload = json.loads(request.body.decode("utf-8") or "{}")
        except Exception:
            payload = {}
        if "name" in payload:
            proj.name = str(payload["name"]).strip()[:200] or proj.name
        if "description" in payload:
            proj.description = str(payload["description"]).strip()
        proj.save()
        return JsonResponse({"success": True, "project": proj.to_dict()})


# =========================================================================
# REST API: Управление сессиями диалогов (Проекты, Теги, Закрепление, Поиск)
# =========================================================================
@csrf_exempt
@require_http_methods(["GET", "POST"])
def api_sessions(request: HttpRequest) -> JsonResponse:
    user = request.user if request.user.is_authenticated else None
    if request.method == "GET":
        if user:
            qs = DialogSession.objects.filter(user=user).select_related("project")
            all_tags = list(DialogSession.objects.filter(user=user).exclude(tag="").values_list("tag", flat=True).distinct())
            projects = [p.to_dict() for p in DiagnosticProject.objects.filter(user=user)]
        else:
            qs = DialogSession.objects.filter(user__isnull=True).select_related("project")
            all_tags = list(DialogSession.objects.filter(user__isnull=True).exclude(tag="").values_list("tag", flat=True).distinct())
            projects = [p.to_dict() for p in DiagnosticProject.objects.filter(user__isnull=True)]

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
        })

    try:
        payload = json.loads(request.body.decode("utf-8") or "{}")
    except Exception:
        payload = {}

    count = (DialogSession.objects.filter(user=user).count() if user else DialogSession.objects.count()) + 1
    title = str(payload.get("title", "")).strip() or f"Диагностика #{count}"
    vehicle_info = str(payload.get("vehicle_info", "")).strip() or "Автомобиль OBD-II"
    tag = str(payload.get("tag", "")).strip()[:60]

    project_id = payload.get("project_id")
    project = None
    if project_id and str(project_id).isdigit():
        if user:
            project = DiagnosticProject.objects.filter(pk=int(project_id), user=user).first()
        else:
            project = DiagnosticProject.objects.filter(pk=int(project_id)).first()

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
        if not session:
            # При необходимости связываем ничейную сессию с авторизованным пользователем
            session = DialogSession.objects.select_related("project").filter(pk=session_id, user__isnull=True).first()
            if session:
                session.user = user
                session.save(update_fields=["user"])
    else:
        session = DialogSession.objects.select_related("project").filter(pk=session_id).first()

    if not session:
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
                session.project = DiagnosticProject.objects.filter(pk=int(p_id)).first()
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
    session = DialogSession.objects.filter(pk=session_id).first()
    if not session:
        return JsonResponse({"error": "Сессия не найдена"}, status=404)
    session.is_pinned = not session.is_pinned
    session.save(update_fields=["is_pinned", "updated_at"])
    return JsonResponse({"id": str(session.id), "is_pinned": session.is_pinned})


@csrf_exempt
@require_http_methods(["POST"])
def api_session_tag(request: HttpRequest, session_id: uuid.UUID) -> JsonResponse:
    """Установка или очистка тега чата."""
    session = DialogSession.objects.filter(pk=session_id).first()
    if not session:
        return JsonResponse({"error": "Сессия не найдена"}, status=404)
    try:
        payload = json.loads(request.body.decode("utf-8") or "{}")
    except Exception:
        payload = {}
    tag = str(payload.get("tag", request.POST.get("tag", ""))).strip()[:60]
    session.tag = tag
    session.save(update_fields=["tag", "updated_at"])
    return JsonResponse({"id": str(session.id), "tag": session.tag})


@csrf_exempt
@require_http_methods(["POST"])
def api_session_rename(request: HttpRequest, session_id: uuid.UUID) -> JsonResponse:
    """Переименование названия чата."""
    session = DialogSession.objects.filter(pk=session_id).first()
    if not session:
        return JsonResponse({"error": "Сессия не найдена"}, status=404)
    try:
        payload = json.loads(request.body.decode("utf-8") or "{}")
    except Exception:
        payload = {}
    title = str(payload.get("title", request.POST.get("title", ""))).strip()[:200]
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
# REST API: Главный эндпоинт диагностики (Текст + Фото + Камера + Документы + DTC + Голос)
# =========================================================================
@csrf_exempt
@require_http_methods(["POST"])
def api_ask_expert(request: HttpRequest) -> JsonResponse:
    """
    Обрабатывает запрос пользователя:
    1. Мгновенно сбрасывает фоновый воркер суммаризации контекста, если тот еще выполняется
       (Requirement #3 — не заставляем пользователя ждать!).
    2. Принимает как multipart/form-data, так и application/json.
    3. Выполняет анализ фото/документов/голоса, запускает Function Calling + AirLLM/Vulkan,
       возвращает строгий JSON с инвентарем и чекбоксами задач.
    4. Запускает новый фоновый воркер выжимки контекста.
    """
    content_type = request.content_type or ""
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
        uploaded_files = request.FILES.getlist("attachments")

    user = request.user if request.user.is_authenticated else None
    session = DialogSession.objects.filter(pk=session_id).first() if session_id else None
    if session and user and session.user is None:
        session.user = user
        session.save(update_fields=["user"])
    if not session:
        session = _ensure_default_session(user=user)

    # ШАГ 1 (Requirement #3): Мгновенный принудительный сброс старого воркера контекста без ожидания!
    worker_was_preempted = context_worker_manager.preempt_if_running(str(session.id))

    if vehicle_info and vehicle_info != session.vehicle_info:
        session.vehicle_info = vehicle_info
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
            data_url, b64, mime = _bytes_to_base64_data_uri(f_bytes, f_name, fallback_mime="audio/webm")
            saved_attachments.append(
                {
                    "type": "audio",
                    "name": f_name,
                    "url": data_url,
                    "base64": b64,
                    "mime_type": mime,
                    "size_bytes": len(f_bytes),
                    "mode": voice_info["mode_label"],
                    "transcript": voice_info["transcript"] or f"Прямой аудиовход 16 кГц ({voice_info.get('duration_sec', 0.0):.1f} с)",
                }
            )
        else:
            doc_analysis = parse_uploaded_document(f_bytes, filename=f_name)
            doc_analyses.append(doc_analysis)
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
                }
            )

    # 2c. Голосовой ввод в формате base64 из браузерного диктофона
    if voice_b64:
        raw_vb64 = voice_b64.split(",", 1)[-1] if "," in voice_b64 else voice_b64
        try:
            v_bytes = base64.b64decode(raw_vb64)
            data_url = voice_b64 if voice_b64.startswith("data:") else f"data:audio/webm;base64,{raw_vb64}"
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
            saved_attachments.append(
                {
                    "type": "audio",
                    "name": "Голосовой запрос",
                    "url": data_url,
                    "base64": raw_vb64,
                    "mime_type": "audio/webm",
                    "size_bytes": len(v_bytes),
                    "mode": voice_info["mode_label"],
                    "transcript": voice_info["transcript"] or f"Прямой аудиовход 16 кГц ({voice_info.get('duration_sec', 0.0):.1f} с)",
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
        query = f"Голосовой запрос / аудиозапись ({dur:.1f} с)"
    if not query and image_analyses:
        query = "Визуальная диагностика неисправности автомобиля по прикреплённому фото"
    if not query and doc_analyses:
        query = f"Анализ прикреплённого диагностического документа {doc_analyses[0]['filename']}"

    if not query:
        return JsonResponse({"error": "Пустой запрос. Введите описание, выберите код ошибки или прикрепите фото/голос."}, status=400)

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

    # ШАГ 4 (Requirement #3): После ответа пользователю запускаем новый фоновый воркер выжимки контекста!
    new_worker_version = context_worker_manager.start_background_update(str(session.id))

    return JsonResponse(
        {
            "session_id": str(session.id),
            "session_title": session.title,
            "worker_preempted": worker_was_preempted,
            "worker_version": new_worker_version,
            "worker_status": "running",
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
    """
    msg = ChatMessage.objects.filter(pk=message_id).select_related("session").first()
    if not msg or not isinstance(msg.structured_data, dict):
        return JsonResponse({"error": "Сообщение или чеклист не найдены"}, status=404)

    try:
        payload = json.loads(request.body.decode("utf-8") or "{}")
    except Exception:
        payload = {}

    item_type = payload.get("type", "step")  # "step" | "inventory"
    target_id = payload.get("id")
    checked = bool(payload.get("checked", False))

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
            active.context_window_tokens = max(512, min(16384, int(payload["context_window_tokens"])))
        if "cross_dialog_memory_enabled" in payload:
            active.cross_dialog_memory_enabled = bool(payload["cross_dialog_memory_enabled"])
        if "global_memory_summary" in payload:
            active.global_memory_summary = str(payload["global_memory_summary"])
        if "voice_mode" in payload:
            active.voice_mode = str(payload["voice_mode"])
        if "strict_json_mode" in payload:
            active.strict_json_mode = bool(payload["strict_json_mode"])

        active.save()

    hw_telemetry = orchestrator.get_hardware_and_model_telemetry(active)
    return JsonResponse(
        {
            "settings": {
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
            },
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
