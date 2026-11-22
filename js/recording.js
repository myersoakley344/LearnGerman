import {
  callPronunciationModel,
  getNextAttemptNumber,
  insertAttempt,
  logApiUsage,
  logEvent,
  uploadRecording
} from "./api.js";
import {
  chooseRecorderMimeType,
  convertBlobToWav,
  requestAudioStream,
  trimSilenceFromWav
} from "./audio.js";
import {
  $,
  PRACTICE_RECORDING_LIMIT_MS,
  PRONUNCIATION_MODEL,
  RECORDING_CHUNK_GRACE_MS,
  RECORDING_CHUNK_MS,
  REQUIRED_SUCCESSES_PER_WORD,
  TEST_RECORDING_LIMIT_MS,
  WORD_CHECK_LIMIT_MS,
  currentItem,
  errorText,
  getRecordingLimitMs,
  normalizeWord,
  state
} from "./state.js";
import {
  renderItem,
  resetRecordingUi,
  setBusy,
  showEvaluation,
  showMessage,
  updateWordCheckButton
} from "./ui.js";

let callbacks = {
  abandonLessonTest: async () => {},
  advanceLessonTest: async () => {},
  loadLearnerProgress: async () => {}
};

export function setRecordingCallbacks(nextCallbacks) {
  callbacks = { ...callbacks, ...nextCallbacks };
}

function configureRecorder(stream, mode, item) {
  const mimeType = chooseRecorderMimeType();
  const recorder = new MediaRecorder(
    stream,
    mimeType ? { mimeType } : undefined
  );

  state.mediaRecorder = recorder;
  state.recordingStream = stream;
  state.recordingChunks = [];
  state.recordingMode = mode;
  state.recordingItem = item;
  state.recordingStartedAt = null;
  state.recordingStartedMonotonic = null;
  state.manualStop = false;

  recorder.addEventListener(
    "start",
    () => {
      state.recordingStartedAt = Date.now();
      state.recordingStartedMonotonic = performance.now();
    },
    { once: true }
  );

  recorder.addEventListener("dataavailable", event => {
    if (!event.data?.size) return;

    const limitMs = getRecordingLimitMs(state.recordingMode);
    const elapsedMs = state.recordingStartedMonotonic === null
      ? 0
      : performance.now() - state.recordingStartedMonotonic;

    if (
      limitMs === null ||
      elapsedMs <= limitMs + RECORDING_CHUNK_GRACE_MS
    ) {
      state.recordingChunks.push(event.data);
      return;
    }

    if (recorder.state === "recording") {
      state.manualStop = false;
      recorder.stop();
    }
  });

  recorder.addEventListener(
    "stop",
    () => {
      void finishRecording().catch(async error => {
        console.error("Recording finalization failed:", error);

        clearRecordingTimers();
        stopMediaTracks();

        state.recordingChunks = [];
        state.mediaRecorder = null;
        state.recordingMode = null;
        state.recordingItem = null;
        state.recordingStartedAt = null;
        state.recordingStartedMonotonic = null;
        state.wordCheckArmed = false;

        resetRecordingUi();
        setBusy(false);
        updateWordCheckButton();

        if (state.testRunState?.active) {
          await callbacks.abandonLessonTest(
            "Technisches Problem beim Verarbeiten der Testaufnahme. " +
            "Der Test wurde ohne Auszahlung abgebrochen."
          );
          return;
        }

        showMessage(
          "Die Aufnahme konnte nicht verarbeitet werden. " +
          (error.message || String(error)),
          true
        );
      });
    },
    { once: true }
  );
}

export async function startPracticeRecording() {
  if (!state.currentApiKey) {
    showMessage("Bitte abmelden und erneut anmelden.", true);
    return;
  }

  const item = currentItem();
  if (
    !item ||
    state.isBusy ||
    state.wordCheckArmed ||
    state.testRunState?.active
  ) {
    return;
  }

  try {
    setBusy(true);
    showMessage(
      "Mikrofon wird vorbereitet … " +
      "Die Aufnahme endet spätestens nach 20 Sekunden."
    );

    const stream = await requestAudioStream();
    configureRecorder(stream, "practice", item);

    state.mediaRecorder.addEventListener(
      "start",
      () => onPracticeRecorderStarted(item),
      { once: true }
    );

    state.mediaRecorder.start(RECORDING_CHUNK_MS);
  } catch (error) {
    console.error(error);
    stopMediaTracks();
    resetRecordingUi();
    setBusy(false);
    showMessage(
      error.message || "Aufnahme konnte nicht gestartet werden.",
      true
    );
  }
}

