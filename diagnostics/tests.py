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
9. Удаление сообщений и контекста из чата
10. Проекты, тегирование, закрепление и переименование диалогов
11. Регистрация, вход и многопользовательская изоляция сессий и проектов
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
from .models import ChatMessage, DiagnosticProject, DialogSession, SystemSettings, UserMemorySettings
from .schemas import (
    DIAGNOSTIC_JSON_SCHEMA,
    DiagnosticStructuredResponse,
    truncate_to_last_sentence,
    validate_and_coerce_structured_json,
)
from . import voice_service
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

        dtc_resp = self.client.get("/api/dtc/?q=&system=all&limit=80")
        self.assertEqual(dtc_resp.status_code, 200)
        dtc_items = dtc_resp.json()["items"]
        self.assertGreater(len(dtc_items), 30)
        self.assertIn("symptom", dtc_items[0])
        self.assertIn("solution", dtc_items[0])
        self.assertIn("has_telemetry", dtc_items[0])

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
        from django.contrib.auth import get_user_model

        User = get_user_model()
        user = User.objects.create_user(username="worker_ctx_user", password="Password123!")
        self.client.force_login(user)

        session = DialogSession.objects.create(
            user=user,
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
        mem_settings, _ = UserMemorySettings.for_user(user)
        self.assertIn("C0050", mem_settings.global_memory_summary)
        self.assertEqual(SystemSettings.get_active().global_memory_summary, "")

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
        self.assertEqual(manifest_resp.json()["short_name"], "ИИДЕАЛ АВТО")

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

        # Тест voice_service: исключительно нативный ввод Gemma 4 без Whisper
        voice_res = process_voice_input(raw_wav_bytes, filename="engine_sound.wav", voice_mode="direct_audio")
        self.assertTrue(voice_res["audio_attached_to_model"])
        self.assertIsNotNone(voice_res["audio_waveform_16k"])
        self.assertEqual(len(voice_res["audio_waveform_16k"]), sample_rate)
        self.assertEqual(voice_res["engine"], "Google Gemma 4 Unified (embed_audio 16kHz)")
        self.assertFalse(hasattr(voice_service, "get_asr_pipeline"))

        # Тест отправки чисто голосового запроса через /api/ask/ без текстового поля
        from django.core.files.uploadedfile import SimpleUploadedFile
        voice_upload = SimpleUploadedFile("voice_input.wav", raw_wav_bytes, content_type="audio/wav")
        ask_voice_resp = self.client.post(
            "/api/ask/",
            data={"query": "", "attachments": [voice_upload]},
        )
        self.assertEqual(ask_voice_resp.status_code, 200)
        resp_json = ask_voice_resp.json()
        self.assertIn("assistant_message", resp_json)
        # Проверяем, что вложение сохранено в БД в виде base64 data URI без записи файла на диск сервера
        user_atts = resp_json.get("user_message", {}).get("attachments", [])
        self.assertGreater(len(user_atts), 0)
        self.assertTrue(user_atts[0]["url"].startswith("data:audio/wav;base64,"))
        self.assertIn("base64", user_atts[0])
        self.assertEqual(user_atts[0]["mime_type"], "audio/wav")
        self.assertEqual(user_atts[0]["duration"], 1.0)

        # Тест эндпоинта /api/transcode-audio/
        transcode_upload = SimpleUploadedFile("engine_sound.wav", raw_wav_bytes, content_type="audio/wav")
        tc_resp = self.client.post("/api/transcode-audio/", data={"file": transcode_upload})
        self.assertEqual(tc_resp.status_code, 200)
        tc_data = tc_resp.json()
        self.assertTrue(tc_data.get("ok"))
        self.assertTrue(tc_data.get("wav_data_url", "").startswith("data:audio/wav;base64,"))
        self.assertEqual(tc_data.get("duration"), 1.0)

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

    def test_09_message_deletion_and_multiformat_documents(self):
        """Проверка удаления сообщений из чата/контекста и расширенного парсинга документов."""
        session = DialogSession.objects.create(
            title="Тест удаления сообщений",
            vehicle_info="BMW 320d F30",
            summary="Выжимка: обнаружены множественные пропуски зажигания P0300.",
        )
        msg1 = ChatMessage.objects.create(session=session, role="user", content="Вопрос 1: троит двигатель")
        msg2 = ChatMessage.objects.create(session=session, role="assistant", content="Ответ 1: проверьте свечи")
        msg3 = ChatMessage.objects.create(session=session, role="user", content="Вопрос 2: проверил свечи")

        # 1. Удаление одного сообщения через POST/DELETE /api/messages/<id>/delete/
        del_single_resp = self.client.post(f"/api/messages/{msg1.id}/delete/")
        self.assertEqual(del_single_resp.status_code, 200)
        self.assertFalse(ChatMessage.objects.filter(id=msg1.id).exists())

        # 2. Массовое удаление через POST /api/messages/delete/
        del_batch_resp = self.client.post(
            "/api/messages/delete/",
            data=json.dumps({"message_ids": [msg2.id]}),
            content_type="application/json",
        )
        self.assertEqual(del_batch_resp.status_code, 200)
        self.assertFalse(ChatMessage.objects.filter(id=msg2.id).exists())
        self.assertTrue(ChatMessage.objects.filter(id=msg3.id).exists())

        # 3. Полная очистка чата через POST /api/messages/delete/ с delete_all
        clear_all_resp = self.client.post(
            "/api/messages/delete/",
            data=json.dumps({"session_id": str(session.id), "delete_all": True}),
            content_type="application/json",
        )
        self.assertEqual(clear_all_resp.status_code, 200)
        self.assertEqual(ChatMessage.objects.filter(session=session).count(), 0)
        session.refresh_from_db()
        self.assertEqual(session.summary, "")

        # 4. Проверка парсинга текстовых/CSV/XLSX документов
        csv_data = "Код_ошибки,Описание,Статус\nP0171,Система слишком бедная,Активна\nP0420,Эффективность катализатора ниже порога,В памяти".encode("utf-8")
        parsed_csv = parse_uploaded_document(csv_data, "diagnostics_table.csv")
        self.assertIn("P0171", parsed_csv["detected_dtc_codes"])
        self.assertIn("P0420", parsed_csv["detected_dtc_codes"])
        self.assertIn("Система слишком бедная", parsed_csv["extracted_text"])
        self.assertTrue(parsed_csv["is_fully_processed"])
        self.assertEqual(parsed_csv["processing_mode"], "full")
        self.assertEqual(parsed_csv["llm_ready_text"], parsed_csv["extracted_text"])

        # 5. Проверка интеллектуальной выборки для сверхдлинных документов (> 25000 символов)
        large_log_lines = ["Header Line: OBD-II CAN-Bus Telemetry Log"]
        for i in range(1200):
            if i == 150:
                large_log_lines.append(f"Line {i}: CRITICAL ERROR P0301 Cylinder 1 Misfire Detected Engine_Temp=104 C")
            elif i == 800:
                large_log_lines.append(f"Line {i}: WARNING P0113 Intake Air Temperature Sensor 1 Circuit High")
            else:
                large_log_lines.append(f"Line {i}: Telemetry normal packet rpm=2150 vbatt=14.1 speed=62.5 km/h")
        large_log_lines.append("Tail Line: Final diagnostic state OK")
        large_log_bytes = "\n".join(large_log_lines).encode("utf-8")
        parsed_large = parse_uploaded_document(large_log_bytes, "huge_obd_dump.log")
        self.assertFalse(parsed_large["is_fully_processed"])
        self.assertEqual(parsed_large["processing_mode"], "smart_sampled")
        self.assertIn("P0301", parsed_large["detected_dtc_codes"])
        self.assertIn("P0113", parsed_large["detected_dtc_codes"])
        self.assertIn("P0301", parsed_large["llm_ready_text"])
        self.assertIn("P0113", parsed_large["llm_ready_text"])
        self.assertIn("Header Line:", parsed_large["llm_ready_text"])
        self.assertIn("Tail Line:", parsed_large["llm_ready_text"])

        # 6. Проверка извлечения встроенных изображений из DOCX
        import docx
        doc_obj = docx.Document()
        doc_obj.add_paragraph("Отчёт осмотра дроссельного узла P0122")
        test_img = Image.new("RGB", (120, 120), color=(200, 50, 50))
        img_bytes_io = io.BytesIO()
        test_img.save(img_bytes_io, format="JPEG")
        img_bytes_io.seek(0)
        doc_obj.add_picture(img_bytes_io)
        docx_buf = io.BytesIO()
        doc_obj.save(docx_buf)
        parsed_docx = parse_uploaded_document(docx_buf.getvalue(), "throttle_inspection.docx")
        self.assertIn("P0122", parsed_docx["detected_dtc_codes"])
        self.assertGreaterEqual(len(parsed_docx["embedded_images_bytes"]), 1)
        self.assertGreaterEqual(len(parsed_docx["embedded_images_data_urls"]), 1)
        self.assertTrue(parsed_docx["embedded_images_data_urls"][0].startswith("data:image/jpeg;base64,"))


    def test_10_projects_pinning_tagging_and_renaming(self):
        """Проверка создания проектов, закрепления, тегирования, переименования диалогов и удаления проектов."""
        # Аутентификация пользователя для проверки персистентности в БД
        self.client.post(
            "/api/auth/register/",
            data=json.dumps({"username": "user_park_mgr", "password": "Password123!", "password_confirm": "Password123!"}),
            content_type="application/json",
        )

        # 1. Создание проекта через API
        proj_resp = self.client.post(
            "/api/projects/",
            data=json.dumps({"name": "Парк такси Skoda Octavia", "description": "Диагностика автопарка"}),
            content_type="application/json",
        )
        self.assertEqual(proj_resp.status_code, 201)
        proj_data = proj_resp.json()
        proj_id = proj_data["id"]
        self.assertEqual(proj_data["name"], "Парк такси Skoda Octavia")

        # 2. Создание сессий: с проектом и без проекта
        s1_resp = self.client.post(
            "/api/sessions/",
            data=json.dumps({"vehicle_info": "Skoda Octavia 1.6", "project_id": proj_id, "title": "Диагностика #1"}),
            content_type="application/json",
        )
        self.assertEqual(s1_resp.status_code, 201)
        s1_id = s1_resp.json()["id"]

        s2_resp = self.client.post(
            "/api/sessions/",
            data=json.dumps({"vehicle_info": "Toyota Camry", "title": "Диагностика #2"}),
            content_type="application/json",
        )
        self.assertEqual(s2_resp.status_code, 201)
        s2_id = s2_resp.json()["id"]

        # 3. Закрепление (Pin/Unpin)
        pin_resp = self.client.post(f"/api/sessions/{s1_id}/pin/")
        self.assertEqual(pin_resp.status_code, 200)
        self.assertTrue(pin_resp.json()["is_pinned"])
        s1 = DialogSession.objects.get(id=s1_id)
        self.assertTrue(s1.is_pinned)

        # 4. Переименование (Rename)
        rename_resp = self.client.post(
            f"/api/sessions/{s1_id}/rename/",
            data=json.dumps({"title": "Skoda Octavia — Пропуск зажигания"}),
            content_type="application/json",
        )
        self.assertEqual(rename_resp.status_code, 200)
        self.assertEqual(rename_resp.json()["title"], "Skoda Octavia — Пропуск зажигания")

        # 5. Тегирование (Tag)
        tag_resp = self.client.post(
            f"/api/sessions/{s1_id}/tag/",
            data=json.dumps({"tag": "ДВС"}),
            content_type="application/json",
        )
        self.assertEqual(tag_resp.status_code, 200)
        self.assertEqual(tag_resp.json()["tag"], "ДВС")

        # 6. Переименование проекта (Rename project)
        ren_proj_resp = self.client.post(
            f"/api/projects/{proj_id}/",
            data=json.dumps({"name": "Парк такси Skoda Octavia (Обновленный)"}),
            content_type="application/json",
        )
        self.assertEqual(ren_proj_resp.status_code, 200)
        self.assertEqual(ren_proj_resp.json()["project"]["name"], "Парк такси Skoda Octavia (Обновленный)")

        # 7. Фильтрация сессий по проекту
        filter_proj_resp = self.client.get(f"/api/sessions/?project_id={proj_id}")
        self.assertEqual(filter_proj_resp.status_code, 200)
        filtered_proj_sessions = filter_proj_resp.json()["sessions"]
        self.assertEqual(len(filtered_proj_sessions), 1)
        self.assertEqual(filtered_proj_sessions[0]["id"], s1_id)

        # 8. Фильтрация сессий по тегу
        filter_tag_resp = self.client.get("/api/sessions/?tag=ДВС")
        self.assertEqual(filter_tag_resp.status_code, 200)
        filtered_tag_sessions = filter_tag_resp.json()["sessions"]
        self.assertEqual(len(filtered_tag_sessions), 1)
        self.assertEqual(filtered_tag_sessions[0]["tag"], "ДВС")

        # 9. Проверка получения деталей сессии (GET /api/sessions/<id>/)
        detail_resp = self.client.get(f"/api/sessions/{s1_id}/")
        self.assertEqual(detail_resp.status_code, 200)
        detail_json = detail_resp.json()
        self.assertEqual(detail_json["id"], s1_id)
        self.assertEqual(detail_json["title"], "Skoda Octavia — Пропуск зажигания")
        self.assertEqual(detail_json["tag"], "ДВС")
        self.assertIn("messages", detail_json)

        # 10. Проверка обновления деталей сессии (PATCH /api/sessions/<id>/)
        patch_resp = self.client.patch(
            f"/api/sessions/{s1_id}/",
            data=json.dumps({"summary": "Проверено состояние свечей"}),
            content_type="application/json",
        )
        self.assertEqual(patch_resp.status_code, 200)

        # 11. Проверка отдачи главной страницы
        idx_resp = self.client.get("/")
        self.assertEqual(idx_resp.status_code, 200)
        self.assertIn("projects", idx_resp.context)
        self.assertIn("all_tags", idx_resp.context)

        # 12. Удаление проекта через API
        del_proj_resp = self.client.delete(f"/api/projects/{proj_id}/")
        self.assertEqual(del_proj_resp.status_code, 200)
        self.assertFalse(DiagnosticProject.objects.filter(id=proj_id).exists())

    def test_11_user_authentication_and_multi_tenant_isolation(self):
        """Проверка регистрации, входа, выхода и изоляции диалогов/проектов между пользователями."""
        # 1. Проверка исходного статуса гостя
        guest_status = self.client.get("/api/auth/status/")
        self.assertEqual(guest_status.status_code, 200)
        self.assertFalse(guest_status.json()["is_authenticated"])

        # 2. Регистрация первого пользователя
        reg1_resp = self.client.post(
            "/api/auth/register/",
            data=json.dumps({"username": "mechanic_ivan", "password": "Password123!", "password_confirm": "Password123!"}),
            content_type="application/json",
        )
        self.assertEqual(reg1_resp.status_code, 201)
        self.assertTrue(reg1_resp.json()["is_authenticated"])
        self.assertEqual(reg1_resp.json()["user"]["username"], "mechanic_ivan")

        # 3. Создание проекта и сессии под первым пользователем
        p1_resp = self.client.post(
            "/api/projects/",
            data=json.dumps({"name": "Проект Ивана", "description": "Сервис VAG"}),
            content_type="application/json",
        )
        self.assertEqual(p1_resp.status_code, 201)
        p1_id = p1_resp.json()["id"]

        s1_resp = self.client.post(
            "/api/sessions/",
            data=json.dumps({"vehicle_info": "VW Golf 7", "project_id": p1_id, "title": "Диагностика Гольфа"}),
            content_type="application/json",
        )
        self.assertEqual(s1_resp.status_code, 201)
        s1_id = s1_resp.json()["id"]

        # 4. Выход первого пользователя
        logout_resp = self.client.post("/api/auth/logout/")
        self.assertEqual(logout_resp.status_code, 200)
        self.assertFalse(logout_resp.json()["is_authenticated"])

        # 5. Регистрация второго пользователя
        reg2_resp = self.client.post(
            "/api/auth/register/",
            data=json.dumps({"username": "mechanic_olga", "password": "Password456!", "password_confirm": "Password456!"}),
            content_type="application/json",
        )
        self.assertEqual(reg2_resp.status_code, 201)
        self.assertEqual(reg2_resp.json()["user"]["username"], "mechanic_olga")

        # 6. Проверка изоляции: Ольга НЕ должна видеть проекты и сессии Ивана
        olga_projects = self.client.get("/api/projects/").json()["projects"]
        self.assertEqual(len(olga_projects), 0)

        olga_sessions = self.client.get("/api/sessions/").json()["sessions"]
        olga_session_ids = [s["id"] for s in olga_sessions]
        self.assertNotIn(s1_id, olga_session_ids)

        # 7. Ольга создает свой проект
        p2_resp = self.client.post(
            "/api/projects/",
            data=json.dumps({"name": "Проект Ольги", "description": "Сервис BMW"}),
            content_type="application/json",
        )
        self.assertEqual(p2_resp.status_code, 201)
        p2_id = p2_resp.json()["id"]

        olga_projects_updated = self.client.get("/api/projects/").json()["projects"]
        self.assertEqual(len(olga_projects_updated), 1)
        self.assertEqual(olga_projects_updated[0]["name"], "Проект Ольги")

        # 8. Вход обратно под Иваном: Иван видит только свой проект и сессию
        self.client.post("/api/auth/logout/")
        login_ivan = self.client.post(
            "/api/auth/login/",
            data=json.dumps({"username": "mechanic_ivan", "password": "Password123!"}),
            content_type="application/json",
        )
        self.assertEqual(login_ivan.status_code, 200)
        self.assertEqual(login_ivan.json()["user"]["username"], "mechanic_ivan")

        ivan_projects = self.client.get("/api/projects/").json()["projects"]
        self.assertEqual(len(ivan_projects), 1)
        self.assertEqual(ivan_projects[0]["name"], "Проект Ивана")

        ivan_sessions = self.client.get("/api/sessions/").json()["sessions"]
        ivan_session_ids = [s["id"] for s in ivan_sessions]
        self.assertIn(s1_id, ivan_session_ids)
        self.assertNotIn(olga_session_ids[0], ivan_session_ids)

    def test_12_demo_mode_and_account_deletion(self):
        """Проверка работы демо-режима без сохранения в БД и полного удаления аккаунта."""
        # 1. Гостевой клиент (Демо-режим)
        guest_client = Client()
        msg_count_before = ChatMessage.objects.count()
        sess_count_before = DialogSession.objects.count()
        proj_count_before = DiagnosticProject.objects.count()

        # Запрос к эксперту в демо-режиме
        demo_ask = guest_client.post(
            "/api/ask/",
            data=json.dumps({
                "query": "Диагностика в демо режиме",
                "dtc_codes": ["P0300"],
            }),
            content_type="application/json",
        )
        self.assertEqual(demo_ask.status_code, 200)
        demo_data = demo_ask.json()
        self.assertTrue(demo_data.get("is_demo", False))
        self.assertIn("assistant_message", demo_data)

        # Проверка, что в БД ничего не сохранилось!
        self.assertEqual(ChatMessage.objects.count(), msg_count_before)
        self.assertEqual(DialogSession.objects.count(), sess_count_before)
        self.assertEqual(DiagnosticProject.objects.count(), proj_count_before)

        # Проект в демо-режиме
        demo_proj = guest_client.post(
            "/api/projects/",
            data=json.dumps({"name": "Демо Проект"}),
            content_type="application/json",
        )
        self.assertEqual(demo_proj.status_code, 201)
        self.assertEqual(DiagnosticProject.objects.count(), proj_count_before)

        # 2. Регистрация пользователя и удаление аккаунта
        reg_resp = self.client.post(
            "/api/auth/register/",
            data=json.dumps({"username": "user_to_delete", "password": "DeleteMe123!", "password_confirm": "DeleteMe123!"}),
            content_type="application/json",
        )
        self.assertEqual(reg_resp.status_code, 201)

        # Создаем проект и сессию под этим аккаунтом
        p_resp = self.client.post("/api/projects/", data=json.dumps({"name": "Проект для удаления"}), content_type="application/json")
        self.assertEqual(p_resp.status_code, 201)
        p_id = p_resp.json()["id"]

        s_resp = self.client.post("/api/sessions/", data=json.dumps({"project_id": p_id, "title": "Сессия"}), content_type="application/json")
        self.assertEqual(s_resp.status_code, 201)

        # Вызов API удаления аккаунта
        del_acc_resp = self.client.post("/api/auth/delete-account/")
        self.assertEqual(del_acc_resp.status_code, 200)
        self.assertTrue(del_acc_resp.json()["success"])

        # Проверка, что пользователь и его данные удалены из БД
        from django.contrib.auth.models import User
        self.assertFalse(User.objects.filter(username="user_to_delete").exists())
        self.assertFalse(DiagnosticProject.objects.filter(id=p_id).exists())

        # Сессия сброшена, статус гостя
        status_after = self.client.get("/api/auth/status/")
        self.assertFalse(status_after.json()["is_authenticated"])

    def test_13_api_preview_document(self):
        """Проверка быстрого API предпросмотра содержимого технического документа для модели."""
        from django.core.files.uploadedfile import SimpleUploadedFile

        # 1. Запрос без файла -> 400
        resp_no_file = self.client.post("/api/preview-document/")
        self.assertEqual(resp_no_file.status_code, 400)

        # 2. Передача лог-файла с кодом ошибки
        log_content = b"=== OBD-II Diagnostic Report ===\nDTC Error: P0300 Random Cylinder Misfire Detected\nEngine RPM: 2450\nCoolant Temp: 92C"
        test_file = SimpleUploadedFile("engine_diagnostic.log", log_content, content_type="text/plain")

        resp = self.client.post("/api/preview-document/", {"file": test_file})
        self.assertEqual(resp.status_code, 200)
        data = resp.json()

        self.assertEqual(data["filename"], "engine_diagnostic.log")
        self.assertEqual(data["extension"], ".log")
        self.assertEqual(data["size_bytes"], len(log_content))
        self.assertTrue(data["is_fully_processed"])
        self.assertEqual(data["processing_mode"], "full")
        self.assertIn("P0300", data["detected_dtc_codes"])
        self.assertIn("P0300 Random Cylinder Misfire", data["llm_ready_text"])
        self.assertEqual(data["embedded_images_count"], 0)

    def test_14_hybrid_json_followup_and_vehicle_detection(self):
        """Проверка гибридного разбора prose + JSON, сохранения пустых списков для followup и автоопределения авто."""
        from diagnostics.schemas import DetectedFault, DiagnosticStructuredResponse, RepairTaskStep

        fallback = DiagnosticStructuredResponse(
            response_type="diagnosis",
            summary_title="Первичная диагностика P0300",
            mentor_reply="",
            faults=[
                DetectedFault(
                    code="P0300",
                    system="engine",
                    system_ru="Двигатель",
                    title="Пропуски зажигания",
                    root_cause="Свечи/катушки/впуск",
                )
            ],
            repair_steps=[
                RepairTaskStep(step_number=1, title="Проверка свечей", instruction="Осмотреть свечи")
            ],
        )

        # 1. На followup модель выдает текст перед fenced JSON с пустыми faults/repair_steps: шаблон НЕ должен затирать []
        hybrid_followup = (
            "Раз свечи и катушки заменены, а компрессия по 12 бар — исключаем механику и зажигание. "
            "Проверьте баланс форсунок и подсос через впуск.\n\n"
            "```json\n"
            '{"response_type": "followup", "summary_title": "Проверка форсунок 2-3 цил", '
            '"vehicle_detected": "Skoda Octavia 1.4 TSI", "faults": [], "inventory": [], "repair_steps": [], '
            '"follow_up_question": "Какая долговременная коррекция LTFT на холостом ходу?"}\n'
            "```"
        )
        parsed = validate_and_coerce_structured_json(hybrid_followup, fallback_response=fallback)
        self.assertEqual(parsed.response_type, "followup")
        self.assertEqual(parsed.vehicle_detected, "Skoda Octavia 1.4 TSI")
        self.assertIn("компрессия по 12 бар", parsed.mentor_reply)
        self.assertEqual(len(parsed.faults), 0)
        self.assertEqual(len(parsed.repair_steps), 0)

        # 2. Скрытые рассуждения Gemma <|channel>thought...<channel|> вырезаются без утечки пользователю
        with_thought = "<|channel>thought\nПроверим симптомы.<channel|>Вероятно виноват ступичный подшипник."
        cleaned_res = validate_and_coerce_structured_json(with_thought)
        self.assertNotIn("channel>", cleaned_res.mentor_reply)
        self.assertIn("ступичный подшипник", cleaned_res.mentor_reply)

    def test_15_cross_tenant_endpoint_ownership_security(self):
        """Проверка строгой защиты чужих сессий и чеклистов между пользователями и гостями."""
        self.client.post(
            "/api/auth/register/",
            data=json.dumps({"username": "owner_u1", "password": "Password123!", "password_confirm": "Password123!"}),
            content_type="application/json",
        )
        s_resp = self.client.post(
            "/api/sessions/",
            data=json.dumps({"vehicle_info": "BMW X5 F15", "title": "Приватная сессия"}),
            content_type="application/json",
        )
        private_sid = s_resp.json()["id"]
        ask_resp = self.client.post(
            "/api/ask/",
            data=json.dumps({"session_id": private_sid, "query": "Ошибка P0300"}),
            content_type="application/json",
        )
        self.assertEqual(ask_resp.status_code, 200)
        private_msg_id = ask_resp.json()["assistant_message"]["id"]

        # Гость (после logout) не может читать/удалять приватную сессию и сообщения
        self.client.post("/api/auth/logout/")
        self.assertEqual(self.client.get(f"/api/worker-status/{private_sid}/").status_code, 403)
        self.assertEqual(
            self.client.post(
                f"/api/messages/{private_msg_id}/toggle-task/",
                data=json.dumps({"type": "step", "id": 1, "checked": True}),
                content_type="application/json",
            ).status_code,
            403,
        )
        self.assertEqual(self.client.delete(f"/api/messages/{private_msg_id}/delete/").status_code, 403)

        # Второй пользователь (attacker_u2) также получает 403 при попытке вмешаться в чужую сессию
        self.client.post(
            "/api/auth/register/",
            data=json.dumps({"username": "attacker_u2", "password": "Password123!", "password_confirm": "Password123!"}),
            content_type="application/json",
        )
        self.assertEqual(
            self.client.post(
                "/api/ask/",
                data=json.dumps({"session_id": private_sid, "query": "P0300"}),
                content_type="application/json",
            ).status_code,
            403,
        )
        self.assertEqual(
            self.client.post(
                "/api/messages/delete/",
                data=json.dumps({"session_id": private_sid, "delete_all": True}),
                content_type="application/json",
            ).status_code,
            403,
        )

    def test_16_legal_pages_and_cancel_generation(self):
        """Проверка страниц Пользовательского соглашения, Политики конфиденциальности и API отмены."""
        # 1. Страницы документов (соответствие 152-ФЗ РФ + упоминание веб и Android com.mmcco.aidealauto)
        terms_resp = self.client.get("/terms/")
        self.assertEqual(terms_resp.status_code, 200)
        self.assertContains(terms_resp, "Пользовательское соглашение")
        self.assertContains(terms_resp, "GPL")
        self.assertContains(terms_resp, "152-ФЗ")
        self.assertContains(terms_resp, "com.mmcco.aidealauto")

        privacy_resp = self.client.get("/privacy/")
        self.assertEqual(privacy_resp.status_code, 200)
        self.assertContains(privacy_resp, "Политика конфиденциальности")
        self.assertContains(privacy_resp, "152-ФЗ")
        self.assertContains(privacy_resp, "com.mmcco.aidealauto")

        # 2. Endpoint отмены генерации
        cancel_resp = self.client.post(
            "/api/cancel/",
            data=json.dumps({"session_id": "non_existent_session"}),
            content_type="application/json",
        )
        self.assertEqual(cancel_resp.status_code, 200)
        data = cancel_resp.json()
        self.assertTrue(data.get("cancelled"))

    def test_17_async_multipart_photo_speech_and_document(self):
        """
        Комплексный тест мультимодального мобильного/AR-конвейера:
        - Загрузка фото узла (JPEG), голосового/аудиофайла (WAV/M4A с распознанной речью) и отчёта OBD (.log)
        - Асинхронный запуск /api/ask/?async=1 -> HTTP 202 -> поллинг /api/ask/job/<id>/
        - Авторизация по X-Session-Key (как в нативном Android-приложении le.codes)
        """
        import wave
        from django.core.files.uploadedfile import SimpleUploadedFile

        reg = self.client.post(
            "/api/auth/register/",
            data=json.dumps(
                {
                    "username": "mobile_mm_tester",
                    "email": "mm@aideal.local",
                    "password": "Password123!",
                    "password_confirm": "Password123!",
                }
            ),
            content_type="application/json",
        )
        self.assertEqual(reg.status_code, 201)
        sess_key = reg.json().get("session_key")
        self.assertTrue(bool(sess_key))

        # 1. Фото узла (JPEG)
        img = Image.new("RGB", (320, 240), color=(45, 75, 110))
        img_buf = io.BytesIO()
        img.save(img_buf, format="JPEG")
        photo_file = SimpleUploadedFile("engine_node.jpg", img_buf.getvalue(), content_type="image/jpeg")

        # 2. Синтетический аудиопоток 16kHz (имитация голоса/шума под капотом)
        sr = 16000
        t = np.linspace(0, 1.2, int(sr * 1.2), endpoint=False)
        pcm = (np.sin(2 * np.pi * 220 * t) * 12000).astype(np.int16)
        wav_buf = io.BytesIO()
        with wave.open(wav_buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sr)
            wf.writeframes(pcm.tobytes())
        wav_bytes = wav_buf.getvalue()
        audio_file = SimpleUploadedFile("voice_ar_speech.wav", wav_bytes, content_type="audio/wav")

        # 3. Лог-файл диагностики (.log) с ошибками P0301 и P0171
        log_bytes = (
            "OBD2 Freeze Frame\n"
            "DTC: P0301 Cylinder 1 Misfire Detected, P0171 System Too Lean\n"
            "RPM=840, CoolantTemp=96C, Battery=13.9V\n"
        ).encode("utf-8")
        doc_file = SimpleUploadedFile("obd_scan.log", log_bytes, content_type="text/plain")

        # Проверка /api/transcode-audio/ и /api/preview-document/
        tc_resp = self.client.post(
            "/api/transcode-audio/",
            data={"file": SimpleUploadedFile("voice_rec.wav", wav_bytes, content_type="audio/wav")},
            HTTP_X_SESSION_KEY=sess_key,
        )
        self.assertEqual(tc_resp.status_code, 200)
        self.assertTrue(tc_resp.json().get("ok"))

        prev_resp = self.client.post(
            "/api/preview-document/",
            data={"file": SimpleUploadedFile("obd_prev.log", log_bytes, content_type="text/plain")},
            HTTP_X_SESSION_KEY=sess_key,
        )
        self.assertEqual(prev_resp.status_code, 200)
        self.assertIn("P0301", prev_resp.json().get("detected_dtc_codes", []))
        self.assertIn("P0171", prev_resp.json().get("detected_dtc_codes", []))

        # 4. Асинхронная мультимодальная отправка на /api/ask/?async=1
        async_resp = self.client.post(
            "/api/ask/?async=1",
            data={
                "query": "Проверь катушку зажигания и подсос воздуха на фото",
                "vehicle_info": "Skoda Octavia A7 1.4 TSI",
                "dtc_codes": json.dumps(["P0301"]),
                "voice_transcript": "Троит первый цилиндр на холодную при запуске",
                "attachments": [photo_file, audio_file, doc_file],
            },
            HTTP_X_SESSION_KEY=sess_key,
        )
        self.assertEqual(async_resp.status_code, 202)
        job_id = async_resp.json()["job_id"]

        # 5. Поллинг /api/ask/job/<job_id>/
        job_payload = None
        for _ in range(40):
            poll = self.client.get(f"/api/ask/job/{job_id}/", HTTP_X_SESSION_KEY=sess_key)
            self.assertEqual(poll.status_code, 200)
            jp = poll.json()
            if jp["status"] in ("done", "error"):
                job_payload = jp
                break
            time.sleep(0.08)

        self.assertIsNotNone(job_payload)
        self.assertEqual(job_payload["status"], "done")
        result = job_payload["result"]
        user_atts = result["user_message"]["attachments"]
        att_types = [a["type"] for a in user_atts]
        self.assertIn("image", att_types)
        self.assertIn("audio", att_types)
        self.assertIn("document", att_types)

        audio_att = next(a for a in user_atts if a["type"] == "audio")
        self.assertTrue(audio_att["url"].startswith("data:audio/wav;base64,"))
        self.assertEqual(audio_att["transcript"], "Троит первый цилиндр на холодную при запуске")

        tool_names = [
            tc["tool_name"]
            for tc in result["assistant_message"]["structured_data"].get("tool_calls", [])
        ]
        self.assertIn("inspect_attached_image", tool_names)
        self.assertIn("inspect_attached_audio", tool_names)

    def test_18_autotune_calibration_math_cache_and_gitignore(self):
        """Проверка расчёта профилей авто-калибратора AirLLM, кэширования по GPU/VRAM и исключения из Git."""
        import tempfile
        from pathlib import Path
        from diagnostics.autotune import (
            compute_optimal_profile,
            compute_vram_bucket_mb,
            load_cached_profile,
            save_cached_profile,
        )

        # 1. Профиль для 8 ГБ GPU (умеренный tok/s): без thinking, валидный JSON-бюджет в SLA <= 60 с
        p_mid = compute_optimal_profile(
            gpu_name="NVIDIA GeForce RTX 3050",
            vram_total_mb=8192,
            vram_free_bucket_mb=compute_vram_bucket_mb(5159),
            optimal_gpu_layers=28,
            prefill_ms=2800,
            decode_tps=4.5,
            min_free_vram_mb=950,
            target_sla_sec=55.0,
        )
        self.assertEqual(p_mid.optimal_gpu_layers, 28)
        self.assertEqual(p_mid.streamed_layers, 20)
        self.assertFalse(p_mid.enable_thinking)
        self.assertTrue(p_mid.compact_json)
        self.assertGreaterEqual(p_mid.max_new_tokens_diag, 220)
        self.assertLessEqual(p_mid.max_time_sec_diag, 60.0)

        # 2. Профиль для быстрой GPU (>= 12 ГБ, высокий tok/s): максимум качества + enable_thinking=True
        p_fast = compute_optimal_profile(
            gpu_name="NVIDIA GeForce RTX 4080",
            vram_total_mb=16384,
            vram_free_bucket_mb=compute_vram_bucket_mb(14000),
            optimal_gpu_layers=48,
            prefill_ms=900,
            decode_tps=18.0,
            min_free_vram_mb=4000,
            target_sla_sec=55.0,
        )
        self.assertTrue(p_fast.enable_thinking)
        self.assertFalse(p_fast.compact_json)
        self.assertGreaterEqual(p_fast.max_new_tokens_diag, 960)
        self.assertEqual(p_fast.rag_top_n, 3)

        # 3. Проверка восстановления усечённого JSON при обрыве генерации по 60с SLA
        from diagnostics.schemas import DiagnosticStructuredResponse, validate_and_coerce_structured_json

        truncated_llm = (
            "На Skoda Octavia 1.8 TSI (CJSA) ошибка P0171 со свистом на ХХ и LTFT +18% "
            "указывает на разрыв мембраны маслоотделителя КВКГ.\n\n"
            "```json\n"
            '{"response_type":"diagnosis","summary_title":"Подсос через КВКГ (P0171) на 1.8 TSI",'
            '"vehicle_detected":"Skoda Octavia 1.8 TSI (CJSA)",'
            '"faults":[{"code":"P0171","system":"engine","title":"Разрыв мембраны КВКГ","severity":"warning","confidence":90,"root_cause":"Неучтённый воздух на ХХ"}],'
            '"repair_steps":[{"step_number":1,"title":"Проверка крышки КВКГ","instruction":"Приоткройте маслозаливную крышку на ХХ."},'
            '{"step_number":2,"title":"Опрессовка дымом","instruction":"Подайте дым 0.6 бар во впуск и проверь'
        )
        fb = DiagnosticStructuredResponse(
            response_type="diagnosis",
            summary_title="Fallback заголовок",
            mentor_reply="Fallback текст",
            follow_up_question="Какой шаг выполняете?",
        )
        recovered = validate_and_coerce_structured_json(truncated_llm, fallback_response=fb)
        self.assertEqual(recovered.summary_title, "Подсос через КВКГ (P0171) на 1.8 TSI")
        self.assertEqual(recovered.vehicle_detected, "Skoda Octavia 1.8 TSI (CJSA)")
        self.assertIn("КВКГ", recovered.mentor_reply)
        self.assertEqual(len(recovered.faults), 1)
        self.assertEqual(recovered.faults[0].code, "P0171")
        self.assertEqual(recovered.faults[0].system_ru, "Двигатель")
        self.assertGreaterEqual(len(recovered.repair_steps), 1)
        self.assertEqual(recovered.repair_steps[0].title, "Проверка крышки КВКГ")

        # Если обрыв произошёл на недописанном fault-объекте без title/root_cause — подставляется богатая карточка из fallback
        stub_fault_llm = (
            "Физическая причина — подсос воздуха через КВКГ.\n\n"
            '```json\n{"response_type":"diagnosis","summary_title":"Подсос через КВКГ",'
            '"vehicle_detected":"Skoda Octavia 1.8 TSI","faults":[{"code":"P0171","system":"engine","title":"Подс'
        )
        from diagnostics.schemas import DetectedFault
        fb_rich = DiagnosticStructuredResponse(
            response_type="diagnosis",
            summary_title="Fallback",
            mentor_reply="Fallback",
            faults=[
                DetectedFault(
                    code="P0171",
                    system="engine",
                    system_ru="Двигатель",
                    title="Бедная смесь Bank 1",
                    severity="warning",
                    confidence=95,
                    health_index=66.0,
                    root_cause="Подсос воздуха во впуск",
                )
            ],
        )
        rec_stub = validate_and_coerce_structured_json(stub_fault_llm, fallback_response=fb_rich)
        self.assertEqual(rec_stub.summary_title, "Подсос через КВКГ")
        self.assertEqual(rec_stub.vehicle_detected, "Skoda Octavia 1.8 TSI")
        self.assertEqual(rec_stub.faults[0].title, "Бедная смесь Bank 1")
        self.assertEqual(rec_stub.faults[0].system_ru, "Двигатель")

        # 3. Сохранение, загрузка кэша и инвалидация при смене железа / VRAM / AIRLLM_RECALIBRATE=1
        with tempfile.TemporaryDirectory() as tmpdir:
            shards = Path(tmpdir)
            saved = save_cached_profile(shards, p_mid)
            self.assertTrue(saved.exists())

            loaded = load_cached_profile(
                shards,
                gpu_name="NVIDIA GeForce RTX 3050",
                vram_total_mb=8192,
                vram_free_bucket_mb=p_mid.vram_free_bucket_mb,
                target_sla_sec=55.0,
            )
            self.assertIsNotNone(loaded)
            self.assertEqual(loaded.source, "cache")
            self.assertEqual(loaded.optimal_gpu_layers, 28)

            # Другая GPU -> кэш не подходит -> требуется перекалибровка
            wrong_gpu = load_cached_profile(
                shards,
                gpu_name="NVIDIA GeForce RTX 4060",
                vram_total_mb=8192,
                vram_free_bucket_mb=p_mid.vram_free_bucket_mb,
                target_sla_sec=55.0,
            )
            self.assertIsNone(wrong_gpu)

            # Резкое изменение свободной VRAM -> перекалибровка
            wrong_vram = load_cached_profile(
                shards,
                gpu_name="NVIDIA GeForce RTX 3050",
                vram_total_mb=8192,
                vram_free_bucket_mb=p_mid.vram_free_bucket_mb - 2048,
                target_sla_sec=55.0,
            )
            self.assertIsNone(wrong_vram)

        # 4. Проверка .gitignore: профиль калибровки строго исключён из Git
        from django.conf import settings as dj_settings
        gi_text = (Path(dj_settings.BASE_DIR) / ".gitignore").read_text(encoding="utf-8")
        self.assertIn("autotune_profile.json", gi_text)

    @staticmethod
    def _wait_worker(session_id: str, timeout_steps: int = 40) -> None:
        for _ in range(timeout_steps):
            if not context_worker_manager.get_worker_state(str(session_id))["is_running"]:
                return
            time.sleep(0.05)

    def test_19_cross_account_global_memory_isolation(self):
        """Проверка строгой изоляции междиалоговой памяти между User A, User B, гостем и LLM-вызовами."""
        from unittest.mock import patch
        from django.contrib.auth import get_user_model
        from .airllm_vulkan_service import orchestrator

        User = get_user_model()
        user_a = User.objects.create_user(username="iso_user_a", password="Password123!")
        user_b = User.objects.create_user(username="iso_user_b", password="Password123!")

        # Искусственно помещаем устаревшие данные в SystemSettings — они НИКОГДА не должны протекать
        sys_cfg = SystemSettings.get_active()
        sys_cfg.global_memory_summary = "POLLUTED_SYSTEM_SECRET"
        sys_cfg.save()

        client_a = Client()
        client_b = Client()
        guest_client = Client()
        client_a.force_login(user_a)
        client_b.force_login(user_b)

        try:
            # User A задает вопрос с уникальным кодом P0300
            sa_resp = client_a.post(
                "/api/sessions/",
                data=json.dumps({"title": "Авто А", "vehicle_info": "Skoda Octavia A7"}),
                content_type="application/json",
            )
            sa_id = sa_resp.json()["id"]
            ask_a = client_a.post(
                "/api/ask/",
                data=json.dumps({"session_id": sa_id, "query": "Троит мотор MARKER_ALPHA", "dtc_codes": ["P0300"]}),
                content_type="application/json",
            )
            self.assertEqual(ask_a.status_code, 200)
            self._wait_worker(sa_id)

            # User B задает вопрос с уникальным кодом P0420
            sb_resp = client_b.post(
                "/api/sessions/",
                data=json.dumps({"title": "Авто Б", "vehicle_info": "Kia Rio 1.6"}),
                content_type="application/json",
            )
            sb_id = sb_resp.json()["id"]
            ask_b = client_b.post(
                "/api/ask/",
                data=json.dumps({"session_id": sb_id, "query": "Низкая эффективность катализатора MARKER_BETA", "dtc_codes": ["P0420"]}),
                content_type="application/json",
            )
            self.assertEqual(ask_b.status_code, 200)
            self._wait_worker(sb_id)

            # 1. Проверка GET /api/settings/
            set_a = client_a.get("/api/settings/").json()
            set_b = client_b.get("/api/settings/").json()
            set_g = guest_client.get("/api/settings/").json()

            self.assertIn("MARKER_ALPHA", set_a["global_memory_summary"])
            self.assertNotIn("MARKER_BETA", set_a["global_memory_summary"])
            self.assertNotIn("POLLUTED_SYSTEM_SECRET", set_a["global_memory_summary"])

            self.assertIn("MARKER_BETA", set_b["global_memory_summary"])
            self.assertNotIn("MARKER_ALPHA", set_b["global_memory_summary"])
            self.assertNotIn("POLLUTED_SYSTEM_SECRET", set_b["global_memory_summary"])

            self.assertEqual(set_g["global_memory_summary"], "")
            self.assertTrue(set_g["cross_dialog_memory_enabled"])

            # 2. Проверка GET /api/sessions/<id>/ и /api/worker-status/<id>/
            det_a = client_a.get(f"/api/sessions/{sa_id}/").json()
            ws_a = client_a.get(f"/api/worker-status/{sa_id}/").json()
            self.assertIn("MARKER_ALPHA", det_a["global_memory_summary"])
            self.assertNotIn("MARKER_BETA", det_a["global_memory_summary"])
            self.assertIn("MARKER_ALPHA", ws_a["global_memory_summary"])
            self.assertNotIn("MARKER_BETA", ws_a["global_memory_summary"])

            # 3. Проверка GET / (HTML + context)
            idx_a = client_a.get("/")
            idx_b = client_b.get("/")
            idx_g = guest_client.get("/")
            self.assertIn("MARKER_ALPHA", idx_a.context["active_settings"].global_memory_summary)
            self.assertNotIn("MARKER_BETA", idx_a.context["active_settings"].global_memory_summary)
            self.assertIn("MARKER_BETA", idx_b.context["active_settings"].global_memory_summary)
            self.assertNotIn("MARKER_ALPHA", idx_b.context["active_settings"].global_memory_summary)
            self.assertEqual(idx_g.context["active_settings"].global_memory_summary, "")
            self.assertNotContains(idx_g, "MARKER_ALPHA")
            self.assertNotContains(idx_g, "POLLUTED_SYSTEM_SECRET")

            # 4. Проверка diagnose_and_respond: передает только память владельца сессии и никогда SystemSettings
            captured_globals = []
            with patch.object(orchestrator, "_run_airllm_inference", side_effect=lambda **kw: (captured_globals.append(kw["global_summary"]), None)[1]):
                sess_a_obj = DialogSession.objects.get(pk=sa_id)
                sess_b_obj = DialogSession.objects.get(pk=sb_id)
                guest_sess = DialogSession(title="Демо")
                orchestrator.diagnose_and_respond("проверка", sess_a_obj, sys_cfg, [], [], [], [])
                orchestrator.diagnose_and_respond("проверка", sess_b_obj, sys_cfg, [], [], [], [])
                orchestrator.diagnose_and_respond("проверка", guest_sess, sys_cfg, [], [], [], [])

            self.assertIn("MARKER_ALPHA", captured_globals[0])
            self.assertNotIn("MARKER_BETA", captured_globals[0])
            self.assertNotIn("POLLUTED_SYSTEM_SECRET", captured_globals[0])
            self.assertIn("MARKER_BETA", captured_globals[1])
            self.assertNotIn("MARKER_ALPHA", captured_globals[1])
            self.assertEqual(captured_globals[2], "")

            # 5. Ручные заметки сохраняются, а выключение cross_dialog_memory_enabled очищает автостроки
            manual_note = "Гараж: компрессор 8 бар"
            upd = client_a.post(
                "/api/settings/",
                data=json.dumps({
                    "cross_dialog_memory_enabled": True,
                    "global_memory_summary": manual_note + "\n" + set_a["global_memory_summary"],
                }),
                content_type="application/json",
            )
            self.assertEqual(upd.status_code, 200)
            rebuilt = context_worker_manager.rebuild_user_cross_dialog_memory(user_a.id)
            self.assertIn(manual_note, rebuilt)
            self.assertIn("MARKER_ALPHA", rebuilt)

            off_resp = client_a.post(
                "/api/settings/",
                data=json.dumps({
                    "cross_dialog_memory_enabled": False,
                    "global_memory_summary": rebuilt,
                }),
                content_type="application/json",
            )
            self.assertEqual(off_resp.status_code, 200)
            off_summary = off_resp.json()["global_memory_summary"]
            self.assertIn(manual_note, off_summary)
            self.assertNotIn("• Сессия «", off_summary)
        finally:
            sys_cfg.global_memory_summary = ""
            sys_cfg.save()

    def test_20_global_memory_clear_and_lifecycle_purge(self):
        """Проверка очистки глобальной памяти (memory_cleared_at) и мгновенного удаления из памяти при удалении сообщений/сессий/проектов."""
        from django.contrib.auth import get_user_model

        User = get_user_model()
        user = User.objects.create_user(username="lifecycle_u1", password="Password123!")
        self.client.force_login(user)

        # 1. Создаем проект и сессию, добавляем два сообщения и ждём воркера
        proj_resp = self.client.post(
            "/api/projects/",
            data=json.dumps({"name": "Проект ЖЦ"}),
            content_type="application/json",
        )
        proj_id = proj_resp.json()["id"]

        s1_resp = self.client.post(
            "/api/sessions/",
            data=json.dumps({"title": "Диалог 1", "vehicle_info": "Lada Vesta", "project_id": proj_id}),
            content_type="application/json",
        )
        s1_id = s1_resp.json()["id"]

        ask1 = self.client.post(
            "/api/ask/",
            data=json.dumps({"session_id": s1_id, "query": "Симптом OLD_SECRET_SYMPTOM код P0300", "dtc_codes": ["P0300"]}),
            content_type="application/json",
        )
        self.assertEqual(ask1.status_code, 200)
        msg1_user_id = ask1.json()["user_message"]["id"]
        msg1_ai_id = ask1.json()["assistant_message"]["id"]

        ask2 = self.client.post(
            "/api/ask/",
            data=json.dumps({"session_id": s1_id, "query": "Второй вопрос KEEP_THIS_SYMPTOM"}),
            content_type="application/json",
        )
        self.assertEqual(ask2.status_code, 200)
        self._wait_worker(s1_id)

        mem_before = UserMemorySettings.for_user(user)[0].global_memory_summary
        self.assertIn("OLD_SECRET_SYMPTOM", mem_before)

        # 2. Частичное удаление сообщения с OLD_SECRET_SYMPTOM мгновенно убирает его из summary и global_memory_summary
        del_one = self.client.post(f"/api/messages/{msg1_user_id}/delete/")
        self.assertEqual(del_one.status_code, 200)
        del_one_json = del_one.json()
        self.assertNotIn("OLD_SECRET_SYMPTOM", del_one_json["session_summary"])
        self.assertNotIn("OLD_SECRET_SYMPTOM", del_one_json["global_memory_summary"])
        self.assertIn("KEEP_THIS_SYMPTOM", del_one_json["session_summary"])

        # 3. Удаление оставшихся сообщений через delete_all=True обнуляет session.summary и убирает сессию из global_memory
        del_all = self.client.post(
            "/api/messages/delete/",
            data=json.dumps({"session_id": s1_id, "delete_all": True}),
            content_type="application/json",
        )
        self.assertEqual(del_all.status_code, 200)
        self.assertEqual(del_all.json()["session_summary"], "")
        self.assertNotIn("Диалог 1", del_all.json()["global_memory_summary"])

        # 4. Новый вопрос + переименование + удаление сессии + удаление проекта
        self.client.post(
            "/api/ask/",
            data=json.dumps({"session_id": s1_id, "query": "Проверка проекта TEMP_PROJ_TOKEN"}),
            content_type="application/json",
        )
        self._wait_worker(s1_id)
        self.assertIn("TEMP_PROJ_TOKEN", UserMemorySettings.for_user(user)[0].global_memory_summary)

        # Переименование отражается в глобальной памяти
        ren = self.client.post(
            f"/api/sessions/{s1_id}/rename/",
            data=json.dumps({"title": "Переименованная сессия"}),
            content_type="application/json",
        )
        self.assertEqual(ren.status_code, 200)
        self.assertIn("Переименованная сессия", UserMemorySettings.for_user(user)[0].global_memory_summary)

        # Удаление проекта очищает глобальную память от сессий этого проекта
        del_proj = self.client.delete(f"/api/projects/{proj_id}/")
        self.assertEqual(del_proj.status_code, 200)
        self.assertNotIn("TEMP_PROJ_TOKEN", UserMemorySettings.for_user(user)[0].global_memory_summary)

        # 5. Очистка глобальной памяти + новая сессия: старые сессии до memory_cleared_at не всплывают
        s_old = self.client.post(
            "/api/sessions/",
            data=json.dumps({"title": "Старая сессия"}),
            content_type="application/json",
        ).json()["id"]
        self.client.post(
            "/api/ask/",
            data=json.dumps({"session_id": s_old, "query": "Старая ошибка BURIED_TOKEN"}),
            content_type="application/json",
        )
        self._wait_worker(s_old)
        self.assertIn("BURIED_TOKEN", UserMemorySettings.for_user(user)[0].global_memory_summary)

        clear_resp = self.client.post(
            "/api/settings/",
            data=json.dumps({"global_memory_summary": "", "clear_global_memory": True}),
            content_type="application/json",
        )
        self.assertEqual(clear_resp.status_code, 200)
        mem_after_clear = UserMemorySettings.for_user(user)[0]
        self.assertEqual(mem_after_clear.global_memory_summary, "")
        self.assertIsNotNone(mem_after_clear.memory_cleared_at)

        # Создаем новую сессию после очистки
        time.sleep(0.02)
        s_new = self.client.post(
            "/api/sessions/",
            data=json.dumps({"title": "Новая сессия"}),
            content_type="application/json",
        ).json()["id"]
        self.client.post(
            "/api/ask/",
            data=json.dumps({"session_id": s_new, "query": "Новый симптом FRESH_TOKEN"}),
            content_type="application/json",
        )
        self._wait_worker(s_new)

        final_mem = UserMemorySettings.for_user(user)[0].global_memory_summary
        self.assertIn("FRESH_TOKEN", final_mem)
        self.assertNotIn("BURIED_TOKEN", final_mem)

        # 6. Удаление сессии убирает её из глобальной памяти
        self.client.delete(f"/api/sessions/{s_new}/")
        self.assertNotIn("FRESH_TOKEN", UserMemorySettings.for_user(user)[0].global_memory_summary)

        # 7. Удаление аккаунта удаляет и UserMemorySettings
        uid = user.id
        del_acc = self.client.post("/api/auth/delete-account/")
        self.assertEqual(del_acc.status_code, 200)
        self.assertFalse(UserMemorySettings.objects.filter(user_id=uid).exists())

    def test_21_idor_and_cancel_generation_isolation(self):
        """Проверка IDOR защиты (/pin, /tag, /rename, /sessions/<id>, /ask/job, /cancel) и защиты /api/settings/ в демо/госте."""
        from django.contrib.auth import get_user_model
        from .airllm_vulkan_service import orchestrator

        User = get_user_model()
        user_a = User.objects.create_user(username="idor_a", password="Password123!")
        user_b = User.objects.create_user(username="idor_b", password="Password123!")

        client_a = Client()
        client_b = Client()
        guest = Client()
        client_a.force_login(user_a)
        client_b.force_login(user_b)

        sa_id = client_a.post(
            "/api/sessions/",
            data=json.dumps({"title": "Приватная А"}),
            content_type="application/json",
        ).json()["id"]

        # Гость и User B не могут pin/tag/rename/get/patch/delete чужую сессию
        for attacker in (guest, client_b):
            self.assertEqual(attacker.post(f"/api/sessions/{sa_id}/pin/").status_code, 403)
            self.assertEqual(
                attacker.post(f"/api/sessions/{sa_id}/tag/", data=json.dumps({"tag": "HACK"}), content_type="application/json").status_code,
                403,
            )
            self.assertEqual(
                attacker.post(f"/api/sessions/{sa_id}/rename/", data=json.dumps({"title": "HACK"}), content_type="application/json").status_code,
                403,
            )
            self.assertEqual(attacker.get(f"/api/sessions/{sa_id}/").status_code, 403)
            self.assertEqual(
                attacker.patch(f"/api/sessions/{sa_id}/", data=json.dumps({"title": "HACK"}), content_type="application/json").status_code,
                403,
            )
            self.assertEqual(attacker.delete(f"/api/sessions/{sa_id}/").status_code, 403)

        # Авторизованный пользователь НЕ может присвоить анонимную (user=None) сессию через /api/ask/
        anon_sess = DialogSession.objects.create(title="Анонимная")
        claim_attempt = client_a.post(
            "/api/ask/",
            data=json.dumps({"session_id": str(anon_sess.id), "query": "test"}),
            content_type="application/json",
        )
        self.assertEqual(claim_attempt.status_code, 403)
        anon_sess.refresh_from_db()
        self.assertIsNone(anon_sess.user_id)

        # Изоляция /api/ask/job/<job_id>/
        async_resp = client_a.post(
            "/api/ask/?async=1",
            data=json.dumps({"session_id": sa_id, "query": "привет"}),
            content_type="application/json",
        )
        self.assertEqual(async_resp.status_code, 202)
        job_id = async_resp.json()["job_id"]
        self.assertEqual(guest.get(f"/api/ask/job/{job_id}/").status_code, 403)
        self.assertEqual(client_b.get(f"/api/ask/job/{job_id}/").status_code, 403)
        for _ in range(30):
            r = client_a.get(f"/api/ask/job/{job_id}/")
            self.assertEqual(r.status_code, 200)
            if r.json()["status"] in ("done", "error"):
                break
            time.sleep(0.05)
        self._wait_worker(sa_id)

        # Изоляция /api/cancel/
        ev_a = threading.Event()
        ev_b = threading.Event()
        orchestrator.register_cancel_event(str(sa_id), ev_a, owner_user_id=user_a.id)
        sb_id = client_b.post("/api/sessions/", data=json.dumps({"title": "Б"}), content_type="application/json").json()["id"]
        orchestrator.register_cancel_event(str(sb_id), ev_b, owner_user_id=user_b.id)
        try:
            self.assertEqual(
                guest.post("/api/cancel/", data=json.dumps({"session_id": sa_id}), content_type="application/json").status_code,
                403,
            )
            self.assertEqual(
                client_b.post("/api/cancel/", data=json.dumps({"session_id": sa_id}), content_type="application/json").status_code,
                403,
            )
            self.assertFalse(ev_a.is_set())

            # Вызов /api/cancel/ без session_id от имени User B отменяет только генерацию User B, не трогая User A
            cancel_b = client_b.post("/api/cancel/", data=json.dumps({}), content_type="application/json")
            self.assertEqual(cancel_b.status_code, 200)
            self.assertTrue(ev_b.is_set())
            self.assertFalse(ev_a.is_set())
        finally:
            orchestrator.unregister_cancel_event(str(sa_id))
            orchestrator.unregister_cancel_event(str(sb_id))

        # Демо и неавторизованный POST /api/settings/ никогда не меняют БД
        mem_a_before = UserMemorySettings.for_user(user_a)[0].global_memory_summary
        demo_post = guest.post(
            "/api/settings/",
            data=json.dumps({"global_memory_summary": "DEMO_POISON", "cross_dialog_memory_enabled": False}),
            headers={"X-Demo-Mode": "1"},
            content_type="application/json",
        )
        self.assertEqual(demo_post.status_code, 200)
        self.assertTrue(demo_post.json().get("is_demo"))
        self.assertEqual(SystemSettings.get_active().global_memory_summary, "")
        self.assertTrue(SystemSettings.get_active().cross_dialog_memory_enabled)
        self.assertEqual(UserMemorySettings.for_user(user_a)[0].global_memory_summary, mem_a_before)

        unauth_post = guest.post(
            "/api/settings/",
            data=json.dumps({"global_memory_summary": "UNAUTH_POISON"}),
            content_type="application/json",
        )
        self.assertEqual(unauth_post.status_code, 401)
        self.assertEqual(SystemSettings.get_active().global_memory_summary, "")

    def test_22_dtc_dictionary_pagination(self):
        """Проверка пагинации словаря DTC через offset/limit и корректной обработки некорректных параметров."""
        p1 = self.client.get("/api/dtc/?q=&system=all&limit=10&offset=0")
        self.assertEqual(p1.status_code, 200)
        d1 = p1.json()
        self.assertEqual(d1["limit"], 10)
        self.assertEqual(d1["offset"], 0)
        self.assertIn("total", d1)
        self.assertIn("total_catalog", d1)
        self.assertLessEqual(len(d1["items"]), 10)

        bad_offset = self.client.get("/api/dtc/?q=&system=all&limit=5&offset=not_an_int")
        self.assertEqual(bad_offset.status_code, 200)
        self.assertEqual(bad_offset.json()["offset"], 0)
        self.assertEqual(bad_offset.json()["limit"], 5)






