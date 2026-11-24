# -*- coding: utf-8 -*-
"""
Генератор отчета по Практической работе №1:
«Гибкая методология разработки Agile»
Дисциплина: «Управление программными проектами»
Кафедра программной инженерии ЮЗГУ
Авторы: Подорожный М.Е., Свирин Н.Р., Эрденко М.Д., Разгуляев Е.О., Михайлов А.
"""

import os
import docx
from docx import Document
from docx.shared import Inches, Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_ALIGN_VERTICAL
from docx.oxml import OxmlElement, parse_xml
from docx.oxml.ns import nsdecls, qn

FONT_NAME = "Times New Roman"

def set_cell_borders(cell, top=None, bottom=None, left=None, right=None, color="auto", sz="4", val="single"):
    """Установка границ ячейки таблицы"""
    tcPr = cell._tc.get_or_add_tcPr()
    tcBorders = parse_xml(
        f'<w:tcBorders {nsdecls("w")}>\n'
        f'  <w:top w:val="{val}" w:sz="{sz}" w:space="0" w:color="{color}"/>\n'
        f'  <w:left w:val="{val}" w:sz="{sz}" w:space="0" w:color="{color}"/>\n'
        f'  <w:bottom w:val="{val}" w:sz="{sz}" w:space="0" w:color="{color}"/>\n'
        f'  <w:right w:val="{val}" w:sz="{sz}" w:space="0" w:color="{color}"/>\n'
        f'</w:tcBorders>'
    )
    tcPr.append(tcBorders)

def set_cell_shading(cell, color_hex="F2F2F2"):
    """Установка фона ячейки"""
    shading_elm = parse_xml(f'<w:shd {nsdecls("w")} w:fill="{color_hex}"/>')
    cell._tc.get_or_add_tcPr().append(shading_elm)

def set_cell_margins(cell, top=100, bottom=100, left=150, right=150):
    """Отступы внутри ячейки таблицы"""
    tcPr = cell._tc.get_or_add_tcPr()
    tcMar = parse_xml(
        f'<w:tcMar {nsdecls("w")}>\n'
        f'  <w:top w:w="{top}" w:type="dxa"/>\n'
        f'  <w:bottom w:w="{bottom}" w:type="dxa"/>\n'
        f'  <w:left w:w="{left}" w:type="dxa"/>\n'
        f'  <w:right w:w="{right}" w:type="dxa"/>\n'
        f'</w:tcMar>'
    )
    tcPr.append(tcMar)

def add_title_page(doc, lab_num=1, topic="Гибкая методология разработки Agile"):
    section = doc.sections[0]
    section.top_margin = Cm(2.0)
    section.bottom_margin = Cm(2.0)
    section.left_margin = Cm(3.0)
    section.right_margin = Cm(1.5)

    def p_hdr(text, bold=False, size=12, align=WD_ALIGN_PARAGRAPH.CENTER, space_after=0):
        p = doc.add_paragraph()
        p.alignment = align
        p.paragraph_format.line_spacing = 1.0
        p.paragraph_format.space_after = Pt(space_after)
        p.paragraph_format.first_line_indent = Cm(0)
        r = p.add_run(text)
        r.font.name = FONT_NAME
        r.font.size = Pt(size)
        r.font.bold = bold
        return p

    p_hdr("МИНОБРНАУКИ РОССИИ", bold=True, size=13)
    p_hdr("ФЕДЕРАЛЬНОЕ ГОСУДАРСТВЕННОЕ БЮДЖЕТНОЕ ОБРАЗОВАТЕЛЬНОЕ УЧРЕЖДЕНИЕ", size=10)
    p_hdr("ВЫСШЕГО ОБРАЗОВАНИЯ", size=10)
    p_hdr("«ЮГО-ЗАПАДНЫЙ ГОСУДАРСТВЕННЫЙ УНИВЕРСИТЕТ»", bold=True, size=13)
    p_hdr("(ЮЗГУ)", bold=True, size=12, space_after=8)
    p_hdr("Факультет фундаментальной и прикладной информатики", size=11)
    p_hdr("Кафедра программной инженерии", bold=True, size=12, space_after=65)

    p_hdr(f"ОТЧЕТ ПО ПРАКТИЧЕСКОЙ РАБОТЕ №{lab_num}", bold=True, size=16, space_after=8)
    p_hdr("по дисциплине «Управление программными проектами»", size=13, space_after=8)
    p_hdr(f"Тема: «{topic}»", bold=True, size=14, space_after=85)

    # Блок исполнителей справа
    p_right = doc.add_paragraph()
    p_right.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    p_right.paragraph_format.line_spacing = 1.15
    p_right.paragraph_format.space_after = Pt(80)
    p_right.paragraph_format.first_line_indent = Cm(0)
    
    lines_right = [
        ("Выполнили:", True),
        ("студенты группы ПО-32б:", False),
        ("Подорожный М. Е. (Архитектура, ML)", False),
        ("Свирин Н. Р. (Данные, RAG)", False),
        ("Эрденко М. Д. (Frontend, AR)", False),
        ("Разгуляев Е. О. (Презентация, UI)", False),
        ("Михайлов А. (Аппаратная часть, OBD)", False),
        ("", False),
        ("Проверил:", True),
        ("канд. техн. наук, доцент", False),
        ("Петрик Е. А.", False),
    ]
    for text, bold in lines_right:
        r = p_right.add_run(text + "\n")
        r.font.name = FONT_NAME
        r.font.size = Pt(12)
        r.font.bold = bold

    p_bot = doc.add_paragraph()
    p_bot.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_bot.paragraph_format.line_spacing = 1.0
    p_bot.paragraph_format.space_after = Pt(0)
    p_bot.paragraph_format.first_line_indent = Cm(0)
    r_bot = p_bot.add_run("Курск — 2026")
    r_bot.font.name = FONT_NAME
    r_bot.font.size = Pt(12)

    doc.add_page_break()

