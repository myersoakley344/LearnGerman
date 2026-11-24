export const SUPABASE_URL =
  "https://coaiznrxtpdqatvfbsyi.supabase.co";

export const SUPABASE_KEY =
  "sb_publishable_D0adyb95if5W2IH5WA9JOQ_ENePqpoh";

export const NANO_API_BASE = "https://api.nano-gpt.com/api/v1";
export const PRONUNCIATION_ENDPOINT =
  `${NANO_API_BASE}/chat/completions`;

export const PRONUNCIATION_MODEL = "google/gemini-4-carbon";

export const RECORDING_BUCKET = "learn-recordings";
export const TTS_BUCKET = "learn-tts";

export const PRACTICE_RECORDING_LIMIT_MS = 20_000;
export const WORD_CHECK_LIMIT_MS = 2_000;
export const TEST_RECORDING_LIMIT_MS = 4_000;
export const RECORDING_CHUNK_MS = 100;
export const RECORDING_CHUNK_GRACE_MS = 250;
export const MAX_TEST_STARTS = 5;

export const AUDIO_SAMPLE_RATE = 16000;
export const SILENCE_WINDOW_MS = 20;
export const SILENCE_PADDING_MS = 120;
export const ABSOLUTE_SPEECH_THRESHOLD = 0.004;
export const RELATIVE_SPEECH_THRESHOLD = 0.08;

export const supabaseClient = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_KEY
);

export const state = {
  currentUser: null,
  currentApiKey: null,
  lessons: [],
  items: [],
  currentIndex: 0,

  promptShownAt: null,
  usedTranslationForCurrentItem: false,
  usedAudioForCurrentItem: false,

  wordCheckArmed: false,

  mediaRecorder: null,
  recordingStream: null,
  recordingChunks: [],
  recordingStartedAt: null,
  recordingStartedMonotonic: null,
  recordingMode: null,
  recordingItem: null,
  recordingDeadlineTimer: null,
  countdownTimer: null,
  wordCheckStartedAt: null,
  wordCheckDeadline: null,
  manualStop: false,
  isBusy: false,

  passedWordChecks: new Set(),
  lastRecordingUrl: null,

  testRunState: null,
  testEligibility: {
    starts: 0,
    completed: false,
    latestCompletedScore: null,
    latestCompletedReward: null,
    loadFailed: false
  }
};

export const $ = id => document.getElementById(id);

export function currentItem() {
  if (state.testRunState?.active) {
    return state.testRunState.queue[state.testRunState.index] || null;
  }

  return state.items[state.currentIndex] || null;
}

export function normalizeWord(text) {
  return String(text || "")
    .toLocaleLowerCase("de-DE")
    .normalize("NFC")
    .replace(/[.,!?;:"“”„()[\]{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function getNanoGPTConfig() {
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

export function parseLoginString(value) {
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

export function getRequiredWordsForTest() {
  if (state.items.length === 0) return 0;

  return Math.max(
    1,
    state.items.length - Math.ceil(state.items.length * 0.1)
  );
}

export function getPassedWordCheckCount() {
  return state.items.filter(item =>
    state.passedWordChecks.has(item.id)
  ).length;
}

export function getRecordingLimitMs(mode) {
  if (mode === "word_check") return WORD_CHECK_LIMIT_MS;
  if (mode === "test") return TEST_RECORDING_LIMIT_MS;
  if (mode === "practice") return PRACTICE_RECORDING_LIMIT_MS;
  return null;
}

export function formatTestReward(value) {
  return new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4
  }).format(Number(value) || 0);
}

export function shuffleItems(source) {
  const shuffled = [...source];

  for (let index = shuffled.length - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[other]] =
      [shuffled[other], shuffled[index]];
  }

  return shuffled;
}

export function errorText(error) {
  if (!error) return "Unbekannter Fehler";
  return error.message || String(error);
}