function onPracticeRecorderStarted(item) {
  $("record-button").classList.add("hidden");
  $("word-check-button").classList.add("hidden");
  $("stop-button").classList.remove("hidden");
  $("stop-button").disabled = false;

  showMessage(
    "Aufnahme läuft. Tippe auf „Fertig“; " +
    "automatisch endet sie nach 20 Sekunden."
  );

  logEvent("recording_started", item, {
    mode: "practice",
    timeLimitMs: PRACTICE_RECORDING_LIMIT_MS
  });

  state.recordingDeadlineTimer = window.setTimeout(() => {
    if (state.mediaRecorder?.state === "recording") {
      state.manualStop = false;
      state.mediaRecorder.stop();
    }
  }, PRACTICE_RECORDING_LIMIT_MS);
}

export function armWordCheck() {
  if (!state.currentApiKey) {
    showMessage("Bitte abmelden und erneut anmelden.", true);
    return;
  }

  const item = currentItem();
  const successes = item
    ? state.practiceSuccessCounts.get(item.id) || 0
    : 0;

  if (
    !item ||
    state.isBusy ||
    state.mediaRecorder ||
    state.wordCheckArmed ||
    state.testRunState?.active
  ) {
    return;
  }

  if (successes < REQUIRED_SUCCESSES_PER_WORD) {
    showMessage(
      `Für den Wort-Check brauchst du zuerst ` +
      `${REQUIRED_SUCCESSES_PER_WORD} erfolgreiche Übungsversuche.`
    );
    return;
  }

  if (state.passedWordChecks.has(item.id)) {
    showMessage("Dieses Wort ist bereits erfolgreich getestet.", false);
    return;
  }

  state.wordCheckArmed = true;
  renderItem();
  showMessage(
    "Bereit für den Wort-Check. Tippe auf „Wort-Check-Aufnahme starten“, " +
    "um das Wort anzuzeigen und aufzunehmen."
  );
}

export function cancelWordCheck() {
  if (!state.wordCheckArmed || state.isBusy || state.mediaRecorder) return;

  state.wordCheckArmed = false;
  renderItem();
}

export async function startWordCheckRecording() {
  if (!state.currentApiKey) {
    showMessage("Bitte abmelden und erneut anmelden.", true);
    return;
  }

  const item = currentItem();

  if (
    !item ||
    !state.wordCheckArmed ||
    state.isBusy ||
    state.mediaRecorder ||
    state.testRunState?.active
  ) {
    return;
  }

  setBusy(true);
  showMessage("Mikrofon wird vorbereitet …");

  try {
    const stream = await requestAudioStream();
    configureRecorder(stream, "word_check", item);

    state.mediaRecorder.addEventListener(
      "start",
      () => onWordCheckRecorderStarted(item),
      { once: true }
    );

    state.mediaRecorder.start(RECORDING_CHUNK_MS);
  } catch (error) {
    console.error(error);
    stopMediaTracks();
    state.wordCheckArmed = false;
    resetRecordingUi();
    setBusy(false);
    showMessage(
      error.message || "Aufnahme konnte nicht gestartet werden.",
      true
    );
  }
}

function onWordCheckRecorderStarted(item) {
  state.wordCheckStartedAt = performance.now();
  state.wordCheckDeadline =
    state.wordCheckStartedAt + WORD_CHECK_LIMIT_MS;
  state.promptShownAt = Date.now();

  $("prompt").textContent = item.prompt_mg;
  $("timer-panel").classList.remove("hidden");
  $("timer-countdown").textContent =
    (WORD_CHECK_LIMIT_MS / 1000).toFixed(1);
  $("timer-label").textContent = "Wort-Check läuft";
  $("timer-help").textContent =
    `Sprich das deutsche Wort. Die Aufnahme endet spätestens nach ` +
    `${WORD_CHECK_LIMIT_MS / 1000} Sekunden.`;

  $("record-button").classList.add("hidden");
  $("word-check-button").classList.add("hidden");
  $("word-check-cancel-button").classList.add("hidden");
  $("reveal-button").classList.add("hidden");
  $("play-audio-button").classList.add("hidden");
  $("translation").classList.add("hidden");
  $("tts-player").classList.add("hidden");
  $("stop-button").classList.remove("hidden");
  $("stop-button").disabled = false;

  showMessage("Aufnahme läuft …");

  logEvent("word_check_started", item, {
    timeLimitMs: WORD_CHECK_LIMIT_MS
  });

  startCountdownTimer();

  state.recordingDeadlineTimer = window.setTimeout(() => {
    if (state.mediaRecorder?.state === "recording") {
      state.manualStop = false;
      state.mediaRecorder.stop();
    }
  }, WORD_CHECK_LIMIT_MS);
}

