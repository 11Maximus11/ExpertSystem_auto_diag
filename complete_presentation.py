# -*- coding: utf-8 -*-
"""
Скрипт для полного дооформления презентации проекта «ИИдеал Авто» (AIdeal Auto)
для акселерационной программы Платформы университетского технологического
предпринимательства (ПУТП / Платформа НТИ).
Стандартизация типографики: основной шрифт Calibri, размер ~13-14 pt,
настоящая функциональная схема по ГОСТ 19.701-90, выверенная контрастность.
"""

import sys
import io
import os
from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.enum.shapes import MSO_SHAPE

sys.stdout.reconfigure(encoding='utf-8')

SRC_PATH = r"D:\Downloads\Shablon_prezentatsii_2_0_2_1 (1).pptx"
DST_PATH = r"D:\Downloads\ИИдеал_Авто_Презентация_Акселератор_НТИ.pptx"
DIAG_IMG_PATH = r"C:\Users\maxxf\.gemini\antigravity\brain\42432578-c9a8-4b4f-b2ab-11e021ad4c01\architecture_gost.png"

prs = Presentation(SRC_PATH)
print("Исходное количество слайдов в шаблоне:", len(prs.slides))

FONT_TITLE = "Calibri"
FONT_BODY = "Calibri"

COLOR_TITLE = RGBColor(15, 23, 42)        # #0F172A
COLOR_TEXT = RGBColor(30, 41, 59)         # #1E293B
COLOR_MUTED = RGBColor(71, 85, 105)       # #475569
COLOR_PURPLE = RGBColor(124, 58, 237)     # #7C3AED
COLOR_ORANGE = RGBColor(234, 88, 12)      # #EA580C
COLOR_LIGHT_BG = RGBColor(248, 250, 252)  # #F8FAFC
COLOR_WHITE = RGBColor(255, 255, 255)
COLOR_LIGHT_SLATE = RGBColor(241, 245, 249) # #F1F5F9

def style_para(para, text, font_size=13.5, bold=False, color=COLOR_TEXT, align=PP_ALIGN.LEFT, space_after=Pt(4)):
    para.text = text
    para.alignment = align
    para.space_after = space_after
    for r in para.runs:
        r.font.name = FONT_BODY
        r.font.size = Pt(font_size)
        r.font.bold = bold
        r.font.color.rgb = color

# ==============================================================================
# 1. ТИТУЛЬНЫЙ СЛАЙД (Slide 1)
# ==============================================================================
print("Обработка Слайда 1 (Титульный)...")
s1 = prs.slides[0]
for sh in s1.shapes:
    if sh.has_text_frame:
        txt = sh.text_frame.text.strip()
        # Заголовок проекта
        if "«ИИдеал Авто»" in txt or "Экспертная ИИ-система" in txt:
            sh.left = Inches(0.65)
            sh.top = Inches(1.8)
            sh.width = Inches(11.5)
            sh.text_frame.clear()
            sh.text_frame.word_wrap = True
            p = sh.text_frame.paragraphs[0]
            style_para(p, "«ИИдеал Авто» (AIdeal Auto) — Экспертная ИИ-система\nавтодиагностики и пошагового ремонта автомобиля", font_size=26, bold=True, color=COLOR_WHITE, space_after=Pt(0))
        # Контакты и автор
        elif "ФИО, контакты, организация" in txt or "Подорожный" in txt:
            sh.left = Inches(0.65)
            sh.top = Inches(4.75)
            sh.width = Inches(8.5)
            sh.height = Inches(2.3)
            
            tf = sh.text_frame
            tf.clear()
            tf.word_wrap = True
            
            p1 = tf.paragraphs[0]
            style_para(p1, "Подорожный Максим Евгеньевич", font_size=15.5, bold=True, color=COLOR_WHITE, space_after=Pt(3))
            
            p2 = tf.add_paragraph()
            style_para(p2, "Студент 4 курса направления «Программная инженерия» (гр. ПО-32б)", font_size=13.5, bold=False, color=COLOR_LIGHT_SLATE, space_after=Pt(2))
            
            p3 = tf.add_paragraph()
            style_para(p3, "ФГБОУ ВО «Юго-Западный государственный университет» (ЮЗГУ), г. Курск", font_size=13.5, bold=False, color=COLOR_LIGHT_SLATE, space_after=Pt(4))
            
            p4 = tf.add_paragraph()
            style_para(p4, "Контакты: maxxf05@gmail.com | Telegram: @maxxf05", font_size=13.5, bold=True, color=RGBColor(251, 146, 60), space_after=Pt(0))

# ==============================================================================
# СЛАЙД 2: ПРОБЛЕМА (Стандартизация шрифта до 14 pt Calibri)
# ==============================================================================
print("Обработка Слайда 2 (Проблема)...")
s2 = prs.slides[1]
for sh in s2.shapes:
    if sh.has_text_frame:
        txt = sh.text_frame.text.strip()
        if "ПРОБЛЕМА" in txt:
            sh.text_frame.paragraphs[0].font.name = FONT_TITLE
            sh.text_frame.paragraphs[0].font.size = Pt(24)
            sh.text_frame.paragraphs[0].font.bold = True
        elif "Система решает проблему" in txt:
            sh.top = Inches(1.5)
            sh.width = Inches(11.5)
            tf = sh.text_frame
            tf.clear()
            tf.word_wrap = True
            
            p0 = tf.paragraphs[0]
            style_para(p0, "Система решает острую проблему двух взаимосвязанных целевых групп потребителей:", font_size=14, bold=True, color=COLOR_TITLE, space_after=Pt(6))
            
            p1 = tf.add_paragraph()
            style_para(p1, "1. Владельцы подержанных автомобилей (52,8 млн авто в РФ, из них 72% старше 10 лет):", font_size=14, bold=True, color=COLOR_PURPLE, space_after=Pt(2))
            p1_sub = tf.add_paragraph()
            style_para(p1_sub, "Автовладельцы стремятся самостоятельно обслуживать машину или точно понимать причину неисправности, но не имеют инженерных знаний. Поездка к официальному дилеру экономически нецелесообразна (нормо-час 4 000–6 000 ₽), а в гаражных сервисах высок риск навязанного ремонта и неквалифицированной замены исправных узлов.", font_size=13.5, bold=False, color=COLOR_TEXT, space_after=Pt(8))
            
            p2 = tf.add_paragraph()
            style_para(p2, "2. Частные мастера-диагносты и малые независимые СТО (32,1% рынка автосервисов):", font_size=14, bold=True, color=COLOR_PURPLE, space_after=Pt(2))
            p2_sub = tf.add_paragraph()
            style_para(p2_sub, "Специалисты лишены доступа к зарубежным профессиональным базам данных (Autodata, Bosch ESI) из-за санкций и неподъемной стоимости подписки. Вынуждены диагностировать «на ощупь», тратя до 2–3 часов на поиск плавающих неисправностей электроники и теряя клиентов.", font_size=13.5, bold=False, color=COLOR_TEXT, space_after=Pt(0))

