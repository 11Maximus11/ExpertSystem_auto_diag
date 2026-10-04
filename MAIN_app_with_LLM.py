import json
import os
from pathlib import Path
from engine import VehicleExpertEngine
from vulkan_backend import BASE_DIR, init_vulkan_environment

# Относительный путь к локальной модели GGUF внутри проекта
MODEL_PATH = BASE_DIR / "models" / os.environ.get("GGUF_MODEL_NAME", "gemma-4-12b-it-Q4_K_M.gguf")
KB_PATH = BASE_DIR / "kb_data.json"


def init_gpu_check():
    print("[DEBUG] Проверка доступности ускорения Vulkan (профиль 8 ГБ VRAM)...")
    vk_status = init_vulkan_environment(model_path=MODEL_PATH, verbose=True)
    print("-" * 60)
    return vk_status


def main():
    vk_status = init_gpu_check()

    if not MODEL_PATH.exists():
        print(f"[ERROR] Файл модели не найден по относительному пути: {MODEL_PATH.relative_to(BASE_DIR)}")
        print("Поместите модель GGUF в папку ./models/ или используйте режим AirLLM в веб-интерфейсе Django.")
        return

    print("Загрузка модели через бэкенд Vulkan...")
    try:
        from llama_cpp import Llama  # type: ignore

        llm = Llama(
            model_path=str(MODEL_PATH),
            n_ctx=vk_status.recommended_ctx_size,
            n_gpu_layers=vk_status.recommended_gpu_layers,
            n_threads=min(8, os.cpu_count() or 4),
            verbose=False,
        )
        print("[SUCCESS] Модель успешно инициализирована на Vulkan.")
    except Exception as e:
        print(f"[ERROR] Ошибка инициализации Llama (Vulkan): {e}")
        return

    print("Загрузка базы знаний...")
    try:
        with open(KB_PATH, "r", encoding="utf-8") as f:
            kb_data = json.load(f)
    except Exception as e:
        print(f"[ERROR] Не удалось прочитать {KB_PATH}: {e}")
        return

    engine = VehicleExpertEngine(kb_data=kb_data, kb_path=KB_PATH)

    history = [
        {
            "role": "system",
            "content": (
                "Ты — ведущий инженер-диагност и эксперт-автомеханик. Твоя задача — проанализировать "
                "симптомы неисправности автомобиля и дать чёткий, структурированный ответ на основе "
                "предоставленного технического контекста.\n\n"
                "Обязательно используй следующую структуру ответа:\n"
                "1. Установленная неисправность (укажи систему и код ошибки из контекста, если они есть);\n"
                "2. Пошаговое руководство по устранению проблемы (что проверить, как заменить);\n"
                "3. Важные рекомендации (на что обратить внимание при ремонте).\n\n"
                "Правила: Отвечай строго на русском языке."
            ),
        }
    ]

    print("\n" + "=" * 50)
    print(" VEHICLE DIAGNOSTIC EXPERT SYSTEM (VULKAN) ")
    print("=" * 50)

    while True:
        query = input("\nВведите симптом или запрос (или 'q' для выхода):\n> ").strip()
        if not query:
            continue
        if query.lower() in ["q", "exit", "quit"]:
            break

        print("\n[*] Поиск контекста в базе данных...")
        llm_prompt = engine.prepare_llm_context(query, top_n=3)
        history.append({"role": "user", "content": llm_prompt})

        print("[*] Генерация ответа эксперта...\n")
        try:
            response = llm.create_chat_completion(
                messages=history,
                max_tokens=800,
                temperature=0.1,
                stream=True,
            )

            print("ОТВЕТ:")
            print("-" * 50)
            bot_response = ""
            for chunk in response:
                delta = chunk["choices"][0]["delta"]
                if "content" in delta and delta["content"]:
                    token = delta["content"]
                    print(token, end="", flush=True)
                    bot_response += token
            print("\n" + "-" * 50)

            history.append({"role": "assistant", "content": bot_response})
            if len(history) > 7:
                history = [history[0]] + history[-6:]

        except Exception as e:
            print(f"[ERROR] Ошибка генерации: {e}")


if __name__ == "__main__":
    main()