/**
 * AutoDiag Pro AI — Клиентское ядро интерфейса (Mobile-First PWA + Desktop + RayNeo AR HUD)
 * Поддерживает:
 * - Неблокирующий фоновый воркер выжимки контекста с индикацией сброса при приоритете ответа
 * - Интерактивные чеклисты задач ремонта и блоки инвентаря с синхронизацией состояния
 * - Словарь кодов ошибок DTC (kb_data.json + VehicleDiagnosticSample.txt)
 * - Встроенную камеру, прикрепление фото/документов и голосовой ввод (Direct Audio / GGML Whisper)
 * - Режим AR-очков типа RayNeo (два перетаскиваемых плавающих окна на чисто черном фоне #000000)
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
    cameraStream: null,
    arCameraStream: null,
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

    const roleTitle = msg.role === 'user' ? 'ЗАПРОС МАСТЕРА / ВОДИТЕЛЯ' : 'AUTODIAG PRO AI • ВЕДУЩИЙ ДИАГНОСТ';
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
          attachmentsHtml += `<span class="attachment-doc-chip">Аудио (${escapeHtml(att.mode || 'GGML')}): ${escapeHtml(att.transcript || '')}</span>`;
        } else {
          attachmentsHtml += `<span class="attachment-doc-chip">Документ: ${escapeHtml(att.name || 'Файл')}</span>`;
        }
      });
      attachmentsHtml += `</div>`;
    }

    const bodyHtml =
      msg.role === 'assistant' ? buildStructuredCardHtml(msg) : `<div>${formatMarkdownLite(msg.content)}</div>`;

    wrapper.innerHTML = `
      <div class="msg-header">
        <span class="msg-role-badge">${roleTitle}</span>
        <span>${escapeHtml(msg.created_at || '')}</span>
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
          feed.innerHTML = `
            <div class="msg-card msg-assistant">
              <div class="msg-header">
                <span class="msg-role-badge">AUTODIAG PRO AI • ГОТОВ К ДИАГНОСТИКЕ</span>
                <span>VULKAN + AIRLLM</span>
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
  // 4. Отправка диагностического запроса
  // =========================================================================
  async function sendDiagnosticQuery(overrideQuery) {
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

    const sendBtn = el('btnSendQuery');
    if (sendBtn) sendBtn.disabled = true;

    const formData = new FormData();
    formData.append('session_id', state.currentSessionId);
    formData.append('query', queryText);
    formData.append('vehicle_info', vehInput ? vehInput.value.trim() : '');
    formData.append('dtc_codes', JSON.stringify(state.stagedCodes));

    if (state.stagedCameraShots.length > 0) {
      formData.append('camera_image_b64', state.stagedCameraShots[0]);
    }
    state.stagedFiles.forEach((file) => {
      formData.append('attachments', file);
    });
    if (state.stagedVoiceBlob) {
      formData.append('attachments', state.stagedVoiceBlob, 'voice_input.webm');
    }
    if (state.stagedVoiceTranscript) {
      formData.append('voice_transcript', state.stagedVoiceTranscript);
    }

    // Очищаем поле ввода сразу для высокой отзывчивости
    if (typeof overrideQuery !== 'string' && queryInput) {
      queryInput.value = '';
    }
    state.stagedCodes = [];
    state.stagedFiles = [];
    state.stagedCameraShots = [];
    state.stagedVoiceBlob = null;
    state.stagedVoiceTranscript = '';
    renderStagingBar();

    try {
      const resp = await fetch('/api/ask/', {
        method: 'POST',
        body: formData,
      });
      const data = await resp.json();
      if (!resp.ok) {
        alert(data.error || 'Ошибка выполнения диагностики');
        return;
      }

      if (data.worker_preempted) {
        updateWorkerUi('aborted_for_priority', null, null, true);
      }

      const feed = el('chatFeed');
      if (feed) {
        if (data.user_message) {
          feed.appendChild(renderMessageElement(data.user_message));
        }
        if (data.assistant_message) {
          feed.appendChild(renderMessageElement(data.assistant_message));
          bindTaskCheckboxes(feed);
          updateInspectorAndArFromAssistant(data.assistant_message);
        }
        feed.scrollTop = feed.scrollHeight;
      }

      // Запускаем опрос фонового воркера, который обновляет краткую выжимку
      setTimeout(pollWorkerStatus, 250);
    } catch (err) {
      console.error('Ошибка отправки запроса:', err);
    } finally {
      if (sendBtn) sendBtn.disabled = false;
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
  // 7. Голосовой ввод (Прямое аудио или GGML Whisper — Requirement #12)
  // =========================================================================
  async function toggleVoiceRecording() {
    const btn = el('btnVoiceRecord');
    if (state.isRecording) {
      state.isRecording = false;
      if (btn) btn.classList.remove('recording');
      if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
        state.mediaRecorder.stop();
      }
      if (state.speechRecognition) {
        try {
          state.speechRecognition.stop();
        } catch (e) {}
      }
      return;
    }

    state.isRecording = true;
    state.stagedVoiceTranscript = '';
    if (btn) btn.classList.add('recording');

    // Параллельно запускаем браузерный распознаватель для мгновенного предпросмотра
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
      const chunks = [];
      const mr = new MediaRecorder(stream);
      mr.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) chunks.push(ev.data);
      };
      mr.onstop = () => {
        stopStream(stream);
        const blob = new Blob(chunks, { type: 'audio/webm' });
        state.stagedVoiceBlob = blob;
        renderStagingBar();
      };
      mr.start();
      state.mediaRecorder = mr;
    } catch (err) {
      state.isRecording = false;
      if (btn) btn.classList.remove('recording');
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

  async function enterArMode() {
    document.body.classList.add('ar-glasses-mode');
    try {
      if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen();
      }
    } catch (_) {}
    const arVideo = el('arCameraVideoEl');
    state.arCameraStream = await startCameraStream(arVideo, state.cameraFacingMode);
  }

  function exitArMode() {
    document.body.classList.remove('ar-glasses-mode');
    stopStream(state.arCameraStream);
    state.arCameraStream = null;
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

    // Режим AR-очков RayNeo
    el('btnEnterArMode')?.addEventListener('click', () => enterArMode());
    el('btnExitArMode')?.addEventListener('click', () => exitArMode());
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
      sendDiagnosticQuery('Визуальная диагностика узла автомобиля с камеры AR-очков RayNeo');
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

    // Сохранение настроек Vulkan / AirLLM / Междиалоговой памяти
    const saveSettings = async () => {
      const payload = {
        llm_backend: el('settingBackend')?.value || 'hybrid_auto',
        airllm_model_id: el('settingAirllmModel')?.value || 'Qwen/Qwen2.5-32B-Instruct',
        airllm_compression: el('settingAirllmCompression')?.value || '4bit',
        gguf_model_rel_path: el('settingGgufPath')?.value || 'models/gemma-4-12b-it-Q4_K_M.gguf',
        vulkan_gpu_layers: Number(el('settingGpuLayers')?.value || 37),
        context_window_tokens: Number(el('settingCtxTokens')?.value || 2048),
        voice_mode: el('settingVoiceMode')?.value || 'auto',
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
