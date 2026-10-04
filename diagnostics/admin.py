from django.contrib import admin
from .models import ChatMessage, DialogSession, SystemSettings


@admin.register(SystemSettings)
class SystemSettingsAdmin(admin.ModelAdmin):
    list_display = (
        "llm_backend",
        "airllm_model_id",
        "airllm_compression",
        "vulkan_gpu_layers",
        "context_window_tokens",
        "cross_dialog_memory_enabled",
        "updated_at",
    )


@admin.register(DialogSession)
class DialogSessionAdmin(admin.ModelAdmin):
    list_display = ("title", "vehicle_info", "worker_status", "worker_version", "updated_at")
    search_fields = ("title", "vehicle_info", "summary")


@admin.register(ChatMessage)
class ChatMessageAdmin(admin.ModelAdmin):
    list_display = ("session", "role", "short_content", "created_at")
    list_filter = ("role", "created_at")

    def short_content(self, obj):
        return obj.content[:80]
