"use strict";

const SUPABASE_URL =
  "https://coaiznrxtpdqatvfbsyi.supabase.co";

const SUPABASE_KEY =
  "sb_publishable_D0adyb95if5W2IH5WA9JOQ_ENePqpoh";

const NANO_API_BASE = "https://api.nano-gpt.com/api/v1";
const WHISPER_ENDPOINT = `${NANO_API_BASE}/audio/transcriptions`;
const PRONUNCIATION_ENDPOINT = `${NANO_API_BASE}/chat/completions`;

const WHISPER_DEFAULT_MODEL = "openai/whisper-large-v3";
const PRONUNCIATION_MODEL = "google/gemini-4-carbon";

const RECORDING_BUCKET = "learn-recordings";
const TTS_BUCKET = "learn-tts";

const WORD_CHECK_LIMIT_MS = 2000;
const REQUIRED_SUCCESSES_PER_WORD = 3;

const supabaseClient = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_KEY
);

let currentUser = null;
let currentApiKey = null;
let lessons = [];
let items = [];
let currentIndex = 0;
let promptShownAt = null;
let usedTranslationForCurrentItem = false;
let usedAudioForCurrentItem = false;

let mediaRecorder = null;
let recordingStream = null;
let recordingChunks = [];
let recordingStartedAt = null;
let recordingMode = null;
let recordingItem = null;
let recordingDeadlineTimer = null;
let countdownTimer = null;
let wordCheckStartedAt = null;
let wordCheckDeadline = null;
let manualStop = false;
let isBusy = false;

let practiceSuccessCounts = new Map();
let passedWordChecks = new Set();
let lastRecordingUrl = null;

const $ = id => document.getElementById(id);

function showMessage(text, isError = false) {
  const element = $("app-message");
  element.textContent = text;
  element.style.color = isError ? "#a12626" : "#236b37";
}

function currentItem() {
  return items[currentIndex] || null;
}

function setBusy(value) {
  isBusy = value;

  $("lesson-select").disabled = value;
  $("reveal-button").disabled = value;
  $("play-audio-button").disabled = value;
  $("record-button").disabled = value;
  $("word-check-button").disabled = value;
  $("repeat-button").disabled = value;
  $("skip-button").disabled = value;
}

