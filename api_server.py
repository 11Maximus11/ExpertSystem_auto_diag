"""
Скрипт запуска веб-сервера ИИдеал Авто (AIdeal Auto) — Django + AirLLM Google Gemma 4 12B.
"""

import os
import sys
from django.core.management import execute_from_command_line
from vulkan_backend import init_vulkan_environment


def main():
    init_vulkan_environment(verbose=True)
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "autodiag_project.settings")
    execute_from_command_line([sys.argv[0], "runserver", "0.0.0.0:8000"])


if __name__ == "__main__":
    main()