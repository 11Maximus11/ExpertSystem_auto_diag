/**
 * ИИдеал Авто (AIdeal Auto) — Клиентское ядро интерфейса (Mobile-First PWA + Desktop + RayNeo AR HUD)
 * Поддерживает:
 * - Неблокирующий фоновый воркер выжимки контекста с индикацией сброса при приоритете ответа
 * - Интерактивные чеклисты задач ремонта и блоки инвентаря с синхронизацией состояния
 * - Словарь кодов ошибок DTC (kb_data.json + VehicleDiagnosticSample.txt)
 * - Встроенную камеру, прикрепление фото/документов и прямой нативный аудиовход (Direct Gemma 4 Audio)
 * - Двойной режим AR-очков (RayNeo Optical #000000 и Камера-фон Video Passthrough)
 */

(function () {
  'use strict';

  const state = {
    currentSessionId: document.body.dataset.initialSession || '',
    stagedCodes: [],
    stagedFiles: [],
    stagedCameraShots: [],
    stagedVoiceBlob: null,
    stagedVoiceTranscript: '',
    isRecording: false,
    mediaRecorder: null,
    speechRecognition: null,
    stopRecordingPromise: null,
    audioCtx: null,
    analyserNode: null,
    spectrogramRafId: null,
    smoothedBands: new Float32Array(28),
    smoothedEnergy: 0,
    cameraStream: null,
    arCameraStream: null,
    arBgCameraStream: null,
    arSubmode: 'rayneo', // 'rayneo' | 'passthrough'
    cameraFacingMode: 'environment',
    workerPollTimer: null,
    latestAssistantMessage: null,
  };

  const el = (id) => document.getElementById(id);

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatMarkdownLite(text) {
    let safe = escapeHtml(text);
    safe = safe.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    safe = safe.replace(/\*(.+?)\*/g, '<em>$1</em>');
    return safe.replace(/\n/g, '<br/>');
  }

  // =========================================================================
  // 1. Отрисовка очереди вложений (Staging Bar: Коды DTC, Фото, Документы, Голос)
  // =========================================================================
  function renderStagingBar() {
    const bar = el('stagingBar');
    if (!bar) return;
    const chips = [];

    state.stagedCodes.forEach((code, idx) => {
      chips.push(
        `<span class="staged-chip">
          <span>DTC: ${escapeHtml(code)}</span>
          <button type="button" data-remove-code="${idx}" style="border:none;background:none;color:inherit;font-weight:700;">×</button>
        </span>`
      );
    });

    state.stagedCameraShots.forEach((_, idx) => {
      chips.push(
        `<span class="staged-chip">
          <span>Снимок камеры #${idx + 1}</span>
          <button type="button" data-remove-shot="${idx}" style="border:none;background:none;color:inherit;font-weight:700;">×</button>
        </span>`
      );
    });

    state.stagedFiles.forEach((f, idx) => {
      chips.push(
        `<span class="staged-chip">
          <span>Файл: ${escapeHtml(f.name)}</span>
          <button type="button" data-remove-file="${idx}" style="border:none;background:none;color:inherit;font-weight:700;">×</button>
        </span>`
      );
    });

    if (state.stagedVoiceBlob) {
      chips.push(
        `<span class="staged-chip">
          <span>Голосовая запись готова ${state.stagedVoiceTranscript ? '(' + escapeHtml(state.stagedVoiceTranscript.slice(0, 28)) + '...)' : ''}</span>
          <button type="button" data-remove-voice="1" style="border:none;background:none;color:inherit;font-weight:700;">×</button>
        </span>`
      );
    }

    bar.innerHTML = chips.join('');

    bar.querySelectorAll('[data-remove-code]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.stagedCodes.splice(Number(btn.dataset.removeCode), 1);
        renderStagingBar();
      });
    });
    bar.querySelectorAll('[data-remove-shot]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.stagedCameraShots.splice(Number(btn.dataset.removeShot), 1);
        renderStagingBar();
      });
    });
    bar.querySelectorAll('[data-remove-file]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.stagedFiles.splice(Number(btn.dataset.removeFile), 1);
        renderStagingBar();
      });
    });
    bar.querySelectorAll('[data-remove-voice]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.stagedVoiceBlob = null;
        state.stagedVoiceTranscript = '';
        renderStagingBar();
      });
    });
  }

  // =========================================================================
  // 2. Отрисовка Task-Friendly сообщений (Инвентарь, Чекбоксы задач, Function Calls)
  // =========================================================================
  function buildStructuredCardHtml(msg) {
    const sdata = msg.structured_data;
    if (!sdata || typeof sdata !== 'object') {
      return `<div>${formatMarkdownLite(msg.content)}</div>`;
    }

    const faults = Array.isArray(sdata.faults) ? sdata.faults : [];
    const inventory = Array.isArray(sdata.inventory) ? sdata.inventory : [];
    const steps = Array.isArray(sdata.repair_steps) ? sdata.repair_steps : [];
    const telemetryNotes = Array.isArray(sdata.telemetry_notes) ? sdata.telemetry_notes : [];
    const recommendations = Array.isArray(sdata.recommendations) ? sdata.recommendations : [];
    const toolCalls = Array.isArray(sdata.tool_calls) ? sdata.tool_calls : [];

    const invDone = inventory.filter((i) => i.checked).length;
    const stepsDone = steps.filter((s) => s.completed).length;

    let html = `
      <div class="diagnosis-verdict-title">
        <span>${escapeHtml(sdata.summary_title || 'Экспертное заключение')}</span>
        <span class="badge-vulkan">JSON SCHEMA VALIDATED</span>
      </div>
      <div style="font-size:0.9rem; color:var(--text-secondary); margin-bottom:10px;">
        ${formatMarkdownLite(sdata.mentor_reply || msg.content)}
      </div>
    `;

    // Карточки установленных неисправностей
    if (faults.length > 0) {
      html += `<div class="faults-grid">`;
      faults.forEach((f) => {
        const sevClass = f.severity === 'critical' ? 'critical' : '';
        const health = Number(f.health_index || 75);
        html += `
          <div class="fault-box ${sevClass}">
            <div class="fault-top">
              <span class="dtc-pill">${escapeHtml(f.code)}</span>
              <span style="font-size:0.75rem; font-family:var(--font-mono); color:var(--text-muted);">
                ${escapeHtml(f.system_ru)} • Достоверность ${Number(f.confidence || 90)}%
              </span>
            </div>
            <div style="font-weight:700; font-size:0.88rem; margin-bottom:4px;">${escapeHtml(f.title)}</div>
            <div class="health-bar-wrap" title="Индекс здоровья узла: ${health}%">
              <div class="health-bar-fill" style="width:${Math.max(10, Math.min(100, health))}%;"></div>
            </div>
            <div style="font-size:0.76rem; color:var(--text-secondary);">
              Health Index: <strong>${health}%</strong> — ${escapeHtml(f.root_cause)}
            </div>
          </div>
        `;
      });
      html += `</div>`;
    }

    // Блок инвентаря с чекбоксами
    if (inventory.length > 0) {
      html += `
        <div class="task-section-box">
          <div class="task-section-header">
            <span>Блок инвентаря (Инструменты, запчасти и СИЗ)</span>
            <span class="task-progress-pill" data-inv-counter="${msg.id}">Готово: ${invDone} / ${inventory.length}</span>
          </div>
          <div class="inventory-list">
      `;
      inventory.forEach((item) => {
        const checkedAttr = item.checked ? 'checked' : '';
        const rowClass = item.checked ? 'completed' : '';
        const catMap = { tool: 'Инструмент', part: 'Запчасть', consumable: 'Расходник', safety: 'Безопасность' };
        html += `
          <label class="check-row ${rowClass}" data-msg-id="${msg.id}" data-check-type="inventory" data-check-id="${escapeHtml(item.id)}">
            <input type="checkbox" class="custom-checkbox js-task-checkbox" ${checkedAttr}
              data-msg-id="${msg.id}" data-check-type="inventory" data-check-id="${escapeHtml(item.id)}" />
            <div class="check-body">
              <div class="check-title">${escapeHtml(item.name)}</div>
              <div class="check-meta-tags">
                <span class="spec-tag">${escapeHtml(catMap[item.category] || item.category)}</span>
                ${item.spec ? `<span class="spec-tag">${escapeHtml(item.spec)}</span>` : ''}
              </div>
            </div>
          </label>
        `;
      });
      html += `</div></div>`;
    }

    // Пошаговый чеклист ремонта с чекбоксами
    if (steps.length > 0) {
      html += `
        <div class="task-section-box">
          <div class="task-section-header">
            <span>Пошаговый план устранения неисправности</span>
            <span class="task-progress-pill" data-step-counter="${msg.id}">Выполнено: ${stepsDone} / ${steps.length}</span>
          </div>
          <div class="steps-checklist">
      `;
      steps.forEach((step) => {
        const checkedAttr = step.completed ? 'checked' : '';
        const rowClass = step.completed ? 'completed' : '';
        html += `
          <label class="check-row ${rowClass}" data-msg-id="${msg.id}" data-check-type="step" data-check-id="${step.step_number}">
            <input type="checkbox" class="custom-checkbox js-task-checkbox" ${checkedAttr}
              data-msg-id="${msg.id}" data-check-type="step" data-check-id="${step.step_number}" />
            <div class="check-body">
              <div class="check-title">Шаг ${step.step_number}. ${escapeHtml(step.title)}</div>
              <div class="check-desc">${escapeHtml(step.instruction)}</div>
              <div class="check-meta-tags">
                ${step.torque_or_spec ? `<span class="spec-tag">${escapeHtml(step.torque_or_spec)}</span>` : ''}
                ${step.estimated_minutes ? `<span class="spec-tag">~${step.estimated_minutes} мин</span>` : ''}
                ${step.safety_warning ? `<span class="safety-tag">ТБ: ${escapeHtml(step.safety_warning)}</span>` : ''}
              </div>
            </div>
          </label>
        `;
      });
      html += `</div></div>`;
    }

    // Эталонная телеметрия и рекомендации
    if (telemetryNotes.length > 0 || recommendations.length > 0) {
      html += `<div class="task-section-box" style="font-size:0.8rem; color:var(--text-secondary);">`;
      if (telemetryNotes.length > 0) {
        html += `<div style="font-weight:700; color:var(--accent-cyan); margin-bottom:4px;">Сверка с телеметрией БД:</div>`;
        telemetryNotes.forEach((note) => {
          html += `<div style="margin-bottom:4px;">• ${escapeHtml(note)}</div>`;
        });
      }
      if (recommendations.length > 0) {
        html += `<div style="font-weight:700; color:var(--accent-orange); margin:8px 0 4px 0;">Рекомендации мастера:</div>`;
        recommendations.forEach((rec) => {
          html += `<div style="margin-bottom:3px;">• ${escapeHtml(rec)}</div>`;
        });
      }
      html += `</div>`;
    }

    // Трассировка вызовов Function Calling
    if (toolCalls.length > 0) {
      html += `
        <div class="tool-calls-drawer">
          <div style="font-weight:600;">Выполненные вызовы инструментов ИИ (Function Calling: ${toolCalls.length}):</div>
          ${toolCalls
            .map(
              (tc) =>
                `<div class="tool-call-item">fn <strong>${escapeHtml(tc.tool_name)}</strong>(${escapeHtml(
                  JSON.stringify(tc.arguments || {})
                )}) → ${escapeHtml(tc.result_summary)}</div>`
            )
            .join('')}
        </div>
      `;
    }

    return html;
  }

  function renderMessageElement(msg) {
    const wrapper = document.createElement('article');
    wrapper.className = `msg-card ${msg.role === 'user' ? 'msg-user' : 'msg-assistant'}`;
    wrapper.dataset.messageId = msg.id;

    const roleTitle = msg.role === 'user' ? 'ЗАПРОС МАСТЕРА / ВОДИТЕЛЯ' : 'ИИдеал Авто • Экспертная диагностика';
    const dtcHtml =
      Array.isArray(msg.dtc_codes) && msg.dtc_codes.length
        ? `<div class="dtc-badge-row">${msg.dtc_codes.map((c) => `<span class="dtc-pill">${escapeHtml(c)}</span>`).join('')}</div>`
        : '';

    let attachmentsHtml = '';
    if (Array.isArray(msg.attachments) && msg.attachments.length) {
      attachmentsHtml = `<div class="attachments-grid">`;
      msg.attachments.forEach((att) => {
        if (att.type === 'image' && att.url) {
          attachmentsHtml += `<img src="${escapeHtml(att.url)}" alt="${escapeHtml(att.name || 'Фото поломки')}" class="attachment-thumb" />`;
        } else if (att.type === 'audio') {
          const modeLabel = att.mode && !att.mode.toLowerCase().includes('ggml') ? att.mode : 'Gemma 4 Native Audio';
          attachmentsHtml += `<span class="attachment-doc-chip">Аудио (${escapeHtml(modeLabel)}): ${escapeHtml(att.transcript || '')}</span>`;
        } else {
          attachmentsHtml += `<span class="attachment-doc-chip">Документ: ${escapeHtml(att.name || 'Файл')}</span>`;
        }
      });
      attachmentsHtml += `</div>`;
    }

    const bodyHtml =
      msg.role === 'assistant' ? buildStructuredCardHtml(msg) : `<div>${formatMarkdownLite(msg.content)}</div>`;

    const isTemp = String(msg.id).startsWith('temp-');
    const actionsHtml = isTemp
      ? `<span>${escapeHtml(msg.created_at || '')}</span>`
      : `
        <div class="msg-card-actions">
          <span>${escapeHtml(msg.created_at || '')}</span>
          <label class="msg-select-label" title="Выбрать для удаления">
            <input type="checkbox" class="msg-select-cb" data-msg-id="${msg.id}" />
          </label>
          <button type="button" class="btn-msg-delete" data-msg-id="${msg.id}" title="Удалить из чата и памяти ИИ">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
          </button>
        </div>
      `;

    wrapper.innerHTML = `
      <div class="msg-header">
        <span class="msg-role-badge">${roleTitle}</span>
        ${actionsHtml}
      </div>
      ${bodyHtml}
      ${attachmentsHtml}
      ${dtcHtml}
    `;

    return wrapper;
  }

  function bindTaskCheckboxes(rootContainer) {
    (rootContainer || document).querySelectorAll('.js-task-checkbox').forEach((chk) => {
      if (chk.dataset.bound === '1') return;
      chk.dataset.bound = '1';
      chk.addEventListener('change', async (e) => {
        const msgId = chk.dataset.msgId;
        const checkType = chk.dataset.checkType;
        const checkId = chk.dataset.checkId;
        const isChecked = chk.checked;

        // Синхронно обновляем все копии этого чекбокса (в чате, в правой панели и в AR-окне)
        document
          .querySelectorAll(
            `.js-task-checkbox[data-msg-id="${msgId}"][data-check-type="${checkType}"][data-check-id="${checkId}"]`
          )
          .forEach((peer) => {
            peer.checked = isChecked;
            const row = peer.closest('.check-row');
            if (row) row.classList.toggle('completed', isChecked);
          });

        try {
          const resp = await fetch(`/api/messages/${msgId}/toggle-task/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: checkType, id: checkId, checked: isChecked }),
          });
          if (resp.ok) {
            const data = await resp.json();
            const p = data.progress || {};
            document.querySelectorAll(`[data-step-counter="${msgId}"]`).forEach((b) => {
              b.textContent = `Выполнено: ${p.steps_done} / ${p.steps_total}`;
            });
            document.querySelectorAll(`[data-inv-counter="${msgId}"]`).forEach((b) => {
              b.textContent = `Готово: ${p.inventory_done} / ${p.inventory_total}`;
            });
            pollWorkerStatus();
          }
        } catch (err) {
          console.error('Ошибка сохранения чекбокса:', err);
        }
      });
    });
  }

  function updateInspectorAndArFromAssistant(msg) {
    state.latestAssistantMessage = msg;
    const inspectorPane = el('inspectorChecklistContent');
    const arFeed = el('arAssistantFeed');
    if (!msg || !msg.structured_data) return;

    const cardHtml = buildStructuredCardHtml(msg);
    if (inspectorPane) {
      inspectorPane.innerHTML = cardHtml;
      bindTaskCheckboxes(inspectorPane);
    }
    if (arFeed) {
      arFeed.innerHTML = cardHtml;
      bindTaskCheckboxes(arFeed);
    }
  }

  // =========================================================================
  // 3. Загрузка сессии и мониторинг фонового воркера контекста (Requirement #3)
  // =========================================================================
  function updateWorkerUi(status, summaryText, globalSummaryText, preemptedNow) {
    const headerDot = el('headerWorkerDot');
    const headerText = el('headerWorkerText');
    const sideBadge = el('sidebarWorkerBadge');

    let label = 'Синхронизирован';
    let stateClass = '';

    if (preemptedNow || status === 'aborted_for_priority') {
      label = 'Сброшен (приоритет ответа)';
      stateClass = 'aborted';
    } else if (status === 'running') {
      label = 'Фоновое сжатие контекста...';
      stateClass = 'running';
    } else if (status === 'completed' || status === 'idle') {
      label = 'Контекст синхронизирован';
      stateClass = '';
    }

    if (headerDot) {
      headerDot.className = `status-dot ${stateClass}`;
    }
    if (headerText) {
      headerText.textContent = `Воркер: ${label}`;
    }
    if (sideBadge) {
      sideBadge.className = `worker-badge ${stateClass}`;
      sideBadge.textContent = label;
    }

    const summaryArea = el('dialogSummaryTextarea');
    if (summaryArea && typeof summaryText === 'string' && document.activeElement !== summaryArea) {
      summaryArea.value = summaryText;
    }

    const globalArea = el('globalSummaryTextarea');
    if (globalArea && typeof globalSummaryText === 'string' && document.activeElement !== globalArea) {
      globalArea.value = globalSummaryText;
    }
  }

  async function pollWorkerStatus() {
    if (!state.currentSessionId) return;
    try {
      const resp = await fetch(`/api/worker-status/${state.currentSessionId}/`);
      if (!resp.ok) return;
      const data = await resp.json();
      updateWorkerUi(
        data.is_running ? 'running' : data.worker_status,
        data.summary,
        data.global_memory_summary,
        false
      );
      if (data.is_running) {
        clearTimeout(state.workerPollTimer);
        state.workerPollTimer = setTimeout(pollWorkerStatus, 650);
      }
    } catch (e) {
      // Игнорируем временные сетевые сбои при опросе
    }
  }

  function renderEmptyState(feed) {
    if (!feed) return;
    feed.innerHTML = `
      <div class="msg-card msg-assistant" data-welcome-placeholder="1">
        <div class="msg-header">
          <span class="msg-role-badge">ИИДЕАЛ АВТО • ГОТОВ К ДИАГНОСТИКЕ</span>
          <span>GEMMA 4 12B + AIRLLM GPU</span>
        </div>
        <div class="diagnosis-verdict-title">
          <span>Интеллектуальный стенд автодиагностики и пошагового ремонта</span>
        </div>
        <p style="font-size:0.88rem; color:var(--text-secondary);">
          Опишите симптом своими словами, выберите код ошибки OBD-II из словаря БД, прикрепите лог сканера,
          запишите голосовой вопрос или сфотографируйте неисправный узел прямо через встроенную камеру / очки RayNeo AR.
        </p>
      </div>
    `;
    updateSelectionToolbar();
  }

  function updateSelectionToolbar() {
    const toolbar = el('chatSelectionToolbar');
    const chkSelectAll = el('chkSelectAllMessages');
    const counterBadge = el('selectedMessagesCount');
    const btnDelete = el('btnDeleteSelectedMessages');
    if (!toolbar) return;

    const checkboxes = Array.from(document.querySelectorAll('.msg-select-cb'));
    const totalCount = checkboxes.length;
    const checkedBoxes = checkboxes.filter((cb) => cb.checked);
    const checkedCount = checkedBoxes.length;

    if (counterBadge) {
      counterBadge.textContent = `${checkedCount} / ${totalCount}`;
    }
    if (chkSelectAll) {
      chkSelectAll.checked = totalCount > 0 && checkedCount === totalCount;
      chkSelectAll.indeterminate = checkedCount > 0 && checkedCount < totalCount;
    }
    if (btnDelete) {
      btnDelete.disabled = checkedCount === 0;
    }
  }

  async function deleteSingleMessage(msgId, cardEl) {
    if (!msgId) return;
    if (!confirm('Удалить это сообщение из чата и рабочей памяти ИИ?')) return;

    try {
      const resp = await fetch(`/api/messages/${msgId}/delete/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (resp.ok) {
        const data = await resp.json();
        cardEl?.remove();
        updateSelectionToolbar();

        const feed = el('chatFeed');
        if (feed && !feed.querySelector('.msg-card:not([data-welcome-placeholder])')) {
          renderEmptyState(feed);
        }

        if (data.session_summary !== undefined) {
          updateWorkerUi(null, data.session_summary, null, false);
        }
      } else {
        alert('Не удалось удалить сообщение.');
      }
    } catch (err) {
      console.error('Ошибка удаления сообщения:', err);
    }
  }

  async function deleteSelectedMessages() {
    const checkedBoxes = Array.from(document.querySelectorAll('.msg-select-cb:checked'));
    if (!checkedBoxes.length) return;
    const ids = checkedBoxes.map((cb) => Number(cb.dataset.msgId)).filter(Boolean);
    if (!confirm(`Удалить выбранные сообщения (${ids.length} шт.) из чата и контекста модели?`)) return;

    try {
      const resp = await fetch('/api/messages/delete/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: state.currentSessionId, message_ids: ids }),
      });
      if (resp.ok) {
        const data = await resp.json();
        ids.forEach((id) => {
          document.querySelectorAll(`.msg-card[data-message-id="${id}"]`).forEach((el) => el.remove());
        });
        updateSelectionToolbar();

        const feed = el('chatFeed');
        if (feed && !feed.querySelector('.msg-card:not([data-welcome-placeholder])')) {
          renderEmptyState(feed);
        }

        if (data.session_summary !== undefined) {
          updateWorkerUi(null, data.session_summary, null, false);
        }
      } else {
        alert('Не удалось удалить выбранные сообщения.');
      }
    } catch (err) {
      console.error('Ошибка массового удаления сообщений:', err);
    }
  }

  async function clearAllMessages() {
    if (!state.currentSessionId) return;
    if (!confirm('Полностью очистить всю историю текущего чата и сбросить память модели?')) return;

    try {
      const resp = await fetch('/api/messages/delete/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: state.currentSessionId, delete_all: true }),
      });
      if (resp.ok) {
        const data = await resp.json();
        const feed = el('chatFeed');
        if (feed) {
          renderEmptyState(feed);
        }
        if (data.session_summary !== undefined) {
          updateWorkerUi(null, data.session_summary, null, false);
        }
      } else {
        alert('Не удалось очистить чат.');
      }
    } catch (err) {
      console.error('Ошибка очистки чата:', err);
    }
  }

  async function loadSession(sessionId) {
    if (!sessionId) return;
    state.currentSessionId = sessionId;
    try {
      const resp = await fetch(`/api/sessions/${sessionId}/`);
      if (!resp.ok) return;
      const data = await resp.json();

      const vehInput = el('vehicleInfoInput');
      if (vehInput) vehInput.value = data.vehicle_info || '';

      updateWorkerUi(
        data.worker_live && data.worker_live.is_running ? 'running' : data.worker_status,
        data.summary || '',
        data.global_memory_summary || '',
        false
      );

      const feed = el('chatFeed');
      if (feed) {
        feed.innerHTML = '';
        const messages = data.messages || [];
        if (messages.length === 0) {
          renderEmptyState(feed);
        } else {
          let lastAssistant = null;
          messages.forEach((m) => {
            feed.appendChild(renderMessageElement(m));
            if (m.role === 'assistant') lastAssistant = m;
          });
          bindTaskCheckboxes(feed);
          if (lastAssistant) {
            updateInspectorAndArFromAssistant(lastAssistant);
          }
          feed.scrollTop = feed.scrollHeight;
          updateSelectionToolbar();
        }
      }

      document.querySelectorAll('.session-item').forEach((item) => {
        item.classList.toggle('active', item.dataset.sessionId === String(sessionId));
      });
    } catch (err) {
      console.error('Ошибка загрузки сессии:', err);
    }
  }

  // =========================================================================
  // 4. Отправка диагностического запроса (Мгновенное сообщение + Анимация генерации)
  // =========================================================================
  function createPendingGenerationCard() {
    const wrapper = document.createElement('article');
    wrapper.className = 'msg-card msg-assistant msg-generating-card msg-card-enter';
    wrapper.innerHTML = `
      <div class="msg-header">
        <span class="msg-role-badge">ИИДЕАЛ АВТО • ГЕНЕРАЦИЯ ОТВЕТА (GEMMA 4 12B + AIRLLM GPU)</span>
        <span class="generating-timer-pill" data-gen-timer>0.0 с</span>
      </div>
      <div class="generating-main-row">
        <div class="neural-wave" aria-hidden="true">
          <span></span><span></span><span></span><span></span>
        </div>
        <div style="min-width:0; flex:1;">
          <div class="generating-stage-title" data-gen-title>Нейросеть AirLLM анализирует ваш запрос...</div>
          <div class="generating-stage-sub" data-gen-stage>Этап 1/4: Сверка с базой знаний и словарём OBD-II (RAG + Телеметрия)...</div>
        </div>
      </div>
      <div class="generating-progress-track">
        <div class="generating-progress-bar"></div>
      </div>
      <div class="skeleton-lines" aria-hidden="true">
        <div class="skeleton-line w-90"></div>
        <div class="skeleton-line w-75"></div>
        <div class="skeleton-line w-60"></div>
      </div>
    `;

    const startTs = performance.now();
    const timerEl = wrapper.querySelector('[data-gen-timer]');
    const stageEl = wrapper.querySelector('[data-gen-stage]');

    const intervalId = setInterval(() => {
      const elapsedSec = (performance.now() - startTs) / 1000;
      if (timerEl) {
        timerEl.textContent = `${elapsedSec.toFixed(1)} с`;
      }
      if (stageEl) {
        if (elapsedSec < 1.5) {
          stageEl.textContent = 'Этап 1/4: Сверка с базой знаний и словарём OBD-II (RAG + Телеметрия)...';
        } else if (elapsedSec < 4.5) {
          stageEl.textContent = 'Этап 2/4: Анализ контекста в резидентных слоях GPU VRAM (Gemma 4 12B)...';
        } else if (elapsedSec < 11.0) {
          stageEl.textContent = 'Этап 3/4: Послойный PCIe DMA-стриминг весов AirLLM и синтез ответа...';
        } else {
          stageEl.textContent = 'Этап 4/4: Валидация JSON Schema и сборка чеклиста ремонта...';
        }
      }
    }, 100);

    wrapper._stopAnimation = () => clearInterval(intervalId);
    return wrapper;
  }

  async function sendDiagnosticQuery(overrideQuery) {
    if (state.isRecording || state.stopRecordingPromise) {
      await stopVoiceRecordingAndWait();
    }

    const queryInput = el('queryInput');
    const vehInput = el('vehicleInfoInput');
    const queryText = (typeof overrideQuery === 'string' ? overrideQuery : queryInput.value).trim();

    if (
      !queryText &&
      state.stagedCodes.length === 0 &&
      state.stagedFiles.length === 0 &&
      state.stagedCameraShots.length === 0 &&
      !state.stagedVoiceBlob
    ) {
      queryInput.focus();
      return;
    }

    // Сохраняем снимок данных запроса для мгновенной отрисовки сообщения пользователя в чате
    const codesSnapshot = [...state.stagedCodes];
    const filesSnapshot = [...state.stagedFiles];
    const shotsSnapshot = [...state.stagedCameraShots];
    const voiceBlobSnapshot = state.stagedVoiceBlob;
    const voiceTranscriptSnapshot = state.stagedVoiceTranscript;

    const sendBtn = el('btnSendQuery');
    const origSendBtnHtml = sendBtn ? sendBtn.innerHTML : '';
    if (sendBtn) {
      sendBtn.disabled = true;
      sendBtn.innerHTML = `
        <svg class="spin-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
          <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
        </svg>
        <span>Генерация...</span>
      `;
    }

    const formData = new FormData();
    formData.append('session_id', state.currentSessionId);
    formData.append('query', queryText);
    formData.append('vehicle_info', vehInput ? vehInput.value.trim() : '');
    formData.append('dtc_codes', JSON.stringify(codesSnapshot));

    shotsSnapshot.forEach((shot) => {
      formData.append('camera_image_b64', shot);
    });
    filesSnapshot.forEach((file) => {
      formData.append('attachments', file);
    });
    if (voiceBlobSnapshot) {
      formData.append('attachments', voiceBlobSnapshot, 'voice_input.webm');
    }
    if (voiceTranscriptSnapshot) {
      formData.append('voice_transcript', voiceTranscriptSnapshot);
    }

    // Очищаем поле ввода и панель вложений сразу
    if (typeof overrideQuery !== 'string' && queryInput) {
      queryInput.value = '';
    }
    state.stagedCodes = [];
    state.stagedFiles = [];
    state.stagedCameraShots = [];
    state.stagedVoiceBlob = null;
    state.stagedVoiceTranscript = '';
    renderStagingBar();

    // 1. Мгновенно отображаем сообщение пользователя в чате (Optimistic UI), чтобы оно не исчезало
    const tempObjectUrls = [];
    const optimisticAttachments = [];
    shotsSnapshot.forEach((b64, idx) => {
      optimisticAttachments.push({
        type: 'image',
        url: b64,
        name: `Снимок камеры #${idx + 1}`,
      });
    });
    filesSnapshot.forEach((f) => {
      if (f.type && f.type.startsWith('image/')) {
        const objUrl = URL.createObjectURL(f);
        tempObjectUrls.push(objUrl);
        optimisticAttachments.push({ type: 'image', url: objUrl, name: f.name });
      } else {
        optimisticAttachments.push({ type: 'document', name: f.name });
      }
    });
    if (voiceBlobSnapshot) {
      optimisticAttachments.push({
        type: 'audio',
        mode: 'Gemma 4 Native Audio',
        transcript: voiceTranscriptSnapshot || 'Голосовой запрос',
      });
    }

    const nowTimeStr = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const optimisticUserMsg = {
      id: `temp-user-${Date.now()}`,
      role: 'user',
      content: queryText || voiceTranscriptSnapshot || '[Мультимодальный диагностический запрос]',
      created_at: nowTimeStr,
      dtc_codes: codesSnapshot,
      attachments: optimisticAttachments,
    };

    const feed = el('chatFeed');
    const arFeed = el('arAssistantFeed');
    let optimisticUserEl = null;
    let pendingAssistantEl = null;
    let pendingArEl = null;

    if (feed) {
      const welcomePlaceholder = feed.querySelector('[data-welcome-placeholder="1"]');
      if (welcomePlaceholder) {
        welcomePlaceholder.remove();
      }
      optimisticUserEl = renderMessageElement(optimisticUserMsg);
      optimisticUserEl.classList.add('msg-card-enter');
      feed.appendChild(optimisticUserEl);

      // 2. Сразу добавляем анимированную карточку генерации ответа ИИ
      pendingAssistantEl = createPendingGenerationCard();
      feed.appendChild(pendingAssistantEl);
      feed.scrollTop = feed.scrollHeight;
    }

    if (arFeed && document.body.classList.contains('ar-glasses-mode')) {
      pendingArEl = createPendingGenerationCard();
      arFeed.innerHTML = '';
      arFeed.appendChild(pendingArEl);
    }

    try {
      const resp = await fetch('/api/ask/', {
        method: 'POST',
        body: formData,
      });
      const data = await resp.json();
      if (!resp.ok) {
        if (pendingAssistantEl) {
          pendingAssistantEl._stopAnimation?.();
          pendingAssistantEl.remove();
        }
        if (pendingArEl) {
          pendingArEl._stopAnimation?.();
          pendingArEl.remove();
        }
        alert(data.error || 'Ошибка выполнения диагностики');
        return;
      }

      if (data.worker_preempted) {
        updateWorkerUi('aborted_for_priority', null, null, true);
      }

      if (feed) {
        if (data.user_message) {
          const confirmedUserEl = renderMessageElement(data.user_message);
          if (optimisticUserEl && optimisticUserEl.parentNode === feed) {
            feed.replaceChild(confirmedUserEl, optimisticUserEl);
          } else {
            feed.appendChild(confirmedUserEl);
          }
        }
        if (data.assistant_message) {
          const assistantEl = renderMessageElement(data.assistant_message);
          assistantEl.classList.add('msg-card-enter');
          if (pendingAssistantEl) {
            pendingAssistantEl._stopAnimation?.();
            if (pendingAssistantEl.parentNode === feed) {
              feed.replaceChild(assistantEl, pendingAssistantEl);
            } else {
              feed.appendChild(assistantEl);
            }
          } else {
            feed.appendChild(assistantEl);
          }
          bindTaskCheckboxes(feed);
          if (pendingArEl) {
            pendingArEl._stopAnimation?.();
          }
          updateInspectorAndArFromAssistant(data.assistant_message);
        }
        feed.scrollTop = feed.scrollHeight;
        updateSelectionToolbar();
      }

      // Запускаем опрос фонового воркера, который обновляет краткую выжимку
      setTimeout(pollWorkerStatus, 250);
    } catch (err) {
      console.error('Ошибка отправки запроса:', err);
      if (pendingAssistantEl) {
        pendingAssistantEl._stopAnimation?.();
        pendingAssistantEl.innerHTML = `
          <div class="msg-header">
            <span class="msg-role-badge" style="color:var(--status-crit);">ОШИБКА СОЕДИНЕНИЯ С СЕРВЕРОМ</span>
          </div>
          <div style="font-size:0.86rem; color:var(--text-secondary);">
            Не удалось получить ответ от сервера диагностики. Проверьте, что сервер запущен, и повторите попытку.
          </div>
        `;
      }
      if (pendingArEl) {
        pendingArEl._stopAnimation?.();
      }
    } finally {
      tempObjectUrls.forEach((u) => {
        try {
          URL.revokeObjectURL(u);
        } catch (_) {}
      });
      if (sendBtn) {
        sendBtn.disabled = false;
        if (origSendBtnHtml) sendBtn.innerHTML = origSendBtnHtml;
      }
    }
  }

  // =========================================================================
  // 5. Словарь кодов ошибок DTC (kb_data.json + VehicleDiagnosticSample.txt)
  // =========================================================================
  async function loadDtcDictionary() {
    const searchInput = el('dtcSearchInput');
    const sysSelect = el('dtcSystemSelect');
    const listContainer = el('dtcDictionaryList');
    if (!listContainer) return;

    const q = searchInput ? searchInput.value.trim() : '';
    const sys = sysSelect ? sysSelect.value : 'all';

    try {
      const resp = await fetch(`/api/dtc/?q=${encodeURIComponent(q)}&system=${encodeURIComponent(sys)}&limit=80`);
      if (!resp.ok) return;
      const data = await resp.json();
      const items = data.items || [];

      if (items.length === 0) {
        listContainer.innerHTML = `<div style="padding:16px; color:var(--text-muted); font-size:0.82rem;">Коды по данному фильтру не найдены.</div>`;
        return;
      }

      listContainer.innerHTML = items
        .map((item) => {
          const telemetryBadge = item.has_telemetry
            ? `<span class="spec-tag">Телеметрия • Health ${item.health_index}%</span>`
            : `<span class="spec-tag">Health ${item.health_index}%</span>`;
          return `
            <div class="dtc-card-item">
              <div class="dtc-card-top">
                <span class="dtc-pill">${escapeHtml(item.code)}</span>
                <span style="font-size:0.73rem; color:var(--text-muted); flex:1;">${escapeHtml(item.system_ru)}</span>
                <button type="button" class="btn-attach-code" data-attach-dtc="${escapeHtml(item.code)}">+ В запрос</button>
              </div>
              <div style="font-size:0.81rem; font-weight:600; color:var(--text-primary);">${escapeHtml(item.symptom)}</div>
              <div style="font-size:0.76rem; color:var(--text-secondary); margin-top:3px;">Решение: ${escapeHtml(item.solution)}</div>
              <div class="check-meta-tags" style="margin-top:6px;">${telemetryBadge}</div>
            </div>
          `;
        })
        .join('');

      listContainer.querySelectorAll('[data-attach-dtc]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const code = btn.dataset.attachDtc;
          if (code && !state.stagedCodes.includes(code)) {
            state.stagedCodes.push(code);
            renderStagingBar();
          }
        });
      });
    } catch (err) {
      console.error('Ошибка загрузки словаря DTC:', err);
    }
  }

  // =========================================================================
  // 6. Встроенная камера внутри интерфейса (Requirement #6)
  // =========================================================================
  async function startCameraStream(videoElement, facingMode) {
    if (!videoElement) return null;
    try {
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: facingMode || 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        videoElement.srcObject = stream;
        return stream;
      }
    } catch (err) {
      console.warn('Физическая веб-камера недоступна, доступен генератор тестового диагностического кадра:', err);
    }
    return null;
  }

  function stopStream(stream) {
    if (stream && stream.getTracks) {
      stream.getTracks().forEach((t) => t.stop());
    }
  }

  function generateSyntheticDiagnosticFrame() {
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 600;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0B0F17';
    ctx.fillRect(0, 0, 800, 600);

    // Рисуем контур приборной панели и индикатор Check Engine / P0300
    ctx.strokeStyle = '#38BDF8';
    ctx.lineWidth = 3;
    ctx.strokeRect(40, 40, 720, 520);

    ctx.fillStyle = '#F97316';
    ctx.fillRect(120, 180, 180, 110);
    ctx.fillStyle = '#EF4444';
    ctx.beginPath();
    ctx.arc(540, 235, 55, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#F8FAFC';
    ctx.font = 'bold 28px monospace';
    ctx.fillText('CHECK ENGINE / MIL ACTIVE', 110, 360);
    ctx.font = '22px monospace';
    ctx.fillStyle = '#38BDF8';
    ctx.fillText('OBD-II LIVE CAPTURE • DTC P0300 / C0050', 110, 410);
    return canvas.toDataURL('image/jpeg', 0.9);
  }

  function captureVideoFrame(videoEl) {
    if (videoEl && videoEl.srcObject && videoEl.videoWidth > 0) {
      const canvas = document.createElement('canvas');
      canvas.width = videoEl.videoWidth;
      canvas.height = videoEl.videoHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(videoEl, 0, 0);
      return canvas.toDataURL('image/jpeg', 0.88);
    }
    return generateSyntheticDiagnosticFrame();
  }

  // =========================================================================
  // 7. Голосовой ввод (Прямой нативный аудиовход Gemma 4 16 кГц + Спектрограммный пульсатор)
  // =========================================================================
  function setMicRecordingVisualState(active) {
    const btns = [el('btnVoiceRecord'), el('btnArVoiceTrigger')];
    const wraps = [el('micButtonWrap'), el('arMicButtonWrap')];
    btns.forEach((b) => {
      if (b) b.classList.toggle('recording', active);
    });
    wraps.forEach((w) => {
      if (w) {
        w.classList.toggle('recording', active);
        if (!active) w.style.setProperty('--mic-level', '0');
      }
    });
  }

  function startMicSpectrogram(stream) {
    stopMicSpectrogram();
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const audioCtx = new AudioCtx();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = 0.84;
      source.connect(analyser);

      state.audioCtx = audioCtx;
      state.analyserNode = analyser;
      state.smoothedBands.fill(0);
      state.smoothedEnergy = 0;

      const freqData = new Uint8Array(analyser.frequencyBinCount);
      const canvases = [el('micSpectrogramCanvas'), el('arMicSpectrogramCanvas')].filter(Boolean);
      const wraps = [el('micButtonWrap'), el('arMicButtonWrap')].filter(Boolean);
      const numBars = state.smoothedBands.length;
      const startTime = performance.now();

      const renderFrame = (now) => {
        if (!state.isRecording) return;
        analyser.getByteFrequencyData(freqData);
        const t = (now - startTime) * 0.001;

        let totalEnergy = 0;
        for (let i = 0; i < numBars; i++) {
          const binIdx = Math.min(freqData.length - 1, Math.floor((i / numBars) * (freqData.length * 0.72)) + 1);
          const rawNorm = freqData[binIdx] / 255.0;
          // Плавная органическая базовая волна + реакция на спектр голоса
          const idleWave = 0.12 + 0.07 * Math.sin(t * 3.4 + i * 0.45) + 0.04 * Math.cos(t * 2.1 - i * 0.3);
          const target = Math.min(1.0, idleWave + Math.pow(rawNorm, 0.85) * 0.92);
          // Экспоненциальное сглаживание (плавный подъем и мягкое затухание)
          const lerpFactor = target > state.smoothedBands[i] ? 0.28 : 0.14;
          state.smoothedBands[i] += (target - state.smoothedBands[i]) * lerpFactor;
          totalEnergy += state.smoothedBands[i];
        }

        const avgEnergy = totalEnergy / numBars;
        state.smoothedEnergy += (avgEnergy - state.smoothedEnergy) * 0.22;
        const levelStr = state.smoothedEnergy.toFixed(3);
        wraps.forEach((w) => w.style.setProperty('--mic-level', levelStr));

        canvases.forEach((canvas) => {
          const ctx = canvas.getContext('2d');
          if (!ctx) return;
          const w = canvas.width;
          const h = canvas.height;
          const cx = w / 2;
          const cy = h / 2;
          ctx.clearRect(0, 0, w, h);

          // 1. Плавное гармоническое кольцо-пульсатор вокруг кнопки микрофона
          const baseRadius = 23.5;
          const pulseRadius = baseRadius + 2.5 + state.smoothedEnergy * 9.5;
          const ringGrad = ctx.createRadialGradient(cx, cy, baseRadius - 2, cx, cy, pulseRadius + 8);
          ringGrad.addColorStop(0, 'rgba(249, 115, 22, 0.0)');
          ringGrad.addColorStop(0.55, `rgba(249, 115, 22, ${(0.22 + state.smoothedEnergy * 0.38).toFixed(3)})`);
          ringGrad.addColorStop(0.85, `rgba(239, 68, 68, ${(0.14 + state.smoothedEnergy * 0.28).toFixed(3)})`);
          ringGrad.addColorStop(1, 'rgba(56, 189, 248, 0.0)');

          ctx.beginPath();
          ctx.arc(cx, cy, pulseRadius + 4, 0, Math.PI * 2);
          ctx.fillStyle = ringGrad;
          ctx.fill();

          // 2. Радиальные лепестки спектрограммы вокруг микрофончика
          ctx.lineCap = 'round';
          ctx.lineWidth = 2.6;
          const rotationOffset = t * 0.55;

          for (let i = 0; i < numBars; i++) {
            const angle = (i / numBars) * Math.PI * 2 + rotationOffset;
            const amp = state.smoothedBands[i];
            const innerR = baseRadius + 1.0;
            const barLen = 2.5 + amp * 14.0;
            const outerR = innerR + barLen;

            const x1 = cx + Math.cos(angle) * innerR;
            const y1 = cy + Math.sin(angle) * innerR;
            const x2 = cx + Math.cos(angle) * outerR;
            const y2 = cy + Math.sin(angle) * outerR;

            const hueMix = i / numBars;
            const rCol = Math.round(249 - hueMix * 15);
            const gCol = Math.round(115 + Math.sin(hueMix * Math.PI) * 55);
            const bCol = Math.round(22 + amp * 165);
            const alpha = (0.45 + amp * 0.55).toFixed(3);

            ctx.strokeStyle = `rgba(${rCol}, ${gCol}, ${bCol}, ${alpha})`;
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
          }
        });

        state.spectrogramRafId = requestAnimationFrame(renderFrame);
      };

      state.spectrogramRafId = requestAnimationFrame(renderFrame);
    } catch (e) {
      console.debug('Не удалось инициализировать спектрограмму Web Audio API:', e);
    }
  }

  function stopMicSpectrogram() {
    if (state.spectrogramRafId) {
      cancelAnimationFrame(state.spectrogramRafId);
      state.spectrogramRafId = null;
    }
    if (state.audioCtx) {
      try {
        state.audioCtx.close();
      } catch (_) {}
      state.audioCtx = null;
      state.analyserNode = null;
    }
    [el('micSpectrogramCanvas'), el('arMicSpectrogramCanvas')].forEach((c) => {
      if (c) {
        const ctx = c.getContext('2d');
        ctx?.clearRect(0, 0, c.width, c.height);
      }
    });
  }

  async function stopVoiceRecordingAndWait() {
    state.isRecording = false;
    setMicRecordingVisualState(false);
    stopMicSpectrogram();

    if (state.speechRecognition) {
      try {
        state.speechRecognition.stop();
      } catch (_) {}
      state.speechRecognition = null;
    }

    if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
      try {
        state.mediaRecorder.stop();
      } catch (_) {}
    }

    if (state.stopRecordingPromise) {
      try {
        await state.stopRecordingPromise;
      } catch (_) {}
      state.stopRecordingPromise = null;
    }
  }

  async function toggleVoiceRecording() {
    if (state.isRecording) {
      await stopVoiceRecordingAndWait();
      return;
    }

    state.isRecording = true;
    state.stagedVoiceTranscript = '';
    setMicRecordingVisualState(true);

    // Параллельно запускаем браузерный распознаватель для мгновенного предпросмотра (если поддерживается)
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRec) {
      try {
        const rec = new SpeechRec();
        rec.lang = 'ru-RU';
        rec.interimResults = true;
        rec.onresult = (ev) => {
          let t = '';
          for (let i = 0; i < ev.results.length; i++) {
            t += ev.results[i][0].transcript;
          }
          state.stagedVoiceTranscript = t.trim();
          const qInput = el('queryInput');
          if (qInput && state.stagedVoiceTranscript) {
            qInput.value = state.stagedVoiceTranscript;
          }
        };
        rec.start();
        state.speechRecognition = rec;
      } catch (e) {}
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      startMicSpectrogram(stream);

      const chunks = [];
      let mimeType = 'audio/webm';
      if (typeof MediaRecorder.isTypeSupported === 'function') {
        const preferred = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
        for (const cand of preferred) {
          if (MediaRecorder.isTypeSupported(cand)) {
            mimeType = cand;
            break;
          }
        }
      }

      const mr = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mr.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) chunks.push(ev.data);
      };

      state.stopRecordingPromise = new Promise((resolve) => {
        mr.onstop = () => {
          stopStream(stream);
          stopMicSpectrogram();
          if (chunks.length > 0) {
            const blob = new Blob(chunks, { type: mimeType || 'audio/webm' });
            state.stagedVoiceBlob = blob;
            renderStagingBar();
          }
          resolve();
        };
      });

      mr.start(150);
      state.mediaRecorder = mr;
    } catch (err) {
      state.isRecording = false;
      setMicRecordingVisualState(false);
      stopMicSpectrogram();
      alert('Микрофон недоступен или доступ запрещён браузером.');
    }
  }

  // =========================================================================
  // 8. Режим для AR-очков типа RayNeo (Два перетаскиваемых окна + Черный фон #000000)
  // =========================================================================
  function initDraggableArWindows() {
    document.querySelectorAll('[data-drag-window]').forEach((dragBar) => {
      const winId = dragBar.dataset.dragWindow;
      const winEl = el(winId);
      if (!winEl) return;

      let isDragging = false;
      let startX = 0;
      let startY = 0;
      let origLeft = 0;
      let origTop = 0;

      dragBar.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button')) return;
        isDragging = true;
        dragBar.setPointerCapture(e.pointerId);
        const rect = winEl.getBoundingClientRect();
        startX = e.clientX;
        startY = e.clientY;
        origLeft = rect.left;
        origTop = rect.top;
        winEl.style.right = 'auto';
        winEl.style.bottom = 'auto';
        winEl.style.left = `${origLeft}px`;
        winEl.style.top = `${origTop}px`;
      });

      dragBar.addEventListener('pointermove', (e) => {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        const nextLeft = Math.max(4, Math.min(window.innerWidth - 120, origLeft + dx));
        const nextTop = Math.max(44, Math.min(window.innerHeight - 80, origTop + dy));
        winEl.style.left = `${nextLeft}px`;
        winEl.style.top = `${nextTop}px`;
      });

      const endDrag = (e) => {
        if (!isDragging) return;
        isDragging = false;
        try {
          dragBar.releasePointerCapture(e.pointerId);
        } catch (_) {}
      };

      dragBar.addEventListener('pointerup', endDrag);
      dragBar.addEventListener('pointercancel', endDrag);
    });
  }

  async function setArSubmode(mode) {
    state.arSubmode = mode === 'passthrough' ? 'passthrough' : 'rayneo';
    const overlay = el('arHudOverlay');
    const btnRayneo = el('btnArModeRayneo');
    const btnPassthrough = el('btnArModePassthrough');
    const bgVideo = el('arBgVideoEl');

    if (btnRayneo) btnRayneo.classList.toggle('active', state.arSubmode === 'rayneo');
    if (btnPassthrough) btnPassthrough.classList.toggle('active', state.arSubmode === 'passthrough');

    if (state.arSubmode === 'passthrough') {
      if (overlay) overlay.classList.add('passthrough-mode');
      if (bgVideo) {
        bgVideo.style.display = 'block';
        if (!state.arBgCameraStream) {
          state.arBgCameraStream = await startCameraStream(bgVideo, state.cameraFacingMode);
        }
      }
    } else {
      if (overlay) overlay.classList.remove('passthrough-mode');
      if (bgVideo) {
        bgVideo.style.display = 'none';
        stopStream(state.arBgCameraStream);
        state.arBgCameraStream = null;
      }
    }
  }

  async function enterArMode(submode) {
    document.body.classList.add('ar-glasses-mode');
    try {
      if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen();
      }
    } catch (_) {}
    const arVideo = el('arCameraVideoEl');
    state.arCameraStream = await startCameraStream(arVideo, state.cameraFacingMode);
    await setArSubmode(submode || state.arSubmode || 'rayneo');
  }

  function exitArMode() {
    document.body.classList.remove('ar-glasses-mode');
    stopStream(state.arCameraStream);
    stopStream(state.arBgCameraStream);
    state.arCameraStream = null;
    state.arBgCameraStream = null;
    const bgVideo = el('arBgVideoEl');
    if (bgVideo) bgVideo.style.display = 'none';
    try {
      if (document.fullscreenElement && document.exitFullscreen) {
        document.exitFullscreen();
      }
    } catch (_) {}
  }

  // =========================================================================
  // 9. Инициализация событий и PWA Service Worker
  // =========================================================================
  function initEvents() {
    // Отправка запроса
    el('btnSendQuery')?.addEventListener('click', () => sendDiagnosticQuery());
    el('queryInput')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendDiagnosticQuery();
      }
    });

    // Быстрые сценарии симптомов
    document.querySelectorAll('[data-quick-query]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const code = btn.dataset.quickCode;
        if (code && !state.stagedCodes.includes(code)) {
          state.stagedCodes.push(code);
        }
        sendDiagnosticQuery(btn.dataset.quickQuery);
      });
    });

    // Создание и переключение сессий
    el('btnNewSession')?.addEventListener('click', async () => {
      const veh = el('vehicleInfoInput')?.value || 'Автомобиль OBD-II';
      const resp = await fetch('/api/sessions/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vehicle_info: veh }),
      });
      if (resp.ok) {
        window.location.reload();
      }
    });

    document.querySelectorAll('.session-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('[data-delete-session]')) return;
        loadSession(item.dataset.sessionId);
      });
    });

    document.querySelectorAll('[data-delete-session]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const sid = btn.dataset.deleteSession;
        const resp = await fetch(`/api/sessions/${sid}/`, { method: 'DELETE' });
        if (resp.ok) window.location.reload();
      });
    });

    // Прикрепление файлов
    const fileInput = el('hiddenFileInput');
    el('btnAttachFile')?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', () => {
      Array.from(fileInput.files || []).forEach((f) => state.stagedFiles.push(f));
      fileInput.value = '';
      renderStagingBar();
    });

    // Переключение вкладок правой панели
    document.querySelectorAll('[data-inspector-tab]').forEach((tabBtn) => {
      tabBtn.addEventListener('click', () => {
        const targetId = tabBtn.dataset.inspectorTab;
        document.querySelectorAll('[data-inspector-tab]').forEach((b) => {
          b.classList.toggle('active', b === tabBtn);
          b.setAttribute('aria-selected', b === tabBtn ? 'true' : 'false');
        });
        document.querySelectorAll('.inspector-pane').forEach((pane) => {
          pane.classList.toggle('active', pane.id === targetId);
        });
      });
    });

    el('btnFocusDtcTab')?.addEventListener('click', () => {
      const dtcTabBtn = document.querySelector('[data-inspector-tab="paneDtc"]');
      dtcTabBtn?.click();
      el('panelInspector')?.classList.add('mobile-active');
      el('dtcSearchInput')?.focus();
    });

    // Поиск по словарю DTC
    el('dtcSearchInput')?.addEventListener('input', () => loadDtcDictionary());
    el('dtcSystemSelect')?.addEventListener('change', () => loadDtcDictionary());

    // Камера внутри интерфейса
    el('btnOpenCamera')?.addEventListener('click', async () => {
      el('cameraModal')?.classList.add('open');
      state.cameraStream = await startCameraStream(el('cameraVideoEl'), state.cameraFacingMode);
    });
    el('btnCloseCameraModal')?.addEventListener('click', () => {
      el('cameraModal')?.classList.remove('open');
      stopStream(state.cameraStream);
      state.cameraStream = null;
    });
    el('btnSwitchCameraFacing')?.addEventListener('click', async () => {
      state.cameraFacingMode = state.cameraFacingMode === 'environment' ? 'user' : 'environment';
      stopStream(state.cameraStream);
      state.cameraStream = await startCameraStream(el('cameraVideoEl'), state.cameraFacingMode);
    });
    el('btnCapturePhoto')?.addEventListener('click', () => {
      const b64 = captureVideoFrame(el('cameraVideoEl'));
      state.stagedCameraShots.push(b64);
      renderStagingBar();
      el('btnCloseCameraModal')?.click();
    });
    el('btnGenerateTestShot')?.addEventListener('click', () => {
      const b64 = generateSyntheticDiagnosticFrame();
      state.stagedCameraShots.push(b64);
      renderStagingBar();
      el('btnCloseCameraModal')?.click();
    });

    // Голосовой ввод
    el('btnVoiceRecord')?.addEventListener('click', () => toggleVoiceRecording());

    // Режим AR-очков (RayNeo Optical / Камера-фон)
    el('btnEnterArMode')?.addEventListener('click', () => enterArMode('rayneo'));
    el('btnExitArMode')?.addEventListener('click', () => exitArMode());
    el('btnArModeRayneo')?.addEventListener('click', () => setArSubmode('rayneo'));
    el('btnArModePassthrough')?.addEventListener('click', () => setArSubmode('passthrough'));
    el('btnArFullscreen')?.addEventListener('click', () => {
      if (document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen().catch(() => {});
      }
    });
    el('btnArResetLayout')?.addEventListener('click', () => {
      const wCam = el('arWindowCamera');
      const wAss = el('arWindowAssistant');
      if (wCam) {
        wCam.style.left = '28px';
        wCam.style.top = '64px';
      }
      if (wAss) {
        wAss.style.left = 'auto';
        wAss.style.right = '28px';
        wAss.style.top = '64px';
      }
    });
    el('btnArSnapAndDiagnose')?.addEventListener('click', () => {
      const shot = captureVideoFrame(el('arCameraVideoEl'));
      state.stagedCameraShots.push(shot);
      sendDiagnosticQuery('Визуальная диагностика узла автомобиля с камеры AR-очков');
    });
    el('btnArSendQuick')?.addEventListener('click', () => {
      const inp = el('arQuickInput');
      if (inp && inp.value.trim()) {
        const val = inp.value.trim();
        inp.value = '';
        sendDiagnosticQuery(val);
      }
    });
    el('btnArVoiceTrigger')?.addEventListener('click', () => toggleVoiceRecording());

    // Сохранение настроек Vulkan / AirLLM Gemma 4 12B / Междиалоговой памяти
    const saveSettings = async () => {
      const payload = {
        llm_backend: el('settingBackend')?.value || 'airllm_vulkan',
        airllm_model_id: el('settingAirllmModel')?.value || 'google/gemma-4-12B-it-qat-w4a16-ct',
        airllm_compression: el('settingAirllmCompression')?.value || '4bit',
        gguf_model_rel_path: el('settingGgufPath')?.value || 'models/airllm_shards',
        vulkan_gpu_layers: Number(el('settingGpuLayers')?.value || 36),
        context_window_tokens: Number(el('settingCtxTokens')?.value || 32768),
        voice_mode: el('settingVoiceMode')?.value || 'direct_audio',
        cross_dialog_memory_enabled: Boolean(el('chkCrossDialogMemory')?.checked),
        global_memory_summary: el('globalSummaryTextarea')?.value || '',
      };
      const resp = await fetch('/api/settings/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (resp.ok) {
        const badge = el('backendDisplayBadge');
        if (badge) badge.textContent = `AirLLM ${payload.airllm_compression} + Vulkan`;
      }
    };

    el('btnSaveSettings')?.addEventListener('click', saveSettings);
    el('chkCrossDialogMemory')?.addEventListener('change', (e) => {
      const wrap = el('globalMemoryWrap');
      if (wrap) wrap.style.display = e.target.checked ? 'block' : 'none';
      saveSettings();
    });

    // Сохранение ручных правок выжимки диалога
    el('dialogSummaryTextarea')?.addEventListener('blur', async (e) => {
      if (!state.currentSessionId) return;
      await fetch(`/api/sessions/${state.currentSessionId}/`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ summary: e.target.value }),
      });
    });

    // Переключение светлой и темной темы
    el('btnToggleTheme')?.addEventListener('click', () => {
      const htmlEl = document.documentElement;
      const next = htmlEl.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      htmlEl.setAttribute('data-theme', next);
    });

    // Мобильная нижняя навигация (Thumb-Zone)
    document.querySelectorAll('[data-mobile-view]').forEach((navBtn) => {
      navBtn.addEventListener('click', () => {
        const view = navBtn.dataset.mobileView;
        document.querySelectorAll('[data-mobile-view]').forEach((b) => b.classList.toggle('active', b === navBtn));
        const sidebar = el('panelSidebar');
        const inspector = el('panelInspector');
        sidebar?.classList.remove('mobile-active');
        inspector?.classList.remove('mobile-active');

        if (view === 'sessions') {
          sidebar?.classList.add('mobile-active');
        } else if (view === 'checklist') {
          inspector?.classList.add('mobile-active');
          document.querySelector('[data-inspector-tab="paneChecklist"]')?.click();
        } else if (view === 'dtc') {
          inspector?.classList.add('mobile-active');
          document.querySelector('[data-inspector-tab="paneDtc"]')?.click();
        }
      });
    });

    // Закрытие мобильных выезжающих панелей
    document.querySelectorAll('.js-close-mobile-drawer').forEach((btn) => {
      btn.addEventListener('click', () => {
        el('panelSidebar')?.classList.remove('mobile-active');
        el('panelInspector')?.classList.remove('mobile-active');
        document.querySelectorAll('[data-mobile-view]').forEach((b) => b.classList.remove('active'));
      });
    });

    // Делегирование удаления отдельного сообщения и чекбоксов в ленте чата
    const chatFeedEl = el('chatFeed');
    chatFeedEl?.addEventListener('click', (e) => {
      const delBtn = e.target.closest('.btn-msg-delete');
      if (delBtn) {
        const msgId = delBtn.dataset.msgId;
        const card = delBtn.closest('.msg-card');
        deleteSingleMessage(msgId, card);
      }
    });

    chatFeedEl?.addEventListener('change', (e) => {
      if (e.target.matches('.msg-select-cb')) {
        updateSelectionToolbar();
      }
    });

    el('chkSelectAllMessages')?.addEventListener('change', (e) => {
      const isChecked = e.target.checked;
      document.querySelectorAll('.msg-select-cb').forEach((cb) => {
        cb.checked = isChecked;
      });
      updateSelectionToolbar();
    });

    el('btnDeleteSelectedMessages')?.addEventListener('click', () => {
      deleteSelectedMessages();
    });

    el('btnClearAllMessages')?.addEventListener('click', () => {
      clearAllMessages();
    });

    initDraggableArWindows();
    if (document.body.classList.contains('ar-glasses-mode')) {
      startCameraStream(el('arCameraVideoEl'), state.cameraFacingMode).then((s) => {
        state.arCameraStream = s;
      });
    }

    // Регистрация Service Worker для PWA
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    initEvents();
    loadSession(state.currentSessionId);
    loadDtcDictionary();
  });
})();
