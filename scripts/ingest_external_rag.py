#!/usr/bin/env python3
"""External automotive RAG dataset ingestion, normalization, quality audit, and merge pipeline.

Copyright (C) 2026 ExpertSystem_auto_diag contributors
License: GNU General Public License v3.0 (GPL-3.0)

Fetches, validates, normalizes, deduplicates, and merges five external diagnostic sources:
1. xsvdevelopment/commonmanual (CC-BY-SA-4.0 data / MIT code)
2. MechanicDB/MechanicDB-public (ODbL-1.0 data / MIT upstream J2012 / CC-BY-4.0 docs)
3. karsonmadden/us-vehicle-trouble-codes (CC-BY-4.0)
4. RRK1987/automotive-diagnostics-v2 (MIT) — strict quality & domain-integrity audit
5. GITheMan/vehicle-repair-manuals (MIT) — tree verification (empty upstream repository)
"""

from __future__ import annotations

import argparse
import csv
import gzip
import io
import json
import os
import re
import shutil
import time
import zipfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

try:
    import truststore
except ImportError:  # pragma: no cover - optional only when running pure offline unit tests
    truststore = None  # type: ignore[assignment]

try:
    import requests
except ImportError:  # pragma: no cover
    requests = None  # type: ignore[assignment]


DEFAULT_TEMP_DIR = Path(
    r"C:\Users\maxxf\.gemini\antigravity\brain\40813e4c-5915-49ec-8c28-49f2a221758e\scratch\ingest_tmp"
)
BASE_DIR = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT_PATH = BASE_DIR / "data" / "kb_external.jsonl.gz"
DEFAULT_MANIFEST_PATH = BASE_DIR / "data" / "rag_manifest.json"

DTC_CODE_RE = re.compile(r"^[PCBU][0-9A-F]{4}$")
DTC_TEXT_RE = re.compile(r"\b([PCBU][0-9A-Fa-f]{4})\b")