function normalizeWord(text) {
  return String(text || "")
    .toLocaleLowerCase("de-DE")
    .normalize("NFC")
    .replace(/[.,!?;:"“”„()[\]{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getNanoGPTConfig() {
  const config = window.LEARNGERMAN_CONFIG;

  if (
    !config ||
    typeof config.apiKeyPrefix !== "string" ||
    typeof config.apiKeySuffix !== "string" ||
    !config.profileCodes ||
    typeof config.profileCodes !== "object"
  ) {
    throw new Error("Konfiguration fehlt. Prüfe config.js.");
  }

  return config;
}

function parseLoginString(value) {
  const match = String(value || "")
    .trim()
    .match(/^(\d{2})_([A-Za-z0-9]{4})_([A-Za-z0-9]{4})$/);

  if (!match) {
    throw new Error(
      "Bitte den Login im Format 01_7351_abcd eingeben."
    );
  }

  const participantNumber = match[1];
  const profileCode = match[2];
  const keyFragment = match[3];
  const config = getNanoGPTConfig();

  if (!config.profileCodes[participantNumber]) {
    throw new Error("Unbekanntes Teilnehmerprofil.");
  }

  if (config.profileCodes[participantNumber] !== profileCode) {
    throw new Error("Profilcode stimmt nicht.");
  }

  return {
    accessCode: `profil_${participantNumber}`,
    apiKey:
      config.apiKeyPrefix +
      keyFragment +
      config.apiKeySuffix
  };
}

function costFromObject(data) {
  if (!data || typeof data !== "object") return null;

  const pricing = data.x_nanogpt_pricing;

  if (pricing && typeof pricing === "object") {
    const amount = Number(pricing.amount ?? pricing.cost);
    if (Number.isFinite(amount)) return amount;
  }

  const usageCost = Number(data.usage?.cost);
  if (Number.isFinite(usageCost)) return usageCost;

  const directCost = Number(data.cost);
  if (Number.isFinite(directCost)) return directCost;

  return null;
}

function costFromHeaders(headers) {
  for (const name of [
    "x-nanogpt-pricing",
    "x-nanogpt-cost",
    "x-pricing"
  ]) {
    const raw = headers.get(name);
    if (!raw) continue;

    try {
      const parsed = JSON.parse(raw);
      const amount = Number(parsed.amount ?? parsed.cost);
      if (Number.isFinite(amount)) return amount;
    } catch {
      const match = raw.match(/-?\d+(?:\.\d+)?/);

      if (match) {
        const amount = Number(match[0]);
        if (Number.isFinite(amount)) return amount;
      }
    }
  }

  return null;
}

async function lookupNanoCost(apiKey, requestId) {
  if (!requestId) return null;

  const url =
    "https://api.nano-gpt.com/api/v1/usage/requests/" +
    encodeURIComponent(requestId);

  try {
    const response = await fetch(url, {
      headers: {
        "x-api-key": apiKey,
        "Accept": "application/json"
      }
    });

    if (!response.ok) return null;

    return costFromObject(await response.json());
  } catch (error) {
    console.warn("Could not look up NanoGPT cost:", error);
    return null;
  }
}

function readTokenCount(usage, fields) {
  if (!usage) return null;

  for (const field of fields) {
    const value = Number(usage[field]);
    if (Number.isFinite(value)) return value;
  }

  return null;
}

async function logEvent(eventType, item = null, payload = {}) {
  if (!currentUser) return;

  const { error } = await supabaseClient
    .from("learn_events")
    .insert({
      client_event_id: crypto.randomUUID(),
      user_id: currentUser.id,
      lesson_id: item?.lesson_id || payload.lessonId || null,
      item_id: item?.id || null,
      event_type: eventType,
      client_time: new Date().toISOString(),
      payload
    });

  if (error) {
    console.error("Could not log event:", error);
  }
}

async function logApiUsage({
  requestId,
  attemptId,
  itemId,
  operation,
  model,
  status,
  cost,
  usage,
  audioDurationMs
}) {
  if (!currentUser) return;

  const { error } = await supabaseClient
    .from("learn_api_usage")
    .insert({
      client_request_id: crypto.randomUUID(),
      user_id: currentUser.id,
      attempt_id: attemptId,
      item_id: itemId,
      provider: "NanoGPT",
      model_name: model,
      operation,
      status,
      input_tokens: readTokenCount(
        usage,
        ["prompt_tokens", "input_tokens"]
      ),
      output_tokens: readTokenCount(
        usage,
        ["completion_tokens", "output_tokens"]
      ),
      estimated_cost: cost,
      currency: "USD",
      audio_duration_ms: audioDurationMs,
      provider_request_id: requestId || null,
      pricing_version: "NanoGPT API response or usage lookup",
      completed_at: new Date().toISOString()
    });

  if (error) {
    console.error("Could not log API usage:", error);
  }
}

async function getProfile(user) {
  const { data, error } = await supabaseClient
    .from("learn_profiles")
    .select("display_name, role")
    .eq("id", user.id)
    .single();

  if (error) throw error;
  return data;
}

async function enterApp(user) {
  const profile = await getProfile(user);

  if (profile.role !== "learner") {
    throw new Error("This account is not a learner account.");
  }

  currentUser = user;
  $("login-screen").classList.add("hidden");
  $("app-screen").classList.remove("hidden");
  $("participant-name").textContent =
    profile.display_name || user.email || "";

  await loadLessons();
}

async function loadLessons() {
  showMessage("Loading lessons...");

  const { data, error } = await supabaseClient
    .from("learn_lessons")
    .select("id, slug, title, order_index")
    .eq("is_published", true)
    .order("order_index");

  if (error) {
    console.error(error);
    showMessage(error.message, true);
    return;
  }

  lessons = data || [];

  const select = $("lesson-select");
  select.replaceChildren();

  for (const lesson of lessons) {
    const option = document.createElement("option");
    option.value = lesson.id;
    option.textContent = lesson.title;
    select.appendChild(option);
  }

  if (!lessons.length) {
    items = [];
    renderItem();
    showMessage("No published lessons found.", true);
    return;
  }

  await loadItems(lessons[0].id);
}

async function loadItems(lessonId) {
  showMessage("Loading lesson...");

  const { data, error } = await supabaseClient
    .from("learn_learner_items")
    .select(
      "id, lesson_id, order_index, prompt_mg, target_de, tts_audio_path"
    )
    .eq("lesson_id", lessonId)
    .order("order_index");

  if (error) {
    console.error(error);
    items = [];
    renderItem();
    showMessage(error.message, true);
    return;
  }

  items = data || [];
  currentIndex = 0;

  const lesson = lessons.find(value => value.id === lessonId);
  $("lesson-title").textContent = lesson?.title || "";

  await loadLearnerProgress();

  await logEvent("lesson_opened", null, {
    lessonId,
    itemCount: items.length
  });

  showMessage("");
  renderItem();
}

async function loadLearnerProgress() {
  practiceSuccessCounts = new Map();
  passedWordChecks = new Set();

  for (const item of items) {
    practiceSuccessCounts.set(item.id, 0);
  }

  if (!currentUser || !items.length) {
    renderProgress();
    return;
  }

  const itemIds = items.map(item => item.id);

  const { data, error } = await supabaseClient
    .from("learn_attempts")
    .select(
      "item_id, mode, final_score, evaluation_status, " +
      "used_translation, used_tts_audio"
    )
    .eq("user_id", currentUser.id)
    .in("item_id", itemIds)
    .in("mode", ["practice", "word_check"])
    .limit(5000);

  if (error) {
    console.error("Could not load learner progress:", error);
    showMessage(
      "Fortschritt konnte nicht geladen werden: " + error.message,
      true
    );
    renderProgress();
    return;
  }

  for (const attempt of data || []) {
    if (attempt.mode === "word_check") {
      if (
        attempt.evaluation_status === "complete" &&
        Number(attempt.final_score) === 1
      ) {
        passedWordChecks.add(attempt.item_id);
      }

      continue;
    }

    const qualifies =
      attempt.evaluation_status === "complete" &&
      Number(attempt.final_score) === 1 &&
      !attempt.used_translation &&
      !attempt.used_tts_audio;

    if (qualifies) {
      const previous =
        practiceSuccessCounts.get(attempt.item_id) || 0;

      practiceSuccessCounts.set(attempt.item_id, previous + 1);
    }
  }

  renderProgress();
}

function getRequiredPreparedWords() {
  const count = items.length;

  if (count === 0) return 0;

  return Math.max(1, count - Math.ceil(count * 0.1));
}

function getPreparedWordCount() {
  return items.filter(item =>
    (practiceSuccessCounts.get(item.id) || 0) >=
    REQUIRED_SUCCESSES_PER_WORD
  ).length;
}

function renderProgress() {
  const passedCount = items.filter(item =>
    passedWordChecks.has(item.id)
  ).length;

  $("word-check-progress").textContent =
    `${passedCount} von ${items.length} Wörtern erfolgreich getestet`;

  const required = getRequiredPreparedWords();
  const prepared = getPreparedWordCount();

  if (!items.length) {
    $("test-unlock-status").textContent = "";
  } else if (prepared >= required) {
    $("test-unlock-status").textContent =
      "Voraussetzung für den späteren Gesamttest erfüllt.";
  } else {
    $("test-unlock-status").textContent =
      `Für einen Wort-Check müssen drei unbeeinflusste Übungserfolge ` +
      `mit Score 1 erreicht werden. Für den späteren Gesamttest: ` +
      `${prepared} von ${required} Wörtern ausreichend geübt.`;
  }

  renderCurrentWordStatus();
  updateWordCheckButton();
}

function renderCurrentWordStatus() {
  const item = currentItem();
  const badge = $("current-word-status");

  if (!item) {
    badge.textContent = "";
    badge.classList.remove("passed");
    return;
  }

  if (passedWordChecks.has(item.id)) {
    badge.textContent = "Wort erfolgreich getestet";
    badge.classList.add("passed");
    return;
  }

  const count = practiceSuccessCounts.get(item.id) || 0;

  if (count >= REQUIRED_SUCCESSES_PER_WORD) {
    badge.textContent = "3/3 Übungserfolge · Wort-Check bereit";
  } else {
    badge.textContent =
      `${count}/${REQUIRED_SUCCESSES_PER_WORD} Übungserfolge · ` +
      "Wort-Check noch gesperrt";
  }

  badge.classList.remove("passed");
}

function updateWordCheckButton() {
  const item = currentItem();
  if (!item) {
    $("word-check-button").disabled = true;
    return;
  }

  const count = practiceSuccessCounts.get(item.id) || 0;
  const passed = passedWordChecks.has(item.id);

  $("word-check-button").disabled =
    isBusy ||
    count < REQUIRED_SUCCESSES_PER_WORD ||
    passed;
}

function getTtsUrl(path) {
  if (!path) return null;

  return supabaseClient
    .storage
    .from(TTS_BUCKET)
    .getPublicUrl(path)
    .data
    .publicUrl;
}

function renderItem() {
  const item = currentItem();

  $("evaluation-panel").classList.add("hidden");
  $("evaluation-result").replaceChildren();
  $("translation").classList.add("hidden");
  $("translation").textContent = "";
  $("recording-player").classList.add("hidden");
  $("recording-player").removeAttribute("src");
  $("tts-player").classList.add("hidden");
  $("tts-player").removeAttribute("src");
  $("timer-panel").classList.add("hidden");

  usedTranslationForCurrentItem = false;
  usedAudioForCurrentItem = false;
  promptShownAt = null;

  if (lastRecordingUrl) {
    URL.revokeObjectURL(lastRecordingUrl);
    lastRecordingUrl = null;
  }

  if (!item) {
    $("prompt").textContent = "No items in this lesson.";
    $("item-position").textContent = "";
    $("reveal-button").disabled = true;
    $("play-audio-button").disabled = true;
    $("record-button").disabled = true;
    $("word-check-button").disabled = true;
    $("repeat-button").disabled = true;
    $("skip-button").disabled = true;
    renderProgress();
    return;
  }

  $("prompt").textContent = item.prompt_mg;
  $("item-position").textContent =
    `Teny ${currentIndex + 1} / ${items.length}`;

  $("reveal-button").disabled = false;
  $("play-audio-button").disabled = !item.tts_audio_path;
  $("record-button").disabled = false;
  $("repeat-button").disabled = false;
  $("skip-button").disabled = false;

  renderProgress();

  logEvent("item_shown", item, { index: currentIndex });
  showMessage("");
}

function revealTranslation() {
  const item = currentItem();
  if (!item || recordingMode === "word_check") return;

  $("translation").textContent = item.target_de;
  $("translation").classList.remove("hidden");
  usedTranslationForCurrentItem = true;

  logEvent("translation_revealed", item);
}

async function playTts() {
  const item = currentItem();

  if (!item?.tts_audio_path) {
    showMessage("No TTS audio is available for this item.", true);
    return;
  }

  if (recordingMode === "word_check") return;

  const player = $("tts-player");
  player.src = getTtsUrl(item.tts_audio_path);
  player.classList.remove("hidden");
  usedAudioForCurrentItem = true;

  await logEvent("tts_played", item);

  try {
    await player.play();
  } catch (error) {
    console.error(error);
    showMessage("Could not play the audio. Tap the audio player.", true);
  }
}

function chooseRecorderMimeType() {
  if (!window.MediaRecorder) return "";

  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4"
  ];

  return candidates.find(type =>
    MediaRecorder.isTypeSupported(type)
  ) || "";
}

async function requestAudioStream() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    throw new Error(
      "Dieser Browser unterstützt keine Audioaufnahme. " +
      "Bitte Chrome auf Android verwenden."
    );
  }

  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  });
}