# ==============================================================================
# СЛАЙД 3: РЕШЕНИЕ (Стандартизация шрифта до 14 pt Calibri вместо 24 pt)
# ==============================================================================
print("Обработка Слайда 3 (Решение)...")
s3 = prs.slides[2]
for sh in s3.shapes:
    if sh.has_text_frame:
        txt = sh.text_frame.text.strip()
        if "РЕШЕНИЕ" in txt:
            sh.text_frame.paragraphs[0].font.name = FONT_TITLE
            sh.text_frame.paragraphs[0].font.size = Pt(24)
            sh.text_frame.paragraphs[0].font.bold = True
        elif "ИИдеал Авто" in txt:
            sh.top = Inches(1.5)
            sh.width = Inches(11.5)
            tf = sh.text_frame
            tf.clear()
            tf.word_wrap = True
            
            p1 = tf.paragraphs[0]
            style_para(p1, "«ИИдеал Авто» — автономная мультимодальная экспертная система автодиагностики, трансформирующая комплекс первичных симптомов в верифицированный пошаговый чеклист ремонта.", font_size=14, bold=True, color=COLOR_TITLE, space_after=Pt(8))
            
            p2 = tf.add_paragraph()
            style_para(p2, "• Принцип работы «от симптома к причине»:", font_size=14, bold=True, color=COLOR_PURPLE, space_after=Pt(2))
            p2_sub = tf.add_paragraph()
            style_para(p2_sub, "В отличие от традиционных автосканеров, работающих по принципу «от кода к коду», система анализирует комплекс разнородных данных: текст жалоб автовладельца, спектрограмму аудиозаписи шума ДВС (16 кГц), макрофото узлов и логи телеметрии шины CAN / OBD-II.", font_size=13.5, bold=False, color=COLOR_TEXT, space_after=Pt(8))
            
            p3 = tf.add_paragraph()
            style_para(p3, "• Готовая структурированная диагностическая карта:", font_size=14, bold=True, color=COLOR_PURPLE, space_after=Pt(2))
            p3_sub = tf.add_paragraph()
            style_para(p3_sub, "Пользователь получает не просто расшифровку кода DTC, а наглядный интерактивный алгоритм: последовательность проверки узлов, эталонные диапазоны замеров мультиметром (В, Ом), регламентные моменты затяжки (Н·м), перечень специнструмента и артикулы необходимых запчастей.", font_size=13.5, bold=False, color=COLOR_TEXT, space_after=Pt(0))

# ==============================================================================
# СЛАЙД 4: ТЕХНОЛОГИЧЕСКОЕ ЯДРО (Стандартизация шрифта до 13.5-14 pt)
# ==============================================================================
print("Обработка Слайда 4 (Технологическое ядро)...")
s4 = prs.slides[3]
for sh in s4.shapes:
    if sh.has_text_frame:
        txt = sh.text_frame.text.strip()
        if "ТЕХНОЛОГИЧЕСКОЕ ЯДРО" in txt:
            sh.text_frame.paragraphs[0].font.name = FONT_TITLE
            sh.text_frame.paragraphs[0].font.size = Pt(24)
            sh.text_frame.paragraphs[0].font.bold = True
        elif "гибридная ИИ-система" in txt:
            sh.top = Inches(1.4)
            sh.width = Inches(11.8)
            tf = sh.text_frame
            tf.clear()
            tf.word_wrap = True
            
            p0 = tf.paragraphs[0]
            style_para(p0, "«ИИдеал Авто» функционирует локально на оборудовании пользователя без передачи данных в облако. Архитектура подтверждена исходным кодом проекта:", font_size=13.5, bold=True, color=COLOR_TITLE, space_after=Pt(6))
            
            items = [
                ("1. Гибридный RAG-поиск:", "Двухэтапная система извлечения знаний: семантический Bi-Encoder (paraphrase-multilingual-MiniLM-L12-v2 + FAISS IndexFlatIP) + лексический BM25Okapi с символьными триграммами и Cross-Encoder реранкером (Recall@3 = 100%, время 4.5 мс)."),
                ("2. Доменная адаптация под износ авто:", "Алгоритмический бустинг точных кодов DTC (x2.5) и динамический весовой коэффициент износа: (100 - health_index) / 200, приоритизирующий старение узлов на авто старше 7–10 лет."),
                ("3. Послойный инференс AirLLM (Google Gemma 4 12B Unified):", "Послойная загрузка 48 декодер-слоев квантованной модели (W4A16 QAT) с распределением между VRAM GPU и DMA Pinned RAM. Обеспечивает запуск LLM 12B на потребительских GPU (RTX 3050) без риска OOM."),
                ("4. Прямой мультимодальный процессинг:", "Обработка аудио без промежуточной транскрипции через PyAV/FFmpeg (Direct Audio 16 кГц float32), Vision-проектор фото дефектов, парсеры мануалов ТО (PDF, DOCX, XLSX) и прямая интеграция с шиной CAN/OBD-II.")
            ]
            for title, desc in items:
                p = tf.add_paragraph()
                p.space_after = Pt(4)
                r1 = p.add_run()
                r1.text = title + " "
                r1.font.name = FONT_BODY
                r1.font.size = Pt(13.5)
                r1.font.bold = True
                r1.font.color.rgb = COLOR_PURPLE
                
                r2 = p.add_run()
                r2.text = desc
                r2.font.name = FONT_BODY
                r2.font.size = Pt(13)
                r2.font.bold = False
                r2.font.color.rgb = COLOR_TEXT