function onTestRecorderStarted(item) {
  state.promptShownAt = Date.now();
  state.wordCheckStartedAt = performance.now();
  state.wordCheckDeadline =
    state.wordCheckStartedAt + TEST_RECORDING_LIMIT_MS;

  $("timer-panel").classList.remove("hidden");
  $("timer-countdown").textContent =
    (TEST_RECORDING_LIMIT_MS / 1000).toFixed(1);
  $("timer-label").textContent =
    `Testwort ${state.testRunState.index + 1} von ` +
    `${state.testRunState.queue.length}`;
  $("timer-help").textContent =
    `Sprich das deutsche Wort. Die Aufnahme endet nach ` +
    `${TEST_RECORDING_LIMIT_MS / 1000} Sekunden.`;

  $("record-button").classList.add("hidden");
  $("stop-button").classList.remove("hidden");
  $("stop-button").disabled = false;

  showMessage("Testaufnahme läuft …");

  logEvent("recording_started", item, {
    mode: "test",
    testRunId: state.testRunState.id,
    timeLimitMs: TEST_RECORDING_LIMIT_MS
  });

  startCountdownTimer();

  state.recordingDeadlineTimer = window.setTimeout(() => {
    if (state.mediaRecorder?.state === "recording") {
      state.manualStop = false;
      state.mediaRecorder.stop();
    }
  }, TEST_RECORDING_LIMIT_MS);
}

function startCountdownTimer() {
  state.countdownTimer = window.setInterval(() => {
    const remaining = Math.max(
      0,
      state.wordCheckDeadline - performance.now()
    );

    $("timer-countdown").textContent =
      (remaining / 1000).toFixed(1);

    if (remaining <= 0) {
      clearInterval(state.countdownTimer);
      state.countdownTimer = null;
    }
  }, 40);
}

export async function startTestRecording() {
  if (!state.currentApiKey) {
    showMessage("Bitte abmelden und erneut anmelden.", true);
    return;
  }

  if (
    !state.testRunState?.active ||
    state.isBusy ||
    state.mediaRecorder
  ) {
    return;
  }

  const item = currentItem();
  if (!item) return;

  try {
    setBusy(true);
    showMessage("Mikrofon wird vorbereitet …");

    const stream = await requestAudioStream();
    configureRecorder(stream, "test", item);

    state.mediaRecorder.addEventListener(
      "start",
      () => onTestRecorderStarted(item),
      { once: true }
    );

    state.mediaRecorder.start(RECORDING_CHUNK_MS);
  } catch (error) {
    console.error(error);
    stopMediaTracks();
    resetRecordingUi();
    setBusy(false);
    showMessage(
      error.message || "Testaufnahme konnte nicht gestartet werden.",
      true
    );
  }
}

export function stopRecordingManually() {
  if (!state.mediaRecorder || state.mediaRecorder.state !== "recording") {
    return;
  }

  state.manualStop = true;
  clearRecordingTimers();

  $("stop-button").disabled = true;
  state.mediaRecorder.stop();
}

function clearRecordingTimers() {
  if (state.recordingDeadlineTimer !== null) {
    clearTimeout(state.recordingDeadlineTimer);
    state.recordingDeadlineTimer = null;
  }

  if (state.countdownTimer !== null) {
    clearInterval(state.countdownTimer);
    state.countdownTimer = null;
  }
}

function stopMediaTracks() {
  if (!state.recordingStream) return;

  state.recordingStream.getTracks().forEach(track => track.stop());
  state.recordingStream = null;
}

