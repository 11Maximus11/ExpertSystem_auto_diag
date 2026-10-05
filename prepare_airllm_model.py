"""
Скрипт автоматического скачивания и послойной нарезки модели Google Gemma 4 12B
(google/gemma-4-12B-it-qat-w4a16-ct) в локальную директорию проекта ./models/
для работы через послойный движок AirLLM (Gemma4UnifiedForConditionalGeneration).

Запуск:
    python prepare_airllm_model.py
"""

from __future__ import annotations

import json
import os
import shutil
import time
from pathlib import Path
from typing import Dict, List

import torch
from huggingface_hub import snapshot_download
from safetensors import safe_open
from safetensors.torch import save_file


BASE_DIR = Path(__file__).resolve().parent
MODEL_REPO_ID = os.environ.get("AIRLLM_MODEL_ID", "google/gemma-4-12B-it-qat-w4a16-ct")
DEFAULT_HF_TOKEN = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN") or None
LOCAL_MODEL_DIR = BASE_DIR / "models" / "gemma-4-12B-it"
SHARDS_BASE_DIR = BASE_DIR / "models" / "airllm_shards"
SPLITTED_DIR = SHARDS_BASE_DIR / "splitted_model"

BERT_EMBEDDER_MODEL = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
BERT_RERANKER_MODEL = "cross-encoder/mmarco-mMiniLMv2-L12-H384-v1"

NUM_LAYERS = 48

EXPECTED_SHARDS: List[str] = (
    ["model.language_model.embed_tokens"]
    + [f"model.language_model.layers.{i}" for i in range(NUM_LAYERS)]
    + [
        "model.language_model.norm",
        "model.embed_vision",
        "model.embed_audio",
    ]
)


def remap_gemma4_key(key: str) -> str:
    """Приводит ключи чекпоинта Gemma 4 Unified к именам модулей в transformers >= 5.18."""
    if key == "model.embed_vision.embedding_projection.weight":
        return "model.embed_vision.multimodal_embedder.embedding_projection.weight"
    if key.startswith("model.vision_embedder."):
        return "model.embed_vision." + key[len("model.vision_embedder."):]
    return key


def check_shards_ready(splitted_dir: Path = SPLITTED_DIR) -> bool:
    """Проверяет, что все послойные шарды Gemma 4 12B и маркеры .done уже созданы."""
    marker_file = splitted_dir / "model_id.txt"
    if not marker_file.exists():
        return False
    try:
        if marker_file.read_text(encoding="utf-8").strip() != MODEL_REPO_ID:
            return False
    except Exception:
        return False

    for shard_name in EXPECTED_SHARDS:
        shard_file = splitted_dir / f"{shard_name}.safetensors"
        done_file = splitted_dir / f"{shard_name}.safetensors.done"
        if not shard_file.exists() or not done_file.exists():
            return False
    return True


