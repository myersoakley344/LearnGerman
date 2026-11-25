"use strict";

const SUPABASE_URL = "https://coaiznrxtpdqatvfbsyi.supabase.co";
const SUPABASE_KEY = "sb_publishable_D0adyb95if5W2IH5WA9JOQ_ENePqpoh";

const NANO_API_BASE = "https://api.nano-gpt.com/api/v1";
const PRONUNCIATION_ENDPOINT = `${NANO_API_BASE}/chat/completions`;
const PRONUNCIATION_MODEL = "google/gemini-4-carbon";
const PRONUNCIATION_FALLBACK_MODEL = "google/gemini-4-hydrogen";

const RECORDING_BUCKET = "learn-recordings";
const TTS_BUCKET = "learn-tts";

const PRACTICE_RECORDING_LIMIT_MS = 20_000;
const WORD_CHECK_LIMIT_MS = 2_000;
const TEST_RECORDING_LIMIT_MS = 4_000;
const RECORDING_CHUNK_MS = 100;
const RECORDING_CHUNK_GRACE_MS = 250;
const MAX_TEST_STARTS = 5;
const LESSON_TARGET_ARIARY = 2500;

const AUDIO_SAMPLE_RATE = 16000;
const SILENCE_WINDOW_MS = 20;
const SILENCE_PADDING_MS = 120;
const ABSOLUTE_SPEECH_THRESHOLD = 0.004;
const RELATIVE_SPEECH_THRESHOLD = 0.08;

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

let currentUser = null;
let currentApiKey = null;
let lessons = [];
let items = [];
let currentIndex = 0;

let promptShownAt = null;
let usedTranslationForCurrentItem = false;
let usedAudioForCurrentItem = false;
let wordCheckArmed = false;

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

let passedWordChecks = new Set();
let lastRecordingUrl = null;
let completedAriaryByLesson = new Map();
let totalCompletedAriary = 0;

let testRunState = null;
let testEligibility = {
  starts: 0,
  completed: false,
  maxScoreReached: false,
  latestCompletedScore: null,
  latestCompletedAriary: 0,
  loadFailed: false
};

const $ = id => document.getElementById(id);

function showMessage(text, isError = false) {
  const el = $("app-message");
  el.textContent = text;
  el.style.color = isError ? "#a12626" : "#236b37";
}

function showAnalysisLoading(statusText) {
  $("analysis-modal").classList.remove("hidden");
  $("analysis-spinner").classList.remove("hidden");
  $("analysis-modal-title").textContent = "Mandeha ny fanombanana …";
  $("analysis-modal-status").textContent = statusText;
  $("analysis-modal-status").style.color = "#53616f";
  $("analysis-modal-result").replaceChildren();
  $("analysis-modal-close").classList.add("hidden");
}

function showAnalysisNotice(title, statusText, isError = false) {
  $("analysis-modal").classList.remove("hidden");
  $("analysis-spinner").classList.add("hidden");
  $("analysis-modal-title").textContent = title;
  $("analysis-modal-status").textContent = statusText;
  $("analysis-modal-status").style.color = isError ? "#a12626" : "#236b37";
  $("analysis-modal-result").replaceChildren();
  $("analysis-modal-close").classList.remove("hidden");
}

function hideAnalysisModal() {
  $("analysis-modal").classList.add("hidden");
}

function currentItem() {
  if (testRunState?.active) {
    return testRunState.queue[testRunState.index] || null;
  }
  return items[currentIndex] || null;
}

function getWordMaxAriary(wordCount) {
  if (!wordCount || wordCount <= 0) return 0;
  return Math.round(LESSON_TARGET_ARIARY / wordCount / 10) * 10;
}

function getWordEarnedAriary(wordCount, score) {
  const n = Number(score);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(getWordMaxAriary(wordCount) * n);
}

function formatAriary(amount) {
  const rounded = Math.round(Number(amount) || 0);
  return `${new Intl.NumberFormat("de-DE").format(rounded)} Ariary`;
}

function getDisplayedAriary() {
  if (testRunState?.active) {
    const prev = completedAriaryByLesson.get(testRunState.lessonId) || 0;
    return totalCompletedAriary - prev + testRunState.ariary;
  }
  return totalCompletedAriary;
}

function renderEarnedAriary() {
  const badge = $("earned-ariary");
  if (badge) {
    badge.textContent = `Vola azo: ${formatAriary(getDisplayedAriary())}`;
  }
}

function setBusy(value) {
  isBusy = value;
  $("lesson-select").disabled =
    value || Boolean(testRunState?.active) || wordCheckArmed;
  $("reveal-button").disabled = value;
  $("play-audio-button").disabled = value;
  $("record-button").disabled = value;
  $("word-check-cancel-button").disabled = value;
  $("repeat-button").disabled = value;
  $("skip-button").disabled = value;

  const adminInput = $("admin-code-input");
  const adminSubmit = $("admin-code-submit");
  if (adminInput) adminInput.disabled = value;
  if (adminSubmit) adminSubmit.disabled = value;

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
    throw new Error("Tsy ampy ny fikirakirana (config.js).");
  }
  return config;
}

function parseLoginString(value) {
  const match = String(value || "")
    .trim()
    .match(/^(\d{2})_([A-Za-z0-9]{4})_([A-Za-z0-9]{4})$/);

  if (!match) {
    throw new Error("Ampidiro amin'ny endrika 01_7351_abcd ny kaody.");
  }

  const [, participantNumber, profileCode, keyFragment] = match;
  const config = getNanoGPTConfig();

  if (!config.profileCodes[participantNumber]) {
    throw new Error("Tsy fantatra ny kaonty.");
  }
  if (config.profileCodes[participantNumber] !== profileCode) {
    throw new Error("Diso ny kaody fidirana.");
  }

  return {
    accessCode: `profil_${participantNumber}`,
    apiKey: config.apiKeyPrefix + keyFragment + config.apiKeySuffix
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
  return Number.isFinite(directCost) ? directCost : null;
}

function costFromHeaders(headers) {
  for (const name of ["x-nanogpt-pricing", "x-nanogpt-cost", "x-pricing"]) {
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
      headers: { "x-api-key": apiKey, "Accept": "application/json" }
    });
    if (!response.ok) return null;
    return costFromObject(await response.json());
  } catch {
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
  const { error } = await supabaseClient.from("learn_events").insert({
    client_event_id: crypto.randomUUID(),
    user_id: currentUser.id,
    lesson_id: item?.lesson_id || payload.lessonId || null,
    item_id: item?.id || null,
    test_run_id: payload.testRunId || null,
    event_type: eventType,
    client_time: new Date().toISOString(),
    payload
  });
  if (error) console.error("Could not log event:", error);
}

async function logApiUsage({
  requestId, attemptId, itemId, operation, model, status, cost, usage, audioDurationMs
}) {
  if (!currentUser) return;
  const { error } = await supabaseClient.from("learn_api_usage").insert({
    client_request_id: crypto.randomUUID(),
    user_id: currentUser.id,
    attempt_id: attemptId,
    item_id: itemId,
    provider: "NanoGPT",
    model_name: model,
    operation,
    status,
    input_tokens: readTokenCount(usage, ["prompt_tokens", "input_tokens"]),
    output_tokens: readTokenCount(usage, ["completion_tokens", "output_tokens"]),
    estimated_cost: cost,
    currency: "USD",
    audio_duration_ms: audioDurationMs,
    provider_request_id: requestId || null,
    pricing_version: "NanoGPT API response or usage lookup",
    completed_at: new Date().toISOString()
  });
  if (error) console.error("Could not log API usage:", error);
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
    throw new Error("Tsy kaonty mpianatra ity kaonty ity.");
  }

  currentUser = user;
  $("login-screen").classList.add("hidden");
  $("app-screen").classList.remove("hidden");
  $("participant-name").textContent = profile.display_name || user.email || "";

  await loadTotalEarnedAriary();
  await loadLessons();
}