# ==============================================================================
# 2. ВСТАВКА НОВОГО СЛАЙДА: АРХИТЕКТУРА ПО ГОСТ (Слайд 4.1 / 5)
# ==============================================================================
print("Создание Слайда Архитектуры по ГОСТ (Слайд 4.1)...")
new_slide = prs.slides.add_slide(prs.slide_layouts[4]) # Blank layout

# Копируем декоративные изображения из Слайда 4 (шапка платформы НТИ и логотипы)
for sh in s4.shapes:
    if sh.shape_type == 13: # Picture
        new_slide.shapes.add_picture(io.BytesIO(sh.image.blob), sh.left, sh.top, sh.width, sh.height)

# Заголовок слайда - чистый белый контрастный цвет!
title_box = new_slide.shapes.add_textbox(Emu(762206), Emu(400000), Emu(9500000), Emu(700000))
tf = title_box.text_frame
tf.word_wrap = True
tf.clear()
p_t = tf.paragraphs[0]
style_para(p_t, "АРХИТЕКТУРА И ИНФОРМАЦИОННОЕ ВЗАИМОДЕЙСТВИЕ", font_size=20, bold=True, color=COLOR_WHITE, space_after=Pt(2))
p_sub = tf.add_paragraph()
style_para(p_sub, "Функциональная схема по ГОСТ 19.701-90 (ЕСПД) взаимодействия пользователя, автомобиля и локального ИИ-ядра", font_size=12, bold=False, color=COLOR_LIGHT_SLATE, space_after=Pt(0))

# Номер слайда в правом нижнем углу
num_box = new_slide.shapes.add_textbox(Emu(11709145), Emu(6442645), Emu(282575), Emu(228600))
tf_num = num_box.text_frame
tf_num.clear()
p_num = tf_num.paragraphs[0]
style_para(p_num, "4.1", font_size=12, bold=False, color=COLOR_WHITE)

# Вставляем схему архитектуры
if os.path.exists(DIAG_IMG_PATH):
    img_left = Emu(550000)
    img_top = Emu(1180000)
    img_width = Emu(11092000)
    img_height = Emu(5220000)
    new_slide.shapes.add_picture(DIAG_IMG_PATH, img_left, img_top, img_width, img_height)

# Перемещаем созданный слайд на 5-ю позицию (индекс 4, сразу после Слайда 4)
sldIdLst = prs.slides._sldIdLst
new_el = sldIdLst[-1]
sldIdLst.insert(4, new_el)

# ==============================================================================
# СЛАЙД 6 (теперь prs.slides[5]): ТАБЛИЦА КОНКУРЕНТОВ И АНАЛОГОВ
# Увеличение шрифта с 8.5 pt до 11.5-13 pt, лаконичный плотный текст
# ==============================================================================
print("Обработка Слайда 6: Таблица конкурентов (укрупнение шрифтов до 12-13 pt)...")
s_comp = prs.slides[5]

# Удаляем старую таблицу
for sh in list(s_comp.shapes):
    if sh.has_table:
        sp = sh._element
        sp.getparent().remove(sp)

# Добавляем новую таблицу 7 строк x 5 колонок с выверенными размерами
t_left = Emu(550000)
t_top = Emu(1400000)
t_width = Emu(11092000)
t_height = Emu(4900000)

new_tbl_sh = s_comp.shapes.add_table(7, 5, t_left, t_top, t_width, t_height)
tbl = new_tbl_sh.table

tbl.columns[0].width = Emu(2600000)
tbl.columns[1].width = Emu(2300000)
tbl.columns[2].width = Emu(2050000)
tbl.columns[3].width = Emu(2050000)
tbl.columns[4].width = Emu(2092000)

comp_data = [
    [
        ("Характеристики продукта", True, COLOR_TITLE, 13.0, None),
        ("ИИдеал Авто\n(Россия, разработка)", True, COLOR_PURPLE, 13.0, RGBColor(255, 255, 255)),
        ("Qira\n(Германия)", True, COLOR_TITLE, 13.0, None),
        ("MechNostic\n(США)", True, COLOR_TITLE, 13.0, None),
        ("VINPIN СТО\n(Россия)", True, COLOR_TITLE, 13.0, None),
    ],
    [
        ("Принцип работы и логика", True, COLOR_TITLE, 12.0, None),
        ("От симптома к причине (гибридный RAG + чеклист)", False, COLOR_TEXT, 11.5, None),
        ("От кода к коду (дилерские деревья решений)", False, COLOR_TEXT, 11.5, None),
        ("Текстовый чат-бот по кодам ошибок OBD", False, COLOR_TEXT, 11.5, None),
        ("Статический каталог схем и регламентов по VIN", False, COLOR_TEXT, 11.5, None),
    ],
    [
        ("Входные мультимодальные данные", True, COLOR_TITLE, 12.0, None),
        ("Текст + фото узлов (Vision) + аудио 16 кГц шумов + OBD", False, COLOR_TEXT, 11.5, None),
        ("Текст + подключение сканера OBD-II", False, COLOR_TEXT, 11.5, None),
        ("Только текст + фото (обработка в облаке)", False, COLOR_TEXT, 11.5, None),
        ("Только текст / ручной выбор марки и узла", False, COLOR_TEXT, 11.5, None),
    ],
    [
        ("Приватность и автономность", True, COLOR_TITLE, 12.0, None),
        ("100% локально (AirLLM + DMA RAM, SQLite, без сети)", False, COLOR_TEXT, 11.5, None),
        ("Облако (серверы в ЕС, недоступны в РФ)", False, COLOR_TEXT, 11.5, None),
        ("Облако (серверы в США, API OpenAI)", False, COLOR_TEXT, 11.5, None),
        ("Облачный веб-сервис по годовой подписке", False, COLOR_TEXT, 11.5, None),
    ],
    [
        ("Формат результата диагностики", True, COLOR_TITLE, 12.0, None),
        ("Карта проверок + пошаговый чеклист + моменты (Н·м)", False, COLOR_TEXT, 11.5, None),
        ("Стандартный отчет по ошибкам для мастера СТО", False, COLOR_TEXT, 11.5, None),
        ("Сплошной текстовый диалог без регламентов", False, COLOR_TEXT, 11.5, None),
        ("Чертежи узлов, нормы времени, схемы проводки", False, COLOR_TEXT, 11.5, None),
    ],
    [
        ("Ценовая модель и доступность", True, COLOR_TITLE, 12.0, None),
        ("299–1 490 ₽/мес (доступно частникам и малым СТО)", False, COLOR_TEXT, 11.5, None),
        ("€150–500/мес (только юрлица, блок для РФ)", False, COLOR_TEXT, 11.5, None),
        ("20–50 $/мес (оплата картами банков США/ЕС)", False, COLOR_TEXT, 11.5, None),
        ("От 50 000 ₽/год (ориентация на крупные СТО)", False, COLOR_TEXT, 11.5, None),
    ],
    [
        ("Адаптация под автопарк РФ", True, COLOR_TITLE, 12.0, None),
        ("Высокая (база авто старше 7–10 лет, износ, РФ/КНР)", False, COLOR_TEXT, 11.5, None),
        ("Низкая (только новые европейские авто)", False, COLOR_TEXT, 11.5, None),
        ("Низкая (только рынок США)", False, COLOR_TEXT, 11.5, None),
        ("Средняя (каталоги есть, но нет ИИ-анализа)", False, COLOR_TEXT, 11.5, None),
    ],
]

