# -*- coding: utf-8 -*-
"""
Конфигурация Gunicorn для сервера экспертной системы «ИИдеал Авто» (AIdeal Auto).
ВАЖНО: используется строго 1 процесс (workers = 1) с многопоточностью (gthread),
чтобы пул резидентных слоев GPU VRAM, фоновые задания (/api/ask/?async=1)
и воркер 32K контекстной памяти оставались едиными без дублирования VRAM.
Лицензия: GNU General Public License v3 (GPL-3.0).
"""

bind = "0.0.0.0:8000"
workers = 1
threads = 8
worker_class = "gthread"
timeout = 300
graceful_timeout = 30
keepalive = 5
max_requests = 0