async function loadTotalEarnedAriary() {
  completedAriaryByLesson = new Map();
  totalCompletedAriary = 0;

  if (!currentUser) {
    renderEarnedAriary();
    return;
  }

  const [runsRes, itemsRes] = await Promise.all([
    supabaseClient
      .from("learn_test_runs")
      .select("id, lesson_id, final_score")
      .eq("user_id", currentUser.id)
      .eq("status", "completed")
      .is("voided_at", null),
    supabaseClient.from("learn_learner_items").select("id, lesson_id")
  ]);

  if (runsRes.error) {
    console.error("Could not load earned Ariary:", runsRes.error);
    renderEarnedAriary();
    return;
  }

  const runs = runsRes.data || [];
  if (!runs.length) {
    renderEarnedAriary();
    return;
  }

  const wordCounts = new Map();
  if (!itemsRes.error) {
    for (const row of itemsRes.data || []) {
      wordCounts.set(row.lesson_id, (wordCounts.get(row.lesson_id) || 0) + 1);
    }
  }

  const runIds = runs.map(run => run.id);
  const { data: attemptsData, error: attemptsErr } = await supabaseClient
    .from("learn_attempts")
    .select("test_run_id, final_score")
    .eq("user_id", currentUser.id)
    .eq("mode", "test")
    .in("test_run_id", runIds)
    .limit(5000);

  const attemptsByRun = new Map();
  if (!attemptsErr && attemptsData) {
    for (const a of attemptsData) {
      if (!a.test_run_id) continue;
      const list = attemptsByRun.get(a.test_run_id) || [];
      list.push(a);
      attemptsByRun.set(a.test_run_id, list);
    }
  }

  for (const run of runs) {
    const runAttempts = attemptsByRun.get(run.id) || [];
    const count = wordCounts.get(run.lesson_id) || runAttempts.length || items.length;
    let runAriary = 0;

    if (runAttempts.length > 0 && count > 0) {
      for (const a of runAttempts) {
        runAriary += getWordEarnedAriary(count, a.final_score);
      }
    } else if (count > 0) {
      runAriary = Math.round(
        (Number(run.final_score) || 0) * count * getWordMaxAriary(count)
      );
    }

    completedAriaryByLesson.set(
      run.lesson_id,
      (completedAriaryByLesson.get(run.lesson_id) || 0) + runAriary
    );
    totalCompletedAriary += runAriary;
  }

  renderEarnedAriary();
}

async function loadLessons() {
  showMessage("Maka ny lesona …");
  const { data, error } = await supabaseClient
    .from("learn_lessons")
    .select("id, slug, title, order_index")
    .eq("is_published", true)
    .order("order_index");

  if (error) {
    console.error(error);
    showMessage("Tsy voaray ny lesona.", true);
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
    showMessage("Tsy misy lesona hita.", true);
    return;
  }

  await loadItems(lessons[0].id);
}

async function loadItems(lessonId) {
  if (testRunState?.active || wordCheckArmed) {
    showMessage("Tsy azo ovaina ny lesona mandritra ny fitsapana.", true);
    return;
  }

  showMessage("Maka ny teny …");
  const { data, error } = await supabaseClient
    .from("learn_learner_items")
    .select("id, lesson_id, order_index, prompt_mg, target_de, tts_audio_path, max_reward_eur")
    .eq("lesson_id", lessonId)
    .order("order_index");

  if (error) {
    console.error(error);
    items = [];
    renderItem();
    showMessage("Tsy voaray ny lesona.", true);
    return;
  }

  items = data || [];
  currentIndex = 0;
  testRunState = null;
  wordCheckArmed = false;

  const lesson = lessons.find(v => v.id === lessonId);
  $("lesson-title").textContent = lesson?.title || "";

  await loadLearnerProgress();
  await loadTestEligibility(lessonId);
  await logEvent("lesson_opened", null, { lessonId, itemCount: items.length });

  showMessage("");
  renderItem();
}

async function loadLearnerProgress() {
  passedWordChecks = new Set();

  if (!currentUser || !items.length) {
    renderProgress();
    return;
  }

  const { data, error } = await supabaseClient
    .from("learn_attempts")
    .select("item_id, final_score, evaluation_status")
    .eq("user_id", currentUser.id)
    .in("item_id", items.map(item => item.id))
    .eq("mode", "word_check")
    .limit(5000);

  if (error) {
    console.error("Could not load learner progress:", error);
    showMessage("Tsy voaray ny fivoarana.", true);
    renderProgress();
    return;
  }

  for (const attempt of data || []) {
    if (attempt.evaluation_status === "complete" && Number(attempt.final_score) === 1) {
      passedWordChecks.add(attempt.item_id);
    }
  }

  renderProgress();
}

function getRequiredWordsForTest() {
  if (items.length === 0) return 0;
  return Math.max(1, items.length - Math.ceil(items.length * 0.1));
}

function getPassedWordCheckCount() {
  return items.filter(item => passedWordChecks.has(item.id)).length;
}

async function loadTestEligibility(lessonId) {
  testEligibility = {
    starts: 0,
    completed: false,
    maxScoreReached: false,
    latestCompletedScore: null,
    latestCompletedAriary: completedAriaryByLesson.get(lessonId) || 0,
    loadFailed: false
  };

  if (!currentUser || !lessonId) {
    renderTestControls();
    return;
  }

  const { data, error } = await supabaseClient
    .from("learn_test_runs")
    .select("id, status, voided_at, final_score, completed_at")
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
  for (const run of runs) {
    if (run.status !== "in_progress") continue;
    const { error: updateErr } = await supabaseClient
      .from("learn_test_runs")
      .update({ status: "abandoned", completed_at: new Date().toISOString() })
      .eq("id", run.id)
      .eq("user_id", currentUser.id);
    if (!updateErr) run.status = "abandoned";
  }

  const validRun = runs.find(r => r.status === "completed" && !r.voided_at) || null;
  testEligibility.starts = runs.length;
  testEligibility.completed = Boolean(validRun);
  testEligibility.latestCompletedScore = validRun ? validRun.final_score : null;
  testEligibility.maxScoreReached =
    Boolean(validRun) && Number(validRun.final_score) >= 0.9999;
  testEligibility.latestCompletedAriary = validRun
    ? completedAriaryByLesson.get(lessonId) ||
      Math.round((Number(validRun.final_score) || 0) * items.length * getWordMaxAriary(items.length))
    : 0;

  renderTestControls();
}

