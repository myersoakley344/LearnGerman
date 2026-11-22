import { getTtsUrl, logEvent } from "./api.js";
import {
  $,
  MAX_TEST_STARTS,
  REQUIRED_SUCCESSES_PER_WORD,
  currentItem,
  formatTestReward,
  getPreparedWordCount,
  getRequiredPreparedWords,
  state
} from "./state.js";

export function showMessage(text, isError = false) {
  const element = $("app-message");
  element.textContent = text;
  element.style.color = isError ? "#a12626" : "#236b37";
}

export function setBusy(value) {
  state.isBusy = value;

  $("lesson-select").disabled =
    value || Boolean(state.testRunState?.active) || state.wordCheckArmed;

  $("reveal-button").disabled = value;
  $("play-audio-button").disabled = value;
  $("record-button").disabled = value;
  $("word-check-cancel-button").disabled = value;
  $("repeat-button").disabled = value;
  $("skip-button").disabled = value;

  // TEMPORÄR: Reset-Button für die Testphase
  const resetButton = $("reset-tests-button");
  if (resetButton) resetButton.disabled = value;

  updateWordCheckButton();
  renderTestControls();
}

export function renderTestControls() {
  const startButton = $("test-start-button");
  const status = $("test-status");
  const abandonButton = $("test-abandon-button");
  const reward = $("test-provisional-reward");

  if (!startButton || !status || !abandonButton || !reward) return;

  const active = Boolean(state.testRunState?.active);
  abandonButton.classList.toggle("hidden", !active);

  if (active) {
    const total = state.testRunState.queue.length;
    const completed = state.testRunState.index;

    status.textContent =
      `Test läuft: ${completed} von ${total} Wörtern beantwortet.`;

    reward.textContent =
      `Vorläufiger Betrag: ${formatTestReward(state.testRunState.reward)}`;
    reward.classList.remove("hidden");
    startButton.textContent = "Lektionstest starten";
    startButton.disabled = true;
    return;
  }

  reward.classList.add("hidden");

  if (state.testEligibility.loadFailed) {
    startButton.textContent = "Lektionstest starten";
    status.textContent =
      "Teststatus konnte nicht geladen werden. Bitte Seite neu laden.";
    startButton.disabled = true;
    return;
  }

  if (state.testEligibility.starts >= MAX_TEST_STARTS) {
    startButton.textContent = "Lektionstest starten";

    if (state.testEligibility.completed) {
      status.textContent =
        `Startlimit (${MAX_TEST_STARTS}/${MAX_TEST_STARTS}) erreicht. ` +
        `Gültiges Ergebnis: Score ` +
        `${Number(state.testEligibility.latestCompletedScore).toFixed(2)} ` +
        `(${formatTestReward(state.testEligibility.latestCompletedReward)}).`;
    } else {
      status.textContent =
        `Das Startlimit von ${MAX_TEST_STARTS} Tests wurde erreicht.`;
    }

    startButton.disabled = true;
    return;
  }

  const required = getRequiredPreparedWords();
  const prepared = getPreparedWordCount();

  if (prepared < required) {
    startButton.textContent = "Lektionstest starten";
    status.textContent =
      `Freischaltung: ${prepared} von ${required} ausreichend vorbereiteten ` +
      "Wörtern. Jedes Wort braucht drei hilfefreie Übungserfolge.";
    startButton.disabled = true;
    return;
  }

  const remaining = MAX_TEST_STARTS - state.testEligibility.starts;

  if (state.testEligibility.completed) {
    startButton.textContent = "Lektionstest wiederholen";
    status.textContent =
      `Aktuelles gültiges Ergebnis: Score ` +
      `${Number(state.testEligibility.latestCompletedScore).toFixed(2)} ` +
      `(${formatTestReward(state.testEligibility.latestCompletedReward)}). ` +
      `Verbleibende Starts: ${remaining} von ${MAX_TEST_STARTS}. ` +
      "Ein neu abgeschlossener Test ersetzt das bisherige Ergebnis.";
  } else {
    startButton.textContent = "Lektionstest starten";
    status.textContent =
      `Freigeschaltet. Verfügbare Starts: ` +
      `${remaining} von ${MAX_TEST_STARTS}.`;
  }

  startButton.disabled = state.isBusy || state.wordCheckArmed;
}

