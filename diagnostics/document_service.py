"""
Сервис обработки прикреплённых пользователем файлов в системе ИИдеал Авто (AIdeal Auto):
- Фотографии поломки / приборной панели / узлов авто (включая кадры с веб-камеры и AR-очков)
- Аудиозаписи (.wav, .mp3, .ogg, .m4a, .flac, .webm, .aac) — передаются напрямую в нативный аудиоэнкодер Gemma 4 12B (embed_audio)
- Технические документы, логи OBD-II сканеров (.txt, .log, .obd, .json, .csv, .tsv, .pdf, .docx, .xml, .html, .md, .ini, .yaml)
Все пути сохраняются строго относительно MEDIA_ROOT.
"""

import base64
import csv
import io
import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from PIL import Image, ImageStat


AUDIO_EXTENSIONS = {".wav", ".mp3", ".ogg", ".m4a", ".flac", ".webm", ".aac", ".opus", ".wma"}
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tiff", ".tif", ".avif", ".jfif"}


def extract_dtc_codes(text: str) -> List[str]:
    """Извлекает уникальные коды ошибок стандарта OBD-II (P/C/B/Uxxxx) из произвольного текста."""
    found = re.findall(r"\b([PCBU][0-9A-F]{4})\b", (text or "").upper())
    return list(dict.fromkeys(found))


def _extract_xlsx_text(file_bytes: bytes) -> str:
    """Извлекает текстовые таблицы из .xlsx (Office Open XML) без внешних тяжёлых зависимостей."""
    import xml.etree.ElementTree as ET
    import zipfile

    rows_out: List[str] = []
    with zipfile.ZipFile(io.BytesIO(file_bytes)) as zf:
        shared_strings: List[str] = []
        if "xl/sharedStrings.xml" in zf.namelist():
            root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
            for si in root.iter():
                if si.tag.endswith("}si") or si.tag == "si":
                    texts = [
                        t.text or ""
                        for t in si.iter()
                        if (t.tag.endswith("}t") or t.tag == "t") and t.text
                    ]
                    shared_strings.append("".join(texts))

        sheet_files = sorted(
            name for name in zf.namelist() if name.startswith("xl/worksheets/sheet") and name.endswith(".xml")
        )
        for sheet_name in sheet_files[:4]:
            root = ET.fromstring(zf.read(sheet_name))
            for row_el in root.iter():
                if row_el.tag.endswith("}row") or row_el.tag == "row":
                    row_vals: List[str] = []
                    for cell in row_el:
                        if not (cell.tag.endswith("}c") or cell.tag == "c"):
                            continue
                        cell_type = cell.attrib.get("t", "")
                        val_text = ""
                        for child in cell:
                            if child.tag.endswith("}v") or child.tag == "v":
                                val_text = (child.text or "").strip()
                            elif child.tag.endswith("}is") or child.tag == "is":
                                val_text = "".join(
                                    (t.text or "") for t in child.iter() if t.text
                                ).strip()
                        if cell_type == "s" and val_text.isdigit():
                            idx = int(val_text)
                            if 0 <= idx < len(shared_strings):
                                val_text = shared_strings[idx]
                        if val_text:
                            row_vals.append(val_text)
                    if row_vals:
                        rows_out.append(" | ".join(row_vals))
                    if len(rows_out) >= 120:
                        break
    return "\n".join(rows_out)


MAX_FULL_DOC_CHARS = 25000


def _process_extracted_image_bytes(raw_b: bytes, max_dim: int = 1024) -> Optional[Tuple[bytes, str]]:
    """
    Проверяет байты изображения, фильтрует мелкие иконки/разделители и возвращает (jpeg_bytes, data_url).
    """
    if not raw_b or len(raw_b) < 600:
        return None
    try:
        img = Image.open(io.BytesIO(raw_b)).convert("RGB")
        w, h = img.size
        if w < 48 or h < 48:
            return None
        if max(w, h) > max_dim:
            ratio = max_dim / float(max(w, h))
            img = img.resize((int(w * ratio), int(h * ratio)), Image.Resampling.LANCZOS)
        out_buf = io.BytesIO()
        img.save(out_buf, format="JPEG", quality=85)
        jpeg_bytes = out_buf.getvalue()
        b64 = base64.b64encode(jpeg_bytes).decode("utf-8")
        return jpeg_bytes, f"data:image/jpeg;base64,{b64}"
    except Exception:
        return None


