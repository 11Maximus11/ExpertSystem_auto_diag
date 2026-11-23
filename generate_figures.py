# -*- coding: utf-8 -*-
"""
Генерация векторно-растровых иллюстраций для научной статьи по ГОСТу
с разрешением 300 DPI с использованием matplotlib.
"""

import os
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.patches as patches
import numpy as np

# Настройка шрифтов для соответствия ГОСТ (Times New Roman / DejaVu Serif)
plt.rcParams['font.family'] = 'serif'
plt.rcParams['font.serif'] = ['Times New Roman', 'DejaVu Serif', 'Liberation Serif']
plt.rcParams['mathtext.fontset'] = 'stix'
plt.rcParams['axes.edgecolor'] = '#333333'
plt.rcParams['axes.linewidth'] = 0.8

figures_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "article_figures")
os.makedirs(figures_dir, exist_ok=True)

def generate_figure_1():
    """Рис. 1: Блок-схема алгоритма технологического процесса сквозной автодиагностики"""
    fig, ax = plt.subplots(figsize=(10, 11), dpi=300)
    ax.set_xlim(0, 10)
    ax.set_ylim(0, 12)
    ax.axis('off')

    # Вспомогательные функции для рисования блоков
    def draw_box(x, y, w, h, text, bg='#E8EEF5', border='#2B5B84', shape='round'):
        if shape == 'round':
            box = patches.FancyBboxPatch((x - w/2, y - h/2), w, h,
                                         boxstyle="round,pad=0.1,rounding_size=0.15",
                                         facecolor=bg, edgecolor=border, linewidth=1.2)
        elif shape == 'rect':
            box = patches.Rectangle((x - w/2, y - h/2), w, h,
                                    facecolor=bg, edgecolor=border, linewidth=1.2)
        elif shape == 'diamond':
            pts = [[x, y + h/2], [x + w/2, y], [x, y - h/2], [x - w/2, y]]
            box = patches.Polygon(pts, closed=True, facecolor=bg, edgecolor=border, linewidth=1.2)
        ax.add_patch(box)
        ax.text(x, y, text, ha='center', va='center', fontsize=8.5, color='#111111', multialignment='center')

    def draw_arrow(x1, y1, x2, y2, label=None):
        ax.annotate('', xy=(x2, y2), xytext=(x1, y1),
                    arrowprops=dict(arrowstyle="->", color="#2B5B84", lw=1.2, mutation_scale=12))
        if label:
            mx, my = (x1 + x2)/2, (y1 + y2)/2
            ax.text(mx + 0.15, my, label, fontsize=8, color='#004080', fontweight='bold', va='center')

    # Блоки схемы
    draw_box(5, 11.2, 7.8, 0.7, "ВХОДНЫЕ ДАННЫЕ:\nКоды ошибок DTC (SAE J1979), симптомы, параметры PID, фото/аудио", bg='#E2F0D9', border='#385723')
    draw_arrow(5, 10.85, 5, 10.15)

    draw_box(5, 9.75, 7.8, 0.65, "Первичная нормализация запроса и фильтрация шумовых артефактов", bg='#F2F2F2', border='#595959')
    draw_arrow(5, 9.42, 5, 8.75)

    draw_box(5, 8.25, 4.2, 0.9, "Обнаружен валидный\nкод DTC в запросе?", bg='#FFF2CC', border='#B25900', shape='diamond')
    
    # Ветвление
    # Да -> влево
    ax.plot([2.9, 2.5, 2.5], [8.25, 8.25, 7.3], color="#2B5B84", lw=1.2)
    ax.annotate('', xy=(2.5, 6.95), xytext=(2.5, 7.3),
                arrowprops=dict(arrowstyle="->", color="#2B5B84", lw=1.2, mutation_scale=12))
    ax.text(2.65, 8.35, "Да", fontsize=8.5, fontweight='bold', color='#B25900')

    draw_box(2.5, 6.5, 4.2, 0.75, "Лексический поиск BM25Okapi\nс бустингом кодов DTC (β = 2.5)", bg='#E8EEF5', border='#2B5B84')

    # Нет -> вправо
    ax.plot([7.1, 7.5, 7.5], [8.25, 8.25, 7.3], color="#2B5B84", lw=1.2)
    ax.annotate('', xy=(7.5, 6.95), xytext=(7.5, 7.3),
                arrowprops=dict(arrowstyle="->", color="#2B5B84", lw=1.2, mutation_scale=12))
    ax.text(7.15, 8.35, "Нет", fontsize=8.5, fontweight='bold', color='#B25900')

    draw_box(7.5, 6.5, 4.2, 0.75, "Плотный семантический поиск\nв FAISS (Bi-Encoder MiniLM-L12)", bg='#E8EEF5', border='#2B5B84')

    # Слияние
    ax.plot([2.5, 2.5, 5], [6.12, 5.65, 5.65], color="#2B5B84", lw=1.2)
    ax.plot([7.5, 7.5, 5], [6.12, 5.65, 5.65], color="#2B5B84", lw=1.2)
    draw_arrow(5, 5.65, 5, 5.15)

    draw_box(5, 4.8, 7.8, 0.65, "Объединение пула кандидатов (Top-10 FAISS + Top-10 BM25)", bg='#F2F2F2', border='#595959')
    draw_arrow(5, 4.47, 5, 3.95)

    draw_box(5, 3.6, 7.8, 0.65, "Попарный реранкинг Cross-Encoder (mmarco-mMiniLMv2) с весом Health Index", bg='#E8EEF5', border='#2B5B84')
    draw_arrow(5, 3.27, 5, 2.75)

    draw_box(5, 2.4, 7.8, 0.65, "Формирование контекста RAG (32K токенов) + история диалога (5 пар реплик)", bg='#F2F2F2', border='#595959')
    draw_arrow(5, 2.07, 5, 1.55)

    draw_box(5, 1.2, 7.8, 0.65, "Послойный инференс AirLLM (Gemma 4 12B, W4A16 int4pack resident в VRAM)", bg='#FFF2CC', border='#B25900')
    draw_arrow(5, 0.87, 5, 0.35)

    draw_box(5, 0.05, 7.8, 0.55, "ВЫХОД: Интерактивная технологическая карта ремонта и чеклист с допусками", bg='#E2F0D9', border='#385723')

    fig_path = os.path.join(figures_dir, "fig1_flowchart.png")
    plt.tight_layout()
    plt.savefig(fig_path, dpi=300, bbox_inches='tight')
    plt.close()
    print("Сохранен Рис. 1:", fig_path)
    return fig_path

