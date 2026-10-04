import base64
import os
import tkinter as tk
from pathlib import Path
from tkinter import filedialog
import requests

BASE_DIR = Path(__file__).resolve().parent
API_URL = os.environ.get("AUTODIAG_API_URL", "http://127.0.0.1:8000/api/ask/")


def select_image_via_explorer() -> str:
    """Открывает системный проводник поверх всех окон для выбора картинки (с относительным стартовым каталогом)."""
    try:
        root = tk.Tk()
        root.withdraw()
        root.wm_attributes("-topmost", True)

        file_path = filedialog.askopenfilename(
            initialdir=str(BASE_DIR),
            title="Выберите фото поломки (или отмените для текстового режима)",
            filetypes=[("Images", "*.jpg *.png *.jpeg *.bmp *.webp")],
        )
        return file_path if file_path else ""
    except Exception as e:
        print(f"[WARNING] Не удалось запустить проводник: {e}. Переходим на ручной ввод пути.")
        return input("Введите относительный или полный путь к изображению (или нажмите Enter): ").strip()


def main():
    print("=" * 60)
    print("AutoDiag Pro AI — Консольный клиент (Django / Vulkan API)")
    print(f"Активный эндпоинт: {API_URL}")
    print("=" * 60)

    while True:
        query = input("\nВведите симптом или код ошибки (или 'q' для выхода):\n> ").strip()
        if query.lower() in ["q", "exit", "quit"]:
            break
        if not query:
            continue

        img_path = select_image_via_explorer()
        img_b64 = None

        if img_path:
            img_path = img_path.strip("\"'")
            resolved = Path(img_path)
            if not resolved.is_absolute():
                resolved = BASE_DIR / resolved
            if resolved.exists():
                print(f"[*] Выбрано фото: {resolved.name}")
                try:
                    img_b64 = "data:image/jpeg;base64," + base64.b64encode(resolved.read_bytes()).decode("utf-8")
                except Exception as e:
                    print(f"[ERROR] Ошибка кодирования изображения: {e}")

        payload = {
            "query": query,
            "image": img_b64,
        }

        try:
            response = requests.post(
                API_URL,
                json=payload,
                proxies={"http": None, "https": None},
                timeout=60,
            )
            response.raise_for_status()
            data = response.json()
            assistant = data.get("assistant_message", {})
            sdata = assistant.get("structured_data", {})

            print("\nОТВЕТ ЭКСПЕРТНОЙ СИСТЕМЫ:")
            print("-" * 60)
            print(f"ВЕРДИКТ: {sdata.get('summary_title', '')}")
            print(assistant.get("content", ""))

            if sdata.get("inventory"):
                print("\n[БЛОК ИНВЕНТАРЯ]:")
                for inv in sdata["inventory"]:
                    print(f"  [ ] {inv['name']} ({inv.get('spec', '')})")

            if sdata.get("repair_steps"):
                print("\n[ПОШАГОВЫЙ ПЛАН РЕМОНТА]:")
                for step in sdata["repair_steps"]:
                    print(f"  [ ] Шаг {step['step_number']}: {step['title']} ({step.get('torque_or_spec', '')})")
                    print(f"      {step['instruction']}")
            print("-" * 60)
        except Exception as e:
            print(f"[ERROR] Нет связи с сервером: {e}")


if __name__ == "__main__":
    main()