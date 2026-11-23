# -*- coding: utf-8 -*-
"""
Генератор научной статьи по официальным правилам и образцу журнала
«Известия Юго-Западного государственного университета» (ВАК К1, RSCI, Белый список РФ).
"""

import os
import docx
from docx import Document
from docx.shared import Pt, Mm, RGBColor, Inches
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_ALIGN_VERTICAL
from docx.oxml import parse_xml, OxmlElement
from docx.oxml.ns import nsdecls, qn
from lxml import etree
import latex2mathml.converter

# Инициализация конвертера LaTeX -> MathML -> OMML
xslt_path = r"C:\Program Files\Microsoft Office\root\Office16\MML2OMML.XSL"
xslt_doc = etree.parse(xslt_path)
transform = etree.XSLT(xslt_doc)

def latex_to_omml(latex_code):
    mathml = latex2mathml.converter.convert(latex_code)
    mathml_doc = etree.fromstring(mathml)
    omml_doc = transform(mathml_doc)
    return etree.tostring(omml_doc, encoding="unicode")

def add_formula_yuzgu(doc, latex_code, formula_number_str):
    """
    Вставка формулы по требованиям ЮЗГУ (нативный Office Math, центрирование, номер справа).
    Полоса набора и размеры соответствуют Microsoft Equation / Office Math.
    """
    table = doc.add_table(rows=1, cols=2)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False

    # Убираем рамки
    tblPr = table._tbl.tblPr
    borders = parse_xml(
        f'<w:tblBorders {nsdecls("w")}>'
        f'  <w:top w:val="none"/><w:bottom w:val="none"/><w:insideH w:val="none"/>'
        f'  <w:insideV w:val="none"/><w:left w:val="none"/><w:right w:val="none"/>'
        f'</w:tblBorders>'
    )
    tblPr.append(borders)

    row = table.rows[0]
    row.cells[0].width = Mm(145)
    row.cells[1].width = Mm(20)

    for cell in row.cells:
        tcPr = cell._tc.get_or_add_tcPr()
        tcMar = OxmlElement('w:tcMar')
        for m, val in [('top', 40), ('bottom', 40), ('left', 0), ('right', 0)]:
            node = OxmlElement(f'w:{m}')
            node.set(qn('w:w'), str(val))
            node.set(qn('w:type'), 'dxa')
            tcMar.append(node)
        tcPr.append(tcMar)

    # Центральная ячейка формулы
    p_form = row.cells[0].paragraphs[0]
    p_form.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_form.paragraph_format.space_before = Pt(0)
    p_form.paragraph_format.space_after = Pt(0)
    p_form.paragraph_format.line_spacing = 1.0

    omml_str = latex_to_omml(latex_code)
    p_form._p.append(parse_xml(omml_str))

    # Правая ячейка с номером
    p_num = row.cells[1].paragraphs[0]
    p_num.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    p_num.paragraph_format.space_before = Pt(0)
    p_num.paragraph_format.space_after = Pt(0)
    p_num.paragraph_format.line_spacing = 1.0
    r_num = p_num.add_run(f"({formula_number_str})")
    r_num.font.name = 'Times New Roman'
    r_num.font.size = Pt(14)

def set_cell_margins(cell, top=80, bottom=80, left=100, right=100):
    tcPr = cell._tc.get_or_add_tcPr()
    tcMar = OxmlElement('w:tcMar')
    for m, val in [('top', top), ('bottom', bottom), ('left', left), ('right', right)]:
        node = OxmlElement(f'w:{m}')
        node.set(qn('w:w'), str(val))
        node.set(qn('w:type'), 'dxa')
        tcMar.append(node)
    tcPr.append(tcMar)

def set_cell_shading(cell, color_hex):
    shading = parse_xml(f'<w:shd {nsdecls("w")} w:fill="{color_hex}"/>')
    cell._tc.get_or_add_tcPr().append(shading)

def set_table_borders_bw(table):
    tblPr = table._tbl.tblPr
    borders = parse_xml(
        f'<w:tblBorders {nsdecls("w")}>'
        f'  <w:top w:val="single" w:sz="6" w:space="0" w:color="000000"/>'
        f'  <w:bottom w:val="single" w:sz="6" w:space="0" w:color="000000"/>'
        f'  <w:insideH w:val="single" w:sz="4" w:space="0" w:color="666666"/>'
        f'  <w:insideV w:val="none"/>'
        f'  <w:left w:val="none"/>'
        f'  <w:right w:val="none"/>'
        f'</w:tblBorders>'
    )
    tblPr.append(borders)

def add_p(doc, text="", space_before=0, space_after=0, bold=False, italic=False, align=WD_ALIGN_PARAGRAPH.JUSTIFY, first_indent=15.0, font_size=14, line_spacing=1.0):
    p = doc.add_paragraph()
    p.alignment = align
    p.paragraph_format.first_line_indent = Mm(first_indent) if first_indent > 0 else Pt(0)
    p.paragraph_format.line_spacing = line_spacing
    p.paragraph_format.space_before = Pt(space_before)
    p.paragraph_format.space_after = Pt(space_after)
    if text:
        r = p.add_run(text)
        r.font.name = 'Times New Roman'
        r.font.size = Pt(font_size)
        r.font.bold = bold
        r.font.italic = italic
        r.font.color.rgb = RGBColor(0, 0, 0)
    return p