def _smart_sample_document_text(text: str, filename: str, max_total_chars: int = 24000) -> str:
    """
    Интеллектуальная диагностическая выборка содержимого для длинных документов:
    1. Начальный сегмент (заголовки, инициализация протокола, VIN, системный статус).
    2. Фильтрация строк со всеми кодами ошибок DTC (P/C/B/Uxxxx), ключевыми словами сбоев,
       аварийными статусами и телеметрией.
    3. Финальный сегмент (последние записи журнала с актуальным состоянием).
    """
    lines = text.splitlines()
    total_len = len(text)

    # 1. Заголовок документа (до 4500 симв.)
    head_lines: List[str] = []
    head_chars = 0
    for line in lines:
        if head_chars + len(line) + 1 > 4500:
            break
        head_lines.append(line)
        head_chars += len(line) + 1

    # 2. Фильтрация строк с ошибками и телеметрией из всего документа
    error_pattern = re.compile(
        r"(?:[PCBU][0-9A-F]{4}\b|error|fault|dtc|warning|warn|fail|misfire|leak|voltage|pressure|temp|sensor|status:|code:|ошибк|сбой|неисправн|авари|обрыв|замыкан|отказ|давлен|температур|пропуск|напряжен)",
        re.IGNORECASE,
    )

    diagnostic_lines: List[str] = []
    diag_chars = 0
    head_set = set(range(len(head_lines)))
    tail_start_idx = max(len(lines) - 80, len(head_lines))

    for idx, line in enumerate(lines):
        if idx in head_set or idx >= tail_start_idx:
            continue
        stripped = line.strip()
        if not stripped:
            continue
        if error_pattern.search(stripped):
            diagnostic_lines.append(stripped)
            diag_chars += len(stripped) + 1
            if diag_chars >= 14000:
                diagnostic_lines.append("... [дополнительные строки ошибок опущены для лимита контекста] ...")
                break

    # 3. Хвост документа (до 4500 симв.)
    tail_lines: List[str] = []
    tail_chars = 0
    for line in reversed(lines):
        if tail_chars + len(line) + 1 > 4500:
            break
        tail_lines.insert(0, line)
        tail_chars += len(line) + 1

    dtc_found = extract_dtc_codes(text)
    header_banner = (
        f"[ВНИМАНИЕ: Документ {filename} превышает лимит контекста ({total_len:,} симв.). "
        f"Выполнена интеллектуальная диагностическая выборка: начальные параметры, "
        f"все строки с ошибками/DTC ({len(dtc_found)} кодов: {', '.join(dtc_found[:8]) or 'нет'}) и свежие события]."
    )

    parts = [
        header_banner,
        "--- НАЧАЛО ДОКУМЕНТА (ИНИЦИАЛИЗАЦИЯ И СТАТУС) ---",
        "\n".join(head_lines),
    ]
    if diagnostic_lines:
        parts.extend([
            "--- СТРОКИ С ОШИБКАМИ, DTC И КЛЮЧЕВОЙ ТЕЛЕМЕТРИЕЙ ---",
            "\n".join(diagnostic_lines),
        ])
    parts.extend([
        "--- ПОСЛЕДНИЕ СОБЫТИЯ ЖУРНАЛА (ФИНАЛЬНЫЙ СРЕЗ) ---",
        "\n".join(tail_lines),
    ])

    return "\n\n".join(parts)


