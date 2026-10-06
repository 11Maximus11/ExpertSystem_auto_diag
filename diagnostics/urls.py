"""Маршруты приложения diagnostics."""
from django.urls import path
from . import views

urlpatterns = [
    path("", views.index_view, name="index"),
    path("ar/", views.ar_mode_view, name="ar_mode"),
    path("manifest.json", views.pwa_manifest_view, name="pwa_manifest"),
    path("sw.js", views.service_worker_view, name="service_worker"),
    # API проектов диагностики и сессий (Requirement #2)
    path("api/projects/", views.api_projects, name="api_projects"),
    path("api/projects/<int:project_id>/", views.api_project_detail, name="api_project_detail"),
    path("api/sessions/", views.api_sessions, name="api_sessions"),
    path("api/sessions/<uuid:session_id>/", views.api_session_detail, name="api_session_detail"),
    path("api/sessions/<uuid:session_id>/pin/", views.api_session_pin, name="api_session_pin"),
    path("api/sessions/<uuid:session_id>/tag/", views.api_session_tag, name="api_session_tag"),
    path("api/sessions/<uuid:session_id>/rename/", views.api_session_rename, name="api_session_rename"),
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
    path("api/preview-document/", views.api_preview_document, name="api_preview_document"),
    # API авторизации и пользователей (Requirement #4)
    path("api/auth/register/", views.api_auth_register, name="api_auth_register"),
    path("api/auth/login/", views.api_auth_login, name="api_auth_login"),
    path("api/auth/logout/", views.api_auth_logout, name="api_auth_logout"),
    path("api/auth/status/", views.api_auth_status, name="api_auth_status"),
    path("api/auth/delete-account/", views.api_auth_delete_account, name="api_auth_delete_account"),
]
