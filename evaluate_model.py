# SPDX-License-Identifier: GPL-3.0-or-later
import json
import time
from typing import Any, Dict, List

from engine import VehicleExpertEngine
from vulkan_backend import BASE_DIR, init_vulkan_environment


def _run_benchmark_suite(
    engine: VehicleExpertEngine,
    cases: List[Dict[str, Any]],
    verbose: bool = True,
) -> Dict[str, float]:
    mrr_scores: List[float] = []
    recall_hits = 0
    total_time = 0.0

    for case in cases:
        start_time = time.perf_counter()
        results = engine.diagnose(case["query"], top_n=3)
        elapsed_time = time.perf_counter() - start_time
        total_time += elapsed_time

        found_systems = [r["meta"].get("system") for r in results]
        found_codes = [(r["meta"].get("code") or "").upper() for r in results]

        rank = 0
        expected_code = (case.get("expected_code") or "").upper()
        expected_sys = case.get("expected_system")

        if expected_code:
            if expected_code in found_codes:
                rank = found_codes.index(expected_code) + 1
        elif expected_sys and expected_sys in found_systems:
            rank = found_systems.index(expected_sys) + 1

        if rank > 0:
            mrr_scores.append(1.0 / rank)
            recall_hits += 1
        else:
            mrr_scores.append(0.0)

        if verbose:
            print(
                f"Запрос: {case['query'][:30]:<30} | Найдено: {found_systems} | "
                f"Ранг: {rank if rank > 0 else 'Промах'} | Время: {elapsed_time * 1000:.2f} мс"
            )

    n = max(1, len(cases))
    return {
        "recall_at_3": (recall_hits / n) * 100.0,
        "mrr": sum(mrr_scores) / n,
        "avg_latency_ms": (total_time / n) * 1000.0,
    }


def run_evaluation() -> Dict[str, Any]:
    init_vulkan_environment(verbose=True)
    kb_path = BASE_DIR / "kb_data.json"
    with open(kb_path, "r", encoding="utf-8") as f:
        kb_data = json.load(f)

    engine = VehicleExpertEngine(kb_data=kb_data, kb_path=kb_path)

    test_cases = [
        {"query": "пинки при переключении передач", "expected_system": "transmission"},
        {"query": "педаль тормоза мягкая", "expected_system": "brakes"},
        {"query": "двигатель троит и трясется", "expected_system": "engine"},
        {"query": "потеря мощности, медленный разгон", "expected_system": "engine"},
        {"query": "ошибка ABS колеса", "expected_system": "brakes"},
        {"query": "не работает CAN шина", "expected_system": "electrical"},
        {"query": "вибрации руля и стук при езде по кочкам", "expected_system": "transmission"},
    ]

    print("\nМЕТРИКИ КАЧЕСТВА RAG-ЯДРА (VULKAN)\n" + "=" * 68)
    cold_stats = _run_benchmark_suite(engine, test_cases, verbose=True)
    warm_stats = _run_benchmark_suite(engine, test_cases, verbose=False)

    ext_count = len(getattr(engine, "external_kb", []))
    print("\nИТОГИ (Основной эталон Tier 1 RU):")
    print(f"Всего документов в индексе (KB + Telemetry + External): {len(engine.raw_data)} (внешних: {ext_count})")
    print(f"Уникальных кодов ошибок (DTC) в словаре: {len(engine.dtc_catalog)}")
    print(f"Recall@3: {cold_stats['recall_at_3']:.1f}%")
    print(f"MRR: {cold_stats['mrr']:.3f}")
    print(f"Среднее время отклика (Cold Latency): {cold_stats['avg_latency_ms']:.2f} мс")
    print(f"Среднее время отклика (Warm Latency): {warm_stats['avg_latency_ms']:.2f} мс")

    external_smoke_stats = None
    if ext_count > 0:
        english_smoke_cases: List[Dict[str, Any]] = [
            {"query": "random multiple cylinder misfire sensor circuit", "expected_system": "engine"},
            {"query": "wheel speed sensor ABS circuit malfunction", "expected_system": "brakes"},
            {"query": "transmission shift solenoid pressure performance", "expected_system": "transmission"},
            {"query": "lost communication with ECM PCM CAN bus", "expected_system": "electrical"},
        ]
        # Дополнительно проверяем прямой поиск по первому внешнему коду Tier >= 2 в каталоге
        ext_only_code = next(
            (c for c, info in engine.dtc_catalog.items() if int(info.get("tier") or 1) >= 2),
            None,
        )
        if ext_only_code:
            english_smoke_cases.append(
                {
                    "query": f"diagnostic fault {ext_only_code}",
                    "expected_code": ext_only_code,
                }
            )

        print("\nДОПОЛНИТЕЛЬНЫЙ SMOKE-БЕНЧМАРК (EN / External KB)\n" + "-" * 68)
        external_smoke_stats = _run_benchmark_suite(engine, english_smoke_cases, verbose=True)
        print(
            f"External Smoke Recall@3: {external_smoke_stats['recall_at_3']:.1f}% | "
            f"MRR: {external_smoke_stats['mrr']:.3f} | "
            f"Latency: {external_smoke_stats['avg_latency_ms']:.2f} мс"
        )

    return {
        "total_documents": len(engine.raw_data),
        "unique_dtc_codes": len(engine.dtc_catalog),
        "cold_stats": cold_stats,
        "warm_stats": warm_stats,
        "external_smoke_stats": external_smoke_stats,
    }


if __name__ == "__main__":
    run_evaluation()
