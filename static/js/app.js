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

  const isAuthInitial = document.body.dataset.isAuthenticated === 'true';
  const initialSessionId = document.body.dataset.initialSession || 'demo-session-1';

  const state = {
    currentSessionId: initialSessionId,
    isDemo: !isAuthInitial,
    stagedCodes: [],
    stagedFiles: [],
    stagedCameraShots: [],
    stagedVoiceBlob: null,
    stagedVoiceAudioBuffer: null,
    stagedVoicePreviewUrl: null,
    stagedVoiceDuration: 0,
    recordingStartTime: 0,
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
    arSubmode: 'rayneo', // 'rayneo' | 'passthrough' (VR режим)
    cameraFacingMode: 'environment',
    arWinCameraFacing: 'environment',
    arBgCameraFacing: 'environment',
    arWinDeviceIdx: 0,
    arBgDeviceIdx: 0,
    workerPollTimer: null,
    latestAssistantMessage: null,
    activeProjectId: '',
    activeTag: '',
    demoProjects: [],
    demoSessions: [
      {
        id: initialSessionId,
        title: 'Демо-диагностика',
        is_pinned: false,
        tag: '',
        project_id: null,
        vehicle_info: '',
        summary: '',
        updated_at: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
      },
    ],
    demoMessagesBySession: {},
    demoSettings: {
      cross_dialog_memory_enabled: true,
      global_memory_summary: '',
    },
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
  // Универсальная система стилизованных модальных диалогов (Confirm / Alert / Prompt)
  // =========================================================================
  const DIALOG_ICONS = {
    danger: `
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
        <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
      </svg>
    `,
    warning: `
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
    `,
    info: `
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
      </svg>
    `,
    error: `
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
      </svg>
    `,
    prompt: `
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
      </svg>
    `,
    success: `
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
      </svg>
    `,
  };

  let activeDialogResolver = null;

  function showCustomDialog({
    type = 'confirm',
    title = 'Подтверждение',
    subtitle = 'ИИдеал Авто',
    message = '',
    icon = 'info',
    confirmText = '',
    cancelText = 'Отмена',
    defaultValue = '',
    placeholder = '',
    label = 'Значение:',
    danger = false,
  }) {
    return new Promise((resolve) => {
      const modal = el('customDialogModal');
      const iconBox = el('customDialogIconBox');
      const titleEl = el('customDialogTitle');
      const subtitleEl = el('customDialogSubtitle');
      const msgEl = el('customDialogMessage');
      const inputGroup = el('customDialogInputGroup');
      const inputEl = el('customDialogInput');
      const inputLabel = el('customDialogInputLabel');
      const btnCancel = el('btnCustomDialogCancel');
      const btnConfirm = el('btnCustomDialogConfirm');
      const btnClose = el('btnCustomDialogClose');

      if (!modal) {
        if (type === 'confirm') return resolve(window.confirm(message));
        if (type === 'prompt') return resolve(window.prompt(message, defaultValue));
        window.alert(message);
        return resolve();
      }

      if (activeDialogResolver) {
        activeDialogResolver(type === 'prompt' ? null : false);
        activeDialogResolver = null;
      }

      let iconType = icon;
      if (type === 'confirm' && danger) iconType = 'danger';
      else if (type === 'prompt') iconType = 'prompt';
      else if (type === 'alert' && (!icon || icon === 'info')) iconType = 'info';

      if (iconBox) {
        iconBox.className = `custom-dialog-icon-box ${iconType}`;
        iconBox.innerHTML = DIALOG_ICONS[iconType] || DIALOG_ICONS.info;
      }

      if (titleEl) titleEl.textContent = title;
      if (subtitleEl) subtitleEl.textContent = subtitle;
      if (msgEl) msgEl.textContent = message;

      if (inputGroup && inputEl) {
        if (type === 'prompt') {
          inputGroup.style.display = 'flex';
          if (inputLabel) inputLabel.textContent = label;
          inputEl.value = defaultValue || '';
          inputEl.placeholder = placeholder || '';
        } else {
          inputGroup.style.display = 'none';
          inputEl.value = '';
        }
      }

      if (btnCancel) {
        btnCancel.style.display = type === 'alert' ? 'none' : 'inline-flex';
        btnCancel.textContent = cancelText || 'Отмена';
      }

      if (btnConfirm) {
        btnConfirm.textContent =
          confirmText ||
          (type === 'alert' ? 'Понятно' : type === 'prompt' ? 'Сохранить' : danger ? 'Удалить' : 'Подтвердить');
        btnConfirm.className = `btn-send custom-dialog-btn-confirm ${danger ? 'danger' : ''}`;
      }

      modal.style.display = 'flex';
      modal.setAttribute('aria-hidden', 'false');

      setTimeout(() => {
        if (type === 'prompt' && inputEl) {
          inputEl.focus({ preventScroll: true });
          inputEl.select();
        } else if (btnConfirm) {
          btnConfirm.focus({ preventScroll: true });
        }
        if (window.scrollX !== 0) window.scrollTo(0, 0);
      }, 40);

      let keyHandler = null;

      const cleanup = () => {
        modal.style.display = 'none';
        modal.setAttribute('aria-hidden', 'true');
        if (keyHandler) document.removeEventListener('keydown', keyHandler);
        activeDialogResolver = null;
      };

      const doConfirm = () => {
        const val = inputEl ? inputEl.value : '';
        cleanup();
        if (type === 'prompt') {
          resolve(val);
        } else {
          resolve(true);
        }
      };

      const doCancel = () => {
        cleanup();
        if (type === 'prompt') {
          resolve(null);
        } else if (type === 'confirm') {
          resolve(false);
        } else {
          resolve();
        }
      };

      activeDialogResolver = (val) => {
        cleanup();
        resolve(val);
      };

      if (btnConfirm) btnConfirm.onclick = () => doConfirm();
      if (btnCancel) btnCancel.onclick = () => doCancel();
      if (btnClose) btnClose.onclick = () => doCancel();

      keyHandler = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          doCancel();
        } else if (e.key === 'Enter') {
          if (document.activeElement === inputEl || document.activeElement === btnConfirm) {
            e.preventDefault();
            doConfirm();
          }
        }
      };

      document.addEventListener('keydown', keyHandler);
    });
  }

  const uiConfirm = (message, title = 'Подтверждение', danger = false, confirmText = 'Подтвердить') => {
    return showCustomDialog({
      type: 'confirm',
      title,
      message,
      danger,
      confirmText,
      icon: danger ? 'danger' : 'warning',
    });
  };

  const uiAlert = (message, title = 'Уведомление', icon = 'info', confirmText = 'Понятно') => {
    return showCustomDialog({
      type: 'alert',
      title,
      message,
      icon,
      confirmText,
    });
  };

  const uiPrompt = (message, defaultValue = '', title = 'Ввод данных', confirmText = 'Сохранить') => {
    return showCustomDialog({
      type: 'prompt',
      title,
      message,
      defaultValue,
      confirmText,
      icon: 'prompt',
    });
  };

  // Экспорт на глобальный объект для доступа из любых скриптов и тестов
  window.uiAlert = uiAlert;
  window.uiConfirm = uiConfirm;
  window.uiPrompt = uiPrompt;
  window.showCustomDialog = showCustomDialog;

  // =========================================================================
  // 1. Утилиты предпросмотра файлов и очереди вложений (Staging Bar)
  // =========================================================================
  function formatFileSize(bytes) {
    if (!bytes || isNaN(bytes)) return '';
    if (bytes < 1024) return bytes + ' Б';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' КБ';
    return (bytes / (1024 * 1024)).toFixed(1) + ' МБ';
  }

  function getFileExtAndClass(filename) {
    const parts = String(filename || '').split('.');
    const ext = parts.length > 1 ? parts.pop().toLowerCase() : 'txt';
    let badgeClass = 'staged-icon-generic';
    if (['pdf'].includes(ext)) badgeClass = 'staged-icon-pdf';
    else if (['doc', 'docx'].includes(ext)) badgeClass = 'staged-icon-docx';
    else if (['xls', 'xlsx'].includes(ext)) badgeClass = 'staged-icon-xlsx';
    else if (['log', 'txt', 'ini', 'cfg', 'conf'].includes(ext)) badgeClass = 'staged-icon-log';
    else if (['csv', 'tsv'].includes(ext)) badgeClass = 'staged-icon-csv';
    else if (['json'].includes(ext)) badgeClass = 'staged-icon-json';
    else if (['obd'].includes(ext)) badgeClass = 'staged-icon-generic';
    return { ext: ext.toUpperCase(), badgeClass };
  }

  function openImageLightbox(src, title) {
    const modal = el('imageLightboxModal');
    const imgEl = el('imageLightboxImg');
    const titleEl = el('imageLightboxTitle');
    if (!modal || !imgEl) return;
    imgEl.src = src;
    if (titleEl) titleEl.textContent = title || 'Просмотр изображения';
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
  }

  function closeImageLightbox() {
    const modal = el('imageLightboxModal');
    const imgEl = el('imageLightboxImg');
    if (!modal) return;
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
    if (imgEl) imgEl.src = '';
  }

  function formatAudioTime(sec) {
    if (isNaN(sec) || !isFinite(sec) || sec < 0) return '0:00';
    const s = Math.floor(sec);
    const m = Math.floor(s / 60);
    const rem = String(s % 60).padStart(2, '0');
    return `${m}:${rem}`;
  }

  function fetchDocPreview(file) {
    if (!file || file._parsedDoc || file._parsing) return;
    const isImg = (file.type && file.type.startsWith('image/')) || /\.(jpe?g|png|webp|bmp|gif)$/i.test(file.name);
    const isAud = (file.type && file.type.startsWith('audio/')) || /\.(wav|mp3|ogg|m4a|flac|webm|aac)$/i.test(file.name);
    if (isImg || isAud) return;

    file._parsing = true;
    renderStagingBar();

    const formData = new FormData();
    formData.append('file', file);

    fetch('/api/preview-document/', {
      method: 'POST',
      body: formData,
      credentials: 'same-origin',
    })
      .then(async (res) => {
        file._parsing = false;
        if (res.ok) {
          const data = await res.json();
          file._parsedDoc = data;
        } else {
          readDocLocally(file);
        }
        renderStagingBar();
      })
      .catch(() => {
        file._parsing = false;
        readDocLocally(file);
        renderStagingBar();
      });
  }

  function readDocLocally(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = String(e.target.result || '');
      const dtcMatches = Array.from(new Set(text.match(/\b[PBCU][0-3][0-9A-Fa-f]{3}\b/g) || []));
      file._parsedDoc = {
        filename: file.name,
        extension: (file.name.match(/\.[^.]+$/) || [''])[0].toLowerCase(),
        size_bytes: file.size,
        char_length: text.length,
        is_fully_processed: text.length <= 25000,
        processing_mode: text.length <= 25000 ? 'full' : 'smart_sampled',
        detected_dtc_codes: dtcMatches,
        llm_ready_text: text,
        embedded_images: [],
      };
      renderStagingBar();
    };
    reader.onerror = () => {
      file._parsedDoc = {
        filename: file.name,
        extension: '',
        size_bytes: file.size,
        char_length: 0,
        is_fully_processed: true,
        processing_mode: 'full',
        detected_dtc_codes: [],
        llm_ready_text: `[Файл ${file.name} прикреплен для обработки моделью]`,
        embedded_images: [],
      };
      renderStagingBar();
    };
    reader.readAsText(file.slice(0, 1000000));
  }

  function openDocumentPreviewModal(docData) {
    const modal = el('documentPreviewModal');
    if (!modal || !docData) return;

    const ext = (docData.extension || docData.name || '').replace(/^\./, '').toUpperCase() || 'DOC';
    const badgeEl = el('docPreviewBadge');
    if (badgeEl) {
      badgeEl.textContent = ext.slice(0, 4);
      const { badgeClass } = getFileExtAndClass(docData.filename || docData.name || 'file.txt');
      badgeEl.className = `doc-badge-pill ${badgeClass}`;
    }

    const titleEl = el('docPreviewTitle');
    if (titleEl) titleEl.textContent = docData.filename || docData.name || 'Технический документ';

    const charsEl = el('docPreviewChars');
    if (charsEl) charsEl.textContent = (docData.char_length || (docData.llm_ready_text || docData.extracted_text || '').length || 0).toLocaleString();

    const modePill = el('docPreviewModePill');
    const modeText = el('docPreviewModeText');
    const isFull = docData.is_fully_processed !== false;
    if (modePill && modeText) {
      modePill.className = `doc-status-pill ${isFull ? 'doc-status-full' : 'doc-status-sampled'}`;
      modeText.textContent = isFull ? 'Полный разбор (100% в промпте)' : 'Умная выборка (ошибки + телеметрия)';
    }

    const dtcWrap = el('docPreviewDtcWrap');
    const dtcCount = el('docPreviewDtcCount');
    const dtcs = docData.detected_dtc_codes || docData.detected_codes || [];
    if (dtcWrap && dtcCount) {
      if (dtcs.length) {
        dtcWrap.style.display = 'inline-flex';
        dtcCount.textContent = dtcs.length + ' (' + dtcs.slice(0, 4).join(', ') + (dtcs.length > 4 ? '...' : '') + ')';
      } else {
        dtcWrap.style.display = 'none';
      }
    }

    const imgsWrap = el('docPreviewImagesWrap');
    const imgsCount = el('docPreviewImagesCount');
    const imgs = docData.embedded_images || docData.extracted_images || [];
    if (imgsWrap && imgsCount) {
      if (imgs.length) {
        imgsWrap.style.display = 'inline-flex';
        imgsCount.textContent = imgs.length;
      } else {
        imgsWrap.style.display = 'none';
      }
    }

    const codeBox = el('docPreviewCodeBox');
    if (codeBox) {
      const promptText = docData.llm_ready_text || docData.extracted_text || docData.preview_excerpt || 'Содержимое документа не извлечено';
      codeBox.textContent = promptText;
    }

    const imgsSection = el('docPreviewImagesSection');
    const imgsGrid = el('docPreviewImagesGrid');
    if (imgsSection && imgsGrid) {
      if (imgs.length) {
        imgsSection.style.display = 'flex';
        imgsGrid.innerHTML = imgs.map((imgSrc, i) => `
          <div class="doc-preview-image-thumb js-open-lightbox" data-lightbox-src="${escapeHtml(imgSrc)}" data-lightbox-title="Схема #${i + 1} из ${escapeHtml(docData.filename || 'документа')}" title="Увеличить схему">
            <img src="${escapeHtml(imgSrc)}" alt="Схема #${i + 1}" />
          </div>
        `).join('');
      } else {
        imgsSection.style.display = 'none';
        imgsGrid.innerHTML = '';
      }
    }

    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
  }

  function closeDocumentPreviewModal() {
    const modal = el('documentPreviewModal');
    if (!modal) return;
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
  }

  function renderStagingBar() {
    const bars = [el('stagingBar'), el('arStagingBar')].filter(Boolean);
    if (!bars.length) return;
    const cards = [];

    // 1. Коды ошибок DTC
    state.stagedCodes.forEach((code, idx) => {
      cards.push(
        `<span class="staged-card staged-card-dtc">
          <span class="staged-card-icon-wrap staged-icon-generic">DTC</span>
          <div class="staged-card-body">
            <span class="staged-card-title">${escapeHtml(code)}</span>
            <span class="staged-card-meta">Код ошибки</span>
          </div>
          <button type="button" class="staged-card-remove" data-remove-code="${idx}" title="Удалить код" aria-label="Удалить">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </span>`
      );
    });

    // 2. Снимки с камеры
    state.stagedCameraShots.forEach((shot, idx) => {
      cards.push(
        `<span class="staged-card staged-card-photo">
          <div class="staged-card-thumb-wrap js-open-lightbox" style="width:44px; height:44px; min-width:44px; max-width:44px; min-height:44px; max-height:44px; border-radius:8px; overflow:hidden; position:relative; flex-shrink:0; background:#000; cursor:pointer;" data-lightbox-src="${escapeHtml(shot)}" data-lightbox-title="Снимок камеры #${idx + 1}" title="Увеличить снимок">
            <img src="${escapeHtml(shot)}" alt="Снимок #${idx + 1}" style="width:100%; height:100%; max-width:100%; max-height:100%; object-fit:cover; display:block;" />
            <span class="staged-thumb-zoom-icon" aria-hidden="true">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            </span>
          </div>
          <div class="staged-card-body">
            <span class="staged-card-title">Снимок камеры #${idx + 1}</span>
            <span class="staged-card-meta">Камера • JPEG</span>
          </div>
          <button type="button" class="staged-card-remove" data-remove-shot="${idx}" title="Удалить снимок" aria-label="Удалить">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </span>`
      );
    });

    // 3. Загруженные файлы (фото, аудио, документы)
    state.stagedFiles.forEach((f, idx) => {
      const isImg = (f.type && f.type.startsWith('image/')) || /\.(jpe?g|png|webp|bmp|gif)$/i.test(f.name);
      const isAud = (f.type && f.type.startsWith('audio/')) || /\.(wav|mp3|ogg|m4a|flac|webm|aac)$/i.test(f.name);

      if (isImg) {
        if (!f._previewUrl) {
          try { f._previewUrl = URL.createObjectURL(f); } catch (_) {}
        }
        cards.push(
          `<span class="staged-card staged-card-photo">
            <div class="staged-card-thumb-wrap js-open-lightbox" style="width:44px; height:44px; min-width:44px; max-width:44px; min-height:44px; max-height:44px; border-radius:8px; overflow:hidden; position:relative; flex-shrink:0; background:#000; cursor:pointer;" data-lightbox-src="${escapeHtml(f._previewUrl || '')}" data-lightbox-title="${escapeHtml(f.name)}" title="Увеличить фото">
              <img src="${escapeHtml(f._previewUrl || '')}" alt="${escapeHtml(f.name)}" style="width:100%; height:100%; max-width:100%; max-height:100%; object-fit:cover; display:block;" />
              <span class="staged-thumb-zoom-icon" aria-hidden="true">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              </span>
            </div>
            <div class="staged-card-body">
              <span class="staged-card-title" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
              <span class="staged-card-meta">${formatFileSize(f.size) || 'Фото'}</span>
            </div>
            <button type="button" class="staged-card-remove" data-remove-file="${idx}" title="Удалить файл" aria-label="Удалить">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </span>`
        );
      } else if (isAud) {
        if (!f._previewUrl) {
          try { f._previewUrl = URL.createObjectURL(f); } catch (_) {}
        }
        const dur = (f._duration && isFinite(f._duration) && f._duration > 0) ? f._duration : 0;
        const durTxt = dur > 0 ? `0:00 / ${formatAudioTime(dur)}` : '0:00 / --:--';
        cards.push(
          `<span class="staged-card staged-card-audio" data-audio-src="${escapeHtml(f._previewUrl || '')}" data-audio-dur="${dur}">
            <div class="staged-card-icon-wrap staged-icon-audio">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
              </svg>
            </div>
            <div class="staged-audio-content">
              <div class="staged-audio-top-row">
                <span class="staged-card-title" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
                <span class="audio-time-label js-audio-time">${durTxt}</span>
              </div>
              <div class="staged-audio-scrubber-row">
                <button type="button" class="btn-audio-scrub-play js-audio-play-toggle" title="Воспроизвести / Пауза" aria-label="Воспроизвести">
                  <svg class="play-icon" width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21"/></svg>
                  <svg class="pause-icon" width="13" height="13" viewBox="0 0 24 24" fill="currentColor" style="display:none;"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                </button>
                <input type="range" class="audio-seek-slider js-audio-seek" min="0" max="100" value="0" step="0.1" aria-label="Перемотка аудио" />
                <audio src="${escapeHtml(f._previewUrl || '')}" preload="auto" class="js-audio-element" style="position:absolute; width:0; height:0; opacity:0; pointer-events:none;"></audio>
              </div>
            </div>
            <button type="button" class="staged-card-remove" data-remove-file="${idx}" title="Удалить аудио" aria-label="Удалить">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </span>`
        );
      } else {
        const { ext, badgeClass } = getFileExtAndClass(f.name);
        fetchDocPreview(f);
        cards.push(
          `<span class="staged-card staged-card-doc">
            <div class="staged-card-icon-wrap ${badgeClass}">${escapeHtml(ext.slice(0, 4))}</div>
            <div class="staged-card-body">
              <div style="display:flex; align-items:center; gap:6px; min-width:0;">
                <span class="staged-card-title" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
                ${f._parsedDoc ? (f._parsedDoc.is_fully_processed !== false ? '<span class="staged-doc-pill pill-full" title="Полный текст войдет в контекст модели">100%</span>' : '<span class="staged-doc-pill pill-sample" title="Умная выборка ошибок и ключевой телеметрии">Выборка</span>') : ''}
              </div>
              <div class="staged-card-meta-row">
                <span class="staged-card-meta">${formatFileSize(f.size)}</span>
                ${f._parsedDoc ? `
                  <button type="button" class="btn-staged-doc-inspect js-open-doc-preview" data-file-idx="${idx}" title="Просмотреть точные данные, которые получит модель">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
                    <span>Просмотреть</span>
                  </button>
                ` : (f._parsing ? '<span class="staged-doc-analyzing">Анализ...</span>' : `
                  <button type="button" class="btn-staged-doc-inspect js-open-doc-preview" data-file-idx="${idx}" title="Просмотреть документ">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
                    <span>Просмотреть</span>
                  </button>
                `)}
              </div>
            </div>
            <button type="button" class="staged-card-remove" data-remove-file="${idx}" title="Удалить документ" aria-label="Удалить">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </span>`
        );
      }
    });

    // 4. Записанный диктофоном голос
    if (state.stagedVoiceBlob) {
      if (!state.stagedVoicePreviewUrl) {
        try { state.stagedVoicePreviewUrl = URL.createObjectURL(state.stagedVoiceBlob); } catch (_) {}
      }
      const dur = (state.stagedVoiceDuration && isFinite(state.stagedVoiceDuration) && state.stagedVoiceDuration > 0)
        ? state.stagedVoiceDuration
        : (state.stagedVoiceBlob._duration && isFinite(state.stagedVoiceBlob._duration) ? state.stagedVoiceBlob._duration : 0);
      const durTxt = dur > 0 ? `0:00 / ${formatAudioTime(dur)}` : '0:00 / --:--';
      cards.push(
        `<span class="staged-card staged-card-audio" data-audio-src="${escapeHtml(state.stagedVoicePreviewUrl || '')}" data-audio-dur="${dur}">
          <div class="staged-card-icon-wrap staged-icon-audio">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
            </svg>
          </div>
          <div class="staged-audio-content">
            <div class="staged-audio-top-row">
              <span class="staged-card-title">Голосовая запись</span>
              <span class="audio-time-label js-audio-time">${durTxt}</span>
            </div>
            <div class="staged-audio-scrubber-row">
              <button type="button" class="btn-audio-scrub-play js-audio-play-toggle" title="Воспроизвести / Пауза" aria-label="Воспроизвести">
                <svg class="play-icon" width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21"/></svg>
                <svg class="pause-icon" width="13" height="13" viewBox="0 0 24 24" fill="currentColor" style="display:none;"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
              </button>
              <input type="range" class="audio-seek-slider js-audio-seek" min="0" max="100" value="0" step="0.1" aria-label="Перемотка аудио" />
              <audio src="${escapeHtml(state.stagedVoicePreviewUrl || '')}" preload="auto" class="js-audio-element" style="position:absolute; width:0; height:0; opacity:0; pointer-events:none;"></audio>
            </div>
          </div>
          <button type="button" class="staged-card-remove" data-remove-voice="1" title="Удалить запись" aria-label="Удалить">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </span>`
      );
    }

    const htmlContent = cards.join('');
    bars.forEach((bar) => {
      bar.innerHTML = htmlContent;
      bar.style.display = cards.length ? 'flex' : 'none';

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
          const removed = state.stagedFiles.splice(Number(btn.dataset.removeFile), 1);
          if (removed[0] && removed[0]._previewUrl) {
            try { URL.revokeObjectURL(removed[0]._previewUrl); } catch (_) {}
          }
          renderStagingBar();
        });
      });
      bar.querySelectorAll('[data-remove-voice]').forEach((btn) => {
        btn.addEventListener('click', () => {
          state.stagedVoiceBlob = null;
          state.stagedVoiceAudioBuffer = null;
          state.stagedVoiceTranscript = '';
          state.stagedVoiceDuration = 0;
          if (typeof stopWebAudio === 'function') stopWebAudio(true);
          if (state.stagedVoicePreviewUrl) {
            try { URL.revokeObjectURL(state.stagedVoicePreviewUrl); } catch (_) {}
            state.stagedVoicePreviewUrl = null;
          }
          renderStagingBar();
        });
      });

      // Инспекция документа (кнопка "Просмотреть")
      bar.querySelectorAll('.js-open-doc-preview').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const fileIdx = Number(btn.dataset.fileIdx);
          const f = state.stagedFiles[fileIdx];
          if (f) {
            if (f._parsedDoc) {
              openDocumentPreviewModal(f._parsedDoc);
            } else {
              openDocumentPreviewModal({
                filename: f.name,
                extension: (f.name.match(/\.[^.]+$/) || [''])[0],
                char_length: f.size,
                is_fully_processed: true,
                llm_ready_text: 'Идет анализ содержимого документа...',
              });
            }
          }
        });
      });

      // Инициализация метаданных длительности для аудиоплееров
      bar.querySelectorAll('audio.js-audio-element').forEach((aud) => {
        const updateDur = () => {
          const card = aud.closest('.staged-card-audio, .attachment-card-audio');
          if (!card) return;
          const timeLbl = card.querySelector('.js-audio-time');
          let d = (aud.duration && isFinite(aud.duration) && aud.duration > 0)
            ? aud.duration
            : Number(card.dataset.audioDur) || 0;
          if (d > 0) {
            card.dataset.audioDur = String(d);
            if (timeLbl && (!aud.currentTime || aud.currentTime === 0)) {
              timeLbl.textContent = `0:00 / ${formatAudioTime(d)}`;
            }
          }
        };
        aud.addEventListener('loadedmetadata', updateDur);
        aud.addEventListener('durationchange', updateDur);
        aud.addEventListener('canplay', updateDur);
        if (aud.duration && isFinite(aud.duration)) updateDur();
      });
    });
  }

  function renderAttachmentsHtml(attachments) {
    if (!Array.isArray(attachments) || !attachments.length) return '';
    let html = '<div class="attachments-grid">';

    attachments.forEach((att) => {
      if (att.type === 'image' && att.url) {
        html += `
          <div class="attachment-card-photo js-open-lightbox" data-lightbox-src="${escapeHtml(att.url)}" data-lightbox-title="${escapeHtml(att.name || 'Фотография поломки')}">
            <img src="${escapeHtml(att.url)}" alt="${escapeHtml(att.name || 'Фото узла')}" loading="lazy" />
            <div class="attachment-photo-overlay">
              <span class="attachment-photo-name">${escapeHtml(att.name || 'Фото узла')}</span>
              <div class="attachment-photo-zoom-icon" title="Увеличить">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                  <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>
                </svg>
              </div>
            </div>
          </div>
        `;
      } else if (att.type === 'audio') {
        const modeLabel = att.mode && !att.mode.toLowerCase().includes('ggml') ? att.mode : 'Gemma 4 Native Audio';
        const attDur = att.duration || att.duration_seconds || 0;
        const durTxt = attDur > 0 ? `0:00 / ${formatAudioTime(attDur)}` : '0:00';
        html += `
          <div class="attachment-card-audio" data-audio-src="${escapeHtml(att.url || '')}" data-audio-dur="${attDur}">
            <div class="attachment-card-audio-header">
              <div style="display:flex; align-items:center; gap:6px;">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                  <line x1="12" y1="19" x2="12" y2="22"/>
                </svg>
                <span style="font-weight:600; font-size:0.78rem;">${escapeHtml(att.name || 'Голосовая запись')}</span>
              </div>
              <span class="attachment-audio-badge">${escapeHtml(modeLabel)}</span>
            </div>
            <div class="attachment-card-audio-ctrls">
              ${att.url ? `
                <button type="button" class="btn-audio-play-toggle js-audio-play-toggle" aria-label="Воспроизвести запись" title="Слушать">
                  <svg class="play-icon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21"/></svg>
                  <svg class="pause-icon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="display:none;"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                </button>
                <input type="range" class="audio-seek-slider js-audio-seek" min="0" max="100" value="0" step="0.1" aria-label="Перемотка аудио" style="max-width:140px; margin:0 4px;" />
                <audio src="${escapeHtml(att.url)}" preload="auto" class="js-audio-element" style="position:absolute; width:0; height:0; opacity:0; pointer-events:none;"></audio>
              ` : ''}
              <div class="audio-waveform-bars" aria-hidden="true">
                <span class="audio-wave-bar" style="height:8px;"></span>
                <span class="audio-wave-bar" style="height:14px;"></span>
                <span class="audio-wave-bar" style="height:20px;"></span>
                <span class="audio-wave-bar" style="height:10px;"></span>
                <span class="audio-wave-bar" style="height:16px;"></span>
                <span class="audio-wave-bar" style="height:22px;"></span>
                <span class="audio-wave-bar" style="height:12px;"></span>
                <span class="audio-wave-bar" style="height:18px;"></span>
                <span class="audio-wave-bar" style="height:9px;"></span>
              </div>
              <span class="audio-duration-txt js-audio-duration-display js-audio-time">${durTxt}</span>
            </div>
            ${att.transcript ? `<div class="audio-transcript-note">«${escapeHtml(att.transcript)}»</div>` : ''}
          </div>
        `;
      } else {
        // Document
        const { ext, badgeClass } = getFileExtAndClass(att.name);
        const isFull = att.is_fully_processed !== false;
        const statusBadgeHtml = isFull
          ? `<span class="doc-status-pill doc-status-full" title="Документ полностью передан в контекст модели">
               <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
               <span>Полный разбор</span>
             </span>`
          : `<span class="doc-status-pill doc-status-sampled" title="Выполнена интеллектуальная выборка ошибок и ключевой телеметрии">
               <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
               <span>Умная выборка</span>
             </span>`;

        const dtcList = Array.isArray(att.detected_codes) && att.detected_codes.length
          ? `<div style="display:flex; gap:4px; flex-wrap:wrap; margin-top:2px;">
               ${att.detected_codes.map((c) => `<span class="dtc-pill" style="font-size:0.68rem; padding:1px 6px;">${escapeHtml(c)}</span>`).join('')}
             </div>`
          : '';

        const extractedImgs = Array.isArray(att.extracted_images) && att.extracted_images.length
          ? `<div class="doc-extracted-gallery">
               <div class="doc-extracted-gallery-label">
                 <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                   <rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>
                   <circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>
                 </svg>
                 <span>Извлечено схем и фото: ${att.extracted_images.length}</span>
               </div>
               <div class="doc-extracted-gallery-grid">
                 ${att.extracted_images.map((imgUrl, i) => `
                   <div class="doc-extracted-thumb js-open-lightbox" data-lightbox-src="${escapeHtml(imgUrl)}" data-lightbox-title="Схема #${i + 1} из ${escapeHtml(att.name || 'документа')}" title="Увеличить">
                     <img src="${escapeHtml(imgUrl)}" alt="Схема #${i + 1}" loading="lazy" />
                   </div>
                 `).join('')}
               </div>
             </div>`
          : '';

        const excerptBlock = att.preview_excerpt
          ? `<div class="doc-preview-collapse">
               <button type="button" class="doc-preview-toggle-btn js-toggle-doc-preview">
                 <span>Предпросмотр фрагмента</span>
                 <svg class="chevron-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                   <polyline points="6 9 12 15 18 9"/>
                 </svg>
               </button>
               <div class="doc-preview-content">${escapeHtml(att.preview_excerpt)}</div>
             </div>`
          : '';

        const docInspectJson = JSON.stringify({
          filename: att.name,
          extension: ext,
          char_length: (att.llm_ready_text || att.extracted_text || att.preview_excerpt || '').length,
          is_fully_processed: att.is_fully_processed,
          detected_dtc_codes: att.detected_codes || [],
          llm_ready_text: att.llm_ready_text || att.extracted_text || att.preview_excerpt || '',
          embedded_images: att.extracted_images || [],
        });

        html += `
          <div class="attachment-card-doc">
            <div class="attachment-card-doc-header">
              <span class="doc-badge-pill ${badgeClass}">${escapeHtml(ext)}</span>
              ${statusBadgeHtml}
            </div>
            <div class="attachment-doc-title-row">
              <span class="attachment-doc-name" title="${escapeHtml(att.name || 'Файл')}">${escapeHtml(att.name || 'Документ')}</span>
              <span class="attachment-doc-size">${formatFileSize(att.size_bytes)}</span>
            </div>
            ${dtcList}
            ${extractedImgs}
            ${excerptBlock}
            <div class="attachment-doc-footer">
              <button type="button" class="btn-staged-doc-inspect js-chat-inspect-doc" data-doc-json="${escapeHtml(docInspectJson)}" title="Просмотреть, что передано в контекст модели">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
                <span>Просмотреть</span>
              </button>
              ${att.url ? `
                <a href="${escapeHtml(att.url)}" download="${escapeHtml(att.name || 'document')}" class="btn-doc-download" target="_blank" rel="noopener">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="7 10 12 15 17 10"/>
                    <line x1="12" y1="15" x2="12" y2="3"/>
                  </svg>
                  <span>Скачать файл</span>
                </a>
              ` : '<span></span>'}
            </div>
          </div>
        `;
      }
    });

    html += '</div>';
    return html;
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

    // Трассировка вызовов Function Calling (в консоль разработчика, скрыто из UI)
    if (toolCalls.length > 0) {
      console.debug('[Gemma 4 Function Calling executed]', toolCalls);
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

    const attachmentsHtml = renderAttachmentsHtml(msg.attachments);

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

  function bindWelcomeChips(feed) {
    if (!feed) return;
    feed.querySelectorAll('.chip-scenario').forEach((btn) => {
      btn.onclick = () => {
        const q = btn.dataset.quickQuery;
        const code = btn.dataset.quickCode;
        if (code && !state.stagedCodes.includes(code)) {
          state.stagedCodes.push(code);
          renderStagingBar();
        }
        sendDiagnosticQuery(q);
      };
    });
  }

  function renderEmptyState(feed) {
    if (!feed) return;
    feed.innerHTML = `
      <div class="msg-card msg-assistant" data-welcome-placeholder="1">
        <div class="msg-header">
          <span class="msg-role-badge">ИИДЕАЛ АВТО • ГОТОВ К ДИАГНОСТИКЕ</span>
        </div>
        <div class="diagnosis-verdict-title">
          <span>Интеллектуальный стенд автодиагностики и пошагового ремонта</span>
        </div>
        <p style="font-size:0.88rem; color:var(--text-secondary); margin-bottom: 8px;">
          Здравствуйте! Я экспертная система автодиагностики «ИИдеал Авто» на базе мультимодальной нейросети Gemma 4. Готов помочь локализовать поломку, расшифровать ошибки ЭБУ и составить пошаговый план ремонта.
        </p>
        <p style="font-size:0.82rem; color:var(--text-muted); margin-bottom: 12px;">
          Опишите симптом своими словами, выберите код ошибки OBD-II из словаря, прикрепите лог сканера или фото неисправного узла, либо запишите голосовой вопрос.
        </p>
        <div style="font-size:0.78rem; font-weight:600; color:var(--text-muted); margin-bottom:6px;">Быстрые примеры неисправностей:</div>
        <div class="quick-scenarios" style="display:flex; flex-wrap:wrap; gap:6px;">
          <button type="button" class="chip-scenario" data-quick-query="Двигатель троит на холостых, мигает Check Engine, ошибка P0300" data-quick-code="P0300">P0300 Троит ДВС</button>
          <button type="button" class="chip-scenario" data-quick-query="Жёсткие пинки АКПП при переключении с 1 на 2 передачу, код P0796" data-quick-code="P0796">P0796 Пинки АКПП</button>
          <button type="button" class="chip-scenario" data-quick-query="Педаль тормоза стала мягкой и проваливается, ошибка C0050" data-quick-code="C0050">C0050 Тормоза</button>
          <button type="button" class="chip-scenario" data-quick-query="Потеря связи по шине CAN с блоком управления, ошибка U1900" data-quick-code="U1900">U1900 CAN-шина</button>
          <button type="button" class="chip-scenario" data-quick-query="Пневмоподвеска не поднимает кузов, ошибка компрессора C1731" data-quick-code="C1731">C1731 Пневма</button>
        </div>
      </div>
    `;

    bindWelcomeChips(feed);
    updateSelectionToolbar();
  }

  function updateSelectionToolbar() {
    const toolbar = el('chatSelectionToolbar');
    const chkSelectAll = el('chkSelectAllMessages');
    const counterBadge = el('selectionCountBadge') || el('selectedMessagesCount');
    const btnDelete = el('btnDeleteSelectedMessages');
    if (!toolbar) return;

    const checkboxes = Array.from(document.querySelectorAll('.msg-select-cb'));
    const totalCount = checkboxes.length;
    const checkedBoxes = checkboxes.filter((cb) => cb.checked);
    const checkedCount = checkedBoxes.length;

    if (checkedCount > 0) {
      toolbar.style.display = 'flex';
    } else {
      toolbar.style.display = 'none';
    }

    if (counterBadge) {
      counterBadge.textContent = `${checkedCount} из ${totalCount} выбрано`;
    }
    if (chkSelectAll) {
      chkSelectAll.checked = totalCount > 0 && checkedCount === totalCount;
      chkSelectAll.indeterminate = checkedCount > 0 && checkedCount < totalCount;
    }
    if (btnDelete) {
      btnDelete.disabled = checkedCount === 0;
      const btnSpan = btnDelete.querySelector('span');
      if (btnSpan) {
        btnSpan.textContent = checkedCount > 0 ? `Удалить выбранные (${checkedCount})` : 'Удалить выбранные';
      }
    }
  }

  async function deleteSingleMessage(msgId, cardEl) {
    if (!msgId) return;
    const confirmed = await uiConfirm(
      'Удалить это сообщение из чата и рабочей памяти экспертной модели?',
      'Удаление сообщения',
      true,
      'Удалить'
    );
    if (!confirmed) return;

    if (state.isDemo) {
      const list = state.demoMessagesBySession[state.currentSessionId] || [];
      state.demoMessagesBySession[state.currentSessionId] = list.filter((m) => String(m.id) !== String(msgId));
      cardEl?.remove();
      updateSelectionToolbar();
      const feed = el('chatFeed');
      if (feed && !feed.querySelector('.msg-card:not([data-welcome-placeholder])')) {
        renderEmptyState(feed);
      }
      return;
    }

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
        await uiAlert('Не удалось удалить сообщение из базы данных.', 'Ошибка удаления', 'error');
      }
    } catch (err) {
      console.error('Ошибка удаления сообщения:', err);
    }
  }

  async function deleteSelectedMessages() {
    const checkedBoxes = Array.from(document.querySelectorAll('.msg-select-cb:checked'));
    if (!checkedBoxes.length) return;
    const ids = checkedBoxes.map((cb) => Number(cb.dataset.msgId)).filter(Boolean);
    const confirmed = await uiConfirm(
      `Удалить выбранные сообщения (${ids.length} шт.) из истории диалога и контекстной памяти модели?`,
      'Массовое удаление',
      true,
      'Удалить все'
    );
    if (!confirmed) return;

    if (state.isDemo) {
      const idSet = new Set(ids.map(String));
      const list = state.demoMessagesBySession[state.currentSessionId] || [];
      state.demoMessagesBySession[state.currentSessionId] = list.filter((m) => !idSet.has(String(m.id)));
      ids.forEach((id) => {
        document.querySelectorAll(`.msg-card[data-message-id="${id}"]`).forEach((node) => node.remove());
      });
      updateSelectionToolbar();
      const feed = el('chatFeed');
      if (feed && !feed.querySelector('.msg-card:not([data-welcome-placeholder])')) {
        renderEmptyState(feed);
      }
      return;
    }

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
        await uiAlert('Не удалось удалить выбранные сообщения из базы данных.', 'Ошибка удаления', 'error');
      }
    } catch (err) {
      console.error('Ошибка массового удаления сообщений:', err);
    }
  }

  async function clearAllMessages() {
    if (!state.currentSessionId) return;
    const confirmed = await uiConfirm(
      'Полностью очистить всю историю текущего диалога и сбросить контекстную выжимку модели?',
      'Очистка диалога',
      true,
      'Очистить всё'
    );
    if (!confirmed) return;

    if (state.isDemo) {
      state.demoMessagesBySession[state.currentSessionId] = [];
      const feed = el('chatFeed');
      if (feed) renderEmptyState(feed);
      updateWorkerUi(null, '', null, false);
      return;
    }

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
        await uiAlert('Не удалось очистить историю диалога.', 'Ошибка очистки', 'error');
      }
    } catch (err) {
      console.error('Ошибка очистки чата:', err);
    }
  }

  function scrollFeedToBottom(forceImmediate = false) {
    const feed = el('chatFeed');
    if (!feed) return;
    const doScroll = () => {
      feed.scrollTop = feed.scrollHeight;
      if (window.scrollX !== 0) {
        window.scrollTo(0, window.scrollY);
      }
    };
    if (forceImmediate) {
      doScroll();
    } else {
      requestAnimationFrame(doScroll);
      setTimeout(doScroll, 80);
      setTimeout(doScroll, 260);
    }
  }

  function renderSessionMessagesToDom(messages, sessionId) {
    const feed = el('chatFeed');
    if (feed) {
      feed.innerHTML = '';
      if (!messages || messages.length === 0) {
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
        scrollFeedToBottom(true);
        updateSelectionToolbar();
      }
    }

    const arFeed = el('arAssistantFeed');
    if (arFeed) {
      arFeed.innerHTML = '';
      if (!messages || !messages.length) {
        arFeed.innerHTML = `
          <div class="msg-card msg-assistant" data-welcome-placeholder="1">
            <div class="msg-header">
              <span class="msg-role-badge">AR/VR ПОМОЩНИК • ГОТОВ</span>
            </div>
            <p style="font-size:0.85rem; color:var(--text-secondary); margin:0;">
              Здравствуйте! Наведите визир на узел автомобиля, сделайте снимок или задайте голосовой вопрос.
            </p>
          </div>
        `;
      } else {
        messages.forEach((m) => {
          arFeed.appendChild(renderMessageElement(m));
        });
        arFeed.scrollTop = arFeed.scrollHeight;
      }
    }

    const arSel = el('arSessionSelect');
    if (arSel) {
      arSel.value = String(sessionId);
    }

    document.querySelectorAll('.session-item').forEach((item) => {
      item.classList.toggle('active', item.dataset.sessionId === String(sessionId));
    });
  }

  async function loadSession(sessionId) {
    if (!sessionId) return;
    state.currentSessionId = sessionId;

    if (state.isDemo) {
      const demoSess = state.demoSessions.find((s) => String(s.id) === String(sessionId));
      const messages = state.demoMessagesBySession[sessionId] || [];
      updateWorkerUi('idle', demoSess ? demoSess.summary || '' : '', state.demoSettings.global_memory_summary || '', false);
      renderSessionMessagesToDom(messages, sessionId);
      return;
    }

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

      renderSessionMessagesToDom(data.messages || [], sessionId);
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
        <span class="msg-role-badge">ИИДЕАЛ АВТО • ГЕНЕРАЦИЯ ОТВЕТА</span>
        <span class="generating-timer-pill" data-gen-timer>0.0 с</span>
      </div>
      <div class="generating-main-row">
        <div class="neural-wave" aria-hidden="true">
          <span></span><span></span><span></span><span></span>
        </div>
        <div style="min-width:0; flex:1;">
          <div class="generating-stage-title" data-gen-title>Экспертная система анализирует ваш запрос...</div>
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
          stageEl.textContent = 'Этап 2/4: Анализ симптомов, истории диалога и мультимодальных вложений...';
        } else if (elapsedSec < 11.0) {
          stageEl.textContent = 'Этап 3/4: Синтез экспертного заключения и расчет индекса здоровья...';
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

    if (state.isDemo) {
      const demoHist = (state.demoMessagesBySession[state.currentSessionId] || []).slice(-10).map((m) => ({
        role: m.role,
        content: m.content,
        structured_data: m.structured_data,
        dtc_codes: m.dtc_codes || [],
      }));
      formData.append('demo_history', JSON.stringify(demoHist));
    }

    shotsSnapshot.forEach((shot) => {
      formData.append('camera_image_b64', shot);
    });
    filesSnapshot.forEach((file) => {
      formData.append('attachments', file);
    });
    if (voiceBlobSnapshot) {
      const ext = (voiceBlobSnapshot.type && voiceBlobSnapshot.type.includes('wav')) ? 'wav' : 'webm';
      formData.append('attachments', voiceBlobSnapshot, `voice_input.${ext}`);
    }
    if (voiceTranscriptSnapshot) {
      formData.append('voice_transcript', voiceTranscriptSnapshot);
    }

    // Сохраняем URL предпросмотра для оптимистичного сообщения ДО очистки состояния
    const savedVoicePreviewUrl = state.stagedVoicePreviewUrl;

    // Очищаем поле ввода и панель вложений сразу
    if (typeof overrideQuery !== 'string' && queryInput) {
      queryInput.value = '';
    }
    state.stagedCodes = [];
    state.stagedFiles = [];
    state.stagedCameraShots = [];
    state.stagedVoiceBlob = null;
    state.stagedVoiceAudioBuffer = null;
    state.stagedVoiceTranscript = '';
    state.stagedVoiceDuration = 0;
    state.stagedVoicePreviewUrl = null;
    if (typeof stopWebAudio === 'function') stopWebAudio(true);
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
      const isImg = (f.type && f.type.startsWith('image/')) || /\.(jpe?g|png|webp|bmp|gif)$/i.test(f.name);
      const isAud = (f.type && f.type.startsWith('audio/')) || /\.(wav|mp3|ogg|m4a|flac|webm|aac)$/i.test(f.name);
      if (isImg) {
        const objUrl = f._previewUrl || URL.createObjectURL(f);
        if (objUrl.startsWith('blob:')) tempObjectUrls.push(objUrl);
        optimisticAttachments.push({ type: 'image', url: objUrl, name: f.name, size_bytes: f.size });
      } else if (isAud) {
        const objUrl = f._previewUrl || URL.createObjectURL(f);
        if (objUrl.startsWith('blob:')) tempObjectUrls.push(objUrl);
        optimisticAttachments.push({
          type: 'audio',
          url: objUrl,
          name: f.name,
          size_bytes: f.size,
          duration: f._duration || 0,
          mode: 'Gemma 4 Native Audio',
        });
      } else {
        optimisticAttachments.push({ type: 'document', name: f.name, size_bytes: f.size, is_fully_processed: true });
      }
    });
    if (voiceBlobSnapshot) {
      const vUrl = savedVoicePreviewUrl || URL.createObjectURL(voiceBlobSnapshot);
      if (vUrl.startsWith('blob:')) tempObjectUrls.push(vUrl);
      optimisticAttachments.push({
        type: 'audio',
        url: vUrl,
        name: 'Голосовой запрос',
        size_bytes: voiceBlobSnapshot.size,
        duration: voiceBlobSnapshot._duration || state.stagedVoiceDuration || 0,
        mode: 'Gemma 4 Native Audio',
        transcript: voiceTranscriptSnapshot || 'Голосовой запрос мастера',
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
      scrollFeedToBottom();
    }

    if (arFeed && document.body.classList.contains('ar-glasses-mode')) {
      pendingArEl = createPendingGenerationCard();
      arFeed.innerHTML = '';
      arFeed.appendChild(pendingArEl);
      arFeed.scrollTop = arFeed.scrollHeight;
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
        await uiAlert(data.error || 'Ошибка выполнения диагностики', 'Ошибка диагностики', 'error');
        return;
      }

      if (state.isDemo) {
        if (!state.demoMessagesBySession[state.currentSessionId]) {
          state.demoMessagesBySession[state.currentSessionId] = [];
        }
        if (data.user_message) state.demoMessagesBySession[state.currentSessionId].push(data.user_message);
        if (data.assistant_message) state.demoMessagesBySession[state.currentSessionId].push(data.assistant_message);
        const demoSess = state.demoSessions.find((s) => String(s.id) === String(state.currentSessionId));
        if (demoSess && data.session_title && (demoSess.title === 'Демо-диагностика' || demoSess.title.startsWith('Диагностика #'))) {
          demoSess.title = data.session_title;
        }
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
        scrollFeedToBottom();
        updateSelectionToolbar();
      }

      if (arFeed && data.assistant_message) {
        const arEl = renderMessageElement(data.assistant_message);
        if (pendingArEl && pendingArEl.parentNode === arFeed) {
          arFeed.replaceChild(arEl, pendingArEl);
        } else {
          arFeed.appendChild(arEl);
        }
        arFeed.scrollTop = arFeed.scrollHeight;
      }

      if (typeof window._refreshSidebarProjects === 'function') {
        window._refreshSidebarProjects();
      }

      if (!state.isDemo) {
        // Запускаем опрос фонового воркера, который обновляет краткую выжимку
        setTimeout(pollWorkerStatus, 250);
      }
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

  function encodeWavBlob(samples, sampleRate = 16000) {
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);
    const dataSize = samples.length * 2;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    const writeStr = (offset, str) => {
      for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
      }
    };

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);

    let offset = 44;
    for (let i = 0; i < samples.length; i++, offset += 2) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }

    return new Blob([buffer], { type: 'audio/wav' });
  }

  async function toggleVoiceRecording() {
    if (state.isRecording) {
      await stopVoiceRecordingAndWait();
      return;
    }

    state.isRecording = true;
    state.recordingStartTime = Date.now();
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
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      startMicSpectrogram(stream);

      // Параллельный захват чистого PCM аудиопотока для мгновенного создания стандартного WAV
      let recAudioCtx = null;
      let recProcessor = null;
      let recSource = null;
      const pcmChunks = [];
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) {
          recAudioCtx = new AudioCtx();
          recSource = recAudioCtx.createMediaStreamSource(stream);
          recProcessor = recAudioCtx.createScriptProcessor(4096, 1, 1);
          recProcessor.onaudioprocess = (ev) => {
            if (!state.isRecording) return;
            const ch = ev.inputBuffer.getChannelData(0);
            pcmChunks.push(new Float32Array(ch));
          };
          recSource.connect(recProcessor);
          recProcessor.connect(recAudioCtx.destination);
        }
      } catch (err) {
        console.warn('PCM stream capture init notice:', err);
      }

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

          const sampleRate = (recAudioCtx && recAudioCtx.sampleRate) || 16000;
          if (recProcessor) {
            try { recProcessor.disconnect(); } catch (_) {}
            recProcessor = null;
          }
          if (recSource) {
            try { recSource.disconnect(); } catch (_) {}
            recSource = null;
          }
          if (recAudioCtx) {
            try { recAudioCtx.close(); } catch (_) {}
            recAudioCtx = null;
          }

          let blob = null;
          let calculatedDur = 0;

          if (pcmChunks.length > 0) {
            let totalLen = 0;
            for (let i = 0; i < pcmChunks.length; i++) totalLen += pcmChunks[i].length;
            const merged = new Float32Array(totalLen);
            let off = 0;
            for (let i = 0; i < pcmChunks.length; i++) {
              merged.set(pcmChunks[i], off);
              off += pcmChunks[i].length;
            }
            blob = encodeWavBlob(merged, sampleRate);
            calculatedDur = totalLen / sampleRate;
          } else if (chunks.length > 0) {
            const rawMime = mr.mimeType || mimeType || 'audio/webm';
            blob = new Blob(chunks, { type: rawMime.split(';')[0].trim() || 'audio/webm' });
          }

          if (blob) {
            const recElapsed = state.recordingStartTime
              ? Math.max(0.3, (Date.now() - state.recordingStartTime) / 1000)
              : 0;
            const finalDur = calculatedDur > 0 ? calculatedDur : recElapsed;
            blob._duration = finalDur;
            state.stagedVoiceBlob = blob;
            state.stagedVoiceDuration = finalDur;
            if (state.stagedVoicePreviewUrl) {
              try { URL.revokeObjectURL(state.stagedVoicePreviewUrl); } catch (_) {}
            }
            state.stagedVoicePreviewUrl = URL.createObjectURL(blob);
            renderStagingBar();

            // Отправляем аудио на сервер в /api/transcode-audio/ для получения гарантированного эталонного WAV
            const tcData = new FormData();
            tcData.append('file', blob, blob.type === 'audio/wav' ? 'voice.wav' : 'voice.webm');
            fetch('/api/transcode-audio/', { method: 'POST', body: tcData })
              .then((r) => r.json())
              .then((res) => {
                if (res && res.ok && res.wav_data_url) {
                  if (res.duration && res.duration > 0) {
                    state.stagedVoiceDuration = res.duration;
                    blob._duration = res.duration;
                  }
                  if (res.transcript && !state.stagedVoiceTranscript) {
                    state.stagedVoiceTranscript = res.transcript;
                    const qIn = el('queryInput');
                    if (qIn && !qIn.value.trim()) qIn.value = res.transcript;
                  }
                  state.stagedVoicePreviewUrl = res.wav_data_url;
                  document.querySelectorAll('.staged-card-audio').forEach((c) => {
                    c.dataset.audioSrc = res.wav_data_url;
                    if (res.duration) c.dataset.audioDur = String(res.duration);
                    const aud = c.querySelector('.js-audio-element');
                    if (aud) {
                      aud.src = res.wav_data_url;
                      try { aud.load(); } catch (_) {}
                    }
                    const tl = c.querySelector('.js-audio-time');
                    if (tl && (!aud || aud.paused)) {
                      tl.textContent = `0:00 / ${formatAudioTime(state.stagedVoiceDuration)}`;
                    }
                  });
                }
              })
              .catch((err) => {
                console.warn('Серверный транскодинг аудио завершился с предупреждением:', err);
              });
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
      await uiAlert('Микрофон недоступен или доступ к аудиоустройству запрещён браузером. Пожалуйста, проверьте разрешения.', 'Доступ к микрофону', 'warning');
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

    const cameraWin = el('arWindowCamera');
    if (state.arSubmode === 'passthrough') {
      if (overlay) overlay.classList.add('passthrough-mode');
      if (bgVideo) {
        bgVideo.style.display = 'block';
        if (!state.arBgCameraStream) {
          state.arBgCameraStream = await startCameraStream(bgVideo, state.cameraFacingMode);
        }
      }
      // Скрываем дублирующее плавающее окно камеры — видеопоток уже является полноэкранным фоном
      if (cameraWin) cameraWin.style.display = 'none';
    } else {
      if (overlay) overlay.classList.remove('passthrough-mode');
      if (bgVideo) {
        bgVideo.style.display = 'none';
        stopStream(state.arBgCameraStream);
        state.arBgCameraStream = null;
      }
      // В оптическом режиме RayNeo на черном фоне #000000 окно визира камеры отображается
      if (cameraWin) cameraWin.style.display = 'flex';
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
    const cameraWin = el('arWindowCamera');
    if (cameraWin) cameraWin.style.display = '';
    try {
      if (document.fullscreenElement && document.exitFullscreen) {
        document.exitFullscreen();
      }
    } catch (_) {}
  }

  async function switchArCamera(target) {
    if (target === 'window') {
      state.arWinCameraFacing = state.arWinCameraFacing === 'environment' ? 'user' : 'environment';
      stopStream(state.arCameraStream);
      const arVideo = el('arCameraVideoEl');
      state.arCameraStream = await startCameraStream(arVideo, state.arWinCameraFacing);
    } else if (target === 'bg') {
      state.arBgCameraFacing = state.arBgCameraFacing === 'environment' ? 'user' : 'environment';
      stopStream(state.arBgCameraStream);
      const bgVideo = el('arBgVideoEl');
      state.arBgCameraStream = await startCameraStream(bgVideo, state.arBgCameraFacing);
    }
  }

  // =========================================================================
  // Рендеринг и обновление древовидной структуры проектов и сессий
  // =========================================================================
  function renderSessionItemHtml(s) {
    const isCur = String(s.id) === String(state.currentSessionId);
    const isPinned = Boolean(s.is_pinned);
    return `
      <div class="session-item clickable ${isCur ? 'active' : ''} ${isPinned ? 'pinned' : ''}" data-session-id="${s.id}">
        <div class="session-row-main">
          <button type="button" class="btn-pin-session ${isPinned ? 'active' : ''}" data-pin-session="${s.id}" title="${isPinned ? 'Открепить диалог' : 'Закрепить диалог'}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="${isPinned ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2">
              <path d="M12 17v5"/><path d="M9 2h6l1 7H8l1-7z"/><path d="M5 9h14v2a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V9z"/>
            </svg>
          </button>
          <span class="session-item-title" title="${escapeHtml(s.title || 'Новый диалог')}">${escapeHtml(s.title || 'Новый диалог')}</span>
          <div class="session-item-actions">
            <button type="button" class="btn-rename-session" data-rename-session="${s.id}" data-current-title="${escapeHtml(s.title || '')}" title="Переименовать диалог">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
              </svg>
            </button>
            <button type="button" class="btn-delete-session" data-delete-session="${s.id}" title="Удалить диалог" aria-label="Удалить диалог">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
          </div>
        </div>
        <div class="session-row-sub">
          ${
            s.tag
              ? `<span class="session-tag-badge" data-set-tag-session="${s.id}" data-current-tag="${escapeHtml(s.tag)}">${escapeHtml(s.tag)}</span>`
              : `<button type="button" class="btn-set-tag" data-set-tag-session="${s.id}" title="Назначить тег">+ тег</button>`
          }
          <span class="session-sub-meta">${escapeHtml(s.updated_at || '')}</span>
        </div>
      </div>
    `;
  }

  async function refreshSidebarProjects(tagFilter) {
    if (tagFilter !== undefined) state.activeTag = tagFilter;
    const projectsTreeEl = el('sidebarProjectsList');
    const unassignedListEl = el('sessionsList');
    const arSelectEl = el('arSessionSelect');

    let projects = [];
    let sessions = [];

    if (state.isDemo) {
      projects = state.demoProjects || [];
      sessions = state.demoSessions || [];
    } else {
      try {
        const [projResp, sessResp] = await Promise.all([
          fetch('/api/projects/'),
          fetch('/api/sessions/' + (state.activeTag ? `?tag=${encodeURIComponent(state.activeTag)}` : '')),
        ]);
        if (projResp.ok) {
          const pData = await projResp.json();
          projects = pData.projects || [];
        }
        if (sessResp.ok) {
          const sData = await sessResp.json();
          sessions = sData.sessions || [];
        }
      } catch (err) {
        console.error('Ошибка загрузки проектов и сессий:', err);
      }
    }

    // Построение карты сессий по проектам
    const sessionsByProj = {};
    const unassignedSessions = [];

    sessions.forEach((s) => {
      if (state.activeTag && s.tag !== state.activeTag) return;
      if (s.project_id !== null && s.project_id !== undefined && !Number.isNaN(s.project_id)) {
        const key = String(s.project_id);
        if (!sessionsByProj[key]) sessionsByProj[key] = [];
        if (!sessionsByProj[key].some((x) => String(x.id) === String(s.id))) {
          sessionsByProj[key].push(s);
        }
      } else {
        unassignedSessions.push(s);
      }
    });

    projects.forEach((p) => {
      const key = String(p.id);
      if (!sessionsByProj[key]) sessionsByProj[key] = [];
      (p.sessions || []).forEach((s) => {
        if (state.activeTag && s.tag !== state.activeTag) return;
        if (!sessionsByProj[key].some((x) => String(x.id) === String(s.id))) {
          sessionsByProj[key].push(s);
        }
      });
    });

    // Рендеринг древовидного меню проектов в стиле AIBPMN
    if (projectsTreeEl) {
      if (projects.length === 0) {
        projectsTreeEl.innerHTML = '';
      } else {
        projectsTreeEl.innerHTML = projects
          .map((p) => {
            const pSessions = sessionsByProj[String(p.id)] || [];
            const chatsHtml =
              pSessions.length === 0
                ? `<div class="sidebar-empty-hint">Нет диалогов в проекте</div>`
                : pSessions.map((s) => renderSessionItemHtml(s)).join('');

            return `
              <div class="project-group" data-project-id="${p.id}">
                <div class="project-header" data-project-id="${p.id}">
                  <span class="project-title" title="${escapeHtml(p.name)}">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0; color:var(--accent-orange);">
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                    </svg>
                    <span class="project-title-text">${escapeHtml(p.name)}</span>
                    <span class="project-count-pill">${pSessions.length}</span>
                  </span>
                  <div class="project-actions">
                    <button type="button" class="action-btn action-add-chat" data-project-id="${p.id}" title="Новый диалог в проекте">+</button>
                    <button type="button" class="action-btn action-edit-project" data-project-id="${p.id}" data-project-name="${escapeHtml(p.name)}" title="Переименовать проект">✎</button>
                    <button type="button" class="action-btn action-delete-project" data-project-id="${p.id}" data-project-name="${escapeHtml(p.name)}" title="Удалить проект">✕</button>
                  </div>
                </div>
                <div class="project-chats">
                  ${chatsHtml}
                </div>
              </div>
            `;
          })
          .join('');
      }
    }

    // Рендеринг диалогов вне проектов
    if (unassignedListEl) {
      if (unassignedSessions.length === 0 && projects.length === 0) {
        unassignedListEl.innerHTML = `<div style="padding:16px 8px; color:var(--text-muted); font-size:0.75rem; text-align:center;">Диалоги не найдены</div>`;
      } else {
        unassignedListEl.innerHTML = unassignedSessions.map((s) => renderSessionItemHtml(s)).join('');
      }
    }

    // Обновление селектора сессий в AR HUD
    if (arSelectEl) {
      const allFiltered = sessions.filter((s) => !state.activeTag || s.tag === state.activeTag);
      arSelectEl.innerHTML = allFiltered
        .map(
          (s) =>
            `<option value="${s.id}" ${String(s.id) === String(state.currentSessionId) ? 'selected' : ''}>${escapeHtml(s.title || 'Диалог #' + s.id)}</option>`
        )
        .join('');
    }
  }
  window._refreshSidebarProjects = refreshSidebarProjects;

  async function createNewSession(projectId) {
    if (state.isDemo) {
      const newId = 'demo-sess-' + Date.now();
      const projIdVal = projectId ? (isNaN(Number(projectId)) ? projectId : Number(projectId)) : null;
      const newSess = {
        id: newId,
        project_id: projIdVal,
        title: 'Новый диалог ' + (state.demoSessions.length + 1),
        tag: '',
        is_pinned: false,
        updated_at: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
        messages: [],
      };
      state.demoSessions.unshift(newSess);
      state.demoMessagesBySession[newId] = [];
      state.currentSessionId = newId;
      await refreshSidebarProjects();
      await loadSession(newId);
      return newSess;
    }

    const body = {};
    if (projectId) {
      body.project_id = isNaN(Number(projectId)) ? projectId : Number(projectId);
    } else if (state.activeProjectId) {
      body.project_id = isNaN(Number(state.activeProjectId)) ? state.activeProjectId : Number(state.activeProjectId);
    }
    try {
      const resp = await fetch('/api/sessions/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data.id) {
          state.currentSessionId = String(data.id);
          await refreshSidebarProjects();
          await loadSession(data.id);
          return data;
        }
      }
    } catch (err) {
      console.error('Ошибка создания новой сессии:', err);
    }
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

    // Привязка кликов к сценариям на приветственной карточке
    bindWelcomeChips(el('chatFeed'));

    // Создание новой сессии
    el('btnNewSession')?.addEventListener('click', async () => {
      await createNewSession();
      toggleMobileSidebar(false);
    });

    // Делегирование событий дерева проектов и сессий
    const handleSessionListClicks = async (e) => {
      // 1. Добавление чата в проект
      const addChatBtn = e.target.closest('.action-add-chat');
      if (addChatBtn) {
        e.stopPropagation();
        const pid = addChatBtn.dataset.projectId;
        await createNewSession(pid);
        toggleMobileSidebar(false);
        return;
      }

      // 2. Редактирование / переименование проекта
      const editProjBtn = e.target.closest('.action-edit-project');
      if (editProjBtn) {
        e.stopPropagation();
        const pid = editProjBtn.dataset.projectId;
        const curName = editProjBtn.dataset.projectName || '';
        const newName = await uiPrompt('Введите новое название проекта:', curName, 'Переименование проекта', 'Сохранить');
        if (newName && newName.trim() && newName.trim() !== curName) {
          if (state.isDemo) {
            const p = (state.demoProjects || []).find((x) => String(x.id) === String(pid));
            if (p) p.name = newName.trim();
            refreshSidebarProjects();
          } else {
            const resp = await fetch(`/api/projects/${pid}/`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: newName.trim() }),
            });
            if (resp.ok) {
              refreshSidebarProjects();
            }
          }
        }
        return;
      }

      // 3. Удаление проекта
      const delProjBtn = e.target.closest('.action-delete-project');
      if (delProjBtn) {
        e.stopPropagation();
        const pid = delProjBtn.dataset.projectId;
        const curName = delProjBtn.dataset.projectName || '';
        const confirmed = await uiConfirm(`Удалить проект «${curName}» со всеми его диалогами?`, 'Удаление проекта', true, 'Удалить проект');
        if (!confirmed) return;
        if (state.isDemo) {
          state.demoProjects = (state.demoProjects || []).filter((x) => String(x.id) !== String(pid));
          state.demoSessions = (state.demoSessions || []).filter((x) => String(x.project_id) !== String(pid));
          if (!state.demoSessions.some((s) => String(s.id) === String(state.currentSessionId))) {
            if (state.demoSessions.length > 0) {
              state.currentSessionId = state.demoSessions[0].id;
              loadSession(state.currentSessionId);
            } else {
              await createNewSession();
            }
          }
          refreshSidebarProjects();
        } else {
          const resp = await fetch(`/api/projects/${pid}/`, { method: 'DELETE' });
          if (resp.ok) {
            window.location.reload();
          }
        }
        return;
      }

      // 4. Удаление диалога
      const delBtn = e.target.closest('[data-delete-session]');
      if (delBtn) {
        e.stopPropagation();
        const sid = delBtn.dataset.deleteSession;
        const confirmed = await uiConfirm(
          'Удалить этот диалог диагностики вместе со всей историей сообщений?',
          'Удаление диалога',
          true,
          'Удалить'
        );
        if (!confirmed) return;
        if (state.isDemo) {
          state.demoSessions = (state.demoSessions || []).filter((x) => String(x.id) !== String(sid));
          delete state.demoMessagesBySession[sid];
          if (String(sid) === String(state.currentSessionId)) {
            if (state.demoSessions.length > 0) {
              state.currentSessionId = state.demoSessions[0].id;
              loadSession(state.currentSessionId);
            } else {
              await createNewSession();
            }
          }
          refreshSidebarProjects();
        } else {
          const resp = await fetch(`/api/sessions/${sid}/`, { method: 'DELETE' });
          if (resp.ok) {
            if (String(sid) === String(state.currentSessionId)) {
              window.location.reload();
            } else {
              refreshSidebarProjects();
            }
          }
        }
        return;
      }

      // 5. Закрепление диалога (Pin/Unpin)
      const pinBtn = e.target.closest('[data-pin-session]');
      if (pinBtn) {
        e.stopPropagation();
        const sid = pinBtn.dataset.pinSession;
        if (state.isDemo) {
          const s = (state.demoSessions || []).find((x) => String(x.id) === String(sid));
          if (s) s.is_pinned = !s.is_pinned;
          refreshSidebarProjects();
        } else {
          const resp = await fetch(`/api/sessions/${sid}/pin/`, { method: 'POST' });
          if (resp.ok) {
            refreshSidebarProjects();
          }
        }
        return;
      }

      // 6. Переименование диалога
      const renBtn = e.target.closest('[data-rename-session]');
      if (renBtn) {
        e.stopPropagation();
        const sid = renBtn.dataset.renameSession;
        const curTitle = renBtn.dataset.currentTitle || '';
        const newTitle = await uiPrompt(
          'Введите новое название для этого диалога диагностики:',
          curTitle,
          'Переименование диалога',
          'Сохранить'
        );
        if (newTitle && newTitle.trim() && newTitle.trim() !== curTitle) {
          if (state.isDemo) {
            const s = (state.demoSessions || []).find((x) => String(x.id) === String(sid));
            if (s) s.title = newTitle.trim();
            refreshSidebarProjects();
          } else {
            const resp = await fetch(`/api/sessions/${sid}/rename/`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ title: newTitle.trim() }),
            });
            if (resp.ok) {
              refreshSidebarProjects();
            }
          }
        }
        return;
      }

      // 7. Открытие модального окна тега
      const tagTrigger = e.target.closest('[data-set-tag-session]');
      if (tagTrigger) {
        e.stopPropagation();
        const sid = tagTrigger.dataset.setTagSession;
        const curTag = tagTrigger.dataset.currentTag || '';
        const modal = el('tagModal');
        const idInp = el('tagModalSessionId');
        const tagInp = el('sessionTagInput');
        if (modal && idInp && tagInp) {
          idInp.value = sid;
          tagInp.value = curTag;
          modal.style.display = 'flex';
          tagInp.focus();
        }
        return;
      }

      // 8. Переход к диалогу
      const item = e.target.closest('.session-item');
      if (item && item.dataset.sessionId) {
        loadSession(item.dataset.sessionId);
        toggleMobileSidebar(false);
      }
    };

    el('sidebarProjectsList')?.addEventListener('click', handleSessionListClicks);
    el('sessionsList')?.addEventListener('click', handleSessionListClicks);

    // Создание проекта
    el('btnNewProject')?.addEventListener('click', () => {
      const modal = el('newProjectModal');
      if (modal) {
        const nameInp = el('projectNameInput');
        const descInp = el('projectDescInput');
        if (nameInp) nameInp.value = '';
        if (descInp) descInp.value = '';
        modal.style.display = 'flex';
        nameInp?.focus();
      }
    });

    const closeProjectModal = () => {
      const modal = el('newProjectModal');
      if (modal) modal.style.display = 'none';
    };
    el('btnCloseProjectModal')?.addEventListener('click', closeProjectModal);
    el('btnCancelProject')?.addEventListener('click', closeProjectModal);

    el('btnSubmitProject')?.addEventListener('click', async () => {
      const name = el('projectNameInput')?.value.trim();
      const desc = el('projectDescInput')?.value.trim();
      if (!name) {
        await uiAlert('Пожалуйста, укажите название для проекта или автомобиля.', 'Название обязательно', 'warning');
        return;
      }
      if (state.isDemo) {
        const newProj = {
          id: 'demo-proj-' + Date.now(),
          name,
          description: desc,
          sessions: [],
        };
        state.demoProjects.push(newProj);
        closeProjectModal();
        await refreshSidebarProjects();
        return;
      }
      try {
        const resp = await fetch('/api/projects/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, description: desc }),
        });
        if (resp.ok) {
          closeProjectModal();
          await refreshSidebarProjects();
        } else {
          await uiAlert('Не удалось сохранить проект.', 'Ошибка создания проекта', 'error');
        }
      } catch (err) {
        console.error('Ошибка создания проекта:', err);
      }
    });

    // Фильтрация по тегам
    const tagsFilterBar = el('tagsFilterBar');
    tagsFilterBar?.addEventListener('click', (e) => {
      const chip = e.target.closest('.tag-chip');
      if (!chip) return;
      tagsFilterBar.querySelectorAll('.tag-chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      state.activeTag = chip.dataset.tag || '';
      refreshSidebarProjects(state.activeTag);
    });

    // Модальное окно тегирования
    const closeTagModal = () => {
      const modal = el('tagModal');
      if (modal) modal.style.display = 'none';
    };
    el('btnCloseTagModal')?.addEventListener('click', closeTagModal);
    el('btnCancelTag')?.addEventListener('click', closeTagModal);

    document.querySelectorAll('.js-quick-tag').forEach((btn) => {
      btn.addEventListener('click', () => {
        const inp = el('sessionTagInput');
        if (inp) inp.value = btn.dataset.tagVal || '';
      });
    });

    el('btnSaveSessionTag')?.addEventListener('click', async () => {
      const sid = el('tagModalSessionId')?.value;
      const tag = el('sessionTagInput')?.value.trim() || '';
      if (!sid) return;
      if (state.isDemo) {
        const s = (state.demoSessions || []).find((x) => String(x.id) === String(sid));
        if (s) s.tag = tag;
        closeTagModal();
        refreshSidebarProjects();
        return;
      }
      const resp = await fetch(`/api/sessions/${sid}/tag/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag }),
      });
      if (resp.ok) {
        closeTagModal();
        refreshSidebarProjects();
      }
    });

    el('btnClearSessionTag')?.addEventListener('click', async () => {
      const sid = el('tagModalSessionId')?.value;
      if (!sid) return;
      if (state.isDemo) {
        const s = (state.demoSessions || []).find((x) => String(x.id) === String(sid));
        if (s) s.tag = '';
        closeTagModal();
        refreshSidebarProjects();
        return;
      }
      const resp = await fetch(`/api/sessions/${sid}/tag/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag: '' }),
      });
      if (resp.ok) {
        closeTagModal();
        refreshSidebarProjects();
      }
    });

    // Прикрепление файлов
    const fileInput = el('hiddenFileInput');
    el('btnAttachFile')?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', () => {
      Array.from(fileInput.files || []).forEach((f) => {
        state.stagedFiles.push(f);
        const isAud = (f.type && f.type.startsWith('audio/')) || /\.(wav|mp3|ogg|m4a|flac|webm|aac)$/i.test(f.name);
        if (isAud) {
          try {
            f._previewUrl = URL.createObjectURL(f);
            const tcData = new FormData();
            tcData.append('file', f);
            fetch('/api/transcode-audio/', { method: 'POST', body: tcData })
              .then((r) => r.json())
              .then((res) => {
                if (res && res.ok && res.wav_data_url) {
                  f._previewUrl = res.wav_data_url;
                  f._duration = res.duration || 0;
                  renderStagingBar();
                }
              })
              .catch(() => {});
          } catch (_) {}
        } else {
          fetchDocPreview(f);
        }
      });
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

    // Режим AR-очков (RayNeo Optical / VR режим)
    el('btnEnterArMode')?.addEventListener('click', () => enterArMode('rayneo'));
    el('btnExitArMode')?.addEventListener('click', () => exitArMode());
    el('btnArModeRayneo')?.addEventListener('click', () => setArSubmode('rayneo'));
    el('btnArModePassthrough')?.addEventListener('click', () => setArSubmode('passthrough'));
    el('btnArSwitchWinCamera')?.addEventListener('click', () => switchArCamera('window'));
    el('btnArSwitchBgCamera')?.addEventListener('click', () => switchArCamera('bg'));
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
      const activeVideo = state.arSubmode === 'passthrough' ? el('arBgVideoEl') : el('arCameraVideoEl');
      const shot = captureVideoFrame(activeVideo || el('arCameraVideoEl'));
      state.stagedCameraShots.push(shot);
      renderStagingBar();
      sendDiagnosticQuery('Визуальная диагностика узла автомобиля с камеры AR-очков');
    });

    el('btnArSnapInAssistant')?.addEventListener('click', () => {
      const activeVideo = state.arSubmode === 'passthrough' ? el('arBgVideoEl') : el('arCameraVideoEl');
      const shot = captureVideoFrame(activeVideo || el('arCameraVideoEl'));
      state.stagedCameraShots.push(shot);
      renderStagingBar();
    });

    el('btnArSendQuick')?.addEventListener('click', () => {
      const inp = el('arQuickInput');
      const val = inp ? inp.value.trim() : '';
      if (!val && !state.stagedVoiceBlob && !state.stagedCameraShots.length && !state.stagedCodes.length && !state.stagedFiles.length) {
        return;
      }
      if (inp) inp.value = '';
      sendDiagnosticQuery(val || 'Диагностический запрос в AR');
    });

    el('btnArVoiceTrigger')?.addEventListener('click', () => toggleVoiceRecording());
    el('btnArVoiceTriggerAssistant')?.addEventListener('click', () => toggleVoiceRecording());

    el('arSessionSelect')?.addEventListener('change', (e) => {
      const targetId = e.target.value;
      if (targetId) {
        loadSession(targetId);
      }
    });

    el('btnArNewSession')?.addEventListener('click', async () => {
      await createNewSession();
    });

    // =========================================================================
    // Модальное окно настроек и профиля аккаунта
    // =========================================================================
    const openSettingsModal = async () => {
      const modal = el('settingsModal');
      if (!modal) return;
      if (state.isDemo) {
        const chk = el('chkCrossDialogMemory');
        if (chk) chk.checked = Boolean(state.demoSettings.cross_dialog_memory_enabled);
        const gta = el('globalSummaryTextarea');
        if (gta) gta.value = state.demoSettings.global_memory_summary || '';
        const wrap = el('globalMemorySectionWrap');
        if (wrap) wrap.style.display = chk && chk.checked ? 'block' : 'none';
      } else {
        try {
          const resp = await fetch('/api/settings/');
          if (resp.ok) {
            const data = await resp.json();
            const s = (data && data.settings) ? data.settings : data;
            const chk = el('chkCrossDialogMemory');
            if (chk) chk.checked = Boolean(s.cross_dialog_memory_enabled);
            const gta = el('globalSummaryTextarea');
            if (gta) gta.value = s.global_memory_summary || '';
            const wrap = el('globalMemorySectionWrap');
            if (wrap) wrap.style.display = chk && chk.checked ? 'block' : 'none';
          }
        } catch (err) {
          console.error('Ошибка загрузки настроек:', err);
        }
      }
      modal.style.display = 'flex';
    };

    const closeSettingsModal = () => {
      const modal = el('settingsModal');
      if (modal) modal.style.display = 'none';
    };

    el('btnAccountMenu')?.addEventListener('click', openSettingsModal);
    el('btnOpenSettingsModal')?.addEventListener('click', openSettingsModal);
    el('btnOpenMemorySettingsFromSidebar')?.addEventListener('click', openSettingsModal);
    el('btnCloseSettingsModal')?.addEventListener('click', closeSettingsModal);
    el('btnCloseSettingsModalBottom')?.addEventListener('click', closeSettingsModal);

    el('chkCrossDialogMemory')?.addEventListener('change', (e) => {
      const wrap = el('globalMemorySectionWrap');
      if (wrap) wrap.style.display = e.target.checked ? 'block' : 'none';
    });

    const saveSettings = async () => {
      const chkVal = Boolean(el('chkCrossDialogMemory')?.checked);
      const summaryVal = el('globalSummaryTextarea')?.value || '';
      if (state.isDemo) {
        state.demoSettings.cross_dialog_memory_enabled = chkVal;
        state.demoSettings.global_memory_summary = summaryVal;
        closeSettingsModal();
        return;
      }
      try {
        const resp = await fetch('/api/settings/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cross_dialog_memory_enabled: chkVal,
            global_memory_summary: summaryVal,
          }),
        });
        if (resp.ok) {
          closeSettingsModal();
        }
      } catch (err) {
        console.error('Ошибка сохранения настроек:', err);
      }
    };

    el('btnSaveSettings')?.addEventListener('click', saveSettings);

    el('btnClearGlobalMemory')?.addEventListener('click', async () => {
      const confirmed = await uiConfirm(
        'Очистить всю накопленную междиалоговую память? Сохранённый контекст неисправностей автомобиля будет сброшен.',
        'Сброс глобальной памяти',
        true,
        'Очистить память'
      );
      if (!confirmed) return;
      if (state.isDemo) {
        state.demoSettings.global_memory_summary = '';
        const gta = el('globalSummaryTextarea');
        if (gta) gta.value = '';
        return;
      }
      try {
        const resp = await fetch('/api/settings/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            global_memory_summary: '',
          }),
        });
        if (resp.ok) {
          const gta = el('globalSummaryTextarea');
          if (gta) gta.value = '';
        }
      } catch (err) {
        console.error('Ошибка очистки глобальной памяти:', err);
      }
    });

    // Сохранение ручных правок выжимки диалога
    el('dialogSummaryTextarea')?.addEventListener('blur', async (e) => {
      if (!state.currentSessionId || state.isDemo) return;
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

    // Мобильное левое меню (боковой drawer) и затемнение фона
    const toggleMobileSidebar = (force) => {
      const sidebar = el('panelSidebar');
      const backdrop = el('sidebarBackdrop');
      if (!sidebar) return;
      const willBeActive = force !== undefined ? force : !sidebar.classList.contains('mobile-active');
      sidebar.classList.toggle('mobile-active', willBeActive);
      if (backdrop) backdrop.classList.toggle('active', willBeActive);
    };

    el('btnMobileMenuToggle')?.addEventListener('click', () => toggleMobileSidebar());
    el('sidebarBackdrop')?.addEventListener('click', () => toggleMobileSidebar(false));

    // Мобильная нижняя навигация (Thumb-Zone)
    document.querySelectorAll('[data-mobile-view]').forEach((navBtn) => {
      navBtn.addEventListener('click', () => {
        const view = navBtn.dataset.mobileView;
        document.querySelectorAll('[data-mobile-view]').forEach((b) => b.classList.toggle('active', b === navBtn));
        const inspector = el('panelInspector');
        toggleMobileSidebar(false);
        inspector?.classList.remove('mobile-active');

        if (view === 'checklist') {
          inspector?.classList.add('mobile-active');
          document.querySelector('[data-inspector-tab="paneChecklist"]')?.click();
        } else if (view === 'dtc') {
          inspector?.classList.add('mobile-active');
          document.querySelector('[data-inspector-tab="paneDtc"]')?.click();
        }
      });
    });

    // Закрытие мобильных панелей
    document.querySelectorAll('.js-close-mobile-drawer').forEach((btn) => {
      btn.addEventListener('click', () => {
        toggleMobileSidebar(false);
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

    el('btnDeselectAllMessages')?.addEventListener('click', () => {
      document.querySelectorAll('.msg-select-cb').forEach((cb) => {
        cb.checked = false;
      });
      updateSelectionToolbar();
    });

    el('btnClearAllMessages')?.addEventListener('click', () => {
      clearAllMessages();
    });

    initAuthUi();
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

  // =========================================================================
  // 10. Управление учетными записями и авторизацией (Requirement #4)
  // =========================================================================
  function initAuthUi() {
    const authModal = el('authModal');
    const btnOpenAuth = el('btnOpenAuthModal');
    const btnCloseAuth = el('btnCloseAuthModal');
    const tabLogin = el('tabAuthLogin');
    const tabRegister = el('tabAuthRegister');
    const authForm = el('authForm');
    const emailGroup = el('authEmailGroup');
    const btnSubmit = el('btnSubmitAuth');
    const errBanner = el('authErrorBanner');
    const btnLogout = el('btnLogout');
    const btnDeleteAccount = el('btnDeleteAccount');

    let authMode = 'login';

    function setAuthMode(mode) {
      authMode = mode;
      if (errBanner) {
        errBanner.style.display = 'none';
        errBanner.textContent = '';
      }
      if (mode === 'login') {
        tabLogin?.classList.add('active');
        tabRegister?.classList.remove('active');
        if (emailGroup) emailGroup.style.display = 'none';
        if (btnSubmit) {
          const s = btnSubmit.querySelector('span');
          if (s) s.textContent = 'Войти';
        }
        const title = el('authModalTitle');
        if (title) title.textContent = 'Вход в ИИдеал Авто';
      } else {
        tabRegister?.classList.add('active');
        tabLogin?.classList.remove('active');
        if (emailGroup) emailGroup.style.display = 'flex';
        if (btnSubmit) {
          const s = btnSubmit.querySelector('span');
          if (s) s.textContent = 'Зарегистрироваться';
        }
        const title = el('authModalTitle');
        if (title) title.textContent = 'Регистрация в ИИдеал Авто';
      }
    }

    tabLogin?.addEventListener('click', () => setAuthMode('login'));
    tabRegister?.addEventListener('click', () => setAuthMode('register'));

    btnOpenAuth?.addEventListener('click', () => {
      setAuthMode('login');
      if (authModal) authModal.style.display = 'flex';
      el('authUsernameInput')?.focus();
    });

    btnCloseAuth?.addEventListener('click', () => {
      if (authModal) authModal.style.display = 'none';
    });

    authModal?.addEventListener('click', (e) => {
      if (e.target === authModal) {
        authModal.style.display = 'none';
      }
    });

    authForm?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = (el('authUsernameInput')?.value || '').trim();
      const password = (el('authPasswordInput')?.value || '').trim();
      const email = (el('authEmailInput')?.value || '').trim();

      if (!username || !password) return;

      if (btnSubmit) btnSubmit.disabled = true;
      if (errBanner) {
        errBanner.style.display = 'none';
        errBanner.textContent = '';
      }

      const endpoint = authMode === 'login' ? '/api/auth/login/' : '/api/auth/register/';
      const payload = { username, password };
      if (authMode === 'register' && email) payload.email = email;

      try {
        const resp = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await resp.json();
        if (!resp.ok) {
          if (errBanner) {
            errBanner.textContent = data.error || 'Ошибка авторизации';
            errBanner.style.display = 'block';
          }
          return;
        }

        window.location.reload();
      } catch (err) {
        if (errBanner) {
          errBanner.textContent = 'Ошибка сетевого соединения с сервером';
          errBanner.style.display = 'block';
        }
      } finally {
        if (btnSubmit) btnSubmit.disabled = false;
      }
    });

    btnLogout?.addEventListener('click', async () => {
      const confirmed = await uiConfirm('Вы действительно хотите выйти из своего аккаунта?', 'Выход из системы', false, 'Выйти');
      if (!confirmed) return;
      try {
        await fetch('/api/auth/logout/', { method: 'POST' });
        window.location.reload();
      } catch (_) {
        window.location.reload();
      }
    });

    btnDeleteAccount?.addEventListener('click', async () => {
      const confirmed = await uiConfirm(
        'Вы уверены, что хотите удалить свой аккаунт? Все ваши проекты, сессии и диагностические данные будут удалены безвозвратно.',
        'Удаление аккаунта',
        true,
        'Удалить аккаунт навсегда'
      );
      if (!confirmed) return;
      try {
        const resp = await fetch('/api/auth/delete-account/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        if (resp.ok) {
          window.location.reload();
        } else {
          const data = await resp.json();
          await uiAlert(data.error || 'Ошибка удаления аккаунта', 'Ошибка', 'error');
        }
      } catch (err) {
        console.error('Ошибка при удалении аккаунта:', err);
      }
    });

  function getEffectiveAudioDuration(card, audio) {
    if (audio && audio.duration && isFinite(audio.duration) && audio.duration > 0) {
      return audio.duration;
    }
    const cardDur = card ? Number(card.dataset.audioDur) : 0;
    if (cardDur && isFinite(cardDur) && cardDur > 0) {
      return cardDur;
    }
    if (state.stagedVoiceDuration && isFinite(state.stagedVoiceDuration) && state.stagedVoiceDuration > 0) {
      return state.stagedVoiceDuration;
    }
    return 0;
  }

  function handleAudioMetadataLoaded(aud) {
    if (!aud) return;
    const card = aud.closest('.attachment-card-audio, .staged-card');
    if (!card) return;
    const timeLbl = card.querySelector('.js-audio-time') || card.querySelector('.js-audio-duration-display');
    const dur = getEffectiveAudioDuration(card, aud);
    if (dur > 0) {
      card.dataset.audioDur = String(dur);
      if (timeLbl && (!aud.currentTime || aud.currentTime === 0)) {
        timeLbl.textContent = `0:00 / ${formatAudioTime(dur)}`;
      }
    }
  }

  // =========================================================================
  // Web Audio API движок воспроизведения (безотказный фоллбэк для любых браузеров)
  // =========================================================================
  const webAudioPlayer = {
    ctx: null,
    sourceNode: null,
    audioBuffer: null,
    startTime: 0,
    pausedAt: 0,
    isPlaying: false,
    card: null,
    rafId: null,
  };

  function getSharedAudioContext() {
    if (!webAudioPlayer.ctx || webAudioPlayer.ctx.state === 'closed') {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) webAudioPlayer.ctx = new AudioCtx();
    }
    return webAudioPlayer.ctx;
  }

  function stopWebAudio(resetToZero = false) {
    if (webAudioPlayer.rafId) {
      cancelAnimationFrame(webAudioPlayer.rafId);
      webAudioPlayer.rafId = null;
    }
    if (webAudioPlayer.sourceNode) {
      try { webAudioPlayer.sourceNode.stop(); } catch (_) {}
      try { webAudioPlayer.sourceNode.disconnect(); } catch (_) {}
      webAudioPlayer.sourceNode = null;
    }
    if (resetToZero) {
      webAudioPlayer.pausedAt = 0;
    } else if (webAudioPlayer.ctx && webAudioPlayer.isPlaying) {
      webAudioPlayer.pausedAt = Math.max(0, webAudioPlayer.ctx.currentTime - webAudioPlayer.startTime);
    }
    webAudioPlayer.isPlaying = false;
    if (webAudioPlayer.card) {
      webAudioPlayer.card.classList.remove('playing');
      delete webAudioPlayer.card.dataset.webAudioPlaying;
      const playIcon = webAudioPlayer.card.querySelector('.play-icon');
      const pauseIcon = webAudioPlayer.card.querySelector('.pause-icon');
      const slider = webAudioPlayer.card.querySelector('.js-audio-seek');
      const durationDisplay = webAudioPlayer.card.querySelector('.js-audio-time') || webAudioPlayer.card.querySelector('.js-audio-duration-display');
      if (playIcon) playIcon.style.display = 'block';
      if (pauseIcon) pauseIcon.style.display = 'none';
      if (resetToZero && slider) slider.value = 0;
      const dur = webAudioPlayer.audioBuffer ? webAudioPlayer.audioBuffer.duration : 0;
      if (resetToZero && durationDisplay && dur > 0) {
        durationDisplay.textContent = `0:00 / ${formatAudioTime(dur)}`;
      }
    }
  }

  function startWebAudioBuffer(ab, card, slider, durationDisplay, playIcon, pauseIcon) {
    const actx = getSharedAudioContext();
    if (!actx || !ab) return;
    if (actx.state === 'suspended') {
      actx.resume().catch(() => {});
    }

    stopWebAudio(false);

    const dur = ab.duration;
    let offset = webAudioPlayer.pausedAt || 0;
    if (offset >= dur - 0.05) offset = 0;

    const srcNode = actx.createBufferSource();
    srcNode.buffer = ab;
    srcNode.connect(actx.destination);
    webAudioPlayer.sourceNode = srcNode;
    webAudioPlayer.audioBuffer = ab;
    webAudioPlayer.startTime = actx.currentTime - offset;
    webAudioPlayer.isPlaying = true;
    webAudioPlayer.card = card;

    card.classList.add('playing');
    card.dataset.webAudioPlaying = '1';
    if (playIcon) playIcon.style.display = 'none';
    if (pauseIcon) pauseIcon.style.display = 'block';

    srcNode.start(0, offset);

    const tick = () => {
      if (!webAudioPlayer.isPlaying || webAudioPlayer.card !== card) return;
      const cur = Math.max(0, actx.currentTime - webAudioPlayer.startTime);
      if (cur >= dur) {
        stopWebAudio(true);
        return;
      }
      if (slider) slider.value = Math.min(100, Math.max(0, (cur / dur) * 100));
      if (durationDisplay) durationDisplay.textContent = `${formatAudioTime(cur)} / ${formatAudioTime(dur)}`;
      webAudioPlayer.rafId = requestAnimationFrame(tick);
    };
    webAudioPlayer.rafId = requestAnimationFrame(tick);

    srcNode.onended = () => {
      if (webAudioPlayer.sourceNode === srcNode && webAudioPlayer.isPlaying) {
        stopWebAudio(true);
      }
    };
  }

  function playViaWebAudio(card, audio, slider, durationDisplay, playIcon, pauseIcon) {
    // 1. Попытка взять готовый декодированный AudioBuffer
    let ab = state.stagedVoiceAudioBuffer || (state.stagedVoiceBlob && state.stagedVoiceBlob._audioBuffer);
    if (!ab && card) {
      const rmBtn = card.querySelector('[data-remove-file]');
      const fileIdx = rmBtn ? Number(rmBtn.dataset.removeFile) : -1;
      if (fileIdx >= 0 && state.stagedFiles[fileIdx]) {
        ab = state.stagedFiles[fileIdx]._audioBuffer;
      }
    }

    if (ab) {
      startWebAudioBuffer(ab, card, slider, durationDisplay, playIcon, pauseIcon);
      return;
    }

    // 2. Декодируем аудиофайл по URL/blob через fetch
    const audioUrl = (audio && audio.src) || (card && card.dataset.audioSrc);
    if (audioUrl) {
      fetch(audioUrl)
        .then((r) => r.arrayBuffer())
        .then((buf) => {
          const actx = getSharedAudioContext();
          if (!actx) return;
          return actx.decodeAudioData(buf);
        })
        .then((decodedAb) => {
          if (decodedAb) {
            if (state.stagedVoiceBlob) state.stagedVoiceBlob._audioBuffer = decodedAb;
            state.stagedVoiceAudioBuffer = decodedAb;
            startWebAudioBuffer(decodedAb, card, slider, durationDisplay, playIcon, pauseIcon);
          }
        })
        .catch((err) => {
          console.warn('Web Audio API локальное декодирование не удалось, запрашиваем серверный WAV:', err);
          const tfd = new FormData();
          tfd.append('audio_b64', audioUrl);
          fetch('/api/transcode-audio/', { method: 'POST', body: tfd })
            .then((r) => r.json())
            .then((data) => {
              if (data && data.ok && data.wav_data_url) {
                if (card) {
                  card.dataset.audioSrc = data.wav_data_url;
                  if (data.duration) card.dataset.audioDur = String(data.duration);
                }
                if (audio) {
                  audio.src = data.wav_data_url;
                  try { audio.load(); } catch (_) {}
                  audio.play().then(() => {
                    card.classList.add('playing');
                    if (playIcon) playIcon.style.display = 'none';
                    if (pauseIcon) pauseIcon.style.display = 'block';
                  }).catch(() => {
                    fetch(data.wav_data_url)
                      .then((r2) => r2.arrayBuffer())
                      .then((buf2) => getSharedAudioContext()?.decodeAudioData(buf2))
                      .then((wavAb) => {
                        if (wavAb) startWebAudioBuffer(wavAb, card, slider, durationDisplay, playIcon, pauseIcon);
                      }).catch((e2) => console.error('Ошибка воспроизведения транскодированного WAV:', e2));
                  });
                }
              }
            })
            .catch((tcErr) => {
              console.error('Ошибка вызова api_transcode_audio:', tcErr);
            });
        });
    }
  }

    // =========================================================================
    // Обработчики превью вложений (Лайтбокс, Аудиоплеер, Сворачивание документов)
    // =========================================================================
    el('btnCloseImageLightbox')?.addEventListener('click', closeImageLightbox);
    el('imageLightboxModal')?.addEventListener('click', (e) => {
      if (e.target === el('imageLightboxModal')) {
        closeImageLightbox();
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeImageLightbox();
      }
    });

    // Слушатели событий медиа через фазу перехвата (capture), чтобы ловить события на динамически создаваемых <audio>
    document.addEventListener('loadedmetadata', (e) => {
      if (e.target && e.target.matches && e.target.matches('audio.js-audio-element')) {
        handleAudioMetadataLoaded(e.target);
      }
    }, true);
    document.addEventListener('durationchange', (e) => {
      if (e.target && e.target.matches && e.target.matches('audio.js-audio-element')) {
        handleAudioMetadataLoaded(e.target);
      }
    }, true);
    document.addEventListener('canplay', (e) => {
      if (e.target && e.target.matches && e.target.matches('audio.js-audio-element')) {
        handleAudioMetadataLoaded(e.target);
      }
    }, true);

    document.addEventListener('click', (e) => {
      // 1. Клик по превью фото для открытия лайтбокса
      const lightboxTrigger = e.target.closest('.js-open-lightbox');
      if (lightboxTrigger) {
        e.preventDefault();
        const src = lightboxTrigger.dataset.lightboxSrc;
        const title = lightboxTrigger.dataset.lightboxTitle;
        if (src) openImageLightbox(src, title);
        return;
      }

      // 2. Клик по кнопке Play/Pause аудиоплеера
      const playBtn = e.target.closest('.js-audio-play-toggle');
      if (playBtn) {
        e.preventDefault();
        const card = playBtn.closest('.attachment-card-audio, .staged-card');
        const audio = card ? card.querySelector('.js-audio-element') : null;
        if (!audio) return;

        const playIcon = playBtn.querySelector('.play-icon');
        const pauseIcon = playBtn.querySelector('.pause-icon');
        const slider = card.querySelector('.js-audio-seek');
        const durationDisplay = card.querySelector('.js-audio-time') || card.querySelector('.js-audio-duration-display');

        // Если сейчас играет Web Audio API на этой карточке — ставим на паузу
        if (webAudioPlayer.isPlaying && webAudioPlayer.card === card) {
          stopWebAudio(false);
          return;
        }

        // Если карточка была на паузе в Web Audio режиме — продолжаем воспроизведение
        if (card.dataset.webAudioPlaying !== undefined) {
          playViaWebAudio(card, audio, slider, durationDisplay, playIcon, pauseIcon);
          return;
        }

        if (audio.paused) {
          // Останавливаем Web Audio на любой другой карточке
          stopWebAudio(true);

          // Останавливаем любое другое HTML5 аудио
          document.querySelectorAll('audio.js-audio-element').forEach((other) => {
            if (other !== audio && !other.paused) {
              other.pause();
              other.currentTime = 0;
              const otherCard = other.closest('.attachment-card-audio, .staged-card');
              if (otherCard) {
                otherCard.classList.remove('playing');
                const oBtn = otherCard.querySelector('.js-audio-play-toggle');
                if (oBtn) {
                  const pI = oBtn.querySelector('.play-icon');
                  const paI = oBtn.querySelector('.pause-icon');
                  if (pI) pI.style.display = 'block';
                  if (paI) paI.style.display = 'none';
                }
                const oSlider = otherCard.querySelector('.js-audio-seek');
                if (oSlider) oSlider.value = 0;
              }
            }
          });

          const dur = getEffectiveAudioDuration(card, audio);
          if (dur > 0 && (audio.currentTime >= dur - 0.08 || audio.currentTime >= dur)) {
            audio.currentTime = 0;
          }

          const desiredSrc = card.dataset.audioSrc || audio.src;
          if (desiredSrc && (audio.src !== desiredSrc || !audio.src || audio.error)) {
            audio.src = desiredSrc;
            try { audio.load(); } catch (_) {}
          }

          audio.ontimeupdate = () => {
            const cur = audio.currentTime || 0;
            const currentDur = getEffectiveAudioDuration(card, audio);
            if (slider && currentDur > 0) {
              slider.value = Math.min(100, Math.max(0, (cur / currentDur) * 100));
            }
            if (durationDisplay) {
              if (currentDur > 0) {
                durationDisplay.textContent = `${formatAudioTime(cur)} / ${formatAudioTime(currentDur)}`;
              } else {
                durationDisplay.textContent = formatAudioTime(cur);
              }
            }
            // Автоматическая остановка для WebM с Infinity duration в Chromium
            if (currentDur > 0 && cur >= currentDur - 0.08) {
              audio.pause();
              audio.currentTime = 0;
              card.classList.remove('playing');
              if (playIcon) playIcon.style.display = 'block';
              if (pauseIcon) pauseIcon.style.display = 'none';
              if (slider) slider.value = 0;
              if (durationDisplay) {
                durationDisplay.textContent = `0:00 / ${formatAudioTime(currentDur)}`;
              }
            }
          };

          audio.onended = () => {
            card.classList.remove('playing');
            if (playIcon) playIcon.style.display = 'block';
            if (pauseIcon) pauseIcon.style.display = 'none';
            if (slider) slider.value = 0;
            const endDur = getEffectiveAudioDuration(card, audio);
            if (durationDisplay && endDur > 0) {
              durationDisplay.textContent = `0:00 / ${formatAudioTime(endDur)}`;
            }
          };

          // Попытка воспроизведения через нативный HTML5 audio
          let playPromise;
          try {
            playPromise = audio.play();
          } catch (syncErr) {
            playPromise = Promise.reject(syncErr);
          }

          if (playPromise && typeof playPromise.then === 'function') {
            playPromise.then(() => {
              card.classList.add('playing');
              if (playIcon) playIcon.style.display = 'none';
              if (pauseIcon) pauseIcon.style.display = 'block';
            }).catch((err) => {
              console.warn('HTML5 Audio play failed, starting Web Audio API fallback:', err);
              playViaWebAudio(card, audio, slider, durationDisplay, playIcon, pauseIcon);
            });
          } else {
            card.classList.add('playing');
            if (playIcon) playIcon.style.display = 'none';
            if (pauseIcon) pauseIcon.style.display = 'block';
          }
        } else {
          audio.pause();
          card.classList.remove('playing');
          if (playIcon) playIcon.style.display = 'block';
          if (pauseIcon) pauseIcon.style.display = 'none';
        }
        return;
      }

      // 3. Разворачивание/сворачивание предпросмотра фрагмента документа в чате
      const toggleDocBtn = e.target.closest('.js-toggle-doc-preview');
      if (toggleDocBtn) {
        e.preventDefault();
        const wrap = toggleDocBtn.closest('.doc-preview-collapse');
        if (wrap) {
          const content = wrap.querySelector('.doc-preview-content');
          if (content) {
            content.classList.toggle('open');
            const chevron = toggleDocBtn.querySelector('.chevron-icon');
            if (chevron) {
              chevron.style.transform = content.classList.contains('open') ? 'rotate(180deg)' : 'none';
            }
          }
        }
        return;
      }

      // 4. Клик по кнопке подробной инспекции документа в чате ("Просмотреть")
      const chatDocBtn = e.target.closest('.js-chat-inspect-doc');
      if (chatDocBtn) {
        e.preventDefault();
        const jsonStr = chatDocBtn.dataset.docJson;
        if (jsonStr) {
          try {
            const parsed = JSON.parse(jsonStr);
            openDocumentPreviewModal(parsed);
          } catch (_) {}
        }
        return;
      }
    });

    // Перемотка аудио по перетаскиванию ползунка (seek slider)
    document.addEventListener('input', (e) => {
      const slider = e.target.closest('.js-audio-seek');
      if (!slider) return;
      const card = slider.closest('.attachment-card-audio, .staged-card');
      const audio = card ? card.querySelector('.js-audio-element') : null;
      const durationDisplay = card ? (card.querySelector('.js-audio-time') || card.querySelector('.js-audio-duration-display')) : null;
      if (!audio) return;
      const dur = getEffectiveAudioDuration(card, audio);
      if (dur > 0) {
        const frac = Math.min(100, Math.max(0, Number(slider.value))) / 100;
        const target = Math.max(0, Math.min(dur, frac * dur));
        if (isFinite(target)) {
          if (webAudioPlayer.card === card || card.dataset.webAudioPlaying !== undefined) {
            webAudioPlayer.pausedAt = target;
            if (webAudioPlayer.isPlaying) {
              const playIcon = card.querySelector('.play-icon');
              const pauseIcon = card.querySelector('.pause-icon');
              playViaWebAudio(card, audio, slider, durationDisplay, playIcon, pauseIcon);
            }
          } else {
            try {
              audio.currentTime = target;
            } catch (err) {
              console.warn('Audio seek error:', err);
            }
          }
          if (durationDisplay) {
            durationDisplay.textContent = `${formatAudioTime(target)} / ${formatAudioTime(dur)}`;
          }
        }
      }
    });

    // Модальное окно предпросмотра данных документа для модели
    el('btnCloseDocPreviewModal')?.addEventListener('click', closeDocumentPreviewModal);
    el('documentPreviewModal')?.addEventListener('click', (e) => {
      if (e.target === el('documentPreviewModal')) closeDocumentPreviewModal();
    });

    el('btnCopyDocPreviewText')?.addEventListener('click', () => {
      const text = el('docPreviewCodeBox')?.textContent || '';
      if (!text) return;
      navigator.clipboard.writeText(text).then(() => {
        const lbl = el('btnCopyDocPreviewLabel');
        if (lbl) {
          lbl.textContent = 'Скопировано!';
          setTimeout(() => { lbl.textContent = 'Копировать'; }, 2000);
        }
      }).catch(() => {});
    });

    // Закрытие модалок клавишей Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeImageLightbox();
        closeDocumentPreviewModal();
      }
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    window.addEventListener(
      'scroll',
      () => {
        if (window.scrollX !== 0) {
          window.scrollTo(0, window.scrollY);
        }
      },
      { passive: true }
    );
    initEvents();
    refreshSidebarProjects();
    loadSession(state.currentSessionId);
    loadDtcDictionary();
  });
})();
