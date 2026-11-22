"use strict";

const SUPABASE_URL =
  "https://coaiznrxtpdqatvfbsyi.supabase.co";

const SUPABASE_KEY =
  "sb_publishable_D0adyb95if5W2IH5WA9JOQ_ENePqpoh";

const NANO_API_BASE = "https://api.nano-gpt.com/api/v1";
const PRONUNCIATION_ENDPOINT = `${NANO_API_BASE}/chat/completions`;

const PRONUNCIATION_MODEL = "google/gemini-4-carbon";

const RECORDING_BUCKET = "learn-recordings";
const TTS_BUCKET = "learn-tts";

const PRACTICE_RECORDING_LIMIT_MS = 20_000;
const WORD_CHECK_LIMIT_MS = 2_000;
const TEST_RECORDING_LIMIT_MS = 2_000;
const RECORDING_CHUNK_MS = 100;
const RECORDING_CHUNK_GRACE_MS = 250;
const REQUIRED_SUCCESSES_PER_WORD = 3;
const MAX_TEST_STARTS = 5;

const AUDIO_SAMPLE_RATE = 16000;
const SILENCE_WINDOW_MS = 20;
const SILENCE_PADDING_MS = 120;
const ABSOLUTE_SPEECH_THRESHOLD = 0.004;
const RELATIVE_SPEECH_THRESHOLD = 0.08;

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
let recordingStartedMonotonic = null;
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

let testRunState = null;
let testEligibility = {
  starts: 0,
  completed: false,
  loadFailed: false
};

const $ = id => document.getElementById(id);

function showMessage(text, isError = false) {
  const element = $("app-message");
  element.textContent = text;
  element.style.color = isError ? "#a12626" : "#236b37";
}

function currentItem() {
  if (testRunState?.active) {
    return testRunState.queue[testRunState.index] || null;
  }

  return items[currentIndex] || null;
}

function setBusy(value) {
  isBusy = value;

  $("lesson-select").disabled =
    value || Boolean(testRunState?.active);

  $("reveal-button").disabled = value;
  $("play-audio-button").disabled = value;
  $("record-button").disabled = value;
  $("repeat-button").disabled = value;
  $("skip-button").disabled = value;

  updateWordCheckButton();
  renderTestControls();
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
      test_run_id: payload.testRunId || null,
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
  if (testRunState?.active) {
    showMessage("Während eines Lektionstests kann die Lektion nicht gewechselt werden.");
    return;
  }

  showMessage("Loading lesson...");

  const { data, error } = await supabaseClient
    .from("learn_learner_items")
    .select(
      "id, lesson_id, order_index, prompt_mg, target_de, " +
      "tts_audio_path, max_reward_eur"
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
  testRunState = null;

  const lesson = lessons.find(value => value.id === lessonId);
  $("lesson-title").textContent = lesson?.title || "";

  await loadLearnerProgress();
  await loadTestEligibility(lessonId);

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
  if (items.length === 0) return 0;

  return Math.max(
    1,
    items.length - Math.ceil(items.length * 0.1)
  );
}

function getPreparedWordCount() {
  return items.filter(item =>
    (practiceSuccessCounts.get(item.id) || 0) >=
    REQUIRED_SUCCESSES_PER_WORD
  ).length;
}

async function loadTestEligibility(lessonId) {
  testEligibility = {
    starts: 0,
    completed: false,
    loadFailed: false
  };

  if (!currentUser || !lessonId) {
    renderTestControls();
    return;
  }

  const { data, error } = await supabaseClient
    .from("learn_test_runs")
    .select("id, status, voided_at")
    .eq("user_id", currentUser.id)
    .eq("lesson_id", lessonId)
    .order("started_at", { ascending: false })
    .limit(100);

  if (error) {
    console.error("Could not load test runs:", error);
    testEligibility.loadFailed = true;
    renderTestControls();
    return;
  }

  const runs = data || [];

  // Nach einem Reload wird ein offener Test als abgebrochen gezählt.
  for (const run of runs) {
    if (run.status !== "in_progress") continue;

    const { error: updateError } = await supabaseClient
      .from("learn_test_runs")
      .update({
        status: "abandoned",
        completed_at: new Date().toISOString()
      })
      .eq("id", run.id)
      .eq("user_id", currentUser.id);

    if (updateError) {
      console.error("Could not abandon interrupted test:", updateError);
    } else {
      run.status = "abandoned";
    }
  }

  testEligibility.starts = runs.length;
  testEligibility.completed = runs.some(
    run => run.status === "completed" && !run.voided_at
  );

  renderTestControls();
}

function formatTestReward(value) {
  return new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4
  }).format(Number(value) || 0);
}