def generate_figure_2():
    """Рис. 2: Архитектурная схема трехуровневого программного комплекса «ИИдеал Авто»"""
    fig, ax = plt.subplots(figsize=(10.5, 7.5), dpi=300)
    ax.set_xlim(0, 11)
    ax.set_ylim(0, 8)
    ax.axis('off')

    # Уровень 1: Клиентский
    ax.add_patch(patches.FancyBboxPatch((0.5, 5.5), 10, 2.1, boxstyle="round,pad=0.08,rounding_size=0.15",
                                        facecolor='#F4F7FA', edgecolor='#1F4E79', linewidth=1.5))
    ax.text(0.7, 7.3, "КЛИЕНТСКИЙ УРОВЕНЬ ПРЕДСТАВЛЕНИЯ (Frontend PWA & AR HUD)", fontsize=9.5, fontweight='bold', color='#1F4E79')

    def subbox(x, y, w, h, title, desc, bg='#FFFFFF', border='#2F5597'):
        ax.add_patch(patches.FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.05,rounding_size=0.1",
                                            facecolor=bg, edgecolor=border, linewidth=1.0))
        ax.text(x + w/2, y + h - 0.28, title, fontsize=8.5, fontweight='bold', ha='center', color='#1F4E79')
        ax.text(x + w/2, y + 0.35, desc, fontsize=7.5, ha='center', color='#333333', multialignment='center')

    subbox(0.8, 5.7, 2.8, 1.3, "Веб-интерфейс PWA", "Адаптивная верстка (360-375 px)\nОптимистичный UI, чеклисты\nПрямой аудио- и фото-ввод")
    subbox(4.1, 5.7, 2.8, 1.3, "Двухрежимный AR HUD", "Режим 1: Очки RayNeo (#000000)\nРежим 2: Video Passthrough\nБыстрый стейджинг дефектов")
    subbox(7.4, 5.7, 2.8, 1.3, "Инспектор телеметрии", "Графики PIDs OBD-II в реальном времени\nИндикаторы допусков\nПротокол ISO 14229-1 (UDS)")

    # Стрелка 1 -> 2
    ax.annotate('', xy=(5.5, 4.8), xytext=(5.5, 5.5),
                arrowprops=dict(arrowstyle="<->", color="#1F4E79", lw=1.5, mutation_scale=12))
    ax.text(5.65, 5.15, "REST API (JSON / Multipart / Base64)", fontsize=8, color='#1F4E79', style='italic')

    # Уровень 2: Оркестрация и контекст
    ax.add_patch(patches.FancyBboxPatch((0.5, 2.8), 10, 2.0, boxstyle="round,pad=0.08,rounding_size=0.15",
                                        facecolor='#FBF9F5', edgecolor='#C55A11', linewidth=1.5))
    ax.text(0.7, 4.5, "УРОВЕНЬ ОРКЕСТРАЦИИ И КОНТЕКСТНОЙ ПАМЯТИ (Django Backend)", fontsize=9.5, fontweight='bold', color='#C55A11')

    subbox(0.8, 3.0, 3.0, 1.25, "Воркер памяти (32K)", "Динамический расчет бюджета токенов\nПамять 5 последних реплик\nZero-Wait Preemption (≤ 0.4 мс)", bg='#FFFFFF', border='#C55A11')
    subbox(4.2, 3.0, 2.6, 1.25, "Изоляция сессий", "Многопользовательские проекты\nТегирование агрегатов (ДВС, АКПП)\nSQLite db_clean snapshot", bg='#FFFFFF', border='#C55A11')
    subbox(7.2, 3.0, 3.0, 1.25, "Валидатор схем", "Pydantic v2 JSON Schema\nОтсечение рассуждений модели\nЗащита от OOM и циклических пауз", bg='#FFFFFF', border='#C55A11')

    # Стрелка 2 -> 3
    ax.annotate('', xy=(5.5, 2.1), xytext=(5.5, 2.8),
                arrowprops=dict(arrowstyle="<->", color="#C55A11", lw=1.5, mutation_scale=12))
    ax.text(5.65, 2.45, "IPC / PyTorch Direct Tensor Flow", fontsize=8, color='#C55A11', style='italic')

    # Уровень 3: Вычислительное ядро
    ax.add_patch(patches.FancyBboxPatch((0.5, 0.2), 10, 1.9, boxstyle="round,pad=0.08,rounding_size=0.15",
                                        facecolor='#EDF5EC', edgecolor='#385723', linewidth=1.5))
    ax.text(0.7, 1.85, "ВЫЧИСЛИТЕЛЬНЫЙ УРОВЕНЬ ЯДРА (Hybrid RAG Engine & AirLLM Runtime)", fontsize=9.5, fontweight='bold', color='#385723')

    subbox(0.8, 0.35, 4.4, 1.25, "Гибридный поисковый конвейер (RAG)", "Bi-Encoder (paraphrase-multilingual-MiniLM-L12-v2)\nИндекс FAISS IndexFlatIP + лексический BM25Okapi\nCross-Encoder mmarco-mMiniLMv2-L12-H384-v1", bg='#FFFFFF', border='#385723')
    subbox(5.8, 0.35, 4.4, 1.25, "Движок нейросети AdaptiveAirLLMGemma4", "Google Gemma 4 12B Unified (48 слоев, safetensors)\nКвантование W4A16 int4pack (328 матриц)\nResident VRAM GPU (10.1 ГБ) + PCIe DMA Pinned Stream", bg='#FFFFFF', border='#385723')

    fig_path = os.path.join(figures_dir, "fig2_architecture.png")
    plt.tight_layout()
    plt.savefig(fig_path, dpi=300, bbox_inches='tight')
    plt.close()
    print("Сохранен Рис. 2:", fig_path)
    return fig_path

