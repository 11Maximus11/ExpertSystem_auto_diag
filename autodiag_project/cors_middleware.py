"""
CORS Middleware для экспертной системы ИИдеал-Авто.
Обеспечивает обработку preflight OPTIONS запросов и добавление заголовков
Access-Control для взаимодействия локального веб-приложения (lecodes_webapp)
на портах 3000, 5173, 8080 или любых других с Django REST API.
"""

from typing import Callable
from django.http import HttpRequest, HttpResponse


class CorsMiddleware:
    """
    Легковесный middleware кросс-доменных запросов (CORS).
    Работает без внешних зависимостей.
    """

    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]):
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        origin = request.headers.get("Origin", "*")

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
            "Content-Type, Authorization, X-Requested-With, X-CSRFToken, "
            "X-Demo-Mode, Accept, Origin, Range, Cache-Control"
        )
        response["Access-Control-Expose-Headers"] = "Content-Length, Content-Range, Content-Disposition"
        response["Access-Control-Max-Age"] = "86400"
        if allow_origin != "*":
            response["Access-Control-Allow-Credentials"] = "true"
