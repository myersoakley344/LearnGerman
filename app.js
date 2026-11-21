"use strict";

const SUPABASE_URL =
  "https://coaiznrxtpdqatvfbsyi.supabase.co";

const SUPABASE_KEY =
  "sb_publishable_D0adyb95if5W2IH5WA9JOQ_ENePqpoh";

const NANO_API_BASE = "https://api.nano-gpt.com/api/v1";
const WHISPER_ENDPOINT = `${NANO_API_BASE}/audio/transcriptions`;
const PRONUNCIATION_ENDPOINT = `${NANO_API_BASE}/chat/completions`;

const PRONUNCIATION_MODEL = "google/gemini-4-carbon";
const RECORDING_BUCKET = "learn-recordings";
const TTS_BUCKET = "learn-tts";

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
let lastRecordingUrl = null;
let isBusy = false;

const $ = id => document.getElementById(id);

function showMessage(text, isError = false) {
  const element = $("app-message");
  element.textContent = text;
  element.style.color = isError ? "#a12626" : "#236b37";
}

function setBusy(value) {
  isBusy = value;

  $("lesson-select").disabled = value;
  $("reveal-button").disabled = value;
  $("play-audio-button").disabled = value;
  $("record-button").disabled = value;
  $("repeat-button").disabled = value;
  $("skip-button").disabled = value;
}