function renderTestControls() {
  const startBtn = $("test-start-button");
  const status = $("test-status");
  const abandonBtn = $("test-abandon-button");
  const reward = $("test-provisional-reward");

  if (!startBtn || !status || !abandonBtn || !reward) return;

  const active = Boolean(testRunState?.active);
  abandonBtn.classList.toggle("hidden", !active);

  if (active) {
    status.textContent =
      `Mandeha ny fitsapana: teny ${testRunState.index} amin'ny ${testRunState.queue.length} voavaly.`;
    reward.textContent = `Vola vonjimaika: ${formatAriary(testRunState.ariary)}`;
    reward.classList.remove("hidden");
    startBtn.textContent = "Hanomboka ny fitsapana";
    startBtn.disabled = true;
    return;
  }

  reward.classList.add("hidden");

  if (testEligibility.loadFailed) {
    startBtn.textContent = "Hanomboka ny fitsapana";
    status.textContent = "Tsy voaray ny satan'ny fitsapana. Avereno sokafana ny pejy.";
    startBtn.disabled = true;
    return;
  }

  if (testEligibility.maxScoreReached) {
    startBtn.textContent = "Vita tanteraka";
    status.textContent =
      `Nahazo isa feno (${Number(testEligibility.latestCompletedScore).toFixed(2)} · ` +
      `${formatAriary(testEligibility.latestCompletedAriary)}). Tsy azo averina intsony.`;
    startBtn.disabled = true;
    return;
  }

  if (testEligibility.starts >= MAX_TEST_STARTS) {
    startBtn.textContent = "Hanomboka ny fitsapana";
    status.textContent = testEligibility.completed
      ? `Tapitra ny fanombohana (${MAX_TEST_STARTS}/${MAX_TEST_STARTS}). ` +
        `Isa manankery: ${Number(testEligibility.latestCompletedScore).toFixed(2)} ` +
        `(${formatAriary(testEligibility.latestCompletedAriary)}).`
      : `Tapitra ny fetra fanombohana ${MAX_TEST_STARTS}.`;
    startBtn.disabled = true;
    return;
  }

  const required = getRequiredWordsForTest();
  const passed = getPassedWordCheckCount();

  if (passed < required) {
    startBtn.textContent = "Hanomboka ny fitsapana";
    status.textContent =
      `Fanokafana: teny ${passed} amin'ny ${required} voasedra tsara.`;
    startBtn.disabled = true;
    return;
  }

  const remaining = MAX_TEST_STARTS - testEligibility.starts;
  if (testEligibility.completed) {
    startBtn.textContent = "Avereno ny fitsapana";
    status.textContent =
      `Isa manankery ankehitriny: ${Number(testEligibility.latestCompletedScore).toFixed(2)} ` +
      `(${formatAriary(testEligibility.latestCompletedAriary)}). ` +
      `Andrana sisa: ${remaining} amin'ny ${MAX_TEST_STARTS}. ` +
      "Manolo ny vokatra teo aloha ny fitsapana vaovao vita.";
  } else {
    startBtn.textContent = "Hanomboka ny fitsapana";
    status.textContent =
      `Misokatra. Andrana azo atao: ${remaining} amin'ny ${MAX_TEST_STARTS}.`;
  }

  startBtn.disabled = isBusy || wordCheckArmed;
}

function renderProgress() {
  const passedCount = getPassedWordCheckCount();
  $("word-check-progress").textContent =
    `${passedCount} amin'ny ${items.length} teny voasedra tsara`;

  const required = getRequiredWordsForTest();
  if (!items.length) {
    $("test-unlock-status").textContent = "";
  } else if (passedCount >= required) {
    $("test-unlock-status").textContent = "Azo atomboka ny fitsapana farany.";
  } else {
    $("test-unlock-status").textContent =
      `Ho an'ny fitsapana farany: teny ${passedCount} amin'ny ${required} no voasedra. ` +
      "Azo atao na oviana na oviana ny fitsapana teny.";
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
    badge.textContent = "Teny voasedra tsara";
    badge.classList.add("passed");
  } else {
    badge.textContent = "Tsy mbola voasedra";
    badge.classList.remove("passed");
  }
}

function updateWordCheckButton() {
  const btn = $("word-check-button");
  if (!btn) return;
  const item = currentItem();
  btn.disabled = !item || isBusy || wordCheckArmed || Boolean(testRunState?.active);
}

function getTtsUrl(path) {
  if (!path) return null;
  return supabaseClient.storage.from(TTS_BUCKET).getPublicUrl(path).data.publicUrl;
}

function renderItem({ keepMessage = false } = {}) {
  const item = currentItem();

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
    wordCheckArmed = false;
    $("app-screen").classList.remove("word-check-armed");
    $("prompt").textContent = "Tsy misy teny ato amin'ity lesona ity.";
    $("item-position").textContent = "";
    $("reveal-button").disabled = true;
    $("play-audio-button").disabled = true;
    $("record-button").disabled = true;
    $("word-check-button").disabled = true;
    $("word-check-cancel-button").classList.add("hidden");
    $("repeat-button").disabled = true;
    $("skip-button").disabled = true;
    renderProgress();
    return;
  }

  $("prompt").textContent = item.prompt_mg;

  if (testRunState?.active) {
    wordCheckArmed = false;
    $("app-screen").classList.remove("word-check-armed");
    $("item-position").textContent =
      `Fitsapana ${testRunState.index + 1} / ${testRunState.queue.length}`;
    $("reveal-button").classList.add("hidden");
    $("translation").classList.add("hidden");
    $("play-audio-button").classList.add("hidden");
    $("tts-player").classList.add("hidden");
    $("word-check-button").classList.add("hidden");
    $("word-check-cancel-button").classList.add("hidden");
    $("repeat-button").classList.add("hidden");
    $("skip-button").classList.add("hidden");
    $("record-button").textContent = "Handray feo (Fitsapana)";
    $("record-button").classList.remove("hidden");
    $("record-button").disabled = isBusy;
    $("lesson-select").disabled = true;
  } else if (wordCheckArmed) {
    $("app-screen").classList.add("word-check-armed");
    $("item-position").textContent =
      `Teny ${currentIndex + 1} / ${items.length} · Fitsapana teny`;
    $("reveal-button").classList.add("hidden");
    $("translation").classList.add("hidden");
    $("play-audio-button").classList.add("hidden");
    $("tts-player").classList.add("hidden");
    $("word-check-button").classList.add("hidden");
    $("repeat-button").classList.add("hidden");
    $("skip-button").classList.add("hidden");
    $("record-button").textContent = "Hanomboka handray feo";
    $("record-button").classList.remove("hidden");
    $("record-button").disabled = isBusy;
    $("word-check-cancel-button").classList.remove("hidden");
    $("word-check-cancel-button").disabled = isBusy;
    $("lesson-select").disabled = true;
  } else {
    $("app-screen").classList.remove("word-check-armed");
    $("item-position").textContent = `Teny ${currentIndex + 1} / ${items.length}`;
    $("reveal-button").classList.remove("hidden");
    $("play-audio-button").classList.remove("hidden");
    $("word-check-button").classList.remove("hidden");
    $("word-check-cancel-button").classList.add("hidden");
    $("repeat-button").classList.remove("hidden");
    $("skip-button").classList.remove("hidden");
    $("record-button").textContent = "Handray feo sy hanombana";
    $("record-button").classList.remove("hidden");
    $("lesson-select").disabled = isBusy;
    $("reveal-button").disabled = isBusy;
    $("play-audio-button").disabled = isBusy || !item.tts_audio_path;
    $("record-button").disabled = isBusy;
    $("repeat-button").disabled = isBusy;
    $("skip-button").disabled = isBusy;
  }

  renderProgress();

  if (!wordCheckArmed) {
    logEvent("item_shown", item, { index: currentIndex });
    if (!keepMessage) showMessage("");
  }
}

function revealTranslation() {
  const item = currentItem();
  if (!item || testRunState?.active || wordCheckArmed || recordingMode === "word_check") return;
  $("translation").textContent = item.target_de;
  $("translation").classList.remove("hidden");
  usedTranslationForCurrentItem = true;
  logEvent("translation_revealed", item);
}

async function playTts() {
  const item = currentItem();
  if (!item?.tts_audio_path) {
    showMessage("Tsy misy feo ho an'ity teny ity.", true);
    return;
  }
  if (testRunState?.active || wordCheckArmed || recordingMode === "word_check") return;

  const player = $("tts-player");
  player.src = getTtsUrl(item.tts_audio_path);
  player.classList.remove("hidden");
  usedAudioForCurrentItem = true;

  await logEvent("tts_played", item);
  try {
    await player.play();
  } catch (error) {
    console.error(error);
    showMessage("Tsy nandeha ny feo. Tsindrio ny mpandefa feo.", true);
  }
}

function chooseRecorderMimeType() {
  if (!window.MediaRecorder) return "";
  return ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find(type =>
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
      "Tsy manohana ny fandraisam-peo ity navigateur ity. Ampiasao Chrome amin'ny Android."
    );
  }
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  });
}

