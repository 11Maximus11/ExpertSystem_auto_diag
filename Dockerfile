# =====================================================================
# Dockerfile для экспертной системы «ИИдеал Авто» (AIdeal Auto)
# Django + AirLLM Google Gemma 4 12B W4A16 (CUDA TensorCore int4pack + PCIe DMA)
# + Гибридный RAG v2 (BERT MiniLM + FAISS + BM25 + CrossEncoder) + Vulkan Telemetry
# =====================================================================
FROM python:3.13-slim-bookworm

LABEL org.opencontainers.image.title="AIdeal Auto (ИИдеал Авто)" \
      org.opencontainers.image.description="Autonomous AI Automotive Diagnostics Expert System (Gemma 4 12B W4A16 AirLLM + Hybrid RAG v2 + Web AR HUD)" \
      org.opencontainers.image.licenses="GPL-3.0"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONUTF8=1 \
    GGML_VULKAN=1 \
    LLAMA_VULKAN=1 \
    VULKAN_DEVICE=0 \
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility,graphics \
    PYTORCH_CUDA_ALLOC_CONF="max_split_size_mb:256" \
    MAX_VRAM_MB=auto \
    VRAM_HEADROOM_MB=1280 \
    LLM_CTX_SIZE=32768 \
    AIRLLM_CONTEXT_WINDOW=32768 \
    AIRLLM_MODEL_ID=google/gemma-4-12B-it-qat-w4a16-ct \
    AIRLLM_COMPRESSION=4bit \
    AIRLLM_TARGET_SLA_SEC=55.0 \
    HF_HOME=/app/models/.hf_cache \
    RAG_USE_NEURAL=1 \
    RAG_DEVICE=cpu \
    RAG_INCLUDE_EXTERNAL=1 \
    AUTODIAG_PRELOAD_ON_STARTUP=1 \
    DJANGO_DB_PATH=/app/db_data/db.sqlite3

WORKDIR /app

# Установка системных библиотек Vulkan, OpenMP (для FAISS), FFmpeg и утилит
RUN apt-get update && apt-get install -y --no-install-recommends \
    libvulkan1 \
    vulkan-tools \
    mesa-vulkan-drivers \
    libgomp1 \
    ffmpeg \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r /app/requirements.txt

COPY . /app/

RUN mkdir -p /app/models /app/db_data /app/staticfiles && \
    sed -i 's/\r$//' /app/docker/entrypoint.sh /app/run_dev.sh && \
    chmod +x /app/docker/entrypoint.sh /app/run_dev.sh

ENV HF_TOKEN=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

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=180s --retries=5 \
    CMD curl -fsS http://127.0.0.1:8000/api/settings/ || exit 1

ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["gunicorn", "-c", "gunicorn.conf.py", "autodiag_project.wsgi:application"]
