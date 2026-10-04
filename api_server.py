import os
import sys
import time
import json
import uvicorn
import subprocess
import httpx 
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
from openai import OpenAI
from engine import VehicleExpertEngine

app = FastAPI()

http_client = httpx.Client(trust_env=False)

llama_client = OpenAI(
    base_url="http://127.0.0.1:8080/v1", 
    api_key="not-needed",
    http_client=http_client 
)

def start_llama_server():
    """Автоматический запуск батника с llama.cpp в отдельной консоли Windows"""
    current_dir = os.path.dirname(os.path.abspath(__file__))
    bat_file = os.path.join(current_dir, r"llama/start_server.bat")
    
    if os.path.exists(bat_file):
        print(f"[SYSTEM] Запуск LLM-сервера из файла: {bat_file}")
        
        creation_flags = subprocess.CREATE_NEW_CONSOLE if sys.platform == "win32" else 0
        
        subprocess.Popen([bat_file], cwd=current_dir, creationflags=creation_flags)

        print("[SYSTEM] Ожидание инициализации видеокарты...")
        time.sleep(3)
    else:
        print(f"[WARNING] Файл {bat_file} не найден. Убедитесь, что LLM сервер запущен вручную.")

# =====================================================================
# Инициализация RAG (Поиск по базе знаний)
# =====================================================================
print("[SYSTEM] Загрузка базы знаний и поискового движка...")
try:
    with open("kb_data.json", "r", encoding="utf-8") as f:
        kb_data = json.load(f)
    engine = VehicleExpertEngine(kb_data)
except Exception as e:
    print(f"[ERROR] Ошибка инициализации RAG: {e}")
    sys.exit(1)

# =====================================================================
# Логика API
# =====================================================================
@app.post("/ask")
async def ask_expert(request: Request):
    data = await request.json()
    query = data.get("query")
    image_b64 = data.get("image")
    history = data.get("history", []) # Получаем чистую историю от клиента

    print(f"\n[API] Запрос: {query} | Фото: {'Да' if image_b64 else 'Нет'}")

    # 1. Поиск релевантных фактов в базе знаний 
    llm_prompt = engine.prepare_llm_context(query, top_n=3)

    # 2. Формируем текущее сообщение (Текст RAG + Картинка) в едином формате ввода
    user_content = [{"type": "text", "text": llm_prompt}]
    if image_b64:
        user_content.append({"type": "image_url", "image_url": {"url": image_b64}})
    
    # Добавляем текущий запрос к истории, полученной от клиента
    history.append({"role": "user", "content": user_content})

    # 3. Передача запроса в llama.cpp и потоковый возврат ответа обратно клиенту
    def generate():
        try:
            response = llama_client.chat.completions.create(
                model="local",
                messages=history,
                max_tokens=10000,
                temperature=0.2,
                stream=True,
                # Отключение встроенного режима размышлений Gemma 4
                extra_body={"chat_template_kwargs": {"enable_thinking": False}}
            )
            for chunk in response:
                token = chunk.choices[0].delta.content
                if token:
                    yield token
        except Exception as e:
            yield f"\n[Ошибка генерации: сервер LLM недоступен ({e})]"

    return StreamingResponse(generate(), media_type="text/plain")

# =====================================================================
if __name__ == "__main__":
    # Запускаем батник с llama.cpp
    start_llama_server()
    
    # Запускаем API-сервер
    print("[SYSTEM] Запуск API-сервера на порту 8010...")
    uvicorn.run(app, host="0.0.0.0", port=8010)