SYSTEM_RU_MAP: Dict[str, str] = {
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
VALID_SYSTEMS = frozenset(SYSTEM_RU_MAP.keys())

PLACEHOLDER_DTCS = frozenset(
    {"P0000", "P0999", "U0000", "U0999", "B0000", "B0999", "C0000", "C0999"}
)

USER_AGENT = "ExpertSystem-AutoDiag-Ingest/1.0 (+https://www.gnu.org/licenses/gpl-3.0)"

MECHANICDB_FILES = [
    "dtc_codes.csv",
    "diagnostic_fixes.csv",
    "dtc_fixes_joined.csv",
    "replacement_parts.csv",
    "samples/heavyduty/j1939_faults.csv",
    "samples/heavyduty/j1939_fixes_joined.csv",
    "samples/heavyduty/j1939_fmi.csv",
    "samples/heavyduty/diagnostic_fixes.csv",
    "LICENSE",
    "LICENSE-upstream.txt",
    "SOURCES.md",
]


def inject_ssl_truststore() -> None:
    """Inject OS trust store into Python SSL for Windows HTTPS reliability."""
    if truststore is not None:
        truststore.inject_into_ssl()


def _clean_text(value: Any) -> str:
    if value is None:
        return ""
    text = str(value).replace("\r\n", " ").replace("\n", " ").replace("\t", " ")
    return re.sub(r"\s+", " ", text).strip()


def _parse_int(value: Any, default: int = 0) -> int:
    if value is None or value == "":
        return default
    try:
        return int(float(str(value).strip()))
    except (ValueError, TypeError):
        return default


def _parse_float(value: Any) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        val = float(str(value).strip())
        return round(val, 2)
    except (ValueError, TypeError):
        return None


def is_valid_dtc(code: str) -> bool:
    return bool(DTC_CODE_RE.match((code or "").strip().upper()))


def _has_keyword(blob: str, keywords: Sequence[str]) -> bool:
    for kw in keywords:
        if len(kw) <= 4 and kw.isalnum():
            if re.search(rf"\b{re.escape(kw)}\b", blob):
                return True
        elif kw in blob:
            return True
    return False


def infer_system(code: str = "", text: str = "", category: str = "") -> str:
    """Deterministically map a DTC code / description / category to one of the 9 valid systems."""
    c = (code or "").strip().upper()
    cat_l = (category or "").lower()
    blob = f"{category} {text}".lower()

    # 1. Explicit cooling cues or dedicated OBD-II cooling ranges
    cooling_kw = (
        "coolant",
        "thermostat",
        "radiator",
        "overheat",
        "overheating",
        "antifreeze",
        "cooling fan",
        "fan control",
        "fan relay",
        "water pump",
        "engine coolant temperature",
        "ect sensor",
        "intercooler coolant",
    )
    if (
        c == "P0217"
        or c.startswith(("P0115", "P0116", "P0117", "P0118", "P0119", "P0125", "P0126", "P0128"))
        or c.startswith(("P0480", "P0481", "P0482", "P0483", "P0484", "P0485", "P2181"))
        or _has_keyword(blob, cooling_kw)
    ):
        if "transmission fluid" not in blob and not _has_keyword(blob, ("atf",)):
            return "cooling"

    # 2. Hybrid & High-Voltage Battery / Charging (P0A-P0F, P1A)
    battery_kw = (
        "battery pack",
        "hybrid battery",
        "high voltage battery",
        "hv battery",
        "battery cell",
        "cell voltage",
        "battery module",
        "bms",
        "becm",
        "state of charge",
        "charging port",
        "charger",
        "on-board charger",
        "12v battery",
        "battery voltage",
        "system voltage",
        "alternator",
        "generator field",
        "charging system",
        "parasitic draw",
    )
    hybrid_kw = (
        "hybrid",
        "inverter",
        "dc/dc",
        "dc-dc",
        "traction motor",
        "drive motor",
        "motor generator",
        "high voltage interlock",
        "hvil",
        "isolation fault",
        "regenerative braking",
        "phev",
    )

    if c.startswith(("P0A", "P0B", "P0C", "P0D", "P0E", "P0F", "P1A")):
        if c == "P0A80" or _has_keyword(blob, ("inverter", "motor", "hybrid", "interlock")):
            if "battery" in blob and c != "P0A80" and "inverter" not in blob and "motor" not in blob:
                return "battery"
            return "hybrid"
        if _has_keyword(blob, battery_kw):
            return "battery"
        return "hybrid"

    if c.startswith(("P056", "P062")) or _has_keyword(
        blob,
        (
            "battery voltage",
            "system voltage",
            "charging system",
            "alternator",
            "generator field",
            "parasitic draw",
            "12v battery",
            "battery state of charge",
        ),
    ):
        return "battery"

    if _has_keyword(blob, hybrid_kw):
        return "hybrid"

    # 3. Brakes & ABS / ESC (check explicit brake/ABS category/codes before generic transmission words)
    brakes_kw = (
        "brake",
        "braking",
        "abs",
        "anti-lock",
        "antilock",
        "wheel speed sensor",
        "caliper",
        "master cylinder",
        "hydraulic control unit",
        "ebd",
        "esc",
        "esp",
        "traction control",
        "stability control",
        "bleed brakes",
    )
    if c.startswith(("C00", "C01", "C02")) or _has_keyword(cat_l, brakes_kw):
        return "brakes"

    # 4. Transmission & Drivetrain
    trans_kw = (
        "transmission",
        "transaxle",
        "gearbox",
        "torque converter",
        "shift solenoid",
        "pressure control solenoid",
        "clutch",
        "tcm",
        "10r80",
        "8l90",
        "8l45",
        "cvt",
        "dsg",
        "transfer case",
        "4wd",
        "4hi",
        "iwe",
        "differential",
        "axle",
        "output shaft speed",
        "input shaft speed",
        "turbine shaft",
        "gear ratio",
        "atf",
    )
    if c.startswith(("P07", "P08", "P09", "P17", "P18", "P27", "P28")) or _has_keyword(
        blob, trans_kw
    ):
        return "transmission"

    if _has_keyword(blob, brakes_kw):
        return "brakes"

    # 5. Suspension
    susp_kw = (
        "suspension",
        "strut",
        "shock absorber",
        "damper",
        "air spring",
        "air ride",
        "ride height",
        "leveling",
        "sway bar",
        "coil spring",
        "ball joint",
        "control arm",
        "wheel bearing",
        "hub bearing",
    )
    if c.startswith(("C17", "C18", "C19")) or _has_keyword(blob, susp_kw):
        if "steering oscillation" in blob or "steering damper" in blob:
            return "chassis"
        return "suspension"

    # 6. Chassis / Steering / Body mechanicals (Cxxxx remaining + Bxxxx body/restraint/HVAC/door)
    chassis_kw = (
        "steering",
        "eps",
        "power steering",
        "rack",
        "yaw",
        "steering angle",
        "airbag",
        "srs",
        "restraint",
        "seatbelt",
        "seat belt",
        "occupant",
        "pretensioner",
        "door",
        "window",
        "sunroof",
        "mirror",
        "wiper",
        "seat",
        "climate",
        "hvac",
        "blower",
        "a/c",
        "tpms",
        "tire pressure",
        "body",
        "chassis",
    )
    if c.startswith("C"):
        return "chassis"
    if c.startswith("B"):
        if _has_keyword(blob, chassis_kw):
            return "chassis"
        return "electrical"

    # 7. Network / Electrical
    if c.startswith("U"):
        return "electrical"
    if _has_keyword(
        blob,
        (
            "can bus",
            "lin bus",
            "lost communication",
            "network",
            "voltage drop",
            "wiring",
            "ground circuit",
            "bcm",
            "immobilizer",
            "pats",
            "instrument cluster",
            "lighting",
            "headlamp",
        ),
    ):
        return "electrical"

    # 8. Engine / Powertrain default
    if _has_keyword(blob, chassis_kw) and not c.startswith("P"):
        return "chassis"
    if "transmission" in blob:
        return "transmission"
    return "engine"


def infer_severity_and_health(
    code: str, text: str, tier: int, is_procedural: bool = False
) -> Tuple[str, int]:
    """Compute severity ('critical'|'warning'|'info') and health_index (0..100)."""
    blob = f"{code} {text}".lower()
    if is_procedural and not code:
        return "info", 88
    if any(
        kw in blob
        for kw in (
            "airbag",
            "srs",
            "deploy",
            "pretensioner",
            "brake",
            "abs",
            "overheat",
            "oil pressure",
            "internal control module",
            "processor",
            "high voltage interlock",
            "isolation",
            "bus off",
            "lost communication with ecm",
            "p0300",
            "p0217",
            "p0522",
            "p0606",
            "u0100",
            "fracture",
        )
    ):
        return "critical", 55
    if tier == 2:
        return "warning", 70
    return "warning", 72


def build_search_text(record: Dict[str, Any]) -> str:
    """Assemble deterministic full-text RAG representation."""
    parts: List[str] = []
    if record["code"]:
        header = f"DTC {record['code']}"
        if record["oem_make"]:
            header += f" ({record['oem_make']})"
    else:
        header = record["id"]
    parts.append(header)
    parts.append(f"System: {record['system']} ({record['system_ru']})")
    if record["symptoms"]:
        parts.append(f"Symptoms/Meaning: {record['symptoms']}")
    if record["cause"]:
        parts.append(f"Causes: {record['cause']}")
    if record["fix"]:
        parts.append(f"Fix: {record['fix']}")
    if record["procedures"]:
        parts.append("Procedures: " + " | ".join(record["procedures"]))
    if record["parts"]:
        parts.append("Parts: " + ", ".join(record["parts"]))
    if record["oem_variants"]:
        parts.append("OEM Variants: " + " ; ".join(record["oem_variants"]))
    if record["nhtsa_bulletins"] or record["nhtsa_owner_reports"]:
        parts.append(
            f"NHTSA: {record['nhtsa_bulletins']} bulletins, {record['nhtsa_owner_reports']} owner reports"
        )
    parts.append(f"Source: {record['source']} ({record['license']})")
    return " | ".join(parts)


def make_canonical_record(
    *,
    rec_id: str,
    code: str,
    oem_make: str,
    system: str,
    symptoms: str,
    cause: str,
    fix: str,
    procedures: Sequence[str] = (),
    parts: Sequence[str] = (),
    difficulty: str = "",
    est_labor_hours: Optional[float] = None,
    nhtsa_bulletins: int = 0,
    nhtsa_owner_reports: int = 0,
    oem_variants: Sequence[str] = (),
    lang: str = "en",
    tier: int = 3,
    source: str,
    license_name: str,
    severity: Optional[str] = None,
    health_index: Optional[int] = None,
    is_procedural: bool = False,
) -> Dict[str, Any]:
    if system not in VALID_SYSTEMS:
        raise ValueError(f"Invalid system '{system}'; expected one of {sorted(VALID_SYSTEMS)}")
    norm_code = code.strip().upper() if code else ""
    if norm_code and not is_valid_dtc(norm_code):
        raise ValueError(f"Invalid DTC code '{norm_code}'")

    sev, hi = infer_severity_and_health(
        norm_code, f"{symptoms} {cause} {fix}", tier, is_procedural=is_procedural
    )
    if severity is not None:
        sev = severity
    if health_index is not None:
        hi = health_index

    rec: Dict[str, Any] = {
        "id": rec_id.strip(),
        "code": norm_code,
        "oem_make": _clean_text(oem_make),
        "system": system,
        "system_ru": SYSTEM_RU_MAP[system],
        "symptoms": _clean_text(symptoms),
        "cause": _clean_text(cause),
        "fix": _clean_text(fix),
        "procedures": [_clean_text(p) for p in procedures if _clean_text(p)],
        "parts": [_clean_text(p) for p in parts if _clean_text(p)],
        "difficulty": _clean_text(difficulty),
        "est_labor_hours": est_labor_hours,
        "nhtsa_bulletins": int(nhtsa_bulletins),
        "nhtsa_owner_reports": int(nhtsa_owner_reports),
        "oem_variants": [_clean_text(v) for v in oem_variants if _clean_text(v)],
        "lang": lang,
        "tier": int(tier),
        "source": source,
        "license": license_name,
        "severity": sev,
        "health_index": int(hi),
        "text": "",
    }
    rec["text"] = build_search_text(rec)
    return rec


# ---------------------------------------------------------------------------
# Download helpers
# ---------------------------------------------------------------------------

def _new_session() -> Any:
    if requests is None:
        raise RuntimeError("requests package is required for downloading external datasets")
    inject_ssl_truststore()
    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT
    return session


def download_all_sources(temp_dir: Path) -> Dict[str, Any]:
    """Download all required external datasets into temp_dir."""
    temp_dir.mkdir(parents=True, exist_ok=True)
    session = _new_session()

    # 1. commonmanual zipball (~1.6 MB)
    cm_dir = temp_dir / "commonmanual"
    if not (cm_dir / "data" / "dtc" / "codes.json").exists():
        resp = session.get(
            "https://github.com/xsvdevelopment/commonmanual/archive/refs/heads/main.zip",
            timeout=60,
        )
        resp.raise_for_status()
        if cm_dir.exists():
            shutil.rmtree(cm_dir)
        with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
            zf.extractall(temp_dir)
        extracted = temp_dir / "commonmanual-main"
        if extracted.exists():
            extracted.rename(cm_dir)

    # 2. MechanicDB selective raw CSV/license files (never git clone 145MB HTML)
    mdb_dir = temp_dir / "mechanicdb"
    mdb_dir.mkdir(parents=True, exist_ok=True)
    for rel in MECHANICDB_FILES:
        dest = mdb_dir / rel
        if not dest.exists():
            dest.parent.mkdir(parents=True, exist_ok=True)
            resp = session.get(
                f"https://raw.githubusercontent.com/MechanicDB/MechanicDB-public/main/{rel}",
                timeout=60,
            )
            resp.raise_for_status()
            dest.write_bytes(resp.content)

    # 3. karsonmadden/us-vehicle-trouble-codes via huggingface_hub
    km_dir = temp_dir / "karsonmadden"
    km_dir.mkdir(parents=True, exist_ok=True)
    if not (km_dir / "dtc.csv").exists():
        from huggingface_hub import hf_hub_download

        for fn in ("dtc.csv", "dtc.json", "README.md"):
            hf_hub_download(
                repo_id="karsonmadden/us-vehicle-trouble-codes",
                filename=fn,
                repo_type="dataset",
                local_dir=str(km_dir),
            )

    # 4. RRK1987/automotive-diagnostics-v2 via HF Datasets Server API
    rrk_dir = temp_dir / "rrk1987"
    rrk_dir.mkdir(parents=True, exist_ok=True)
    if not (rrk_dir / "train.json").exists() or not (rrk_dir / "validation.json").exists():
        info_resp = session.get(
            "https://datasets-server.huggingface.co/info?dataset=RRK1987/automotive-diagnostics-v2",
            timeout=60,
        )
        info_resp.raise_for_status()
        info_json = info_resp.json()
        (rrk_dir / "info.json").write_bytes(info_resp.content)
        splits = info_json.get("dataset_info", {}).get("default", {}).get("splits", {})
        for split_name, split_meta in splits.items():
            total = int(split_meta.get("num_examples", 0))
            rows_acc: List[Any] = []
            offset = 0
            while offset < total:
                chunk = min(100, total - offset)
                r = session.get(
                    f"https://datasets-server.huggingface.co/rows?dataset=RRK1987/automotive-diagnostics-v2"
                    f"&config=default&split={split_name}&offset={offset}&length={chunk}",
                    timeout=60,
                )
                r.raise_for_status()
                rows_acc.extend(r.json().get("rows", []))
                offset += chunk
            (rrk_dir / f"{split_name}.json").write_text(
                json.dumps({"rows": rows_acc}, ensure_ascii=False), encoding="utf-8"
            )

    # 5. GITheMan/vehicle-repair-manuals GitHub tree audit
    githeman_dir = temp_dir / "githeman"
    githeman_dir.mkdir(parents=True, exist_ok=True)
    tree_path = githeman_dir / "tree.json"
    if not tree_path.exists():
        r = session.get(
            "https://api.github.com/repos/GITheMan/vehicle-repair-manuals/git/trees/main?recursive=1",
            timeout=30,
        )
        r.raise_for_status()
        tree_path.write_bytes(r.content)

    return {"status": "downloaded", "temp_dir": str(temp_dir)}


# ---------------------------------------------------------------------------
# 1. CommonManual parser
# ---------------------------------------------------------------------------

def _pick_consensus_description(entries: Sequence[Any]) -> str:
    """Choose the clearest consensus description from [desc, source_ids] pairs."""
    best_score = (-1, -1)
    best_desc = ""
    for item in entries:
        if not isinstance(item, list) or not item:
            continue
        desc = _clean_text(item[0])
        if not desc:
            continue
        src_ids = item[1] if len(item) > 1 and isinstance(item[1], list) else []
        generic_penalty = 0 if desc.lower().startswith("manufacturer controlled") else 1
        score = (generic_penalty * 100 + len(src_ids) * 10, min(len(desc), 160))
        if score > best_score:
            best_score = score
            best_desc = desc
    return best_desc


def _extract_gp_lookup(gp_data: Dict[str, Any]) -> Dict[str, Dict[str, List[str]]]:
    lookup: Dict[str, Dict[str, List[str]]] = {}
    for code, entry in (gp_data.get("codes") or {}).items():
        c = code.strip().upper()
        lookup[c] = {
            "causes": [_clean_text(x) for x in entry.get("causes", []) if _clean_text(x)],
            "checks": [_clean_text(x) for x in entry.get("checks", []) if _clean_text(x)],
        }
    for fam in gp_data.get("families") or []:
        start = int(fam["from"])
        end = int(fam["to"])
        causes = [_clean_text(x) for x in fam.get("causes", []) if _clean_text(x)]
        checks = [_clean_text(x) for x in fam.get("checks", []) if _clean_text(x)]
        for num in range(start, end + 1):
            c = f"P{num:04d}"
            cur = lookup.setdefault(c, {"causes": [], "checks": []})
            for x in causes:
                if x not in cur["causes"]:
                    cur["causes"].append(x)
            for x in checks:
                if x not in cur["checks"]:
                    cur["checks"].append(x)
    return lookup


def _extract_dtcs_from_kb_doc(doc: Dict[str, Any]) -> List[str]:
    found: List[str] = []
    seen = set()
    blobs = [doc.get("title", ""), doc.get("summary", "")]
    blobs.extend(doc.get("tags") or [])
    for blob in blobs:
        for m in DTC_TEXT_RE.findall(str(blob)):
            c = m.upper()
            if is_valid_dtc(c) and c not in seen:
                seen.add(c)
                found.append(c)
    return found


def parse_commonmanual(cm_dir: Path) -> Tuple[Dict[str, Dict[str, Any]], List[Dict[str, Any]], Dict[str, Any]]:
    """Parse CommonManual codes.json, generic-powertrain.json, and kb/known-issues + kb/procedures."""
    codes_payload = json.loads((cm_dir / "data" / "dtc" / "codes.json").read_text(encoding="utf-8"))
    gp_payload = json.loads(
        (cm_dir / "data" / "dtc" / "generic-powertrain.json").read_text(encoding="utf-8")
    )
    gp_lookup = _extract_gp_lookup(gp_payload)
    raw_codes: Dict[str, Dict[str, Any]] = codes_payload.get("codes", {})

    dtc_records: Dict[str, Dict[str, Any]] = {}
    stats = {
        "codes_total_raw": len(raw_codes),
        "codes_with_generic": 0,
        "codes_oem_only_synthesized": 0,
        "codes_enriched_with_generic_powertrain": 0,
        "kb_known_issues_total": 0,
        "kb_procedures_total": 0,
        "kb_verified_or_cited": 0,
        "kb_draft": 0,
        "kb_linked_to_dtc": 0,
        "kb_standalone_emitted": 0,
    }

    for raw_code, sections in sorted(raw_codes.items()):
        code = raw_code.strip().upper()
        if not is_valid_dtc(code):
            continue

        generic_desc = _pick_consensus_description(sections.get("generic", []))
        oem_desc_to_makes: Dict[str, List[str]] = defaultdict(list)
        all_oem_texts: List[str] = []

        for make_name, entries in sorted(sections.items()):
            if make_name == "generic":
                continue
            desc = _pick_consensus_description(entries)
            if desc:
                oem_desc_to_makes[desc].append(make_name)
                all_oem_texts.append(f"{make_name}: {desc}")

        if generic_desc:
            stats["codes_with_generic"] += 1
            primary_desc = generic_desc
        else:
            stats["codes_oem_only_synthesized"] += 1
            mns_desc = (
                _pick_consensus_description(sections["Make not stated"])
                if "Make not stated" in sections
                else ""
            )
            if mns_desc and not mns_desc.lower().startswith("manufacturer controlled"):
                primary_desc = mns_desc
            elif oem_desc_to_makes:
                specific_candidates = [
                    (desc, makes)
                    for desc, makes in oem_desc_to_makes.items()
                    if not desc.lower().startswith("manufacturer controlled")
                ]
                pool = specific_candidates if specific_candidates else list(oem_desc_to_makes.items())
                primary_desc = max(
                    pool,
                    key=lambda kv: (len(kv[1]), min(len(kv[0]), 160)),
                )[0]
            else:
                primary_desc = f"Diagnostic trouble code {code}"

        oem_variants: List[str] = []
        for desc, makes in sorted(oem_desc_to_makes.items(), key=lambda kv: (-len(kv[1]), kv[0])):
            if desc.lower() == primary_desc.lower() and generic_desc:
                continue
            makes_clean = [m for m in makes if m != "Make not stated"]
            label = "/".join(makes_clean[:6]) if makes_clean else "OEM"
            if len(makes_clean) > 6:
                label += f" (+{len(makes_clean) - 6})"
            oem_variants.append(f"{label}: {desc}")
        if not generic_desc and not oem_variants and oem_desc_to_makes:
            # Ensure OEM-only synthesized codes still list their applicable makes clearly
            for desc, makes in oem_desc_to_makes.items():
                makes_clean = [m for m in makes if m != "Make not stated"]
                if makes_clean:
                    oem_variants.append(f"{'/'.join(makes_clean[:8])}: {desc}")
        oem_variants = oem_variants[:12]

        gp = gp_lookup.get(code)
        cause = ""
        fix = ""
        procedures: List[str] = []
        if gp:
            stats["codes_enriched_with_generic_powertrain"] += 1
            cause = "; ".join(gp["causes"])
            procedures = list(gp["checks"])
            if procedures:
                fix = "; ".join(procedures)

        system = infer_system(code, f"{primary_desc} {' '.join(oem_variants)} {cause}")
        rec = make_canonical_record(
            rec_id=f"EXT-CM-{code}",
            code=code,
            oem_make="",
            system=system,
            symptoms=primary_desc,
            cause=cause,
            fix=fix,
            procedures=procedures,
            oem_variants=oem_variants,
            tier=3,
            source="commonmanual",
            license_name="CC-BY-SA-4.0",
        )
        dtc_records[code] = rec

    # Parse kb/known-issues and kb/procedures
    kb_records: List[Dict[str, Any]] = []
    for subdir, kind_label in (("known-issues", "known-issue"), ("procedures", "procedure")):
        dir_path = cm_dir / "data" / "kb" / subdir
        if not dir_path.exists():
            continue
        for fp in sorted(dir_path.glob("*.json")):
            doc = json.loads(fp.read_text(encoding="utf-8"))
            if subdir == "known-issues":
                stats["kb_known_issues_total"] += 1
            else:
                stats["kb_procedures_total"] += 1

            status = _clean_text(doc.get("status") or "unknown")
            is_verified = status in {"factory-sourced", "cited"}
            if is_verified:
                stats["kb_verified_or_cited"] += 1
            else:
                stats["kb_draft"] += 1

            title = _clean_text(doc.get("title") or fp.stem)
            summary = _clean_text(doc.get("summary") or "")
            body = _clean_text(doc.get("body") or "")
            steps_raw = doc.get("steps") or []
            steps = [
                _clean_text(s.get("text") if isinstance(s, dict) else s)
                for s in steps_raw
            ]
            steps = [s for s in steps if s]
            parts_list = [_clean_text(p) for p in (doc.get("parts") or []) if _clean_text(p)]
            tools_list = [_clean_text(t) for t in (doc.get("tools") or []) if _clean_text(t)]
            warnings_list = [_clean_text(w) for w in (doc.get("warnings") or []) if _clean_text(w)]
            specs_list = [
                f"{_clean_text(sp.get('name'))}: {_clean_text(sp.get('value'))}"
                for sp in (doc.get("specs") or [])
                if isinstance(sp, dict) and (_clean_text(sp.get("name")) or _clean_text(sp.get("value")))
            ]
            applies_makes = sorted(
                {
                    _clean_text(a.get("make"))
                    for a in (doc.get("applies") or [])
                    if isinstance(a, dict) and _clean_text(a.get("make")) not in ("", "*")
                }
            )
            oem_make = "/".join(applies_makes)
            linked_dtcs = _extract_dtcs_from_kb_doc(doc)

            # Enrich matching DTC records when KB explicitly references DTC(s)
            for dtc in linked_dtcs:
                if dtc in dtc_records:
                    stats["kb_linked_to_dtc"] += 1
                    target = dtc_records[dtc]
                    note = f"[{kind_label} | status={status}] {title}: {summary or body[:220]}"
                    if note not in target["procedures"]:
                        target["procedures"].append(note)
                    if not target["fix"] and (summary or steps):
                        target["fix"] = summary or "; ".join(steps[:3])
                    target["text"] = build_search_text(target)

            # Emit standalone record: code="" for general/multi-DTC guides, or primary DTC if single
            # Keeping code="" for general/multi-DTC guides as specified
            standalone_code = linked_dtcs[0] if len(linked_dtcs) == 1 else ""
            if standalone_code == "":
                stats["kb_standalone_emitted"] += 1

            combined_symptoms = f"[{status}] {title}"
            if summary:
                combined_symptoms += f" — {summary}"
            cause_text = body[:400] if body else ("Warnings: " + "; ".join(warnings_list) if warnings_list else "")
            fix_text = "; ".join(steps[:4]) if steps else ("; ".join(specs_list[:3]) or summary)
            combined_parts = parts_list + [f"Tool: {t}" for t in tools_list]
            combined_procs = steps + specs_list
            if linked_dtcs:
                combined_procs.insert(0, f"Related DTCs: {', '.join(linked_dtcs)}")

            sys_id = infer_system(
                standalone_code,
                f"{title} {summary} {' '.join(doc.get('tags') or [])}",
            )
            kb_id_slug = re.sub(r"[^A-Za-z0-9_-]+", "-", doc.get("id") or fp.stem).strip("-")
            kb_rec = make_canonical_record(
                rec_id=f"EXT-CM-KB-{kb_id_slug}",
                code=standalone_code,
                oem_make=oem_make,
                system=sys_id,
                symptoms=combined_symptoms,
                cause=cause_text,
                fix=fix_text,
                procedures=combined_procs,
                parts=combined_parts,
                tier=2 if is_verified else 3,
                source="commonmanual",
                license_name="CC-BY-SA-4.0",
                is_procedural=(subdir == "procedures"),
            )
            kb_records.append(kb_rec)

    return dtc_records, kb_records, stats


# ---------------------------------------------------------------------------
# 2. MechanicDB parser
# ---------------------------------------------------------------------------

def _read_pipe_csv(path: Path) -> List[Dict[str, str]]:
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f, delimiter="|"))