async function finishRecording() {
  clearRecordingTimers();
  showMessage("Aufnahme beendet. Audio wird vorbereitet …");
  stopMediaTracks();

  const mode = state.recordingMode;
  const item = state.recordingItem;
  const startedAt = state.recordingStartedAt;
  const promptTime = state.promptShownAt;
  const timeLimitMs = getRecordingLimitMs(mode);
  const testRunId = mode === "test"
    ? state.testRunState?.id || null
    : null;

  const endReason = state.manualStop ? "manual" : "deadline";

  let durationMs = state.recordingStartedMonotonic === null
    ? 0
    : Math.max(
        0,
        performance.now() - state.recordingStartedMonotonic
      );

  if (timeLimitMs !== null) {
    durationMs = Math.min(timeLimitMs, durationMs);
  }

  if (
    (mode === "word_check" || mode === "test") &&
    state.wordCheckStartedAt !== null
  ) {
    durationMs = Math.min(
      timeLimitMs,
      Math.max(0, performance.now() - state.wordCheckStartedAt)
    );
  }

  if (!item || !state.mediaRecorder) {
    state.wordCheckArmed = false;
    resetRecordingUi();
    setBusy(false);
    return;
  }

  const sourceBlob = new Blob(state.recordingChunks, {
    type: state.mediaRecorder.mimeType || "audio/webm"
  });

  state.recordingChunks = [];
  state.mediaRecorder = null;
  state.recordingMode = null;
  state.recordingItem = null;
  state.recordingStartedAt = null;
  state.recordingStartedMonotonic = null;

  if (mode === "word_check" || mode === "test") {
    $("timer-label").textContent = "Aufnahme beendet";
    $("timer-countdown").textContent =
      (durationMs / 1000).toFixed(1);
    $("timer-help").textContent = "Die Antwort wird jetzt bewertet.";
  }

  if (!sourceBlob.size) {
    state.wordCheckArmed = false;
    resetRecordingUi();
    setBusy(false);
    updateWordCheckButton();

    if (mode === "test") {
      await callbacks.abandonLessonTest(
        "Es wurden keine Audiodaten aufgenommen. " +
        "Der Test wurde ohne Auszahlung abgebrochen."
      );
    } else {
      showMessage(
        "Keine Audiodaten aufgenommen. Bitte erneut versuchen.",
        true
      );
    }

    return;
  }

  if (state.lastRecordingUrl) {
    URL.revokeObjectURL(state.lastRecordingUrl);
  }

  state.lastRecordingUrl = URL.createObjectURL(sourceBlob);

  const recordingPlayer = $("recording-player");
  recordingPlayer.src = state.lastRecordingUrl;
  recordingPlayer.classList.remove("hidden");

  await logEvent(
    mode === "word_check" ? "word_check_completed" : "recording_stopped",
    item,
    {
      mode,
      durationMs,
      timeLimitMs,
      endReason,
      ...(testRunId ? { testRunId } : {})
    }
  );

  await evaluateRecording({
    item,
    sourceBlob,
    mode,
    testRunId,
    startedAt,
    promptTime,
    durationMs,
    timeLimitMs,
    endReason
  });
}

