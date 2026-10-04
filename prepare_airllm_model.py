"""
Скрипт загрузки и послойного разбиения (AirLLM Sharding) официально поддерживаемой
мультимодальной модели Qwen/Qwen3.5-4B (AirLLMQwen3_5, Qwen3_5ForConditionalGeneration:
Gated DeltaNet + Gated Attention + встроенный Vision-энкодер model.visual).

Все пути строго относительные:
- Конфигурация, процессор и токенизатор: models/Qwen3.5-4B/
- Послойные шарды AirLLM: models/airllm_shards/splitted_model/
"""

import gc
import json
import os
import shutil
import ssl
import time
from pathlib import Path

import httpx
import huggingface_hub
from safetensors import safe_open
from safetensors.torch import save_file

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_MODEL_REPO = "Qwen/Qwen3.5-4B"
MODEL_REPO_ID = os.environ.get("AIRLLM_MODEL_ID", DEFAULT_MODEL_REPO)
LOCAL_MODEL_DIR = BASE_DIR / "models" / "Qwen3.5-4B"
SHARDS_DIR = BASE_DIR / "models" / "airllm_shards"


def configure_resilient_hf_http():
    """Обходит ошибки корпоративных/локальных SSL-сертификатов при обращении к HuggingFace Hub."""
    try:
        huggingface_hub.set_client_factory(
            lambda: httpx.Client(
                verify=False,
                follow_redirects=True,
                timeout=httpx.Timeout(180.0, connect=30.0),
            )
        )
    except Exception:
        pass
    ssl._create_default_https_context = ssl._create_unverified_context


def get_airllm_layer_prefixes(all_keys: list[str]) -> list[str]:
    """
    Формирует список послойных префиксов в точном соответствии с классом `AirLLMQwen3_5`
    из официального пакета `airllm` (`airllm/airllm_qwen3_5.py`).
    """
    is_vl = any(k.startswith("model.language_model.") for k in all_keys)
    if is_vl:
        layer_prefix = "model.language_model.layers"
        embed_prefix = "model.language_model.embed_tokens"
        norm_prefix = "model.language_model.norm"
        residents = ["model.visual"]
    else:
        layer_prefix = "model.layers"
        embed_prefix = "model.embed_tokens"
        norm_prefix = "model.norm"
        residents = []

    layer_indices = set()
    for k in all_keys:
        if k.startswith(layer_prefix + "."):
            rest = k[len(layer_prefix) + 1 :]
            idx_str = rest.split(".", 1)[0]
            if idx_str.isdigit():
                layer_indices.add(int(idx_str))

    n_layers = max(layer_indices) + 1 if layer_indices else 32
    prefixes = (
        [embed_prefix + "."]
        + [f"{layer_prefix}.{i}." for i in range(n_layers)]
        + [norm_prefix + ".", "lm_head."]
        + [r + "." for r in residents]
    )
    return [p for p in prefixes if any(k.startswith(p) for k in all_keys)]