def parse_mechanicdb(mdb_dir: Path) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """Parse MechanicDB OBD-II ranked fixes + parts and J1939 heavy-duty faults."""
    dtc_rows = _read_pipe_csv(mdb_dir / "dtc_codes.csv")
    fix_rows = _read_pipe_csv(mdb_dir / "dtc_fixes_joined.csv")
    part_rows = _read_pipe_csv(mdb_dir / "replacement_parts.csv")

    parts_by_fix: Dict[str, List[str]] = defaultdict(list)
    for pr in part_rows:
        fid = (pr.get("fix_id") or "").strip()
        pname = _clean_text(pr.get("part_name"))
        if fid and pname and pname not in parts_by_fix[fid]:
            parts_by_fix[fid].append(pname)

    fixes_by_code_id: Dict[str, List[Dict[str, str]]] = defaultdict(list)
    for fr in fix_rows:
        cid = (fr.get("code_id") or "").strip()
        if cid:
            fixes_by_code_id[cid].append(fr)

    records: List[Dict[str, Any]] = []
    obd_count = 0
    for row in dtc_rows:
        code = (row.get("dtc_code") or "").strip().upper()
        if not is_valid_dtc(code):
            continue
        code_id = (row.get("code_id") or "").strip()
        oem_make = _clean_text(row.get("oem_make"))
        short_desc = _clean_text(row.get("short_description"))
        detail = _clean_text(row.get("detailed_technical_explanation"))
        category = _clean_text(row.get("system_category"))

        ranked_fixes = sorted(
            fixes_by_code_id.get(code_id, []),
            key=lambda x: _parse_int(x.get("probability_rank"), 999),
        )
        procedures: List[str] = []
        parts: List[str] = []
        top_diff = ""
        top_hours: Optional[float] = None
        top_fix_titles: List[str] = []

        for idx, fx in enumerate(ranked_fixes):
            rank = _parse_int(fx.get("probability_rank"), idx + 1)
            title = _clean_text(fx.get("fix_title"))
            steps = _clean_text(fx.get("step_by_step_instructions"))
            diff = _clean_text(fx.get("difficulty_level"))
            hrs = _parse_float(fx.get("est_labor_hours"))
            if idx == 0:
                top_diff = diff
                top_hours = hrs
            if title:
                top_fix_titles.append(f"#{rank} {title}")
            proc_line = f"#{rank} {title}"
            if diff:
                proc_line += f" [{diff}]"
            if hrs is not None:
                proc_line += f" (~{hrs}h)"
            if steps:
                proc_line += f": {steps}"
            procedures.append(proc_line)
            fid = (fx.get("fix_id") or "").strip()
            for pname in parts_by_fix.get(fid, []):
                if pname not in parts:
                    parts.append(pname)

        sys_id = infer_system(code, f"{short_desc} {detail}", category=category)
        rec = make_canonical_record(
            rec_id=f"EXT-MDB-{code_id}-{code}",
            code=code,
            oem_make=oem_make,
            system=sys_id,
            symptoms=short_desc,
            cause=detail,
            fix="; ".join(top_fix_titles[:3]) or short_desc,
            procedures=procedures,
            parts=parts,
            difficulty=top_diff,
            est_labor_hours=top_hours,
            tier=2,
            source="MechanicDB-public",
            license_name="ODbL-1.0",
        )
        records.append(rec)
        obd_count += 1

    # J1939 Heavy-Duty faults -> code="" (non-OBD-II)
    hd_dir = mdb_dir / "samples" / "heavyduty"
    j_faults = _read_pipe_csv(hd_dir / "j1939_faults.csv")
    j_fixes = _read_pipe_csv(hd_dir / "j1939_fixes_joined.csv")
    j_fmi_rows = _read_pipe_csv(hd_dir / "j1939_fmi.csv")
    fmi_map = {
        (r.get("fmi") or "").strip(): _clean_text(r.get("fmi_name"))
        for r in j_fmi_rows
        if (r.get("fmi") or "").strip()
    }
    j_fixes_by_fid: Dict[str, List[Dict[str, str]]] = defaultdict(list)
    for jf in j_fixes:
        fid = (jf.get("fault_id") or "").strip()
        if fid:
            j_fixes_by_fid[fid].append(jf)

    j1939_count = 0
    for jf in j_faults:
        fault_id = (jf.get("fault_id") or "").strip()
        spn = (jf.get("spn") or "").strip()
        fmi = (jf.get("fmi") or "").strip()
        oem_make = _clean_text(jf.get("oem_make"))
        oem_code = _clean_text(jf.get("oem_code"))
        controller = _clean_text(jf.get("controller"))
        short_desc = _clean_text(jf.get("short_description"))
        detail = _clean_text(jf.get("detailed_technical_explanation"))
        fmi_name = fmi_map.get(fmi, "")

        ranked = sorted(
            j_fixes_by_fid.get(fault_id, []),
            key=lambda x: _parse_int(x.get("probability_rank"), 999),
        )
        procedures = []
        top_diff = ""
        top_hours = None
        fix_titles = []
        for idx, fx in enumerate(ranked):
            rank = _parse_int(fx.get("probability_rank"), idx + 1)
            title = _clean_text(fx.get("fix_title"))
            steps = _clean_text(fx.get("step_by_step_instructions"))
            diff = _clean_text(fx.get("difficulty_level"))
            hrs = _parse_float(fx.get("est_labor_hours"))
            if idx == 0:
                top_diff = diff
                top_hours = hrs
            if title:
                fix_titles.append(f"#{rank} {title}")
            line = f"#{rank} {title}"
            if diff:
                line += f" [{diff}]"
            if hrs is not None:
                line += f" (~{hrs}h)"
            if steps:
                line += f": {steps}"
            procedures.append(line)

        j1939_label = f"J1939 SPN {spn} FMI {fmi}"
        if fmi_name:
            j1939_label += f" ({fmi_name})"
        if oem_code:
            j1939_label += f" | OEM Code {oem_code}"
        symptoms_full = f"{j1939_label} [{controller}]: {short_desc}"
        sys_id = infer_system("", f"{controller} {short_desc} {detail}", category=controller)

        rec = make_canonical_record(
            rec_id=f"EXT-MDB-J1939-{fault_id}-SPN{spn}-FMI{fmi}",
            code="",
            oem_make=oem_make,
            system=sys_id,
            symptoms=symptoms_full,
            cause=detail,
            fix="; ".join(fix_titles[:3]) or short_desc,
            procedures=procedures,
            difficulty=top_diff,
            est_labor_hours=top_hours,
            tier=3,
            source="MechanicDB-public",
            license_name="ODbL-1.0",
        )
        records.append(rec)
        j1939_count += 1

    stats = {
        "obd_codes_ingested": obd_count,
        "j1939_faults_ingested": j1939_count,
        "total_emitted": len(records),
    }
    return records, stats


