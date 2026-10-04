"""
Кроссплатформенный модуль инициализации и управления ускорением Vulkan (Windows / Linux).
Заменяет привязку к CUDA на стек Vulkan (GGML_VULKAN / PyTorch Vulkan / AirLLM Offload)
с оптимизацией под видеокарты с 8 ГБ видеопамяти (например, RTX 3050 8GB).
"""

import ctypes
import os
import platform
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Dict, Any, List, Optional

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
    details: Dict[str, Any]

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def _check_vulkan_shared_library() -> bool:
    """Проверяет наличие системной библиотеки среды выполнения Vulkan (Windows / Linux)."""
    system_name = platform.system().lower()
    lib_names = ["vulkan-1.dll"] if system_name == "windows" else ["libvulkan.so.1", "libvulkan.so"]
    for lib_name in lib_names:
        try:
            ctypes.CDLL(lib_name)
            return True
        except OSError:
            continue
    return False


def _parse_vulkaninfo_summary() -> Dict[str, Any]:
    """Извлекает информацию об устройствах из утилиты vulkaninfo --summary."""
    info: Dict[str, Any] = {
        "instance_version": "Unknown",
        "devices": [],
    }
    vulkaninfo_bin = shutil.which("vulkaninfo")
    if not vulkaninfo_bin:
        return info

    try:
        proc = subprocess.run(
            [vulkaninfo_bin, "--summary"],
            capture_output=True,
            text=True,
            timeout=6,
            encoding="utf-8",
            errors="replace",
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
    Определяет общий и свободный объем видеопамяти (в МБ).
    По умолчанию ориентируется на целевой профиль 8192 МБ (8 ГБ VRAM).
    """
    default_total = int(os.environ.get("MAX_VRAM_MB", "8192"))
    default_free = int(os.environ.get("FREE_VRAM_MB", "6800"))

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
            )
            if proc.returncode == 0 and proc.stdout.strip():
                first_line = proc.stdout.strip().splitlines()[0]
                parts = [p.strip() for p in first_line.split(",")]
                if len(parts) >= 2:
                    return int(float(parts[0])), int(float(parts[1]))
        except Exception:
            pass

    return default_total, default_free


def compute_optimal_vulkan_layers(
    model_path: Optional[Path] = None,
    vram_free_mb: int = 6800,
    ctx_size: int = 2048,
    total_layers: int = 42,
) -> int:
    """
    Рассчитывает безопасное количество слоев для выгрузки в Vulkan на 8 ГБ VRAM,
    чтобы избежать переполнения видеопамяти (OOM) при активном контексте.
    """
    env_layers = os.environ.get("VULKAN_GPU_LAYERS")
    if env_layers is not None:
        try:
            return int(env_layers)
        except ValueError:
            pass

    if model_path and model_path.exists():
        size_mb = model_path.stat().st_size / (1024 * 1024)
    else:
        size_mb = 6800.0  # ~7 ГБ для Q4_K_M 12B

    kv_cache_mb = max(384.0, (ctx_size / 2048.0) * 512.0)
    usable_vram_mb = max(1024.0, vram_free_mb - kv_cache_mb - 450.0)

    if usable_vram_mb >= size_mb:
        return -1  # Все слои помещаются в память Vulkan

    ratio = min(0.95, max(0.15, usable_vram_mb / size_mb))
    return max(8, int(total_layers * ratio))


def get_vulkan_status(model_path: Optional[Path] = None) -> VulkanDeviceInfo:
    """Возвращает полный статус подсистемы Vulkan и параметры видеокарты."""
    lib_ok = _check_vulkan_shared_library()
    vk_summary = _parse_vulkaninfo_summary()
    total_mb, free_mb = _detect_vram_mb()

    devices: List[Dict[str, str]] = vk_summary.get("devices", [])
    primary = devices[0] if devices else {}

    device_name = primary.get("deviceName", os.environ.get("VULKAN_DEVICE_NAME", "Vulkan Compatible GPU (8GB Profile)"))
    api_version = primary.get("apiVersion", vk_summary.get("instance_version", "1.3+"))
    driver_info = primary.get("driverInfo", primary.get("driverName", "System Vulkan ICD"))
    device_type = primary.get("deviceType", "PHYSICAL_DEVICE_TYPE_DISCRETE_GPU")
    device_idx = int(os.environ.get("VULKAN_DEVICE", "0"))

    ctx_size = int(os.environ.get("LLM_CTX_SIZE", "2048"))
    if model_path is None:
        default_gguf = BASE_DIR / "models" / "gemma-4-12b-it-Q4_K_M.gguf"
        if default_gguf.exists():
            model_path = default_gguf

    rec_layers = compute_optimal_vulkan_layers(
        model_path=model_path,
        vram_free_mb=free_mb,
        ctx_size=ctx_size,
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
        },
    )


def init_vulkan_environment(model_path: Optional[Path] = None, verbose: bool = True) -> VulkanDeviceInfo:
    """
    Активирует переменные окружения для работы llama.cpp / ggml / PyTorch через Vulkan
    и отключает жесткую привязку к проприетарному стеку CUDA.
    """
    os.environ.setdefault("GGML_VULKAN", "1")
    os.environ.setdefault("LLAMA_VULKAN", "1")
    os.environ.setdefault("VULKAN_DEVICE", "0")
    os.environ.setdefault("GGML_VK_VISIBLE_DEVICES", os.environ.get("VULKAN_DEVICE", "0"))
    # Ограничение буфера под 8 ГБ видеопамяти
    os.environ.setdefault("MAX_VRAM_MB", "8192")
    os.environ.setdefault("LLM_CTX_SIZE", "2048")

    status = get_vulkan_status(model_path=model_path)

    if verbose:
        if status.available:
            print(
                f"[VULKAN] Ускорение Vulkan активно: {status.device_name} "
                f"(API {status.api_version}, Драйвер {status.driver_info}) | "
                f"VRAM: {status.vram_free_mb}/{status.vram_total_mb} МБ | "
                f"Рекомендуемые слои GPU: {status.recommended_gpu_layers} | Окно контекста: {status.recommended_ctx_size}"
            )
        else:
            print("[VULKAN] Библиотека Vulkan не обнаружена, используется программный конвейер CPU / AirLLM.")

    return status


def get_torch_device(prefer_vulkan: bool = True) -> str:
    """
    Определяет устройство для PyTorch без использования CUDA (приоритет Vulkan, затем CPU,
    чтобы не занимать 8 ГБ видеопамяти вспомогательными моделями во время работы основной LLM).
    """
    try:
        import torch  # type: ignore

        if prefer_vulkan and hasattr(torch.backends, "vulkan") and torch.backends.vulkan.is_available():
            return "vulkan"
    except Exception:
        pass
    return "cpu"
