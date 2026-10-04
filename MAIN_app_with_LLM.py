import os
import json
import torch
from llama_cpp import Llama
from engine import VehicleExpertEngine

# Путь к файлу модели GGUF
MODEL_PATH = r"C:\Users\Makushimu\.lmstudio\models\lmstudio-community\gemma-4-12B-it-GGUF\gemma-4-12B-it-Q4_K_M.gguf"

def init_gpu_check():
    # Проверка доступности видеокарты
    print("[DEBUG] Проверка доступности GPU...")
    if torch.cuda.is_available():
        gpu_name = torch.cuda.get_device_name(0)
        print(f"[DEBUG] PyTorch CUDA активна на: {gpu_name}")
    else:
        print("[DEBUG] CUDA не найдена, переключаемся на CPU.")
    print("-" * 50)

def main():
    init_gpu_check()

    # Проверка физического существования файла модели
    if not os.path.exists(MODEL_PATH):
        print(f"[ERROR] Файл модели не найден по пути: {MODEL_PATH}")
        print("Проверьте директорию кэша LM Studio.")
        return

    print("Загрузка модели в память видеокарты...")
    try:
        # Инициализация Llama с переносом всех слоев на GPU
        llm = Llama(
            model_path=MODEL_PATH,
            n_ctx=8192,       # Контекстное окно (4096 токенов оптимально для истории и RAG)
            n_gpu_layers=-1,    # Полный перенос слоев на GPU
            n_threads=8,
            verbose=False
        )
        print("[SUCCESS] Модель успешно загружена.")
    except Exception as e:
        print(f"[ERROR] Ошибка инициализации Llama: {e}")
        return

    print("Загрузка базы знаний...")
    try:
        with open("kb_data.json", "r", encoding="utf-8") as f:
            kb_data = json.load(f)
    except Exception as e:
        print(f"[ERROR] Не удалось прочитать kb_data.json: {e}")
        return
    
    # Инициализация поискового движка коллеги
    engine = VehicleExpertEngine(kb_data)
    
    # Инициализация истории диалога с системной ролью на старте
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
                "3. Важные рекомендации (на что обратить внимание при ремонте, используй все имеющиеся у тебя знания по этой теме).\n\n"
                "Правила: Отвечай строго на русском языке. Для пунктов 1 и 2 опирайся исключительно на предоставленный "
                "технический контекст. Если информации в контексте недостаточно для точного ответа, "
                "прямо скажи: 'В базе знаний недостаточно данных для ответа'."
            )
        }
    ]
    
    print("\n" + "=" * 50)
    print(" VEHICLE DIAGNOSTIC EXPERT SYSTEM ")
    print("=" * 50)
    
    while True:
        query = input("\nВведите симптом или запрос (или 'q' для выхода):\n> ").strip()
        if not query:
            continue
        if query.lower() in ['q', 'exit', 'quit']:
            break
            
        print("\n[*] Поиск контекста в базе данных...")
        # Поиск документов и сборка промпта
        llm_prompt = engine.prepare_llm_context(query, top_n=3)
        
        # Добавляем сформированный RAG-промпт пользователя в историю переписки
        history.append({"role": "user", "content": llm_prompt})
        
        print("[*] Генерация ответа эксперта...\n")
        
        try:
            # Отправляем ВСЮ историю переписки в модель
            response = llm.create_chat_completion(
                messages=history,
                max_tokens=800,        
                temperature=0.1,       
                stream=True            
            )
            
            print("ОТВЕТ:")
            print("-" * 50)
            
            # Переменная для склеивания генерируемого ответа в единую строку
            bot_response = ""
            
            for chunk in response:
                delta = chunk['choices'][0]['delta']
                if 'content' in delta:
                    token = delta['content']
                    print(token, end='', flush=True)
                    bot_response += token
            print("\n" + "-" * 50)
            
            # Добавляем итоговый ответ модели в историю для памяти на следующем шаге
            history.append({"role": "assistant", "content": bot_response})
            
            # Ограничиваем историю последними 6 сообщениями (3 круга диалога) + системный промпт.
            # Это защищает контекстное окно модели от переполнения гигантскими текстами документов.
            if len(history) > 7:
                history = [history[0]] + history[-6:]
                
        except Exception as e:
            print(f"[ERROR] Ошибка генерации: {e}")

if __name__ == "__main__":
    main()