# ---------------------------------------------------------------------------
# 3. karsonmadden/us-vehicle-trouble-codes enrichment & standalone additions
# ---------------------------------------------------------------------------

def apply_karsonmadden(
    km_dir: Path,
    cm_dtcs: Dict[str, Dict[str, Any]],
    mdb_records: List[Dict[str, Any]],
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """Enrich existing DTCs with NHTSA bulletin/owner counts and emit uncovered valid DTCs."""
    with open(km_dir / "dtc.csv", encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))

    mdb_by_code: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for rec in mdb_records:
        if rec["code"]:
            mdb_by_code[rec["code"]].append(rec)

    standalone: List[Dict[str, Any]] = []
    enriched_cm = 0
    enriched_mdb = 0
    skipped_empty_meaning = 0
    invalid_codes = 0

    for row in rows:
        code = (row.get("code") or "").strip().upper()
        if not is_valid_dtc(code):
            invalid_codes += 1
            continue
        meaning = _clean_text(row.get("meaning"))
        bulletins = _parse_int(row.get("bulletins"), 0)
        owner_reports = _parse_int(row.get("owner_reports"), 0)
        components_raw = _clean_text(row.get("components"))
        components = [
            c.strip()
            for c in components_raw.split("|")
            if c.strip() and c.strip().lower() != "unknown or other"
        ]

        matched_any = False
        if code in cm_dtcs:
            rec = cm_dtcs[code]
            rec["nhtsa_bulletins"] = max(rec["nhtsa_bulletins"], bulletins)
            rec["nhtsa_owner_reports"] = max(rec["nhtsa_owner_reports"], owner_reports)
            if components:
                comp_note = "NHTSA Components: " + ", ".join(components[:6])
                if comp_note not in rec["procedures"]:
                    rec["procedures"].append(comp_note)
            rec["text"] = build_search_text(rec)
            enriched_cm += 1
            matched_any = True

        if code in mdb_by_code:
            for rec in mdb_by_code[code]:
                rec["nhtsa_bulletins"] = max(rec["nhtsa_bulletins"], bulletins)
                rec["nhtsa_owner_reports"] = max(rec["nhtsa_owner_reports"], owner_reports)
                rec["text"] = build_search_text(rec)
                enriched_mdb += 1
            matched_any = True

        if not matched_any:
            if not meaning:
                skipped_empty_meaning += 1
                continue
            sys_id = infer_system(code, f"{meaning} {' '.join(components)}")
            procs = [f"NHTSA Components: {', '.join(components[:6])}"] if components else []
            standalone.append(
                make_canonical_record(
                    rec_id=f"EXT-KM-{code}",
                    code=code,
                    oem_make="",
                    system=sys_id,
                    symptoms=meaning,
                    cause="",
                    fix="",
                    procedures=procs,
                    nhtsa_bulletins=bulletins,
                    nhtsa_owner_reports=owner_reports,
                    tier=3,
                    source="karsonmadden/us-vehicle-trouble-codes",
                    license_name="CC-BY-4.0",
                )
            )

    stats = {
        "rows_total": len(rows),
        "invalid_codes": invalid_codes,
        "enriched_commonmanual_records": enriched_cm,
        "enriched_mechanicdb_records": enriched_mdb,
        "standalone_emitted": len(standalone),
        "skipped_uncovered_empty_meaning": skipped_empty_meaning,
    }
    return standalone, stats