export function renderProgress() {
  const passedCount = state.items.filter(item =>
    state.passedWordChecks.has(item.id)
  ).length;

  $("word-check-progress").textContent =
    `${passedCount} von ${state.items.length} Wörtern erfolgreich getestet`;

  const required = getRequiredPreparedWords();
  const prepared = getPreparedWordCount();

  if (!state.items.length) {
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

export function renderCurrentWordStatus() {
  const item = currentItem();
  const badge = $("current-word-status");

  if (!item) {
    badge.textContent = "";
    badge.classList.remove("passed");
    return;
  }

  if (state.passedWordChecks.has(item.id)) {
    badge.textContent = "Wort erfolgreich getestet";
    badge.classList.add("passed");
    return;
  }

  const count = state.practiceSuccessCounts.get(item.id) || 0;

  if (count >= REQUIRED_SUCCESSES_PER_WORD) {
    badge.textContent = "3/3 Übungserfolge · Wort-Check bereit";
  } else {
    badge.textContent =
      `${count}/${REQUIRED_SUCCESSES_PER_WORD} Übungserfolge · ` +
      "Wort-Check noch gesperrt";
  }

  badge.classList.remove("passed");
}

export function updateWordCheckButton() {
  const button = $("word-check-button");
  if (!button) return;

  const item = currentItem();

  if (!item) {
    button.disabled = true;
    return;
  }

  const successes = state.practiceSuccessCounts.get(item.id) || 0;

  button.disabled =
    state.isBusy ||
    state.wordCheckArmed ||
    Boolean(state.testRunState?.active) ||
    successes < REQUIRED_SUCCESSES_PER_WORD ||
    state.passedWordChecks.has(item.id);
}

export function renderItem() {
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

  state.usedTranslationForCurrentItem = false;
  state.usedAudioForCurrentItem = false;
  state.promptShownAt = null;

  if (state.lastRecordingUrl) {
    URL.revokeObjectURL(state.lastRecordingUrl);
    state.lastRecordingUrl = null;
  }

  if (!item) {
    state.wordCheckArmed = false;
    $("app-screen").classList.remove("word-check-armed");
    $("prompt").textContent = "No items in this lesson.";
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

  if (state.testRunState?.active) {
    state.wordCheckArmed = false;
    $("app-screen").classList.remove("word-check-armed");
    $("item-position").textContent =
      `Testwort ${state.testRunState.index + 1} / ` +
      `${state.testRunState.queue.length}`;

    $("reveal-button").classList.add("hidden");
    $("translation").classList.add("hidden");
    $("play-audio-button").classList.add("hidden");
    $("tts-player").classList.add("hidden");
    $("word-check-button").classList.add("hidden");
    $("word-check-cancel-button").classList.add("hidden");
    $("repeat-button").classList.add("hidden");
    $("skip-button").classList.add("hidden");

    $("record-button").textContent = "Testantwort aufnehmen";
    $("record-button").classList.remove("hidden");
    $("record-button").disabled = state.isBusy;
    $("lesson-select").disabled = true;
  } else if (state.wordCheckArmed) {
    $("app-screen").classList.add("word-check-armed");
    $("item-position").textContent =
      `Teny ${state.currentIndex + 1} / ${state.items.length} · Wort-Check`;

    $("reveal-button").classList.add("hidden");
    $("translation").classList.add("hidden");
    $("play-audio-button").classList.add("hidden");
    $("tts-player").classList.add("hidden");
    $("word-check-button").classList.add("hidden");
    $("repeat-button").classList.add("hidden");
    $("skip-button").classList.add("hidden");

    $("record-button").textContent = "Wort-Check-Aufnahme starten";
    $("record-button").classList.remove("hidden");
    $("record-button").disabled = state.isBusy;
    $("word-check-cancel-button").classList.remove("hidden");
    $("word-check-cancel-button").disabled = state.isBusy;
    $("lesson-select").disabled = true;
  } else {
    $("app-screen").classList.remove("word-check-armed");
    $("item-position").textContent =
      `Teny ${state.currentIndex + 1} / ${state.items.length}`;

    $("reveal-button").classList.remove("hidden");
    $("play-audio-button").classList.remove("hidden");
    $("word-check-button").classList.remove("hidden");
    $("word-check-cancel-button").classList.add("hidden");
    $("repeat-button").classList.remove("hidden");
    $("skip-button").classList.remove("hidden");

    $("record-button").textContent = "Aufnahme mit Bewertung";
    $("record-button").classList.remove("hidden");
    $("lesson-select").disabled = state.isBusy;

    $("reveal-button").disabled = state.isBusy;
    $("play-audio-button").disabled =
      state.isBusy || !item.tts_audio_path;
    $("record-button").disabled = state.isBusy;
    $("repeat-button").disabled = state.isBusy;
    $("skip-button").disabled = state.isBusy;
  }

  renderProgress();

  if (!state.wordCheckArmed) {
    logEvent("item_shown", item, { index: state.currentIndex });
    showMessage("");
  }
}

export function revealTranslation() {
  const item = currentItem();
  if (
    !item ||
    state.testRunState?.active ||
    state.wordCheckArmed ||
    state.recordingMode === "word_check"
  ) {
    return;
  }

  $("translation").textContent = item.target_de;
  $("translation").classList.remove("hidden");
  state.usedTranslationForCurrentItem = true;

  logEvent("translation_revealed", item);
}

export async function playTts() {
  const item = currentItem();

  if (!item?.tts_audio_path) {
    showMessage("No TTS audio is available for this item.", true);
    return;
  }

  if (
    state.testRunState?.active ||
    state.wordCheckArmed ||
    state.recordingMode === "word_check"
  ) {
    return;
  }

  const player = $("tts-player");
  player.src = getTtsUrl(item.tts_audio_path);
  player.classList.remove("hidden");
  state.usedAudioForCurrentItem = true;

  await logEvent("tts_played", item);

  try {
    await player.play();
  } catch (error) {
    console.error(error);
    showMessage("Could not play the audio. Tap the audio player.", true);
  }
}

export function resetRecordingUi() {
  $("stop-button").classList.add("hidden");
  $("record-button").classList.remove("hidden");
  $("word-check-cancel-button").classList.add("hidden");
  $("app-screen").classList.remove("word-check-armed");

  if (state.testRunState?.active) {
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

export function showEvaluation({
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