function configureRecorder(stream, mode, item) {
  const mimeType = chooseRecorderMimeType();

  mediaRecorder = new MediaRecorder(
    stream,
    mimeType ? { mimeType } : undefined
  );

  recordingStream = stream;
  recordingChunks = [];
  recordingMode = mode;
  recordingItem = item;
  recordingStartedAt = Date.now();
  manualStop = false;

  mediaRecorder.addEventListener("dataavailable", event => {
    if (event.data?.size) recordingChunks.push(event.data);
  });

  mediaRecorder.addEventListener(
    "stop",
    () => finishRecording(),
    { once: true }
  );
}

async function startPracticeRecording() {
  if (!currentApiKey) {
    showMessage("Bitte abmelden und erneut anmelden.", true);
    return;
  }

  const item = currentItem();
  if (!item || isBusy) return;

  try {
    setBusy(true);
    showMessage("Mikrofon wird vorbereitet …");

    const stream = await requestAudioStream();
    configureRecorder(stream, "practice", item);
    mediaRecorder.start();

    $("record-button").classList.add("hidden");
    $("word-check-button").classList.add("hidden");
    $("stop-button").classList.remove("hidden");
    $("stop-button").disabled = false;

    showMessage("Aufnahme läuft. Tippe auf „Fertig“, wenn du fertig bist.");

    await logEvent("recording_started", item, {
      mode: "practice"
    });
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

async function startWordCheck() {
  if (!currentApiKey) {
    showMessage("Bitte abmelden und erneut anmelden.", true);
    return;
  }

  const item = currentItem();
  const count = item
    ? practiceSuccessCounts.get(item.id) || 0
    : 0;

  if (!item || isBusy || mediaRecorder) return;

  if (count < REQUIRED_SUCCESSES_PER_WORD) {
    showMessage(
      `Für den Wort-Check brauchst du zuerst ` +
      `${REQUIRED_SUCCESSES_PER_WORD} erfolgreiche Übungsversuche.`
    );
    return;
  }

  if (passedWordChecks.has(item.id)) {
    showMessage("Dieses Wort ist bereits erfolgreich getestet.", false);
    return;
  }

  setBusy(true);
  showMessage("Mikrofon wird vorbereitet …");

  try {
    const stream = await requestAudioStream();
    configureRecorder(stream, "word_check", item);

    mediaRecorder.addEventListener(
      "start",
      () => onWordCheckRecorderStarted(item),
      { once: true }
    );

    mediaRecorder.start();
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

function onWordCheckRecorderStarted(item) {
  wordCheckStartedAt = performance.now();
  wordCheckDeadline = wordCheckStartedAt + WORD_CHECK_LIMIT_MS;
  promptShownAt = Date.now();

  $("prompt").textContent = item.prompt_mg;
  $("timer-panel").classList.remove("hidden");
  $("timer-countdown").textContent =
    (WORD_CHECK_LIMIT_MS / 1000).toFixed(1);
  $("timer-label").textContent = "Wort-Check läuft";
  $("timer-help").textContent =
    "Sprich das deutsche Wort. Die Aufnahme endet spätestens nach 2 Sekunden.";

  $("record-button").classList.add("hidden");
  $("word-check-button").classList.add("hidden");
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

  countdownTimer = window.setInterval(() => {
    const remaining = Math.max(
      0,
      wordCheckDeadline - performance.now()
    );

    $("timer-countdown").textContent =
      (remaining / 1000).toFixed(1);

    if (remaining <= 0) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }, 40);

  recordingDeadlineTimer = window.setTimeout(() => {
    if (mediaRecorder?.state === "recording") {
      manualStop = false;
      mediaRecorder.stop();
    }
  }, WORD_CHECK_LIMIT_MS);
}

function stopRecordingManually() {
  if (!mediaRecorder || mediaRecorder.state !== "recording") return;

  manualStop = true;
  clearRecordingTimers();

  $("stop-button").disabled = true;
  mediaRecorder.stop();
}

function clearRecordingTimers() {
  if (recordingDeadlineTimer !== null) {
    clearTimeout(recordingDeadlineTimer);
    recordingDeadlineTimer = null;
  }

  if (countdownTimer !== null) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

function stopMediaTracks() {
  if (!recordingStream) return;

  recordingStream.getTracks().forEach(track => track.stop());
  recordingStream = null;
}

function resetRecordingUi() {
  $("stop-button").classList.add("hidden");
  $("record-button").classList.remove("hidden");
  $("word-check-button").classList.remove("hidden");
  $("reveal-button").classList.remove("hidden");
  $("play-audio-button").classList.remove("hidden");
  $("timer-panel").classList.add("hidden");
}

async function finishRecording() {
  clearRecordingTimers();
  stopMediaTracks();

  const mode = recordingMode;
  const item = recordingItem;
  const startedAt = recordingStartedAt;
  const promptTime = promptShownAt;
  const timeLimitMs =
    mode === "word_check" ? WORD_CHECK_LIMIT_MS : null;

  let durationMs = Math.max(
    0,
    Date.now() - (startedAt || Date.now())
  );

  const endReason = mode === "word_check"
    ? (manualStop ? "manual" : "deadline")
    : "manual";

  if (mode === "word_check" && wordCheckStartedAt !== null) {
    durationMs = Math.min(
      WORD_CHECK_LIMIT_MS,
      Math.max(0, performance.now() - wordCheckStartedAt)
    );
  }

  $("stop-button").classList.add("hidden");
  $("record-button").classList.remove("hidden");
  $("word-check-button").classList.remove("hidden");
  $("reveal-button").classList.remove("hidden");
  $("play-audio-button").classList.remove("hidden");

  if (!item || !mediaRecorder) {
    resetRecordingUi();
    setBusy(false);
    return;
  }

  const recorderMimeType = mediaRecorder.mimeType || "audio/webm";
  const sourceBlob = new Blob(recordingChunks, {
    type: recorderMimeType
  });

  recordingChunks = [];
  mediaRecorder = null;
  recordingMode = null;
  recordingItem = null;
  recordingStartedAt = null;

  if (mode === "word_check") {
    $("timer-label").textContent = "Aufnahme beendet";
    $("timer-countdown").textContent =
      (durationMs / 1000).toFixed(1);
    $("timer-help").textContent =
      "Die Antwort wird jetzt bewertet.";
  }

  if (!sourceBlob.size) {
    resetRecordingUi();
    setBusy(false);
    updateWordCheckButton();
    showMessage("Keine Audiodaten aufgenommen. Bitte erneut versuchen.", true);
    return;
  }

  if (lastRecordingUrl) {
    URL.revokeObjectURL(lastRecordingUrl);
  }

  lastRecordingUrl = URL.createObjectURL(sourceBlob);

  const recordingPlayer = $("recording-player");
  recordingPlayer.src = lastRecordingUrl;
  recordingPlayer.classList.remove("hidden");

  await logEvent(
    mode === "word_check" ? "word_check_completed" : "recording_stopped",
    item,
    {
      mode,
      durationMs,
      timeLimitMs,
      endReason
    }
  );

  await evaluateRecording({
    item,
    sourceBlob,
    mode,
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
  startedAt,
  promptTime,
  durationMs,
  timeLimitMs,
  endReason
}) {
  setBusy(true);
  showMessage("Valiny dinihina... / Checking your answer...");

  const whisperModel =
    $("whisper-model").value.trim() || WHISPER_DEFAULT_MODEL;

  const attemptId = crypto.randomUUID();
  let wavBlob;

  try {
    wavBlob = await convertBlobToWav(sourceBlob);
  } catch (error) {
    console.error(error);
    resetRecordingUi();
    setBusy(false);
    updateWordCheckButton();
    showMessage(
      "Audio konnte nicht verarbeitet werden. Bitte erneut versuchen.",
      true
    );
    return;
  }

  const attemptNumber = await getNextAttemptNumber(item.id, mode);
  const audioPath =
    `${currentUser.id}/${item.lesson_id}/${item.id}/${attemptId}.wav`;

  const [uploadResult, whisperResult, pronunciationResult] =
    await Promise.allSettled([
      uploadRecording(audioPath, wavBlob),
      callWhisper({
        apiKey: currentApiKey,
        model: whisperModel,
        wavBlob
      }),
      callPronunciationModel({
        apiKey: currentApiKey,
        item,
        wavBlob
      })
    ]);

  const uploadSucceeded = uploadResult.status === "fulfilled";
  const whisperSucceeded = whisperResult.status === "fulfilled";
  const pronunciationSucceeded =
    pronunciationResult.status === "fulfilled";

  const whisper = whisperSucceeded ? whisperResult.value : null;
  const pronunciation =
    pronunciationSucceeded ? pronunciationResult.value : null;

  let finalScore = null;
  let recognized = null;
  let phonemeScore = null;
  let evaluationStatus = "complete";
  const errors = [];

  if (whisperSucceeded && pronunciationSucceeded) {
    recognized =
      normalizeWord(whisper.text) === normalizeWord(item.target_de);

    phonemeScore = pronunciation.match ? 1 : 0;
    finalScore = !recognized
      ? 0
      : pronunciation.match
        ? 1
        : 0.75;
  } else {
    evaluationStatus = "error";

    if (!whisperSucceeded) {
      errors.push(`Whisper: ${errorText(whisperResult.reason)}`);
    }

    if (!pronunciationSucceeded) {
      errors.push(
        `Aussprachemodell: ${errorText(pronunciationResult.reason)}`
      );
    }
  }

  if (!uploadSucceeded) {
    errors.push(`Audio-Upload: ${errorText(uploadResult.reason)}`);
  }

  const isWordCheck = mode === "word_check";

  const attemptRow = {
    client_attempt_id: attemptId,
    user_id: currentUser.id,
    item_id: item.id,
    test_run_id: null,
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
    used_translation: isWordCheck
      ? false
      : usedTranslationForCurrentItem,
    used_tts_audio: isWordCheck
      ? false
      : usedAudioForCurrentItem,
    stt_transcript: whisper?.text || null,
    target_word_recognized: recognized,
    phoneme_transcription: pronunciation?.ipa || null,
    phoneme_score: phonemeScore,
    final_score: finalScore,
    audio_path: uploadSucceeded ? audioPath : null,
    evaluation_status: evaluationStatus,
    evaluation_error: errors.length ? errors.join("\n") : null,
    model_name: `${whisperModel} + ${PRONUNCIATION_MODEL}`,
    model_version:
      "NanoGPT API; reasoning_effort=low; max_tokens=1024"
  };

  const { data: attemptData, error: attemptInsertError } =
    await supabaseClient
      .from("learn_attempts")
      .insert(attemptRow)
      .select("id")
      .single();

  if (attemptInsertError) {
    console.error("Could not save attempt:", attemptInsertError);
    errors.push(`Datenbank: ${attemptInsertError.message}`);
  }

  const savedAttemptId = attemptData?.id || null;

  await logApiUsage({
    requestId: whisper?.requestId || null,
    attemptId: savedAttemptId,
    itemId: item.id,
    operation: "stt",
    model: whisperModel,
    status: whisper ? "success" : "error",
    cost: whisper?.cost ?? null,
    usage: whisper?.usage ?? null,
    audioDurationMs: durationMs
  });

  await logApiUsage({
    requestId: pronunciation?.requestId || null,
    attemptId: savedAttemptId,
    itemId: item.id,
    operation: "phoneme_analysis",
    model: PRONUNCIATION_MODEL,
    status: pronunciation ? "success" : "error",
    cost: pronunciation?.cost ?? null,
    usage: pronunciation?.usage ?? null,
    audioDurationMs: durationMs
  });

  await loadLearnerProgress();

  showEvaluation({
    item,
    whisper,
    pronunciation,
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
      "Es wurde kein erfolgreicher Wort-Check gespeichert.",
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

function errorText(error) {
  if (!error) return "Unbekannter Fehler";
  return error.message || String(error);
}

async function getNextAttemptNumber(itemId, mode) {
  const { count, error } = await supabaseClient
    .from("learn_attempts")
    .select("id", { count: "exact", head: true })
    .eq("user_id", currentUser.id)
    .eq("item_id", itemId)
    .eq("mode", mode);

  if (error) {
    console.warn("Could not count previous attempts:", error);
    return 1;
  }

  return (count || 0) + 1;
}

async function uploadRecording(path, blob) {
  const { error } = await supabaseClient
    .storage
    .from(RECORDING_BUCKET)
    .upload(path, blob, {
      contentType: "audio/wav",
      upsert: false
    });

  if (error) throw error;
  return path;
}

async function callWhisper({ apiKey, model, wavBlob }) {
  const form = new FormData();
  form.append("model", model);
  form.append("file", wavBlob, "answer.wav");
  form.append("language", "de");
  form.append("response_format", "json");

  const response = await fetch(WHISPER_ENDPOINT, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "Accept": "application/json"
    },
    body: form
  });

  const requestId = response.headers.get("x-request-id");
  const bodyText = await response.text();

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}: ${bodyText.slice(0, 700)}`
    );
  }

  let data;

  try {
    data = JSON.parse(bodyText);
  } catch {
    throw new Error(
      `Whisper-Antwort war kein JSON: ${bodyText.slice(0, 500)}`
    );
  }

  const text = String(data.text || "").trim();

  if (!text) {
    throw new Error("Whisper lieferte kein Transkript.");
  }

  let cost = costFromHeaders(response.headers);
  if (cost === null) cost = costFromObject(data);
  if (cost === null) {
    cost = await lookupNanoCost(apiKey, requestId);
  }

  return {
    text,
    requestId,
    cost,
    usage: data.usage || null
  };
}

async function callPronunciationModel({ apiKey, item, wavBlob }) {
  const base64Audio = await blobToBase64(wavBlob);

  const prompt =
    "Analysiere das Audio in zwei Schritten. " +
    "1. Bestimme ausschließlich aus dem Audio die tatsächlich gesprochene " +
    "deutsche Lautfolge in breiter IPA-Notation. " +
    "2. Vergleiche sie mit einer akzeptablen Standardaussprache des " +
    "Referenztexts. Akzeptiere normale Akzentvariation, aber nicht deutlich " +
    "falsche, ausgelassene oder hinzugefügte Laute. " +
    "Antworte ausschließlich als JSON mit den Feldern ipa und match, " +
    "ohne Markdown oder Erklärung. " +
    `Referenztext: ${item.target_de}`;

  const response = await fetch(PRONUNCIATION_ENDPOINT, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify({
      model: PRONUNCIATION_MODEL,
      stream: false,
      reasoning_effort: "low",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            {
              type: "input_audio",
              input_audio: {
                data: base64Audio,
                format: "wav"
              }
            }
          ]
        }
      ]
    })
  });

  const requestId = response.headers.get("x-request-id");
  const bodyText = await response.text();

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}: ${bodyText.slice(0, 700)}`
    );
  }

  let data;

  try {
    data = JSON.parse(bodyText);
  } catch {
    throw new Error(
      `Aussprachemodell lieferte kein JSON: ${bodyText.slice(0, 500)}`
    );
  }

  let content = data.choices?.[0]?.message?.content;

  if (Array.isArray(content)) {
    content = content
      .filter(part => typeof part?.text === "string")
      .map(part => part.text)
      .join("");
  }

  content = String(content || "").trim();

  const jsonMatch = content.match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    const notice = data.x_nanogpt_notice
      ? ` NanoGPT-Hinweis: ${data.x_nanogpt_notice}`
      : "";

    throw new Error(
      `Kein JSON in der Ausspracheantwort gefunden: ` +
      `${content.slice(0, 500)}.${notice}`
    );
  }

  let result;

  try {
    result = JSON.parse(jsonMatch[0]);
  } catch {
    throw new Error(
      `Ungültiges Aussprache-JSON: ${jsonMatch[0].slice(0, 500)}`
    );
  }

  if (typeof result.match !== "boolean") {
    throw new Error("Antwort enthält kein boolesches Feld 'match'.");
  }

  let cost = costFromHeaders(response.headers);
  if (cost === null) cost = costFromObject(data);
  if (cost === null) {
    cost = await lookupNanoCost(apiKey, requestId);
  }

  return {
    ipa: String(result.ipa || ""),
    match: result.match,
    requestId,
    cost,
    usage: data.usage || null,
    notice: data.x_nanogpt_notice || null
  };
}

async function blobToBase64(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

async function convertBlobToWav(blob) {
  const AudioContextClass =
    window.AudioContext || window.webkitAudioContext;

  if (!AudioContextClass) {
    throw new Error("Web Audio API ist nicht verfügbar.");
  }

  const context = new AudioContextClass();

  try {
    const inputBuffer = await context.decodeAudioData(
      await blob.arrayBuffer()
    );

    const targetRate = 16000;
    const ratio = inputBuffer.sampleRate / targetRate;
    const outputLength = Math.ceil(inputBuffer.length / ratio);
    const mono = new Float32Array(outputLength);

    for (
      let channel = 0;
      channel < inputBuffer.numberOfChannels;
      channel++
    ) {
      const source = inputBuffer.getChannelData(channel);

      for (let index = 0; index < outputLength; index++) {
        const sourcePosition = index * ratio;
        const left = Math.floor(sourcePosition);
        const right = Math.min(left + 1, source.length - 1);
        const fraction = sourcePosition - left;
        const sample =
          source[left] * (1 - fraction) +
          source[right] * fraction;

        mono[index] += sample / inputBuffer.numberOfChannels;
      }
    }

    return encodeWav(mono, targetRate);
  } finally {
    await context.close();
  }
}

function encodeWav(samples, sampleRate) {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;

  for (const sample of samples) {
    const clipped = Math.max(-1, Math.min(1, sample));
    const value = clipped < 0
      ? clipped * 0x8000
      : clipped * 0x7fff;

    view.setInt16(offset, value, true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function writeAscii(view, offset, text) {
  for (let index = 0; index < text.length; index++) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

function showEvaluation({
  item,
  whisper,
  pronunciation,
  finalScore,
  errors,
  mode
}) {
  const panel = $("evaluation-panel");
  const result = $("evaluation-result");
  result.replaceChildren();

  const addLine = text => {
    const div = document.createElement("div");
    div.className = "evaluation-line";
    div.textContent = text;
    result.appendChild(div);
  };

  if (whisper) {
    const recognized =
      normalizeWord(whisper.text) === normalizeWord(item.target_de);

    addLine(
      `Whisper: "${whisper.text}" — ` +
      (recognized ? "Zielwort erkannt" : "Zielwort nicht exakt erkannt")
    );
  } else {
    addLine("Whisper: keine verwertbare Transkription.");
  }

  if (pronunciation) {
    addLine(
      `${PRONUNCIATION_MODEL}: ` +
      (pronunciation.match
        ? "Aussprache akzeptiert"
        : "Aussprache nicht akzeptiert")
    );

    if (pronunciation.ipa) {
      addLine(`Erkannte Lautfolge: ${pronunciation.ipa}`);
    }

    if (pronunciation.usage) {
      addLine(
        `Tokens: ${pronunciation.usage.prompt_tokens ?? "—"} Input / ` +
        `${pronunciation.usage.completion_tokens ?? "—"} Output`
      );
    }

    if (pronunciation.cost !== null) {
      addLine(
        `Modellkosten: ${Number(pronunciation.cost).toFixed(6)} USD`
      );
    }

    if (pronunciation.notice) {
      addLine(`NanoGPT-Hinweis: ${pronunciation.notice}`);
    }
  } else {
    addLine("Aussprachemodell: keine verwertbare Bewertung.");
  }

  if (finalScore !== null) {
    const scoreLine = document.createElement("div");
    scoreLine.className = "score";
    scoreLine.textContent = `Score: ${finalScore}`;
    result.appendChild(scoreLine);
  } else {
    addLine("Kein Score: technische Bewertung unvollständig.");
  }

  if (mode === "word_check") {
    addLine(
      finalScore === 1
        ? "Wort-Check bestanden."
        : "Wort-Check nicht bestanden; du kannst weiter üben."
    );
  }

  if (errors.length) {
    addLine(`Technische Hinweise: ${errors.join(" | ")}`);
  }

  panel.classList.remove("hidden");
}

function errorText(error) {
  if (!error) return "Unbekannter Fehler";
  return error.message || String(error);
}

async function getNextAttemptNumber(itemId, mode) {
  const { count, error } = await supabaseClient
    .from("learn_attempts")
    .select("id", { count: "exact", head: true })
    .eq("user_id", currentUser.id)
    .eq("item_id", itemId)
    .eq("mode", mode);

  if (error) {
    console.warn("Could not count previous attempts:", error);
    return 1;
  }

  return (count || 0) + 1;
}

async function uploadRecording(path, blob) {
  const { error } = await supabaseClient
    .storage
    .from(RECORDING_BUCKET)
    .upload(path, blob, {
      contentType: "audio/wav",
      upsert: false
    });

  if (error) throw error;
  return path;
}

async function callWhisper({ apiKey, model, wavBlob }) {
  const form = new FormData();
  form.append("model", model);
  form.append("file", wavBlob, "answer.wav");
  form.append("language", "de");
  form.append("response_format", "json");

  const response = await fetch(WHISPER_ENDPOINT, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "Accept": "application/json"
    },
    body: form
  });

  const requestId = response.headers.get("x-request-id");
  const bodyText = await response.text();

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}: ${bodyText.slice(0, 700)}`
    );
  }

  let data;

  try {
    data = JSON.parse(bodyText);
  } catch {
    throw new Error(
      `Whisper-Antwort war kein JSON: ${bodyText.slice(0, 500)}`
    );
  }

  const text = String(data.text || "").trim();

  if (!text) {
    throw new Error("Whisper lieferte kein Transkript.");
  }

  let cost = costFromHeaders(response.headers);
  if (cost === null) cost = costFromObject(data);
  if (cost === null) {
    cost = await lookupNanoCost(apiKey, requestId);
  }

  return {
    text,
    requestId,
    cost,
    usage: data.usage || null
  };
}

async function callPronunciationModel({ apiKey, item, wavBlob }) {
  const base64Audio = await blobToBase64(wavBlob);

  const prompt =
    "Analysiere das Audio in zwei Schritten. " +
    "1. Bestimme ausschließlich aus dem Audio die tatsächlich gesprochene " +
    "deutsche Lautfolge in breiter IPA-Notation. " +
    "2. Vergleiche sie mit einer akzeptablen Standardaussprache des " +
    "Referenztexts. Akzeptiere normale Akzentvariation, aber nicht deutlich " +
    "falsche, ausgelassene oder hinzugefügte Laute. " +
    "Antworte ausschließlich als JSON mit den Feldern ipa und match, " +
    "ohne Markdown oder Erklärung. " +
    `Referenztext: ${item.target_de}`;

  const response = await fetch(PRONUNCIATION_ENDPOINT, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify({
      model: PRONUNCIATION_MODEL,
      stream: false,
      reasoning_effort: "low",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            {
              type: "input_audio",
              input_audio: {
                data: base64Audio,
                format: "wav"
              }
            }
          ]
        }
      ]
    })
  });

  const requestId = response.headers.get("x-request-id");
  const bodyText = await response.text();

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}: ${bodyText.slice(0, 700)}`
    );
  }

  let data;

  try {
    data = JSON.parse(bodyText);
  } catch {
    throw new Error(
      `Aussprachemodell lieferte kein JSON: ${bodyText.slice(0, 500)}`
    );
  }

  let content = data.choices?.[0]?.message?.content;

  if (Array.isArray(content)) {
    content = content
      .filter(part => typeof part?.text === "string")
      .map(part => part.text)
      .join("");
  }

  content = String(content || "").trim();

  const jsonMatch = content.match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    const notice = data.x_nanogpt_notice
      ? ` NanoGPT-Hinweis: ${data.x_nanogpt_notice}`
      : "";

    throw new Error(
      `Kein JSON in der Ausspracheantwort gefunden: ` +
      `${content.slice(0, 500)}.${notice}`
    );
  }

  let result;

  try {
    result = JSON.parse(jsonMatch[0]);
  } catch {
    throw new Error(
      `Ungültiges Aussprache-JSON: ${jsonMatch[0].slice(0, 500)}`
    );
  }

  if (typeof result.match !== "boolean") {
    throw new Error("Antwort enthält kein boolesches Feld 'match'.");
  }

  let cost = costFromHeaders(response.headers);
  if (cost === null) cost = costFromObject(data);
  if (cost === null) {
    cost = await lookupNanoCost(apiKey, requestId);
  }

  return {
    ipa: String(result.ipa || ""),
    match: result.match,
    requestId,
    cost,
    usage: data.usage || null,
    notice: data.x_nanogpt_notice || null
  };
}

async function blobToBase64(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

async function convertBlobToWav(blob) {
  const AudioContextClass =
    window.AudioContext || window.webkitAudioContext;

  if (!AudioContextClass) {
    throw new Error("Web Audio API ist nicht verfügbar.");
  }

  const context = new AudioContextClass();

  try {
    const inputBuffer = await context.decodeAudioData(
      await blob.arrayBuffer()
    );

    const targetRate = 16000;
    const ratio = inputBuffer.sampleRate / targetRate;
    const outputLength = Math.ceil(inputBuffer.length / ratio);
    const mono = new Float32Array(outputLength);

    for (
      let channel = 0;
      channel < inputBuffer.numberOfChannels;
      channel++
    ) {
      const source = inputBuffer.getChannelData(channel);

      for (let index = 0; index < outputLength; index++) {
        const sourcePosition = index * ratio;
        const left = Math.floor(sourcePosition);
        const right = Math.min(left + 1, source.length - 1);
        const fraction = sourcePosition - left;
        const sample =
          source[left] * (1 - fraction) +
          source[right] * fraction;

        mono[index] += sample / inputBuffer.numberOfChannels;
      }
    }

    return encodeWav(mono, targetRate);
  } finally {
    await context.close();
  }
}

function encodeWav(samples, sampleRate) {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;

  for (const sample of samples) {
    const clipped = Math.max(-1, Math.min(1, sample));
    const value = clipped < 0
      ? clipped * 0x8000
      : clipped * 0x7fff;

    view.setInt16(offset, value, true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function writeAscii(view, offset, text) {
  for (let index = 0; index < text.length; index++) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

function showEvaluation({
  item,
  whisper,
  pronunciation,
  finalScore,
  errors,
  mode
}) {
  const panel = $("evaluation-panel");
  const result = $("evaluation-result");
  result.replaceChildren();

  const addLine = text => {
    const div = document.createElement("div");
    div.className = "evaluation-line";
    div.textContent = text;
    result.appendChild(div);
  };

  if (whisper) {
    const recognized =
      normalizeWord(whisper.text) === normalizeWord(item.target_de);

    addLine(
      `Whisper: "${whisper.text}" — ` +
      (recognized ? "Zielwort erkannt" : "Zielwort nicht exakt erkannt")
    );
  } else {
    addLine("Whisper: keine verwertbare Transkription.");
  }

  if (pronunciation) {
    addLine(
      `${PRONUNCIATION_MODEL}: ` +
      (pronunciation.match
        ? "Aussprache akzeptiert"
        : "Aussprache nicht akzeptiert")
    );

    if (pronunciation.ipa) {
      addLine(`Erkannte Lautfolge: ${pronunciation.ipa}`);
    }

    if (pronunciation.usage) {
      addLine(
        `Tokens: ${pronunciation.usage.prompt_tokens ?? "—"} Input / ` +
        `${pronunciation.usage.completion_tokens ?? "—"} Output`
      );
    }

    if (pronunciation.cost !== null) {
      addLine(
        `Modellkosten: ${Number(pronunciation.cost).toFixed(6)} USD`
      );
    }

    if (pronunciation.notice) {
      addLine(`NanoGPT-Hinweis: ${pronunciation.notice}`);
    }
  } else {
    addLine("Aussprachemodell: keine verwertbare Bewertung.");
  }

  if (finalScore !== null) {
    const scoreLine = document.createElement("div");
    scoreLine.className = "score";
    scoreLine.textContent = `Score: ${finalScore}`;
    result.appendChild(scoreLine);
  } else {
    addLine("Kein Score: technische Bewertung unvollständig.");
  }

  if (mode === "word_check") {
    addLine(
      finalScore === 1
        ? "Wort-Check bestanden."
        : "Wort-Check nicht bestanden; du kannst weiter üben."
    );
  }

  if (errors.length) {
    addLine(`Technische Hinweise: ${errors.join(" | ")}`);
  }

  panel.classList.remove("hidden");
}

$("login-form").addEventListener("submit", async event => {
  event.preventDefault();
  $("login-message").textContent = "Anmeldung wird geprüft …";

  currentApiKey = null;

  let parsed;

  try {
    parsed = parseLoginString($("access-code").value);
  } catch (error) {
    $("login-message").textContent =
      error.message || "Ungültiger Login-String.";
    return;
  }

  const { accessCode, apiKey } = parsed;

  const { data, error } = await supabaseClient.auth
    .signInWithPassword({
      email: `${accessCode}@malagasy.local`,
      password: accessCode
    });

  if (error) {
    console.error(error);
    $("login-message").textContent = "Diso ny kaody fidirana.";
    return;
  }

  currentApiKey = apiKey;

  try {
    await enterApp(data.user);
    $("login-message").textContent = "";
  } catch (profileError) {
    console.error(profileError);
    currentApiKey = null;
    await supabaseClient.auth.signOut();
    $("login-message").textContent =
      profileError.message || "Profil konnte nicht geladen werden.";
  }
});

$("lesson-select").addEventListener("change", async event => {
  await loadItems(event.target.value);
});

$("reveal-button").addEventListener("click", revealTranslation);
$("play-audio-button").addEventListener("click", playTts);
$("record-button").addEventListener("click", startPracticeRecording);
$("word-check-button").addEventListener("click", startWordCheck);
$("stop-button").addEventListener("click", stopRecordingManually);

$("repeat-button").addEventListener("click", async () => {
  const item = currentItem();
  if (!item || isBusy || mediaRecorder) return;

  await logEvent("item_repeated", item, { index: currentIndex });
  renderItem();
});

$("skip-button").addEventListener("click", async () => {
  if (!items.length || isBusy || mediaRecorder) return;

  const item = currentItem();

  if (item) {
    await logEvent("item_skipped", item, { index: currentIndex });
  }

  currentIndex = (currentIndex + 1) % items.length;
  renderItem();
});

$("logout-button").addEventListener("click", async () => {
  currentApiKey = null;
  await supabaseClient.auth.signOut();
  location.reload();
});

async function restoreSession() {
  const { data, error } = await supabaseClient.auth.getSession();

  if (error) {
    console.error(error);
    return;
  }

  if (!data.session?.user) return;

  try {
    await enterApp(data.session.user);
  } catch (profileError) {
    console.error(profileError);
    await supabaseClient.auth.signOut();
  }
}

restoreSession();