function configureRecorder(stream, mode, item) {
  const mimeType = chooseRecorderMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

  mediaRecorder = recorder;
  recordingStream = stream;
  recordingChunks = [];
  recordingMode = mode;
  recordingItem = item;
  recordingStartedAt = null;
  recordingStartedMonotonic = null;
  manualStop = false;

  recorder.addEventListener("start", () => {
    recordingStartedAt = Date.now();
    recordingStartedMonotonic = performance.now();
  }, { once: true });

  recorder.addEventListener("dataavailable", event => {
    if (!event.data?.size) return;
    const limitMs = getRecordingLimitMs(recordingMode);
    const elapsedMs = recordingStartedMonotonic === null
      ? 0
      : performance.now() - recordingStartedMonotonic;

    if (limitMs === null || elapsedMs <= limitMs + RECORDING_CHUNK_GRACE_MS) {
      recordingChunks.push(event.data);
      return;
    }
    if (recorder.state === "recording") {
      manualStop = false;
      recorder.stop();
    }
  });

  recorder.addEventListener("stop", () => {
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
      wordCheckArmed = false;

      resetRecordingUi();
      setBusy(false);
      updateWordCheckButton();

      if (testRunState?.active) {
        const msg = "Nisy olana ara-teknika tamin'ny fandraisam-peo. Najanona ny fitsapana.";
        await abandonLessonTest(msg);
        showAnalysisNotice("Najanona ny fitsapana", msg, true);
        return;
      }

      const msg = "Tsy voakarakara ny feo noraisina.";
      showMessage(msg, true);
      showAnalysisNotice("Tsy nahomby ny fandraisam-peo", msg, true);
    });
  }, { once: true });
}

async function startPracticeRecording() {
  if (!currentApiKey) {
    showMessage("Mivoaha azafady dia midira indray.", true);
    return;
  }
  const item = currentItem();
  if (!item || isBusy || wordCheckArmed || testRunState?.active) return;

  try {
    setBusy(true);
    showMessage("Manomana ny mikrô … Mifarana ho azy afaka 20 segondra.");
    const stream = await requestAudioStream();
    configureRecorder(stream, "practice", item);
    mediaRecorder.addEventListener("start", () => onPracticeRecorderStarted(item), { once: true });
    mediaRecorder.start(RECORDING_CHUNK_MS);
  } catch (error) {
    console.error(error);
    stopMediaTracks();
    resetRecordingUi();
    setBusy(false);
    showMessage(error.message || "Tsy afaka nanomboka ny fandraisam-peo.", true);
  }
}

function onPracticeRecorderStarted(item) {
  $("record-button").classList.add("hidden");
  $("word-check-button").classList.add("hidden");
  $("stop-button").classList.remove("hidden");
  $("stop-button").disabled = false;
  showMessage("Mandeha ny fandraisam-peo. Tsindrio ny « Vita » rehefa tapitra.");

  logEvent("recording_started", item, { mode: "practice", timeLimitMs: PRACTICE_RECORDING_LIMIT_MS });
  recordingDeadlineTimer = window.setTimeout(() => {
    if (mediaRecorder?.state === "recording") {
      manualStop = false;
      mediaRecorder.stop();
    }
  }, PRACTICE_RECORDING_LIMIT_MS);
}

function armWordCheck() {
  if (!currentApiKey) {
    showMessage("Mivoaha azafady dia midira indray.", true);
    return;
  }
  const item = currentItem();
  if (!item || isBusy || mediaRecorder || wordCheckArmed || testRunState?.active) return;

  wordCheckArmed = true;
  renderItem();
  showMessage("Tsindrio ny « Hanomboka handray feo » rehefa vonona.");
}

function cancelWordCheck() {
  if (!wordCheckArmed || isBusy || mediaRecorder) return;
  wordCheckArmed = false;
  renderItem();
}

async function startWordCheckRecording() {
  if (!currentApiKey) {
    showMessage("Mivoaha azafady dia midira indray.", true);
    return;
  }
  const item = currentItem();
  if (!item || !wordCheckArmed || isBusy || mediaRecorder || testRunState?.active) return;

  setBusy(true);
  showMessage("Manomana ny mikrô …");
  try {
    const stream = await requestAudioStream();
    configureRecorder(stream, "word_check", item);
    mediaRecorder.addEventListener("start", () => onWordCheckRecorderStarted(item), { once: true });
    mediaRecorder.start(RECORDING_CHUNK_MS);
  } catch (error) {
    console.error(error);
    stopMediaTracks();
    wordCheckArmed = false;
    resetRecordingUi();
    setBusy(false);
    showMessage(error.message || "Tsy afaka nanomboka ny fandraisam-peo.", true);
  }
}

function onWordCheckRecorderStarted(item) {
  wordCheckStartedAt = performance.now();
  wordCheckDeadline = wordCheckStartedAt + WORD_CHECK_LIMIT_MS;
  promptShownAt = Date.now();

  $("prompt").textContent = item.prompt_mg;
  $("timer-panel").classList.remove("hidden");
  $("timer-countdown").textContent = (WORD_CHECK_LIMIT_MS / 1000).toFixed(1);
  $("timer-label").textContent = "Mandeha ny fitsapana teny";
  $("timer-help").textContent =
    `Lazao amin'ny teny alemà. Mifarana afaka ${WORD_CHECK_LIMIT_MS / 1000} segondra.`;

  $("record-button").classList.add("hidden");
  $("word-check-button").classList.add("hidden");
  $("word-check-cancel-button").classList.add("hidden");
  $("reveal-button").classList.add("hidden");
  $("play-audio-button").classList.add("hidden");
  $("translation").classList.add("hidden");
  $("tts-player").classList.add("hidden");
  $("stop-button").classList.remove("hidden");
  $("stop-button").disabled = false;
  showMessage("Mandeha ny fandraisam-peo …");

  logEvent("word_check_started", item, { timeLimitMs: WORD_CHECK_LIMIT_MS });
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
  $("timer-countdown").textContent = (TEST_RECORDING_LIMIT_MS / 1000).toFixed(1);
  $("timer-label").textContent =
    `Teny ${testRunState.index + 1} amin'ny ${testRunState.queue.length}`;
  $("timer-help").textContent =
    `Lazao amin'ny teny alemà. Mifarana afaka ${TEST_RECORDING_LIMIT_MS / 1000} segondra.`;

  $("record-button").classList.add("hidden");
  $("stop-button").classList.remove("hidden");
  $("stop-button").disabled = false;
  showMessage("Mandeha ny fandraisam-peo …");

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
    const remaining = Math.max(0, wordCheckDeadline - performance.now());
    $("timer-countdown").textContent = (remaining / 1000).toFixed(1);
    if (remaining <= 0) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }, 40);
}