def add_heading_1(doc, text):
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.line_spacing = 1.5
    p.paragraph_format.space_before = Pt(14)
    p.paragraph_format.space_after = Pt(8)
    p.paragraph_format.first_line_indent = Cm(0)
    r = p.add_run(text)
    r.font.name = FONT_NAME
    r.font.size = Pt(14)
    r.font.bold = True
    return p

def add_heading_2(doc, text):
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.LEFT
    p.paragraph_format.line_spacing = 1.5
    p.paragraph_format.space_before = Pt(10)
    p.paragraph_format.space_after = Pt(4)
    p.paragraph_format.first_line_indent = Cm(1.25)
    r = p.add_run(text)
    r.font.name = FONT_NAME
    r.font.size = Pt(14)
    r.font.bold = True
    return p

def add_heading_3(doc, text):
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.LEFT
    p.paragraph_format.line_spacing = 1.5
    p.paragraph_format.space_before = Pt(6)
    p.paragraph_format.space_after = Pt(2)
    p.paragraph_format.first_line_indent = Cm(1.25)
    r = p.add_run(text)
    r.font.name = FONT_NAME
    r.font.size = Pt(13)
    r.font.bold = True
    r.font.italic = True
    return p

def add_body(doc, text, space_after=0):
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    p.paragraph_format.line_spacing = 1.5
    p.paragraph_format.space_after = Pt(space_after)
    p.paragraph_format.first_line_indent = Cm(1.25)
    r = p.add_run(text)
    r.font.name = FONT_NAME
    r.font.size = Pt(14)
    return p

def add_bullet(doc, bold_prefix, text):
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    p.paragraph_format.line_spacing = 1.5
    p.paragraph_format.space_after = Pt(0)
    p.paragraph_format.left_indent = Cm(1.25)
    p.paragraph_format.first_line_indent = Cm(0)
    r_bullet = p.add_run("• ")
    r_bullet.font.name = FONT_NAME
    r_bullet.font.size = Pt(14)
    r_bullet.font.bold = True
    if bold_prefix:
        r_pre = p.add_run(bold_prefix)
        r_pre.font.name = FONT_NAME
        r_pre.font.size = Pt(14)
        r_pre.font.bold = True
    r_txt = p.add_run(text)
    r_txt.font.name = FONT_NAME
    r_txt.font.size = Pt(14)
    return p

def add_table_caption(doc, text):
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.LEFT
    p.paragraph_format.line_spacing = 1.15
    p.paragraph_format.space_before = Pt(8)
    p.paragraph_format.space_after = Pt(3)
    p.paragraph_format.first_line_indent = Cm(0)
    r = p.add_run(text)
    r.font.name = FONT_NAME
    r.font.size = Pt(12)
    r.font.italic = True
    return p

def create_styled_table(doc, headers, data, col_widths=None):
    table = doc.add_table(rows=len(data) + 1, cols=len(headers))
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False

    # Шапка
    hdr_cells = table.rows[0].cells
    for i, title in enumerate(headers):
        hdr_cells[i].text = title
        set_cell_borders(hdr_cells[i], color="4A5568", sz="6")
        set_cell_shading(hdr_cells[i], "E2E8F0")
        set_cell_margins(hdr_cells[i], top=120, bottom=120, left=150, right=150)
        p = hdr_cells[i].paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.space_after = Pt(0)
        p.paragraph_format.line_spacing = 1.0
        p.paragraph_format.first_line_indent = Cm(0)
        for r in p.runs:
            r.font.name = FONT_NAME
            r.font.size = Pt(11)
            r.font.bold = True

    # Данные
    for row_idx, row_data in enumerate(data):
        row_cells = table.rows[row_idx + 1].cells
        bg_color = "F8FAFC" if row_idx % 2 == 1 else "FFFFFF"
        for col_idx, cell_value in enumerate(row_data):
            row_cells[col_idx].text = cell_value
            set_cell_borders(row_cells[col_idx], color="CBD5E1", sz="4")
            if bg_color != "FFFFFF":
                set_cell_shading(row_cells[col_idx], bg_color)
            set_cell_margins(row_cells[col_idx], top=80, bottom=80, left=120, right=120)
            p = row_cells[col_idx].paragraphs[0]
            p.alignment = WD_ALIGN_PARAGRAPH.LEFT if col_idx > 0 else WD_ALIGN_PARAGRAPH.CENTER
            p.paragraph_format.space_after = Pt(0)
            p.paragraph_format.line_spacing = 1.15
            p.paragraph_format.first_line_indent = Cm(0)
            for r in p.runs:
                r.font.name = FONT_NAME
                r.font.size = Pt(11)

    # Ширины колонок
    if col_widths:
        for row in table.rows:
            for idx, width in enumerate(col_widths):
                row.cells[idx].width = width

    p_after = doc.add_paragraph()
    p_after.paragraph_format.space_after = Pt(6)
    p_after.paragraph_format.line_spacing = 1.0
    return table
