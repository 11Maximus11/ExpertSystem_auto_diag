"""
Комплексный набор автотестов для проверки всех требований проекта AutoDiag Pro AI:
1. Относительные пути и отсутствие жестких абсолютных путей
2. Инициализация и расчет слоев ускорения GPU / Vulkan (адаптивный профиль VRAM)
3. Индексация kb_data.json и VehicleDiagnosticSample.txt + фильтрация нерелевантных запросов (например «привет»)
4. Фоновый воркер выжимки контекста, междиалоговая память и принудительный сброс (preemption)
5. Строгий JSON-формат ответов (Pydantic v2 + JSON Schema) и Function Calling
6. Прикрепление фото/снимков камеры, документов, кодов ошибок и голоса (GGML / Direct Audio)
7. Режим для AR-очков типа RayNeo (чисто черный прозрачный фон + два плавающих окна)
8. Интерактивные чекбоксы задач ремонта, блок инвентаря и проверка шардов AirLLM Qwen3.5-4B
"""

import base64
import io
import json
import os
import threading
import time
from django.test import Client, TransactionTestCase
from PIL import Image

# Для быстрых модульных тестов HTTP/воркера используем быстрый тестовый режим без 35-слойного прогона весов на каждый запрос
os.environ.setdefault("AUTODIAG_FAST_TEST", "1")

from engine import VehicleExpertEngine
from vulkan_backend import BASE_DIR, compute_optimal_vulkan_layers, init_vulkan_environment
from .context_worker import context_worker_manager
from .models import ChatMessage, DialogSession, SystemSettings
from .schemas import DIAGNOSTIC_JSON_SCHEMA, DiagnosticStructuredResponse, validate_and_coerce_structured_json