async function startTestRecording() {
  if (!currentApiKey) {
    showMessage("Mivoaha azafady dia midira indray.", true);
    return;
  }
  if (!testRunState?.active || isBusy || mediaRecorder) return;

  const item = currentItem();
  if (!item) return;

  try {
    setBusy(true);
    showMessage("Manomana ny mikrô …");
    const stream = await requestAudioStream();
    configureRecorder(stream, "test", item);
    mediaRecorder.addEventListener("start", () => onTestRecorderStarted(item), { once: true });
    mediaRecorder.start(RECORDING_CHUNK_MS);
  } catch (error) {
    console.error(error);
    stopMediaTracks();
    resetRecordingUi();
    setBusy(false);
    showMessage(error.message || "Tsy afaka nanomboka ny fandraisam-peo.", true);
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
  $("word-check-cancel-button").classList.add("hidden");
  $("app-screen").classList.remove("word-check-armed");

  if (testRunState?.active) {
    $("word-check-button").classList.add("hidden");
    $("reveal-button").classList.add("hidden");
    $("play-audio-button").classList.add("hidden");
    $("repeat-button").classList.add("hidden");
    $("skip-button").classList.add("hidden");
    $("record-button").textContent = "Handray feo (Fitsapana)";
  } else {
    $("word-check-button").classList.remove("hidden");
    $("reveal-button").classList.remove("hidden");
    $("play-audio-button").classList.remove("hidden");
    $("repeat-button").classList.remove("hidden");
    $("skip-button").classList.remove("hidden");
    $("record-button").textContent = "Handray feo sy hanombana";
  }

  $("timer-panel").classList.add("hidden");
}

async function finishRecording() {
  clearRecordingTimers();
  showMessage("");
  showAnalysisLoading("Tapitra ny fandraisam-peo. Manomana ny feo …");
  stopMediaTracks();

  const mode = recordingMode;
  const item = recordingItem;
  const startedAt = recordingStartedAt;
  const promptTime = promptShownAt;
  const timeLimitMs = getRecordingLimitMs(mode);
  const testRunId = mode === "test" ? testRunState?.id || null : null;
  const endReason = manualStop ? "manual" : "deadline";

  let durationMs = recordingStartedMonotonic === null
    ? 0
    : Math.max(0, performance.now() - recordingStartedMonotonic);

  if (timeLimitMs !== null) durationMs = Math.min(timeLimitMs, durationMs);
  if ((mode === "word_check" || mode === "test") && wordCheckStartedAt !== null) {
    durationMs = Math.min(timeLimitMs, Math.max(0, performance.now() - wordCheckStartedAt));
  }

  if (!item || !mediaRecorder) {
    wordCheckArmed = false;
    hideAnalysisModal();
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
    $("timer-label").textContent = "Tapitra ny fandraisam-peo";
    $("timer-countdown").textContent = (durationMs / 1000).toFixed(1);
    $("timer-help").textContent = "Eo am-panombanana ny valinteny.";
  }

  if (!sourceBlob.size) {
    wordCheckArmed = false;
    resetRecordingUi();
    setBusy(false);
    updateWordCheckButton();

    if (mode === "test") {
      const msg = "Tsy nisy feo voaray. Najanona ny fitsapana.";
      await abandonLessonTest(msg);
      showAnalysisNotice("Najanona ny fitsapana", msg, true);
    } else {
      const msg = "Tsy nisy feo voaray. Andramo indray azafady.";
      showAnalysisNotice("Tsy nisy feo", msg, true);
    }
    return;
  }

  if (lastRecordingUrl) URL.revokeObjectURL(lastRecordingUrl);
  lastRecordingUrl = URL.createObjectURL(sourceBlob);

  const recordingPlayer = $("recording-player");
  recordingPlayer.src = lastRecordingUrl;
  recordingPlayer.classList.remove("hidden");

  await logEvent(
    mode === "word_check" ? "word_check_completed" : "recording_stopped",
    item,
    { mode, durationMs, timeLimitMs, endReason, ...(testRunId ? { testRunId } : {}) }
  );

  await evaluateRecording({
    item, sourceBlob, mode, testRunId, startedAt, promptTime, durationMs, timeLimitMs, endReason
  });
}

async function startLessonTest() {
  if (isBusy || wordCheckArmed || testRunState?.active) return;
  if (!currentApiKey) {
    showMessage("Mivoaha azafady dia midira indray.", true);
    return;
  }

  const lessonId = $("lesson-select").value;
  await loadTestEligibility(lessonId);

  if (
    testEligibility.loadFailed ||
    testEligibility.maxScoreReached ||
    testEligibility.starts >= MAX_TEST_STARTS ||
    getPassedWordCheckCount() < getRequiredWordsForTest()
  ) {
    renderTestControls();
    return;
  }

  if (!items.length || items.some(item => item.max_reward_eur == null)) {
    showMessage("Tsy afaka nanomboka ny fitsapana (tsy ampy ny angona).", true);
    return;
  }

  if (testEligibility.completed) {
    const prevAriary = formatAriary(testEligibility.latestCompletedAriary);
    const confirmed = window.confirm(
      `Efa manana vokatra ianao (${prevAriary}). ` +
      "Raha vitanao ny fitsapana vaovao dia hisolo ny vokatra teo aloha izany, " +
      "na dia kely kokoa aza ny vola azo. Raha ajanona eny an-tenantenany dia mijanona ny teo aloha. " +
      "Hanomboka fitsapana vaovao ve?"
    );
    if (!confirmed) return;
  }

  setBusy(true);
  showMessage("Manomboka ny fitsapana …");

  const { data, error } = await supabaseClient
    .from("learn_test_runs")
    .insert({ user_id: currentUser.id, lesson_id: lessonId, status: "in_progress" })
    .select("id")
    .single();

  if (error) {
    console.error("Could not start test:", error);
    setBusy(false);
    showMessage("Tsy afaka nanomboka ny fitsapana.", true);
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
    ariary: 0,
    active: true
  };

  currentIndex = items.findIndex(item => item.id === testRunState.queue[0].id);

  await logEvent("test_started", null, {
    lessonId,
    testRunId: data.id,
    itemCount: items.length,
    startNumber: testEligibility.starts
  });

  setBusy(false);
  renderEarnedAriary();
  renderItem();
  renderTestControls();
  showMessage("Mandeha ny fitsapana. Tsindrio ny « Handray feo (Fitsapana) ».");
}

function shuffleItems(source) {
  const shuffled = [...source];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
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

  if (error) console.error("Could not abandon test:", error);

  await logEvent("test_abandoned", null, { lessonId, testRunId: runId, reason: message });

  testRunState = null;
  setBusy(false);
  renderEarnedAriary();
  await loadTestEligibility(lessonId);
  renderItem();
  showMessage(message, Boolean(error));
}

async function advanceLessonTest(score, expectedRunId, wordAriary = null) {
  if (!testRunState?.active || testRunState.id !== expectedRunId) return;

  const answeredItem = currentItem();
  const run = testRunState;
  const numericScore = Number(score);

  if (![0, 0.75, 1].includes(numericScore)) {
    const msg = "Nisy olana ara-teknika tamin'ny naoty. Najanona ny fitsapana.";
    await abandonLessonTest(msg);
    showAnalysisNotice("Najanona ny fitsapana", msg, true);
    return;
  }

  const earned = wordAriary !== null
    ? wordAriary
    : getWordEarnedAriary(run.queue.length, numericScore);

  run.scoreSum += numericScore;
  run.reward += (Number(answeredItem.max_reward_eur) || 0) * numericScore;
  run.ariary += earned;
  run.index += 1;

  renderEarnedAriary();

  if (run.index < run.queue.length) {
    currentIndex = items.findIndex(item => item.id === run.queue[run.index].id);
    renderItem({ keepMessage: true });
    renderTestControls();
    showMessage(
      `Voatahiry (+${formatAriary(earned)}). ${run.index} amin'ny ${run.queue.length} vita. ` +
      `Vola vonjimaika: ${formatAriary(run.ariary)}`
    );
    return;
  }

  const finalScore = run.scoreSum / run.queue.length;
  const finalReward = Number(run.reward.toFixed(4));
  const finalAriary = run.ariary;

  const { error } = await supabaseClient.rpc("complete_learn_test_run", {
    p_run_id: run.id,
    p_final_score: finalScore,
    p_final_reward_eur: finalReward
  });

  if (error) {
    console.error("Could not complete test:", error);
    const msg = "Tsy voatahiry tsara ny fitsapana. Najanona ny fitsapana.";
    await abandonLessonTest(msg);
    showAnalysisNotice("Tsy voatahiry", msg, true);
    return;
  }

  const completedRunId = run.id;
  const lessonId = run.lessonId;

  await logEvent("test_completed", null, {
    lessonId,
    testRunId: completedRunId,
    finalScore,
    finalReward,
    finalAriary
  });

  const previousLessonAriary = completedAriaryByLesson.get(lessonId) || 0;
  completedAriaryByLesson.set(lessonId, finalAriary);
  totalCompletedAriary = totalCompletedAriary - previousLessonAriary + finalAriary;

  testRunState = null;
  renderEarnedAriary();
  await loadTestEligibility(lessonId);
  renderItem({ keepMessage: true });

  const finishLine = document.createElement("div");
  finishLine.className = "ariary-earned-line";
  finishLine.textContent =
    `Vita ny fitsapana! Isa farany: ${finalScore.toFixed(2)} · ` +
    `Vola azo: ${formatAriary(finalAriary)}`;
  $("analysis-modal-result").appendChild(finishLine);

  showMessage(
    `Vita ny fitsapana. Isa: ${finalScore.toFixed(2)} · Vola azo: ${formatAriary(finalAriary)}.`
  );
}

async function evaluateRecording({
  item, sourceBlob, mode, testRunId, startedAt, promptTime, durationMs, timeLimitMs, endReason
}) {
  setBusy(true);
  showAnalysisLoading("Manomana ny feo …");

  const attemptId = crypto.randomUUID();
  let originalWavBlob;
  let trimmedAudio;

  try {
    originalWavBlob = await convertBlobToWav(sourceBlob);
    trimmedAudio = await trimSilenceFromWav(originalWavBlob);
  } catch (error) {
    console.error("Audio conversion/trim failed:", error);
    wordCheckArmed = false;
    resetRecordingUi();
    setBusy(false);

    if (mode === "test") {
      const msg = "Nisy olana ara-teknika tamin'ny feo. Najanona ny fitsapana.";
      await abandonLessonTest(msg);
      showAnalysisNotice("Najanona ny fitsapana", msg, true);
      return;
    }

    updateWordCheckButton();
    showAnalysisNotice("Olana ara-teknika", "Tsy voakarakara ny feo.", true);
    return;
  }

  let attemptNumber;
  try {
    attemptNumber = await getNextAttemptNumber(item.id, mode);
  } catch (error) {
    console.error("Could not get attempt number:", error);
    wordCheckArmed = false;
    if (mode === "test") {
      const msg = "Tsy voatahiry ny andrana. Najanona ny fitsapana.";
      await abandonLessonTest(msg);
      showAnalysisNotice("Najanona ny fitsapana", msg, true);
    } else {
      resetRecordingUi();
      setBusy(false);
      showAnalysisNotice("Olana ara-teknika", "Tsy voatahiry ny andrana.", true);
    }
    return;
  }

  const audioPath = `${currentUser.id}/${item.lesson_id}/${item.id}/${attemptId}.wav`;

  if (!trimmedAudio.hasSpeech) {
    const saveResult = await saveNoSpeechAttempt({
      item, mode, testRunId, attemptId, attemptNumber, originalWavBlob,
      audioPath, startedAt, promptTime, durationMs, timeLimitMs, endReason
    });

    wordCheckArmed = false;
    resetRecordingUi();
    setBusy(false);
    updateWordCheckButton();

    if (mode === "test") {
      if (!saveResult.ok) {
        const msg = "Tsy voatahiry ny valinteny. Najanona ny fitsapana.";
        await abandonLessonTest(msg);
        showAnalysisNotice("Najanona ny fitsapana", msg, true);
        return;
      }

      showEvaluation({
        pronunciation: null,
        recognized: false,
        finalScore: 0,
        wordAriary: 0,
        hasError: false,
        mode
      });
      await advanceLessonTest(0, testRunId, 0);
      return;
    }

    showAnalysisNotice(
      "Tsy nisy feo re",
      "Mitenena mafimafy kokoa azafady dia andramo indray.",
      true
    );
    return;
  }

  showAnalysisLoading("Eo am-panombanana ny valinteny … Mety haharitra segondra vitsy izany.");

  const [uploadResult, pronunciationResult] = await Promise.allSettled([
    uploadRecording(audioPath, originalWavBlob),
    callPronunciationModel({ apiKey: currentApiKey, item, wavBlob: trimmedAudio.blob })
  ]);

  const uploadSucceeded = uploadResult.status === "fulfilled";
  const pronunciationSucceeded = pronunciationResult.status === "fulfilled";
  const pronunciation = pronunciationSucceeded ? pronunciationResult.value : null;

  let recognized = null;
  let finalScore = null;
  let phonemeScore = null;
  let evaluationStatus = "complete";
  const errors = [];

  if (pronunciationSucceeded) {
    recognized = normalizeWord(pronunciation.heardText) === normalizeWord(item.target_de);
    phonemeScore = pronunciation.match ? 1 : 0;
    finalScore = !recognized ? 0 : pronunciation.match ? 1 : 0.75;
  } else {
    evaluationStatus = "error";
    errors.push(errorText(pronunciationResult.reason));
  }

  if (!uploadSucceeded) {
    errors.push(`Audio-Upload: ${errorText(uploadResult.reason)}`);
  }

  const usedModel = pronunciation?.model || PRONUNCIATION_MODEL;
  const isRestrictedMode = mode === "word_check" || mode === "test";

  const attemptRow = {
    client_attempt_id: attemptId,
    user_id: currentUser.id,
    item_id: item.id,
    test_run_id: mode === "test" ? testRunId : null,
    mode,
    attempt_number: attemptNumber,
    client_started_at: startedAt ? new Date(startedAt).toISOString() : null,
    prompt_finished_at: promptTime ? new Date(promptTime).toISOString() : null,
    speech_started_at: null,
    recording_finished_at: new Date().toISOString(),
    reaction_time_ms: null,
    response_duration_ms: durationMs,
    time_limit_ms: timeLimitMs,
    recording_end_reason: endReason,
    used_translation: isRestrictedMode ? false : usedTranslationForCurrentItem,
    used_tts_audio: isRestrictedMode ? false : usedAudioForCurrentItem,
    stt_transcript: pronunciation?.heardText || null,
    target_word_recognized: recognized,
    phoneme_transcription: pronunciation?.ipa || null,
    phoneme_score: phonemeScore,
    final_score: finalScore,
    audio_path: uploadSucceeded ? audioPath : null,
    evaluation_status: evaluationStatus,
    evaluation_error: errors.length ? errors.join("\n") : null,
    model_name: usedModel,
    model_version:
      `${usedModel} transcript+IPA+pronunciation` +
      (pronunciation?.fallbackFrom ? ` (fallback from ${pronunciation.fallbackFrom})` : "") +
      "; reasoning_effort=low; max_tokens=1024; edge-trim=v1"
  };

  const { data: attemptData, error: attemptInsertError } = await supabaseClient
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
    model: usedModel,
    status: pronunciation ? "success" : "error",
    cost: pronunciation?.cost ?? null,
    usage: pronunciation?.usage ?? null,
    audioDurationMs: trimmedAudio.trimmedDurationMs
  });

  if (mode === "test") {
    const wordAriary = finalScore !== null && testRunState?.active
      ? getWordEarnedAriary(testRunState.queue.length, finalScore)
      : null;

    const hasTechnicalError =
      Boolean(attemptInsertError) ||
      !pronunciationSucceeded ||
      !uploadSucceeded ||
      evaluationStatus !== "complete" ||
      finalScore === null;

    showEvaluation({
      pronunciation,
      recognized,
      finalScore,
      wordAriary,
      hasError: hasTechnicalError,
      mode
    });

    wordCheckArmed = false;
    resetRecordingUi();
    setBusy(false);

    if (hasTechnicalError) {
      const msg = "Nisy olana ara-teknika. Najanona ny fitsapana.";
      await abandonLessonTest(msg);
      const errNote = document.createElement("div");
      errNote.className = "evaluation-line";
      errNote.style.color = "#a12626";
      errNote.textContent = msg;
      $("analysis-modal-result").appendChild(errNote);
      return;
    }

    await advanceLessonTest(finalScore, testRunId, wordAriary);
    return;
  }

  wordCheckArmed = false;
  await loadLearnerProgress();
  showEvaluation({
    pronunciation,
    recognized,
    finalScore,
    hasError: errors.length > 0,
    mode
  });
  resetRecordingUi();
  setBusy(false);
  updateWordCheckButton();
}

