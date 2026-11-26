/**
 * Главный экран ИИ-диагностики ИИдеал-Авто (100% паритет с мобильной веб-версией).
 * Поддержка: живой ленты с чеклистами/неисправностями, выбора/удаления сообщений,
 * камеры (UICameraNode + fallback), голосового ввода (AudioRecorder + SpeechRecognizer),
 * прикрепления документов с LLM-предпросмотром, словаря DTC, OBD-2 снимка,
 * анимированной генерации ответа с отменой и фонового воркера памяти.
 *
 * Лицензия: GPL-3.0
 */

import { apiClient } from "../api/BackendApiClient";
import { externalDisplayBridge } from "../ar/ExternalDisplayBridge";
import { cacheManager } from "../cache/ResourceCacheManager";
import {
  appState,
  attachObdSnapshotToStaging,
  createWelcomeMessage,
  generateUuidV4,
  stageDtcCodes
} from "../state/appState";
import { ChatMessageItem, StagedItem } from "../types";
import {
  AppHeader,
  DtcChip,
  LucideIcon,
  MessageCard,
  openConfirmModal,
  openDocumentPreviewModal,
  PendingGenerationCard,
  PendingCardHandle,
  PrimaryButton,
  SecondaryButton,
  SelectionToolbar,
  StagingBar,
  THEME,
  VehicleBar
} from "./components";

export interface DiagnosticsScreenCallbacks {
  onOpenAr?: () => void;
  onOpenSettings?: () => void;
  onOpenObd?: () => void;
  onOpenDtc?: () => void;
  onOpenSessions?: () => void;
}

