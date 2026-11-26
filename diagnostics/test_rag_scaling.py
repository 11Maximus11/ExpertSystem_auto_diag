# SPDX-License-Identifier: GPL-3.0-or-later
"""
Автономные модульные тесты масштабирования RAG-ядра (13 000+ записей),
двуязычной токенизации (RU + EN), иерархического слияния Tier 1/2/3 и пагинации словаря DTC.
Совместимы как с прямым запуском `python -m unittest diagnostics/test_rag_scaling.py -v`,
так и с `python manage.py test`.
"""

import gzip
import json
import tempfile
import time
import unittest
from pathlib import Path
from typing import Any, Dict, List

from engine import (
    STOP_WORDS,
    SYSTEM_NAMES_RU,
    VehicleExpertEngine,
    tokenize_multilingual,
    tokenize_ru,
)


class _ForbiddenDocTokensView:
    """Объект-ловушка: выбрасывает AssertionError при любой попытке итерации по doc_tokens."""

    def __iter__(self):
        raise AssertionError("is_general_or_greeting_query() не должен итерироваться по self.doc_tokens!")


class RAGScalingAndTieredRetrievalTests(unittest.TestCase):
    def _make_base_kb(self) -> List[Dict[str, Any]]:
        return [
            {
                "code": "P0300",
                "system": "engine",
                "severity": "critical",
                "health_index": 58,
                "symptoms": "Двигатель троит и трясется на холостом ходу, плавают обороты, потеря мощности",
                "cause": "Множественные пропуски зажигания: износ свечей, пробой катушек, подсос воздуха",
                "fix": "Проверить свечи и катушки зажигания, опрессовать впуск дымогенератором",
            },
            {
                "code": "P0796",
                "system": "transmission",
                "severity": "critical",
                "health_index": 54,
                "symptoms": "Пинки и рывки при переключении передач АКПП, пробуксовка фрикционов",
                "cause": "Заклинивание соленоида управления давлением C в гидроблоке АКПП",
                "fix": "Проверить давление ATF, промыть гидроблок и заменить соленоид PC C",
            },
            {
                "code": "C0050",
                "system": "brakes",
                "severity": "critical",
                "health_index": 60,
                "symptoms": "Горит лампа ABS и ESP, мягкая педаль тормоза, сбой датчика скорости колеса",
                "cause": "Обрыв цепи правого заднего датчика скорости вращения колеса ABS",
                "fix": "Прозвонить проводку датчика ABS и очистить магнитное кольцо ступицы",
            },
            {
                "code": "U0100",
                "system": "electrical",
                "severity": "critical",
                "health_index": 50,
                "symptoms": "Потеря связи с ЭБУ двигателя ECM/PCM по шине CAN, стартер не крутит",
                "cause": "Обрыв витой пары CAN-High / CAN-Low или просадка питания терминатора 60 Ом",
                "fix": "Измерить сопротивление шины CAN (60 Ом) и питание главного реле ЭБУ",
            },
        ]

    def test_01_bilingual_tokenization_and_stopword_preservation(self):
        """Проверка двуязычного токенизатора RU+EN и сохранности диагностических терминов."""
        self.assertIs(tokenize_ru, tokenize_multilingual)

        protected_terms = [
            "sensor", "circuit", "high", "low", "open", "short", "lean", "rich",
            "misfire", "pressure", "voltage", "bank", "cylinder", "clutch", "brake",
            "abs", "can", "sym",
        ]
        for term in protected_terms:
            self.assertNotIn(term, STOP_WORDS, f"Диагностический термин '{term}' не должен быть в STOP_WORDS")
            self.assertIn(term, tokenize_multilingual(term))

        ru_toks = tokenize_multilingual("Привет, двигатель в машине сильно троит и плавают обороты P0300!")
        self.assertNotIn("привет", ru_toks)
        self.assertNotIn("машина", ru_toks)
        self.assertIn("двигатель", ru_toks)
        self.assertIn("двига", ru_toks)
        self.assertIn("троит", ru_toks)
        self.assertIn("p0300", ru_toks)

        en_toks = tokenize_multilingual(
            "The vehicle oxygen sensors misfiring detected in bank 1 circuit low voltage 12v gdi sym C0050 batteries"
        )
        self.assertNotIn("the", en_toks)
        self.assertNotIn("vehicle", en_toks)
        self.assertIn("sensors", en_toks)
        self.assertIn("sensor", en_toks)
        self.assertIn("misfiring", en_toks)
        self.assertIn("misfir", en_toks)
        self.assertIn("detected", en_toks)
        self.assertIn("detect", en_toks)
        self.assertIn("batteries", en_toks)
        self.assertIn("battery", en_toks)
        self.assertIn("12v", en_toks)
        self.assertIn("gdi", en_toks)
        self.assertIn("sym", en_toks)
        self.assertIn("c0050", en_toks)

    def test_02_greeting_uses_precomputed_vocab_without_iterating_doc_tokens(self):
        """Проверка O(|q_tokens|) фильтра приветствий через _all_kb_vocab без обхода doc_tokens."""
        with tempfile.TemporaryDirectory() as tmpdir:
            missing_sample = Path(tmpdir) / "no_sample.txt"
            engine = VehicleExpertEngine(
                kb_data=self._make_base_kb(),
                sample_path=missing_sample,
                use_neural_models=False,
                include_external_kb=False,
            )
            self.assertGreater(len(engine._all_kb_vocab), 15)

            # Подменяем doc_tokens на объект-ловушку, запрещающий итерацию
            engine.doc_tokens = _ForbiddenDocTokensView()  # type: ignore[assignment]

            self.assertTrue(engine.is_general_or_greeting_query("привет"))
            self.assertTrue(engine.is_general_or_greeting_query("добрый вечер!"))
            self.assertTrue(engine.is_general_or_greeting_query("какая погода завтра"))
            self.assertFalse(engine.is_general_or_greeting_query("троит двигатель"))
            self.assertFalse(engine.is_general_or_greeting_query("P9999"))

    def test_03_tier1_protection_and_tier2_tier3_enrichment_from_jsonl_gz(self):
        """Проверка неизменности русских полей Tier 1 и обогащения из внешнего .jsonl.gz."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            missing_sample = tmp_path / "no_sample.txt"
            ext_gz = tmp_path / "kb_external.jsonl.gz"

            external_records = [
                # Попытка перезаписать существующий Tier 1 код P0300 (должна только обогатить!)
                {
                    "code": "P0300",
                    "tier": 2,
                    "lang": "en",
                    "system": "brakes",
                    "en_title": "Random/Multiple Cylinder Misfire Detected",
                    "symptoms": "ENGLISH OVERWRITE ATTEMPT",
                    "cause": "ENGLISH CAUSE OVERWRITE",
                    "fix": "ENGLISH FIX OVERWRITE",
                    "severity": "info",
                    "health_index": 99,
                    "procedures": [
                        "Monitor misfire counters per cylinder in Mode $06",
                        "Inspect spark plugs and ignition coil boots",
                    ],
                    "parts": ["Spark Plug Set", "Ignition Coil Pack"],
                    "difficulty": "medium",
                    "est_labor_hours": 1.5,
                    "nhtsa_bulletins": 14,
                    "nhtsa_owner_reports": 62,
                    "source": "nhtsa_obd2",
                    "license": "Public Domain",
                },
                # OEM-вариант Tier 3 для того же кода P0300
                {
                    "code": "P0300",
                    "tier": 3,
                    "lang": "en",
                    "oem_make": "Toyota",
                    "system": "powertrain",
                    "en_title": "Toyota Random/Multiple Cylinder Misfire Detected (IGT/IGF)",
                    "source": "oem_toyota_dtc",
                },
                # Новый внешний код P2195 с алиасом подсистемы emissions -> engine
                {
                    "code": "P2195",
                    "tier": 2,
                    "lang": "en",
                    "system": "emissions",
                    "en_title": "O2 Sensor Signal Biased/Stuck Lean Bank 1 Sensor 1",
                    "symptoms": "Rough idle, hesitation on acceleration, lean air-fuel ratio",
                    "cause": "Intake manifold vacuum leak or contaminated upstream A/F sensor",
                    "procedures": ["Smoke test intake manifold", "Check upstream O2 sensor heater circuit"],
                    "parts": ["Upstream Air/Fuel Ratio Sensor"],
                    "difficulty": "easy",
                    "est_labor_hours": 0.8,
                    "nhtsa_bulletins": 5,
                    "nhtsa_owner_reports": 19,
                    "source": "open_obd_catalog",
                },
                # Общая сервисная процедура без кода DTC (не должна засорять dtc_catalog, но доступна в RAG)
                {
                    "code": "",
                    "tier": 2,
                    "lang": "en",
                    "system": "gearbox",
                    "text": "ZF 8HP automatic transmission mechatronic clutch adaptation reset procedure after valve body repair",
                    "source": "open_service_guide",
                },
            ]

            with gzip.open(ext_gz, "wt", encoding="utf-8") as gz:
                for rec in external_records:
                    gz.write(json.dumps(rec, ensure_ascii=False) + "\n")

            engine = VehicleExpertEngine(
                kb_data=self._make_base_kb(),
                sample_path=missing_sample,
                use_neural_models=False,
                external_kb_path=ext_gz,
                include_external_kb=True,
            )

            # 1. Защита русских полей Tier 1 по коду P0300
            p0300 = engine.get_dtc_details("P0300")
            self.assertIsNotNone(p0300)
            self.assertEqual(p0300["tier"], 1)
            self.assertEqual(p0300["lang"], "ru")
            self.assertEqual(p0300["system"], "engine")
            self.assertEqual(p0300["system_ru"], "Двигатель")
            self.assertEqual(p0300["severity"], "critical")
            self.assertEqual(p0300["health_index"], 58)
            self.assertIn("Двигатель троит", p0300["symptom"])
            self.assertNotIn("OVERWRITE", p0300["symptom"])
            self.assertNotIn("OVERWRITE", p0300["cause"])
            self.assertNotIn("OVERWRITE", p0300["fix"])
            self.assertNotIn("OVERWRITE", p0300["solution"])

            # Проверка корректного обогащения P0300 из Tier 2/3
            self.assertEqual(p0300["en_title"], "Random/Multiple Cylinder Misfire Detected")
            self.assertEqual(len(p0300["oem_variants"]), 1)
            self.assertEqual(p0300["oem_variants"][0]["make"], "Toyota")
            self.assertEqual(p0300["nhtsa_stats"], {"bulletins": 14, "owner_reports": 62})
            self.assertEqual(len(p0300["procedures"]), 2)
            self.assertIn("Spark Plug Set", p0300["parts"])
            self.assertEqual(p0300["difficulty"], "medium")
            self.assertEqual(p0300["est_labor_hours"], 1.5)
            self.assertEqual(p0300["kb_cases_count"], 3)
            self.assertEqual(p0300["external_sources"], ["nhtsa_obd2", "oem_toyota_dtc"])

            # 2. Проверка нового внешнего кода P2195 и нормализации подсистемы в SYSTEM_NAMES_RU
            p2195 = engine.get_dtc_details("P2195")
            self.assertIsNotNone(p2195)
            self.assertIn(p2195["system"], SYSTEM_NAMES_RU)
            self.assertEqual(p2195["system"], "engine")
            self.assertEqual(p2195["tier"], 2)
            self.assertEqual(p2195["lang"], "en")
            for required_key in (
                "code", "system", "system_ru", "system_description", "symptom", "symptoms",
                "symptoms_str", "cause", "fix", "solution", "solutions", "severity",
                "health_index", "kb_cases_count", "has_telemetry", "telemetry", "tier",
                "lang", "en_title", "oem_variants", "nhtsa_stats", "procedures",
                "parts", "difficulty", "est_labor_hours", "external_sources",
            ):
                self.assertIn(required_key, p2195)

            # 3. Запись без кода не попадает в dtc_catalog, но находится через diagnose()
            self.assertNotIn("", engine.dtc_catalog)
            proc_hits = engine.diagnose("ZF 8HP mechatronic clutch adaptation reset procedure", top_n=3)
            self.assertGreater(len(proc_hits), 0)
            self.assertEqual(proc_hits[0]["meta"]["system"], "transmission")

            # 4. На русском запросе курируемая запись Tier 1 остаётся на 1-м месте
            ru_hits = engine.diagnose("двигатель троит и трясется на холостом ходу P0300", top_n=3)
            self.assertGreater(len(ru_hits), 0)
            self.assertEqual(ru_hits[0]["meta"]["source"], "kb_data.json")
            self.assertEqual(ru_hits[0]["meta"]["tier"], 1)

    def test_04_paginated_dtc_dictionary_ranking_and_backwards_compat(self):
        """Проверка ранжирования, пагинации, граничных параметров и обратной совместимости словаря DTC."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            missing_sample = tmp_path / "no_sample.txt"
            ext_gz = tmp_path / "kb_external.jsonl.gz"

            ext_items = [
                {"code": "P0301", "tier": 2, "system": "engine", "en_title": "Cylinder 1 Misfire Detected"},
                {"code": "P0302", "tier": 2, "system": "engine", "en_title": "Cylinder 2 Misfire Detected"},
                {"code": "P1300", "tier": 3, "system": "engine", "en_title": "Boost Calibration Fault P030X"},
                {"code": "B2100", "tier": 3, "system": "body", "en_title": "Door Driver Key Cylinder Switch P0300 Ref"},
            ]
            with gzip.open(ext_gz, "wt", encoding="utf-8") as gz:
                for rec in ext_items:
                    gz.write(json.dumps(rec) + "\n")

            engine = VehicleExpertEngine(
                kb_data=self._make_base_kb(),
                sample_path=missing_sample,
                use_neural_models=False,
                external_kb_path=ext_gz,
                include_external_kb=True,
            )

            # Обратная совместимость search_dtc_dictionary -> list
            legacy_list = engine.search_dtc_dictionary(query="P030", limit=10)
            self.assertIsInstance(legacy_list, list)
            paginated_list, total = engine.search_dtc_dictionary_paginated(query="P030", limit=10, offset=0)
            self.assertEqual(legacy_list, paginated_list)
            self.assertEqual(total, len(paginated_list))

            # Проверка порядка ранжирования при запросе "P0300":
            # exact code match (0) -> code substring / blob match (3)
            exact_page, exact_total = engine.search_dtc_dictionary_paginated(query="P0300", limit=10, offset=0)
            self.assertGreaterEqual(exact_total, 2)
            self.assertEqual(exact_page[0]["code"], "P0300")
            self.assertEqual(exact_page[-1]["code"], "B2100")

            # Проверка порядка при запросе "P030": prefix (P0300 Tier 1, P0301/P0302 Tier 2) раньше substring/blob
            prefix_page, _ = engine.search_dtc_dictionary_paginated(query="P030", limit=10, offset=0)
            codes_order = [item["code"] for item in prefix_page]
            self.assertEqual(codes_order[:3], ["P0300", "P0301", "P0302"])

            # Проверка пагинации без пропусков и пересечений
            all_items, all_total = engine.search_dtc_dictionary_paginated(query="", system="all", limit=100, offset=0)
            self.assertEqual(all_total, 8)
            # При пустом запросе первыми идут все записи Tier 1
            self.assertTrue(all(x["tier"] == 1 for x in all_items[:4]))
            self.assertTrue(all(x["tier"] >= 2 for x in all_items[4:]))

            p1, t1 = engine.search_dtc_dictionary_paginated(query="", system="all", limit=3, offset=0)
            p2, t2 = engine.search_dtc_dictionary_paginated(query="", system="all", limit=3, offset=3)
            p3, t3 = engine.search_dtc_dictionary_paginated(query="", system="all", limit=3, offset=6)
            self.assertEqual((t1, t2, t3), (all_total, all_total, all_total))
            self.assertEqual([x["code"] for x in (p1 + p2 + p3)], [x["code"] for x in all_items])

            # Защита от отрицательных и некорректных limit / offset
            clamped_items, clamped_total = engine.search_dtc_dictionary_paginated(
                query="",
                system="all",
                limit=-25,
                offset=-10,
            )
            self.assertEqual(clamped_total, all_total)
            self.assertEqual(len(clamped_items), 1)
            self.assertEqual(clamped_items[0]["code"], all_items[0]["code"])

            bad_type_items, _ = engine.search_dtc_dictionary_paginated(
                query="",
                system="all",
                limit="invalid",  # type: ignore[arg-type]
                offset="negative",  # type: ignore[arg-type]
            )
            self.assertEqual(len(bad_type_items), all_total)

            # Проверка безопасной работы на полностью пустом корпусе
            empty_engine = VehicleExpertEngine(
                kb_data=[],
                sample_path=missing_sample,
                use_neural_models=False,
                include_external_kb=False,
            )
            self.assertIsNone(empty_engine.bm25)
            self.assertEqual(empty_engine.diagnose("троит двигатель P0300"), [])
            self.assertEqual(empty_engine.search_dtc_dictionary_paginated("P0300"), ([], 0))

    def test_05_embedding_cache_hash_differs_with_external_kb(self):
        """Проверка различия хэша кэша эмбеддингов при включении и отключении внешней БЗ."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            missing_sample = tmp_path / "no_sample.txt"
            ext_gz = tmp_path / "kb_external.jsonl.gz"

            with gzip.open(ext_gz, "wt", encoding="utf-8") as gz:
                gz.write(
                    json.dumps(
                        {
                            "code": "P2096",
                            "tier": 2,
                            "system": "engine",
                            "en_title": "Post Catalyst Fuel Trim System Too Lean Bank 1",
                        }
                    )
                    + "\n"
                )

            eng_no_ext = VehicleExpertEngine(
                kb_data=self._make_base_kb(),
                sample_path=missing_sample,
                use_neural_models=False,
                external_kb_path=ext_gz,
                include_external_kb=False,
            )
            eng_with_ext = VehicleExpertEngine(
                kb_data=self._make_base_kb(),
                sample_path=missing_sample,
                use_neural_models=False,
                external_kb_path=ext_gz,
                include_external_kb=True,
            )

            digest_without = eng_no_ext._compute_embeddings_digest(eng_no_ext.embed_model_name)
            digest_with = eng_with_ext._compute_embeddings_digest(eng_with_ext.embed_model_name)
            self.assertNotEqual(digest_without, digest_with)

    def test_06_synthetic_13000_corpus_warm_latency_under_100ms(self):
        """Нагрузочный тест на корпусе 13 000 записей: тёплый вызов diagnose() строго быстрее 100 мс."""
        systems = list(SYSTEM_NAMES_RU.keys())
        prefixes = ["P", "C", "B", "U"]
        components = [
            "oxygen sensor", "camshaft actuator", "wheel speed sensor", "solenoid valve",
            "can bus module", "coolant pump", "inverter contactor", "battery cell", "air strut",
        ]
        failure_modes = [
            "circuit low voltage", "circuit high input", "range performance", "stuck open",
            "intermittent signal", "plausibility fault", "short to ground", "lean threshold",
        ]

        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            missing_sample = tmp_path / "no_sample.txt"
            ext_gz = tmp_path / "kb_external_13k.jsonl.gz"

            with gzip.open(ext_gz, "wt", encoding="utf-8") as gz:
                for i in range(12996):
                    pfx = prefixes[i % 4]
                    code = f"{pfx}{(i % 3999) + 1000:04X}" if i < 12200 else ""
                    sys_key = systems[i % len(systems)]
                    comp = components[i % len(components)]
                    mode = failure_modes[(i // 3) % len(failure_modes)]
                    oem = "Ford" if (i % 7 == 0 and i >= 8000) else ""
                    rec: Dict[str, Any] = {
                        "code": code,
                        "tier": 2 if i < 8000 else 3,
                        "lang": "en",
                        "oem_make": oem,
                        "system": sys_key,
                        "en_title": f"{comp.title()} {mode} #{i}",
                        "symptoms": f"rough operation {comp} {mode} symptomvar{i % 250}",
                        "cause": f"wiring harness resistance or {comp} degradation",
                        "fix": f"inspect connector pins and test {comp} waveform",
                        "source": "synthetic_bench",
                    }
                    gz.write(json.dumps(rec) + "\n")

            engine = VehicleExpertEngine(
                kb_data=self._make_base_kb(),
                sample_path=missing_sample,
                use_neural_models=False,
                external_kb_path=ext_gz,
                include_external_kb=True,
            )
            self.assertEqual(len(engine.raw_data), 13000)
            self.assertGreater(len(engine.dtc_catalog), 3500)

            # Прогрев
            engine.diagnose("двигатель троит на холостом ходу", top_n=3)

            queries = [
                "двигатель троит и трясется на холостом ходу",
                "пинки при переключении передач АКПП P0796",
                "oxygen sensor circuit low voltage lean",
                "wheel speed sensor intermittent signal C0050",
                "привет как дела",
            ]

            latencies_ms: List[float] = []
            for q in queries:
                t0 = time.perf_counter()
                hits = engine.diagnose(q, top_n=3)
                dt_ms = (time.perf_counter() - t0) * 1000.0
                latencies_ms.append(dt_ms)
                if q != "привет как дела":
                    self.assertGreater(len(hits), 0, f"Ожидались результаты для запроса: {q}")
                else:
                    self.assertEqual(hits, [])

            avg_ms = sum(latencies_ms) / len(latencies_ms)
            max_ms = max(latencies_ms)
            self.assertLess(
                avg_ms,
                100.0,
                f"Средняя задержка diagnose() на 13k корпусе составила {avg_ms:.2f} мс (>= 100 мс)",
            )
            self.assertLess(
                max_ms,
                100.0,
                f"Максимальная задержка diagnose() на 13k корпусе составила {max_ms:.2f} мс (>= 100 мс)",
            )

            # Проверяем также скорость пагинированного поиска по словарю 3500+ кодов
            t_dict = time.perf_counter()
            page, total = engine.search_dtc_dictionary_paginated(query="oxygen sensor", limit=50, offset=0)
            dict_ms = (time.perf_counter() - t_dict) * 1000.0
            self.assertGreater(total, 50)
            self.assertEqual(len(page), 50)
            self.assertLess(dict_ms, 50.0)


if __name__ == "__main__":
    unittest.main()
