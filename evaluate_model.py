import time  
import json
from engine import VehicleExpertEngine

def run_evaluation():
    with open("kb_data.json", "r", encoding="utf-8") as f:
        kb_data = json.load(f)
    
    engine = VehicleExpertEngine(kb_data)

    test_cases = [
        {"query": "пинки при переключении передач", "expected_system": "transmission"},
        {"query": "педаль тормоза мягкая", "expected_system": "brakes"},
        {"query": "двигатель троит и трясется", "expected_system": "engine"},
        {"query": "потеря мощности, медленный разгон", "expected_system": "engine"},
        {"query": "ошибка ABS колеса", "expected_system": "brakes"},
        {"query": "не работает CAN шина", "expected_system": "electrical"},
        {"query": "вибрации руля и стук при езде по кочкам", "expected_system": "transmission"},
    ]

    mrr, recall = [], 0
    total_time = 0 
    print(f"МЕТРИКИ\n")
    
    for case in test_cases:
        start_time = time.perf_counter()  
        results = engine.diagnose(case["query"], top_n=3)
        elapsed_time = time.perf_counter() - start_time  
        total_time += elapsed_time  
        
        found_systems = [r["meta"].get("system") for r in results]
        
        rank = 0
        if case["expected_system"] in found_systems:
            rank = found_systems.index(case["expected_system"]) + 1
            mrr.append(1.0 / rank)
            recall += 1
        else:
            mrr.append(0.0)
            
        print(f"Запрос: {case['query'][:25]}... | Найдено: {found_systems} | Ранг: {rank if rank>0 else 'Промах'} | Время: {elapsed_time * 1000:.1f} мс")

    avg_latency = (total_time / len(test_cases)) * 1000

    print(f"\nИТОГИ:")
    print(f"Recall@3: {(recall/len(test_cases))*100:.1f}%")
    print(f"MRR: {sum(mrr)/len(test_cases):.3f}")
    print(f"Среднее время отклика (Latency): {avg_latency:.2f} мс") 

if __name__ == "__main__":
    run_evaluation()