function renderTestControls() {
  const startButton = $("test-start-button");
  const status = $("test-status");
  const abandonButton = $("test-abandon-button");
  const reward = $("test-provisional-reward");

  if (!startButton || !status || !abandonButton || !reward) return;

  const active = Boolean(testRunState?.active);
  abandonButton.classList.toggle("hidden", !active);

  if (active) {
    const total = testRunState.queue.length;
    const completed = testRunState.index;

    status.textContent =
      `Test läuft: ${completed} von ${total} Wörtern beantwortet.`;

    reward.textContent =
      `Vorläufiger Betrag: ${formatTestReward(testRunState.reward)}`;
    reward.classList.remove("hidden");
    startButton.disabled = true;
    return;
  }

  reward.classList.add("hidden");

  if (testEligibility.loadFailed) {
    status.textContent =
      "Teststatus konnte nicht geladen werden. Bitte Seite neu laden.";
    startButton.disabled = true;
  } else if (testEligibility.completed) {
    status.textContent = "Dieser Lektionstest wurde bereits abgeschlossen.";
    startButton.disabled = true;
  } else if (testEligibility.starts >= MAX_TEST_STARTS) {
    status.textContent =
      `Das Startlimit von ${MAX_TEST_STARTS} Tests wurde erreicht.`;
    startButton.disabled = true;
  } else {
    const required = getRequiredPreparedWords();
    const prepared = getPreparedWordCount();

    if (prepared < required) {
      status.textContent =
        `Freischaltung: ${prepared} von ${required} ausreichend vorbereiteten ` +
        "Wörtern. Jedes Wort braucht drei hilfefreie Übungserfolge.";
      startButton.disabled = true;
    } else {
      status.textContent =
        `Freigeschaltet. Verfügbare Starts: ` +
        `${MAX_TEST_STARTS - testEligibility.starts} von ${MAX_TEST_STARTS}.`;
      startButton.disabled = isBusy;
    }
  }
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
      "Voraussetzung für den Lektionstest erfüllt.";
  } else {
    $("test-unlock-status").textContent =
      `Für einen Wort-Check brauchst du drei Übungserfolge mit Score 1 ` +
      `ohne Übersetzung oder TTS. Für den Lektionstest: ` +
      `${prepared} von ${required} Wörtern ausreichend geübt.`;
  }

  renderCurrentWordStatus();
  updateWordCheckButton();
  renderTestControls();
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
  const button = $("word-check-button");
  if (!button) return;

  const item = currentItem();

  if (!item) {
    button.disabled = true;
    return;
  }

  const successes = practiceSuccessCounts.get(item.id) || 0;

  button.disabled =
    isBusy ||
    Boolean(testRunState?.active) ||
    successes < REQUIRED_SUCCESSES_PER_WORD ||
    passedWordChecks.has(item.id);
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

  if (testRunState?.active) {
    $("item-position").textContent =
      `Testwort ${testRunState.index + 1} / ${testRunState.queue.length}`;

    $("reveal-button").classList.add("hidden");
    $("translation").classList.add("hidden");
    $("play-audio-button").classList.add("hidden");
    $("tts-player").classList.add("hidden");
    $("word-check-button").classList.add("hidden");
    $("repeat-button").classList.add("hidden");
    $("skip-button").classList.add("hidden");

    $("record-button").textContent = "Testantwort aufnehmen";
    $("record-button").classList.remove("hidden");
    $("lesson-select").disabled = true;
  } else {
    $("item-position").textContent =
      `Teny ${currentIndex + 1} / ${items.length}`;

    $("reveal-button").classList.remove("hidden");
    $("play-audio-button").classList.remove("hidden");
    $("word-check-button").classList.remove("hidden");
    $("repeat-button").classList.remove("hidden");
    $("skip-button").classList.remove("hidden");

    $("record-button").textContent = "Aufnahme mit Bewertung";
    $("lesson-select").disabled = isBusy;

    $("reveal-button").disabled = isBusy;
    $("play-audio-button").disabled =
      isBusy || !item.tts_audio_path;
    $("record-button").disabled = isBusy;
    $("repeat-button").disabled = isBusy;
    $("skip-button").disabled = isBusy;
  }

  renderProgress();
  logEvent("item_shown", item, { index: currentIndex });
  showMessage("");
}