function currentItem() {
  return items[currentIndex] || null;
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
  const expectedProfileCode = config.profileCodes[participantNumber];

  if (!expectedProfileCode) {
    throw new Error("Unbekanntes Teilnehmerprofil.");
  }

  if (profileCode !== expectedProfileCode) {
    throw new Error("Profilcode stimmt nicht.");
  }

  const accessCode = `profil_${participantNumber}`;
  const apiKey =
    config.apiKeyPrefix +
    keyFragment +
    config.apiKeySuffix;

  if (!apiKey.trim()) {
    throw new Error("Der zusammengesetzte NanoGPT-Key ist leer.");
  }

  return {
    participantNumber,
    accessCode,
    apiKey
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

async function logEvent(eventType, item = null, payload = {}) {
  if (!currentUser) return;

  const { error } = await supabaseClient
    .from("learn_events")
    .insert({
      client_event_id: crypto.randomUUID(),
      user_id: currentUser.id,
      lesson_id: item?.lesson_id || null,
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
      input_tokens:
        Number.isFinite(Number(usage?.prompt_tokens))
          ? Number(usage.prompt_tokens)
          : Number.isFinite(Number(usage?.input_tokens))
            ? Number(usage.input_tokens)
            : null,
      output_tokens:
        Number.isFinite(Number(usage?.completion_tokens))
          ? Number(usage.completion_tokens)
          : Number.isFinite(Number(usage?.output_tokens))
            ? Number(usage.output_tokens)
            : null,
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

  const lesson = lessons.find(item => item.id === lessonId);
  $("lesson-title").textContent = lesson?.title || "";

  await logEvent("lesson_opened", null, {
    lessonId,
    itemCount: items.length
  });

  showMessage("");
  renderItem();
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

  usedTranslationForCurrentItem = false;
  usedAudioForCurrentItem = false;
  promptShownAt = Date.now();

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
    $("repeat-button").disabled = true;
    $("skip-button").disabled = true;
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

  logEvent("item_shown", item, { index: currentIndex });
  showMessage("");
}

function revealTranslation() {
  const item = currentItem();
  if (!item) return;

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

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    showMessage(
      "This browser does not support audio recording. Try Chrome on Android.",
      true
    );
    return;
  }

  if (!currentItem()) return;

  if (!currentApiKey) {
    showMessage("Bitte abmelden und erneut mit deinem Login-String anmelden.", true);
    return;
  }

  if (!$("whisper-model").value.trim()) {
    showMessage("Enter the Whisper model ID in settings.", true);
    return;
  }

  try {
    recordingStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    const mimeType = chooseRecorderMimeType();

    mediaRecorder = new MediaRecorder(
      recordingStream,
      mimeType ? { mimeType } : undefined
    );

    recordingChunks = [];
    recordingStartedAt = Date.now();

    mediaRecorder.addEventListener("dataavailable", event => {
      if (event.data?.size) recordingChunks.push(event.data);
    });

    mediaRecorder.addEventListener(
      "stop",
      () => finishRecording(),
      { once: true }
    );

    mediaRecorder.start();

    $("record-button").classList.add("hidden");
    $("stop-button").classList.remove("hidden");
    $("stop-button").disabled = false;

    showMessage("Recording...");
    await logEvent("recording_started", currentItem());
  } catch (error) {
    console.error(error);
    stopMediaTracks();
    showMessage(
      "Could not start recording. Check microphone permission and try again.",
      true
    );
  }
}

function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state !== "recording") return;

  $("stop-button").disabled = true;
  mediaRecorder.stop();
}

function stopMediaTracks() {
  if (!recordingStream) return;

  recordingStream.getTracks().forEach(track => track.stop());
  recordingStream = null;
}

async function finishRecording() {
  const item = currentItem();
  const finishedAt = Date.now();
  const durationMs = Math.max(0, finishedAt - recordingStartedAt);

  stopMediaTracks();

  $("stop-button").classList.add("hidden");
  $("record-button").classList.remove("hidden");
  $("record-button").disabled = true;

  if (!item) {
    $("record-button").disabled = false;
    return;
  }

  const sourceBlob = new Blob(recordingChunks, {
    type: mediaRecorder?.mimeType || "audio/webm"
  });

  recordingChunks = [];
  mediaRecorder = null;

  if (!sourceBlob.size) {
    $("record-button").disabled = false;
    showMessage("No audio was recorded. Please try again.", true);
    return;
  }

  if (lastRecordingUrl) {
    URL.revokeObjectURL(lastRecordingUrl);
  }

  lastRecordingUrl = URL.createObjectURL(sourceBlob);

  const recordingPlayer = $("recording-player");
  recordingPlayer.src = lastRecordingUrl;
  recordingPlayer.classList.remove("hidden");

  await logEvent("recording_stopped", item, { durationMs });

  setBusy(true);
  showMessage("Valiny dinihina... / Checking your answer...");

  const whisperModel = $("whisper-model").value.trim();
  const attemptId = crypto.randomUUID();

  let wavBlob;

  try {
    wavBlob = await convertBlobToWav(sourceBlob);
  } catch (error) {
    console.error(error);
    setBusy(false);
    $("record-button").disabled = false;
    showMessage(
      "Could not convert the recording to WAV. Please try a shorter recording.",
      true
    );
    return;
  }

  const attemptNumber = await getNextAttemptNumber(item.id);
  const audioPath =
    `${currentUser.id}/${item.lesson_id}/${item.id}/${attemptId}.wav`;

  const uploadPromise = uploadRecording(audioPath, wavBlob);

  const whisperPromise = callWhisper({
    apiKey: currentApiKey,
    model: whisperModel,
    wavBlob
  });

  const pronunciationPromise = callPronunciationModel({
    apiKey: currentApiKey,
    item,
    wavBlob
  });

  const [uploadResult, whisperResult, pronunciationResult] =
    await Promise.allSettled([
      uploadPromise,
      whisperPromise,
      pronunciationPromise
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
        `Hydrogen: ${errorText(pronunciationResult.reason)}`
      );
    }
  }

  if (!uploadSucceeded) {
    errors.push(`Audio upload: ${errorText(uploadResult.reason)}`);
  }

  const attemptRow = {
    client_attempt_id: attemptId,
    user_id: currentUser.id,
    item_id: item.id,
    test_run_id: null,
    mode: "practice",
    attempt_number: attemptNumber,
    client_started_at: new Date(recordingStartedAt).toISOString(),
    prompt_finished_at: promptShownAt
      ? new Date(promptShownAt).toISOString()
      : null,
    speech_started_at: null,
    recording_finished_at: new Date(finishedAt).toISOString(),
    reaction_time_ms: null,
    response_duration_ms: durationMs,
    used_translation: usedTranslationForCurrentItem,
    used_tts_audio: usedAudioForCurrentItem,
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
    errors.push(`Database: ${attemptInsertError.message}`);
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

  showEvaluation({
    item,
    whisper,
    pronunciation,
    finalScore,
    errors
  });

  setBusy(false);
  $("record-button").disabled = false;

  if (errors.length) {
    showMessage(
      "Nisy olana ara-teknika tamin'ny fanombanana. " +
      "Jereo ny antsipiriany etsy ambany.",
      true
    );
  } else {
    showMessage("Fanombanana vita.", false);
  }
}

function errorText(error) {
  if (!error) return "Unknown error";
  return error.message || String(error);
}

async function getNextAttemptNumber(itemId) {
  const { count, error } = await supabaseClient
    .from("learn_attempts")
    .select("id", { count: "exact", head: true })
    .eq("user_id", currentUser.id)
    .eq("item_id", itemId)
    .eq("mode", "practice");

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

  const startedAt = performance.now();

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
      `Whisper returned non-JSON: ${bodyText.slice(0, 500)}`
    );
  }

  const text = String(data.text || "").trim();

  if (!text) {
    throw new Error("Whisper returned an empty transcript.");
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
    usage: data.usage || null,
    elapsedMs: Math.round(performance.now() - startedAt)
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

  const startedAt = performance.now();

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
            {
              type: "text",
              text: prompt
            },
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
      `Hydrogen returned non-JSON: ${bodyText.slice(0, 500)}`
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
      ? ` NanoGPT notice: ${data.x_nanogpt_notice}`
      : "";

    throw new Error(
      `Could not find JSON in Hydrogen response: ` +
      `${content.slice(0, 500)}.${notice}`
    );
  }

  let result;

  try {
    result = JSON.parse(jsonMatch[0]);
  } catch {
    throw new Error(
      `Invalid Hydrogen JSON: ${jsonMatch[0].slice(0, 500)}`
    );
  }

  if (typeof result.match !== "boolean") {
    throw new Error(
      "Hydrogen response is missing boolean field 'match'."
    );
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
    notice: data.x_nanogpt_notice || null,
    elapsedMs: Math.round(performance.now() - startedAt)
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
    throw new Error("Web Audio API is not available.");
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
  errors
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
      (recognized
        ? "Zielwort erkannt"
        : "Zielwort nicht exakt erkannt")
    );
  } else {
    addLine("Whisper: keine verwertbare Transkription.");
  }

  if (pronunciation) {
    addLine(
      `Hydrogen: ${pronunciation.match
        ? "Aussprache akzeptiert"
        : "Aussprache nicht akzeptiert"}`
    );

    if (pronunciation.ipa) {
      addLine(`Erkannte Lautfolge: ${pronunciation.ipa}`);
    }

    if (pronunciation.usage) {
      addLine(
        `Hydrogen-Tokens: ` +
        `${pronunciation.usage.prompt_tokens ?? "—"} Input / ` +
        `${pronunciation.usage.completion_tokens ?? "—"} Output`
      );
    }

    if (pronunciation.cost !== null) {
      addLine(
        `Hydrogen-Kosten: ` +
        `${Number(pronunciation.cost).toFixed(6)} USD`
      );
    }

    if (pronunciation.notice) {
      addLine(`NanoGPT-Hinweis: ${pronunciation.notice}`);
    }
  } else {
    addLine("Hydrogen: keine verwertbare Bewertung.");
  }

  if (finalScore !== null) {
    const scoreLine = document.createElement("div");
    scoreLine.className = "score";
    scoreLine.textContent = `Score: ${finalScore}`;
    result.appendChild(scoreLine);
  } else {
    addLine("Kein Score: technische Bewertung unvollständig.");
  }

  if (errors.length) {
    addLine(`Technische Hinweise: ${errors.join(" | ")}`);
  }

  panel.classList.remove("hidden");
}

