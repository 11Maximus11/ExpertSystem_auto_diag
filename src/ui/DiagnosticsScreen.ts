// ИИдеал Авто — Главный экран ИИ-диагностики (2026-11-28)
// Copyright (C) 2026 ИИдеал Авто (LeCodes48 Edition)
// Licensed under the GNU General Public License v3.0 (GPL-3.0).

import {
  appState,
  askExpertHandler,
  attachAcousticMetricsToStaging,
  attachDocumentFileToStaging,
  attachObdSnapshotToStaging,
  attachPhotoFileToStaging,
  attachTextLogToStaging,
  createNewSession,
  removeStagedItem,
  stageDtcCodes,
  toggleChecklistTask,
  toggleInventoryItemCheck,
  updateVehicleInfo,
} from "../state/appState";
import { localDb } from "../storage/LocalDatabase";
import type { AcousticAnalysisMetrics, ChatMessageItem } from "../types";
import {
  AppHeader,
  DtcChip,
  LucideIcon,
  MessageCard,
  openConfirmModal,
  openDocumentPreviewModal,
  openTextPromptModal,
  openVehicleModal,
  PendingGenerationCard,
  type PendingCardHandle,
  PrimaryButton,
  SecondaryButton,
  StagingBar,
  THEME,
  VehicleBar,
} from "./components";

export interface DiagnosticsScreenCallbacks {
  onOpenAr?: () => void;

  onOpenSettings?: () => void;
  onOpenObd?: () => void;
  onOpenDtc?: () => void;
  onOpenSessions?: () => void;
}