function revealTranslation() {
  const item = currentItem();
  if (!item || testRunState?.active || recordingMode === "word_check") return;

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

  if (testRunState?.active || recordingMode === "word_check") return;

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

function getRecordingLimitMs(mode) {
  if (mode === "word_check") return WORD_CHECK_LIMIT_MS;
  if (mode === "test") return TEST_RECORDING_LIMIT_MS;
  if (mode === "practice") return PRACTICE_RECORDING_LIMIT_MS;
  return null;
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
  const recorder = new MediaRecorder(
    stream,
    mimeType ? { mimeType } : undefined
  );

  mediaRecorder = recorder;
  recordingStream = stream;
  recordingChunks = [];
  recordingMode = mode;
  recordingItem = item;
  recordingStartedAt = null;
  recordingStartedMonotonic = null;
  manualStop = false;

  recorder.addEventListener(
    "start",
    () => {
      recordingStartedAt = Date.now();
      recordingStartedMonotonic = performance.now();
    },
    { once: true }
  );

  recorder.addEventListener("dataavailable", event => {
    if (!event.data?.size) return;

    const limitMs = getRecordingLimitMs(recordingMode);
    const elapsedMs = recordingStartedMonotonic === null
      ? 0
      : performance.now() - recordingStartedMonotonic;

    if (
      limitMs === null ||
      elapsedMs <= limitMs + RECORDING_CHUNK_GRACE_MS
    ) {
      recordingChunks.push(event.data);
      return;
    }

    if (recorder.state === "recording") {
      manualStop = false;
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

        recordingChunks = [];
        mediaRecorder = null;
        recordingMode = null;
        recordingItem = null;
        recordingStartedAt = null;
        recordingStartedMonotonic = null;

        resetRecordingUi();
        setBusy(false);
        updateWordCheckButton();

        if (testRunState?.active) {
          await abandonLessonTest(
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

async function startPracticeRecording() {
  if (!currentApiKey) {
    showMessage("Bitte abmelden und erneut anmelden.", true);
    return;
  }

  const item = currentItem();
  if (!item || isBusy || testRunState?.active) return;

  try {
    setBusy(true);
    showMessage(
      "Mikrofon wird vorbereitet … Die Aufnahme endet spätestens nach 20 Sekunden."
    );

    const stream = await requestAudioStream();
    configureRecorder(stream, "practice", item);

    mediaRecorder.addEventListener(
      "start",
      () => onPracticeRecorderStarted(item),
      { once: true }
    );

    mediaRecorder.start(RECORDING_CHUNK_MS);
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
    "Aufnahme läuft. Tippe auf „Fertig“; automatisch endet sie nach 20 Sekunden."
  );

  logEvent("recording_started", item, {
    mode: "practice",
    timeLimitMs: PRACTICE_RECORDING_LIMIT_MS
  });

  recordingDeadlineTimer = window.setTimeout(() => {
    if (mediaRecorder?.state === "recording") {
      manualStop = false;
      mediaRecorder.stop();
    }
  }, PRACTICE_RECORDING_LIMIT_MS);
}

async function startWordCheck() {
  if (!currentApiKey) {
    showMessage("Bitte abmelden und erneut anmelden.", true);
    return;
  }

  const item = currentItem();
  const successes = item
    ? practiceSuccessCounts.get(item.id) || 0
    : 0;

  if (!item || isBusy || mediaRecorder || testRunState?.active) return;

  if (successes < REQUIRED_SUCCESSES_PER_WORD) {
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

    mediaRecorder.start(RECORDING_CHUNK_MS);
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

  startCountdownTimer();

  recordingDeadlineTimer = window.setTimeout(() => {
    if (mediaRecorder?.state === "recording") {
      manualStop = false;
      mediaRecorder.stop();
    }
  }, WORD_CHECK_LIMIT_MS);
}

function onTestRecorderStarted(item) {
  promptShownAt = Date.now();
  wordCheckStartedAt = performance.now();
  wordCheckDeadline = wordCheckStartedAt + TEST_RECORDING_LIMIT_MS;

  $("timer-panel").classList.remove("hidden");
  $("timer-countdown").textContent =
    (TEST_RECORDING_LIMIT_MS / 1000).toFixed(1);
  $("timer-label").textContent =
    `Testwort ${testRunState.index + 1} von ${testRunState.queue.length}`;
  $("timer-help").textContent =
    "Sprich das deutsche Wort. Die Aufnahme endet nach 2 Sekunden.";

  $("record-button").classList.add("hidden");
  $("stop-button").classList.remove("hidden");
  $("stop-button").disabled = false;

  showMessage("Testaufnahme läuft …");

  logEvent("recording_started", item, {
    mode: "test",
    testRunId: testRunState.id,
    timeLimitMs: TEST_RECORDING_LIMIT_MS
  });

  startCountdownTimer();

  recordingDeadlineTimer = window.setTimeout(() => {
    if (mediaRecorder?.state === "recording") {
      manualStop = false;
      mediaRecorder.stop();
    }
  }, TEST_RECORDING_LIMIT_MS);
}

function startCountdownTimer() {
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
}

async function startTestRecording() {
  if (!currentApiKey) {
    showMessage("Bitte abmelden und erneut anmelden.", true);
    return;
  }

  if (!testRunState?.active || isBusy || mediaRecorder) return;

  const item = currentItem();
  if (!item) return;

  try {
    setBusy(true);
    showMessage("Mikrofon wird vorbereitet …");

    const stream = await requestAudioStream();
    configureRecorder(stream, "test", item);

    mediaRecorder.addEventListener(
      "start",
      () => onTestRecorderStarted(item),
      { once: true }
    );

    mediaRecorder.start(RECORDING_CHUNK_MS);
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

  if (testRunState?.active) {
    $("word-check-button").classList.add("hidden");
    $("reveal-button").classList.add("hidden");
    $("play-audio-button").classList.add("hidden");
    $("repeat-button").classList.add("hidden");
    $("skip-button").classList.add("hidden");
    $("record-button").textContent = "Testantwort aufnehmen";
  } else {
    $("word-check-button").classList.remove("hidden");
    $("reveal-button").classList.remove("hidden");
    $("play-audio-button").classList.remove("hidden");
    $("repeat-button").classList.remove("hidden");
    $("skip-button").classList.remove("hidden");
    $("record-button").textContent = "Aufnahme mit Bewertung";
  }

  $("timer-panel").classList.add("hidden");
}

async function finishRecording() {
  clearRecordingTimers();
  showMessage("Aufnahme beendet. Audio wird vorbereitet …");
  stopMediaTracks();

  const mode = recordingMode;
  const item = recordingItem;
  const startedAt = recordingStartedAt;
  const promptTime = promptShownAt;
  const timeLimitMs = getRecordingLimitMs(mode);
  const testRunId = mode === "test"
    ? testRunState?.id || null
    : null;

  const endReason = manualStop ? "manual" : "deadline";

  let durationMs = recordingStartedMonotonic === null
    ? 0
    : Math.max(
        0,
        performance.now() - recordingStartedMonotonic
      );

  if (timeLimitMs !== null) {
    durationMs = Math.min(timeLimitMs, durationMs);
  }

  if (
    (mode === "word_check" || mode === "test") &&
    wordCheckStartedAt !== null
  ) {
    durationMs = Math.min(
      timeLimitMs,
      Math.max(0, performance.now() - wordCheckStartedAt)
    );
  }

  if (!item || !mediaRecorder) {
    resetRecordingUi();
    setBusy(false);
    return;
  }

  const sourceBlob = new Blob(recordingChunks, {
    type: mediaRecorder.mimeType || "audio/webm"
  });

  recordingChunks = [];
  mediaRecorder = null;
  recordingMode = null;
  recordingItem = null;
  recordingStartedAt = null;
  recordingStartedMonotonic = null;

  if (mode === "word_check" || mode === "test") {
    $("timer-label").textContent = "Aufnahme beendet";
    $("timer-countdown").textContent =
      (durationMs / 1000).toFixed(1);
    $("timer-help").textContent = "Die Antwort wird jetzt bewertet.";
  }

  if (!sourceBlob.size) {
    resetRecordingUi();
    setBusy(false);
    updateWordCheckButton();

    if (mode === "test") {
      await abandonLessonTest(
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

async function startLessonTest() {
  if (isBusy || testRunState?.active) return;

  if (!currentApiKey) {
    showMessage("Bitte abmelden und erneut anmelden.", true);
    return;
  }

  const lessonId = $("lesson-select").value;

  await loadTestEligibility(lessonId);

  if (
    testEligibility.loadFailed ||
    testEligibility.completed ||
    testEligibility.starts >= MAX_TEST_STARTS ||
    getPreparedWordCount() < getRequiredPreparedWords()
  ) {
    renderTestControls();
    return;
  }

  if (
    !items.length ||
    items.some(item => item.max_reward_eur == null)
  ) {
    showMessage(
      "Test konnte nicht gestartet werden. Wortbeträge fehlen; " +
      "prüfe die View learn_learner_items.",
      true
    );
    return;
  }

  setBusy(true);
  showMessage("Lektionstest wird gestartet …");

  const { data, error } = await supabaseClient
    .from("learn_test_runs")
    .insert({
      user_id: currentUser.id,
      lesson_id: lessonId,
      status: "in_progress"
    })
    .select("id")
    .single();

  if (error) {
    console.error("Could not start test:", error);
    setBusy(false);
    showMessage(
      "Test konnte nicht gestartet werden: " + error.message,
      true
    );
    return;
  }

  testEligibility.starts += 1;
  testRunState = {
    id: data.id,
    lessonId,
    queue: shuffleItems(items),
    index: 0,
    scoreSum: 0,
    reward: 0,
    active: true
  };

  currentIndex = items.findIndex(
    item => item.id === testRunState.queue[0].id
  );

  await logEvent("test_started", null, {
    lessonId,
    testRunId: data.id,
    itemCount: items.length,
    startNumber: testEligibility.starts
  });

  setBusy(false);
  renderItem();
  renderTestControls();
  showMessage(
    "Der Test läuft. Tippe auf „Testantwort aufnehmen“, " +
    "um das angezeigte Wort zu beantworten."
  );
}

function shuffleItems(source) {
  const shuffled = [...source];

  for (let index = shuffled.length - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[other]] =
      [shuffled[other], shuffled[index]];
  }

  return shuffled;
}

async function abandonLessonTest(message) {
  if (!testRunState?.active) return;

  const runId = testRunState.id;
  const lessonId = testRunState.lessonId;

  const { error } = await supabaseClient
    .from("learn_test_runs")
    .update({
      status: "abandoned",
      completed_at: new Date().toISOString(),
      final_score: null,
      final_reward_eur: null
    })
    .eq("id", runId)
    .eq("user_id", currentUser.id);

  if (error) {
    console.error("Could not abandon test:", error);
  }

  await logEvent("test_abandoned", null, {
    lessonId,
    testRunId: runId,
    reason: message
  });

  testRunState = null;
  setBusy(false);
  await loadTestEligibility(lessonId);
  renderItem();
  showMessage(message, Boolean(error));
}

async function advanceLessonTest(score, expectedRunId) {
  if (
    !testRunState?.active ||
    testRunState.id !== expectedRunId
  ) {
    return;
  }

  const answeredItem = currentItem();
  const run = testRunState;
  const numericScore = Number(score);

  if (![0, 0.75, 1].includes(numericScore)) {
    await abandonLessonTest(
      "Ungültiger Testscore. Der Test wurde ohne Auszahlung abgebrochen."
    );
    return;
  }

  run.scoreSum += numericScore;
  run.reward +=
    (Number(answeredItem.max_reward_eur) || 0) * numericScore;
  run.index += 1;

  if (run.index < run.queue.length) {
    currentIndex = items.findIndex(
      item => item.id === run.queue[run.index].id
    );

    renderItem();
    renderTestControls();
    showMessage(
      `Antwort gespeichert. ${run.index} von ${run.queue.length} Wörtern ` +
      `bearbeitet. Vorläufig: ${formatTestReward(run.reward)}`
    );
    return;
  }

  const finalScore = run.scoreSum / run.queue.length;
  const finalReward = Number(run.reward.toFixed(4));

  const { error } = await supabaseClient
    .from("learn_test_runs")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
      final_score: finalScore,
      final_reward_eur: finalReward
    })
    .eq("id", run.id)
    .eq("user_id", currentUser.id);

  if (error) {
    console.error("Could not complete test:", error);
    await abandonLessonTest(
      "Der Test konnte nicht sicher gespeichert werden. " +
      "Es wurde kein Betrag gutgeschrieben."
    );
    return;
  }

  const completedRunId = run.id;
  const lessonId = run.lessonId;

  await logEvent("test_completed", null, {
    lessonId,
    testRunId: completedRunId,
    finalScore,
    finalReward
  });

  testRunState = null;
  await loadTestEligibility(lessonId);
  renderItem();

  showMessage(
    `Lektionstest abgeschlossen. Endscore: ${finalScore.toFixed(2)}. ` +
    `Vorläufiger Betrag: ${formatTestReward(finalReward)}. ` +
    "Die Auszahlung wird später manuell geprüft."
  );
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
    resetRecordingUi();
    setBusy(false);

    if (mode === "test") {
      await abandonLessonTest(
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

    if (mode === "test") {
      await abandonLessonTest(
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
    `${currentUser.id}/${item.lesson_id}/${item.id}/${attemptId}.wav`;

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

    resetRecordingUi();
    setBusy(false);
    updateWordCheckButton();

    if (mode === "test") {
      if (!saveResult.ok) {
        await abandonLessonTest(
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

      await advanceLessonTest(0, testRunId);
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
        apiKey: currentApiKey,
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
    user_id: currentUser.id,
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
      : usedTranslationForCurrentItem,
    used_tts_audio: isRestrictedMode
      ? false
      : usedAudioForCurrentItem,
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
  } = await supabaseClient
    .from("learn_attempts")
    .insert(attemptRow)
    .select("id")
    .single();

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

    resetRecordingUi();
    setBusy(false);

    if (
      attemptInsertError ||
      !pronunciationSucceeded ||
      !uploadSucceeded ||
      evaluationStatus !== "complete" ||
      finalScore === null
    ) {
      await abandonLessonTest(
        "Technisches Problem bei der Testbewertung oder Speicherung. " +
        "Der Test wurde ohne Auszahlung abgebrochen."
      );
      return;
    }

    await advanceLessonTest(finalScore, testRunId);
    return;
  }

  await loadLearnerProgress();

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

  const { error: insertError } = await supabaseClient
    .from("learn_attempts")
    .insert({
      client_attempt_id: attemptId,
      user_id: currentUser.id,
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
        : usedTranslationForCurrentItem,
      used_tts_audio: isRestrictedMode
        ? false
        : usedAudioForCurrentItem,
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

async function convertBlobToWav(blob) {
  const AudioContextClass =
    window.AudioContext || window.webkitAudioContext;

  if (!AudioContextClass) {
    throw new Error("Web Audio API ist nicht verfügbar.");
  }

  const context = new AudioContextClass();

  try {
    const input = await context.decodeAudioData(
      await blob.arrayBuffer()
    );

    const outputRate = AUDIO_SAMPLE_RATE;
    const ratio = input.sampleRate / outputRate;
    const outputLength = Math.max(
      1,
      Math.ceil(input.length / ratio)
    );

    const mono = new Float32Array(outputLength);

    for (let channel = 0; channel < input.numberOfChannels; channel++) {
      const source = input.getChannelData(channel);

      for (let index = 0; index < outputLength; index++) {
        const sourcePosition = index * ratio;
        const left = Math.min(
          Math.floor(sourcePosition),
          source.length - 1
        );
        const right = Math.min(left + 1, source.length - 1);
        const fraction = sourcePosition - left;

        const sample =
          source[left] * (1 - fraction) +
          source[right] * fraction;

        mono[index] += sample / input.numberOfChannels;
      }
    }

    return encodeWav(mono, outputRate);
  } finally {
    await context.close();
  }
}

async function trimSilenceFromWav(wavBlob) {
  const AudioContextClass =
    window.AudioContext || window.webkitAudioContext;

  if (!AudioContextClass) {
    throw new Error("Web Audio API ist nicht verfügbar.");
  }

  const context = new AudioContextClass();

  try {
    const decoded = await context.decodeAudioData(
      await wavBlob.arrayBuffer()
    );

    const sampleRate = decoded.sampleRate;
    const samples = decoded.getChannelData(0);

    const windowSize = Math.max(
      1,
      Math.round(sampleRate * SILENCE_WINDOW_MS / 1000)
    );

    const windows = [];

    for (let start = 0; start < samples.length; start += windowSize) {
      const end = Math.min(start + windowSize, samples.length);
      let sumSquares = 0;

      for (let index = start; index < end; index++) {
        sumSquares += samples[index] * samples[index];
      }

      windows.push({
        start,
        end,
        rms: Math.sqrt(sumSquares / Math.max(1, end - start))
      });
    }

    const peakRms = windows.reduce(
      (peak, window) => Math.max(peak, window.rms),
      0
    );

    const threshold = Math.max(
      ABSOLUTE_SPEECH_THRESHOLD,
      peakRms * RELATIVE_SPEECH_THRESHOLD
    );

    const activeWindows = windows.filter(
      window => window.rms >= threshold
    );

    const originalDurationMs =
      decoded.length / sampleRate * 1000;

    if (
      peakRms < ABSOLUTE_SPEECH_THRESHOLD ||
      activeWindows.length < 2
    ) {
      return {
        blob: wavBlob,
        hasSpeech: false,
        originalDurationMs,
        trimmedDurationMs: originalDurationMs,
        trimStartMs: 0,
        trimEndMs: 0,
        threshold
      };
    }

    const paddingSamples = Math.round(
      sampleRate * SILENCE_PADDING_MS / 1000
    );

    const startSample = Math.max(
      0,
      activeWindows[0].start - paddingSamples
    );

    const endSample = Math.min(
      decoded.length,
      activeWindows[activeWindows.length - 1].end + paddingSamples
    );

    const frameCount = endSample - startSample;

    if (frameCount <= 0) {
      return {
        blob: wavBlob,
        hasSpeech: false,
        originalDurationMs,
        trimmedDurationMs: originalDurationMs,
        trimStartMs: 0,
        trimEndMs: 0,
        threshold
      };
    }

    const monoOutput = new Float32Array(frameCount);
    monoOutput.set(
      decoded.getChannelData(0).slice(startSample, endSample)
    );

    const trimmedBlob = encodeWav(monoOutput, sampleRate);

    return {
      blob: trimmedBlob,
      hasSpeech: true,
      originalDurationMs,
      trimmedDurationMs: frameCount / sampleRate * 1000,
      trimStartMs: startSample / sampleRate * 1000,
      trimEndMs: (decoded.length - endSample) / sampleRate * 1000,
      threshold
    };
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

async function callPronunciationModel({ apiKey, item, wavBlob }) {
  const base64Audio = await blobToBase64(wavBlob);

  const prompt =
    "Analysiere das deutsche Audio. " +
    "Schritt 1: Transkribiere nur tatsächlich hörbare deutsche Wörter " +
    "und bestimme die gehörte Lautfolge in breiter IPA-Notation. " +
    "Verwende den Referenztext für diese beiden Felder nicht. " +
    "Wenn keine verständliche Sprache zu hören ist, gib für heard_text " +
    "und ipa leere Strings zurück. " +
    "Schritt 2: Vergleiche die gehörte Aussprache mit einer akzeptablen " +
    "Standardaussprache des Referenztexts. Akzeptiere normale " +
    "Akzentvariation, aber nicht deutlich falsche, ausgelassene oder " +
    "hinzugefügte Laute. " +
    "Antworte ausschließlich als JSON mit den Feldern heard_text, ipa " +
    "und pronunciation_match. Keine Erklärung und kein Markdown. " +
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
      `Carbon-Antwort war kein JSON: ${bodyText.slice(0, 500)}`
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
      `Kein JSON in der Carbon-Antwort gefunden: ` +
      `${content.slice(0, 500)}.${notice}`
    );
  }

  let result;

  try {
    result = JSON.parse(jsonMatch[0]);
  } catch {
    throw new Error(
      `Ungültiges Carbon-JSON: ${jsonMatch[0].slice(0, 500)}`
    );
  }

  if (typeof result.heard_text !== "string") {
    throw new Error(
      "Carbon-Antwort enthält kein Textfeld 'heard_text'."
    );
  }

  if (typeof result.ipa !== "string") {
    throw new Error(
      "Carbon-Antwort enthält kein Textfeld 'ipa'."
    );
  }

  if (typeof result.pronunciation_match !== "boolean") {
    throw new Error(
      "Carbon-Antwort enthält kein boolesches Feld " +
      "'pronunciation_match'."
    );
  }

  let cost = costFromHeaders(response.headers);

  if (cost === null) {
    cost = costFromObject(data);
  }

  if (cost === null) {
    cost = await lookupNanoCost(apiKey, requestId);
  }

  return {
    heardText: result.heard_text.trim(),
    ipa: result.ipa.trim(),
    match: result.pronunciation_match,
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

function showEvaluation({
  item,
  pronunciation,
  recognized,
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

  if (pronunciation) {
    addLine(
      `Carbon-Transkript: "${pronunciation.heardText || "(leer)"}" — ` +
      (recognized ? "Zielwort erkannt" : "Zielwort nicht exakt erkannt")
    );

    addLine(
      "Carbon-Aussprache: " +
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
    addLine("Carbon: keine verwertbare Bewertung.");
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

  if (mode === "test") {
    addLine("Lektionstest-Antwort wurde bewertet.");
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
  if (testRunState?.active) return;
  await loadItems(event.target.value);
});

$("reveal-button").addEventListener("click", revealTranslation);
$("play-audio-button").addEventListener("click", playTts);

$("record-button").addEventListener("click", () => {
  if (testRunState?.active) {
    startTestRecording();
  } else {
    startPracticeRecording();
  }
});

$("word-check-button").addEventListener("click", startWordCheck);
$("stop-button").addEventListener("click", stopRecordingManually);
$("test-start-button").addEventListener("click", startLessonTest);

$("test-abandon-button").addEventListener("click", async () => {
  if (!testRunState?.active || isBusy || mediaRecorder) return;

  const confirmed = window.confirm(
    "Test abbrechen? Die vorläufige Summe wird verworfen."
  );

  if (confirmed) {
    await abandonLessonTest(
      "Test abgebrochen. Die vorläufige Summe wurde verworfen."
    );
  }
});

$("repeat-button").addEventListener("click", async () => {
  const item = currentItem();
  if (!item || isBusy || mediaRecorder || testRunState?.active) return;

  await logEvent("item_repeated", item, { index: currentIndex });
  renderItem();
});

$("skip-button").addEventListener("click", async () => {
  if (!items.length || isBusy || mediaRecorder || testRunState?.active) return;

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