def parse_uploaded_document(file_bytes: bytes, filename: str) -> Dict[str, Any]:
    """
    Извлекает текстовое содержимое, коды ошибок, встроенные изображения и ключевые параметры телеметрии
    из прикреплённого документа любого поддерживаемого формата:
    .txt, .log, .obd, .json, .csv, .tsv, .pdf, .docx, .xlsx, .xml, .html, .md, .ini, .yaml, .rtf,
    а также декодирует аудиофайлы в 16 кГц float32 массив для прямой подачи в Gemma 4 12B.

    Если размер текста документа укладывается в контекстный бюджет (<=25000 символов),
    текст отправляется в модель полностью без сокращений (processing_mode='full').
    Если документ превышает лимит — выполняется интеллектуальная выборка ошибок, заголовков и хвоста
    (processing_mode='smart_sampled').
    Все встроенные в документ изображения (PDF, DOCX) извлекаются, преобразуются в превью
    и передаются в мультимодальный энкодер Gemma 4 Vision.
    """
    ext = Path(filename or "document.txt").suffix.lower()
    extracted_text = ""
    audio_waveform_16k = None
    embedded_images_bytes: List[bytes] = []
    embedded_images_data_urls: List[str] = []

    try:
        if ext in AUDIO_EXTENSIONS:
            from .voice_service import process_voice_input

            voice_res = process_voice_input(
                audio_bytes=file_bytes,
                filename=filename,
                voice_mode="direct_audio",
            )
            audio_waveform_16k = voice_res.get("audio_waveform_16k")
            dur = voice_res.get("duration_sec", 0.0)
            extracted_text = (
                f"[Аудиозапись {filename} ({dur} с) передана напрямую в мультимодальный аудиовход Gemma 4 12B (embed_audio)]"
                if voice_res.get("audio_attached_to_model")
                else f"[Аудиофайл {filename}: не удалось декодировать аудиопоток]"
            )
        elif ext in IMAGE_EXTENSIONS:
            img_info = analyze_image_bytes(file_bytes, filename=filename)
            if img_info.get("raw_jpeg_bytes"):
                embedded_images_bytes.append(img_info["raw_jpeg_bytes"])
            if img_info.get("data_url"):
                embedded_images_data_urls.append(img_info["data_url"])
            extracted_text = f"[Изображение {filename}: {img_info.get('visual_summary', '')}]"
        elif ext in {".txt", ".log", ".md", ".obd", ".ini", ".cfg", ".conf", ".yaml", ".yml"}:
            extracted_text = file_bytes.decode("utf-8", errors="replace")
        elif ext in {".xml", ".html", ".htm", ".rtf"}:
            raw_str = file_bytes.decode("utf-8", errors="replace")
            extracted_text = re.sub(r"<[^>]+>", " ", raw_str)
            extracted_text = re.sub(r"\s+", " ", extracted_text).strip()
        elif ext == ".json":
            data = json.loads(file_bytes.decode("utf-8", errors="replace"))
            extracted_text = json.dumps(data, ensure_ascii=False, indent=2)
        elif ext in {".csv", ".tsv"}:
            decoded = file_bytes.decode("utf-8", errors="replace")
            delimiter = "\t" if ext == ".tsv" else ","
            reader = csv.reader(io.StringIO(decoded), delimiter=delimiter)
            rows = [", ".join(row) for _, row in zip(range(300), reader)]
            extracted_text = "\n".join(rows)
        elif ext == ".xlsx":
            extracted_text = _extract_xlsx_text(file_bytes)
        elif ext == ".pdf":
            from pypdf import PdfReader

            reader = PdfReader(io.BytesIO(file_bytes))
            pages_text = []
            for page in reader.pages[:40]:
                pages_text.append(page.extract_text() or "")
                try:
                    if len(embedded_images_bytes) < 6 and hasattr(page, "images"):
                        for img_file in page.images:
                            if getattr(img_file, "data", None):
                                res = _process_extracted_image_bytes(img_file.data)
                                if res:
                                    embedded_images_bytes.append(res[0])
                                    embedded_images_data_urls.append(res[1])
                                    if len(embedded_images_bytes) >= 6:
                                        break
                except Exception:
                    pass
            extracted_text = "\n".join(pages_text)
        elif ext == ".docx":
            import zipfile
            import docx

            doc = docx.Document(io.BytesIO(file_bytes))
            paragraphs = [p.text for p in doc.paragraphs if p.text.strip()]
            for table in doc.tables[:10]:
                for row in table.rows[:40]:
                    row_txt = " | ".join(cell.text.strip() for cell in row.cells if cell.text.strip())
                    if row_txt:
                        paragraphs.append(row_txt)
            extracted_text = "\n".join(paragraphs)
            try:
                with zipfile.ZipFile(io.BytesIO(file_bytes)) as zf:
                    for name in zf.namelist():
                        if name.startswith("word/media/") and Path(name).suffix.lower() in IMAGE_EXTENSIONS:
                            res = _process_extracted_image_bytes(zf.read(name))
                            if res:
                                embedded_images_bytes.append(res[0])
                                embedded_images_data_urls.append(res[1])
                                if len(embedded_images_bytes) >= 6:
                                    break
            except Exception:
                pass
        else:
            extracted_text = file_bytes.decode("utf-8", errors="replace")
    except Exception as exc:
        extracted_text = f"[Предупреждение при разборе файла {filename}: {exc}]"

    dtc_codes = extract_dtc_codes(extracted_text)

    telemetry_pairs = re.findall(
        r"([a-zA-Zа-яА-Я0-9_\-]+)\s*[=:]\s*([0-9]+(?:\.[0-9]+)?\s*(?:°C|rpm|В|V|кПа|psi|bar|%|мм/с|mm/s|кВт|kW|Нм|Nm)?)",
        extracted_text,
    )
    key_metrics = [f"{k}={v}" for k, v in telemetry_pairs[:12]]

    char_len = len(extracted_text)
    is_fully_processed = char_len <= MAX_FULL_DOC_CHARS
    processing_mode = "full" if is_fully_processed else "smart_sampled"

    if is_fully_processed:
        llm_ready_text = extracted_text
    else:
        llm_ready_text = _smart_sample_document_text(extracted_text, filename=filename)

    preview_excerpt = re.sub(r"\s+", " ", extracted_text[:400]).strip()
    snippet = llm_ready_text.strip()
    if len(snippet) > 2500:
        snippet = snippet[:2500] + "\n...[документ сокращён для экономии окна контекста]..."

    return {
        "filename": filename,
        "extension": ext,
        "text_snippet": snippet,
        "extracted_text": extracted_text,
        "llm_ready_text": llm_ready_text,
        "preview_excerpt": preview_excerpt,
        "is_fully_processed": is_fully_processed,
        "processing_mode": processing_mode,
        "raw_excerpt": snippet[:1600],
        "summary": f"[{filename}] Коды: {', '.join(dtc_codes) if dtc_codes else 'нет'}. {snippet[:500]}",
        "detected_dtc_codes": dtc_codes,
        "extracted_codes": dtc_codes,
        "key_metrics": key_metrics,
        "char_length": char_len,
        "audio_waveform_16k": audio_waveform_16k,
        "embedded_images_bytes": embedded_images_bytes,
        "embedded_images_data_urls": embedded_images_data_urls,
    }


