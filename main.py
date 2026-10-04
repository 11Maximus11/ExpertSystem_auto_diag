import json
from engine import VehicleExpertEngine

def main():
    print("Загрузка базы знаний...")
    with open("kb_data.json", "r", encoding="utf-8") as f:
        data = json.load(f)
    
    engine = VehicleExpertEngine()
    engine.add_knowledge_base(data)
    
    print("\nЭКСПЕРТНАЯ СИСТЕМА ДИАГНОСТИКИ")
    while True:
        query = input("\nВаш запрос (или 'q' для выхода): ")
        if query.lower() in ['q', 'exit', 'выход']:
            break
            
        results = engine.diagnose(query)
        for r in results:
            print(f"[{r['meta']['code']}] {r['text']} (Score: {r['score']:.2f})")

if __name__ == "__main__":
    main()