#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Локальный HTTP сервер разработки для веб-приложения ИИдеал-Авто (le.codes).
Лицензия: GNU General Public License v3.0 (GPL-3.0)

Раздает скомпилированное веб-приложение из папки dist/web/ на порту 3000 (http://localhost:3000)
с поддержкой CORS заголовков и отключением кэширования для удобной разработки и отладки.
"""

import os
import sys
import mimetypes
from http.server import HTTPServer, SimpleHTTPRequestHandler
import socketserver

DEFAULT_PORT = 3000

# Дополнительные MIME-типы для современных веб-технологий и PWA
mimetypes.add_type("text/javascript; charset=utf-8", ".js")
mimetypes.add_type("text/javascript; charset=utf-8", ".mjs")
mimetypes.add_type("application/json; charset=utf-8", ".json")
mimetypes.add_type("text/css; charset=utf-8", ".css")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("font/woff", ".woff")
mimetypes.add_type("application/manifest+json", ".webmanifest")

class DevServerRequestHandler(SimpleHTTPRequestHandler):
    """Кастомный HTTP-обработчик с CORS и no-cache заголовками."""

    def end_headers(self):
        # Добавляем заголовки CORS для свободного взаимодействия с бэкендами и локальными скриптами
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD")
        self.send_header("Access-Control-Allow-Headers", "*")
        # Отключаем кэширование браузера для быстрой горячей перезагрузки изменений
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def do_OPTIONS(self):
        """Обработка preflight CORS запросов."""
        self.send_response(200, "OK")
        self.end_headers()

    def log_message(self, format, *args):
        # Компактный вывод в консоль
        sys.stderr.write(f"[{self.log_date_time_string()}] {format % args}\n")

def run(port=DEFAULT_PORT):
    base_dir = os.path.dirname(os.path.abspath(__file__))
    web_dir = os.path.join(base_dir, "dist", "web")

    if not os.path.exists(web_dir):
        print(f"[ОШИБКА] Директория с веб-сборкой не найдена: {web_dir}")
        print("Сначала запустите компиляцию приложения: npm run build")
        sys.exit(1)

    # Переходим в директорию раздачи
    os.chdir(web_dir)

    # Разрешаем повторное использование адреса сокета
    socketserver.TCPServer.allow_reuse_address = True

    try:
        with HTTPServer(("", port), DevServerRequestHandler) as httpd:
            print("=" * 65)
            print("  ИИдеал-Авто • Локальный сервер веб-приложения (le.codes)")
            print("=" * 65)
            print(f"  • Раздача из:  {web_dir}")
            print(f"  • Локальный адрес: http://localhost:{port}/")
            print(f"  • Сетевой адрес:   http://127.0.0.1:{port}/")
            print(f"  • CORS:            Access-Control-Allow-Origin: *")
            print(f"  • Кэш браузера:    Отключен (no-cache)")
            print(f"  • Web APIs:        Web Bluetooth, Web Serial, Cache Storage")
            print("=" * 65)
            print("  Нажмите Ctrl+C для остановки сервера.\n")
            httpd.serve_forever()
    except OSError as e:
        if e.errno == 48 or getattr(e, 'winerror', None) == 10048:
            print(f"[ПРЕДУПРЕЖДЕНИЕ] Порт {port} уже занят. Пробуем порт {port + 1}...")
            run(port + 1)
        else:
            raise e
    except KeyboardInterrupt:
        print("\n[СЕРВЕР] Сервер остановлен пользователем.")

if __name__ == "__main__":
    port_to_use = DEFAULT_PORT
    if len(sys.argv) > 1:
        try:
            port_to_use = int(sys.argv[1])
        except ValueError:
            print(f"Неверный порт: {sys.argv[1]}, используется порт по умолчанию {DEFAULT_PORT}")
    run(port_to_use)