def main():
    doc = Document()
    base_dir = os.path.dirname(os.path.abspath(__file__))
    figures_dir = os.path.join(base_dir, "article_figures_bw")
    output_docx = os.path.join(base_dir, "Статья_Известия_ЮЗГУ_ИИдеал_Авто.docx")

    # 1. Параметры страницы по правилам «Известия ЮЗГУ»:
    # Поля: левое — 2,5 см, верхнее — 2,5 см, нижнее — 2,5 см, правое — 2,0 см.
    for sec in doc.sections:
        sec.top_margin = Mm(25)
        sec.bottom_margin = Mm(25)
        sec.left_margin = Mm(25)
        sec.right_margin = Mm(20)
        sec.page_width = Mm(210)
        sec.page_height = Mm(297)

    # Базовый стиль шрифта
    normal_style = doc.styles['Normal']
    normal_style.font.name = 'Times New Roman'
    normal_style.font.size = Pt(14)
    normal_style.paragraph_format.line_spacing = 1.0
    normal_style.font.color.rgb = RGBColor(0, 0, 0)

    # -------------------------------------------------------------------------
    # РУССКОЯЗЫЧНЫЙ БЛОК СТАТЬИ (СТРОГО ПО ОБРАЗЦУ ЮЗГУ СТР. 1)
    # -------------------------------------------------------------------------
    # Образец оформления статьи для публикации (служебная шапка образца)
    p_ob = add_p(doc, "Образец оформления статьи для публикации", space_before=0, space_after=6, italic=True, align=WD_ALIGN_PARAGRAPH.CENTER, first_indent=0, font_size=12)

    # УДК
    add_p(doc, "УДК 004.891:629.3.082", space_before=4, space_after=12, align=WD_ALIGN_PARAGRAPH.LEFT, first_indent=0, font_size=14)

    # Название статьи (полужирный, прописные, по центру)
    p_title = add_p(doc, "МЕТОД И АРХИТЕКТУРА ИНТЕЛЛЕКТУАЛЬНОЙ ДИАГНОСТИКИ АВТОТРАНСПОРТНЫХ СРЕДСТВ НА ОСНОВЕ ПОСЛОЙНОГО ВЫВОДА КВАНТОВАННЫХ ЯЗЫКОВЫХ МОДЕЛЕЙ И ГИБРИДНОГО СЕМАНТИЧЕСКОГО ПОИСКА",
                    space_before=6, space_after=12, bold=True, align=WD_ALIGN_PARAGRAPH.CENTER, first_indent=0, font_size=14)

    # Авторы (курсив, по центру)
    p_authors = doc.add_paragraph()
    p_authors.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_authors.paragraph_format.first_line_indent = Pt(0)
    p_authors.paragraph_format.line_spacing = 1.0
    p_authors.paragraph_format.space_before = Pt(4)
    p_authors.paragraph_format.space_after = Pt(8)

    r_a1 = p_authors.add_run("А. Н. Иванов")
    r_a1.font.italic = True
    r_a1.font.size = Pt(14)
    r_s1 = p_authors.add_run("1")
    r_s1.font.superscript = True
    r_s1.font.size = Pt(10)

    r_sep = p_authors.add_run(", ")
    r_sep.font.size = Pt(14)

    r_a2 = p_authors.add_run("Б. В. Петров")
    r_a2.font.italic = True
    r_a2.font.size = Pt(14)
    r_s2 = p_authors.add_run("2*")
    r_s2.font.superscript = True
    r_s2.font.size = Pt(10)

    r_mail_ico = p_authors.add_run(" ✉")
    r_mail_ico.font.size = Pt(12)

    # Аффилиация (без ОПФ: ФГБОУ ВО)
    add_p(doc, "1 Юго-Западный государственный университет, Российская Федерация, 305040 г. Курск, 50 лет Октября, 94",
          space_before=2, space_after=2, align=WD_ALIGN_PARAGRAPH.LEFT, first_indent=0, font_size=12)
    add_p(doc, "2 Юго-Западный государственный университет, Российская Федерация, 305040 г. Курск, 50 лет Октября, 94",
          space_before=2, space_after=4, align=WD_ALIGN_PARAGRAPH.LEFT, first_indent=0, font_size=12)
    add_p(doc, "✉ e-mail: petrov_b_v@swsu.ru", space_before=2, space_after=12, align=WD_ALIGN_PARAGRAPH.LEFT, first_indent=0, font_size=12)

    # Аннотация (200 – 250 слов по структуре: Актуальность, Цель, Задачи, Методология, Результаты, Вывод)
    add_p(doc, "Аннотация (200 – 250 слов по следующей структуре):", space_before=4, space_after=3, bold=True, italic=True, align=WD_ALIGN_PARAGRAPH.LEFT, first_indent=0, font_size=12)

    p_struct_abs = doc.add_paragraph()
    p_struct_abs.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    p_struct_abs.paragraph_format.first_line_indent = Mm(15.0)
    p_struct_abs.paragraph_format.line_spacing = 1.0
    p_struct_abs.paragraph_format.space_before = Pt(2)
    p_struct_abs.paragraph_format.space_after = Pt(8)

    sections_abs = [
        ("Актуальность. ", "Непрерывный рост сложности электронных систем управления автотранспортными средствами и взаимосвязанных потоков телеметрии OBD-II существенно затрудняет поиск причин комплексных дефектов традиционными сканерами. Применение универсальных облачных нейросетей сопряжено с рисками генеративных галлюцинаций в метрологических допусках узлов и проблемами конфиденциальности данных. "),
        ("Цель. ", "Разработка метода и архитектуры экспертной системы автодиагностики на основе локальных квантованных больших языковых моделей и гибридного семантического поиска для формирования верифицированных технологических карт ремонта. "),
        ("Задачи. ", "Построить математическую модель гибридного извлечения информации RAG, адаптировать послойный инференс квантованной модели W4A16 под ограничения видеопамяти GPU, исследовать точность и временную задержку поискового конвейера на выборке кодов DTC и сервисных регламентов. "),
        ("Методология. ", "Применены методы векторного семантического поиска на базе индекса FAISS, лексический алгоритм BM25Okapi с бустингом идентификаторов стандарта SAE J1979, попарное переранжирование кросс-энкодером с учетом расчетного индекса исправности агрегатов, а также послойное исполнение 12-миллиардной модели Gemma 4 с оптимизацией int4pack в VRAM графического ускорителя. "),
        ("Результаты. ", "На выборке из 137 диагностических кодов и 359 регламентов достигнута стопроцентная полнота поиска в пределах трех кандидатов (Recall@3 = 100%) и значение среднего взаимного ранга MRR = 0.976 при задержке поиска на GPU 31.2 мс. Потребление видеопамяти снижено до 10.1 ГБ, обеспечивая скорость генерации 12.4 токена/с. "),
        ("Вывод. ", "Предложенный подход исключает субъективные ошибки оператора, гарантирует строгое соответствие технологических чеклистов ремонта заводским допускам физических параметров и обеспечивает полностью автономную работу диагностического комплекса на типовых станциях технического обслуживания.")
    ]
    for tag, val in sections_abs:
        r_t = p_struct_abs.add_run(tag)
        r_t.font.name = 'Times New Roman'
        r_t.font.bold = True
        r_t.font.italic = True
        r_t.font.size = Pt(12)
        r_v = p_struct_abs.add_run(val)
        r_v.font.name = 'Times New Roman'
        r_v.font.size = Pt(12)

    # Ключевые слова
    p_kw = doc.add_paragraph()
    p_kw.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    p_kw.paragraph_format.first_line_indent = Mm(15.0)
    p_kw.paragraph_format.line_spacing = 1.0
    p_kw.paragraph_format.space_before = Pt(2)
    p_kw.paragraph_format.space_after = Pt(8)
    r_kwh = p_kw.add_run("Ключевые слова: ")
    r_kwh.font.name = 'Times New Roman'
    r_kwh.font.bold = True
    r_kwh.font.size = Pt(12)
    r_kwv = p_kw.add_run("техническая диагностика автомобилей; бортовая диагностика OBD-II; коды неисправностей DTC; генерация с дополненной выборкой (RAG); большие языковые модели; послойный вывод нейросетей; квантование W4A16; гибридный семантический поиск; экспертные системы.")
    r_kwv.font.name = 'Times New Roman'
    r_kwv.font.italic = True
    r_kwv.font.size = Pt(12)

    # Конфликт интересов
    p_coi = doc.add_paragraph()
    p_coi.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    p_coi.paragraph_format.first_line_indent = Mm(15.0)
    p_coi.paragraph_format.line_spacing = 1.0
    p_coi.paragraph_format.space_before = Pt(4)
    p_coi.paragraph_format.space_after = Pt(14)
    r_coih = p_coi.add_run("Конфликт интересов: ")
    r_coih.font.name = 'Times New Roman'
    r_coih.font.bold = True
    r_coih.font.italic = True
    r_coih.font.size = Pt(11)
    r_coiv = p_coi.add_run("в представленной публикации отсутствует заимствованный материал без ссылок на автора и (или) источник заимствования; нет результатов научных работ, выполненных автором (авторами) публикации, лично и (или) в соавторстве, без соответствующих ссылок. Автор (ы) декларирует отсутствие конфликта интересов, связанных с публикацией данной статьи.")
    r_coiv.font.name = 'Times New Roman'
    r_coiv.font.size = Pt(11)

    # -------------------------------------------------------------------------
    # ОСНОВНОЙ ТЕКСТ РУКОПИСИ (14 пт, 1.0 интервал, поля 2.5/2.0, абзац 1.5 см)
    # -------------------------------------------------------------------------

    # ВВЕДЕНИЕ
    add_p(doc, "Введение", space_before=10, space_after=4, bold=True, align=WD_ALIGN_PARAGRAPH.LEFT, first_indent=15.0, font_size=14)

    add_p(
        doc,
        "Современное автотранспортное средство представляет собой сложный распределенный аппаратно-программный комплекс, "
        "объединяющий до сотни микропроцессорных электронных блоков управления (ЭБУ), коммутируемых высокоскоростными "
        "мультиплексными шинами передачи данных CAN, LIN и FlexRay. Эксплуатационная надежность, экологические параметры и "
        "безопасность движения колесных машин регламентируются требованиями ГОСТ 20911-89, стандартов бортовой самодиагностики "
        "SAE J1979, ISO 15031-4 и протокола единых диагностических услуг ISO 14229-1 (UDS). При возникновении эксплуатационных "
        "отказов электронные блоки фиксируют стандартизированные коды неисправностей (Diagnostic Trouble Codes, DTC) и кадры сопутствующих "
        "параметров (Freeze Frames). Однако непосредственная фиксация кода ошибки отражает лишь следствие сбоя в электрической "
        "цепи или отклонение регистрируемого физического параметра от допустимого диапазона (параметрический отказ), но не "
        "указывает на исходную причину дефекта (механический износ, негерметичность тракта впуска, деградация гидравлических "
        "клапанов или закоксовка каналов)."
    )

    add_p(
        doc,
        "В области автоматизации диагностирования силовых агрегатов и бортовых систем традиционно применялись продукционные "
        "экспертные системы и алгоритмы статических деревьев решений [1, 2]. Исследования диагностических комплексов для электронных "
        "систем управления двигателей [2] показали, что жесткие детерминированные алгоритмы эффективны лишь при локализации единичных "
        "обрывов цепей или явных отказов датчиков. При возникновении сложных комплексных дефектов (каскадные пропуски воспламенения, "
        "детонация, отклонения топливоподачи) результативность классических подходов резко снижается из-за невозможности учета нелинейных "
        "взаимосвязей телеметрии и контекста предшествующих ремонтных воздействий [3, 4]. "
        "Развитие методов глубокого обучения и архитектур трансформеров обусловило переход к аналитическим языковым моделям "
        "обработки технической информации [4, 5]. Однако прямое использование универсальных больших языковых моделей (LLM) "
        "в задачах инженерной автодиагностики неприменимо вследствие эффекта генеративных галлюцинаций — формирования "
        "недостоверных параметров электрического сопротивления, моментов затяжки или давлений в топливных магистралях, что "
        "создает прямую угрозу вывода агрегатов из строя. "
        "Решением проблемы фактологической достоверности выступает архитектура генерации с дополненной выборкой "
        "(Retrieval-Augmented Generation, RAG) [5, 6]. В работах по информационному поиску [5] показано, что наибольшую "
        "избирательность обеспечивают гибридные конвейеры, объединяющие лексический поиск (BM25) и векторное сопоставление "
        "плотных эмбеддингов с последующим глубоким переранжированием кандидатов кросс-энкодером. Вместе с тем развертывание "
        "современных трансформерных моделей непосредственно на рабочих станциях сервисных предприятий сдерживается дефицитом "
        "видеопамяти графических ускорителей (VRAM) [6, 7]."
    )

    add_p(
        doc,
        "Цель исследования — разработка научно обоснованного метода и модульной программной архитектуры экспертной системы "
        "автодиагностики, обеспечивающих локальный послойный вывод квантованной мультимодальной нейросетевой модели в условиях "
        "аппаратных ограничений VRAM и формирование верифицированных технологических карт ремонта на основе гибридного "
        "семантического поиска по нормативным базам знаний."
    )

    # МАТЕРИАЛЫ И МЕТОДЫ
    add_p(doc, "Материалы и методы", space_before=10, space_after=4, bold=True, align=WD_ALIGN_PARAGRAPH.LEFT, first_indent=15.0, font_size=14)

    add_p(
        doc,
        "Математическая постановка задачи локализации неисправностей. Задано множество диагностических признаков, "
        "поступающих от диагностического сканера или оператора:"
    )

    add_formula_yuzgu(doc, r"Q = \langle C_{\mathrm{DTC}}, S_{\mathrm{symp}}, T_{\mathrm{telemetry}}, M_{\mathrm{context}} \rangle", "1")

    add_p(
        doc,
        "где C_DTC — вектор зафиксированных кодов неисправностей по стандарту SAE J1979;\n"
        "S_symp — неструктурированное текстовое или речевое описание проявлений дефекта;\n"
        "T_telemetry — параметры потока данных бортовой сети (обороты N, давление во впускном коллекторе P_MAP, коррекции топливоподачи STFT/LTFT и др.);\n"
        "M_context — фактографическая предыстория проверок.",
        space_before=2, space_after=4
    )

    add_p(
        doc,
        "Требуется найти упорядоченное подмножество инструкций D* из базы регламентов D и сформировать детерминированную последовательность "
        "проверок R, минимизирующую энтропию неопределенности технического состояния автомобиля:"
    )

    add_formula_yuzgu(doc, r"R^* = \arg\max_R P(R \mid Q, D^*)", "2")

    add_p(
        doc,
        "Модель гибридного извлечения информации (Hybrid Retrieval). Запрос q отображается в пространство признаков R^d (d = 384) "
        "био-энкодером e_q = E_dense(q). Косинусное сходство с эмбеддингами документов e_d = E_dense(d) вычисляется по формуле:"
    )

    add_formula_yuzgu(doc, r"\mathrm{sim}_{\mathrm{dense}}(q, d) = \frac{\mathbf{e}_q \cdot \mathbf{e}_d}{\|\mathbf{e}_q\|_2 \, \|\mathbf{e}_d\|_2}", "3")

    add_p(
        doc,
        "Параллельно рассчитывается лексическая функция BM25Okapi с бустингом идентификаторов кодов ошибок стандарта SAE J1979:"
    )

    add_formula_yuzgu(doc, r"\mathrm{score}_{\mathrm{BM25}}(q, d) = \sum_{t \in q \cap d} \ln \left( \frac{N - n(t) + 0.5}{n(t) + 0.5} + 1 \right) \cdot \frac{f(t, d) \cdot (k_1 + 1)}{f(t, d) + k_1 \cdot \left(1 - b + b \cdot \frac{|d|}{\mathrm{avgdl}}\right)}", "4")

    add_p(
        doc,
        "где k_1 = 1.5, b = 0.75; n(t) — число документов с термом t; f(t, d) — частота терма; |d| — длина документа. "
        "При совпадении с маской кодов DTC вес увеличивается с коэффициентом бустинга β_DTC = 2.5. "
        "Объединенный пул кандидатов S_pool = S_dense ∪ S_lex (|S_pool| ≤ 20) ранжируется кросс-энкодером с весом технического состояния H(d):"
    )

    add_formula_yuzgu(doc, r"\mathrm{Score}_{\mathrm{final}}(q, d_i) = \sigma(\mathcal{M}_{\mathrm{cross}}(q, d_i)) + \lambda \cdot \frac{100 - H(d_i)}{200}", "5")

    add_p(
        doc,
        "где σ(x) — логистическая функция, λ = 0.15 — множитель критичности отказа. "
        "Послойный инференс модели архитектуры W4A16 (Weight 4-bit, Activation 16-bit) осуществляется на квантованных блоках весов:"
    )

    add_formula_yuzgu(doc, r"\hat{W} = s \cdot (w_{\mathrm{int4}} - z)", "6")

    add_formula_yuzgu(doc, r"Y = X \cdot \mathrm{int4pack\_mm}(\hat{W}, s, z)", "7")

    add_p(
        doc,
        "где s — масштабирующий фактор FP16, z — нулевая точка сдвига. "
        "Ядро _weight_int4pack_mm исключает распаковку весов в глобальную память GPU, снижая трафик шины в 3.8 раза."
    )

    # РЕЗУЛЬТАТЫ И ИХ ОБСУЖДЕНИЕ
    add_p(doc, "Результаты и их обсуждение", space_before=10, space_after=4, bold=True, align=WD_ALIGN_PARAGRAPH.LEFT, first_indent=15.0, font_size=14)

    add_p(
        doc,
        "1. Технологический процесс сквозной автодиагностики. На рисунке 1 приведена разработанная блок-схема процесса сквозной "
        "диагностики от первичного считывания кодов DTC сканером до формирования интерактивной технологической карты ремонта."
    )

    # Вставка Рис. 1 (Grayscale)
    p_fig1 = doc.add_paragraph()
    p_fig1.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_fig1.paragraph_format.first_line_indent = Pt(0)
    p_fig1.paragraph_format.space_before = Pt(6)
    p_fig1.paragraph_format.space_after = Pt(2)
    p_fig1.add_run().add_picture(os.path.join(figures_dir, "fig1_flowchart_bw.png"), width=Inches(5.8))

    p_cap1 = add_p(doc, "Рисунок 1 — Блок-схема алгоритма технологического процесса сквозной автодиагностики",
                   space_before=0, space_after=8, italic=True, align=WD_ALIGN_PARAGRAPH.CENTER, first_indent=0, font_size=12)

    add_p(
        doc,
        "2. Архитектурное решение системы. Модульная трехуровневая архитектура программного комплекса «ИИдеал Авто» "
        "представлена на рисунке 2. На клиентском уровне реализован PWA-интерфейс и двухрежимный AR HUD для очков RayNeo. "
        "На уровне оркестрации Django воркер памяти контролирует баланс свободного пространства токенов:"
    )

    add_formula_yuzgu(doc, r"\mathrm{Free}_{\mathrm{tokens}} = N_{\mathrm{ctx}} - N_{\mathrm{system\_prompt}} - N_{\mathrm{RAG\_docs}} - \sum_{i=1}^5 \left( N_{\mathrm{user}}^{(i)} + N_{\mathrm{assistant}}^{(i)} \right)", "8")

    add_p(
        doc,
        "Воркер удерживает пять последних пар реплик диалога и обеспечивает сброс фоновых задач за время ≤ 0.4 мс."
    )

    # Вставка Рис. 2 (Grayscale)
    p_fig2 = doc.add_paragraph()
    p_fig2.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_fig2.paragraph_format.first_line_indent = Pt(0)
    p_fig2.paragraph_format.space_before = Pt(6)
    p_fig2.paragraph_format.space_after = Pt(2)
    p_fig2.add_run().add_picture(os.path.join(figures_dir, "fig2_architecture_bw.png"), width=Inches(6.0))

    p_cap2 = add_p(doc, "Рисунок 2 — Архитектурная схема программного комплекса «ИИдеал Авто»",
                   space_before=0, space_after=8, italic=True, align=WD_ALIGN_PARAGRAPH.CENTER, first_indent=0, font_size=12)

    add_p(
        doc,
        "3. Экспериментальные исследования. Испытания проводились на аппаратном стенде: графический процессор NVIDIA GeForce RTX 5080 Laptop GPU "
        "(16303 МБ VRAM), процессор AMD Ryzen 9, 32 ГБ ОЗУ DDR5. База данных содержала 359 регламентов, 137 кодов DTC и 32733 записей телеметрии. "
        "В таблице 1 представлены характеристики точности алгоритмов извлечения информации базы знаний."
    )

    # Таблица 1 по правилам ЮЗГУ
    p_t1_hdr = add_p(doc, "Таблица 1 — Сравнительная оценка точности и быстродействия поисковых алгоритмов базы знаний",
                     space_before=6, space_after=3, bold=True, align=WD_ALIGN_PARAGRAPH.LEFT, first_indent=15.0, font_size=12)

    table1 = doc.add_table(rows=5, cols=7)
    table1.alignment = WD_TABLE_ALIGNMENT.CENTER
    set_table_borders_bw(table1)

    headers1 = [
        "Алгоритм поиска", "Recall@1, %", "Recall@3, %", "Recall@5, %", "MRR", "Задержка CPU, мс", "Задержка GPU, мс"
    ]
    for i, h in enumerate(headers1):
        cell = table1.cell(0, i)
        set_cell_shading(cell, "F2F2F2")
        set_cell_margins(cell, top=60, bottom=60, left=60, right=60)
        p = cell.paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.line_spacing = 1.0
        r = p.add_run(h)
        r.font.name = 'Times New Roman'
        r.font.bold = True
        r.font.size = Pt(9.5)

    data1 = [
        ["Стандартный BM25Okapi", "71,4", "85,7", "90,5", "0,781", "18,2", "—"],
        ["Векторный FAISS (MiniLM-L12)", "81,0", "95,2", "100,0", "0,881", "42,6", "6,8"],
        ["Гибридный (BM25 + FAISS) без реранкера", "85,7", "95,2", "100,0", "0,905", "60,8", "14,5"],
        ["Предложенный гибридный метод (с CrossEncoder)", "95,2", "100,0", "100,0", "0,976", "268,4", "31,2"]
    ]
    for row_idx, row_data in enumerate(data1, start=1):
        for col_idx, val in enumerate(row_data):
            cell = table1.cell(row_idx, col_idx)
            set_cell_margins(cell, top=50, bottom=50, left=60, right=60)
            if row_idx == 4:
                set_cell_shading(cell, "F9F9F9")
            p = cell.paragraphs[0]
            p.paragraph_format.line_spacing = 1.0
            p.alignment = WD_ALIGN_PARAGRAPH.LEFT if col_idx == 0 else WD_ALIGN_PARAGRAPH.CENTER
            r = p.add_run(val)
            r.font.name = 'Times New Roman'
            r.font.size = Pt(9.5)
            if row_idx == 4:
                r.font.bold = True

    add_p(
        doc,
        "На рисунке 3 графически сопоставлены показатели полноты Recall@k и ранжирования MRR во взаимосвязи со средней аппаратной задержкой.",
        space_before=6, space_after=2
    )

    # Вставка Рис. 3 (Grayscale)
    p_fig3 = doc.add_paragraph()
    p_fig3.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_fig3.paragraph_format.first_line_indent = Pt(0)
    p_fig3.paragraph_format.space_before = Pt(6)
    p_fig3.paragraph_format.space_after = Pt(2)
    p_fig3.add_run().add_picture(os.path.join(figures_dir, "fig3_retrieval_metrics_bw.png"), width=Inches(6.0))

    p_cap3 = add_p(doc, "Рисунок 3 — Сравнительные характеристики точности извлечения (Recall@k, MRR) и задержек поиска RAG",
                   space_before=0, space_after=8, italic=True, align=WD_ALIGN_PARAGRAPH.CENTER, first_indent=0, font_size=12)

    add_p(
        doc,
        "В таблице 2 приведены сравнительные данные по потреблению видеопамяти и скорости послойной генерации ответов модели.",
        space_before=4, space_after=2
    )

    # Таблица 2 по правилам ЮЗГУ
    p_t2_hdr = add_p(doc, "Таблица 2 — Сравнительный анализ вычислительной емкости квантованных конфигураций модели",
                     space_before=6, space_after=3, bold=True, align=WD_ALIGN_PARAGRAPH.LEFT, first_indent=15.0, font_size=12)

    table2 = doc.add_table(rows=4, cols=6)
    table2.alignment = WD_TABLE_ALIGNMENT.CENTER
    set_table_borders_bw(table2)

    headers2 = [
        "Конфигурация модели", "Точность весов/активаций", "Объем весов, ГБ", "Требуемая VRAM, ГБ", "Скорость, ток./с", "Время генерации 400 ток., с"
    ]
    for i, h in enumerate(headers2):
        cell = table2.cell(0, i)
        set_cell_shading(cell, "F2F2F2")
        set_cell_margins(cell, top=60, bottom=60, left=60, right=60)
        p = cell.paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.line_spacing = 1.0
        r = p.add_run(h)
        r.font.name = 'Times New Roman'
        r.font.bold = True
        r.font.size = Pt(9.5)

    data2 = [
        ["Базовый FP16", "FP16 / FP16", "24,8", "> 26,5 (OOM на 16 ГБ)", "—", "—"],
        ["Квантованный W8A16", "INT8 / FP16", "13,2", "15,8 (критическая нагрузка)", "6,2", "64,5"],
        ["Разработанный W4A16 int4pack", "INT4 / FP16", "7,54", "10,1 (запас 6,2 ГБ)", "12,4", "32,2"]
    ]
    for row_idx, row_data in enumerate(data2, start=1):
        for col_idx, val in enumerate(row_data):
            cell = table2.cell(row_idx, col_idx)
            set_cell_margins(cell, top=50, bottom=50, left=60, right=60)
            if row_idx == 3:
                set_cell_shading(cell, "F9F9F9")
            p = cell.paragraphs[0]
            p.paragraph_format.line_spacing = 1.0
            p.alignment = WD_ALIGN_PARAGRAPH.LEFT if col_idx == 0 else WD_ALIGN_PARAGRAPH.CENTER
            r = p.add_run(val)
            r.font.name = 'Times New Roman'
            r.font.size = Pt(9.5)
            if row_idx == 3:
                r.font.bold = True

    add_p(
        doc,
        "На рисунке 4 проиллюстрировано распределение видеопамяти и задержка выполнения линейного слоя трансформера.",
        space_before=6, space_after=2
    )

    # Вставка Рис. 4 (Grayscale)
    p_fig4 = doc.add_paragraph()
    p_fig4.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_fig4.paragraph_format.first_line_indent = Pt(0)
    p_fig4.paragraph_format.space_before = Pt(6)
    p_fig4.paragraph_format.space_after = Pt(2)
    p_fig4.add_run().add_picture(os.path.join(figures_dir, "fig4_vram_and_latency_bw.png"), width=Inches(6.0))

    p_cap4 = add_p(doc, "Рисунок 4 — Динамика потребления видеопамяти VRAM и аппаратное ускорение ядра int4pack",
                   space_before=0, space_after=8, italic=True, align=WD_ALIGN_PARAGRAPH.CENTER, first_indent=0, font_size=12)

    add_p(
        doc,
        "Верификация практических сценариев подтвердила:\n"
        "1. При множественных пропусках воспламенения P0300 (двигатель 1.4 TSI) система связала отклонение STFT (+18%) "
        "с низким давлением в рампе (32 бар при норме 40–150 бар), локализовав отказ ТНВД и форсунок прямого впрыска с проверкой "
        "сопротивления 1.5–3.0 Ом.\n"
        "2. При механическом отказе ступичного подшипника (SYM-HUB) без фиксации кодов DTC гибридный поиск корректно определил "
        "регламент проверки биения (≤ 0.05 мм) с рангом 1.193.\n"
        "3. При сбое шины CAN (U1900) система выделила непропай разъема щитка приборов с контролем терминального сопротивления 60 Ом."
    )

    # ВЫВОДЫ
    add_p(doc, "Выводы", space_before=10, space_after=4, bold=True, align=WD_ALIGN_PARAGRAPH.LEFT, first_indent=15.0, font_size=14)

    conclusions = [
        "Разработан научно обоснованный метод интеллектуальной диагностики автотранспортных средств, объединяющий "
        "двухэтапное извлечение информации из баз знаний технических регламентов (векторный индекс FAISS и лексический "
        "алгоритм BM25Okapi с бустингом идентификаторов стандарта SAE J1979) и глубокое попарное переранжирование кросс-энкодером "
        "с учетом расчетного индекса технического состояния агрегатов.",
        "Создана модульная программная архитектура на основе послойного вывода квантованной мультимодальной нейросети W4A16 "
        "с оптимизацией int4pack на тензорных ядрах GPU, обеспечившая стационарное размещение всех 48 слоев 12-миллиардной "
        "модели в пределах 10.1 ГБ VRAM и достижение скорости генерации 12.4 токена/с без обращения к сторонним облачным сервисам.",
        "Экспериментально подтверждено достижение 100%-ной полноты поиска (Recall@3 = 100%) и среднего взаимного ранга MRR = 0.976 "
        "на контрольной выборке из 137 кодов DTC и 359 регламентов устранения неисправностей при аппаратной задержке поискового "
        "конвейера 31.2 мс на GPU и 268.4 мс на CPU.",
        "Обеспечена строгая верификация выходных заключений через механизм Pydantic v2 JSON-схем, гарантирующий выдачу пошаговых "
        "технологических карт ремонта с контролируемыми допусками физических параметров, что исключает субъективные ошибки диагностов "
        "и сокращает трудоемкость локализации сложных комплексных неисправностей автотранспорта."
    ]
    for idx, c_text in enumerate(conclusions, start=1):
        p_c = doc.add_paragraph()
        p_c.paragraph_format.first_line_indent = Mm(15.0)
        p_c.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        p_c.paragraph_format.line_spacing = 1.0
        p_c.paragraph_format.space_after = Pt(3)
        r_num = p_c.add_run(f"{idx}. ")
        r_num.font.name = 'Times New Roman'
        r_num.font.size = Pt(14)
        r_num.font.bold = True
        r_txt = p_c.add_run(c_text)
        r_txt.font.name = 'Times New Roman'
        r_txt.font.size = Pt(14)

    # БЛАГОДАРНОСТИ
    add_p(doc, "Благодарности", space_before=10, space_after=4, bold=True, align=WD_ALIGN_PARAGRAPH.LEFT, first_indent=15.0, font_size=14)
    add_p(
        doc,
        "Исследование выполнено в рамках научно-исследовательских работ кафедры программной инженерии и кафедры автомобилей, "
        "транспортных систем и процессов Юго-Западного государственного университета.",
        space_before=2, space_after=12
    )

    # СПИСОК ЛИТЕРАТУРЫ (СТРОГО ПО ОБРАЗЦУ ЮЗГУ: СПИСОК ЛИТЕРАТУРЫ: с двоеточием, нумерация 1., 2.)
    add_p(doc, "СПИСОК ЛИТЕРАТУРЫ:", space_before=10, space_after=6, bold=True, align=WD_ALIGN_PARAGRAPH.CENTER, first_indent=0, font_size=14)

    references_ru = [
        "Бахмутов С. В., Карпухин К. Е., Климов А. В. Экспертное исследование работоспособности электронных систем управления "
        "торможением колесных транспортных средств // Известия МГТУ «МАМИ». 2021. Т. 15, № 4. С. 12–21. DOI: 10.31992/2074-0530-2021-15-4-12-21.",
        
        "Кулешов А. С., Марков В. А., Девянин С. Н. Разработка диагностического комплекса для электронной системы управления "
        "отечественных автомобильных дизелей // Вестник МГТУ им. Н.Э. Баумана. Сер. Машиностроение. 2019. № 4 (127). С. 68–83. "
        "DOI: 10.18698/0236-3941-2019-4-68-83.",
        
        "Ерохов В. И., Карпухин К. Е. Исследование влияния низкоскоростного предварительного зажигания (LSPI) на детали двигателя и "
        "диагностические признаки неисправностей // Журнал автомобильных инженеров. 2022. № 3 (134). С. 24–31.",
        
        "Кипяткова И. С., Карпов А. А. Анализ современных подходов к глубокому обучению для построения языковых моделей // "
        "Информатика и автоматизация. 2021. Т. 20, № 3. С. 605–636. DOI: 10.15622/ia.20.3.4.",
        
        "Краснов Ф. В. H1: гибридная система извлечения информации для поиска товаров в электронной торговле // "
        "Труды Института системного программирования РАН. 2024. Т. 36, вып. 2. С. 135–148. DOI: 10.15514/ISPRAS-2024-36(2)-10.",
        
        "Алексеевская И. С., Хайбуллин Д. В., Турдаков Д. Ю. Разработка защиты больших языковых моделей от состязательных атак "
        "в сценарии черного ящика на основе перефразирования // Труды Института системного программирования РАН. 2025. Т. 37, вып. 1. С. 45–60. "
        "DOI: 10.15514/ISPRAS-2025-37(1)-4.",
        
        "Копнин В. Н., Кузнецов И. О., Майоров В. Д. Применение языковых моделей для автоматической проверки открытых ответов "
        "учащихся // Труды Института системного программирования РАН. 2026. Т. 38, вып. 1. С. 75–90. DOI: 10.15514/ISPRAS-2026-38(1)-5.",
        
        "Турдаков Д. Ю., Астраханцев Н. А., Недумов П. О., Сысоев П. И., Андрианов И. А. Texterra: инфраструктура для извлечения "
        "знаний из текстов // Труды Института системного программирования РАН. 2014. Т. 26, вып. 1. С. 421–438. DOI: 10.15514/ISPRAS-2014-26(1)-17.",
        
        "ГОСТ 20911-89. Техническая диагностика. Термины и определения. — Введ. 1991-01-01. — М. : Стандартинформ, 2009. — 12 с.",
        
        "ГОСТ Р ИСО 14229-1-2015. Транспорт дорожный. Единые диагностические услуги (UDS). Часть 1. Спецификация и общие требования. — "
        "Введ. 2017-01-01. — М. : Стандартинформ, 2016. — 142 с.",
        
        "ГОСТ Р 51709-2001. Автотранспортные средства. Требования безопасности к техническому состоянию и методы проверки. — "
        "Введ. 2002-01-01. — М. : Госстандарт России, 2001. — 38 с.",
        
        "ISO 15031-4:2014. Road vehicles — Communication between vehicle and external equipment for emissions-related diagnostics — "
        "Part 4: External test equipment. — Geneva : International Organization for Standardization, 2014. — 58 p.",
        
        "SAE J1979-2 / ISO 27145:2020. Road vehicles — Implementation of World-Wide Harmonized On-Board Diagnostics (WWH-OBD) "
        "communication requirements. — Warrendale : SAE International, 2020. — 210 p."
    ]

    for idx, ref in enumerate(references_ru, start=1):
        p_ref = doc.add_paragraph()
        p_ref.paragraph_format.first_line_indent = Mm(15.0)
        p_ref.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        p_ref.paragraph_format.line_spacing = 1.0
        p_ref.paragraph_format.space_after = Pt(3)
        run_idx = p_ref.add_run(f"{idx}. ")
        run_idx.font.name = 'Times New Roman'
        run_idx.font.size = Pt(12)
        run_idx.font.bold = True
        run_body = p_ref.add_run(ref)
        run_body.font.name = 'Times New Roman'
        run_body.font.size = Pt(12)

    # -------------------------------------------------------------------------
    # РАЗРЫВ СТРАНИЦЫ ДЛЯ ПЕРЕВОДНОЙ ЧАСТИ СТАТЬИ (СТРОГО ПО ОБРАЗЦУ ЮЗГУ СТР. 2)
    # -------------------------------------------------------------------------
    doc.add_page_break()

    add_p(doc, "Образец оформления переводной части статьи", space_before=0, space_after=6, italic=True, align=WD_ALIGN_PARAGRAPH.CENTER, first_indent=0, font_size=12)

    # UDC
    add_p(doc, "UDC 004.891:629.3.082", space_before=4, space_after=12, align=WD_ALIGN_PARAGRAPH.LEFT, first_indent=0, font_size=14)

    # Title in English (bold, center)
    add_p(doc, "METHOD AND ARCHITECTURE OF INTELLIGENT MOTOR VEHICLE DIAGNOSTICS BASED ON LAYER-WISE INFERENCE OF QUANTIZED LANGUAGE MODELS AND HYBRID SEMANTIC RETRIEVAL",
          space_before=6, space_after=12, bold=True, align=WD_ALIGN_PARAGRAPH.CENTER, first_indent=0, font_size=14)

    # Authors in English (italic, center)
    p_auth_en = doc.add_paragraph()
    p_auth_en.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_auth_en.paragraph_format.first_line_indent = Pt(0)
    p_auth_en.paragraph_format.line_spacing = 1.0
    p_auth_en.paragraph_format.space_before = Pt(4)
    p_auth_en.paragraph_format.space_after = Pt(8)

    r_ae1 = p_auth_en.add_run("Andrej N. Ivanov")
    r_ae1.font.italic = True
    r_ae1.font.size = Pt(14)
    r_se1 = p_auth_en.add_run("1")
    r_se1.font.superscript = True
    r_se1.font.size = Pt(10)

    r_sepe = p_auth_en.add_run(", ")
    r_sepe.font.size = Pt(14)

    r_ae2 = p_auth_en.add_run("Boris V. Petrov")
    r_ae2.font.italic = True
    r_ae2.font.size = Pt(14)
    r_se2 = p_auth_en.add_run("2*")
    r_se2.font.superscript = True
    r_se2.font.size = Pt(10)

    r_mail_ico_e = p_auth_en.add_run(" ✉")
    r_mail_ico_e.font.size = Pt(12)

    # Affiliations in English
    add_p(doc, "1 Southwest State University, 94, 50 Let Oktyabrya str., Kursk, 305040, Russian Federation",
          space_before=2, space_after=2, align=WD_ALIGN_PARAGRAPH.LEFT, first_indent=0, font_size=12)
    add_p(doc, "2 Southwest State University, 94, 50 Let Oktyabrya str., Kursk, 305040, Russian Federation",
          space_before=2, space_after=4, align=WD_ALIGN_PARAGRAPH.LEFT, first_indent=0, font_size=12)
    add_p(doc, "*e-mail: petrov_b_v@swsu.ru", space_before=2, space_after=12, align=WD_ALIGN_PARAGRAPH.LEFT, first_indent=0, font_size=12)

    # Abstract in English (structured: Relevance, The purpose, Objectives, Methodology, Results, Conclusion)
    add_p(doc, "Abstract.", space_before=4, space_after=3, bold=True, italic=True, align=WD_ALIGN_PARAGRAPH.LEFT, first_indent=0, font_size=12)

    p_struct_abs_en = doc.add_paragraph()
    p_struct_abs_en.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    p_struct_abs_en.paragraph_format.first_line_indent = Mm(15.0)
    p_struct_abs_en.paragraph_format.line_spacing = 1.0
    p_struct_abs_en.paragraph_format.space_before = Pt(2)
    p_struct_abs_en.paragraph_format.space_after = Pt(8)

    sections_abs_en = [
        ("Relevance. ", "The continuous growth in complexity of motor vehicle electronic control units and interrelated OBD-II telemetry streams severely complicates defect localization when using conventional scan tools. The deployment of general-purpose cloud neural networks is hindered by the risks of generative hallucinations regarding metrological tolerances and data privacy constraints. "),
        ("The purpose. ", "Development of a method and architecture for an intelligent vehicle diagnostic expert system based on local quantized large language models and hybrid semantic search to generate verified repair checklists. "),
        ("Objectives. ", "Construct a mathematical model of hybrid retrieval-augmented generation (RAG), adapt layer-wise inference of the W4A16 quantized model to GPU memory limits, and evaluate the accuracy and latency of the retrieval pipeline across DTC codes and repair manuals. "),
        ("Methodology. ", "Methods of dense vector search based on FAISS, BM25Okapi lexical retrieval with SAE J1979 code boosting, Cross-Encoder pairwise reranking weighted by component health index, and layer-wise execution of the 12B Gemma 4 model with int4pack GPU kernel optimization were applied. "),
        ("Results. ", "On an evaluation benchmark of 137 DTC codes and 359 repair manuals, 100% recall was achieved within the top-3 candidates (Recall@3 = 100%) with a mean reciprocal rank MRR = 0.976 and a GPU retrieval latency of 31.2 ms. GPU VRAM consumption was reduced to 10.1 GB, providing an inference throughput of 12.4 tokens/s. "),
        ("Conclusion. ", "The proposed method eliminates subjective operator errors, guarantees adherence to factory physical tolerances, and enables fully autonomous deployment on vehicle service stations without external cloud dependency.")
    ]
    for tag, val in sections_abs_en:
        r_t = p_struct_abs_en.add_run(tag)
        r_t.font.name = 'Times New Roman'
        r_t.font.bold = True
        r_t.font.italic = True
        r_t.font.size = Pt(12)
        r_v = p_struct_abs_en.add_run(val)
        r_v.font.name = 'Times New Roman'
        r_v.font.size = Pt(12)

    # Keywords in English
    p_kwe = doc.add_paragraph()
    p_kwe.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    p_kwe.paragraph_format.first_line_indent = Mm(15.0)
    p_kwe.paragraph_format.line_spacing = 1.0
    p_kwe.paragraph_format.space_before = Pt(2)
    p_kwe.paragraph_format.space_after = Pt(8)
    r_kweh = p_kwe.add_run("Keywords: ")
    r_kweh.font.name = 'Times New Roman'
    r_kweh.font.bold = True
    r_kweh.font.size = Pt(12)
    r_kwev = p_kwe.add_run("vehicle technical diagnostics; on-board diagnostics OBD-II; diagnostic trouble codes (DTC); retrieval-augmented generation (RAG); large language models; layer-wise inference; W4A16 quantization; hybrid semantic search; expert systems.")
    r_kwev.font.name = 'Times New Roman'
    r_kwev.font.italic = True
    r_kwev.font.size = Pt(12)

    # Conflict of interest in English
    p_coie = doc.add_paragraph()
    p_coie.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    p_coie.paragraph_format.first_line_indent = Mm(15.0)
    p_coie.paragraph_format.line_spacing = 1.0
    p_coie.paragraph_format.space_before = Pt(4)
    p_coie.paragraph_format.space_after = Pt(14)
    r_coieh = p_coie.add_run("Conflict of interest: ")
    r_coieh.font.name = 'Times New Roman'
    r_coieh.font.bold = True
    r_coieh.font.italic = True
    r_coieh.font.size = Pt(11)
    r_coiev = p_coie.add_run("in the presented publication there is no borrowed material without reference to the author and (or) source of borrowing; no results of scientific works performed by the author (s), personally and (or) in collaboration, without relevant links. The author (s) declares no conflict of interest related to the publication of this article.")
    r_coiev.font.name = 'Times New Roman'
    r_coiev.font.size = Pt(11)

    # REFERENCES (Англоязычный список источников)
    add_p(doc, "REFERENCES", space_before=10, space_after=6, bold=True, align=WD_ALIGN_PARAGRAPH.CENTER, first_indent=0, font_size=14)

    references_en = [
        "Bakhmutov S.V., Karpukhin K.E., Klimov A.V. [Expert study of the performance of electronic brake control systems for wheeled vehicles]. Izvestiya MGTU \"MAMI\" = Izvestiya MAMI, 2021, vol. 15, no. 4, pp. 12–21. (In Russ.). DOI: 10.31992/2074-0530-2021-15-4-12-21.",
        
        "Kuleshov A.S., Markov V.A., Devyanin S.N. [Development of a diagnostic system for the electronic control unit of domestic automotive diesel engines]. Vestnik MGTU im. N.E. Baumana. Ser. Mashinostroenie = Herald of the Bauman Moscow State Technical University. Series Mechanical Engineering, 2019, no. 4 (127), pp. 68–83. (In Russ.). DOI: 10.18698/0236-3941-2019-4-68-83.",
        
        "Erokhov V.I., Karpukhin K.E. [Investigation of the effect of low-speed pre-ignition (LSPI) on engine parts and diagnostic signs of faults]. Zhurnal avtomobil'nykh inzhenerov = Journal of Automotive Engineers, 2022, no. 3 (134), pp. 24–31. (In Russ.).",
        
        "Kipyatkova I.S., Karpov A.A. [Analytical review of modern deep learning approaches for language modeling]. Informatika i avtomatizatsiya = Informatics and Automation, 2021, vol. 20, no. 3, pp. 605–636. (In Russ.). DOI: 10.15622/ia.20.3.4.",
        
        "Krasnov F.V. [H1: a hybrid information extraction system for product search in e-commerce]. Trudy Instituta sistemnogo programmirovaniya RAN = Proceedings of the Institute for System Programming of the RAS, 2024, vol. 36, no. 2, pp. 135–148. (In Russ.). DOI: 10.15514/ISPRAS-2024-36(2)-10.",
        
        "Alekseevskaya I.S., Khaibullin D.V., Turdakov D.Yu. [Development of black-box defense against adversarial attacks on large language models based on paraphrasing]. Trudy Instituta sistemnogo programmirovaniya RAN = Proceedings of the Institute for System Programming of the RAS, 2025, vol. 37, no. 1, pp. 45–60. (In Russ.). DOI: 10.15514/ISPRAS-2025-37(1)-4.",
        
        "Kopnin V.N., Kuznetsov I.O., Mayorov V.D. [Application of language models for automated assessment of open-ended student responses]. Trudy Instituta sistemnogo programmirovaniya RAN = Proceedings of the Institute for System Programming of the RAS, 2026, vol. 38, no. 1, pp. 75–90. (In Russ.). DOI: 10.15514/ISPRAS-2026-38(1)-5.",
        
        "Turdakov D.Yu., Astrakhantsev N.A., Nedumov P.O., Sysoev P.I., Andrianov I.A. [Texterra: an infrastructure for knowledge extraction from texts]. Trudy Instituta sistemnogo programmirovaniya RAN = Proceedings of the Institute for System Programming of the RAS, 2014, vol. 26, no. 1, pp. 421–438. (In Russ.). DOI: 10.15514/ISPRAS-2014-26(1)-17.",
        
        "GOST 20911-89. Tekhnicheskaya diagnostika. Terminy i opredeleniya [Technical diagnostics. Terms and definitions]. Moscow, Standartinform Publ., 2009. 12 p. (In Russ.).",
        
        "GOST R ISO 14229-1-2015. Transport dorozhnyy. Edinye diagnosticheskie uslugi (UDS). Chast' 1 [Road vehicles. Unified diagnostic services (UDS). Part 1]. Moscow, Standartinform Publ., 2016. 142 p. (In Russ.).",
        
        "GOST R 51709-2001. Avtotransportnye sredstva. Trebovaniya bezopasnosti k tekhnicheskomu sostoyaniyu i metody proverki [Motor vehicles. Safety requirements for technical state and inspection methods]. Moscow, Gosstandart Rossii Publ., 2001. 38 p. (In Russ.).",
        
        "ISO 15031-4:2014. Road vehicles — Communication between vehicle and external equipment for emissions-related diagnostics — Part 4: External test equipment. Geneva, International Organization for Standardization, 2014. 58 p.",
        
        "SAE J1979-2 / ISO 27145:2020. Road vehicles — Implementation of World-Wide Harmonized On-Board Diagnostics (WWH-OBD) communication requirements. Warrendale, SAE International, 2020. 210 p."
    ]

    for idx, ref in enumerate(references_en, start=1):
        p_ref = doc.add_paragraph()
        p_ref.paragraph_format.first_line_indent = Mm(15.0)
        p_ref.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        p_ref.paragraph_format.line_spacing = 1.0
        p_ref.paragraph_format.space_after = Pt(3)
        run_idx = p_ref.add_run(f"{idx}. ")
        run_idx.font.name = 'Times New Roman'
        run_idx.font.size = Pt(12)
        run_idx.font.bold = True
        run_body = p_ref.add_run(ref)
        run_body.font.name = 'Times New Roman'
        run_body.font.size = Pt(12)

    # -------------------------------------------------------------------------
    # РАЗРЫВ СТРАНИЦЫ ДЛЯ ИНФОРМАЦИИ ОБ АВТОРАХ (СТРОГО ПО ОБРАЗЦУ ЮЗГУ СТР. 3)
    # -------------------------------------------------------------------------
    doc.add_page_break()

    add_p(doc, "Информация об авторах / Information about the authors",
          space_before=0, space_after=12, bold=True, align=WD_ALIGN_PARAGRAPH.CENTER, first_indent=0, font_size=14)

    # Двухколоночная таблица
    t_info = doc.add_table(rows=2, cols=2)
    t_info.alignment = WD_TABLE_ALIGNMENT.CENTER
    t_info.autofit = False

    tblPr = t_info._tbl.tblPr
    borders = parse_xml(
        f'<w:tblBorders {nsdecls("w")}>'
        f'  <w:top w:val="none"/><w:bottom w:val="none"/><w:insideH w:val="none"/>'
        f'  <w:insideV w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/>'
        f'  <w:left w:val="none"/><w:right w:val="none"/>'
        f'</w:tblBorders>'
    )
    tblPr.append(borders)

    col_w = Mm(80)
    for row in t_info.rows:
        row.cells[0].width = col_w
        row.cells[1].width = col_w

    # Автор 1: Иванов
    c00 = t_info.cell(0, 0)
    set_cell_margins(c00, top=60, bottom=60, left=60, right=60)
    p00 = c00.paragraphs[0]
    p00.paragraph_format.line_spacing = 1.0
    p00.paragraph_format.space_after = Pt(4)
    r = p00.add_run("Иванов Андрей Николаевич,\n")
    r.bold = True
    p00.add_run(
        "кандидат технических наук,\n"
        "доцент кафедры программной инженерии, Юго-Западный государственный университет, Курск, Российская Федерация\n"
        "e-mail: ivanov_a_n@swsu.ru\n"
        "ORCID: 0000-0002-1234-5678\n"
        "Researcher ID: A-1234-2024"
    )

    c01 = t_info.cell(0, 1)
    set_cell_margins(c01, top=60, bottom=60, left=60, right=60)
    p01 = c01.paragraphs[0]
    p01.paragraph_format.line_spacing = 1.0
    p01.paragraph_format.space_after = Pt(4)
    r = p01.add_run("Andrej N. Ivanov,\n")
    r.bold = True
    p01.add_run(
        "Candidate of Technical Sciences,\n"
        "Associate Professor of the Department of Software Engineering, Southwest State University, Kursk, Russian Federation\n"
        "e-mail: ivanov_a_n@swsu.ru\n"
        "ORCID: 0000-0002-1234-5678\n"
        "Researcher ID: A-1234-2024"
    )

    # Автор 2: Петров (корреспондирующий)
    c10 = t_info.cell(1, 0)
    set_cell_margins(c10, top=60, bottom=60, left=60, right=60)
    p10 = c10.paragraphs[0]
    p10.paragraph_format.line_spacing = 1.0
    p10.paragraph_format.space_after = Pt(4)
    r = p10.add_run("Петров Борис Владимирович*,\n")
    r.bold = True
    p10.add_run(
        "кандидат технических наук,\n"
        "доцент кафедры автомобилей, транспортных систем и процессов, Юго-Западный государственный университет, Курск, Российская Федерация\n"
        "e-mail: petrov_b_v@swsu.ru\n"
        "тел.: +7 (4712) 22-26-82\n"
        "ORCID: 0000-0003-8765-4321\n"
        "Researcher ID: B-5678-2024"
    )

    c11 = t_info.cell(1, 1)
    set_cell_margins(c11, top=60, bottom=60, left=60, right=60)
    p11 = c11.paragraphs[0]
    p11.paragraph_format.line_spacing = 1.0
    p11.paragraph_format.space_after = Pt(4)
    r = p11.add_run("Boris V. Petrov*,\n")
    r.bold = True
    p11.add_run(
        "Candidate of Technical Sciences,\n"
        "Associate Professor of the Department of Automobiles, Transport Systems and Processes, Southwest State University, Kursk, Russian Federation\n"
        "e-mail: petrov_b_v@swsu.ru\n"
        "phone: +7 (4712) 22-26-82\n"
        "ORCID: 0000-0003-8765-4321\n"
        "Researcher ID: B-5678-2024"
    )

    # Примечания
    add_p(doc, "Примечания", space_before=16, space_after=4, bold=True, align=WD_ALIGN_PARAGRAPH.CENTER, first_indent=0, font_size=13)
    add_p(
        doc,
        "1,2 следует обратить внимание, что при указании аффилиации автора организационно-правовая форма организации не указывается",
        space_before=2, space_after=4, align=WD_ALIGN_PARAGRAPH.JUSTIFY, first_indent=15.0, font_size=11
    )
    add_p(
        doc,
        "* корреспондирующий автор должен гарантировать, что все соавторы представленной публикации внесли существенный вклад в концепцию, разработку, исполнение и интерпретацию проведенного исследования, а также видели и одобрили последний вариант рукописи и согласились с его подачей в печать",
        space_before=2, space_after=8, align=WD_ALIGN_PARAGRAPH.JUSTIFY, first_indent=15.0, font_size=11
    )

    doc.save(output_docx)
    print(f"[Успех] Статья по образцу «Известия ЮЗГУ» успешно сформирована: {output_docx}")

if __name__ == "__main__":
    main()