def generate_figure_3():
    """Рис. 3: Точность (Recall@k, MRR) и задержки поисковых алгоритмов RAG"""
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(10.5, 4.2), dpi=300)

    algorithms = ['BM25Okapi', 'FAISS\n(MiniLM)', 'Гибридный\nбез реранкера', 'Предложенный\n(с CrossEncoder)']
    r1 = [71.4, 81.0, 85.7, 95.2]
    r3 = [85.7, 95.2, 95.2, 100.0]
    r5 = [90.5, 100.0, 100.0, 100.0]

    x = np.arange(len(algorithms))
    width = 0.25

    # Панель 1: Полнота Recall@k
    bars1 = ax1.bar(x - width, r1, width, label='Recall@1', color='#4F81BD', edgecolor='#2B5B84', lw=0.8)
    bars2 = ax1.bar(x, r3, width, label='Recall@3', color='#9BBB59', edgecolor='#4F6228', lw=0.8)
    bars3 = ax1.bar(x + width, r5, width, label='Recall@5', color='#F79646', edgecolor='#974706', lw=0.8)

    ax1.set_ylabel('Полнота охвата (Recall), %', fontsize=9.5)
    ax1.set_title('а) Полнота извлечения регламентов базы знаний', fontsize=10, fontweight='bold', pad=10)
    ax1.set_xticks(x)
    ax1.set_xticklabels(algorithms, fontsize=8.5)
    ax1.set_ylim(60, 108)
    ax1.grid(axis='y', linestyle='--', alpha=0.6)
    ax1.legend(loc='lower right', fontsize=8.5, framealpha=0.9)

    for bar in [bars1, bars2, bars3]:
        for rect in bar:
            h = rect.get_height()
            ax1.text(rect.get_x() + rect.get_width()/2., h + 1.0, f'{h:.1f}',
                     ha='center', va='bottom', fontsize=7.2)

    # Панель 2: MRR и Задержка
    mrr = [0.781, 0.881, 0.905, 0.976]
    lat_cpu = [18.2, 42.6, 60.8, 268.4]
    lat_gpu = [18.2, 6.8, 14.5, 31.2]

    color = '#1F4E79'
    ax2.set_title('б) Метрика ранжирования MRR и аппаратная задержка', fontsize=10, fontweight='bold', pad=10)
    bars_mrr = ax2.bar(x - 0.18, mrr, 0.35, label='MRR (шкала слева)', color='#5B9BD5', edgecolor='#1F4E79', lw=0.8)
    ax2.set_ylabel('Средний взаимный ранг (MRR)', color=color, fontsize=9.5)
    ax2.set_ylim(0.5, 1.05)
    ax2.tick_params(axis='y', labelcolor=color)
    ax2.set_xticks(x)
    ax2.set_xticklabels(algorithms, fontsize=8.5)
    ax2.grid(axis='y', linestyle='--', alpha=0.4)

    ax2_twin = ax2.twinx()
    color_twin = '#C55A11'
    line1 = ax2_twin.plot(x, lat_cpu, color=color_twin, marker='o', lw=1.8, label='Задержка CPU, мс')
    line2 = ax2_twin.plot(x, lat_gpu, color='#385723', marker='s', lw=1.8, linestyle='--', label='Задержка GPU, мс')
    ax2_twin.set_ylabel('Задержка отклика, мс (шкала справа)', color=color_twin, fontsize=9.5)
    ax2_twin.tick_params(axis='y', labelcolor=color_twin)
    ax2_twin.set_ylim(0, 310)

    # Объединение легенд
    lines, labels = ax2.get_legend_handles_labels()
    lines2, labels2 = ax2_twin.get_legend_handles_labels()
    ax2.legend(lines + lines2, labels + labels2, loc='upper left', fontsize=8, framealpha=0.9)

    fig_path = os.path.join(figures_dir, "fig3_retrieval_metrics.png")
    plt.tight_layout()
    plt.savefig(fig_path, dpi=300, bbox_inches='tight')
    plt.close()
    print("Сохранен Рис. 3:", fig_path)
    return fig_path