# ---------------------------------------------------------------------------
# 4. RRK1987/automotive-diagnostics-v2 strict quality-audit filter
# ---------------------------------------------------------------------------

def _ecu_matches_dtc(code: str, ecu: str, canonical_desc: str = "") -> bool:
    ecu_l = ecu.lower()
    prefix = code[0]
    if code.startswith(("P07", "P08", "P09", "P17", "P18", "P27", "P28")):
        return any(k in ecu_l for k in ("transmission", "tcm", "powertrain", "pcm"))
    if prefix == "P":
        return any(k in ecu_l for k in ("engine", "ecm", "pcm", "powertrain", "hybrid", "battery"))
    if prefix == "C":
        if "abs" in ecu_l or "brake" in ecu_l or "chassis" in ecu_l or "eps" in ecu_l or "steering" in ecu_l:
            return True
        return False
    if prefix == "B":
        return any(k in ecu_l for k in ("body", "bcm", "srs", "airbag", "restraint", "climate", "hvac"))
    if prefix == "U":
        # U0121 is specifically ABS; U0100 is ECM
        if code == "U0121":
            return "abs" in ecu_l or "brake" in ecu_l or "gateway" in ecu_l
        if code == "U0100":
            return "engine" in ecu_l or "ecm" in ecu_l or "pcm" in ecu_l or "gateway" in ecu_l
        if "gateway" in ecu_l or "network" in ecu_l or "can" in ecu_l or "bcm" in ecu_l:
            return True
        return "transmission" not in ecu_l and "srs" not in ecu_l
    return False


