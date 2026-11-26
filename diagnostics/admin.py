from django.contrib import admin
from .models import ChatMessage, DialogSession, DiagnosticProject, SystemSettings, UserMemorySettings


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


@admin.register(UserMemorySettings)
class UserMemorySettingsAdmin(admin.ModelAdmin):
    list_display = (
        "user",
        "cross_dialog_memory_enabled",
        "memory_cleared_at",
        "updated_at",
    )
    list_filter = ("cross_dialog_memory_enabled",)
    search_fields = ("user__username", "global_memory_summary")


@admin.register(DiagnosticProject)
class DiagnosticProjectAdmin(admin.ModelAdmin):
    list_display = ("name", "user", "updated_at")
    search_fields = ("name", "description", "user__username")


@admin.register(DialogSession)
class DialogSessionAdmin(admin.ModelAdmin):
    list_display = ("title", "user", "vehicle_info", "worker_status", "worker_version", "updated_at")
    search_fields = ("title", "vehicle_info", "summary", "user__username")


@admin.register(ChatMessage)
class ChatMessageAdmin(admin.ModelAdmin):
    list_display = ("session", "role", "short_content", "created_at")
    list_filter = ("role", "created_at")

    def short_content(self, obj):
        return obj.content[:80]
