"""
Настройки Django для экспертной системы автодиагностики AutoDiag Pro AI.
Все пути в проекте строго относительные (относительно BASE_DIR).
Поддерживаются Windows, Linux и Docker, ускорение Vulkan и послойный инференс AirLLM (8 ГБ VRAM).
"""

import os
from pathlib import Path
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")

SECRET_KEY = os.environ.get(
    "DJANGO_SECRET_KEY",
    "django-insecure-autodiag-vulkan-airllm-expert-system-2026-key",
)

DEBUG = os.environ.get("DJANGO_DEBUG", "1") in ("1", "true", "True", "yes")

ALLOWED_HOSTS = ["*"]

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "diagnostics",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "autodiag_project.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.debug",
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "autodiag_project.wsgi.application"
ASGI_APPLICATION = "autodiag_project.asgi.application"

# База данных SQLite (относительный путь)
DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": BASE_DIR / "db.sqlite3",
        "OPTIONS": {
            "timeout": 20,
        },
    }
}

AUTH_PASSWORD_VALIDATORS = []

LANGUAGE_CODE = "ru-ru"
TIME_ZONE = "Europe/Moscow"
USE_I18N = True
USE_TZ = True

# Статические и медиа-файлы (все пути относительные)
STATIC_URL = "/static/"
STATICFILES_DIRS = [BASE_DIR / "static"]
STATIC_ROOT = BASE_DIR / "staticfiles"

MEDIA_URL = "/media/"
MEDIA_ROOT = BASE_DIR / "media"

# Ограничения размера загружаемых фото/документов/аудио (до 50 МБ)
DATA_UPLOAD_MAX_MEMORY_SIZE = 52428800
FILE_UPLOAD_MAX_MEMORY_SIZE = 52428800

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# Относительные пути к ресурсам экспертной системы
KB_DATA_PATH = BASE_DIR / "kb_data.json"
DIAGNOSTIC_SAMPLE_PATH = BASE_DIR / "VehicleDiagnosticSample.txt"
MODELS_DIR = BASE_DIR / "models"
GGUF_DEFAULT_MODEL = MODELS_DIR / os.environ.get("GGUF_MODEL_NAME", "gemma-4-12b-it-Q4_K_M.gguf")
AIRLLM_SHARDS_DIR = MODELS_DIR / "airllm_shards"

# Настройки Vulkan и AirLLM под 8 ГБ видеопамяти
VULKAN_ENABLED = os.environ.get("GGML_VULKAN", "1") == "1"
MAX_VRAM_MB = int(os.environ.get("MAX_VRAM_MB", "8192"))
DEFAULT_CTX_SIZE = int(os.environ.get("LLM_CTX_SIZE", "2048"))
AIRLLM_DEFAULT_MODEL = os.environ.get("AIRLLM_MODEL_ID", "Qwen/Qwen2.5-32B-Instruct")
AIRLLM_DEFAULT_COMPRESSION = os.environ.get("AIRLLM_COMPRESSION", "4bit")