async function saveNoSpeechAttempt({
  item, mode, testRunId, attemptId, attemptNumber, originalWavBlob,
  audioPath, startedAt, promptTime, durationMs, timeLimitMs, endReason
}) {
  let uploadError = null;
  try {
    await uploadRecording(audioPath, originalWavBlob);
  } catch (error) {
    uploadError = error;
  }

  const isTest = mode === "test";
  const isRestrictedMode = mode === "word_check" || isTest;

  const { error: insertError } = await supabaseClient.from("learn_attempts").insert({
    client_attempt_id: attemptId,
    user_id: currentUser.id,
    item_id: item.id,
    test_run_id: isTest ? testRunId : null,
    mode,
    attempt_number: attemptNumber,
    client_started_at: startedAt ? new Date(startedAt).toISOString() : null,
    prompt_finished_at: promptTime ? new Date(promptTime).toISOString() : null,
    response_duration_ms: durationMs,
    time_limit_ms: timeLimitMs,
    recording_end_reason: endReason,
    used_translation: isRestrictedMode ? false : usedTranslationForCurrentItem,
    used_tts_audio: isRestrictedMode ? false : usedAudioForCurrentItem,
    target_word_recognized: isTest ? false : null,
    final_score: isTest ? 0 : null,
    audio_path: uploadError ? null : audioPath,
    evaluation_status: isTest ? "complete" : "error",
    evaluation_error: isTest ? null : "No speech detected after edge silence trimming.",
    model_version: "edge-trim-v1"
  });

  if (insertError) console.error("Could not save no-speech attempt:", insertError);
  if (uploadError) console.error("Could not upload no-speech attempt:", uploadError);

  return { ok: !insertError && (!isTest || !uploadError), insertError, uploadError };
}

