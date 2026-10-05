"""
Модуль аппаратного ускорения Vulkan / GPU и адаптивного расчета резидентных слоев
для послойного движка AirLLM Google Gemma 4 12B (W4A16, 48 слоев, окно ~5000 токенов).
"""

import ctypes
import os
import platform
import re
import shutil
import subprocess
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional


BASE_DIR = Path(__file__).resolve().parent


@dataclass
class VulkanDeviceInfo:
    available: bool
    backend: str
    device_index: int
    device_name: str
    api_version: str
    driver_info: str
    device_type: str
    vram_total_mb: int
    vram_free_mb: int
    recommended_gpu_layers: int
    recommended_ctx_size: int
    platform_os: str
    details: Dict[str, Any] = field(default_factory=dict)

    @property
    def backend_name(self) -> str:
        return self.backend

    @property
    def vulkan_available(self) -> bool:
        return self.available

    @property
    def driver_version(self) -> str:
        return self.driver_info

    @property
    def recommended_context_window(self) -> int:
        return self.recommended_ctx_size

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


VulkanDeviceStatus = VulkanDeviceInfo


def _check_vulkan_shared_library() -> bool:
    lib_names = ["vulkan-1.dll"] if platform.system().lower().startswith("win") else ["libvulkan.so.1", "libvulkan.so"]
    for name in lib_names:
        try:
            ctypes.CDLL(name)
            return True
        except OSError:
            continue
    return False


def _parse_vulkaninfo_summary() -> Dict[str, Any]:
    info: Dict[str, Any] = {"instance_version": "1.3+", "devices": []}
    vulkaninfo_bin = shutil.which("vulkaninfo")
    if not vulkaninfo_bin:
        return info

    try:
        proc = subprocess.run(
            [vulkaninfo_bin, "--summary"],
            capture_output=True,
            text=True,
            timeout=4,
            encoding="utf-8",
            errors="ignore",
        )
        output = (proc.stdout or "") + "\n" + (proc.stderr or "")
        ver_match = re.search(r"Vulkan Instance Version:\s*([0-9.]+)", output)
        if ver_match:
            info["instance_version"] = ver_match.group(1)

        current_gpu: Optional[Dict[str, str]] = None
        for line in output.splitlines():
            gpu_match = re.match(r"^GPU(\d+):", line.strip())
            if gpu_match:
                if current_gpu:
                    info["devices"].append(current_gpu)
                current_gpu = {"index": gpu_match.group(1)}
                continue
            if current_gpu is not None and "=" in line:
                k, v = line.split("=", 1)
                current_gpu[k.strip()] = v.strip()
        if current_gpu:
            info["devices"].append(current_gpu)
    except Exception as exc:
        info["error"] = str(exc)

    return info


