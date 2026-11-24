"""
CORS Middleware для экспертной системы ИИдеал-Авто.
Обеспечивает обработку preflight OPTIONS запросов и добавление заголовков
Access-Control для взаимодействия локального веб-приложения (lecodes_webapp)
на портах 3000, 5173, 8080 или любых других с Django REST API.
"""

import re
from typing import Callable
from django.conf import settings
from django.http import HttpRequest, HttpResponse


class CorsMiddleware:
    """
    Легковесный middleware кросс-доменных запросов (CORS) и проброса X-Session-Key
    для нативных клиентов (Android/iOS без браузерного CookieJar).
    Работает без внешних зависимостей.
    """

    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]):
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        origin = request.headers.get("Origin", "*")

        # Проброс токен-ключа сессии из заголовка для нативных мобильных клиентов до SessionMiddleware
        session_key = (request.headers.get("X-Session-Key") or "").strip()
        if not session_key:
            auth_hdr = (request.headers.get("Authorization") or "").strip()
            if auth_hdr.lower().startswith("bearer "):
                session_key = auth_hdr[7:].strip()
        if session_key and re.fullmatch(r"[A-Za-z0-9_-]{8,128}", session_key):
            request.COOKIES[settings.SESSION_COOKIE_NAME] = session_key

        # Немедленный ответ на Preflight OPTIONS запросы до других middleware
        if request.method == "OPTIONS":
            response = HttpResponse(status=204)
            self._apply_cors_headers(response, origin)
            return response

        response = self.get_response(request)
        self._apply_cors_headers(response, origin)
        return response

    def _apply_cors_headers(self, response: HttpResponse, origin: str) -> None:
        # Если передан Origin клиента, возвращаем его для поддержки credentials, иначе *
        allow_origin = origin if origin and origin != "null" else "*"
        response["Access-Control-Allow-Origin"] = allow_origin
        response["Access-Control-Allow-Methods"] = "GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD"
        response["Access-Control-Allow-Headers"] = (
            "Content-Type, Authorization, X-Session-Key, X-Requested-With, X-CSRFToken, "
            "X-Demo-Mode, Accept, Origin, Range, Cache-Control"
        )
        response["Access-Control-Expose-Headers"] = "Content-Length, Content-Range, Content-Disposition"
        response["Access-Control-Max-Age"] = "86400"
        if allow_origin != "*":
            response["Access-Control-Allow-Credentials"] = "true"