for row_idx, row_content in enumerate(comp_data):
    for col_idx, cell_data in enumerate(row_content):
        cell = tbl.cell(row_idx, col_idx)
        cell.text = ""
        cell.vertical_anchor = MSO_ANCHOR.MIDDLE
        txt, is_bold, text_color, fsz, bg_color = cell_data
        if bg_color is not None:
            cell.fill.solid()
            cell.fill.fore_color.rgb = bg_color
            
        tf = cell.text_frame
        tf.word_wrap = True
        tf.margin_left = Pt(4)
        tf.margin_right = Pt(4)
        tf.margin_top = Pt(2)
        tf.margin_bottom = Pt(2)
        p = tf.paragraphs[0]
        style_para(p, txt, font_size=fsz, bold=is_bold, color=text_color, space_after=Pt(1))

# ==============================================================================
# СЛАЙДЫ 7 И 8: ТАБЛИЦЫ МОБИЛЬНЫХ ПРИЛОЖЕНИЙ И РЫНОЧНОГО ПОТЕНЦИАЛА
# Перевод всех ячеек в Calibri 12-13.5 pt
# ==============================================================================
for s_idx in [6, 7]:
    s_curr = prs.slides[s_idx]
    print(f"Форматирование шрифтов Слайда {s_idx + 1} (Таблица)...")
    for sh in s_curr.shapes:
        if sh.has_table:
            for r_i, row in enumerate(sh.table.rows):
                for c_i, cell in enumerate(row.cells):
                    is_hdr = (r_i == 0)
                    cell_lines = [p.text.strip() for p in cell.text_frame.paragraphs if p.text.strip()]
                    if not cell_lines:
                        continue
                    cell.text = ""
                    cell.vertical_anchor = MSO_ANCHOR.MIDDLE
                    for line_idx, line in enumerate(cell_lines):
                        p = cell.text_frame.paragraphs[0] if line_idx == 0 else cell.text_frame.add_paragraph()
                        p.alignment = PP_ALIGN.CENTER if is_hdr else PP_ALIGN.LEFT
                        p.space_after = Pt(1)
                        r = p.add_run()
                        r.text = line
                        r.font.name = FONT_BODY
                        r.font.size = Pt(13.0 if is_hdr else 12.0)
                        r.font.bold = is_hdr
                        if is_hdr:
                            r.font.color.rgb = COLOR_WHITE
                        else:
                            r.font.color.rgb = COLOR_TEXT

# ==============================================================================
# СЛАЙД 9: МОДЕЛЬ МОНЕТИЗАЦИИ, РЫНОК И ПОТРЕБИТЕЛИ (13.5-14 pt)
# ==============================================================================
print("Обработка Слайда 9 (Модель монетизации)...")
s9 = prs.slides[8]
for sh in s9.shapes:
    if sh.has_text_frame:
        txt = sh.text_frame.text
        if "Кто наш потребитель" in txt:
            sh.top = Inches(1.4)
            sh.width = Inches(5.8)
            sh.height = Inches(4.8)
            tf = sh.text_frame
            tf.clear()
            tf.word_wrap = True
            p0 = tf.paragraphs[0]
            style_para(p0, "ЦЕЛЕВЫЕ СЕГМЕНТЫ РЫНКА (B2C И B2B):", font_size=14, bold=True, color=COLOR_PURPLE, space_after=Pt(4))
            
            p1 = tf.add_paragraph()
            style_para(p1, "1. Владельцы авто с пробегом (TAM 52,8 млн авто, 72% старше 10 лет) — ключевая аудитория. Стремятся сэкономить 8 000–25 000 ₽/год на ТО и диагностике.", font_size=13, bold=False, color=COLOR_TEXT, space_after=Pt(4))
            
            p2 = tf.add_paragraph()
            style_para(p2, "2. Автолюбители-энтузиасты — самостоятельно ремонтируют и дооснащают автомобили в гараже.", font_size=13, bold=False, color=COLOR_TEXT, space_after=Pt(4))
            
            p3 = tf.add_paragraph()
            style_para(p3, "3. Частные выездные диагносты — нуждаются в мобильном инструменте комплексной верификации узлов.", font_size=13, bold=False, color=COLOR_TEXT, space_after=Pt(4))
            
            p4 = tf.add_paragraph()
            style_para(p4, "4. Малые независимые СТО (41 800 станций в РФ) — ускорение диагностики в 2.5 раза и обучение молодых механиков.", font_size=13, bold=False, color=COLOR_TEXT, space_after=Pt(0))

        elif "Модель монетизации" in txt:
            sh.left = Inches(6.8)
            sh.top = Inches(1.4)
            sh.width = Inches(5.8)
            sh.height = Inches(4.8)
            tf = sh.text_frame
            tf.clear()
            tf.word_wrap = True
            p0 = tf.paragraphs[0]
            style_para(p0, "ТАРИФНАЯ МОДЕЛЬ ПОДПИСКИ (SaaS):", font_size=14, bold=True, color=COLOR_ORANGE, space_after=Pt(4))
            
            tiers = [
                ("• Freemium (0 ₽/мес):", "До 3 экспресс-запросов в месяц по текстовым симптомам и кодам DTC без фото/аудио анализа (воронка привлечения)."),
                ("• Базовый B2C (299–499 ₽/мес):", "Неограниченная диагностика 1 личного автомобиля, полный RAG-чеклист, аудио- и фотоанализ, регламентные затяжки."),
                ("• Студенческий (149 ₽/мес):", "Льготный доступ для студентов инженерных и автотранспортных специальностей вузов и колледжей."),
                ("• Профессиональный B2B (1 490 ₽/мес):", "Мультимарочная база для независимых СТО, экспорт карт в PDF, логирование сессий клиентов, поддержка AR HUD RayNeo.")
            ]
            for t_name, t_desc in tiers:
                p = tf.add_paragraph()
                p.space_after = Pt(3)
                r1 = p.add_run()
                r1.text = t_name + " "
                r1.font.name = FONT_BODY
                r1.font.size = Pt(13)
                r1.font.bold = True
                r1.font.color.rgb = COLOR_TITLE
                r2 = p.add_run()
                r2.text = t_desc
                r2.font.name = FONT_BODY
                r2.font.size = Pt(12.5)
                r2.font.color.rgb = COLOR_TEXT

