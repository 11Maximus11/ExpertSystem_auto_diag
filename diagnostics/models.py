"""
Модели базы данных Django для экспертной системы ИИдеал Авто (AIdeal Auto):
хранение диалогов, фоновых выжимок контекста, междиалоговой памяти,
интерактивных чеклистов ремонта, инвентаря и настроек AirLLM Gemma 4 12B / Vulkan.
"""

import uuid
from django.conf import settings
from django.db import models


class SystemSettings(models.Model):
    """
    Глобальные настройки экспертной системы ИИдеал Авто (AIdeal Auto):
    AirLLM Google Gemma 4 12B (W4A16) + Adaptive GPU VRAM + прямой нативный аудиовход + междиалоговая память.
    """

    BACKEND_CHOICES = [
        ("airllm_vulkan", "AirLLM Adaptive GPU + Layer Offload (Google Gemma 4 12B Unified Multimodal)"),
    ]

    COMPRESSION_CHOICES = [
        ("4bit", "4-bit W4A16 QAT квантование (Оптимально для GPU от 4 до 8+ ГБ VRAM)"),
        ("8bit", "8-bit квантование"),
        ("none", "BF16/FP16 послойная выгрузка через AirLLM"),
    ]

    VOICE_CHOICES = [
        ("direct_audio", "Прямая передача аудиопотока в мультимодальную модель Gemma 4 12B (embed_audio)"),
    ]

    llm_backend = models.CharField(
        max_length=32,
        choices=BACKEND_CHOICES,
        default="airllm_vulkan",
        verbose_name="Бэкенд ИИ и ускорения",
    )
    airllm_model_id = models.CharField(
        max_length=160,
        default="models/gemma-4-12B-it",
        verbose_name="Модель AirLLM (локальный путь или HuggingFace ID)",
    )
    airllm_compression = models.CharField(
        max_length=16,
        choices=COMPRESSION_CHOICES,
        default="4bit",
        verbose_name="Сжатие слоев AirLLM",
    )
    gguf_model_rel_path = models.CharField(
        max_length=255,
        default="models/airllm_shards",
        verbose_name="Директория послойных шардов AirLLM",
    )
    llama_server_url = models.CharField(
        max_length=255,
        default="airllm://local-gpu",
        verbose_name="Внутренний конвейер AirLLM",
    )
    vulkan_gpu_layers = models.IntegerField(
        default=36,
        verbose_name="Макс. резидентных слоев GPU (авто-баланс VRAM, 0..48)",
    )
    context_window_tokens = models.IntegerField(
        default=32768,
        verbose_name="Размер окна контекста (токенов, в разы больше длины ответа ~5000 ток.)",
    )
    cross_dialog_memory_enabled = models.BooleanField(
        default=True,
        verbose_name="Обновлять и использовать краткую выжимку МЕЖДУ диалогами",
    )
    global_memory_summary = models.TextField(
        blank=True,
        default="",
        verbose_name="Глобальная междиалоговая выжимка (профиль авто и история ремонтов)",
    )
    voice_mode = models.CharField(
        max_length=32,
        choices=VOICE_CHOICES,
        default="direct_audio",
        verbose_name="Режим голосового ввода (нативное аудио Gemma 4 12B)",
    )
    strict_json_mode = models.BooleanField(
        default=True,
        verbose_name="Строгий JSON формат ответа и Function Calling",
    )
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "Настройки экспертной системы"
        verbose_name_plural = "Настройки экспертной системы"

    @property
    def model_name(self) -> str:
        return self.airllm_model_id

    @property
    def voice_input_mode(self) -> str:
        return self.voice_mode

    @property
    def max_response_tokens(self) -> int:
        return 5000

    @classmethod
    def get_active(cls) -> "SystemSettings":
        obj, _ = cls.objects.get_or_create(pk=1)
        changed = False
        if not obj.airllm_model_id or "gemma-4" not in obj.airllm_model_id.lower():
            obj.airllm_model_id = "models/gemma-4-12B-it"
            obj.llm_backend = "airllm_vulkan"
            obj.airllm_compression = "4bit"
            obj.vulkan_gpu_layers = 36
            changed = True
        if obj.context_window_tokens < 16384:
            obj.context_window_tokens = 32768
            changed = True
        if obj.voice_mode != "direct_audio":
            obj.voice_mode = "direct_audio"
            changed = True
        if changed:
            obj.save()
        return obj

    @classmethod
    def load(cls) -> "SystemSettings":
        return cls.get_active()