def _is_synthetic_truncated_noise(assistant_text: str) -> bool:
    """Detect mid-word truncated or all-caps synthetic context chunks."""
    m = re.search(
        r"Technical Context:\s*(.*?)(?:\n\nSafety Action Required:|$)",
        assistant_text,
        re.S,
    )
    if not m:
        return False
    ctx = m.group(1).strip()
    if not ctx:
        return True
    # Check if mostly ALL-CAPS synthetic slice
    alpha_chars = [ch for ch in ctx if ch.isalpha()]
    upper_ratio = (sum(1 for ch in alpha_chars if ch.isupper()) / len(alpha_chars)) if alpha_chars else 0.0
    if upper_ratio > 0.85 and len(alpha_chars) >= 40:
        # Check truncation at end (no sentence-ending punctuation) or mid-word fragment start
        ends_cleanly = ctx.rstrip().endswith((".", "!", "?", ")"))
        first_token = ctx.lstrip().split()[0] if ctx.lstrip() else ""
        # Short fragment like RE, SED, TION, D, LE, RS, AL
        if not ends_cleanly or (first_token.isalpha() and len(first_token) <= 4 and first_token not in {"CAN", "UDS", "ECU", "ECM", "TCM", "ABS", "SRS", "OBD"}):
            return True
        if upper_ratio > 0.90:
            return True
    return False