# ==============================================================================
# СЛАЙД 10: КОМАНДА И ПРОГРЕСС (Шрифт 12.5-13.5 pt, ширина 520 pt)
# ==============================================================================
print("Обработка Слайда 10 (Команда)...")
s_team = prs.slides[9]
for sh in s_team.shapes:
    if sh.has_text_frame and ("Укажите – ФИО" in sh.text_frame.text or "СОСТАВ КОМАНДЫ" in sh.text_frame.text):
        sh.left = Inches(0.65)
        sh.top = Inches(1.4)
        sh.width = Inches(7.2)
        sh.height = Inches(5.3)
        tf = sh.text_frame
        tf.clear()
        tf.word_wrap = True
        
        p = tf.paragraphs[0]
        style_para(p, "СОСТАВ КОМАНДЫ (Студенты 4 курса гр. ПО-32б, ЮЗГУ):", font_size=13.5, bold=True, color=COLOR_PURPLE, space_after=Pt(3))
        
        team_members = [
            ("Подорожный Максим", "Лидер / Архитектор", "Клиент-серверное ядро, RAG (BERT+FAISS), инференс Gemma 4 12B AirLLM."),
            ("Эрденко Максим", "Фронтенд-разработчик", "Клиент PWA, двухрежимный AR HUD очков RayNeo, оптимистичный UI."),
            ("Гусева Елена", "Аналитик / Маркетолог", "Анализ рынка (52,8 млн авто), финмодель SaaS, исследование СТО."),
            ("Разгуляев Егор", "ML-инженер", "Датасет телеметрии (32 733 записи), калибровка Bi/Cross-Encoder."),
            ("Свирин Николай", "Инженер БД", "Архитектура SQLite, Base64 Data URI, справочники кодов OBD-II (DTC)."),
            ("Корнеев Егор", "QA-инженер", "Тестовые сценарии диагностики, валидация пошаговых чеклистов узлов."),
            ("Рыжков Егор", "UI/UX дизайнер", "Дизайн-система, пиктограммы узлов, интерактивные чеклисты, AR-оверлей."),
            ("Михайлов Александр", "Аппаратная часть", "Протоколы CAN/OBD-II, сопряжение с ELM327, фильтрация сигналов датчиков.")
        ]
        
        for name, role, task in team_members:
            p_m = tf.add_paragraph()
            p_m.space_after = Pt(2)
            
            r1 = p_m.add_run()
            r1.text = f"• {name} "
            r1.font.name = FONT_BODY
            r1.font.size = Pt(12.5)
            r1.font.bold = True
            r1.font.color.rgb = COLOR_TITLE
            
            r2 = p_m.add_run()
            r2.text = f"[{role}]: "
            r2.font.name = FONT_BODY
            r2.font.size = Pt(12)
            r2.font.bold = True
            r2.font.color.rgb = COLOR_PURPLE
            
            r3 = p_m.add_run()
            r3.text = task
            r3.font.name = FONT_BODY
            r3.font.size = Pt(12)
            r3.font.color.rgb = COLOR_TEXT
            
        p_dyn = tf.add_paragraph()
        style_para(p_dyn, "Динамика компетенций: от гипотезы — к слаженной Agile-команде с готовым прототипом (TRL 4–5).", font_size=12, bold=True, color=COLOR_MUTED, space_after=Pt(0))

