"""
Консольный интерфейс экспертной системы ИИдеал Авто (AIdeal Auto) на базе
послойного движка AirLLM (Google Gemma 4 12B W4A16) с адаптивным GPU-ускорением.
"""

import os
import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "autodiag_project.settings")
django.setup()

from diagnostics.airllm_vulkan_service import orchestrator
from diagnostics.models import DialogSession, SystemSettings
from vulkan_backend import init_vulkan_environment


def main():
    init_vulkan_environment(verbose=True)
    settings_obj = SystemSettings.get_active()
    session = DialogSession.objects.create(title="Консольная сессия AirLLM Gemma 4")

    print("\n" + "=" * 60)
    print(" ИИДЕАЛ АВТО (AIdeal Auto) • AirLLM Google Gemma 4 12B ")
    print("=" * 60)

    while True:
        query = input("\nВведите симптом или запрос (или 'q' для выхода):\n> ").strip()
        if not query:
            continue
        if query.lower() in ["q", "exit", "quit"]:
            break

        print("[*] Выполнение Function Calling и генерация ответа через AirLLM (GPU)...\n")
        resp = orchestrator.diagnose_and_respond(
            query=query,
            session=session,
            settings_obj=settings_obj,
            recent_messages=[],
            attached_codes=[],
            image_analyses=[],
            doc_analyses=[],
        )
        print("-" * 60)
        print(f"ВЕРДИКТ: {resp.summary_title}\n")
        print(resp.mentor_reply)
        if resp.repair_steps:
            print("\nПОШАГОВЫЙ ЧЕКЛИСТ РЕМОНТА:")
            for step in resp.repair_steps:
                print(f"  [ ] Шаг {step.step_number}: {step.title} ({step.torque_or_spec})")
        print("-" * 60)


if __name__ == "__main__":
    main()