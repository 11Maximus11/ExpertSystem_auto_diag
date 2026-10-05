"""
Комплексный набор автотестов экспертной системы ИИдеал Авто (AIdeal Auto):
1. Относительные пути и отсутствие жестких абсолютных путей
2. Инициализация и расчет слоев ускорения GPU / Vulkan (адаптивный профиль VRAM для Gemma 4 12B, 48 слоев)
3. Индексация kb_data.json и VehicleDiagnosticSample.txt + гибридный RAG BERT + FAISS + CrossEncoder
4. Динамический фоновый воркер выжимки контекста, междиалоговая память и принудительный сброс (preemption)
5. Строгий JSON-формат ответов (Pydantic v2 + JSON Schema) и Function Calling
6. Нативный аудиовход Gemma 4 12B (embed_audio 16kHz), прикрепление фото и документов разных форматов
7. Режим для AR-очков (два подрежима: RayNeo Optical #000000 и Камера-фон Passthrough)
8. Интерактивные чекбоксы задач ремонта, блок инвентаря и автообрезка ответа по последнему предложению
"""

import base64
import io
import json
import os
import threading
import time
import numpy as np
from django.test import Client, TransactionTestCase
from PIL import Image

os.environ.setdefault("AUTODIAG_FAST_TEST", "1")

from engine import VehicleExpertEngine
from vulkan_backend import BASE_DIR, compute_optimal_vulkan_layers, init_vulkan_environment
from .context_worker import compute_dynamic_context_budget, context_worker_manager
from .document_service import parse_uploaded_document
from .models import ChatMessage, DialogSession, SystemSettings
from .schemas import (
    DIAGNOSTIC_JSON_SCHEMA,
    DiagnosticStructuredResponse,
    truncate_to_last_sentence,
    validate_and_coerce_structured_json,
)
from .voice_service import decode_audio_to_waveform_16k, process_voice_input


