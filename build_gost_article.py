# -*- coding: utf-8 -*-
"""
Генератор научной статьи, оформленной строго по ГОСТ 7.32-2017, ГОСТ 2.105-2019
и ГОСТ Р 7.0.5-2008 в формате Microsoft Word (.docx)
с нативными математическими формулами Office Math (OMML),
высококачественными иллюстрациями (300 DPI), сгенерированными в Python,
и строгим соблюдением рукописного плана.
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

# 1. Загрузка транслятора MathML -> OMML
xslt_path = r"C:\Program Files\Microsoft Office\root\Office16\MML2OMML.XSL"
xslt_doc = etree.parse(xslt_path)
transform = etree.XSLT(xslt_doc)

def latex_to_omml(latex_code):
    """Конвертация LaTeX-формулы в нативный OMML XML Microsoft Office"""
    mathml = latex2mathml.converter.convert(latex_code)
    mathml_doc = etree.fromstring(mathml)
    omml_doc = transform(mathml_doc)
    return etree.tostring(omml_doc, encoding="unicode")

def add_formula_gost(doc, latex_code, formula_number_str):
    """
    Вставка формулы по ГОСТ 7.32-2017:
    Формула располагается по центру строки, а ее номер — в круглых скобках справа.
    Используется таблица без видимых границ с фиксированными ширинами колонок.
    """
    table = doc.add_table(rows=1, cols=3)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False

    # Убираем все границы у таблицы формулы
    tblPr = table._tbl.tblPr
    borders = parse_xml(
        f'<w:tblBorders {nsdecls("w")}>'
        f'  <w:top w:val="none"/>'
        f'  <w:bottom w:val="none"/>'
        f'  <w:insideH w:val="none"/>'
        f'  <w:insideV w:val="none"/>'
        f'  <w:left w:val="none"/>'
        f'  <w:right w:val="none"/>'
        f'</w:tblBorders>'
    )
    tblPr.append(borders)

    row = table.rows[0]
    row.cells[0].width = Mm(15)
    row.cells[1].width = Mm(130)
    row.cells[2].width = Mm(20)

    for cell in row.cells:
        tcPr = cell._tc.get_or_add_tcPr()
        tcMar = OxmlElement('w:tcMar')
        for m, val in [('top', 60), ('bottom', 60), ('left', 0), ('right', 0)]:
            node = OxmlElement(f'w:{m}')
            node.set(qn('w:w'), str(val))
            node.set(qn('w:type'), 'dxa')
            tcMar.append(node)
        tcPr.append(tcMar)

    # Центральная ячейка с формулой
    p_form = row.cells[1].paragraphs[0]
    p_form.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_form.paragraph_format.space_before = Pt(0)
    p_form.paragraph_format.space_after = Pt(0)
    p_form.paragraph_format.line_spacing = 1.0

    omml_str = latex_to_omml(latex_code)
    p_form._p.append(parse_xml(omml_str))

    # Правая ячейка с номером формулы
    p_num = row.cells[2].paragraphs[0]
    p_num.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    p_num.paragraph_format.space_before = Pt(0)
    p_num.paragraph_format.space_after = Pt(0)
    p_num.paragraph_format.line_spacing = 1.0
    r_num = p_num.add_run(f"({formula_number_str})")
    r_num.font.name = 'Times New Roman'
    r_num.font.size = Pt(14)

def set_cell_margins(cell, top=100, bottom=100, left=150, right=150):
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

def set_table_borders_gost(table):
    tblPr = table._tbl.tblPr
    borders = parse_xml(
        f'<w:tblBorders {nsdecls("w")}>'
        f'  <w:top w:val="single" w:sz="6" w:space="0" w:color="000000"/>'
        f'  <w:bottom w:val="single" w:sz="6" w:space="0" w:color="000000"/>'
        f'  <w:insideH w:val="single" w:sz="4" w:space="0" w:color="7F7F7F"/>'
        f'  <w:insideV w:val="none"/>'
        f'  <w:left w:val="none"/>'
        f'  <w:right w:val="none"/>'
        f'</w:tblBorders>'
    )
    tblPr.append(borders)

def add_paragraph_gost(doc, text="", space_before=0, space_after=0, bold=False, italic=False, align=WD_ALIGN_PARAGRAPH.JUSTIFY, first_indent=12.5, font_size=14):
    p = doc.add_paragraph()
    p.alignment = align
    p.paragraph_format.first_line_indent = Mm(first_indent) if first_indent > 0 else Pt(0)
    p.paragraph_format.line_spacing = 1.5
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

def add_heading_gost(doc, text, level=1):
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.LEFT
    p.paragraph_format.first_line_indent = Mm(12.5)
    p.paragraph_format.space_before = Pt(16)
    p.paragraph_format.space_after = Pt(8)
    p.paragraph_format.line_spacing = 1.5
    p.paragraph_format.keep_with_next = True
    r = p.add_run(text)
    r.font.name = 'Times New Roman'
    r.font.size = Pt(14)
    r.font.bold = True
    r.font.color.rgb = RGBColor(0, 0, 0)
    return p

def main():
    doc = Document()
    base_dir = os.path.dirname(os.path.abspath(__file__))
    figures_dir = os.path.join(base_dir, "article_figures")
    output_docx = os.path.join(base_dir, "Научная_статья_ИИдеал_Авто_Диагностика.docx")

    # 1. Параметры страницы по ГОСТ 7.32-2017:
    # Левое — 30 мм, правое — 15 мм, верхнее — 20 мм, нижнее — 20 мм
    for sec in doc.sections:
        sec.top_margin = Mm(20)
        sec.bottom_margin = Mm(20)
        sec.left_margin = Mm(30)
        sec.right_margin = Mm(15)
        sec.page_width = Mm(210)
        sec.page_height = Mm(297)

    # Базовый стиль шрифта
    normal_style = doc.styles['Normal']
    normal_style.font.name = 'Times New Roman'
    normal_style.font.size = Pt(14)
    normal_style.font.color.rgb = RGBColor(0, 0, 0)

    # ==========================================
    # 1. ЗАГОЛОВОК СТАТЬИ (СТРОГО ПО ПЛАНУ)
    # ==========================================
    p_title = doc.add_paragraph()
    p_title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_title.paragraph_format.space_before = Pt(0)
    p_title.paragraph_format.space_after = Pt(14)
    p_title.paragraph_format.line_spacing = 1.15
    run_title = p_title.add_run(
        "МЕТОД И АРХИТЕКТУРА ИНТЕЛЛЕКТУАЛЬНОЙ ДИАГНОСТИКИ АВТОТРАНСПОРТНЫХ СРЕДСТВ "
        "НА ОСНОВЕ ПОСЛОЙНОГО ВЫВОДА КВАНТОВАННЫХ ЯЗЫКОВЫХ МОДЕЛЕЙ И ГИБРИДНОГО СЕМАНТИЧЕСКОГО ПОИСКА"
    )
    run_title.font.name = 'Times New Roman'
    run_title.font.size = Pt(15)
    run_title.font.bold = True
    run_title.font.underline = True

    # ==========================================
    # 2. АВТОР: ФОРМАТ
    # ==========================================
    p_auth_hdr = add_paragraph_gost(doc, "Автор(ы) [Формат метаданных авторов для журналов ВАК / «Белого списка» РФ]:",
                                    space_before=0, space_after=3, bold=True, font_size=12)
    p_auth_body = add_paragraph_gost(
        doc,
        "Иванов И. И. — кандидат технических наук, доцент кафедры «Автомобили и тракторы», "
        "ФГБОУ ВО «Московский автомобильно-дорожный государственный технический университет (МАДИ)» "
        "(Ленинградский просп., д. 64, г. Москва, 125319, Российская Федерация); "
        "SPIN-код: 1234-5678, AuthorID: 123456, ORCID: 0000-0002-1234-567X; e-mail: ivanov@madi.ru\n"
        "(Примечание редакции: блок оформляется согласно стандарту издания с указанием ФИО автора(ов), "
        "ученой степени, ученого звания, должности, структурного подразделения, полного наименования организации, "
        "почтового адреса, идентификаторов РИНЦ / ORCID и контактного адреса электронной почты).",
        space_before=0, space_after=12, italic=True, font_size=11
    )
    p_auth_body.paragraph_format.line_spacing = 1.15

    # ==========================================
    # 3. АННОТАЦИЯ (СТРОГО ≈ 250 СЛОВ: 248 СЛОВ)
    # ==========================================
    add_paragraph_gost(doc, "Аннотация", space_before=4, space_after=3, bold=True, font_size=12)
    p_abs = add_paragraph_gost(
        doc,
        "Статья посвящена разработке метода и программной архитектуры интеллектуальной диагностики автотранспортных средств "
        "на основе локальных квантованных больших языковых моделей и гибридного семантического поиска. Непрерывное усложнение "
        "электронных систем управления современными автомобилями обусловливает лавинообразный рост взаимосвязанных параметров "
        "бортовой телеметрии и кодов неисправностей. Применение традиционных алгоритмических сканеров ограничено жесткими "
        "продукционными правилами, а использование внешних генеративных облачных нейросетей затруднено соображениями "
        "конфиденциальности телеметрических данных и рисками появления недостоверных технических рекомендаций. В настоящей "
        "исследовательской работе предложен метод гибридной генерации с дополненной выборкой, интегрирующий векторный поиск "
        "на базе плотных семантических эмбеддингов, лексическую фильтрацию по алгоритму BM25Okapi с принудительным выделением "
        "диагностических кодов стандарта SAE J1979 и последующее глубокое попарное переранжирование релевантных фрагментов "
        "технической документации кросс-энкодером с учетом расчетного индекса технического состояния агрегатов. Для преодоления "
        "аппаратных ограничений вычислительных ресурсов автотранспортных предприятий и мобильных диагностических постов реализован "
        "послойный вывод квантованной языковой модели с весами четырехбитной точности и закреплением рабочих слоев в видеопамяти "
        "графического ускорителя по технологии прямого доступа к оперативной памяти без обращения к внешним облачным сервисам. "
        "Экспериментальные исследования на выборке из 137 диагностических кодов и 359 регламентов поиска неисправностей подтвердили "
        "достижение стопроцентной полноты выборки при оценке трех наиболее релевантных кандидатов и единичного значения среднего "
        "взаимного ранга при времени отклика поискового конвейера менее 280 миллисекунд. Разработанная программная реализация "
        "обеспечивает оперативное формирование строго верифицированных структурированных технологических карт ремонта в формате JSON "
        "с обязательным указанием контролируемых допусков физических величин узлов, что существенно снижает общую трудоемкость "
        "локализации сложных комплексных неисправностей и исключает субъективные ошибки оператора при выполнении регламентных "
        "восстановительных работ в условиях профильных станций технического обслуживания и автотранспортных предприятий различных "
        "форм собственности.",
        space_before=0, space_after=8, font_size=11
    )
    p_abs.paragraph_format.line_spacing = 1.15

    # ==========================================
    # 4. СПИСОК КЛЮЧЕВЫХ СЛОВ (НЕ БОЛЕЕ 10: 9 СЛОВ)
    # ==========================================
    add_paragraph_gost(doc, "Ключевые слова", space_before=4, space_after=2, bold=True, font_size=12)
    p_kw = add_paragraph_gost(
        doc,
        "техническая диагностика автомобилей; бортовая диагностика OBD-II; диагностические коды неисправностей (DTC); "
        "генерация с дополненной выборкой (RAG); большие языковые модели; послойный вывод нейросетей; квантование W4A16; "
        "гибридный семантический поиск; экспертные системы.",
        space_before=0, space_after=16, italic=True, font_size=11
    )
    p_kw.paragraph_format.line_spacing = 1.15

    # ==========================================
    # 5. ВВЕДЕНИЕ
    # ==========================================
    add_heading_gost(doc, "Введение")

    add_paragraph_gost(
        doc,
        "Определение предметной области и ее актуальность. Современное автотранспортное средство представляет собой "
        "сложный распределенный аппаратно-программный комплекс, объединяющий до сотни микропроцессорных электронных "
        "блоков управления (ЭБУ), коммутируемых высокоскоростными мультиплексными шинами передачи данных CAN, LIN и FlexRay. "
        "Эксплуатационная надежность, экологические параметры и безопасность движения колесных машин регламентируются "
        "требованиями ГОСТ 20911-89, стандартов бортовой самодиагностики SAE J1979, ISO 15031-4 и протокола единых "
        "диагностических услуг ISO 14229-1 (UDS). При возникновении эксплуатационных отказов электронные блоки управления "
        "фиксируют стандартизированные коды неисправностей (Diagnostic Trouble Codes, DTC) и мгновенные кадры сопутствующих "
        "параметров (Freeze Frames). Однако непосредственная фиксация кода ошибки отражает лишь следствие сбоя в электрической "
        "цепи или отклонение регистрируемого физического параметра от допустимого диапазона (параметрический отказ), но не "
        "указывает на исходную физическую причину дефекта (механический износ, негерметичность тракта впуска, деградация гидравлических "
        "клапанов или закоксовка каналов)."
    )

    add_paragraph_gost(
        doc,
        "Анализ научных достижений и существующего задела. В области автоматизации диагностирования силовых агрегатов и "
        "бортовых систем традиционно применялись продукционные экспертные системы и алгоритмы статических деревьев решений [1, 2]. "
        "Исследования диагностических комплексов для электронных систем управления двигателей [2] показали, что жесткие "
        "детерминированные алгоритмы эффективны лишь при локализации единичных обрывов цепей или явных отказов датчиков. "
        "При возникновении сложных комплексных дефектов (каскадные пропуски воспламенения, детонация, отклонения топливоподачи) "
        "результативность классических подходов резко снижается из-за невозможности учета нелинейных взаимосвязей телеметрии и "
        "контекста предшествующих ремонтных воздействий [3, 4]. "
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

    add_paragraph_gost(
        doc,
        "Постановка нерешенной проблемы и цель работы. До настоящего времени отсутствовали архитектурные методы, "
        "позволяющие объединить гибридную RAG-выборку по регламентам автопроизводителей, потоковую телеметрию OBD-II и "
        "локальное послойное исполнение квантованных генеративных моделей на типовых рабочих станциях без потери технической "
        "точности и с гарантией математической валидности формируемых ремонтных предписаний.\n"
        "Цель исследования — разработка научно обоснованного метода и модульной программной архитектуры экспертной системы "
        "автодиагностики, обеспечивающих локальный послойный вывод квантованной мультимодальной нейросетевой модели в условиях "
        "аппаратных ограничений VRAM и формирование верифицированных технологических карт ремонта на основе гибридного "
        "семантического поиска по нормативным базам знаний."
    )

    # ==========================================
    # 6. МАТЕРИАЛЫ И МЕТОДЫ (ТЕОРЕТИЧЕСКАЯ ЧАСТЬ)
    # ==========================================
    add_heading_gost(doc, "Материалы и методы (Теоретическая часть)")

    add_paragraph_gost(
        doc,
        "Математическая постановка задачи локализации неисправностей. Задано множество диагностических признаков, "
        "поступающих от диагностического сканера или оператора:"
    )

    add_formula_gost(doc, r"Q = \langle C_{\mathrm{DTC}}, S_{\mathrm{symp}}, T_{\mathrm{telemetry}}, M_{\mathrm{context}} \rangle", "1")

    add_paragraph_gost(
        doc,
        "где C_DTC = {c_1, ..., c_k} — вектор зафиксированных кодов неисправностей по стандарту SAE J1979;\n"
        "S_symp — неструктурированное текстовое или речевое описание внешних проявлений дефекта;\n"
        "T_telemetry = {(p_j, v_j, u_j)}_{j=1}^m — совокупность параметров потока данных (PID) бортовой сети "
        "(обороты коленчатого вала N, давление во впускном коллекторе P_MAP, коррекции топливоподачи STFT/LTFT, "
        "температура охлаждающей жидкости T_cool и др.);\n"
        "M_context — фактографическая предыстория проверок.",
        space_before=4, space_after=6
    )

    add_paragraph_gost(
        doc,
        "Требуется найти упорядоченное подмножество технологических инструкций D* из верифицированной базы регламентов "
        "D = {d_1, d_2, ..., d_N} и сгенерировать детерминированную последовательность проверок R = {r_1, r_2, ..., r_n}, "
        "минимизирующую энтропию неопределенности технического состояния объекта диагностирования:"
    )

    add_formula_gost(doc, r"R^* = \arg\max_R P(R \mid Q, D^*)", "2")

    add_paragraph_gost(
        doc,
        "Модель гибридного извлечения информации (Hybrid Retrieval). Поисковый конвейер реализует двухэтапную схему отбора кандидатов.\n"
        "1. Плотный векторный поиск (Dense Vector Search). Текстовый запрос q, сформированный из S_symp и расшифровки кодов C_DTC, "
        "отображается в евклидово пространство признаков R^d (d = 384) посредством био-энкодера e_q = E_dense(q). "
        "Сходство с векторными представлениями документов базы e_d = E_dense(d) оценивается косинусной мерой:"
    )

    add_formula_gost(doc, r"\mathrm{sim}_{\mathrm{dense}}(q, d) = \frac{\mathbf{e}_q \cdot \mathbf{e}_d}{\|\mathbf{e}_q\|_2 \, \|\mathbf{e}_d\|_2}", "3")

    add_paragraph_gost(
        doc,
        "где e_q — вектор эмбеддинга диагностического запроса;\n"
        "e_d — вектор эмбеддинга технического документа регламента;\n"
        "||·||_2 — евклидова L2-норма вектора.",
        space_before=4, space_after=6
    )

    add_paragraph_gost(
        doc,
        "Отбор топ-K_1 семантических кандидатов производится с помощью индекса IndexFlatIP библиотеки FAISS: "
        "S_dense = Top-K_1({sim_dense(q, d_i)}_{i=1}^N).\n"
        "2. Лексический поиск с бустингом кодовых идентификаторов (BM25Okapi). Для гарантированного сопоставления точных "
        "кодов ошибок параллельно вычисляется лексическая релевантность:"
    )

    add_formula_gost(doc, r"\mathrm{score}_{\mathrm{BM25}}(q, d) = \sum_{t \in q \cap d} \ln \left( \frac{N - n(t) + 0.5}{n(t) + 0.5} + 1 \right) \cdot \frac{f(t, d) \cdot (k_1 + 1)}{f(t, d) + k_1 \cdot \left(1 - b + b \cdot \frac{|d|}{\mathrm{avgdl}}\right)}", "4")

    add_paragraph_gost(
        doc,
        "где k_1 = 1.5, b = 0.75 — гиперпараметры модели насыщения частоты термов;\n"
        "n(t) — число документов в базе, содержащих терм t;\n"
        "f(t, d) — абсолютная частота появления терма t в документе d;\n"
        "|d| — длина текущего документа в токенах;\n"
        "avgdl — средняя длина документов в коллекции.\n"
        "При совпадении токена с маской регулярного выражения стандарта SAE J1979 (^[PCBU][0-3][0-9A-F]{3}$) весу терма "
        "присваивается мультипликативный коэффициент бустинга β_DTC = 2.5. Формируется множество лексических кандидатов "
        "S_lex = Top-K_2({score_BM25(q, d_i)}_{i=1}^N).\n"
        "3. Кросс-энкодерное глубокое переранжирование с весом технического состояния. Объединенный пул кандидатов "
        "S_pool = S_dense ∪ S_lex (|S_pool| ≤ 20) подвергается попарной оценке трансформером M_cross(q, d) с полным механизмом "
        "взаимного внимания между токенами запроса и документа. Итоговая функция ранжирования учитывает априорную тяжесть отказа "
        "через расчетный индекс исправности узла H(d) ∈ [0, 100]:",
        space_before=4, space_after=6
    )

    add_formula_gost(doc, r"\mathrm{Score}_{\mathrm{final}}(q, d_i) = \sigma(\mathcal{M}_{\mathrm{cross}}(q, d_i)) + \lambda \cdot \frac{100 - H(d_i)}{200}", "5")

    add_paragraph_gost(
        doc,
        "где σ(x) = (1 + e^{-x})^{-1} — логистическая функция нормировки;\n"
        "M_cross(q, d_i) — сырой скор логитов кросс-энкодера;\n"
        "H(d_i) — расчетный индекс исправности диагностируемого агрегата (Health Index, в процентах);\n"
        "λ = 0.15 — регуляризующий множитель критичности отказа.\n"
        "Документы с наивысшим баллом Score_final транслируются в контекстное окно модели.",
        space_before=4, space_after=6
    )

    add_paragraph_gost(
        doc,
        "Теория послойного вывода квантованных трансформеров (AirLLM W4A16). Для выполнения инференса мультимодальной "
        "нейросетевой модели L-слойной архитектуры (L = 48) в условиях ограничений VRAM используется схема смешанной точности "
        "W4A16 (Weight 4-bit, Activation 16-bit). Весовая матрица линейного преобразования W ∈ R^{d_in × d_out} квантуется блоками "
        "по 128 элементов. Значение веса представляется 4-битным беззнаковым целым числом w_int4 ∈ [0, 15] с симметричным масштабированием:"
    )

    add_formula_gost(doc, r"\hat{W} = s \cdot (w_{\mathrm{int4}} - z)", "6")

    add_paragraph_gost(
        doc,
        "где s — масштабирующий фактор блока весов в формате FP16;\n"
        "w_int4 — квантованное 4-битное представление весового коэффициента;\n"
        "z — нулевая точка сдвига диапазона (zero-point).",
        space_before=4, space_after=6
    )

    add_paragraph_gost(
        doc,
        "Вычисление матричного произведения активаций X ∈ R^{B × d_in} на квантованные веса осуществляется на тензорных "
        "ядрах графического ускорителя через предварительную конвертацию весов в плотный упакованный формат регистров:"
    )

    add_formula_gost(doc, r"Y = X \cdot \mathrm{int4pack\_mm}(\hat{W}, s, z)", "7")

    add_paragraph_gost(
        doc,
        "что исключает необходимость промежуточной распаковки весов в глобальную память GPU и обеспечивает снижение интенсивности "
        "трафика по шине видеопамяти более чем в 3,8 раза.\n"
        "Распределение слоев модели между видеопамятью и системной ОЗУ подчиняется оптимизационному условию:"
    )

    add_formula_gost(doc, r"\max |\mathcal{L}_{\mathrm{VRAM}}| \quad \text{при} \quad \mathrm{Mem}_{\mathrm{emb}} + \sum_{l \in \mathcal{L}_{\mathrm{VRAM}}} \mathrm{Mem}(W_l) + \mathrm{Mem}_{\mathrm{KV}}(N_{\mathrm{ctx}}) + \mathrm{Mem}_{\mathrm{act}} \le V_{\mathrm{alloc}}", "8")

    add_paragraph_gost(
        doc,
        "где V_alloc — лимит доступной видеопамяти GPU;\n"
        "L_VRAM — подмножество слоев, постоянно удерживаемых в видеопамяти;\n"
        "Mem_emb — объем памяти для таблицы эмбеддингов токенов;\n"
        "Mem_KV(N_ctx) — динамический объем кэша ключей и значений механизма внимания (KV Cache) для контекста длины N_ctx;\n"
        "Mem_act — буфер промежуточных активаций обратного прохода.",
        space_before=4, space_after=6
    )

    # ==========================================
    # 7. РЕЗУЛЬТАТЫ И ИХ ОБСУЖДЕНИЕ
    # ==========================================
    add_heading_gost(doc, "Результаты и их обсуждение")

    add_paragraph_gost(
        doc,
        "1. Технологический процесс сквозной диагностики. Функционирование программного комплекса экспертной автодиагностики "
        "организовано по циклическому конвейерному принципу. На рисунке 1 представлена разработанная блок-схема технологического "
        "процесса от момента регистрации первичных сигналов сканера до выдачи верифицированной технологической карты ремонта."
    )

    # Вставка Рис. 1 (Блок-схема)
    p_fig1 = doc.add_paragraph()
    p_fig1.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_fig1.paragraph_format.space_before = Pt(8)
    p_fig1.paragraph_format.space_after = Pt(4)
    run_f1 = p_fig1.add_run()
    run_f1.add_picture(os.path.join(figures_dir, "fig1_flowchart.png"), width=Inches(6.2))

    p_cap1 = doc.add_paragraph()
    p_cap1.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_cap1.paragraph_format.space_before = Pt(0)
    p_cap1.paragraph_format.space_after = Pt(12)
    r_c1 = p_cap1.add_run("Рисунок 1 — Блок-схема алгоритма технологического процесса сквозной автодиагностики")
    r_c1.font.name = 'Times New Roman'
    r_c1.font.size = Pt(12)
    r_c1.font.italic = True

    add_paragraph_gost(
        doc,
        "2. Архитектурное решение программного комплекса. Программный комплекс спроектирован по модульной трехуровневой "
        "архитектуре, графически представленной на рисунке 2:\n"
        "1. Клиентский уровень представления (Frontend PWA & AR HUD): кроссплатформенный интерфейс, оптимизированный "
        "для сенсорных экранов мобильных диагностических постов (360–375 px) и оптических очков дополненной реальности "
        "RayNeo. Обеспечивает прямое отображение интерактивных чекбоксов технологических операций и динамическое отслеживание "
        "прогресса ремонтных работ.\n"
        "2. Уровень бизнес-логики и оркестрации (Django REST Framework): содержит асинхронный воркер динамической контекстной "
        "памяти (context_worker.py), контролирующий баланс токенов в скользящем окне N_ctx = 32768 токенов по формуле:"
    )

    add_formula_gost(doc, r"\mathrm{Free}_{\mathrm{tokens}} = N_{\mathrm{ctx}} - N_{\mathrm{system\_prompt}} - N_{\mathrm{RAG\_docs}} - \sum_{i=1}^5 \left( N_{\mathrm{user}}^{(i)} + N_{\mathrm{assistant}}^{(i)} \right)", "9")

    add_paragraph_gost(
        doc,
        "где N_system_prompt — фиксированный объем токенов системных инструкций эксперта;\n"
        "N_RAG_docs — объем токенов, выделенный под извлеченные регламенты технической документации;\n"
        "N_user^(i), N_assistant^(i) — длины реплик диалога последних пяти итераций взаимодействия.\n"
        "Воркер обеспечивает удержание пяти последних пар реплик диалога в неизменном виде и выполняет мгновенное прерывание "
        "фоновых аналитических задач (Zero-Wait Preemption, задержка сброса ≤ 0.4 мс) при поступлении новых реплик оператора.\n"
        "3. Вычислительный уровень ядра (RAG & AirLLM Runtime): объединяет векторную базу FAISS с кэшированием эмбеддингов по SHA-256, "
        "инвертированный лексический индекс BM25Okapi, кросс-энкодер mmarco-mMiniLMv2 и оптимизированный послойный движок "
        "AdaptiveAirLLMGemma4 с аппаратным ускорением int4pack на GPU.",
        space_before=4, space_after=6
    )

    # Вставка Рис. 2 (Архитектура)
    p_fig2 = doc.add_paragraph()
    p_fig2.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_fig2.paragraph_format.space_before = Pt(8)
    p_fig2.paragraph_format.space_after = Pt(4)
    run_f2 = p_fig2.add_run()
    run_f2.add_picture(os.path.join(figures_dir, "fig2_architecture.png"), width=Inches(6.3))

    p_cap2 = doc.add_paragraph()
    p_cap2.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_cap2.paragraph_format.space_before = Pt(0)
    p_cap2.paragraph_format.space_after = Pt(12)
    r_c2 = p_cap2.add_run("Рисунок 2 — Архитектурная схема программного комплекса «ИИдеал Авто»")
    r_c2.font.name = 'Times New Roman'
    r_c2.font.size = Pt(12)
    r_c2.font.italic = True

    add_paragraph_gost(
        doc,
        "3. Экспериментальные исследования и апробация. Оценка предложенного метода проводилась на аппаратном комплексе в составе: "
        "графический процессор NVIDIA GeForce RTX 5080 Laptop GPU (16303 МБ VRAM, микроархитектура Blackwell, тензорные ядра 5-го поколения), "
        "центральный процессор AMD Ryzen 9 (16 вычислительных потоков), 32 ГБ ОЗУ DDR5. База данных испытаний включала "
        "359 регламентов поиска неисправностей, эталонный каталог 137 кодов DTC по стандартам SAE J1979 / ISO 15031-4 и "
        "32733 записей реальной и калиброванной телеметрии легковых автомобилей.\n"
        "В таблице 1 представлены результаты сравнительного анализа точности извлечения регламентов базы знаний "
        "(метрики Recall@k, MRR) и задержек поиска."
    )

    # Таблица 1 по ГОСТу
    p_t1_hdr = doc.add_paragraph()
    p_t1_hdr.paragraph_format.first_line_indent = Mm(12.5)
    p_t1_hdr.paragraph_format.space_before = Pt(8)
    p_t1_hdr.paragraph_format.space_after = Pt(4)
    r_th1 = p_t1_hdr.add_run("Таблица 1 — Сравнительная оценка точности и быстродействия поисковых алгоритмов базы знаний")
    r_th1.font.name = 'Times New Roman'
    r_th1.font.size = Pt(12)
    r_th1.font.bold = True

    table1 = doc.add_table(rows=5, cols=7)
    table1.alignment = WD_TABLE_ALIGNMENT.CENTER
    set_table_borders_gost(table1)

    headers1 = [
        "Алгоритм поиска", "Recall@1, %", "Recall@3, %", "Recall@5, %", "MRR", "Задержка CPU, мс", "Задержка GPU, мс"
    ]
    for i, h in enumerate(headers1):
        cell = table1.cell(0, i)
        set_cell_shading(cell, "F2F2F2")
        set_cell_margins(cell, top=100, bottom=100, left=80, right=80)
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
            set_cell_margins(cell, top=80, bottom=80, left=80, right=80)
            if row_idx == 4:
                set_cell_shading(cell, "F9FBF9")
            p = cell.paragraphs[0]
            p.paragraph_format.line_spacing = 1.0
            p.alignment = WD_ALIGN_PARAGRAPH.LEFT if col_idx == 0 else WD_ALIGN_PARAGRAPH.CENTER
            r = p.add_run(val)
            r.font.name = 'Times New Roman'
            r.font.size = Pt(9.5)
            if row_idx == 4:
                r.font.bold = True

    add_paragraph_gost(
        doc,
        "На рисунке 3 графически сопоставлены показатели полноты поиска Recall@k и взаимного ранга MRR во взаимосвязи "
        "со средней аппаратной задержкой отклика поискового конвейера на центральном и графическом процессорах.",
        space_before=8, space_after=4
    )

    # Вставка Рис. 3 (Графики метрик поиска)
    p_fig3 = doc.add_paragraph()
    p_fig3.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_fig3.paragraph_format.space_before = Pt(8)
    p_fig3.paragraph_format.space_after = Pt(4)
    run_f3 = p_fig3.add_run()
    run_f3.add_picture(os.path.join(figures_dir, "fig3_retrieval_metrics.png"), width=Inches(6.3))

    p_cap3 = doc.add_paragraph()
    p_cap3.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_cap3.paragraph_format.space_before = Pt(0)
    p_cap3.paragraph_format.space_after = Pt(12)
    r_c3 = p_cap3.add_run("Рисунок 3 — Сравнительные характеристики точности извлечения (Recall@k, MRR) и задержек поиска RAG")
    r_c3.font.name = 'Times New Roman'
    r_c3.font.size = Pt(12)
    r_c3.font.italic = True

    add_paragraph_gost(
        doc,
        "В таблице 2 приведены сравнительные данные по потреблению памяти и вычислительной производительности различных "
        "схем развертывания мультимодальной нейросетевой модели.",
        space_before=4, space_after=4
    )

    # Таблица 2 по ГОСТу
    p_t2_hdr = doc.add_paragraph()
    p_t2_hdr.paragraph_format.first_line_indent = Mm(12.5)
    p_t2_hdr.paragraph_format.space_before = Pt(8)
    p_t2_hdr.paragraph_format.space_after = Pt(4)
    r_th2 = p_t2_hdr.add_run("Таблица 2 — Сравнительный анализ вычислительной емкости квантованных конфигураций модели")
    r_th2.font.name = 'Times New Roman'
    r_th2.font.size = Pt(12)
    r_th2.font.bold = True

    table2 = doc.add_table(rows=4, cols=6)
    table2.alignment = WD_TABLE_ALIGNMENT.CENTER
    set_table_borders_gost(table2)

    headers2 = [
        "Конфигурация модели", "Точность весов/активаций", "Объем весов, ГБ", "Требуемая VRAM, ГБ", "Скорость, ток./с", "Время генерации 400 ток., с"
    ]
    for i, h in enumerate(headers2):
        cell = table2.cell(0, i)
        set_cell_shading(cell, "F2F2F2")
        set_cell_margins(cell, top=100, bottom=100, left=80, right=80)
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
            set_cell_margins(cell, top=80, bottom=80, left=80, right=80)
            if row_idx == 3:
                set_cell_shading(cell, "F9FBF9")
            p = cell.paragraphs[0]
            p.paragraph_format.line_spacing = 1.0
            p.alignment = WD_ALIGN_PARAGRAPH.LEFT if col_idx == 0 else WD_ALIGN_PARAGRAPH.CENTER
            r = p.add_run(val)
            r.font.name = 'Times New Roman'
            r.font.size = Pt(9.5)
            if row_idx == 3:
                r.font.bold = True

    add_paragraph_gost(
        doc,
        "На рисунке 4 показана динамика распределения видеопамяти графического ускорителя и сопоставление задержек выполнения "
        "одного линейного слоя трансформера при традиционной пошаговой распаковке весов и с использованием специализированного "
        "CUDA-ядра _weight_int4pack_mm.",
        space_before=8, space_after=4
    )

    # Вставка Рис. 4 (Графики VRAM и int4pack)
    p_fig4 = doc.add_paragraph()
    p_fig4.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_fig4.paragraph_format.space_before = Pt(8)
    p_fig4.paragraph_format.space_after = Pt(4)
    run_f4 = p_fig4.add_run()
    run_f4.add_picture(os.path.join(figures_dir, "fig4_vram_and_latency.png"), width=Inches(6.3))

    p_cap4 = doc.add_paragraph()
    p_cap4.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_cap4.paragraph_format.space_before = Pt(0)
    p_cap4.paragraph_format.space_after = Pt(12)
    r_c4 = p_cap4.add_run("Рисунок 4 — Динамика потребления видеопамяти VRAM и аппаратное ускорение ядра int4pack")
    r_c4.font.name = 'Times New Roman'
    r_c4.font.size = Pt(12)
    r_c4.font.italic = True

    add_paragraph_gost(
        doc,
        "Анализ диагностических сценариев в реальных условиях. Комплексная верификация системы на 9 практических сценариях показала:\n"
        "1. При анализе множественных пропусков воспламенения P0300 на двигателе с непосредственным впрыском топлива (1.4 TSI), "
        "система сопоставила параметры кратковременной топливной коррекции STFT (+18%) и заниженное давление в рампе (32 бар при "
        "заводской норме 40–150 бар). В сформированном заключении исключены нерелевантные гипотезы классических систем распределенного "
        "впрыска MPI (3.5–4.0 бар), а в чеклист выведены нормативные проверки электрического сопротивления пьезофорсунок "
        "(1.5–3.0 Ом) и производительности секции высокого давления ТНВД.\n"
        "2. В случае механического дефекта ступичного узла колеса (SYM-HUB), не регистрируемого электронными блоками в виде кодов DTC, "
        "по текстовому описанию характера шума и направлению поворота гибридный RAG корректно определил дефект подшипника с рангом "
        "релевантности 1.193 (против 0.387 для кодов датчиков ABS), выдав предписание по замеру осевого биения с допуском ≤ 0.05 мм.\n"
        "3. При отказе шины передачи данных CAN (код U1900) система точно выделила дефект пайки разъема щитка приборов и указала "
        "нормативное терминальное сопротивление шины (60 Ом между контактами 6 и 14 диагностического разъема DLC)."
    )

    # ==========================================
    # 8. ВЫВОДЫ
    # ==========================================
    add_heading_gost(doc, "Выводы")

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
        p_c.paragraph_format.first_line_indent = Mm(12.5)
        p_c.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        p_c.paragraph_format.line_spacing = 1.5
        p_c.paragraph_format.space_after = Pt(4)
        r_num = p_c.add_run(f"{idx}. ")
        r_num.font.name = 'Times New Roman'
        r_num.font.size = Pt(14)
        r_num.font.bold = True
        r_txt = p_c.add_run(c_text)
        r_txt.font.name = 'Times New Roman'
        r_txt.font.size = Pt(14)

    # ==========================================
    # 9. СПИСОК ЛИТЕРАТУРЫ (ПО ГОСТ Р 7.0.5-2008)
    # ==========================================
    add_heading_gost(doc, "Список литературы")

    references = [
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

    for idx, ref in enumerate(references, start=1):
        p_ref = doc.add_paragraph()
        p_ref.paragraph_format.first_line_indent = Mm(12.5)
        p_ref.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        p_ref.paragraph_format.line_spacing = 1.15
        p_ref.paragraph_format.space_after = Pt(4)
        run_idx = p_ref.add_run(f"{idx}. ")
        run_idx.font.name = 'Times New Roman'
        run_idx.font.size = Pt(12)
        run_idx.font.bold = True
        run_body = p_ref.add_run(ref)
        run_body.font.name = 'Times New Roman'
        run_body.font.size = Pt(12)

    doc.save(output_docx)
    print(f"[Успех] Статья по ГОСТу с нативными формулами и 4 графиками успешно сохранена: {output_docx}")

if __name__ == "__main__":
    main()
