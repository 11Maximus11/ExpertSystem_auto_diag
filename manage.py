#!/usr/bin/env python
"""Утилита командной строки Django для экспертной системы автодиагностики AutoDiag Pro AI."""
import os
import sys
from pathlib import Path


def main():
    """Запуск административных задач Django с поддержкой относительных путей и Vulkan."""
    base_dir = Path(__file__).resolve().parent
    if str(base_dir) not in sys.path:
        sys.path.insert(0, str(base_dir))

    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "autodiag_project.settings")
    os.environ.setdefault("GGML_VULKAN", "1")
    os.environ.setdefault("LLAMA_VULKAN", "1")

    try:
        from django.core.management import execute_from_command_line
    except ImportError as exc:
        raise ImportError(
            "Не удалось импортировать Django. Убедитесь, что активировано виртуальное окружение .venv."
        ) from exc
    execute_from_command_line(sys.argv)


if __name__ == "__main__":
    main()
