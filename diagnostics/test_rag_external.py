"""Tests for external RAG ingestion pipeline, output corpus, manifest, and licenses.

Copyright (C) 2026 ExpertSystem_auto_diag contributors
License: GNU General Public License v3.0 (GPL-3.0)
"""

import gzip
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from scripts import ingest_external_rag as ingest  # noqa: E402

VALID_DTC_RE = re.compile(r"^[PCBU][0-9A-F]{4}$")
EXPECTED_SYSTEM_RU = {
    "engine": "Двигатель",
    "transmission": "Трансмиссия",
    "brakes": "Тормозная система",
    "electrical": "Электрика",
    "cooling": "Система охлаждения",
    "hybrid": "Гибридная установка",
    "battery": "Аккумулятор и зарядка",
    "chassis": "Рулевое и кузов",
    "suspension": "Подвеска и ходовая",
}
REQUIRED_SOURCES = (
    "commonmanual",
    "MechanicDB-public",
    "karsonmadden/us-vehicle-trouble-codes",
    "RRK1987/automotive-diagnostics-v2",
    "GITheMan/vehicle-repair-manuals",
)


class ExternalRagArtifactsTest(unittest.TestCase):
    """Validate generated kb_external.jsonl.gz, rag_manifest.json, licenses, and cleanup."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.corpus_path = BASE_DIR / "data" / "kb_external.jsonl.gz"
        cls.manifest_path = BASE_DIR / "data" / "rag_manifest.json"
        cls.licenses_path = BASE_DIR / "THIRD_PARTY_DATA_LICENSES.md"

        with gzip.open(cls.corpus_path, "rt", encoding="utf-8") as gz:
            cls.records = [json.loads(line) for line in gz if line.strip()]

        cls.manifest = json.loads(cls.manifest_path.read_text(encoding="utf-8"))
        cls.licenses_text = cls.licenses_path.read_text(encoding="utf-8")

    def test_corpus_size_and_unique_dtc_coverage(self) -> None:
        self.assertTrue(self.corpus_path.exists())
        self.assertGreaterEqual(len(self.records), 10000)
        unique_dtcs = {r["code"] for r in self.records if r["code"]}
        self.assertGreaterEqual(len(unique_dtcs), 10000)

    def test_schema_valid_on_100_percent_of_records(self) -> None:
        seen_ids = set()
        for rec in self.records:
            rec_id = rec["id"]
            self.assertIsInstance(rec_id, str)
            self.assertTrue(rec_id.strip())
            self.assertNotIn(rec_id, seen_ids)
            seen_ids.add(rec_id)

            code = rec["code"]
            self.assertIsInstance(code, str)
            if code != "":
                self.assertRegex(code, VALID_DTC_RE)

            self.assertIsInstance(rec["oem_make"], str)
            self.assertIn(rec["system"], EXPECTED_SYSTEM_RU)
            self.assertEqual(rec["system_ru"], EXPECTED_SYSTEM_RU[rec["system"]])

            self.assertIn(rec["tier"], (2, 3))
            self.assertIsInstance(rec["source"], str)
            self.assertTrue(rec["source"].strip())
            self.assertIsInstance(rec["license"], str)
            self.assertTrue(rec["license"].strip())
            self.assertIsInstance(rec["text"], str)
            self.assertTrue(rec["text"].strip())
            self.assertEqual(rec["lang"], "en")

            for list_field in ("procedures", "parts", "oem_variants"):
                self.assertIsInstance(rec[list_field], list)
                for item in rec[list_field]:
                    self.assertIsInstance(item, str)

            self.assertIsInstance(rec["nhtsa_bulletins"], int)
            self.assertGreaterEqual(rec["nhtsa_bulletins"], 0)
            self.assertIsInstance(rec["nhtsa_owner_reports"], int)
            self.assertGreaterEqual(rec["nhtsa_owner_reports"], 0)

            self.assertIn(rec["severity"], ("critical", "warning", "info"))
            self.assertIsInstance(rec["health_index"], int)
            self.assertGreaterEqual(rec["health_index"], 0)
            self.assertLessEqual(rec["health_index"], 100)
            if rec["est_labor_hours"] is not None:
                self.assertIsInstance(rec["est_labor_hours"], (int, float))
                self.assertGreaterEqual(rec["est_labor_hours"], 0)

    def test_mechanicdb_ranked_procedures_parts_and_j1939(self) -> None:
        mdb_obd = [
            r for r in self.records if r["source"] == "MechanicDB-public" and r["code"] != ""
        ]
        mdb_j1939 = [
            r for r in self.records if r["source"] == "MechanicDB-public" and r["code"] == ""
        ]
        self.assertGreaterEqual(len(mdb_obd), 80)
        self.assertGreaterEqual(len(mdb_j1939), 90)
        self.assertTrue(all(r["tier"] == 2 and r["license"] == "ODbL-1.0" for r in mdb_obd))
        self.assertTrue(any(r["procedures"] and r["parts"] and r["difficulty"] for r in mdb_obd))
        self.assertTrue(any(r["est_labor_hours"] is not None for r in mdb_obd))
        self.assertTrue(
            all("J1939 SPN" in r["symptoms"] and "FMI" in r["symptoms"] for r in mdb_j1939)
        )
        abs_j1939 = [r for r in mdb_j1939 if "ABS/ESC" in r["symptoms"]]
        self.assertTrue(abs_j1939)
        self.assertTrue(all(r["system"] == "brakes" for r in abs_j1939))

    def test_commonmanual_kb_and_oem_synthesis(self) -> None:
        cm_kb = [r for r in self.records if r["id"].startswith("EXT-CM-KB-")]
        self.assertGreaterEqual(len(cm_kb), 30)
        self.assertTrue(any(r["code"] == "" and r["tier"] == 2 for r in cm_kb))
        self.assertTrue(all(r["license"] == "CC-BY-SA-4.0" for r in cm_kb))

        p1000 = next(r for r in self.records if r["id"] == "EXT-CM-P1000")
        self.assertNotEqual(p1000["symptoms"], "Manufacturer Controlled DTC")
        self.assertTrue(p1000["oem_variants"])

    def test_karsonmadden_nhtsa_enrichments_and_standalone(self) -> None:
        enriched = [
            r
            for r in self.records
            if r["nhtsa_bulletins"] > 0 or r["nhtsa_owner_reports"] > 0
        ]
        self.assertGreaterEqual(len(enriched), 500)
        p0300 = next(r for r in self.records if r["id"] == "EXT-CM-P0300")
        self.assertGreater(p0300["nhtsa_bulletins"], 0)
        self.assertGreater(p0300["nhtsa_owner_reports"], 0)

        km_only = [
            r for r in self.records if r["source"] == "karsonmadden/us-vehicle-trouble-codes"
        ]
        self.assertGreaterEqual(len(km_only), 1)
        self.assertTrue(all(r["license"] == "CC-BY-4.0" and r["tier"] == 3 for r in km_only))

    def test_manifest_licenses_and_temp_cleanup(self) -> None:
        for src in REQUIRED_SOURCES:
            self.assertIn(src, self.manifest["sources"])
            self.assertIn(src, self.licenses_text)

        self.assertEqual(
            self.manifest["sources"]["GITheMan/vehicle-repair-manuals"]["status"],
            "skipped_empty_upstream_repository",
        )
        self.assertIn("GPL-3.0", self.licenses_text)
        self.assertIn("CC-BY-SA-4.0", self.licenses_text)
        self.assertIn("ODbL", self.licenses_text)
        self.assertIn("CC-BY-4.0", self.licenses_text)
        self.assertFalse(ingest.DEFAULT_TEMP_DIR.exists())


class IngestUnitTests(unittest.TestCase):
    """Offline unit tests for normalization, system inference, and RRK1987 quality audit."""

    def test_infer_system_mapping(self) -> None:
        self.assertEqual(ingest.infer_system("P0300", "Random misfire"), "engine")
        self.assertEqual(ingest.infer_system("P0741", "Torque converter clutch"), "transmission")
        self.assertEqual(ingest.infer_system("P0217", "Engine coolant over temperature"), "cooling")
        self.assertEqual(ingest.infer_system("C0035", "Left front wheel speed sensor"), "brakes")
        self.assertEqual(ingest.infer_system("C1750", "Air suspension ride height sensor"), "suspension")
        self.assertEqual(ingest.infer_system("B0001", "Driver frontal airbag deployment"), "chassis")
        self.assertEqual(ingest.infer_system("U0100", "Lost communication with ECM"), "electrical")
        self.assertEqual(ingest.infer_system("P0A80", "Replace hybrid battery pack"), "hybrid")
        self.assertEqual(ingest.infer_system("P0562", "System voltage low"), "battery")

    def test_rrk1987_quality_audit_filter(self) -> None:
        canonical = {
            "P0300": {"symptoms": "Random/Multiple Cylinder Misfire Detected"},
            "P0420": {"symptoms": "Catalyst System Efficiency Below Threshold (Bank 1)"},
            "P0700": {"symptoms": "Transmission Control System Malfunction"},
        }
        # 1. Placeholder DTC rejected
        ok, reason, _ = ingest.validate_rrk1987_row(
            {"user": "DTC P0999", "assistant": "Fault Code: P0999\nAffected ECU: Engine Control Module"},
            canonical,
        )
        self.assertFalse(ok)
        self.assertEqual(reason, "placeholder_dtc")

        # 2. Contradictory ECU mapping rejected (P0171 -> ABS Control Module)
        ok, reason, _ = ingest.validate_rrk1987_row(
            {"user": "DTC P0171", "assistant": "Fault Code: P0171\nAffected ECU: ABS Control Module"},
            canonical,
        )
        self.assertFalse(ok)
        self.assertEqual(reason, "contradictory_ecu_dtc_mapping")

        # 3. Synthetic mid-word truncated ALL-CAPS noise rejected
        ok, reason, _ = ingest.validate_rrk1987_row(
            {
                "user": "DTC P0300",
                "assistant": (
                    "Fault Code: P0300\nAffected ECU: Engine Control Module\n"
                    "Technical Context:\nSED FOR ECU CONFIGURATION VARIANT CODING "
                    "AND CALIBRATION CONTROL OPTI\n\nSafety Action Required:\nMonitor."
                ),
            },
            canonical,
        )
        self.assertFalse(ok)
        self.assertEqual(reason, "synthetic_truncated_noise")

        # 4. Cross-topic mismatch rejected (P0700 transmission code with catalytic converter text)
        ok, reason, _ = ingest.validate_rrk1987_row(
            {
                "user": "DTC P0700",
                "assistant": (
                    "Fault Code: P0700\nAffected ECU: Transmission Control Module\n"
                    "Technical Context:\nFailed catalytic converter substrate from thermal damage."
                ),
            },
            canonical,
        )
        self.assertFalse(ok)
        self.assertEqual(reason, "canonical_definition_mismatch")

        # 5. Clean coherent row accepted
        ok, reason, rec = ingest.validate_rrk1987_row(
            {
                "user": "OBD-II scanner shows P0300 with rough idle.",
                "assistant": (
                    "Fault Code: P0300\nAffected ECU: Engine Control Module\n"
                    "Technical Context:\nInspect spark plugs, ignition coils, and fuel pressure."
                ),
            },
            canonical,
        )
        self.assertTrue(ok)
        self.assertIsNone(reason)
        self.assertIsNotNone(rec)
        self.assertEqual(rec["code"], "P0300")
        self.assertEqual(rec["system"], "engine")

    def test_parse_commonmanual_consolidation_and_oem_synthesis(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            cm_dir = Path(td)
            (cm_dir / "data" / "dtc").mkdir(parents=True)
            (cm_dir / "data" / "kb" / "known-issues").mkdir(parents=True)
            (cm_dir / "data" / "kb" / "procedures").mkdir(parents=True)

            codes_payload = {
                "codes": {
                    "P0420": {
                        "generic": [["Catalyst System Efficiency Below Threshold", [1, 2]]],
                        "FORD": [["Catalyst System Efficiency Below Threshold (Bank 1)", [1]]],
                    },
                    "P1000": {
                        "Make not stated": [["Manufacturer Controlled DTC", [1]]],
                        "FORD": [["OBD System Readiness Test Not Complete", [1]]],
                        "LINCOLN": [["OBD System Readiness Test Not Complete", [1]]],
                    },
                }
            }
            gp_payload = {
                "codes": {"P0420": {"causes": ["Worn catalyst"], "checks": ["Check O2 sensors"]}},
                "families": [],
            }
            (cm_dir / "data" / "dtc" / "codes.json").write_text(
                json.dumps(codes_payload), encoding="utf-8"
            )
            (cm_dir / "data" / "dtc" / "generic-powertrain.json").write_text(
                json.dumps(gp_payload), encoding="utf-8"
            )

            dtcs, kb_recs, _ = ingest.parse_commonmanual(cm_dir)
            self.assertEqual(len(dtcs), 2)
            self.assertEqual(len(kb_recs), 0)
            self.assertEqual(dtcs["P0420"]["cause"], "Worn catalyst")
            self.assertEqual(dtcs["P1000"]["symptoms"], "OBD System Readiness Test Not Complete")
            self.assertTrue(any("FORD/LINCOLN" in v for v in dtcs["P1000"]["oem_variants"]))


if __name__ == "__main__":
    unittest.main()