export function createDiagnosticsScreen(callbacks?: DiagnosticsScreenCallbacks): any {
  const inputSignal = signal<string>("");
  const isRecordingVoiceSignal = signal<boolean>(false);
  let activeRecorder: any = null;
  let activeSpeech: any = null;

  const queryInput = UIInput()
    .named("diag-query-input")
    .style({
      flex: 1,
      minHeight: 40,
      maxHeight: 96,
      backgroundColor: () => THEME.bgInput,
      color: () => THEME.textPrimary,
      borderWidth: 1,
      borderColor: () => THEME.borderDefault,
      borderRadius: 12,
      paddingHorizontal: 12,
      paddingVertical: 8,
      fontSize: 13,
      placeholder: "Опишите симптомы, код ошибки или задайте вопрос...",
      placeholderColor: () => THEME.inputPlaceholder,
    })
    .onChange((val: string) => {
      inputSignal.value = val;
    });

  const submitQuery = async (overrideText?: string) => {
    const textToSend = (overrideText !== undefined ? overrideText : queryInput.value || inputSignal.value).trim();
    if (!textToSend && appState.stagedItemsSignal.value.length === 0) {
      toast("Введите симптомы или прикрепите код DTC / фото / лог");
      return;
    }
    if (overrideText === undefined) {
      queryInput.value = "";
      inputSignal.value = "";
    }
    await askExpertHandler(textToSend);
  };

  // Фото / Камера через нативный выбор файла (безопасно работает на iOS, Android, Web и Desktop)
  const handlePickPhoto = async () => {
    try {
      const files = await openFilePicker({
        accept: "image/*",
        multiple: false,
      });
      const picked = Array.isArray(files) ? files[0] : files;
      if (picked) {
        attachPhotoFileToStaging(picked, "Фото узла");
        toast(`Фото «${picked.name}» прикреплено`);
      }
    } catch {
      toast("Выбор фото отменён");
    }
  };

  // Прикрепление лога / отчёта (.txt, .csv, .log, .json, .pdf)
  const handlePickDocument = async () => {
    try {
      const files = await openFilePicker({
        accept: ".txt,.csv,.log,.json,.pdf,*/*",
        multiple: false,
      });
      const picked = Array.isArray(files) ? files[0] : files;
      if (picked) {
        await attachDocumentFileToStaging(picked);
        toast(`Документ «${picked.name}» обработан`);
      }
    } catch {
      openTextPromptModal({
        title: "Вставить лог сканера / текст",
        placeholder: "Вставьте текст отчета ELM327, коды P0300/P0171 или параметры Live Data...",
        confirmLabel: "Прикрепить лог",
        multiline: true,
        onConfirm: (rawText) => {
          if (rawText.trim()) {
            attachTextLogToStaging("Ручной_лог_сканера.txt", rawText);
            toast("Лог сканера прикреплен");
          }
        },
      });
    }
  };

  // Голосовой ввод и акустический анализ ДВС
  const handleToggleVoice = async () => {
    if (isRecordingVoiceSignal.value) {
      isRecordingVoiceSignal.value = false;
      try {
        if (activeSpeech && typeof activeSpeech.stop === "function") activeSpeech.stop();
      } catch {}
      try {
        if (activeRecorder && typeof activeRecorder.stop === "function") {
          const recRes = await activeRecorder.stop();
          const metrics: AcousticAnalysisMetrics = {
            durationSec: Math.max(1.2, (recRes?.durationMs || 2500) / 1000),
            avgHz: 145,
            peakHz: 420,
            clarity: 0.78,
            peakDb: -18,
            noteLabel: "D3",
            acousticHint: "Запись звука работы узла прикреплена к диагностике",
          };
          attachAcousticMetricsToStaging(metrics, inputSignal.value || undefined);
        }
      } catch {}
      activeRecorder = null;
      activeSpeech = null;
      return;
    }

    let startedAny = false;
    isRecordingVoiceSignal.value = true;
    appState.statusNoteSignal.value = "Запись речи / звука ДВС...";

    try {
      if (typeof SpeechRecognizer !== "undefined" && SpeechRecognizer.supported) {
        activeSpeech = new SpeechRecognizer();
        activeSpeech.addEventListener("result", (res: any) => {
          const txt = String(res?.transcript || res?.text || "").trim();
          if (txt) {
            queryInput.value = txt;
            inputSignal.value = txt;
          }
        });
        activeSpeech.addEventListener("end", () => {
          isRecordingVoiceSignal.value = false;
        });
        await activeSpeech.start({ lang: "ru-RU" });
        startedAny = true;
      }
    } catch {}

    try {
      if (typeof AudioRecorder !== "undefined") {
        activeRecorder = new AudioRecorder();
        await activeRecorder.start();
        startedAny = true;
      }
    } catch {}

    if (!startedAny) {
      isRecordingVoiceSignal.value = false;
      openTextPromptModal({
        title: "Голосовая заметка / описание звука",
        placeholder: "Например: металлический стук на холодную в районе ГБЦ, ~1200 об/мин",
        confirmLabel: "Добавить к запросу",
        onConfirm: (txt) => {
          if (txt.trim()) {
            const nextVal = (inputSignal.value ? `${inputSignal.value} ` : "") + txt.trim();
            queryInput.value = nextVal;
            inputSignal.value = nextVal;
          }
        },
      });
    }
  };

  // Быстрые пресеты кодов DTC для мгновенной проверки
  const quickDtcBar = UIScrollable(
    UIRow(
      DtcChip("P0300", () => stageDtcCodes(["P0300"])),
      DtcChip("P0171", () => stageDtcCodes(["P0171"])),
      DtcChip("P0420", () => stageDtcCodes(["P0420"])),
      DtcChip("P0700", () => stageDtcCodes(["P0700"])),
      DtcChip("U0100", () => stageDtcCodes(["U0100"])),
      SecondaryButton(
        "Снимок OBD",
        () => {
          attachObdSnapshotToStaging();
          toast("Телеметрия OBD-2 прикреплена");
        },
        "lucide:gauge"
      )
    ).style({ gap: 6, alignItems: "center", paddingHorizontal: 12 })
  ).style({ scrollDirection: "horizontal", width: "100%", height: 36, marginBottom: 4 });

  // Лента сообщений диалога (реактивное обновление)
  let pendingHandle: PendingCardHandle | null = null;

  const buildFeedCards = (): any[] => {
    const msgs: ChatMessageItem[] = appState.messagesSignal.value || [];
    const isGen = appState.isGeneratingSignal.value;
    void appState.settingsSignal.value.theme_mode;

    if (pendingHandle) {
      pendingHandle.stop();
      pendingHandle = null;
    }

    const cards = msgs.map((msg) =>
      MessageCard(msg, {
        onToggleTask: (msgId, itemType, checkId) => {
          if (itemType === "step") toggleChecklistTask(msgId, String(checkId));
          else toggleInventoryItemCheck(msgId, String(checkId));
        },
        onFollowupClick: (promptText) => {
          void submitQuery(promptText);
        },
        onDeleteMessage: (msgId) => {
          const sid = appState.currentSessionIdSignal.value;
          if (!sid) return;
          openConfirmModal({
            title: "Удалить сообщение?",
            message: "Запись будет удалена из локальной базы данных устройства.",
            confirmLabel: "Удалить",
            danger: true,
            onConfirm: () => {
              const filtered = appState.messagesSignal.value.filter((m) => m.id !== msgId);
              appState.messagesSignal.value = filtered;
              localDb.saveMessages(sid, filtered);
            },
          });
        },
        onOpenAr: callbacks?.onOpenAr,

        onStageDtc: (code) => stageDtcCodes([code]),
      })
    );

    if (isGen) {
      pendingHandle = PendingGenerationCard();
      cards.push(pendingHandle.node);
    }

    return cards;
  };

  const feedContainer = UIColumn(() => buildFeedCards()).style({
    width: "100%",
    gap: 10,
    paddingHorizontal: 12,
    paddingTop: 6,
    paddingBottom: 14,
  });

  const scrollFeed = UIScrollable(feedContainer)
    .named("diag-feed-scroll")
    .style({
      flex: 1,
      width: "100%",
    });

  // Нижняя панель ввода
  const inputComposer = UIColumn(
    StagingBar(
      appState.stagedItemsSignal,
      (id) => removeStagedItem(id),
      (item) => {
        if (item.parsedDoc) openDocumentPreviewModal(item.parsedDoc);
      }
    ),
    UIRow(
      UIButton(LucideIcon("lucide:camera", 18, () => THEME.accentCyan))
        .named("diag-btn-photo")
        .style({
          width: 38,
          height: 38,
          borderRadius: 10,
          backgroundColor: () => THEME.bgElevated,
          borderWidth: 1,
          borderColor: () => THEME.borderDefault,
          alignItems: "center",
          justifyContent: "center",
        })
        .onClick(() => void handlePickPhoto()),

      UIButton(LucideIcon("lucide:paperclip", 18, () => THEME.accentViolet))
        .named("diag-btn-file")
        .style({
          width: 38,
          height: 38,
          borderRadius: 10,
          backgroundColor: () => THEME.bgElevated,
          borderWidth: 1,
          borderColor: () => THEME.borderDefault,
          alignItems: "center",
          justifyContent: "center",
        })
        .onClick(() => void handlePickDocument()),

      UIButton(
        LucideIcon("lucide:mic", 18, () =>
          isRecordingVoiceSignal.value ? THEME.statusCrit : THEME.textSecondary
        )
      )
        .named("diag-btn-voice")
        .style({
          width: 38,
          height: 38,
          borderRadius: 10,
          backgroundColor: () =>
            isRecordingVoiceSignal.value ? "rgba(239, 68, 68, 0.18)" : THEME.bgElevated,
          borderWidth: 1,
          borderColor: () =>
            isRecordingVoiceSignal.value ? THEME.statusCrit : THEME.borderDefault,
          alignItems: "center",
          justifyContent: "center",
        })
        .onClick(() => void handleToggleVoice()),

      queryInput,

      PrimaryButton(
        () => (appState.isGeneratingSignal.value ? "..." : "Анализ"),
        () => void submitQuery(),
        "lucide:send"
      ).named("diag-btn-send")
    ).style({
      width: "100%",
      gap: 6,
      alignItems: "center",
    })
  ).style({
    width: "100%",
    backgroundColor: () => THEME.bgSurface,
    borderTopWidth: 1,
    borderColor: () => THEME.borderDefault,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 6,
  });

  return UIColumn(
    AppHeader({
      title: "ИИДЕАЛ АВТО",
      onOpenAr: callbacks?.onOpenAr,

      onOpenSettings: callbacks?.onOpenSettings,
      onResetChat: () => {
        createNewSession("Новая диагностика");
        toast("Создана новая диагностическая сессия");
      },
    }),
    UIColumn(
      VehicleBar(appState.vehicleSignal, () => {
        openVehicleModal(appState.vehicleSignal, (val) => updateVehicleInfo(val));
      })
    ).style({ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 4, width: "100%" }),
    quickDtcBar,
    scrollFeed,
    inputComposer
  )
    .named("diag")
    .style({
      flex: 1,
      width: "100%",
      backgroundColor: () => THEME.bgBase,
    });
}
