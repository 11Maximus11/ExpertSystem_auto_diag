import json
import os
import subprocess
import sys
import time
from pathlib import Path

import httpx
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
from openai import OpenAI

from engine import VehicleExpertEngine
from vulkan_backend import BASE_DIR, init_vulkan_environment

app = FastAPI(title="AutoDiag Expert API (Vulkan)")

http_client = httpx.Client(trust_env=False)

LLAMA_SERVER_URL = os.environ.get("LLAMA_SERVER_URL", "http://127.0.0.1:8080/v1")

llama_client = OpenAI(
    base_url=LLAMA_SERVER_URL,
    api_key="not-needed",
    http_client=http_client,
)


def start_llama_server():
    """Кроссплатформенный запуск локального сервера llama.cpp с ускорением Vulkan по относительному пути."""
    init_vulkan_environment(verbose=True)
    script_rel = Path("llama") / ("start_server.bat" if sys.platform == "win32" else "start_server.sh")
    script_file = BASE_DIR / script_rel

    if script_file.exists():
        print(f"[SYSTEM] Запуск Vulkan LLM-сервера из относительного пути: {script_rel}")
        if sys.platform == "win32":
            subprocess.Popen(
                [str(script_file)],
                cwd=str(BASE_DIR),
                creationflags=subprocess.CREATE_NEW_CONSOLE,
            )
        else:
            subprocess.Popen(
                ["bash", str(script_file)],
                cwd=str(BASE_DIR),
            )
        print("[SYSTEM] Ожидание инициализации Vulkan устройства (8 ГБ VRAM)...")
        time.sleep(3)
    else:
        print(f"[WARNING] Скрипт {script_rel} не найден. Убедитесь, что LLM сервер запущен.")


print("[SYSTEM] Загрузка базы знаний и поискового движка (относительные пути)...")
try:
    kb_path = BASE_DIR / "kb_data.json"
    with open(kb_path, "r", encoding="utf-8") as f:
        kb_data = json.load(f)
    engine = VehicleExpertEngine(kb_data=kb_data, kb_path=kb_path)
except Exception as e:
    print(f"[ERROR] Ошибка инициализации RAG: {e}")
    sys.exit(1)


@app.post("/ask")
async def ask_expert(request: Request):
    data = await request.json()
    query = data.get("query", "")
    image_b64 = data.get("image")
    history = data.get("history", [])

    print(f"\n[API] Запрос: {query} | Фото: {'Да' if image_b64 else 'Нет'}")

    llm_prompt = engine.prepare_llm_context(query, top_n=3)

    user_content = [{"type": "text", "text": llm_prompt}]
    if image_b64:
        user_content.append({"type": "image_url", "image_url": {"url": image_b64}})

    history.append({"role": "user", "content": user_content})

    def generate():
        try:
            response = llama_client.chat.completions.create(
                model="local",
                messages=history,
                max_tokens=2048,
                temperature=0.2,
                stream=True,
                extra_body={"chat_template_kwargs": {"enable_thinking": False}},
            )
            for chunk in response:
                token = chunk.choices[0].delta.content
                if token:
                    yield token
        except Exception as e:
            yield f"\n[Ошибка генерации: сервер LLM недоступен ({e})]"

    return StreamingResponse(generate(), media_type="text/plain")


if __name__ == "__main__":
    start_llama_server()
    print("[SYSTEM] Запуск API-сервера на порту 8010...")
    uvicorn.run(app, host="0.0.0.0", port=8010)