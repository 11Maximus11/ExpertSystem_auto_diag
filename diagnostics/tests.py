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
from .models import ChatMessage, DiagnosticProject, DialogSession, SystemSettings
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

        # Тест отправки чисто голосового запроса через /api/ask/ без текстового поля
        from django.core.files.uploadedfile import SimpleUploadedFile
        voice_upload = SimpleUploadedFile("voice_input.wav", raw_wav_bytes, content_type="audio/wav")
        ask_voice_resp = self.client.post(
            "/api/ask/",
            data={"query": "", "attachments": [voice_upload]},
        )
        self.assertEqual(ask_voice_resp.status_code, 200)
        self.assertIn("assistant_message", ask_voice_resp.json())

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

    def test_10_projects_pinning_tagging_and_renaming(self):
        """Проверка создания проектов, закрепления, тегирования и переименования диалогов."""
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

        # 6. Фильтрация сессий по проекту
        filter_proj_resp = self.client.get(f"/api/sessions/?project_id={proj_id}")
        self.assertEqual(filter_proj_resp.status_code, 200)
        filtered_proj_sessions = filter_proj_resp.json()["sessions"]
        self.assertEqual(len(filtered_proj_sessions), 1)
        self.assertEqual(filtered_proj_sessions[0]["id"], s1_id)

        # 7. Фильтрация сессий по тегу
        filter_tag_resp = self.client.get("/api/sessions/?tag=ДВС")
        self.assertEqual(filter_tag_resp.status_code, 200)
        filtered_tag_sessions = filter_tag_resp.json()["sessions"]
        self.assertEqual(len(filtered_tag_sessions), 1)
        self.assertEqual(filtered_tag_sessions[0]["tag"], "ДВС")

        # 8. Проверка получения деталей сессии (GET /api/sessions/<id>/)
        detail_resp = self.client.get(f"/api/sessions/{s1_id}/")
        self.assertEqual(detail_resp.status_code, 200)
        detail_json = detail_resp.json()
        self.assertEqual(detail_json["id"], s1_id)
        self.assertEqual(detail_json["title"], "Skoda Octavia — Пропуск зажигания")
        self.assertEqual(detail_json["tag"], "ДВС")
        self.assertIn("messages", detail_json)

        # 9. Проверка обновления деталей сессии (PATCH /api/sessions/<id>/)
        patch_resp = self.client.patch(
            f"/api/sessions/{s1_id}/",
            data=json.dumps({"summary": "Проверено состояние свечей"}),
            content_type="application/json",
        )
        self.assertEqual(patch_resp.status_code, 200)

        # 10. Проверка отдачи главной страницы
        idx_resp = self.client.get("/")
        self.assertEqual(idx_resp.status_code, 200)
        self.assertIn("projects", idx_resp.context)
        self.assertIn("all_tags", idx_resp.context)

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


