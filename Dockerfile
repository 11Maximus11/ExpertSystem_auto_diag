# =====================================================================
# Dockerfile для экспертной системы AutoDiag Pro AI (Django + AirLLM Qwen3.5 + Vulkan)
# Поддерживает аппаратное ускорение GPU / Vulkan и автономную послойную выгрузку AirLLM
# =====================================================================
FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONUTF8=1 \
    GGML_VULKAN=1 \
    LLAMA_VULKAN=1 \
    MAX_VRAM_MB=8192 \
    LLM_CTX_SIZE=6144 \
    AIRLLM_MODEL_ID=models/Qwen3.5-4B \
    AIRLLM_COMPRESSION=none

WORKDIR /app

# Установка системных библиотек Vulkan, драйверов Mesa/ICD и аудио/видео утилит
RUN apt-get update && apt-get install -y --no-install-recommends \
    libvulkan1 \
    vulkan-tools \
    mesa-vulkan-drivers \
    ffmpeg \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r /app/requirements.txt

COPY . /app/

RUN chmod +x /app/docker/entrypoint.sh /app/run_dev.sh || true

EXPOSE 8000 8010

ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["python", "manage.py", "runserver", "0.0.0.0:8000"]
