# -*- coding: utf-8 -*-
"""
Конфигурация Gunicorn для многопоточного высоконагруженного сервера экспертной системы «ИИдеал Авто» (AIdeal Auto).
Лицензия: GNU General Public License v3 (GPL-3.0).
"""

bind = "0.0.0.0:8000"
workers = 4
threads = 4
worker_class = "gthread"
timeout = 300
keepalive = 5
max_requests = 1000
max_requests_jitter = 100