def _sanitize_local_config(local_model_dir: Path) -> None:
    """
    Сохраняет оригинальную конфигурацию квантования W4A16 в w4a16_quant_config.json
    и убирает жесткую зависимость от внешнего пакета compressed-tensors при создании
    meta-модели в AirLLM (распаковка W4A16 выполняется напрямую в GPU-слоях).
    """
    cfg_path = local_model_dir / "config.json"
    if not cfg_path.exists():
        return
    try:
        with open(cfg_path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        if "quantization_config" in cfg and cfg["quantization_config"] is not None:
            q_cfg = cfg.pop("quantization_config")
            cfg["w4a16_config"] = q_cfg
            with open(local_model_dir / "w4a16_quant_config.json", "w", encoding="utf-8") as qf:
                json.dump(q_cfg, qf, ensure_ascii=False, indent=2)
            with open(cfg_path, "w", encoding="utf-8") as f:
                json.dump(cfg, f, ensure_ascii=False, indent=2)
    except Exception as exc:
        print(f"[AirLLM Prepare] Предупреждение при обработке config.json: {exc}")


def download_and_split_model(
    repo_id: str = MODEL_REPO_ID,
    local_model_dir: Path = LOCAL_MODEL_DIR,
    splitted_dir: Path = SPLITTED_DIR,
    remove_raw_shards_after_split: bool = True,
) -> Dict[str, object]:
    """
    1. Скачивает конфигурацию, токенизатор, процессор и веса Gemma 4 12B из HuggingFace.
    2. За один проход нарезает веса на послойные шарды для AirLLM.
    3. Опционально удаляет исходный монолитный файл весов для экономии места на диске.
    """
    t0 = time.perf_counter()
    local_model_dir.mkdir(parents=True, exist_ok=True)
    splitted_dir.mkdir(parents=True, exist_ok=True)

    if check_shards_ready(splitted_dir) and (local_model_dir / "config.json").exists():
        _sanitize_local_config(local_model_dir)
        print(f"[AirLLM Prepare] Все {len(EXPECTED_SHARDS)} шардов AirLLM ({repo_id}) уже готовы в {splitted_dir}")
        return {
            "status": "ready",
            "model_dir": str(local_model_dir),
            "splitted_dir": str(splitted_dir),
            "shards_count": len(EXPECTED_SHARDS),
            "elapsed_sec": round(time.perf_counter() - t0, 2),
        }

    # Очищаем устаревшие шарды, если идентификатор модели изменился
    old_marker = splitted_dir / "model_id.txt"
    old_model_id = old_marker.read_text(encoding="utf-8").strip() if old_marker.exists() else ""
    if old_model_id != repo_id:
        for old_file in splitted_dir.glob("*"):
            if old_file.is_file():
                try:
                    old_file.unlink()
                except OSError:
                    pass

    existing_safetensors = sorted(p for p in local_model_dir.glob("*.safetensors") if p.is_file())
    if not existing_safetensors or not (local_model_dir / "config.json").exists():
        print(f"[AirLLM Prepare] Скачивание модели {repo_id} в {local_model_dir}...")
        snapshot_download(
            repo_id=repo_id,
            local_dir=str(local_model_dir),
            token=DEFAULT_HF_TOKEN,
            max_workers=2,
        )
    else:
        print(f"[AirLLM Prepare] Найдены локальные файлы весов {repo_id} в {local_model_dir}, переход к нарезке шардов...")
    _sanitize_local_config(local_model_dir)

    raw_safetensors = sorted(
        p for p in local_model_dir.glob("*.safetensors")
        if p.is_file()
    )
    if not raw_safetensors:
        raise FileNotFoundError(
            f"Не найдены файлы весов *.safetensors в {local_model_dir} после скачивания {repo_id}."
        )

    print(f"[AirLLM Prepare] Нарезка весов ({len(raw_safetensors)} файл(ов)) на {len(EXPECTED_SHARDS)} шардов AirLLM...")
    prefixes_sorted = sorted(EXPECTED_SHARDS, key=len, reverse=True)

    # Послойно группируем ключи по файлам, чтобы не держать все 10 ГБ в RAM одновременно
    shard_to_keys: Dict[str, List[tuple[Path, str, str]]] = {name: [] for name in EXPECTED_SHARDS}
    for sf_path in raw_safetensors:
        with safe_open(str(sf_path), framework="pt", device="cpu") as f:
            for orig_key in f.keys():
                # Пропускаем дублирующий lm_head.weight (привязан к embed_tokens через tie_weights)
                # и служебный 16-байтный тензор weight_shape
                if orig_key == "lm_head.weight" or orig_key.endswith(".weight_shape"):
                    continue
                mapped_key = remap_gemma4_key(orig_key)
                for prefix in prefixes_sorted:
                    if mapped_key == prefix or mapped_key.startswith(prefix + "."):
                        shard_to_keys[prefix].append((sf_path, orig_key, mapped_key))
                        break

    saved_count = 0
    for shard_name in EXPECTED_SHARDS:
        out_file = splitted_dir / f"{shard_name}.safetensors"
        done_file = splitted_dir / f"{shard_name}.safetensors.done"
        if out_file.exists() and done_file.exists():
            saved_count += 1
            continue

        key_entries = shard_to_keys.get(shard_name, [])
        if not key_entries:
            continue

        tensors: Dict[str, torch.Tensor] = {}
        by_file: Dict[Path, List[tuple[str, str]]] = {}
        for sf_path, orig_key, mapped_key in key_entries:
            by_file.setdefault(sf_path, []).append((orig_key, mapped_key))

        for sf_path, pairs in by_file.items():
            with safe_open(str(sf_path), framework="pt", device="cpu") as f:
                for orig_key, mapped_key in pairs:
                    tensors[mapped_key] = f.get_tensor(orig_key)

        save_file(tensors, str(out_file))
        done_file.touch()
        tensors.clear()
        saved_count += 1
        if saved_count % 8 == 0 or saved_count == len(EXPECTED_SHARDS):
            print(f"[AirLLM Prepare] Сохранено шардов: {saved_count}/{len(EXPECTED_SHARDS)}")

    (splitted_dir / "model_id.txt").write_text(repo_id, encoding="utf-8")

    # Записываем model.safetensors.index.json для AirLLM, чтобы монолитный model.safetensors не требовался
    idx_file = local_model_dir / "model.safetensors.index.json"
    if not idx_file.exists():
        weight_map: Dict[str, str] = {}
        for sf in sorted(splitted_dir.glob("*.safetensors")):
            with safe_open(str(sf), framework="pt", device="cpu") as f:
                for k in f.keys():
                    weight_map[k] = sf.name
        with open(idx_file, "w", encoding="utf-8") as f:
            json.dump({"metadata": {"total_size": 7540000000}, "weight_map": weight_map}, f, indent=2)

    # Удаляем исходный монолитный файл весов после успешной нарезки для экономии места на диске
    if remove_raw_shards_after_split and check_shards_ready(splitted_dir):
        for sf_path in raw_safetensors:
            try:
                sf_path.unlink()
                print(f"[AirLLM Prepare] Удален исходный монолитный файл {sf_path.name} (шарды сохранены в {splitted_dir})")
            except OSError:
                pass

    elapsed = round(time.perf_counter() - t0, 2)
    print(f"[AirLLM Prepare] Готово за {elapsed} с. Шардов: {saved_count}/{len(EXPECTED_SHARDS)}")
    return {
        "status": "splitted",
        "model_dir": str(local_model_dir),
        "splitted_dir": str(splitted_dir),
        "shards_count": saved_count,
        "elapsed_sec": elapsed,
    }


def ensure_bert_rag_models_ready() -> Dict[str, str]:
    """
    Гарантирует автоматическое скачивание и кэширование BERT-моделей
    (SentenceTransformer + CrossEncoder) при первом запуске после клонирования.
    """
    status: Dict[str, str] = {}
    try:
        from sentence_transformers import SentenceTransformer, CrossEncoder

        print(f"[BERT Prepare] Проверка эмбеддера {BERT_EMBEDDER_MODEL}...")
        SentenceTransformer(BERT_EMBEDDER_MODEL, device="cpu")
        status["embedder"] = "ready"

        print(f"[BERT Prepare] Проверка реранкера {BERT_RERANKER_MODEL}...")
        CrossEncoder(BERT_RERANKER_MODEL, device="cpu")
        status["reranker"] = "ready"
    except Exception as exc:
        status["error"] = str(exc)
        print(f"[BERT Prepare] Предупреждение: {exc}")
    return status


if __name__ == "__main__":
    bert_status = ensure_bert_rag_models_ready()
    result = download_and_split_model()
    result["bert_rag_models"] = bert_status
    print(json.dumps(result, ensure_ascii=False, indent=2))