async function convertBlobToWav(blob) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw new Error("Tsy misy Web Audio API.");

  const context = new AudioContextClass();
  try {
    const input = await context.decodeAudioData(await blob.arrayBuffer());
    const outputRate = AUDIO_SAMPLE_RATE;
    const ratio = input.sampleRate / outputRate;
    const outputLength = Math.max(1, Math.ceil(input.length / ratio));
    const mono = new Float32Array(outputLength);

    for (let ch = 0; ch < input.numberOfChannels; ch++) {
      const source = input.getChannelData(ch);
      for (let i = 0; i < outputLength; i++) {
        const pos = i * ratio;
        const left = Math.min(Math.floor(pos), source.length - 1);
        const right = Math.min(left + 1, source.length - 1);
        const frac = pos - left;
        mono[i] += (source[left] * (1 - frac) + source[right] * frac) / input.numberOfChannels;
      }
    }
    return encodeWav(mono, outputRate);
  } finally {
    await context.close();
  }
}

async function trimSilenceFromWav(wavBlob) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw new Error("Tsy misy Web Audio API.");

  const context = new AudioContextClass();
  try {
    const decoded = await context.decodeAudioData(await wavBlob.arrayBuffer());
    const sampleRate = decoded.sampleRate;
    const samples = decoded.getChannelData(0);
    const windowSize = Math.max(1, Math.round(sampleRate * SILENCE_WINDOW_MS / 1000));
    const windows = [];

    for (let start = 0; start < samples.length; start += windowSize) {
      const end = Math.min(start + windowSize, samples.length);
      let sumSquares = 0;
      for (let i = start; i < end; i++) sumSquares += samples[i] * samples[i];
      windows.push({ start, end, rms: Math.sqrt(sumSquares / Math.max(1, end - start)) });
    }

    const peakRms = windows.reduce((peak, w) => Math.max(peak, w.rms), 0);
    const threshold = Math.max(ABSOLUTE_SPEECH_THRESHOLD, peakRms * RELATIVE_SPEECH_THRESHOLD);
    const activeWindows = windows.filter(w => w.rms >= threshold);
    const originalDurationMs = decoded.length / sampleRate * 1000;

    if (peakRms < ABSOLUTE_SPEECH_THRESHOLD || activeWindows.length < 2) {
      return { blob: wavBlob, hasSpeech: false, originalDurationMs, trimmedDurationMs: originalDurationMs };
    }

    const paddingSamples = Math.round(sampleRate * SILENCE_PADDING_MS / 1000);
    const startSample = Math.max(0, activeWindows[0].start - paddingSamples);
    const endSample = Math.min(
      decoded.length,
      activeWindows[activeWindows.length - 1].end + paddingSamples
    );
    const frameCount = endSample - startSample;

    if (frameCount <= 0) {
      return { blob: wavBlob, hasSpeech: false, originalDurationMs, trimmedDurationMs: originalDurationMs };
    }

    const monoOutput = new Float32Array(frameCount);
    monoOutput.set(decoded.getChannelData(0).slice(startSample, endSample));
    return {
      blob: encodeWav(monoOutput, sampleRate),
      hasSpeech: true,
      originalDurationMs,
      trimmedDurationMs: frameCount / sampleRate * 1000
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
    view.setInt16(offset, clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

async function uploadRecording(path, blob) {
  const { error } = await supabaseClient.storage
    .from(RECORDING_BUCKET)
    .upload(path, blob, { contentType: "audio/wav", upsert: false });
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
  if (error) return 1;
  return (count || 0) + 1;
}

async function requestPronunciationModel({ apiKey, item, base64Audio, model }) {
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
      model,
      stream: false,
      reasoning_effort: "low",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "input_audio", input_audio: { data: base64Audio, format: "wav" } }
          ]
        }
      ]
    })
  });

  const requestId = response.headers.get("x-request-id");
  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${bodyText.slice(0, 700)}`);
  }

  let data;
  try {
    data = JSON.parse(bodyText);
  } catch {
    throw new Error(`Antwort von ${model} war kein JSON: ${bodyText.slice(0, 500)}`);
  }

  let content = data.choices?.[0]?.message?.content;
  if (Array.isArray(content)) {
    content = content.filter(p => typeof p?.text === "string").map(p => p.text).join("");
  }
  content = String(content || "").trim();

  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Kein JSON in Antwort von ${model}: ${content.slice(0, 500)}`);
  }

  let result;
  try {
    result = JSON.parse(jsonMatch[0]);
  } catch {
    throw new Error(`Ungültiges JSON von ${model}: ${jsonMatch[0].slice(0, 500)}`);
  }

  if (typeof result.heard_text !== "string") {
    throw new Error(`${model}: Textfeld 'heard_text' fehlt.`);
  }
  if (typeof result.ipa !== "string") {
    throw new Error(`${model}: Textfeld 'ipa' fehlt.`);
  }
  if (typeof result.pronunciation_match !== "boolean") {
    throw new Error(`${model}: Boolesches Feld 'pronunciation_match' fehlt.`);
  }

  let cost = costFromHeaders(response.headers);
  if (cost === null) cost = costFromObject(data);
  if (cost === null) cost = await lookupNanoCost(apiKey, requestId);

  return {
    model,
    heardText: result.heard_text.trim(),
    ipa: result.ipa.trim(),
    match: result.pronunciation_match,
    requestId,
    cost,
    usage: data.usage || null
  };
}

