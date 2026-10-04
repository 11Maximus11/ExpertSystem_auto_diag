import os
import sys
from django.apps import AppConfig


class DiagnosticsConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "diagnostics"
    verbose_name = "Экспертная автодиагностика и ИИ"

    def ready(self):
        """
        При старте веб-сервиса автоматически предзагружает модель AirLLM (Qwen/Qwen3.5-4B)
        в видеопамять GPU (VRAM), чтобы первый запрос обрабатывался сразу без задержки на инициализацию.
        """
        if os.environ.get("AUTODIAG_FAST_TEST") == "1" or os.environ.get("SKIP_AIRLLM_PRELOAD") == "1":
            return

        argv_lower = [a.lower() for a in sys.argv]
        # Пропускаем служебные одноразовые команды миграций, сборки статики и тестов
        skip_cmds = {"migrate", "makemigrations", "collectstatic", "test", "check", "shell", "dbshell", "createsuperuser"}
        if any(cmd in argv_lower for cmd in skip_cmds):
            return

        # При запуске runserver с автоперезагрузкой (без --noreload) предзагружаем только в рабочем дочернем процессе
        if "runserver" in argv_lower and "--noreload" not in argv_lower:
            if os.environ.get("RUN_MAIN") != "true":
                return

        is_server_process = (
            "runserver" in argv_lower
            or any("gunicorn" in a or "uvicorn" in a or "daphne" in a or "wsgi" in a or "asgi" in a for a in argv_lower)
            or os.environ.get("AUTODIAG_PRELOAD_ON_STARTUP") == "1"
        )
        if is_server_process:
            from .airllm_vulkan_service import orchestrator

            orchestrator.preload_model_on_startup(async_load=False)