def _has_cross_topic_mismatch(code: str, assistant_text: str, canonical_desc: str) -> bool:
    """Cross-check RRK1987 assistant narrative against canonical J2012/CommonManual meaning."""
    text_l = assistant_text.lower()
    if code.startswith(("P07", "P08", "P09")) and "catalytic converter" in text_l:
        return True
    if code == "P0420" and ("fuel pump" in text_l or "fuel rail pressure" in text_l):
        return True
    if code.startswith("B") and "ecm circuit fuses" in text_l and "airbag" not in text_l.split("technical context:")[-1]:
        return True
    if canonical_desc:
        desc_l = canonical_desc.lower()
        if "catalyst" in desc_l and "transmission" in text_l and "catalytic" not in text_l:
            return True
    return False


def validate_rrk1987_row(
    row: Dict[str, Any], canonical_dtcs: Dict[str, Dict[str, Any]]
) -> Tuple[bool, Optional[str], Optional[Dict[str, Any]]]:
    """Validate one RRK1987 row; returns (accepted, rejection_reason, canonical_record_or_None)."""
    user_txt = str(row.get("user") or "")
    asst_txt = str(row.get("assistant") or "")
    raw_code = str(row.get("dtc_code") or "").strip().upper()

    if not raw_code:
        m = re.search(r"Fault Code:\s*([PCBU][0-9A-F]{4})\b", asst_txt, re.I)
        if not m:
            m = DTC_TEXT_RE.search(user_txt)
        raw_code = m.group(1).upper() if m else ""

    if not is_valid_dtc(raw_code):
        return False, "invalid_or_missing_dtc", None
    if raw_code in PLACEHOLDER_DTCS:
        return False, "placeholder_dtc", None

    m_ecu = re.search(r"Affected ECU:\s*(.+)", asst_txt)
    ecu = _clean_text(m_ecu.group(1)) if m_ecu else ""
    canonical = canonical_dtcs.get(raw_code)
    canonical_desc = canonical["symptoms"] if canonical else ""

    if not ecu or not _ecu_matches_dtc(raw_code, ecu, canonical_desc):
        return False, "contradictory_ecu_dtc_mapping", None

    if _is_synthetic_truncated_noise(asst_txt):
        return False, "synthetic_truncated_noise", None

    if _has_cross_topic_mismatch(raw_code, asst_txt, canonical_desc):
        return False, "canonical_definition_mismatch", None

    sys_id = infer_system(raw_code, f"{user_txt} {ecu} {canonical_desc}")
    rec = make_canonical_record(
        rec_id=f"EXT-RRK-{raw_code}",
        code=raw_code,
        oem_make="",
        system=sys_id,
        symptoms=user_txt,
        cause=ecu,
        fix=asst_txt,
        tier=3,
        source="RRK1987/automotive-diagnostics-v2",
        license_name="MIT",
    )
    return True, None, rec