def analyze_image_bytes(
    image_bytes: bytes,
    filename: str = "capture.jpg",
    abs_path: str = "",
) -> Dict[str, Any]:
    """
    Выполняет предварительный визуально-технический анализ изображения (разрешение, экспозиция,
    цветовые доминанты индикаторов приборной панели / следов перегрева или подтёков / обрыва проводки)
    и готовит сжатый JPEG-поток и data URL base64 для прямой передачи в мультимодальную модель Gemma 4 12B (embed_vision).
    """
    try:
        img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        width, height = img.size

        max_dim = 1024
        if max(width, height) > max_dim:
            ratio = max_dim / float(max(width, height))
            resized = img.resize((int(width * ratio), int(height * ratio)), Image.Resampling.LANCZOS)
        else:
            resized = img

        stat = ImageStat.Stat(resized)
        r_mean, g_mean, b_mean = stat.mean
        r_std, g_std, b_std = stat.stddev
        brightness = (0.299 * r_mean + 0.587 * g_mean + 0.114 * b_mean) / 255.0

        small = resized.resize((128, 128))
        pixels = list(small.getdata())
        amber_pixels = 0
        red_pixels = 0
        dark_pixels = 0
        metallic_pixels = 0

        for r, g, b in pixels:
            if r > 190 and 100 <= g <= 190 and b < 70:
                amber_pixels += 1
            elif r > 190 and g < 65 and b < 65:
                red_pixels += 1
            elif r < 35 and g < 35 and b < 35:
                dark_pixels += 1
            elif abs(r - g) < 18 and abs(g - b) < 18 and 60 <= r <= 185:
                metallic_pixels += 1

        total_px = len(pixels)
        amber_ratio = amber_pixels / total_px
        red_ratio = red_pixels / total_px
        dark_ratio = dark_pixels / total_px
        metallic_ratio = metallic_pixels / total_px

        visual_clues: List[str] = []
        if dark_ratio > 0.45 and (amber_ratio > 0.004 or red_ratio > 0.004):
            visual_clues.append(
                "Вероятно фото приборной панели в тёмном окружении с активными сигнальными индикаторами"
            )
            if red_ratio > 0.004:
                visual_clues.append(
                    "Обнаружено красное свечение аварийного индикатора (давление масла, тормозная система, перегрев или заряд АКБ)"
                )
            if amber_ratio > 0.004:
                visual_clues.append(
                    "Обнаружено жёлто-оранжевое свечение предупреждающего индикатора (Check Engine / MIL, ABS, ESP или трансмиссия)"
                )
        elif metallic_ratio > 0.30:
            visual_clues.append(
                "Обнаружены металлические поверхности агрегатов, разъёмов или жгутов подкапотного пространства"
            )
        else:
            visual_clues.append(
                f"Фотография узла/проводки/детали автомобиля ({width}x{height} пикс., яркость {int(brightness * 100)}%)"
            )

        out_buf = io.BytesIO()
        resized.save(out_buf, format="JPEG", quality=85)
        jpeg_bytes = out_buf.getvalue()
        b64_str = base64.b64encode(jpeg_bytes).decode("utf-8")
        data_url = f"data:image/jpeg;base64,{b64_str}"

        return {
            "filename": filename,
            "abs_path": str(abs_path or ""),
            "width": width,
            "height": height,
            "brightness": round(brightness, 2),
            "contrast": round((r_std + g_std + b_std) / 3.0, 1),
            "visual_clues": visual_clues,
            "visual_summary": "; ".join(visual_clues),
            "data_url": data_url,
            "data_uri": data_url,
            "raw_jpeg_bytes": jpeg_bytes,
        }
    except Exception as exc:
        return {
            "filename": filename,
            "abs_path": str(abs_path or ""),
            "error": str(exc),
            "visual_clues": ["Изображение прикреплено для визуального осмотра"],
            "visual_summary": "Изображение прикреплено для визуального осмотра",
            "data_url": "",
            "data_uri": "",
            "raw_jpeg_bytes": image_bytes or b"",
        }


analyze_diagnostic_image = analyze_image_bytes