async function evaluateRecording({
  item,
  sourceBlob,
  mode,
  testRunId,
  startedAt,
  promptTime,
  durationMs,
  timeLimitMs,
  endReason
}) {
  setBusy(true);
  showMessage("Audio wird vorbereitet …");

  const attemptId = crypto.randomUUID();
  let originalWavBlob;
  let trimmedAudio;

  try {
    originalWavBlob = await convertBlobToWav(sourceBlob);
    trimmedAudio = await trimSilenceFromWav(originalWavBlob);
  } catch (error) {
    console.error("Audio conversion/trim failed:", error);
    state.wordCheckArmed = false;
    resetRecordingUi();
    setBusy(false);

    if (mode === "test") {
      await callbacks.abandonLessonTest(
        "Technisches Problem bei der Audioverarbeitung. " +
        "Der Test wurde ohne Auszahlung abgebrochen."
      );
      return;
    }

    updateWordCheckButton();
    showMessage(
      `Audio konnte nicht verarbeitet werden: ${error.message || error}`,
      true
    );
    return;
  }

  let attemptNumber;

  try {
    attemptNumber = await getNextAttemptNumber(item.id, mode);
  } catch (error) {
    console.error("Could not get attempt number:", error);
    state.wordCheckArmed = false;

    if (mode === "test") {
      await callbacks.abandonLessonTest(
        "Testversuch konnte nicht gespeichert werden. " +
        "Der Test wurde ohne Auszahlung abgebrochen."
      );
    } else {
      resetRecordingUi();
      setBusy(false);
      showMessage("Versuchsnummer konnte nicht geladen werden.", true);
    }

    return;
  }

  const audioPath =
    `${state.currentUser.id}/${item.lesson_id}/${item.id}/${attemptId}.wav`;

  if (!trimmedAudio.hasSpeech) {
    const saveResult = await saveNoSpeechAttempt({
      item,
      mode,
      testRunId,
      attemptId,
      attemptNumber,
      originalWavBlob,
      audioPath,
      startedAt,
      promptTime,
      durationMs,
      timeLimitMs,
      endReason
    });

    state.wordCheckArmed = false;
    resetRecordingUi();
    setBusy(false);
    updateWordCheckButton();

    if (mode === "test") {
      if (!saveResult.ok) {
        await callbacks.abandonLessonTest(
          "Die Testantwort konnte nicht gespeichert werden. " +
          "Der Test wurde ohne Auszahlung abgebrochen."
        );
        return;
      }

      showEvaluation({
        item,
        pronunciation: null,
        recognized: false,
        finalScore: 0,
        errors: [],
        mode
      });

      await callbacks.advanceLessonTest(0, testRunId);
      return;
    }

    showMessage(
      "Keine Sprache erkannt. Bitte sprich etwas lauter und versuche es erneut.",
      true
    );
    return;
  }

  showMessage("Carbon bewertet die Antwort …");

  const [uploadResult, pronunciationResult] =
    await Promise.allSettled([
      uploadRecording(audioPath, originalWavBlob),
      callPronunciationModel({
        apiKey: state.currentApiKey,
        item,
        wavBlob: trimmedAudio.blob
      })
    ]);

  const uploadSucceeded = uploadResult.status === "fulfilled";
  const pronunciationSucceeded =
    pronunciationResult.status === "fulfilled";

  const pronunciation = pronunciationSucceeded
    ? pronunciationResult.value
    : null;

  let recognized = null;
  let finalScore = null;
  let phonemeScore = null;
  let evaluationStatus = "complete";
  const errors = [];

  if (pronunciationSucceeded) {
    recognized =
      normalizeWord(pronunciation.heardText) ===
      normalizeWord(item.target_de);

    phonemeScore = pronunciation.match ? 1 : 0;

    finalScore = !recognized
      ? 0
      : pronunciation.match
        ? 1
        : 0.75;
  } else {
    evaluationStatus = "error";
    errors.push(`Carbon: ${errorText(pronunciationResult.reason)}`);
  }

  if (!uploadSucceeded) {
    errors.push(`Audio-Upload: ${errorText(uploadResult.reason)}`);
  }

  const isRestrictedMode =
    mode === "word_check" || mode === "test";

  const attemptRow = {
    client_attempt_id: attemptId,
    user_id: state.currentUser.id,
    item_id: item.id,
    test_run_id: mode === "test" ? testRunId : null,
    mode,
    attempt_number: attemptNumber,
    client_started_at: startedAt
      ? new Date(startedAt).toISOString()
      : null,
    prompt_finished_at: promptTime
      ? new Date(promptTime).toISOString()
      : null,
    speech_started_at: null,
    recording_finished_at: new Date().toISOString(),
    reaction_time_ms: null,
    response_duration_ms: durationMs,
    time_limit_ms: timeLimitMs,
    recording_end_reason: endReason,
    used_translation: isRestrictedMode
      ? false
      : state.usedTranslationForCurrentItem,
    used_tts_audio: isRestrictedMode
      ? false
      : state.usedAudioForCurrentItem,
    stt_transcript: pronunciation?.heardText || null,
    target_word_recognized: recognized,
    phoneme_transcription: pronunciation?.ipa || null,
    phoneme_score: phonemeScore,
    final_score: finalScore,
    audio_path: uploadSucceeded ? audioPath : null,
    evaluation_status: evaluationStatus,
    evaluation_error: errors.length ? errors.join("\n") : null,
    model_name: PRONUNCIATION_MODEL,
    model_version:
      "NanoGPT Carbon combined transcript+IPA+pronunciation; " +
      "reasoning_effort=low; max_tokens=1024; edge-trim=v1"
  };

  const {
    data: attemptData,
    error: attemptInsertError
  } = await insertAttempt(attemptRow, { returnId: true });

  if (attemptInsertError) {
    console.error("Could not save attempt:", attemptInsertError);
    errors.push(`Datenbank: ${attemptInsertError.message}`);
  }

  await logApiUsage({
    requestId: pronunciation?.requestId || null,
    attemptId: attemptData?.id || null,
    itemId: item.id,
    operation: "phoneme_analysis",
    model: PRONUNCIATION_MODEL,
    status: pronunciation ? "success" : "error",
    cost: pronunciation?.cost ?? null,
    usage: pronunciation?.usage ?? null,
    audioDurationMs: trimmedAudio.trimmedDurationMs
  });

  if (mode === "test") {
    showEvaluation({
      item,
      pronunciation,
      recognized,
      finalScore,
      errors,
      mode
    });

    state.wordCheckArmed = false;
    resetRecordingUi();
    setBusy(false);

    if (
      attemptInsertError ||
      !pronunciationSucceeded ||
      !uploadSucceeded ||
      evaluationStatus !== "complete" ||
      finalScore === null
    ) {
      await callbacks.abandonLessonTest(
        "Technisches Problem bei der Testbewertung oder Speicherung. " +
        "Der Test wurde ohne Auszahlung abgebrochen."
      );
      return;
    }

    await callbacks.advanceLessonTest(finalScore, testRunId);
    return;
  }

  state.wordCheckArmed = false;
  await callbacks.loadLearnerProgress();

  showEvaluation({
    item,
    pronunciation,
    recognized,
    finalScore,
    errors,
    mode
  });

  resetRecordingUi();
  setBusy(false);
  updateWordCheckButton();

  if (errors.length) {
    showMessage(
      "Technisches Problem bei der Bewertung. " +
      "Es wurde kein bestandenes Wort-Check-Ergebnis gespeichert.",
      true
    );
  } else if (mode === "word_check" && finalScore === 1) {
    showMessage("Wort-Check bestanden: Score 1,0.", false);
  } else if (mode === "word_check" && finalScore === 0.75) {
    showMessage(
      "Wort erkannt, Aussprache noch nicht vollständig akzeptiert. " +
      "Übe weiter und versuche den Wort-Check erneut."
    );
  } else if (mode === "word_check") {
    showMessage(
      "Wort-Check nicht bestanden. Übe das Wort und versuche es erneut."
    );
  } else {
    showMessage("Bewertung abgeschlossen.", false);
  }
}