export function createDiagnosticsScreen(callbacks?: DiagnosticsScreenCallbacks): any {
  const querySignal = signal<string>("");
  const isRecordingSignal = signal<boolean>(false);
  const recordLevelSignal = signal<number>(0.2);
  const recordSecSignal = signal<number>(0);

  let activePendingCard: PendingCardHandle | null = null;
  let activeRecorder: any = null;
  let activeSpeech: any = null;
  let recordTimer: any = null;
  let capturedTranscript = "";
  let workerPollTimer: any = null;
  let currentAskAbortFlag = { cancelled: false };

  const header = AppHeader({
    title: "ИИДЕАЛ АВТО",
    onOpenAr: () => callbacks?.onOpenAr?.(),
    onOpenSettings: () => callbacks?.onOpenSettings?.(),
    onResetChat: () => startFreshChat()
  });

  const vehicleBar = VehicleBar(appState.vehicleSignal);

  const feedScroll = UIScrollable().style({
    flex: 1,
    width: "100%",
    backgroundColor: () => THEME.bgBase
  });

  const feedColumn = UIColumn().style({
    width: "100%",
    paddingHorizontal: 10,
    paddingVertical: 10,
    gap: 10
  });
  feedScroll.append(feedColumn);

  const scrollFeedToBottom = () => {
    setTimeout(() => {
      try {
        feedScroll.scrollToEnd(true);
      } catch (_) {}
    }, 90);
  };

  // Синхронизация чекбокса (Чат <-> Инспектор <-> AR HUD <-> Django DB)
  const handleToggleTask = async (
    msgId: string,
    itemType: "step" | "inventory",
    checkId: string | number,
    done: boolean
  ) => {
    const msgs = appState.messagesSignal.value;
    let updatedLatest: ChatMessageItem | null = appState.latestAssistantMessageSignal.value;

    const nextMsgs = msgs.map(m => {
      if (m.id !== msgId) return m;
      const cloned: ChatMessageItem = { ...m };
      if (itemType === "step" && cloned.tasks) {
        cloned.tasks = cloned.tasks.map((t, idx) => {
          const id = t.step_number ?? t.id ?? idx + 1;
          return String(id) === String(checkId) ? { ...t, done } : t;
        });
      }
      if (itemType === "inventory" && cloned.inventoryItems) {
        cloned.inventoryItems = cloned.inventoryItems.map((it, idx) => {
          const id = it.id || it.name || String(idx);
          return String(id) === String(checkId) ? { ...it, checked: done } : it;
        });
      }
      if (updatedLatest && updatedLatest.id === m.id) {
        updatedLatest = cloned;
      }
      return cloned;
    });

    appState.messagesSignal.value = nextMsgs;
    if (updatedLatest) {
      appState.latestAssistantMessageSignal.value = { ...updatedLatest };
    }

    if (!appState.currentUserSignal.value.is_authenticated) {
      appState.demoMessagesBySession[appState.currentSessionIdSignal.value] = nextMsgs;
      return;
    }

    if (msgId && msgId !== "msg-welcome" && !msgId.startsWith("local-")) {
      await apiClient.toggleTask(msgId, checkId, done, itemType).catch(() => {});
    }
  };

  appState.toggleTaskHandler = handleToggleTask;

  const animatedMsgIds = new Set<string>(
    (appState.messagesSignal.value || []).map(m => m.id)
  );

  const rebuildFeed = () => {
    const list = appState.messagesSignal.value || [];
    const selectedSet = new Set(appState.selectedMessageIdsSignal.value || []);
    const nodes: any[] = list.map(msg => {
      const shouldAnimate = !animatedMsgIds.has(msg.id);
      if (shouldAnimate) animatedMsgIds.add(msg.id);
      const card = MessageCard(msg, {
        isSelected: id => selectedSet.has(id),
        onToggleSelect: id => {
          const cur = appState.selectedMessageIdsSignal.value || [];
          if (cur.includes(id)) {
            appState.selectedMessageIdsSignal.value = cur.filter(x => x !== id);
          } else {
            appState.selectedMessageIdsSignal.value = [...cur, id];
          }
        },
        onToggleTask: handleToggleTask,
        onFollowupClick: prompt => {
          void handleAsk(prompt, false);
        },
        onDeleteMessage: id => {
          void handleDeleteSingleMessage(id);
        },
        onOpenAr: () => callbacks?.onOpenAr?.(),
        onStageDtc: code => {
          stageDtcCodes([code]);
          toast(`Код ${code} добавлен в запрос`);
        }
      });
      if (shouldAnimate && (msg.id.startsWith("local-") || appState.isAskingSignal.value || appState.messagesSignal.value.length <= 2)) {
        try {
          card.animateFrom?.({
            transform: "translateY(8px)",
            duration: 200,
            easing: "outCubic"
          });
        } catch (_) {}
      }
      return card;
    });

    if (appState.isAskingSignal.value && activePendingCard) {
      nodes.push(activePendingCard.node);
    }

    feedColumn.setContent(nodes);
  };

  // Реактивная перерисовка ленты при изменении сообщений (например после открытия истории сессий)
  effect(() => {
    const _msgs = appState.messagesSignal.value;
    const _sel = appState.selectedMessageIdsSignal.value;
    const _asking = appState.isAskingSignal.value;
    void _msgs;
    void _sel;
    void _asking;
    rebuildFeed();
  });

  const handleDeleteSingleMessage = async (msgId: string) => {
    if (msgId === "msg-welcome") return;
    const next = appState.messagesSignal.value.filter(m => m.id !== msgId);
    appState.messagesSignal.value = next.length > 0 ? next : [createWelcomeMessage()];
    appState.selectedMessageIdsSignal.value = appState.selectedMessageIdsSignal.value.filter(
      id => id !== msgId
    );

    if (appState.currentUserSignal.value.is_authenticated && !msgId.startsWith("local-")) {
      const res = await apiClient.deleteSingleMessage(msgId);
      if (res.session_summary !== undefined) {
        appState.sessionSummarySignal.value = res.session_summary;
      }
    } else {
      appState.demoMessagesBySession[appState.currentSessionIdSignal.value] =
        appState.messagesSignal.value;
    }
  };

  const selectionToolbar = SelectionToolbar(
    appState.selectedMessageIdsSignal,
    () => {
      appState.selectedMessageIdsSignal.value = [];
    },
    async () => {
      const ids = appState.selectedMessageIdsSignal.value || [];
      if (ids.length === 0) return;
      const numericIds = ids.filter(id => !id.startsWith("local-") && id !== "msg-welcome");
      const next = appState.messagesSignal.value.filter(m => !ids.includes(m.id));
      appState.messagesSignal.value = next.length > 0 ? next : [createWelcomeMessage()];
      appState.selectedMessageIdsSignal.value = [];

      if (appState.currentUserSignal.value.is_authenticated && numericIds.length > 0) {
        await apiClient.deleteMessages(
          appState.currentSessionIdSignal.value,
          numericIds,
          false
        );
      } else {
        appState.demoMessagesBySession[appState.currentSessionIdSignal.value] =
          appState.messagesSignal.value;
      }
      toast("Выбранные сообщения удалены");
    },
    () => {
      openConfirmModal({
        title: "Очистить весь диалог?",
        message: "Все сообщения текущей сессии диагностики будут удалены.",
        confirmLabel: "Очистить",
        onConfirm: async () => {
          appState.selectedMessageIdsSignal.value = [];
          const welcome = createWelcomeMessage();
          appState.messagesSignal.value = [welcome];
          appState.latestAssistantMessageSignal.value = welcome;
          if (appState.currentUserSignal.value.is_authenticated) {
            await apiClient.deleteMessages(
              appState.currentSessionIdSignal.value,
              [],
              true
            );
          } else {
            appState.demoMessagesBySession[appState.currentSessionIdSignal.value] = [welcome];
          }
          toast("Диалог очищен");
        }
      });
    }
  );

  const startFreshChat = async () => {
    const newId = generateUuidV4();
    const welcome = createWelcomeMessage();
    appState.selectedMessageIdsSignal.value = [];
    appState.stagedItemsSignal.value = [];
    appState.messagesSignal.value = [welcome];
    appState.latestAssistantMessageSignal.value = welcome;
    appState.sessionSummarySignal.value = "";
    appState.statusNoteSignal.value = "Новый диалог готов";

    if (appState.currentUserSignal.value.is_authenticated) {
      const created = await apiClient.createSession(
        null,
        "Новая диагностика",
        appState.vehicleSignal.value
      );
      if (created?.id) {
        appState.currentSessionIdSignal.value = created.id;
        appState.currentSessionTitleSignal.value = created.title;
        cacheManager.saveSetting("active_session_id", created.id);
        appState.sessionsRefreshCounterSignal.value++;
        toast("Создана новая облачная сессия");
        return;
      }
    }

    appState.currentSessionIdSignal.value = newId;
    appState.currentSessionTitleSignal.value = `Демо-диагностика #${
      appState.demoSessionsSignal.value.length + 1
    }`;
    appState.demoMessagesBySession[newId] = [welcome];
    appState.demoSessionsSignal.value = [
      {
        id: newId,
        title: appState.currentSessionTitleSignal.value,
        is_pinned: false,
        tag: "",
        project_id: null,
        vehicle_info: appState.vehicleSignal.value,
        summary: "",
        updated_at: "Сейчас",
        message_count: 0
      },
      ...appState.demoSessionsSignal.value
    ];
    cacheManager.saveSetting("active_session_id", newId);
    appState.sessionsRefreshCounterSignal.value++;
    toast("Начат новый диалог");
  };

  // =========================================================================
  // МОДАЛКА КАМЕРЫ (ЖИВОЕ ПРЕВЬЮ + СНИМОК УЗЛА) И ВЫБОР ФАЙЛОВ / DTC / ГОЛОС
  // =========================================================================

  const openCameraModal = async () => {
    if (!UICameraNode.supported) {
      try {
        const picked = await openFilePicker({ multiple: false, accept: "image/*" });
        const f = Array.isArray(picked) ? picked[0] : picked;
        if (f) {
          appState.stagedItemsSignal.value = [
            ...appState.stagedItemsSignal.value,
            {
              id: "cam-pick-" + Date.now(),
              type: "photo",
              label: f.name || "Фото узла",
              meta: f.size ? `${Math.round(f.size / 1024)} КБ` : "Изображение",
              file: f,
              data: f,
              mimeType: f.type || "image/jpeg"
            }
          ];
        }
      } catch (_) {
        toast("Выбор фото недоступен");
      }
      return;
    }

    let modal: any = null;
    const facingSignal = signal<"back" | "front">("back");
    const camErrSignal = signal<string>("");
    let camNode: any = null;

    const previewHolder = UIBox().style({
      width: "100%",
      height: 330,
      borderRadius: 12,
      backgroundColor: "#020617",
      overflow: "hidden",
      marginBottom: 10
    });

    const mountCam = () => {
      camErrSignal.value = "";
      if (externalDisplayBridge.connectedSignal.value) {
        void externalDisplayBridge.setCameraEnabled(false);
      }
      camNode = UICameraNode({ facingMode: facingSignal.value }).style({
        width: "100%",
        height: 330
      });
      camNode.onError((err: any) => {
        camErrSignal.value = err?.message || "Камера недоступна или доступ запрещен";
      });
      previewHolder.setContent([camNode]);
    };

    const unmountCam = () => {
      camNode = null;
      previewHolder.setContent([]);
      if (externalDisplayBridge.connectedSignal.value) {
        setTimeout(() => {
          void externalDisplayBridge.setCameraEnabled(true);
        }, 250);
      }
    };

    modal = UIModal(
      UIColumn(
        UIRow(
          LucideIcon("lucide:camera", 17, () => THEME.accentCyan),
          UIText("Фото узла авто").style({
            color: () => THEME.textPrimary,
            fontSize: 14,
            fontWeight: "bold",
            flex: 1,
            lineClamp: 1
          }),
          UIButton(LucideIcon("lucide:switch-camera", 17, () => THEME.accentCyan))
            .style({
              backgroundColor: () => THEME.bgElevated,
              borderRadius: 8,
              padding: 7
            })
            .onClick(async () => {
              facingSignal.value = facingSignal.value === "back" ? "front" : "back";
              if (camNode?.setFacingMode) {
                await camNode.setFacingMode(facingSignal.value).catch(() => {});
              }
            }),
          UIButton(LucideIcon("lucide:x", 18, () => THEME.textMuted))
            .style({ padding: 4 })
            .onClick(() => {
              unmountCam();
              modal.hide();
            })
        ).style({ alignItems: "center", gap: 8, width: "100%", marginBottom: 10 }),

        previewHolder,

        UIText(() => camErrSignal.value).style({
          color: () => THEME.statusCrit,
          fontSize: 11,
          marginBottom: 8,
          display: () => (camErrSignal.value ? "flex" : "none")
        }),

        UIRow(
          SecondaryButton("Из галереи", async () => {
            unmountCam();
            modal.hide();
            try {
              const picked = await openFilePicker({ multiple: false, accept: "image/*" });
              const f = Array.isArray(picked) ? picked[0] : picked;
              if (f) {
                appState.stagedItemsSignal.value = [
                  ...appState.stagedItemsSignal.value,
                  {
                    id: "gal-" + Date.now(),
                    type: "photo",
                    label: f.name || "Фото из галереи",
                    meta: f.size ? `${Math.round(f.size / 1024)} КБ` : "Фото",
                    file: f,
                    data: f,
                    mimeType: f.type || "image/jpeg"
                  }
                ];
              }
            } catch (_) {}
          }),
          UISpacer(),
          PrimaryButton("Сделать фото", async () => {
            if (!camNode) return;
            try {
              const file = await camNode.takePhoto();
              unmountCam();
              modal.hide();
              appState.stagedItemsSignal.value = [
                ...appState.stagedItemsSignal.value,
                {
                  id: "shot-" + Date.now(),
                  type: "photo",
                  label: `Снимок ${new Date().toLocaleTimeString("ru-RU", {
                    hour: "2-digit",
                    minute: "2-digit"
                  })}`,
                  meta: file?.size ? `${Math.round(file.size / 1024)} КБ` : "JPEG",
                  file,
                  data: file,
                  mimeType: "image/jpeg"
                }
              ];
              toast("Фото узла прикреплено");
            } catch (err: any) {
              camErrSignal.value = `Не удалось сделать снимок: ${err?.message || err}`;
            }
          })
        ).style({ alignItems: "center", width: "100%" })
      ).style({
        backgroundColor: () => THEME.bgSurface,
        borderRadius: 18,
        padding: 16,
        borderWidth: 1,
        borderColor: () => THEME.borderStrong,
        width: "92%"
      })
    )
      .transition({ opacity: 0, transform: "scale(0.95)", duration: 210 })
      .onOpen(() => mountCam())
      .onClose(() => unmountCam());

    modal.show();
  };

  const handleAttachFiles = async () => {
    try {
      const picked = await openFilePicker({ multiple: true });
      if (!picked) return;
      const files = Array.isArray(picked) ? picked : [picked];
      for (const f of files) {
        const mime = (f.type || "").toLowerCase();
        const isImg = mime.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/i.test(f.name || "");
        const isAudio = mime.startsWith("audio/") || /\.(mp3|wav|m4a|ogg|webm)$/i.test(f.name || "");
        const itemId = "file-" + Date.now() + "-" + Math.random().toString(16).slice(2, 6);
        const item: StagedItem = {
          id: itemId,
          type: isImg ? "photo" : isAudio ? "audio" : "file",
          label: f.name || "Вложение",
          meta: f.size ? `${Math.max(1, Math.round(f.size / 1024))} КБ` : "Файл",
          file: f,
          data: f,
          mimeType: f.type || undefined
        };
        appState.stagedItemsSignal.value = [...appState.stagedItemsSignal.value, item];

        // Если это документ / лог — извлекаем текст и коды DTC через /api/preview-document/
        if (!isImg && !isAudio) {
          apiClient.previewDocument(f).then(parsed => {
            if (!parsed) return;
            const codes = parsed.detected_dtc_codes || parsed.detected_codes || [];
            appState.stagedItemsSignal.value = appState.stagedItemsSignal.value.map(st =>
              st.id === itemId
                ? {
                    ...st,
                    parsedDoc: parsed,
                    meta:
                      codes.length > 0
                        ? `${codes.length} DTC • ${parsed.char_length || 0} симв.`
                        : `${parsed.char_length || 0} симв.`
                  }
                : st
            );
            if (codes.length > 0) {
              stageDtcCodes(codes.slice(0, 6));
            }
          });
        }
      }
      toast("Материал прикреплён");
    } catch (err: any) {
      toast(`Выбор файла отменён`);
    }
  };

  const openQuickDtcModal = () => {
    const manualSignal = signal("");
    let modal: any = null;
    const popular = ["P0300", "P0171", "P0420", "P0796", "P0335", "C0050", "U1900", "B1000"];

    const codeInput = UIInput()
      .style({
        placeholder: "Код ошибки, например P0301",
        placeholderColor: () => THEME.inputPlaceholder,
        backgroundColor: () => THEME.bgInput,
        color: () => THEME.textPrimary,
        borderWidth: 1.5,
        borderColor: () => THEME.borderStrong,
        borderRadius: 9,
        paddingHorizontal: 10,
        paddingVertical: 9,
        fontSize: 13,
        flex: 1
      })
      .onChange((v: string) => {
        manualSignal.value = v;
      });

    modal = UIModal(
      UIColumn(
        UIRow(
          LucideIcon("lucide:zap", 17, () => THEME.statusWarn),
          UIText("Добавить коды ошибок DTC").style({
            color: () => THEME.textPrimary,
            fontSize: 15,
            fontWeight: "bold",
            flex: 1
          }),
          UIButton(LucideIcon("lucide:x", 18, () => THEME.textMuted))
            .style({ padding: 4 })
            .onClick(() => modal.hide())
        ).style({ alignItems: "center", gap: 8, width: "100%", marginBottom: 10 }),

        UIRow(
          codeInput,
          PrimaryButton("Добавить", () => {
            const raw = (codeInput.value || manualSignal.value || "").trim().toUpperCase();
            if (!raw) return;
            const splitCodes = raw.split(/[\s,;]+/).filter(Boolean);
            stageDtcCodes(splitCodes);
            codeInput.value = "";
            manualSignal.value = "";
            modal.hide();
          })
        ).style({ alignItems: "center", gap: 8, width: "100%", marginBottom: 12 }),

        UIText("Частые коды неисправностей:").style({
          color: () => THEME.textMuted,
          fontSize: 11,
          marginBottom: 6
        }),

        UIRow(
          ...popular.map(code =>
            DtcChip(code, () => {
              stageDtcCodes([code]);
              toast(`Код ${code} прикреплён`);
            })
          )
        ).style({ flexWrap: "wrap", gap: 7, width: "100%", marginBottom: 14 }),

        UIRow(
          SecondaryButton("Словарь DTC (Все)", () => {
            modal.hide();
            callbacks?.onOpenDtc?.();
          }),
          UISpacer(),
          PrimaryButton("Готово", () => modal.hide())
        ).style({ alignItems: "center", width: "100%" })
      ).style({
        backgroundColor: () => THEME.bgSurface,
        borderRadius: 18,
        padding: 18,
        borderWidth: 1,
        borderColor: () => THEME.borderStrong,
        width: "92%"
      })
    ).transition({ opacity: 0, transform: "scale(0.95)", duration: 210 });
    modal.show();
  };

  // =========================================================================
  // ГОЛОСОВОЙ ВВОД (РЕАЛЬНАЯ ЗАПИСЬ МИКРОФОНА + SPEECH-TO-TEXT + WHISPER API)
  // =========================================================================

  const stopVoiceRecording = async () => {
    isRecordingSignal.value = false;
    if (recordTimer) {
      clearInterval(recordTimer);
      recordTimer = null;
    }

    if (activeSpeech) {
      try {
        activeSpeech.stop();
      } catch (_) {}
      activeSpeech = null;
    }

    if (activeRecorder) {
      const rec = activeRecorder;
      activeRecorder = null;
      try {
        const res = await rec.stop();
        if (res?.file) {
          const id = "voice-" + Date.now();
          const sec = Math.max(1, Math.round((res.duration || recordSecSignal.value * 1000) / 1000));
          const stItem: StagedItem = {
            id,
            type: "audio",
            label: `Голосовое (${sec}с)`,
            meta: capturedTranscript ? capturedTranscript.slice(0, 28) : "Обработка аудио...",
            file: res.file,
            data: res.file,
            mimeType: res.mimeType || "audio/mp4",
            duration: sec,
            transcript: capturedTranscript || undefined
          };
          appState.stagedItemsSignal.value = [...appState.stagedItemsSignal.value, stItem];

          // Расшифровываем и перекодируем через бэкенд Whisper/ffmpeg (как на сайте)
          apiClient.transcodeAudio(res.file, res.file.name || "voice_input.m4a").then(tr => {
            const trText = tr.transcript || capturedTranscript || "";
            if (trText && !querySignal.value.trim()) {
              querySignal.value = trText;
              composerInput.value = trText;
            }
            appState.stagedItemsSignal.value = appState.stagedItemsSignal.value.map(x =>
              x.id === id
                ? {
                    ...x,
                    transcript: trText || x.transcript,
                    meta: trText ? trText.slice(0, 32) : `Готово (${sec}с)`
                  }
                : x
            );
          });
        }
      } catch (err: any) {
        toast(`Ошибка остановки записи: ${err?.message || err}`);
      }
    }
    recordSecSignal.value = 0;
  };

  const toggleVoiceRecording = async () => {
    if (isRecordingSignal.value) {
      await stopVoiceRecording();
      return;
    }

    capturedTranscript = "";
    recordSecSignal.value = 0;

    if (AudioRecorder.supported) {
      try {
        const rec = new AudioRecorder();
        rec.addEventListener("level", (lvl: number) => {
          recordLevelSignal.value = Math.max(0.1, Math.min(1, lvl));
        });
        rec.addEventListener("ended", () => {
          if (isRecordingSignal.value) void stopVoiceRecording();
        });
        await rec.start({ maxDuration: 60000 });
        activeRecorder = rec;
        isRecordingSignal.value = true;
        recordTimer = setInterval(() => {
          recordSecSignal.value++;
        }, 1000);
        return;
      } catch (err: any) {
        if (!SpeechRecognizer.supported) {
          toast(`Микрофон недоступен: ${err?.message || err}`);
          return;
        }
      }
    }

    if (SpeechRecognizer.supported) {
      try {
        const sp = new SpeechRecognizer();
        activeSpeech = sp;
        isRecordingSignal.value = true;
        recordTimer = setInterval(() => {
          recordSecSignal.value++;
        }, 1000);
        sp.addEventListener("result", (r: any) => {
          capturedTranscript = r.transcript || "";
          if (capturedTranscript) {
            querySignal.value = capturedTranscript;
            composerInput.value = capturedTranscript;
          }
        });
        sp.addEventListener("end", () => {
          isRecordingSignal.value = false;
          if (recordTimer) {
            clearInterval(recordTimer);
            recordTimer = null;
          }
          activeSpeech = null;
        });
        sp.addEventListener("error", (_code: any, msg: string) => {
          isRecordingSignal.value = false;
          toast(`Речь: ${msg}`);
        });
        await sp.start({ language: "ru-RU", continuous: true, interimResults: true });
      } catch (err: any) {
        isRecordingSignal.value = false;
        toast(`Распознавание речи: ${err?.message || err}`);
      }
    } else {
      toast("Модуль записи голоса не поддерживается");
    }
  };

  // =========================================================================
  // ОТПРАВКА ЗАПРОСА К ЭКСПЕРТНОЙ СИСТЕМЕ (/api/ask/) + ЖИВАЯ АНИМАЦИЯ И ВОРКЕР
  // =========================================================================

  const composerInput = UITextArea()
    .style({
      flex: 1,
      minHeight: 42,
      maxHeight: 110,
      backgroundColor: () => THEME.bgInput,
      color: () => THEME.textPrimary,
      placeholder: "Опишите неисправность, симптомы и коды...",
      placeholderColor: () => THEME.inputPlaceholder,
      borderWidth: 1.5,
      borderColor: () => THEME.borderStrong,
      borderRadius: 12,
      paddingHorizontal: 12,
      paddingVertical: 9,
      fontSize: 13,
      keyboardShrink: true,
      keyboardDismiss: false
    })
    .onChange((val: string) => {
      querySignal.value = val;
    });

  const handleAsk = async (customQuery?: string, fromAr: boolean = false) => {
    if (appState.isAskingSignal.value) {
      toast("Дождитесь завершения текущего ответа или отмените генерацию");
      return;
    }

    const rawText = (customQuery !== undefined ? customQuery : querySignal.value || composerInput.value || "").trim();
    const staged = [...(appState.stagedItemsSignal.value || [])];

    if (!rawText && staged.length === 0) {
      toast("Введите симптом или прикрепите код DTC / фото");
      return;
    }

    const effectiveQuery =
      rawText ||
      (staged.some(s => s.type === "photo")
        ? "Проведи визуальную диагностику по фото узла"
        : staged.some(s => s.type === "audio")
          ? "Проанализируй звук / голосовое сообщение"
          : "Проведи диагностику по прикреплённым материалам");

    if (customQuery === undefined) {
      querySignal.value = "";
      composerInput.value = "";
    }
    appState.stagedItemsSignal.value = [];

    const nowTime = new Date().toLocaleTimeString("ru-RU", {
      hour: "2-digit",
      minute: "2-digit"
    });

    const userMsg: ChatMessageItem = {
      id: "local-u-" + Date.now(),
      role: "user",
      content: effectiveQuery,
      timestamp: nowTime,
      attachments: staged,
      vehicle: appState.vehicleSignal.value
    };

    // Готовим демо-историю заранее для неавторизованных пользователей
    const demoHistory = !appState.currentUserSignal.value.is_authenticated
      ? appState.messagesSignal.value
          .filter(m => m.id !== "msg-welcome" && !m.id.startsWith("local-err-"))
          .slice(-10)
          .map(m => ({
            role: m.role,
            content: m.content
          }))
      : undefined;

    appState.messagesSignal.value = [...appState.messagesSignal.value, userMsg];

    currentAskAbortFlag = { cancelled: false };

    try {
      activePendingCard = PendingGenerationCard(async () => {
        currentAskAbortFlag.cancelled = true;
        appState.isAskingSignal.value = false;
        appState.statusNoteSignal.value = "Генерация отменена";
        activePendingCard?.stop();
        activePendingCard = null;
        await apiClient.cancelGeneration(appState.currentSessionIdSignal.value).catch(() => {});
        rebuildFeed();
        toast("Генерация отменена");
      });

      appState.isAskingSignal.value = true;
      appState.statusNoteSignal.value = "Запрос обрабатывается экспертной моделью...";
      rebuildFeed();
      scrollFeedToBottom();

      // Подготовка структурированных параметров запроса
      const dtcCodes = staged.filter(s => s.type === "dtc").map(s => String(s.data));
      const audioItem = staged.find(s => s.type === "audio");

      const resp = await apiClient.askExpert({
        query: effectiveQuery,
        sessionId: appState.currentSessionIdSignal.value,
        vehicleInfo: appState.vehicleSignal.value,
        dtcCodes,
        telemetry: appState.obdStateSignal.value,
        stagedItems: staged,
        voiceTranscript: audioItem?.transcript,
        demoHistory,
        isCancelled: () => currentAskAbortFlag.cancelled
      });

      if (currentAskAbortFlag.cancelled) return;

      activePendingCard?.stop();
      activePendingCard = null;
      appState.isAskingSignal.value = false;

      if (resp.workerStatus) {
        appState.workerStatusSignal.value = resp.workerStatus as any;
      }

      if (resp.sessionId) {
        appState.currentSessionIdSignal.value = resp.sessionId;
        cacheManager.saveSetting("active_session_id", resp.sessionId);
      }
      if (resp.sessionTitle) {
        appState.currentSessionTitleSignal.value = resp.sessionTitle;
      }
      if (resp.vehicleDetected && !appState.vehicleSignal.value) {
        appState.vehicleSignal.value = resp.vehicleDetected;
      }

      const aiMsg: ChatMessageItem = {
        id: resp.messageId || "ai-" + Date.now(),
        role: "assistant",
        content: resp.answer || "",
        timestamp: new Date().toLocaleTimeString("ru-RU", {
          hour: "2-digit",
          minute: "2-digit"
        }),
        diagnosticType: resp.diagnosticType || "diagnosis",
        summaryTitle: resp.summaryTitle || "Экспертное заключение",
        faults: resp.faults || [],
        dtcCodes: resp.dtcDetails || [],
        tasks: resp.tasks || [],
        inventoryItems: resp.inventoryItems || [],
        inventory: resp.inventory || [],
        telemetryNotes: resp.telemetryNotes || [],
        recommendations: resp.recommendations || [],
        followupSuggestions: resp.followupSuggestions || []
      };

      // Обновляем локальный User msg реальным server id, если пришёл
      const finalMsgs = appState.messagesSignal.value.map(m =>
        m.id === userMsg.id && resp.userMessageId ? { ...m, id: resp.userMessageId } : m
      );
      finalMsgs.push(aiMsg);
      appState.messagesSignal.value = finalMsgs;
      appState.latestAssistantMessageSignal.value = aiMsg;
      appState.statusNoteSignal.value = fromAr ? "Вердикт обновлён для AR HUD" : "Диагностика готова";

      if (!appState.currentUserSignal.value.is_authenticated) {
        const sid = appState.currentSessionIdSignal.value;
        appState.demoMessagesBySession[sid] = finalMsgs;
        appState.demoSessionsSignal.value = appState.demoSessionsSignal.value.map(ds =>
          ds.id === sid
            ? {
                ...ds,
                title: resp.sessionTitle || effectiveQuery.slice(0, 36),
                updated_at: nowTime,
                message_count: finalMsgs.filter(x => x.id !== "msg-welcome").length
              }
            : ds
        );
      } else {
        appState.sessionsRefreshCounterSignal.value++;
        // Кратковременный опрос фонового воркера памяти
        if (workerPollTimer) clearTimeout(workerPollTimer);
        workerPollTimer = setTimeout(async () => {
          const st = await apiClient.getWorkerStatus(appState.currentSessionIdSignal.value);
          if (st?.worker_status) {
            appState.workerStatusSignal.value = st.worker_status;
          }
          if (st?.summary) {
            appState.sessionSummarySignal.value = st.summary;
          }
        }, 2500);
      }

      scrollFeedToBottom();
    } catch (err: any) {
      if (currentAskAbortFlag.cancelled) return;
      activePendingCard?.stop();
      activePendingCard = null;
      appState.isAskingSignal.value = false;
      appState.statusNoteSignal.value = "Сетевая ошибка";
      appState.messagesSignal.value = [
        ...appState.messagesSignal.value,
        {
          id: "local-err-" + Date.now(),
          role: "assistant",
          content: `Ошибка связи с сервером: ${err?.message || err}`,
          timestamp: nowTime,
          summaryTitle: "Сбой соединения",
          followupSuggestions: [effectiveQuery]
        }
      ];
      scrollFeedToBottom();
    }
  };

  appState.askHandler = handleAsk;

  // =========================================================================
  // НИЖНЯЯ ПАНЕЛЬ ВВОДА И ИНСТРУМЕНТОВ (1-в-1 С МОБИЛЬНОЙ ВЕРСИЕЙ САЙТА)
  // =========================================================================

  const stagingBar = StagingBar(appState.stagedItemsSignal, (removeId: string) => {
    appState.stagedItemsSignal.value = appState.stagedItemsSignal.value.filter(
      it => it.id !== removeId
    );
  });

  // Полоса активной записи голоса
  const voiceRecordingBanner = UIRow(
    UIBox().style({
      width: 9,
      height: 9,
      borderRadius: 5,
      backgroundColor: "#ef4444"
    }),
    UIText(() => `Запись голоса: ${recordSecSignal.value}с`).style({
      color: "#ef4444",
      fontSize: 12,
      fontWeight: "bold",
      flex: 1
    }),
    UIBox(
      UIBox().style({
        width: () => `${Math.round(recordLevelSignal.value * 100)}%`,
        height: 5,
        borderRadius: 3,
        backgroundColor: "#ec4899"
      })
    ).style({
      width: 70,
      height: 5,
      borderRadius: 3,
      backgroundColor: () => THEME.bgElevated
    }),
    UIButton(
      UIText("Готово").style({
        color: "#ffffff",
        fontSize: 11,
        fontWeight: "bold"
      })
    )
      .style({
        backgroundColor: "#ef4444",
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 7
      })
      .onClick(() => {
        void stopVoiceRecording();
      })
  ).style({
    width: "100%",
    backgroundColor: "rgba(239, 68, 68, 0.12)",
    borderTopWidth: 1,
    borderTopColor: "rgba(239, 68, 68, 0.4)",
    paddingHorizontal: 12,
    paddingVertical: 7,
    alignItems: "center",
    gap: 8,
    display: () => (isRecordingSignal.value ? "flex" : "none")
  });

  const toolBar = UIRow(
    UIButton(LucideIcon("lucide:camera", 19, () => THEME.accentCyan))
      .style({
        width: 40,
        height: 38,
        borderRadius: 10,
        backgroundColor: () => THEME.bgElevated,
        borderWidth: 1,
        borderColor: () => THEME.borderDefault,
        alignItems: "center",
        justifyContent: "center"
      })
      .onClick(() => {
        void openCameraModal();
      }),

    UIButton(LucideIcon("lucide:paperclip", 19, () => THEME.textSecondary))
      .style({
        width: 40,
        height: 38,
        borderRadius: 10,
        backgroundColor: () => THEME.bgElevated,
        borderWidth: 1,
        borderColor: () => THEME.borderDefault,
        alignItems: "center",
        justifyContent: "center"
      })
      .onClick(() => {
        void handleAttachFiles();
      }),

    UIButton(
      UIRow(
        LucideIcon("lucide:zap", 15, () => THEME.statusWarn),
        UIText("DTC").style({
          color: () => THEME.statusWarn,
          fontSize: 12,
          fontWeight: "bold"
        })
      ).style({ alignItems: "center", gap: 4 })
    )
      .style({
        paddingHorizontal: 11,
        height: 38,
        borderRadius: 10,
        backgroundColor: () => THEME.bgElevated,
        borderWidth: 1,
        borderColor: () => THEME.borderDefault,
        alignItems: "center",
        justifyContent: "center"
      })
      .onClick(openQuickDtcModal),

    UIButton(
      UIRow(
        LucideIcon("lucide:gauge", 15, () => THEME.statusOk),
        UIText("OBD").style({
          color: () => THEME.statusOk,
          fontSize: 12,
          fontWeight: "bold"
        })
      ).style({ alignItems: "center", gap: 4 })
    )
      .style({
        paddingHorizontal: 11,
        height: 38,
        borderRadius: 10,
        backgroundColor: () => THEME.bgElevated,
        borderWidth: 1,
        borderColor: () => THEME.borderDefault,
        alignItems: "center",
        justifyContent: "center"
      })
      .onClick(() => {
        attachObdSnapshotToStaging();
        toast("Телеметрия OBD-II добавлена к запросу");
      }),

    UIButton(
      UIRow(
        LucideIcon("lucide:mic", 16, () => (isRecordingSignal.value ? "#ffffff" : "#ec4899")),
        UIText(() => (isRecordingSignal.value ? "Стоп" : "Голос")).style({
          color: () => (isRecordingSignal.value ? "#ffffff" : "#ec4899"),
          fontSize: 12,
          fontWeight: "bold"
        })
      ).style({ alignItems: "center", gap: 4 })
    )
      .style({
        paddingHorizontal: 11,
        height: 38,
        borderRadius: 10,
        backgroundColor: () => (isRecordingSignal.value ? "#ef4444" : THEME.bgElevated),
        borderWidth: 1,
        borderColor: () => (isRecordingSignal.value ? "#ef4444" : THEME.borderDefault),
        alignItems: "center",
        justifyContent: "center"
      })
      .onClick(() => {
        void toggleVoiceRecording();
      }),

    UISpacer()
  ).style({
    width: "100%",
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 6,
    alignItems: "center",
    gap: 6
  });

  const sendRow = UIRow(
    composerInput,
    UIButton(
      UIRow(
        LucideIcon("lucide:send", 15, "#ffffff"),
        UIText(() => (appState.isAskingSignal.value ? "..." : "Диагноз")).style({
          color: "#ffffff",
          fontSize: 13,
          fontWeight: "bold"
        })
      ).style({ alignItems: "center", gap: 6 })
    )
      .style({
        backgroundColor: () => (appState.isAskingSignal.value ? "#64748b" : THEME.accentOrange),
        paddingHorizontal: 14,
        height: 44,
        borderRadius: 12,
        alignItems: "center",
        justifyContent: "center"
      })
      .onClick(() => {
        void handleAsk();
      })
  ).style({
    width: "100%",
    paddingHorizontal: 10,
    paddingBottom: 9,
    paddingTop: 2,
    alignItems: "flex-end",
    gap: 8
  });

  const bottomComposer = UIColumn(
    stagingBar,
    voiceRecordingBanner,
    toolBar,
    sendRow
  ).style({
    width: "100%",
    backgroundColor: () => THEME.bgSurface,
    borderTopWidth: 1,
    borderTopColor: () => THEME.borderDefault
  });

  // Первичное наполнение ленты
  rebuildFeed();

  return UIColumn(
    header,
    vehicleBar,
    selectionToolbar,
    feedScroll,
    bottomComposer
  ).style({
    flex: 1,
    width: "100%",
    backgroundColor: () => THEME.bgBase
  });
}