def _detect_vram_mb() -> tuple[int, int]:
    """
    Определяет общий и свободный объем видеопамяти (в МБ) в реальном времени.
    """
    try:
        import torch

        if torch.cuda.is_available():
            free_b, total_b = torch.cuda.mem_get_info(0)
            return int(total_b // (1024 * 1024)), int(free_b // (1024 * 1024))
    except Exception:
        pass

    default_total = int(os.environ.get("MAX_VRAM_MB", os.environ.get("AUTODIAG_VRAM_MB", "8192")))
    default_free = int(os.environ.get("FREE_VRAM_MB", str(int(default_total * 0.84))))

    nvidia_smi = shutil.which("nvidia-smi")
    if nvidia_smi:
        try:
            proc = subprocess.run(
                [
                    nvidia_smi,
                    "--query-gpu=memory.total,memory.free",
                    "--format=csv,noheader,nounits",
                ],
                capture_output=True,
                text=True,
                timeout=4,
                encoding="utf-8",
                errors="ignore",
            )
            if proc.returncode == 0 and proc.stdout.strip():
                first_line = proc.stdout.strip().splitlines()[0]
                parts = [p.strip() for p in first_line.split(",")]
                if len(parts) >= 2:
                    return int(float(parts[0])), int(float(parts[1]))
        except Exception:
            pass

    return default_total, default_free


def compute_adaptive_vram_allocation(
    vram_total_mb: int,
    vram_free_mb: int,
    context_window_tokens: int = 32768,
    max_response_tokens: int = 5000,
    total_layers: int = 48,
    layer_size_mb: float = 127.0,
    embed_and_norm_mb: float = 2050.0,
) -> Dict[str, int]:
    """
    Адаптивно рассчитывает, сколько слоев модели Google Gemma 4 12B (W4A16, 48 слоев)
    можно закрепить напрямую в видеопамяти GPU (VRAM), гарантируя резерв под большое окно
    контекста (32 768 токенов, гибридное Sliding Window 1024 на 40 слоях + Full Attention на 8 слоях)
    и генерацию ответа (~5000 токенов).
    """
    # В Gemma 4 12B 40 из 48 слоев используют локальное окно (1024 токена) и лишь 8 слоев —
    # глобальный KV-кэш с 2 KV-головами, поэтому даже окно 32K + ответ 5000 токенов занимает ~1.35 ГБ
    kv_and_runtime_reserve_mb = max(
        1300,
        int(vram_total_mb * 0.17),
        int((context_window_tokens / 32768.0) * 950 + (max_response_tokens / 5000.0) * 350),
    )
    usable_for_weights_mb = max(0, vram_free_mb - kv_and_runtime_reserve_mb)

    if usable_for_weights_mb <= embed_and_norm_mb:
        pinned_layers = 0
    else:
        remaining_mb = usable_for_weights_mb - embed_and_norm_mb
        pinned_layers = min(total_layers, max(0, int(remaining_mb // layer_size_mb)))

    streamed_layers = max(0, total_layers - pinned_layers)
    return {
        "vram_total_mb": vram_total_mb,
        "vram_free_mb": vram_free_mb,
        "kv_and_runtime_reserve_mb": kv_and_runtime_reserve_mb,
        "usable_for_weights_mb": usable_for_weights_mb,
        "pinned_gpu_layers": pinned_layers,
        "streamed_dma_layers": streamed_layers,
        "total_layers": total_layers,
        "context_window_tokens": context_window_tokens,
        "max_response_tokens": max_response_tokens,
    }


def compute_optimal_vulkan_layers(
    model_path: Optional[Path] = None,
    vram_free_mb: int = 6800,
    ctx_size: int = 32768,
    total_layers: int = 48,
) -> int:
    """
    Рассчитывает оптимальное количество резидентных слоев GPU для AirLLM Gemma 4 12B и Vulkan,
    оставляя гарантированный запас видеопамяти под окно контекста (32K токенов) и ответ (~5000 токенов).
    """
    env_layers = os.environ.get("VULKAN_GPU_LAYERS")
    if env_layers is not None:
        try:
            return int(env_layers)
        except ValueError:
            pass

    alloc = compute_adaptive_vram_allocation(
        vram_total_mb=max(vram_free_mb, 8192),
        vram_free_mb=vram_free_mb,
        context_window_tokens=ctx_size,
        max_response_tokens=5000,
        total_layers=total_layers,
    )
    if alloc["pinned_gpu_layers"] > 0:
        return alloc["pinned_gpu_layers"]

    if model_path and model_path.exists():
        if model_path.is_dir():
            size_mb = sum(f.stat().st_size for f in model_path.rglob("*.safetensors")) / (1024 * 1024)
            if size_mb < 100:
                size_mb = 7540.0
        else:
            size_mb = model_path.stat().st_size / (1024 * 1024)
    else:
        size_mb = 7540.0

    kv_cache_mb = max(600.0, (ctx_size / 32768.0) * 950.0)
    streaming_headroom_mb = 650.0
    usable_vram_mb = max(512.0, vram_free_mb - kv_cache_mb - streaming_headroom_mb)

    if usable_vram_mb >= size_mb:
        return total_layers

    ratio = min(0.95, max(0.18, usable_vram_mb / max(1.0, size_mb)))
    return max(8, int(total_layers * ratio))


def get_vulkan_status(model_path: Optional[Path] = None) -> VulkanDeviceInfo:
    """Возвращает полный статус подсистемы Vulkan / GPU и параметры видеопамяти."""
    lib_ok = _check_vulkan_shared_library()
    vk_summary = _parse_vulkaninfo_summary()
    total_mb, free_mb = _detect_vram_mb()

    devices: List[Dict[str, str]] = vk_summary.get("devices", [])
    primary = devices[0] if devices else {}

    device_name = primary.get("deviceName", "")
    if not device_name:
        try:
            import torch

            if torch.cuda.is_available():
                device_name = torch.cuda.get_device_name(0)
        except Exception:
            pass
    if not device_name:
        device_name = os.environ.get("VULKAN_DEVICE_NAME", "Vulkan Compatible GPU")

    api_version = primary.get("apiVersion", vk_summary.get("instance_version", "1.3+"))
    driver_info = primary.get("driverInfo", primary.get("driverName", "System Vulkan ICD"))
    device_type = primary.get("deviceType", "PHYSICAL_DEVICE_TYPE_DISCRETE_GPU")
    device_idx = int(os.environ.get("VULKAN_DEVICE", "0"))

    ctx_size = int(os.environ.get("LLM_CTX_SIZE", os.environ.get("AIRLLM_CONTEXT_WINDOW", "32768")))
    if model_path is None:
        default_airllm = BASE_DIR / "models" / "airllm_shards"
        if default_airllm.exists():
            model_path = default_airllm

    rec_layers = compute_optimal_vulkan_layers(
        model_path=model_path,
        vram_free_mb=free_mb,
        ctx_size=ctx_size,
        total_layers=48,
    )

    return VulkanDeviceInfo(
        available=lib_ok or bool(devices),
        backend="Vulkan",
        device_index=device_idx,
        device_name=device_name,
        api_version=api_version,
        driver_info=driver_info,
        device_type=device_type,
        vram_total_mb=total_mb,
        vram_free_mb=free_mb,
        recommended_gpu_layers=rec_layers,
        recommended_ctx_size=ctx_size,
        platform_os=f"{platform.system()} {platform.release()}",
        details={
            "vulkan_library_loaded": lib_ok,
            "devices_detected": len(devices),
            "ggml_vulkan_enabled": True,
            "airllm_vram_budget_gb": round(total_mb / 1024, 1),
            "model_family": "Google Gemma 4 12B Unified (W4A16)",
            "total_layers": 48,
            "max_response_tokens": 5000,
        },
    )


def detect_vulkan_gpu(default_vram_mb: int = 8192) -> VulkanDeviceInfo:
    return get_vulkan_status()


def init_vulkan_environment(model_path: Optional[Path] = None, verbose: bool = True) -> VulkanDeviceInfo:
    """
    Активирует переменные окружения Vulkan и GPU-управления памятью для AirLLM Gemma 4 12B.
    """
    os.environ.setdefault("GGML_VULKAN", "1")
    os.environ.setdefault("LLAMA_VULKAN", "1")
    os.environ.setdefault("VULKAN_DEVICE", "0")
    os.environ.setdefault("GGML_VK_VISIBLE_DEVICES", os.environ.get("VULKAN_DEVICE", "0"))
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True,max_split_size_mb:256")
    os.environ.setdefault("LLM_CTX_SIZE", "32768")
    os.environ.setdefault("AIRLLM_CONTEXT_WINDOW", "32768")
    os.environ.setdefault("AIRLLM_MAX_RESPONSE_TOKENS", "5000")

    status = get_vulkan_status(model_path=model_path)

    if verbose:
        if status.available:
            print(
                f"[VULKAN + AirLLM Gemma 4 12B] Активно: {status.device_name} "
                f"(Vulkan API {status.api_version}, Драйвер {status.driver_info}) | "
                f"VRAM: {status.vram_free_mb}/{status.vram_total_mb} МБ | "
                f"Резидентные слои GPU: {status.recommended_gpu_layers}/48 | "
                f"Окно контекста: {status.recommended_ctx_size} ток. (ответ до ~5000 ток.)"
            )
        else:
            print("[VULKAN] Библиотека Vulkan не обнаружена, используется конвейер CPU / AirLLM.")

    return status


def get_torch_device(prefer_gpu: bool = True, prefer_vulkan: bool = True) -> str:
    """
    Возвращает устройство максимального аппаратного ускорения для AirLLM / PyTorch.
    """
    try:
        import torch

        if (prefer_gpu or prefer_vulkan) and torch.cuda.is_available():
            return "cuda:0"
        if (prefer_gpu or prefer_vulkan) and hasattr(torch.backends, "vulkan") and torch.backends.vulkan.is_available():
            return "vulkan"
    except Exception:
        pass
    return "cpu"