def fast_split_safetensors_for_airllm(
    checkpoint_dir: Path,
    shards_root_dir: Path,
    delete_original: bool = True,
) -> Path:
    """
    Создаёт послойные шарды AirLLM (`*.safetensors` + `*.safetensors.done`)
    в точном формате `SafetensorModelPersister` пакета `airllm`.
    """
    saving_path = shards_root_dir / "splitted_model"
    saving_path.mkdir(parents=True, exist_ok=True)

    index_file = checkpoint_dir / "model.safetensors.index.json"
    single_file = checkpoint_dir / "model.safetensors"

    if index_file.exists():
        weight_map = json.loads(index_file.read_text(encoding="utf-8"))["weight_map"]
    elif single_file.exists():
        with safe_open(str(single_file), framework="pt", device="cpu") as f:
            all_keys = list(f.keys())
        weight_map = {k: "model.safetensors" for k in all_keys}
        index_file.write_text(
            json.dumps({"metadata": {"format": "pt"}, "weight_map": weight_map}, indent=2),
            encoding="utf-8",
        )
    else:
        raise FileNotFoundError(f"Не найдены веса модели в {checkpoint_dir}")

    layer_prefixes = get_airllm_layer_prefixes(list(weight_map.keys()))

    all_ready = all(
        (saving_path / f"{lp}safetensors").exists() and (saving_path / f"{lp}safetensors.done").exists()
        for lp in layer_prefixes
    )
    if all_ready:
        print(f"[AirLLM] Все {len(layer_prefixes)} послойных шардов уже готовы в {saving_path}")
        return saving_path

    print(f"[AirLLM] Послойное разбиение {MODEL_REPO_ID} ({len(layer_prefixes)} модулей) в {saving_path}...")
    t0 = time.perf_counter()

    keys_by_layer: dict[str, list[str]] = {lp: [] for lp in layer_prefixes}
    for key in weight_map.keys():
        best_lp = None
        for lp in layer_prefixes:
            if key.startswith(lp) and (best_lp is None or len(lp) > len(best_lp)):
                best_lp = lp
        if best_lp is not None:
            keys_by_layer[best_lp].append(key)

    shard_files = sorted(set(weight_map.values()))
    handles = {}
    cms = []
    try:
        for sf in shard_files:
            sf_path = checkpoint_dir / sf
            if sf_path.exists():
                cm = safe_open(str(sf_path), framework="pt", device="cpu")
                handles[sf] = cm.__enter__()
                cms.append(cm)

        for idx, lp in enumerate(layer_prefixes, start=1):
            out_file = saving_path / f"{lp}safetensors"
            done_file = saving_path / f"{lp}safetensors.done"
            if out_file.exists() and done_file.exists():
                continue

            layer_sd = {}
            for k in keys_by_layer[lp]:
                sf = weight_map[k]
                layer_sd[k] = handles[sf].get_tensor(k)

            save_file(layer_sd, str(out_file))
            done_file.touch()
            del layer_sd
            print(f"  [{idx}/{len(layer_prefixes)}] Сохранён шард AirLLM: {out_file.name}")
    finally:
        for cm in cms:
            try:
                cm.__exit__(None, None, None)
            except Exception:
                pass
        gc.collect()

    if delete_original:
        for sf in shard_files:
            sf_path = checkpoint_dir / sf
            if sf_path.exists():
                try:
                    sf_path.unlink()
                    print(f"[AirLLM] Удалён исходный шард {sf_path.name} (оставлены послойные шарды AirLLM).")
                except Exception as exc:
                    print(f"[AirLLM] Не удалось удалить {sf_path.name}: {exc}")
        cache_dir = checkpoint_dir / ".cache"
        if cache_dir.exists():
            shutil.rmtree(cache_dir, ignore_errors=True)

    elapsed = time.perf_counter() - t0
    print(f"[AirLLM] Послойное разбиение успешно завершено за {elapsed:.1f} сек.")
    return saving_path


def ensure_airllm_model_ready() -> tuple[Path, Path]:
    configure_resilient_hf_http()

    # Удаляем незавершенные старые папки при смене модели
    old_dir = BASE_DIR / "models" / "Qwen3.5-9B-bnb-4bit"
    if old_dir.exists():
        shutil.rmtree(old_dir, ignore_errors=True)

    LOCAL_MODEL_DIR.mkdir(parents=True, exist_ok=True)
    SHARDS_DIR.mkdir(parents=True, exist_ok=True)

    splitted_dir = SHARDS_DIR / "splitted_model"
    done_markers = list(splitted_dir.glob("*.done")) if splitted_dir.exists() else []
    if (
        (LOCAL_MODEL_DIR / "config.json").exists()
        and (LOCAL_MODEL_DIR / "model.safetensors.index.json").exists()
        and len(done_markers) >= 34
    ):
        print(f"[AirLLM] Официальная модель {MODEL_REPO_ID} готова ({len(done_markers)} шардов в {splitted_dir}).")
        return LOCAL_MODEL_DIR, splitted_dir

    print(f"[AirLLM] Скачивание официальной модели {MODEL_REPO_ID} с HuggingFace в {LOCAL_MODEL_DIR}...")
    huggingface_hub.snapshot_download(
        repo_id=MODEL_REPO_ID,
        local_dir=str(LOCAL_MODEL_DIR),
        max_workers=4,
    )

    saved_path = fast_split_safetensors_for_airllm(
        checkpoint_dir=LOCAL_MODEL_DIR,
        shards_root_dir=SHARDS_DIR,
        delete_original=True,
    )
    return LOCAL_MODEL_DIR, saved_path


if __name__ == "__main__":
    ensure_airllm_model_ready()