async function callPronunciationModel({ apiKey, item, wavBlob }) {
  const base64Audio = await blobToBase64(wavBlob);

  try {
    return await requestPronunciationModel({
      apiKey, item, base64Audio, model: PRONUNCIATION_MODEL
    });
  } catch (primaryError) {
    console.warn(
      `Primary model ${PRONUNCIATION_MODEL} failed, falling back to ${PRONUNCIATION_FALLBACK_MODEL}:`,
      primaryError
    );

    try {
      const fallbackResult = await requestPronunciationModel({
        apiKey, item, base64Audio, model: PRONUNCIATION_FALLBACK_MODEL
      });
      return {
        ...fallbackResult,
        fallbackFrom: PRONUNCIATION_MODEL
      };
    } catch (fallbackError) {
      throw new Error(
        `Carbon: ${errorText(primaryError)} | Hydrogen: ${errorText(fallbackError)}`
      );
    }
  }
}

async function blobToBase64(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function buildEvaluationNodes({
  pronunciation, recognized, finalScore, wordAriary = null, hasError = false, mode
}) {
  const fragment = document.createDocumentFragment();
  const addLine = (text, className = "evaluation-line") => {
    const div = document.createElement("div");
    div.className = className;
    div.textContent = text;
    fragment.appendChild(div);
  };

  if (pronunciation) {
    addLine(
      `Feo re: "${pronunciation.heardText || "(tsy misy)"}" — ` +
      (recognized ? "Voaray tsara ny teny" : "Tsy voaray tsara ny teny")
    );
    addLine(
      "Fanononana: " +
      (pronunciation.match ? "Ekena" : "Mbola mila fanatsarana")
    );
    if (pronunciation.ipa) {
      addLine(`Feo heno (IPA): ${pronunciation.ipa}`);
    }
  } else if (!hasError) {
    addLine("Tsy nisy feo re.");
  }

  if (finalScore !== null) {
    addLine(`Isa: ${finalScore}`, "score");
  }

  if (mode === "word_check" && finalScore !== null) {
    addLine(
      finalScore === 1
        ? "Afaka tamin'ny fitsapana teny."
        : "Tsy mbola afaka; tohizo ny fanazaran-tena."
    );
  }

  if (mode === "test" && finalScore !== null) {
    if (wordAriary !== null && wordAriary > 0) {
      addLine(`Ity teny ity: +${formatAriary(wordAriary)}`, "ariary-earned-line");
    } else {
      addLine("Ity teny ity: +0 Ariary");
    }
  }

  return fragment;
}

function showEvaluation(params) {
  $("analysis-modal").classList.remove("hidden");
  $("analysis-spinner").classList.add("hidden");

  let title = "Valin'ny fanombanana";
  let statusText = "Vita ny fanombanana.";
  let isError = false;

  if (params.hasError) {
    title = "Olana ara-teknika";
    statusText = "Nisy olana teo am-panombanana. Andramo indray azafady.";
    isError = true;
  } else if (params.mode === "word_check") {
    title = params.finalScore === 1
      ? "Afaka tamin'ny fitsapana teny"
      : "Tsy mbola afaka";
    statusText = params.finalScore === 1
      ? "Tsara! Voasedra ity teny ity."
      : "Mianara kely indray dia andramo indray.";
    isError = params.finalScore !== 1;
  } else if (params.mode === "test") {
    title = params.finalScore > 0 ? "Ekena ny valinteny" : "Tsy voaray ny valinteny";
    statusText = params.wordAriary > 0
      ? `Vola azo: +${formatAriary(params.wordAriary)}`
      : "0 Ariary ho an'ity teny ity.";
    isError = params.finalScore === 0;
  }

  $("analysis-modal-title").textContent = title;
  $("analysis-modal-status").textContent = statusText;
  $("analysis-modal-status").style.color = isError ? "#a12626" : "#236b37";
  $("analysis-modal-result").replaceChildren(buildEvaluationNodes(params));
  $("analysis-modal-close").classList.remove("hidden");
}

function errorText(error) {
  if (!error) return "Olana tsy fantatra";
  return error.message || String(error);
}

async function resetAllTestsByAdmin() {
  if (isBusy || mediaRecorder) return;

  setBusy(true);
  showMessage("Averina amin'ny voalohany ny fitsapana …");
  const { error } = await supabaseClient.rpc("reset_my_tests");

  if (error) {
    console.error("Could not reset tests:", error);
    setBusy(false);
    showMessage("Tsy nahomby ny famerenana.", true);
    return;
  }

  testRunState = null;
  wordCheckArmed = false;

  const lessonId = $("lesson-select").value;
  await loadTotalEarnedAriary();
  await loadLearnerProgress();
  await loadTestEligibility(lessonId);

  setBusy(false);
  renderItem({ keepMessage: true });
  showMessage("Voafafa ny fitsapana rehetra voatahiry.", false);
}

const ADMIN_ACTIONS = {
  "zurück123": resetAllTestsByAdmin
};

$("analysis-modal-close").addEventListener("click", hideAnalysisModal);

$("admin-code-form")?.addEventListener("submit", async event => {
  event.preventDefault();
  if (isBusy || mediaRecorder) return;

  const input = $("admin-code-input");
  const code = input.value.trim();
  input.value = "";
  if (!code) return;

  const action = ADMIN_ACTIONS[code];
  if (!action) {
    showMessage("Diso ny kaody mpitantana.", true);
    return;
  }

  await action();
});

$("login-form").addEventListener("submit", async event => {
  event.preventDefault();
  $("login-message").textContent = "Manamarina ny fidirana …";
  currentApiKey = null;

  let parsed;
  try {
    parsed = parseLoginString($("access-code").value);
  } catch (error) {
    $("login-message").textContent = error.message || "Diso ny kaody fidirana.";
    return;
  }

  const { accessCode, apiKey } = parsed;
  const { data, error } = await supabaseClient.auth.signInWithPassword({
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
      profileError.message || "Tsy voaray ny kaonty.";
  }
});

$("lesson-select").addEventListener("change", async event => {
  if (testRunState?.active || wordCheckArmed) return;
  await loadItems(event.target.value);
});

$("reveal-button").addEventListener("click", revealTranslation);
$("play-audio-button").addEventListener("click", playTts);

$("record-button").addEventListener("click", () => {
  if (testRunState?.active) {
    startTestRecording();
  } else if (wordCheckArmed) {
    startWordCheckRecording();
  } else {
    startPracticeRecording();
  }
});

$("word-check-button").addEventListener("click", armWordCheck);
$("word-check-cancel-button").addEventListener("click", cancelWordCheck);
$("stop-button").addEventListener("click", stopRecordingManually);
$("test-start-button").addEventListener("click", startLessonTest);

$("test-abandon-button").addEventListener("click", async () => {
  if (!testRunState?.active || isBusy || mediaRecorder) return;
  const confirmed = window.confirm(
    "Hajanona ve ny fitsapana? Ho foana ny vola vonjimaika tamin'ity andrana ity, " +
    "fa mijanona kosa ny vokatra manankery teo aloha."
  );
  if (confirmed) {
    await abandonLessonTest("Najanona ny fitsapana. Foana ny vola vonjimaika.");
  }
});

$("repeat-button").addEventListener("click", async () => {
  const item = currentItem();
  if (!item || isBusy || mediaRecorder || wordCheckArmed || testRunState?.active) return;
  await logEvent("item_repeated", item, { index: currentIndex });
  renderItem();
});

$("skip-button").addEventListener("click", async () => {
  if (!items.length || isBusy || mediaRecorder || wordCheckArmed || testRunState?.active) return;
  const item = currentItem();
  if (item) await logEvent("item_skipped", item, { index: currentIndex });
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
  if (error || !data.session?.user) return;
  try {
    await enterApp(data.session.user);
  } catch (profileError) {
    console.error(profileError);
    await supabaseClient.auth.signOut();
  }
}

restoreSession();