def generate_figure_4():
    """Рис. 4: Потребление VRAM и ускорение int4pack послойного вывода"""
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(10.5, 4.2), dpi=300)

    modes = ['Базовый\nFP16', 'Квантованный\nW8A16', 'Разработанный\nW4A16 int4pack']
    vram_used = [26.5, 15.8, 10.1]
    vram_weights = [24.8, 13.2, 7.54]
    gpu_capacity = 16.3

    x = np.arange(len(modes))
    width = 0.35

    # Панель 1: VRAM
    ax1.bar(x - width/2, vram_weights, width, label='Веса модели, ГБ', color='#8EA9DB', edgecolor='#2F5597', lw=0.8)
    ax1.bar(x + width/2, vram_used, width, label='Пиковая VRAM (веса+KV), ГБ', color='#ED7D31', edgecolor='#974706', lw=0.8)
    ax1.axhline(gpu_capacity, color='#C00000', linestyle='--', lw=1.5, label='Лимит GPU VRAM (16.3 ГБ)')

    ax1.set_ylabel('Объем памяти, ГБ', fontsize=9.5)
    ax1.set_title('а) Потребление видеопамяти графического ускорителя', fontsize=10, fontweight='bold', pad=10)
    ax1.set_xticks(x)
    ax1.set_xticklabels(modes, fontsize=8.5)
    ax1.set_ylim(0, 31)
    ax1.grid(axis='y', linestyle='--', alpha=0.6)
    ax1.legend(loc='upper right', fontsize=8, framealpha=0.9)

    ax1.text(0, 27.2, "OOM (> 16.3 ГБ)", ha='center', color='#C00000', fontweight='bold', fontsize=8)
    ax1.text(1, 16.5, "Предел VRAM", ha='center', color='#974706', fontsize=8)
    ax1.text(2, 10.8, "Запас: 6.2 ГБ", ha='center', color='#385723', fontweight='bold', fontsize=8)

    # Панель 2: Задержка выполнения одного слоя
    kernels = ['Eager PyTorch Unpack\n(W4A16 manual)', 'CUDA Tensor Kernel\n(_weight_int4pack_mm)']
    latencies = [2.16, 0.039]
    colors_k = ['#ED7D31', '#70AD47']

    bars_k = ax2.bar(kernels, latencies, width=0.45, color=colors_k, edgecolor='#333333', lw=0.8)
    ax2.set_ylabel('Время вычисления одного слоя, мс', fontsize=9.5)
    ax2.set_title('б) Время выполнения линейного слоя трансформера', fontsize=10, fontweight='bold', pad=10)
    ax2.set_ylim(0, 2.5)
    ax2.grid(axis='y', linestyle='--', alpha=0.6)

    ax2.text(0, 2.22, "2.160 мс", ha='center', va='bottom', fontsize=9, fontweight='bold')
    ax2.text(1, 0.10, "0.039 мс (ускорение в 55 раз)", ha='center', va='bottom', fontsize=9, fontweight='bold', color='#385723')

    fig_path = os.path.join(figures_dir, "fig4_vram_and_latency.png")
    plt.tight_layout()
    plt.savefig(fig_path, dpi=300, bbox_inches='tight')
    plt.close()
    print("Сохранен Рис. 4:", fig_path)
    return fig_path

if __name__ == "__main__":
    f1 = generate_figure_1()
    f2 = generate_figure_2()
    f3 = generate_figure_3()
    f4 = generate_figure_4()
    print("Все 4 иллюстрации успешно сгенерированы в высоком разрешении 300 DPI.")