async function saveNoSpeechAttempt({
  item,
  mode,
  testRunId,
  attemptId,
  attemptNumber,
  originalWavBlob,
  audioPath,
  startedAt,
  promptTime,
  durationMs,
  timeLimitMs,
  endReason
}) {
  let uploadError = null;

  try {
    await uploadRecording(audioPath, originalWavBlob);
  } catch (error) {
    uploadError = error;
  }

  const isTest = mode === "test";
  const isRestrictedMode =
    mode === "word_check" || isTest;

  const { error: insertError } = await insertAttempt({
    client_attempt_id: attemptId,
    user_id: state.currentUser.id,
    item_id: item.id,
    test_run_id: isTest ? testRunId : null,
    mode,
    attempt_number: attemptNumber,
    client_started_at: startedAt
      ? new Date(startedAt).toISOString()
      : null,
    prompt_finished_at: promptTime
      ? new Date(promptTime).toISOString()
      : null,
    response_duration_ms: durationMs,
    time_limit_ms: timeLimitMs,
    recording_end_reason: endReason,
    used_translation: isRestrictedMode
      ? false
      : state.usedTranslationForCurrentItem,
    used_tts_audio: isRestrictedMode
      ? false
      : state.usedAudioForCurrentItem,
    target_word_recognized: isTest ? false : null,
    final_score: isTest ? 0 : null,
    audio_path: uploadError ? null : audioPath,
    evaluation_status: isTest ? "complete" : "error",
    evaluation_error: isTest
      ? null
      : "No speech detected after edge silence trimming.",
    model_version: "edge-trim-v1"
  });

  if (insertError) {
    console.error("Could not save no-speech attempt:", insertError);
  }

  if (uploadError) {
    console.error("Could not upload no-speech attempt:", uploadError);
  }

  return {
    ok: !insertError && (!isTest || !uploadError),
    insertError,
    uploadError
  };
}
