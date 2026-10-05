"""Маршруты приложения diagnostics."""
from django.urls import path
from . import views

urlpatterns = [
    path("", views.index_view, name="index"),
    path("ar/", views.ar_mode_view, name="ar_mode"),
    path("manifest.json", views.pwa_manifest_view, name="pwa_manifest"),
    path("sw.js", views.service_worker_view, name="service_worker"),
    # API сессий и фонового воркера контекста
    path("api/sessions/", views.api_sessions, name="api_sessions"),
    path("api/sessions/<uuid:session_id>/", views.api_session_detail, name="api_session_detail"),
    path("api/worker-status/<uuid:session_id>/", views.api_worker_status, name="api_worker_status"),
    # Главный API диагностики, чеклистов и удаления сообщений
    path("api/ask/", views.api_ask_expert, name="api_ask_expert"),
    path("api/messages/delete/", views.api_delete_messages, name="api_delete_messages"),
    path("api/messages/<int:message_id>/delete/", views.api_delete_single_message, name="api_delete_single_message"),
    path("api/messages/<int:message_id>/", views.api_delete_single_message, name="api_delete_single_message_direct"),
    path("api/messages/<int:message_id>/toggle-task/", views.api_toggle_task, name="api_toggle_task"),
    # API словаря кодов ошибок (DTC) и телеметрии
    path("api/dtc/", views.api_dtc_dictionary, name="api_dtc_dictionary"),
    path("api/dtc/<str:code>/", views.api_dtc_detail, name="api_dtc_detail"),
    # API настроек Vulkan / AirLLM / Междиалоговой памяти
    path("api/settings/", views.api_system_settings, name="api_system_settings"),
]