class DiagnosticProject(models.Model):
    """Проект диагностики / автомобиль / заказ-наряд (по аналогии с AIBPMN и emotions_chat)."""
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="diagnostic_projects",
        verbose_name="Владелец проекта",
    )
    name = models.CharField(max_length=200, verbose_name="Название проекта")
    description = models.TextField(blank=True, default="", verbose_name="Описание проекта")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-updated_at"]
        verbose_name = "Проект диагностики"
        verbose_name_plural = "Проекты диагностики"

    def __str__(self) -> str:
        return self.name

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "sessions_count": self.sessions.count(),
            "created_at": self.created_at.strftime("%Y-%m-%d %H:%M"),
            "updated_at": self.updated_at.strftime("%Y-%m-%d %H:%M"),
        }


class DialogSession(models.Model):
    """Сессия диагностики автомобиля с поддержкой проектов, тегов, закрепления и фонового воркера."""

    WORKER_STATUS_CHOICES = [
        ("idle", "Ожидание"),
        ("running", "Фоновое обновление выжимки..."),
        ("aborted_for_priority", "Воркер сброшен (приоритет новому вопросу)"),
        ("completed", "Контекст синхронизирован"),
        ("error", "Ошибка воркера"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="dialog_sessions",
        verbose_name="Владелец сессии",
    )
    project = models.ForeignKey(
        DiagnosticProject,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="sessions",
        verbose_name="Проект",
    )
    title = models.CharField(max_length=200, default="Новая диагностика")
    is_pinned = models.BooleanField(
        default=False,
        verbose_name="Закреплен вверху списка",
    )
    tag = models.CharField(
        max_length=60,
        blank=True,
        default="",
        verbose_name="Тег категории (ДВС, АКПП, Электрика, Тормоза и т.д.)",
    )
    vehicle_info = models.CharField(
        max_length=200,
        blank=True,
        default="",
        help_text="Марка, модель, год выпуска, пробег, тип КПП/ДВС",
    )
    summary = models.TextField(
        blank=True,
        default="",
        help_text="Краткая выжимка по текущему диалогу для динамической оптимизации окна контекста",
    )
    worker_status = models.CharField(
        max_length=32,
        choices=WORKER_STATUS_CHOICES,
        default="idle",
    )
    worker_version = models.IntegerField(
        default=0,
        help_text="Поколение задачи воркера для мгновенного принудительного сброса",
    )
    worker_last_duration_ms = models.IntegerField(default=0)
    attached_dtc_codes = models.JSONField(default=list, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-is_pinned", "-updated_at"]
        verbose_name = "Диагностическая сессия"
        verbose_name_plural = "Диагностические сессии"

    def to_dict(self):
        return {
            "id": str(self.id),
            "title": self.title,
            "is_pinned": self.is_pinned,
            "tag": self.tag,
            "project_id": self.project_id,
            "project_name": self.project.name if self.project else None,
            "vehicle_info": self.vehicle_info,
            "summary": self.summary,
            "worker_status": self.worker_status,
            "worker_version": self.worker_version,
            "attached_dtc_codes": self.attached_dtc_codes,
            "message_count": self.messages.count(),
            "updated_at": self.updated_at.strftime("%d.%m.%Y %H:%M"),
            "created_at": self.created_at.strftime("%d.%m.%Y %H:%M"),
        }

    @property
    def vehicle_context(self) -> str:
        return self.vehicle_info

    @vehicle_context.setter
    def vehicle_context(self, value: str) -> None:
        self.vehicle_info = value

    def __str__(self) -> str:
        return f"{self.title} ({self.id})"


class ChatMessage(models.Model):
    """Сообщение в диалоге с поддержкой структурированного JSON, чекбоксов задач и вложений."""

    ROLE_CHOICES = [
        ("user", "Пользователь"),
        ("assistant", "Эксперт ИИ"),
        ("system", "Система"),
        ("tool", "Вызов инструмента (Function Call)"),
    ]

    session = models.ForeignKey(
        DialogSession,
        on_delete=models.CASCADE,
        related_name="messages",
    )
    role = models.CharField(max_length=16, choices=ROLE_CHOICES)
    content = models.TextField()
    structured_data = models.JSONField(
        null=True,
        blank=True,
        help_text="Валидированный JSON ответ модели: диагноз, инвентарь, чеклист задач, вызовы функций",
    )
    attachments = models.JSONField(
        default=list,
        blank=True,
        help_text="Прикрепленные фотографии, снимки с камеры, документы и аудиозаписи",
    )
    dtc_codes = models.JSONField(
        default=list,
        blank=True,
        help_text="Коды ошибок, прикрепленные к данному сообщению",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at"]
        verbose_name = "Сообщение диагностики"
        verbose_name_plural = "Сообщения диагностики"

    def __str__(self) -> str:
        return f"[{self.role}] {self.content[:50]}"