# ==============================================================================
# СЛАЙД 11: ПАРТНЕРЫ (Шрифт 12.5-13.5 pt, ширина 520 pt)
# ==============================================================================
print("Обработка Слайда 11 (Партнеры)...")
s_part = prs.slides[10]
for sh in s_part.shapes:
    if sh.has_text_frame and ("Опишите задачу партнера" in sh.text_frame.text or "ЗАДАЧА ПАРТНЕРА" in sh.text_frame.text):
        sh.left = Inches(0.65)
        sh.top = Inches(1.4)
        sh.width = Inches(7.2)
        sh.height = Inches(5.3)
        tf = sh.text_frame
        tf.clear()
        tf.word_wrap = True
        
        p = tf.paragraphs[0]
        style_para(p, "ЗАДАЧА ПАРТНЕРА В ОСНОВЕ ПРОЕКТА:", font_size=13.5, bold=True, color=COLOR_PURPLE, space_after=Pt(3))
        
        p_desc = tf.add_paragraph()
        style_para(p_desc, "Острая нехватка у независимых СТО доступа к базам Autodata и Bosch ESI из-за санкций. Мастера тратят до 2–3 часов на диагностику «на опыте», теряя клиентов при сложных плавающих неисправностях электроники.", font_size=12.5, bold=False, color=COLOR_TEXT, space_after=Pt(5))
        
        p_pl = tf.add_paragraph()
        style_para(p_pl, "ПАРТНЕРЫ И ПЛОЩАДКИ ПИЛОТИРОВАНИЯ:", font_size=13.5, bold=True, color=COLOR_TITLE, space_after=Pt(3))
        
        partners = [
            ("ЮЗГУ (Кафедра программной инженерии):", "Лаборатория вычислений для квантования Gemma 4, научно-техническая экспертиза, содействие в РИД."),
            ("Независимая СТО (г. Курск):", "Поток авто с пробегом (10+ лет) для полевой верификации чеклистов, оборудование (осциллографы, J2534)."),
            ("Автоклубы (Drive2, профильные форумы):", "Поставка датасетов аудиозаписей стуков ДВС и обратная связь по эргономике чеклистов.")
        ]
        
        for p_name, p_role in partners:
            p_item = tf.add_paragraph()
            p_item.space_after = Pt(2.5)
            
            r1 = p_item.add_run()
            r1.text = f"• {p_name} "
            r1.font.name = FONT_BODY
            r1.font.size = Pt(12.5)
            r1.font.bold = True
            r1.font.color.rgb = COLOR_PURPLE
            
            r2 = p_item.add_run()
            r2.text = p_role
            r2.font.name = FONT_BODY
            r2.font.size = Pt(12)
            r2.font.color.rgb = COLOR_TEXT
            
        p_next = tf.add_paragraph()
        p_next.space_after = Pt(0)
        rn1 = p_next.add_run()
        rn1.text = "Ближайший совместный шаг: "
        rn1.font.name = FONT_BODY
        rn1.font.size = Pt(12.5)
        rn1.font.bold = True
        rn1.font.color.rgb = COLOR_ORANGE
        
        rn2 = p_next.add_run()
        rn2.text = "Проведение 50+ контрольных диагностических сессий и подписание акта пилотирования."
        rn2.font.name = FONT_BODY
        rn2.font.size = Pt(12.5)
        rn2.font.color.rgb = COLOR_TEXT

# ==============================================================================
# СЛАЙД 12: УРОВЕНЬ ГОТОВНОСТИ ТЕХНОЛОГИИ (TRL)
# ==============================================================================
print("Обработка Слайда 12 (TRL)...")
s_trl = prs.slides[11]
for sh in s_trl.shapes:
    if sh.has_text_frame and ("Определите уровень готовности" in sh.text_frame.text or "ТЕКУЩИЙ СТАТУС" in sh.text_frame.text):
        sh.left = Inches(0.65)
        sh.top = Inches(1.3)
        sh.width = Inches(11.8)
        sh.height = Inches(1.3)
        tf = sh.text_frame
        tf.clear()
        tf.word_wrap = True
        
        p = tf.paragraphs[0]
        style_para(p, "ТЕКУЩИЙ СТАТУС: TRL 4–5 (ДЕЙСТВУЮЩИЙ ПРОГРАММНЫЙ ПРОТОТИП)", font_size=13.5, bold=True, color=COLOR_ORANGE, space_after=Pt(2))
        
        p_body = tf.add_paragraph()
        p_body.space_after = Pt(0)
        
        r1 = p_body.add_run()
        r1.text = "Разработан полнофункциональный программный прототип системы «ИИдеал Авто» (C# / Python / Django). "
        r1.font.name = FONT_BODY
        r1.font.size = Pt(13)
        r1.font.bold = True
        r1.font.color.rgb = COLOR_TITLE
        
        r2 = p_body.add_run()
        r2.text = "Подтверждено в лабораторных условиях: исходный код ядра AirLLM+RAG, тесты evaluate_model.py (Recall@3 = 100%, 4.5 мс), база телеметрии на 32 733 записи, логи сессий и двухрежимный AR HUD RayNeo."
        r2.font.name = FONT_BODY
        r2.font.size = Pt(12.5)
        r2.font.color.rgb = COLOR_TEXT

    elif sh.has_table:
        # Укрупнение шрифта в таблице TRL
        for r_i, row in enumerate(sh.table.rows):
            for c_i, cell in enumerate(row.cells):
                is_hdr = (r_i == 0)
                cell_lines = [p.text.strip() for p in cell.text_frame.paragraphs if p.text.strip()]
                if not cell_lines:
                    continue
                cell.text = ""
                cell.vertical_anchor = MSO_ANCHOR.MIDDLE
                for line_idx, line in enumerate(cell_lines):
                    p = cell.text_frame.paragraphs[0] if line_idx == 0 else cell.text_frame.add_paragraph()
                    p.alignment = PP_ALIGN.CENTER if is_hdr else PP_ALIGN.LEFT
                    p.space_after = Pt(1)
                    r = p.add_run()
                    r.text = line
                    r.font.name = FONT_BODY
                    r.font.size = Pt(13.0 if is_hdr else 12.0)
                    r.font.bold = is_hdr
                    if is_hdr:
                        r.font.color.rgb = COLOR_WHITE
                    else:
                        r.font.color.rgb = COLOR_TEXT