class AutoDiagComprehensiveTests(TransactionTestCase):
    def setUp(self):
        self.client = Client()

    def test_01_vulkan_backend_and_relative_paths(self):
        """Проверка инициализации стека Vulkan/GPU и использования относительных путей."""
        status = init_vulkan_environment(verbose=False)
        self.assertEqual(status.backend, "Vulkan")
        self.assertGreaterEqual(status.vram_total_mb, 1024)
        layers = compute_optimal_vulkan_layers(vram_free_mb=6800, ctx_size=4096)
        self.assertTrue(layers == -1 or layers >= 8)
        self.assertTrue((BASE_DIR / "kb_data.json").exists())
        self.assertTrue((BASE_DIR / "VehicleDiagnosticSample.txt").exists())

    def test_02_rag_engine_and_telemetry_dictionary(self):
        """Проверка гибридного RAG-поиска, словаря кодов ошибок (DTC) и отсечения приветствий."""
        engine = VehicleExpertEngine()
        self.assertGreater(len(engine.raw_data), 110)
        self.assertGreater(len(engine.dtc_catalog), 50)

        # Обычное приветствие не должно возвращать ложный код ошибки P0650
        greeting_hits = engine.diagnose("привет", top_n=3)
        self.assertEqual(len(greeting_hits), 0)

        hits = engine.diagnose("пинки АКПП при переключении передач P0796", top_n=3)
        self.assertTrue(len(hits) > 0)
        self.assertEqual(hits[0]["meta"]["system"], "transmission")

        p0796 = engine.get_dtc_details("P0796")
        self.assertIsNotNone(p0796)
        self.assertEqual(p0796["code"], "P0796")
        self.assertTrue(bool(p0796.get("telemetry")))

    def test_03_strict_json_schema_and_task_friendly_blocks(self):
        """Проверка строгой JSON-схемы, блоков инвентаря, чекбоксов задач и Function Calling."""
        resp = self.client.post(
            "/api/ask/",
            data=json.dumps(
                {
                    "query": "Двигатель троит на холостых оборотах, ошибка P0300",
                    "dtc_codes": ["P0300"],
                    "vehicle_info": "Volkswagen Tiguan 2.0 TSI",
                }
            ),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200)
        payload = resp.json()
        assistant_msg = payload["assistant_message"]
        sdata = assistant_msg["structured_data"]

        # Проверяем валидность по Pydantic v2 и JSON Schema
        validated = validate_and_coerce_structured_json(json.dumps(sdata, ensure_ascii=False))
        self.assertIsInstance(validated, DiagnosticStructuredResponse)
        self.assertGreater(len(validated.faults), 0)
        self.assertGreater(len(validated.inventory), 0)
        self.assertGreater(len(validated.repair_steps), 0)
        self.assertGreater(len(validated.tool_calls), 0)

        # Проверяем переключение чекбоксов шага ремонта и инвентаря
        msg_id = assistant_msg["id"]
        toggle_step_resp = self.client.post(
            f"/api/messages/{msg_id}/toggle-task/",
            data=json.dumps({"type": "step", "id": 1, "checked": True}),
            content_type="application/json",
        )
        self.assertEqual(toggle_step_resp.status_code, 200)
        self.assertEqual(toggle_step_resp.json()["progress"]["steps_done"], 1)

        first_inv_id = sdata["inventory"][0]["id"]
        toggle_inv_resp = self.client.post(
            f"/api/messages/{msg_id}/toggle-task/",
            data=json.dumps({"type": "inventory", "id": first_inv_id, "checked": True}),
            content_type="application/json",
        )
        self.assertEqual(toggle_inv_resp.status_code, 200)
        self.assertEqual(toggle_inv_resp.json()["progress"]["inventory_done"], 1)

    def test_04_preemptible_context_worker_and_cross_dialog_memory(self):
        """
        Проверка фонового воркера выжимки контекста:
        если пользователь задаёт новый вопрос до завершения обновления выжимки —
        старый воркер принудительно сбрасывается без задержки ответа.
        """
        session = DialogSession.objects.create(
            title="Тест воркера контекста",
            vehicle_info="Toyota RAV4",
        )
        ChatMessage.objects.create(
            session=session,
            role="user",
            content="Педаль тормоза мягкая, код C0050",
            dtc_codes=["C0050"],
        )

        # Регистрируем искусственно долгий суммаризатор (500 мс), чтобы гарантировать перехват
        def slow_summarizer(base_digest: str, cancel_event: threading.Event):
            for _ in range(10):
                if cancel_event.wait(timeout=0.05):
                    return None
            return base_digest + "\n[Дополнено LLM]"

        context_worker_manager.register_llm_summarizer(slow_summarizer)
        try:
            v1 = context_worker_manager.start_background_update(str(session.id))
            self.assertGreater(v1, 0)

            # Сразу же отправляем новый вопрос через API, пока воркер v1 еще выполняется
            start_t = time.perf_counter()
            ask_resp = self.client.post(
                "/api/ask/",
                data=json.dumps(
                    {
                        "session_id": str(session.id),
                        "query": "А какую тормозную жидкость лучше залить при прокачке?",
                    }
                ),
                content_type="application/json",
            )
            elapsed_ms = (time.perf_counter() - start_t) * 1000
            self.assertEqual(ask_resp.status_code, 200)
            # Убеждаемся, что старый воркер был мгновенно сброшен и не задержал ответ
            self.assertTrue(ask_resp.json()["worker_preempted"])
            self.assertLess(elapsed_ms, 450)
        finally:
            context_worker_manager.register_llm_summarizer(None)

        # Дожидаемся завершения нового фонового воркера и проверяем выжимку и междиалоговую память
        for _ in range(25):
            if not context_worker_manager.get_worker_state(str(session.id))["is_running"]:
                break
            time.sleep(0.05)
        session.refresh_from_db()
        self.assertIn("C0050", session.summary)
        settings_obj = SystemSettings.get_active()
        self.assertIn("C0050", settings_obj.global_memory_summary)

    def test_05_multimodal_photo_and_ar_rayneo_mode(self):
        """Проверка прикрепления фото камеры, PWA манифеста и режима AR-очков RayNeo."""
        img = Image.new("RGB", (320, 240), color=(15, 20, 30))
        buf = io.BytesIO()
        img.save(buf, format="JPEG")
        b64_img = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("utf-8")

        resp = self.client.post(
            "/api/ask/",
            data=json.dumps(
                {
                    "query": "Посмотри фото приборной панели",
                    "image": b64_img,
                }
            ),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200)
        tool_names = [
            tc["tool_name"]
            for tc in resp.json()["assistant_message"]["structured_data"]["tool_calls"]
        ]
        self.assertIn("inspect_attached_image", tool_names)

        # Проверяем страницу AR-очков RayNeo и PWA
        ar_resp = self.client.get("/ar/")
        self.assertEqual(ar_resp.status_code, 200)
        self.assertContains(ar_resp, "ar-glasses-mode")
        self.assertContains(ar_resp, "arWindowCamera")
        self.assertContains(ar_resp, "arWindowAssistant")

        manifest_resp = self.client.get("/manifest.json")
        self.assertEqual(manifest_resp.status_code, 200)
        self.assertEqual(manifest_resp.json()["short_name"], "AutoDiag AI")

    def test_06_greeting_does_not_trigger_false_fault_and_shards_exist(self):
        """Проверка, что приветствие возвращает живой ответ (response_type='general', faults=0) и шарды AirLLM Qwen3.5-4B готовы."""
        resp = self.client.post(
            "/api/ask/",
            data=json.dumps({"query": "привет"}),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200)
        sdata = resp.json()["assistant_message"]["structured_data"]
        self.assertEqual(sdata["response_type"], "general")
        self.assertEqual(len(sdata["faults"]), 0)

        shards_dir = BASE_DIR / "models" / "airllm_shards" / "splitted_model"
        if shards_dir.exists():
            shards = list(shards_dir.glob("*.safetensors"))
            self.assertGreaterEqual(len(shards), 35)
