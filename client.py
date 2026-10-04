import base64
import requests
import tkinter as tk
from tkinter import filedialog
import os

API_URL = "http://127.0.0.1:8010/ask"

def select_image_via_explorer():
    """Открывает системный проводник поверх всех окон для выбора картинки"""
    try:
        root = tk.Tk()
        root.withdraw() 
        root.wm_attributes('-topmost', True) 
        
        file_path = filedialog.askopenfilename(
            title="Выберите фото поломки (или отмените для текстового режима)", 
            filetypes=[("Images", "*.jpg *.png *.jpeg *.bmp")]
        )
        return file_path if file_path else ""
    except Exception as e:
        print(f"[WARNING] Не удалось запустить проводник: {e}. Переходим на ручной ввод пути.")
        return input("Введите путь к изображению вручную (или нажмите Enter): ").strip()

def main():
    print("=" * 50)
    print("(API Mode + Vision) ")
    print("=" * 50)
    
    history = [
        {
            "role": "system", 
            "content": (
                "Ты — ведущий инженер-диагност и наставник. Ты ведешь связный диалог с пользователем. "
                "К каждому новому сообщению сервер автоматически подмешивает технические документы (RAG). "
                "Твоя задача — анализировать вопрос, историю диалога и прикрепленный контекст.\n\n"
                "ПРАВИЛА ОТВЕТА:\n"
                "1. НОВЫЙ ДИАГНОЗ: Если пользователь описывает новую поломку или прикрепляет фото, "
                "опирайся на новые документы и отвечай строго по структуре:\n"
                "   1. Установленная неисправность (с кодом ошибки);\n"
                "   2. Пошаговое руководство по устранению;\n"
                "   3. Важные рекомендации.\n\n"
                "2. УТОЧНЯЮЩИЙ ВОПРОС: Если пользователь задает вопрос по ходу диалога (например, "
                "'как открутить деталь?', 'почему это сломалось?', 'ты помнишь?'), отвечай как живой "
                "человек-наставник. Структуру 1-2-3 применять НЕ нужно. Опирайся на историю диалога. "
                "Если прикрепленные новые технические документы не относятся к текущей беседе — просто игнорируй их.\n\n"
                "ВНИМАНИЕ: Игнорируй системную фразу 'Если информации недостаточно — прямо скажи об этом', "
                "если ты можешь ответить на вопрос пользователя, опираясь на вашу историю переписки. "
                "Всегда отвечай на русском языке.В конце спроси, нужна ли дополнительная помощь по теме."
            )
        }
    ]
    
    
    while True:
        query = input("\nВведите симптом (или 'q' для выхода):\n> ").strip()
        if query.lower() in ['q', 'exit', 'quit']: 
            break
        if not query: 
            continue
            
        print("Открытие проводника для выбора фото...")
        img_path = select_image_via_explorer()
        img_b64 = None
        
        if img_path:
            if img_path.startswith(('"', "'")) and img_path.endswith(('"', "'")):
                img_path = img_path[1:-1]
                
            print(f"[*] Выбрано фото: {os.path.basename(img_path)}")
            try:
                with open(img_path, "rb") as f:
                    img_b64 = "data:image/jpeg;base64," + base64.b64encode(f.read()).decode("utf-8")
            except Exception as e:
                print(f"[ERROR] Ошибка кодирования изображения: {e}")
                img_b64 = None
        
        print("[*] Отправка данных на сервер...")

        payload = {
            "query": query,
            "image": img_b64,
            "history": history
        }
        
        try:

            response = requests.post(
                API_URL, 
                json=payload, 
                stream=True, 
                proxies={"http": None, "https": None} 
            )
            response.raise_for_status()
            
            print("ОТВЕТ ЭКСПЕРТНОЙ СИСТЕМЫ:")
            print("-" * 50)
            
            bot_response = ""
            for chunk in response.iter_content(chunk_size=None, decode_unicode=True):
                if chunk:
                    print(chunk, end='', flush=True)
                    bot_response += chunk
            print("\n" + "-" * 50)
            
            history.append({"role": "user", "content": query})
            history.append({"role": "assistant", "content": bot_response})
            
            if len(history) > 7:
                history = [history[0]] + history[-6:]
                
        except Exception as e:
            print(f"[ERROR] Нет связи с сервером: {e}")

if __name__ == "__main__":
    main()