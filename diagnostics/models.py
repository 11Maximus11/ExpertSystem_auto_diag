"""
Модели базы данных Django для хранения диалогов, фоновых выжимок контекста,
междиалоговой памяти, интерактивных чеклистов ремонта, инвентаря и настроек AirLLM / Vulkan.
"""

import uuid
from django.db import models


class SystemSettings(models.Model):
    """Глобальные настройки экспертной системы и управления 8 ГБ видеопамяти."""

    BACKEND_CHOICES = [
        ("airllm_vulkan", "AirLLM Adaptive GPU + Layer Offload (Qwen 3.5 9B Vision-Language)"),
    ]

    COMPRESSION_CHOICES = [
        ("4bit", "4-bit NF4 квантование (Оптимально для GPU от 4 до 8+ ГБ VRAM)"),
        ("8bit", "8-bit квантование"),
        ("none", "BF16/FP16 послойная выгрузка через AirLLM"),
    ]

    VOICE_CHOICES = [
        ("auto", "Авто (Прямое аудио при поддержке модели / иначе GGML Whisper)"),
        ("direct_audio", "Прямая передача аудиопотока в мультимодальную модель"),
        ("ggml_whisper", "Локальное распознавание речи GGML (Whisper.cpp / Faster-Whisper)"),
    ]

    llm_backend = models.CharField(
        max_length=32,
        choices=BACKEND_CHOICES,
        default="airllm_vulkan",
        verbose_name="Бэкенд ИИ и ускорения",
    )
    airllm_model_id = models.CharField(
        max_length=160,
        default="models/Qwen3.5-4B",
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
        default=32,
        verbose_name="Макс. резидентных слоев GPU (авто-баланс VRAM)",
    )
    context_window_tokens = models.IntegerField(
        default=6144,
        verbose_name="Размер окна контекста (токенов)",
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
        default="auto",
        verbose_name="Режим голосового ввода",
    )
    strict_json_mode = models.BooleanField(
        default=True,
        verbose_name="Строгий JSON формат ответа и Function Calling",
    )
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "Настройки экспертной системы"
        verbose_name_plural = "Настройки экспертной системы"

    @classmethod
    def get_active(cls) -> "SystemSettings":
        obj, _ = cls.objects.get_or_create(pk=1)
        if obj.context_window_tokens < 6144:
            obj.context_window_tokens = 6144
            obj.save(update_fields=["context_window_tokens", "updated_at"])
        return obj


class DialogSession(models.Model):
    """Сессия диагностики автомобиля с поддержкой фонового воркера выжимки контекста."""

    WORKER_STATUS_CHOICES = [
        ("idle", "Ожидание"),
        ("running", "Фоновое обновление выжимки..."),
        ("aborted_for_priority", "Воркер сброшен (приоритет новому вопросу)"),
        ("completed", "Контекст синхронизирован"),
        ("error", "Ошибка воркера"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    title = models.CharField(max_length=200, default="Новая диагностика")
    vehicle_info = models.CharField(
        max_length=200,
        blank=True,
        default="",
        help_text="Марка, модель, год выпуска, пробег, тип КПП/ДВС",
    )
    summary = models.TextField(
        blank=True,
        default="",
        help_text="Краткая выжимка по текущему диалогу для экономии окна контекста",
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
        ordering = ["-updated_at"]
        verbose_name = "Диагностическая сессия"
        verbose_name_plural = "Диагностические сессии"

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