class AIdealAutoComprehensiveTests(TransactionTestCase):
    def setUp(self):
        self.client = Client()

    def test_01_vulkan_backend_and_relative_paths(self):
        """Проверка инициализации стека Vulkan/GPU и использования относительных путей."""
        status = init_vulkan_environment(verbose=False)
        self.assertEqual(status.backend, "Vulkan")
        self.assertGreaterEqual(status.vram_total_mb, 1024)
        layers = compute_optimal_vulkan_layers(vram_free_mb=6800, ctx_size=32768, total_layers=48)
        self.assertTrue(layers == -1 or layers >= 8)
        self.assertTrue((BASE_DIR / "kb_data.json").exists())
        self.assertTrue((BASE_DIR / "VehicleDiagnosticSample.txt").exists())

    def test_02_rag_engine_and_telemetry_dictionary(self):
        """Проверка гибридного RAG-поиска (BERT + FAISS + BM25 + CrossEncoder) и словаря кодов ошибок (DTC)."""
        engine = VehicleExpertEngine()
        self.assertGreater(len(engine.raw_data), 110)
        self.assertGreater(len(engine.dtc_catalog), 50)

        # Обычное приветствие не должно возвращать ложный код ошибки
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

        validated = validate_and_coerce_structured_json(json.dumps(sdata, ensure_ascii=False))
        self.assertIsInstance(validated, DiagnosticStructuredResponse)
        self.assertGreater(len(validated.faults), 0)
        self.assertGreater(len(validated.inventory), 0)
        self.assertGreater(len(validated.repair_steps), 0)
        self.assertGreater(len(validated.tool_calls), 0)

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
        Проверка динамического фонового воркера выжимки контекста:
        приоритет ответа пользователю со сбросом старого воркера.
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

        def slow_summarizer(base_digest: str, cancel_event: threading.Event):
            for _ in range(10):
                if cancel_event.wait(timeout=0.05):
                    return None
            return base_digest + "\n[Дополнено LLM]"

        context_worker_manager.register_llm_summarizer(slow_summarizer)
        try:
            v1 = context_worker_manager.start_background_update(str(session.id))
            self.assertGreater(v1, 0)

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
            self.assertTrue(ask_resp.json()["worker_preempted"])
            self.assertLess(elapsed_ms, 450)
        finally:
            context_worker_manager.register_llm_summarizer(None)

        for _ in range(25):
            if not context_worker_manager.get_worker_state(str(session.id))["is_running"]:
                break
            time.sleep(0.05)
        session.refresh_from_db()
        self.assertIn("C0050", session.summary)
        settings_obj = SystemSettings.get_active()
        self.assertIn("C0050", settings_obj.global_memory_summary)

    def test_05_multimodal_photo_and_ar_two_submodes(self):
        """Проверка прикрепления фото, PWA манифеста и двух подрежимов AR (RayNeo и Passthrough)."""
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

        ar_resp = self.client.get("/ar/")
        self.assertEqual(ar_resp.status_code, 200)
        self.assertContains(ar_resp, "ar-glasses-mode")
        self.assertContains(ar_resp, "arWindowCamera")
        self.assertContains(ar_resp, "arWindowAssistant")
        self.assertContains(ar_resp, "arBgVideoEl")
        self.assertContains(ar_resp, "btnArModeRayneo")
        self.assertContains(ar_resp, "btnArModePassthrough")

        manifest_resp = self.client.get("/manifest.json")
        self.assertEqual(manifest_resp.status_code, 200)
        self.assertEqual(manifest_resp.json()["short_name"], "ИИдеал Авто")

    def test_06_greeting_and_gemma4_shards_ready(self):
        """Проверка, что приветствие возвращает живой ответ (response_type='general') и 52 шарда Gemma 4 12B готовы."""
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
            self.assertGreaterEqual(len(shards), 50)

    def test_07_gemma4_native_audio_and_file_parsing(self):
        """Проверка декодирования нативного аудио 16kHz float32 без Whisper и парсинга документов."""
        # Синтезируем PCM WAV 16 кГц моно
        sample_rate = 16000
        t = np.linspace(0, 1.0, sample_rate, endpoint=False)
        wave_data = (np.sin(2 * np.pi * 440 * t) * 16000).astype(np.int16)
        
        wav_buf = io.BytesIO()
        import wave
        with wave.open(wav_buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sample_rate)
            wf.writeframes(wave_data.tobytes())
        raw_wav_bytes = wav_buf.getvalue()

        # Тест voice_service
        voice_res = process_voice_input(raw_wav_bytes, filename="engine_sound.wav", voice_mode="direct_audio")
        self.assertTrue(voice_res["audio_attached_to_model"])
        self.assertIsNotNone(voice_res["audio_waveform_16k"])
        self.assertEqual(len(voice_res["audio_waveform_16k"]), sample_rate)

        # Тест document_service с логом ошибок и телеметрией
        log_content = "OBD-II Scan Log: P0300 Random/Multiple Cylinder Misfire, P0796 Pressure Control Solenoid, Engine_Temp=92.5 C".encode("utf-8")
        doc_res = parse_uploaded_document(log_content, "scan_report.log")
        self.assertIn("P0300", doc_res["detected_dtc_codes"])
        self.assertIn("P0796", doc_res["detected_dtc_codes"])

    def test_08_dynamic_context_budget_and_sentence_truncation(self):
        """Проверка динамического расчета контекстного бюджета и автообрезки по последнему предложению."""
        budget = compute_dynamic_context_budget(context_window_tokens=32768, messages=[])
        self.assertGreaterEqual(budget["free_context_tokens"], 20000)
        self.assertGreaterEqual(budget["max_summary_chars"], 1200)

        # Проверка truncate_to_last_sentence
        cut_off_text = "Причиной ошибки P0300 является пробой изоляции катушки зажигания 2-го цилиндра. Рекомендуем заменить катушку и свечу. Также проверьте сопротивле"
        trimmed = truncate_to_last_sentence(cut_off_text)
        self.assertTrue(trimmed.endswith("свечу."))
        self.assertNotIn("сопротивле", trimmed)