async function handleLogin(event) {
  event.preventDefault();

  $("login-message").textContent = "Checking access code...";
  currentApiKey = null;
  $("api-key").value = "";

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
  $("api-key").value = apiKey;

  try {
    await enterApp(data.user);
    $("login-message").textContent = "";
  } catch (profileError) {
    console.error(profileError);
    currentApiKey = null;
    $("api-key").value = "";
    await supabaseClient.auth.signOut();
    $("login-message").textContent =
      profileError.message || "Could not load learner profile.";
  }
}

$("login-form").addEventListener("submit", handleLogin);

$("lesson-select").addEventListener("change", async event => {
  await loadItems(event.target.value);
});

$("reveal-button").addEventListener("click", revealTranslation);
$("play-audio-button").addEventListener("click", playTts);
$("record-button").addEventListener("click", startRecording);
$("stop-button").addEventListener("click", stopRecording);

$("repeat-button").addEventListener("click", async () => {
  const item = currentItem();
  if (!item) return;

  await logEvent("item_repeated", item, { index: currentIndex });
  renderItem();
});

$("skip-button").addEventListener("click", async () => {
  const item = currentItem();
  if (!item || !items.length || isBusy) return;

  await logEvent("item_skipped", item, { index: currentIndex });
  currentIndex = (currentIndex + 1) % items.length;
  renderItem();
});

$("logout-button").addEventListener("click", async () => {
  currentApiKey = null;
  $("api-key").value = "";

  await supabaseClient.auth.signOut();
  location.reload();
});

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

  const lesson = lessons.find(item => item.id === lessonId);
  $("lesson-title").textContent = lesson?.title || "";

  await logEvent("lesson_opened", null, {
    lessonId,
    itemCount: items.length
  });

  showMessage("");
  renderItem();
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