# ==============================================================================
# СЛАЙД 13: ПРОГРЕСС ЗА ВРЕМЯ АКСЕЛЕРАЦИИ (Таблица)
# ==============================================================================
print("Обработка Слайда 13 (Прогресс за время акселерации)...")
s_prog = prs.slides[12]
for sh in s_prog.shapes:
    if sh.has_text_frame and "Опишите чего удалось" in sh.text_frame.text:
        sh.text_frame.clear()
        p = sh.text_frame.paragraphs[0]
        style_para(p, "Динамика развития ключевых аспектов проекта «ИИдеал Авто» в рамках программы акселерации:", font_size=13.0, bold=True, color=COLOR_TITLE, space_after=Pt(4))
    elif sh.has_table:
        tbl_prog = sh.table
        prog_data = [
            ("До участия в акселерационной программе", "После участия в акселерационной программе"),
            (
                "Уровень готовности: TRL 2\nКонцепция системы, первичный анализ открытых LLM и методов RAG.",
                "Уровень готовности: TRL 4–5\nРаботающий прототип AirLLM (Gemma 4 12B W4A16), гибридный RAG (BERT+FAISS), аудиовход 16 кГц и AR HUD."
            ),
            (
                "Производственная готовность: MRL 1\nОтсутствие архитектуры сборки и требований инфраструктуры.",
                "Производственная готовность: MRL 4\nМодульная клиент-серверная архитектура, скрипты run_dev.ps1 / run_dev.sh, Docker, PWA."
            ),
            (
                "Рыночная готовность: CRL 1\nГипотетическое представление о потребностях автовладельцев.",
                "Рыночная готовность: CRL 3–4\nОбъем рынка (TAM 52,8 млн авто), SaaS-модель (299–1 490 ₽/мес), конкурентный анализ."
            ),
            (
                "Партнерства:\nОтсутствие договоренностей, студенческая инициатива.",
                "Партнерства:\nСогласовано пилотирование: кафедра Программной инженерии ЮЗГУ и независимая СТО г. Курска."
            )
        ]
        for row_idx, row_content in enumerate(prog_data):
            for col_idx, text_val in enumerate(row_content):
                cell = tbl_prog.cell(row_idx, col_idx)
                cell.text = ""
                cell.vertical_anchor = MSO_ANCHOR.MIDDLE
                tf = cell.text_frame
                tf.word_wrap = True
                is_hdr = (row_idx == 0)
                lines = text_val.split("\n")
                for l_idx, line_str in enumerate(lines):
                    p = tf.paragraphs[0] if l_idx == 0 else tf.add_paragraph()
                    p.alignment = PP_ALIGN.CENTER if is_hdr else PP_ALIGN.LEFT
                    p.space_after = Pt(2)
                    r = p.add_run()
                    r.text = line_str
                    r.font.name = FONT_BODY
                    r.font.size = Pt(13.0 if is_hdr else (12.5 if l_idx == 0 else 12.0))
                    r.font.bold = is_hdr or (l_idx == 0 and not is_hdr)
                    r.font.color.rgb = COLOR_WHITE if is_hdr else (COLOR_PURPLE if l_idx == 0 and col_idx == 1 else COLOR_TEXT)

# ==============================================================================
# СЛАЙД 14: ПЛАНЫ РАЗВИТИЯ (12.5-13.5 pt, ширина 540 pt)
# ==============================================================================
print("Обработка Слайда 14 (Планы развития)...")
s_plans = prs.slides[13]
for sh in s_plans.shapes:
    if sh.has_text_frame and ("Опишите ваши планы" in sh.text_frame.text or "КОМПЛЕКСНЫЙ ПЛАН" in sh.text_frame.text):
        sh.left = Inches(0.65)
        sh.top = Inches(1.4)
        sh.width = Inches(7.5)
        sh.height = Inches(5.3)
        tf = sh.text_frame
        tf.clear()
        tf.word_wrap = True
        
        p = tf.paragraphs[0]
        style_para(p, "КОМПЛЕКСНЫЙ ПЛАН РАЗВИТИЯ «ИИДЕАЛ АВТО» НА 2026–2027 ГГ.:", font_size=13.5, bold=True, color=COLOR_PURPLE, space_after=Pt(3))
        
        plans = [
            ("1. Исследования и разработка (R&D):",
             "• Дообучение LoRA-адаптера Gemma 4 по маркам КНР (Haval, Chery, Geely) и авто 10+ лет.\n"
             "• Оптимизация инференса под мобильные NPU (Snapdragon / Apple NPU) для автономности.\n"
             "• Чтение стоп-кадров (Freeze Frames) с адаптеров ELM327 по прямому Bluetooth-каналу."),
            ("2. Защита интеллектуальной собственности (РИД):",
             "• Регистрация программы для ЭВМ «Система автодиагностики ИИдеал Авто» в Роспатенте.\n"
             "• Регистрация базы данных эталонной телеметрии и алгоритмов пошагового ремонта."),
            ("3. Маркетинг и коммерческое внедрение:",
             "• Пилотное внедрение в 5 независимых СТО г. Курска с фиксацией актов внедрения.\n"
             "• Продвижение через профильные автосообщества (Drive2, Telegram-каналы, форумы).\n"
             "• Партнерская комиссия 5–10% с заказа запчастей по готовому диагностическому чеклисту."),
            ("4. Привлечение инвестиций:",
             "• Подача заявки на грант «Студенческий стартап» Фонда содействия инновациям (1 млн ₽).\n"
             "• Участие в демо-днях ПУТП и привлечение pre-seed раунда (3–5 млн ₽).")
        ]
        
        for p_title, p_content in plans:
            p_hdr = tf.add_paragraph()
            p_hdr.space_after = Pt(1)
            rh = p_hdr.add_run()
            rh.text = p_title
            rh.font.name = FONT_BODY
            rh.font.size = Pt(13)
            rh.font.bold = True
            rh.font.color.rgb = COLOR_TITLE
            
            p_cnt = tf.add_paragraph()
            p_cnt.space_after = Pt(2.5)
            rc = p_cnt.add_run()
            rc.text = p_content
            rc.font.name = FONT_BODY
            rc.font.size = Pt(12)
            rc.font.color.rgb = COLOR_TEXT

# ==============================================================================
# СЛАЙД 15: ЗАПРОС К АКСЕЛЕРАТОРУ (12.5-13.5 pt, ширина 520 pt)
# ==============================================================================
print("Обработка Слайда 15 (Запрос)...")
s_req = prs.slides[14]
for sh in s_req.shapes:
    if sh.has_text_frame and ("Опишите чего сейчас не хватает" in sh.text_frame.text or "ЗАПРОС К АКСЕЛЕРАТОРУ" in sh.text_frame.text):
        sh.left = Inches(0.65)
        sh.top = Inches(1.4)
        sh.width = Inches(7.2)
        sh.height = Inches(5.3)
        tf = sh.text_frame
        tf.clear()
        tf.word_wrap = True
        
        p = tf.paragraphs[0]
        style_para(p, "ЗАПРОС К АКСЕЛЕРАТОРУ И ЭКОСИСТЕМЕ НТИ:", font_size=13.5, bold=True, color=COLOR_ORANGE, space_after=Pt(3))
        
        requests = [
            ("1. Финансирование (Грант 1 000 000 ₽ «Студенческий стартап» ФСИ):",
             "• Закупка сертифицированного оборудования (осциллографы, манометры, адаптеры J2534);\n"
             "• Аренда облачных GPU-серверов для квантования и дообучения моделей Gemma 4;\n"
             "• Таргетированный маркетинг и привлечение первых 1 000 платящих B2C-пользователей."),
            ("2. Компетенции и отраслевая экспертиза:",
             "• Менторское сопровождение экспертов рабочей группы рынка Автонет (Autonet НТИ);\n"
             "• Юридическая поддержка лицензионных договоров SaaS и патентной защиты РИД."),
            ("3. Нетворкинг и масштабирование пилотирования:",
             "• Доступ к партнерской сети автосервисов и корпоративных автопарков акселератора;\n"
             "• Прямая интеграция по API с каталогами дистрибьюторов автозапчастей (Exist, Emex).")
        ]
        
        for r_title, r_content in requests:
            pr_hdr = tf.add_paragraph()
            pr_hdr.space_after = Pt(1)
            rh = pr_hdr.add_run()
            rh.text = r_title
            rh.font.name = FONT_BODY
            rh.font.size = Pt(13)
            rh.font.bold = True
            rh.font.color.rgb = COLOR_TITLE
            
            pr_cnt = tf.add_paragraph()
            pr_cnt.space_after = Pt(2.5)
            rc = pr_cnt.add_run()
            rc.text = r_content
            rc.font.name = FONT_BODY
            rc.font.size = Pt(12)
            rc.font.color.rgb = COLOR_TEXT

