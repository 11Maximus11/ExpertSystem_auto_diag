import json
from engine import VehicleExpertEngine
from vulkan_backend import BASE_DIR, init_vulkan_environment


def main():
    init_vulkan_environment(verbose=True)
    kb_path = BASE_DIR / "kb_data.json"
    print(f"Загрузка базы знаний из {kb_path.relative_to(BASE_DIR)}...")
    with open(kb_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    engine = VehicleExpertEngine(kb_data=data, kb_path=kb_path)

    print("\nЭКСПЕРТНАЯ СИСТЕМА ДИАГНОСТИКИ (VULKAN RAG)")
    while True:
        query = input("\nВаш запрос (или 'q' для выхода): ").strip()
        if query.lower() in ["q", "exit", "выход"]:
            break
        if not query:
            continue

        results = engine.diagnose(query)
        for r in results:
            print(f"[{r['meta']['code']} | {r['meta']['system_ru']}] {r['text']} (Score: {r['score']:.2f})")


if __name__ == "__main__":
    main()