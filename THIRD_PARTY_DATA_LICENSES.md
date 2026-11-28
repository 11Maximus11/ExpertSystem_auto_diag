# Лицензии используемых открытых баз данных и библиотек

Дата ревизии: 2026-11-28  
Лицензия приложения: **GNU General Public License v3.0 (GPL-3.0)**

## Встроенная база знаний OBD-II / DTC (локальный RAG-индекс)
1. **Curated RU Knowledge Base (`src/rag/kb_tier1.json`)** — авторская база симптомов, причин, эталонной телеметрии и пошаговых регламентов ремонта («ИИдеал Авто», GPL-3.0).
2. **commonmanual** (`https://github.com/xsvdevelopment/commonmanual`) — открытый справочник кодов OBD-II / процедур, лицензия **CC-BY-SA-4.0** (данные) / **MIT** (утилиты).
3. **MechanicDB-public** (`https://github.com/MechanicDB/MechanicDB-public`) — коды неисправностей OBD-II и J1939, лицензия **ODbL-1.0** (набор данных) / **MIT** / **CC-BY-4.0**.
4. **us-vehicle-trouble-codes** (`https://huggingface.co/datasets/karsonmadden/us-vehicle-trouble-codes`) — обогащённые описания DTC и статистика сервисных бюллетеней, лицензия **CC-BY-4.0**.

## Сторонние компоненты и иконки
- **Lucide Icons** (встроенный набор `assetIcon("lucide:...")` платформы `le.codes`) — ISC License.
- **Платформа и SDK `le.codes`** (`lecodes-sdk`, Letary LLC) — используется в рамках правил хакатона LeCodes48.