# ==============================================================================
# СЛАЙД 16: ЭКСПЕРТНОЕ ЗАКЛЮЧЕНИЕ (Белый контрастный текст 13 pt)
# ==============================================================================
print("Обработка Слайда 16 (Экспертиза)...")
s_exp = prs.slides[15]

# Удаляем возможные дубликаты
exp_shapes = [sh for sh in s_exp.shapes if sh.has_text_frame]
first_box_handled = False
for sh in exp_shapes:
    txt = sh.text_frame.text
    if "ЭКСПЕРТНОЕ ЗАКЛЮЧЕНИЕ" in txt:
        sh.text_frame.paragraphs[0].font.name = FONT_TITLE
        sh.text_frame.paragraphs[0].font.size = Pt(24)
        sh.text_frame.paragraphs[0].font.bold = True
        sh.text_frame.paragraphs[0].font.color.rgb = COLOR_WHITE
    elif "ЗАКЛЮЧЕНИЯ ЭКСПЕРТОВ" in txt or "Прикрепите комментарии" in txt or "Укажите ФИО эксперта" in txt:
        if not first_box_handled:
            first_box_handled = True
            sh.left = Inches(0.65)
            sh.top = Inches(1.4)
            sh.width = Inches(7.8)
            sh.height = Inches(5.3)
            tf = sh.text_frame
            tf.clear()
            tf.word_wrap = True
            
            p = tf.paragraphs[0]
            style_para(p, "ЗАКЛЮЧЕНИЯ ЭКСПЕРТОВ ПЛАТФОРМЫ НТИ (РЕЕСТР ЭКСПЕРТИЗЫ)", font_size=13.5, bold=True, color=COLOR_WHITE, space_after=Pt(3))
            
            p_sub = tf.add_paragraph()
            style_para(p_sub, "Слайд зарезервирован для внесения отзывов и верификации экспертами ИС «Эксперты НТИ» по 3 ключевым критериям:", font_size=12, bold=False, color=COLOR_LIGHT_SLATE, space_after=Pt(4))
            
            slots = [
                ("Эксперт №1: [ФИО эксперта / Профиль в ИС НТИ]", "Критерии: Теоретическая реализуемость — подтверждена; Коммерческий потенциал — высокий."),
                ("Эксперт №2: [ФИО эксперта / Профиль в ИС НТИ]", "Критерии: Научно-техническая обоснованность алгоритмов RAG и квантования — подтверждена."),
                ("Эксперт №3: [ФИО эксперта / Профиль в ИС НТИ]", "Критерии: Соответствие приоритетам НТР РФ и технологического суверенитета в автодиагностике."),
                ("Эксперт №4: [ФИО эксперта / Профиль в ИС НТИ]", "Критерии: Оценка востребованности решения в сегменте независимых СТО и авторемонта."),
                ("Эксперт №5: [ФИО эксперта / Профиль в ИС НТИ]", "Критерии: Инвестиционная привлекательность и масштабируемость бизнес-модели.")
            ]
            
            for s_hdr, s_crit in slots:
                p_s = tf.add_paragraph()
                p_s.space_after = Pt(2.5)
                
                r1 = p_s.add_run()
                r1.text = f"• {s_hdr}\n  "
                r1.font.name = FONT_BODY
                r1.font.size = Pt(12.5)
                r1.font.bold = True
                r1.font.color.rgb = RGBColor(216, 180, 254) # Светло-сиреневый акцент
                
                r2 = p_s.add_run()
                r2.text = s_crit
                r2.font.name = FONT_BODY
                r2.font.size = Pt(12)
                r2.font.color.rgb = COLOR_WHITE
        else:
            # Удаляем дублирующий шейп
            sp = sh._element
            sp.getparent().remove(sp)

# ==============================================================================
# ФИНАЛЬНАЯ ПРОВЕРКА И ПРИНУДИТЕЛЬНАЯ СТАНДАРТИЗАЦИЯ ШРИФТОВ ВСЕХ СЛАЙДОВ (Calibri)
# ==============================================================================
print("Глобальная стандартизация шрифтов во всех шейпах и таблицах...")
for s_idx, s in enumerate(prs.slides):
    for sh in s.shapes:
        if sh.has_text_frame:
            for p in sh.text_frame.paragraphs:
                for r in p.runs:
                    if r.font.name != "Calibri":
                        r.font.name = "Calibri"
        elif sh.has_table:
            for row in sh.table.rows:
                for cell in row.cells:
                    for p in cell.text_frame.paragraphs:
                        for r in p.runs:
                            if r.font.name != "Calibri":
                                r.font.name = "Calibri"

# Сохраняем готовую презентацию
prs.save(DST_PATH)
print("Презентация успешно сохранена по пути:")
print(DST_PATH)

# Также копируем в рабочую папку проекта
WORKSPACE_PATH = r"d:\GDrive\Документы\Visual Studio 2022\ExpertSystem_auto_diag\ИИдеал_Авто_Презентация_Акселератор_НТИ.pptx"
prs.save(WORKSPACE_PATH)
print("Копия сохранена в репозиторий:", WORKSPACE_PATH)