def audit_and_parse_rrk1987(
    rrk_dir: Path, canonical_dtcs: Dict[str, Dict[str, Any]]
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """Audit all splits of RRK1987/automotive-diagnostics-v2 and emit only validated rows."""
    inspected = 0
    kept_records: List[Dict[str, Any]] = []
    rejection_counts: Counter[str] = Counter()

    for split in ("train", "validation"):
        fp = rrk_dir / f"{split}.json"
        if not fp.exists():
            continue
        payload = json.loads(fp.read_text(encoding="utf-8"))
        for idx, item in enumerate(payload.get("rows", [])):
            row = item.get("row", item) if isinstance(item, dict) else {}
            inspected += 1
            ok, reason, rec = validate_rrk1987_row(row, canonical_dtcs)
            if ok and rec is not None:
                rec["id"] = f"EXT-RRK-{split}-{idx}-{rec['code']}"
                kept_records.append(rec)
            else:
                rejection_counts[reason or "unknown_rejection"] += 1

    stats = {
        "rows_inspected": inspected,
        "rows_kept": len(kept_records),
        "rows_rejected": inspected - len(kept_records),
        "rejection_breakdown": dict(sorted(rejection_counts.items())),
    }
    return kept_records, stats


# ---------------------------------------------------------------------------
# 5. GITheMan/vehicle-repair-manuals audit
# ---------------------------------------------------------------------------

def audit_githeman(githeman_dir: Path) -> Dict[str, Any]:
    tree_path = githeman_dir / "tree.json"
    if not tree_path.exists():
        raise FileNotFoundError(f"Missing GITheMan tree cache: {tree_path}")
    tree_data = json.loads(tree_path.read_text(encoding="utf-8"))
    files = [item["path"] for item in tree_data.get("tree", []) if item.get("type") == "blob"]
    manual_files = [
        p for p in files if p.lower().endswith((".pdf", ".md", ".txt", ".html", ".json")) and p.lower() != "readme.md"
    ]
    return {
        "status": "skipped_empty_upstream_repository" if not manual_files else "verified",
        "verified_files": sorted(files),
        "manual_file_count": len(manual_files),
        "records_emitted": 0,
    }


# ---------------------------------------------------------------------------
# Pipeline runner
# ---------------------------------------------------------------------------

def run_pipeline(
    temp_dir: Path,
    output_path: Path,
    manifest_path: Path,
    skip_download: bool = False,
    cleanup_temp: bool = False,
) -> Dict[str, Any]:
    if not skip_download:
        download_all_sources(temp_dir)

    cm_dir = temp_dir / "commonmanual"
    mdb_dir = temp_dir / "mechanicdb"
    km_dir = temp_dir / "karsonmadden"
    rrk_dir = temp_dir / "rrk1987"
    githeman_dir = temp_dir / "githeman"

    for req_dir in (cm_dir, mdb_dir, km_dir, rrk_dir, githeman_dir):
        if not req_dir.exists():
            raise FileNotFoundError(f"Required downloaded dataset folder missing: {req_dir}")

    cm_dtcs, cm_kb_records, cm_stats = parse_commonmanual(cm_dir)
    mdb_records, mdb_stats = parse_mechanicdb(mdb_dir)
    km_standalone, km_stats = apply_karsonmadden(km_dir, cm_dtcs, mdb_records)
    rrk_records, rrk_stats = audit_and_parse_rrk1987(rrk_dir, cm_dtcs)
    githeman_stats = audit_githeman(githeman_dir)

    all_records: List[Dict[str, Any]] = []
    all_records.extend(cm_dtcs.values())
    all_records.extend(cm_kb_records)
    all_records.extend(mdb_records)
    all_records.extend(km_standalone)
    all_records.extend(rrk_records)

    # Deterministic deduplication by id
    seen_ids = set()
    deduped: List[Dict[str, Any]] = []
    for rec in all_records:
        if rec["id"] in seen_ids:
            continue
        seen_ids.add(rec["id"])
        deduped.append(rec)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=6) as gz:
        for rec in deduped:
            gz.write((json.dumps(rec, ensure_ascii=False) + "\n").encode("utf-8"))
    payload_bytes = buf.getvalue()
    for attempt in range(6):
        try:
            if output_path.exists():
                output_path.unlink()
            output_path.write_bytes(payload_bytes)
            break
        except PermissionError:
            if attempt == 5:
                raise
            time.sleep(0.5)

    unique_dtcs = sorted({r["code"] for r in deduped if r["code"]})
    system_counts = Counter(r["system"] for r in deduped)
    source_counts = Counter(r["source"] for r in deduped)
    tier_counts = Counter(str(r["tier"]) for r in deduped)

    manifest = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "project_license": "GPL-3.0",
        "output_file": output_path.relative_to(BASE_DIR).as_posix()
        if output_path.is_relative_to(BASE_DIR)
        else str(output_path),
        "output_size_bytes": output_path.stat().st_size,
        "totals": {
            "records": len(deduped),
            "unique_valid_obd2_dtcs": len(unique_dtcs),
            "non_obd_or_general_records": sum(1 for r in deduped if not r["code"]),
            "by_system": dict(sorted(system_counts.items())),
            "by_source": dict(sorted(source_counts.items())),
            "by_tier": dict(sorted(tier_counts.items())),
        },
        "sources": {
            "commonmanual": {
                "url": "https://github.com/xsvdevelopment/commonmanual",
                "license": "CC-BY-SA-4.0 (data) / MIT (code)",
                "status": "ingested",
                "records_emitted": len(cm_dtcs) + len(cm_kb_records),
                **cm_stats,
            },
            "MechanicDB-public": {
                "url": "https://github.com/MechanicDB/MechanicDB-public",
                "license": "ODbL-1.0 (dataset) / MIT (upstream J2012) / CC-BY-4.0 (docs)",
                "status": "ingested",
                **mdb_stats,
            },
            "karsonmadden/us-vehicle-trouble-codes": {
                "url": "https://huggingface.co/datasets/karsonmadden/us-vehicle-trouble-codes",
                "license": "CC-BY-4.0",
                "status": "ingested_and_enriched",
                **km_stats,
            },
            "RRK1987/automotive-diagnostics-v2": {
                "url": "https://huggingface.co/datasets/RRK1987/automotive-diagnostics-v2",
                "license": "MIT",
                "status": (
                    "audited_zero_kept_low_quality_synthetic"
                    if rrk_stats["rows_kept"] == 0
                    else "audited_partially_ingested"
                ),
                **rrk_stats,
            },
            "GITheMan/vehicle-repair-manuals": {
                "url": "https://github.com/GITheMan/vehicle-repair-manuals",
                "license": "MIT",
                **githeman_stats,
            },
        },
    }

    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    if cleanup_temp and temp_dir.exists():
        shutil.rmtree(temp_dir)

    return manifest


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Ingest and merge external automotive RAG datasets.")
    parser.add_argument("--temp-dir", type=Path, default=DEFAULT_TEMP_DIR)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT_PATH)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST_PATH)
    parser.add_argument("--skip-download", action="store_true")
    parser.add_argument("--cleanup-temp", action="store_true")
    return parser.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = parse_args(argv)
    manifest = run_pipeline(
        temp_dir=args.temp_dir,
        output_path=args.output,
        manifest_path=args.manifest,
        skip_download=args.skip_download,
        cleanup_temp=args.cleanup_temp,
    )
    print(
        json.dumps(
            {
                "records": manifest["totals"]["records"],
                "unique_dtcs": manifest["totals"]["unique_valid_obd2_dtcs"],
                "output_size_bytes": manifest["output_size_bytes"],
                "by_source": manifest["totals"]["by_source"],
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
