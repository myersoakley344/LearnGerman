import {
  completeTestRun,
  createTestRun,
  fetchLearnerAttempts,
  fetchLessonItems,
  fetchPublishedLessons,
  fetchTestRuns,
  getProfile,
  logEvent,
  resetAllTests,
  updateTestRun
} from "./api.js";
import {
  armWordCheck,
  cancelWordCheck,
  setRecordingCallbacks,
  startPracticeRecording,
  startTestRecording,
  startWordCheckRecording,
  stopRecordingManually
} from "./recording.js";
import {
  $,
  MAX_TEST_STARTS,
  currentItem,
  formatTestReward,
  getPreparedWordCount,
  getRequiredPreparedWords,
  parseLoginString,
  shuffleItems,
  state,
  supabaseClient
} from "./state.js";
import {
  playTts,
  renderItem,
  renderProgress,
  renderTestControls,
  revealTranslation,
  setBusy,
  showMessage
} from "./ui.js";

async function enterApp(user) {
  const profile = await getProfile(user);

  if (profile.role !== "learner") {
    throw new Error("This account is not a learner account.");
  }

  state.currentUser = user;
  $("login-screen").classList.add("hidden");
  $("app-screen").classList.remove("hidden");
  $("participant-name").textContent =
    profile.display_name || user.email || "";

  await loadLessons();
}

async function loadLessons() {
  showMessage("Loading lessons...");

  const { data, error } = await fetchPublishedLessons();

  if (error) {
    console.error(error);
    showMessage(error.message, true);
    return;
  }

  state.lessons = data || [];

  const select = $("lesson-select");
  select.replaceChildren();

  for (const lesson of state.lessons) {
    const option = document.createElement("option");
    option.value = lesson.id;
    option.textContent = lesson.title;
    select.appendChild(option);
  }

  if (!state.lessons.length) {
    state.items = [];
    renderItem();
    showMessage("No published lessons found.", true);
    return;
  }

  await loadItems(state.lessons[0].id);
}

async function loadItems(lessonId) {
  if (state.testRunState?.active || state.wordCheckArmed) {
    showMessage(
      "Während eines Tests oder Wort-Checks kann die Lektion nicht " +
      "gewechselt werden."
    );
    return;
  }

  showMessage("Loading lesson...");

  const { data, error } = await fetchLessonItems(lessonId);

  if (error) {
    console.error(error);
    state.items = [];
    renderItem();
    showMessage(error.message, true);
    return;
  }

  state.items = data || [];
  state.currentIndex = 0;
  state.testRunState = null;
  state.wordCheckArmed = false;

  const lesson = state.lessons.find(value => value.id === lessonId);
  $("lesson-title").textContent = lesson?.title || "";

  await loadLearnerProgress();
  await loadTestEligibility(lessonId);

  await logEvent("lesson_opened", null, {
    lessonId,
    itemCount: state.items.length
  });

  showMessage("");
  renderItem();
}

async function loadLearnerProgress() {
  state.practiceSuccessCounts = new Map();
  state.passedWordChecks = new Set();

  for (const item of state.items) {
    state.practiceSuccessCounts.set(item.id, 0);
  }

  if (!state.currentUser || !state.items.length) {
    renderProgress();
    return;
  }

  const itemIds = state.items.map(item => item.id);
  const { data, error } = await fetchLearnerAttempts(
    state.currentUser.id,
    itemIds
  );

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
        state.passedWordChecks.add(attempt.item_id);
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
        state.practiceSuccessCounts.get(attempt.item_id) || 0;

      state.practiceSuccessCounts.set(attempt.item_id, previous + 1);
    }
  }

  renderProgress();
}

async function loadTestEligibility(lessonId) {
  state.testEligibility = {
    starts: 0,
    completed: false,
    latestCompletedScore: null,
    latestCompletedReward: null,
    loadFailed: false
  };

  if (!state.currentUser || !lessonId) {
    renderTestControls();
    return;
  }

  const { data, error } = await fetchTestRuns(
    state.currentUser.id,
    lessonId
  );

  if (error) {
    console.error("Could not load test runs:", error);
    state.testEligibility.loadFailed = true;
    renderTestControls();
    return;
  }

  const runs = data || [];

  // Nach einem Reload wird ein offener Test als abgebrochen gezählt.
  for (const run of runs) {
    if (run.status !== "in_progress") continue;

    const { error: updateError } = await updateTestRun(
      run.id,
      state.currentUser.id,
      {
        status: "abandoned",
        completed_at: new Date().toISOString()
      }
    );

    if (updateError) {
      console.error("Could not abandon interrupted test:", updateError);
    } else {
      run.status = "abandoned";
    }
  }

  const validCompletedRun =
    runs.find(run => run.status === "completed" && !run.voided_at) || null;

  state.testEligibility.starts = runs.length;
  state.testEligibility.completed = Boolean(validCompletedRun);
  state.testEligibility.latestCompletedScore = validCompletedRun
    ? validCompletedRun.final_score
    : null;
  state.testEligibility.latestCompletedReward = validCompletedRun
    ? validCompletedRun.final_reward_eur
    : null;

  renderTestControls();
}

async function startLessonTest() {
  if (
    state.isBusy ||
    state.wordCheckArmed ||
    state.testRunState?.active
  ) {
    return;
  }

  if (!state.currentApiKey) {
    showMessage("Bitte abmelden und erneut anmelden.", true);
    return;
  }

  const lessonId = $("lesson-select").value;

  await loadTestEligibility(lessonId);

  if (
    state.testEligibility.loadFailed ||
    state.testEligibility.starts >= MAX_TEST_STARTS ||
    getPreparedWordCount() < getRequiredPreparedWords()
  ) {
    renderTestControls();
    return;
  }

  if (
    !state.items.length ||
    state.items.some(item => item.max_reward_eur == null)
  ) {
    showMessage(
      "Test konnte nicht gestartet werden. Wortbeträge fehlen; " +
      "prüfe die View learn_learner_items.",
      true
    );
    return;
  }

  if (state.testEligibility.completed) {
    const previousReward = formatTestReward(
      state.testEligibility.latestCompletedReward
    );
    const confirmed = window.confirm(
      `Du hast bereits ein gültiges Testergebnis (${previousReward}). ` +
      "Wenn du den neuen Durchgang vollständig abschließt, ersetzt er " +
      "das bisherige Ergebnis – auch wenn der Betrag niedriger ist. " +
      "Bei Abbruch bleibt dein bisheriges Ergebnis bestehen. " +
      "Neuen Durchlauf starten?"
    );

    if (!confirmed) return;
  }

  setBusy(true);
  showMessage("Lektionstest wird gestartet …");

  const { data, error } = await createTestRun(
    state.currentUser.id,
    lessonId
  );

  if (error) {
    console.error("Could not start test:", error);
    setBusy(false);
    showMessage(
      "Test konnte nicht gestartet werden: " + error.message,
      true
    );
    return;
  }

  state.testEligibility.starts += 1;
  state.testRunState = {
    id: data.id,
    lessonId,
    queue: shuffleItems(state.items),
    index: 0,
    scoreSum: 0,
    reward: 0,
    active: true
  };

  state.currentIndex = state.items.findIndex(
    item => item.id === state.testRunState.queue[0].id
  );

  await logEvent("test_started", null, {
    lessonId,
    testRunId: data.id,
    itemCount: state.items.length,
    startNumber: state.testEligibility.starts
  });

  setBusy(false);
  renderItem();
  renderTestControls();
  showMessage(
    "Der Test läuft. Tippe auf „Testantwort aufnehmen“, " +
    "um das angezeigte Wort zu beantworten."
  );
}

async function abandonLessonTest(message) {
  if (!state.testRunState?.active) return;

  const runId = state.testRunState.id;
  const lessonId = state.testRunState.lessonId;

  const { error } = await updateTestRun(runId, state.currentUser.id, {
    status: "abandoned",
    completed_at: new Date().toISOString(),
    final_score: null,
    final_reward_eur: null
  });

  if (error) {
    console.error("Could not abandon test:", error);
  }

  await logEvent("test_abandoned", null, {
    lessonId,
    testRunId: runId,
    reason: message
  });

  state.testRunState = null;
  setBusy(false);
  await loadTestEligibility(lessonId);
  renderItem();
  showMessage(message, Boolean(error));
}

async function advanceLessonTest(score, expectedRunId) {
  if (
    !state.testRunState?.active ||
    state.testRunState.id !== expectedRunId
  ) {
    return;
  }

  const answeredItem = currentItem();
  const run = state.testRunState;
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
    state.currentIndex = state.items.findIndex(
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

  const { error } = await completeTestRun(
    run.id,
    finalScore,
    finalReward
  );

  if (error) {
    console.error("Could not complete test:", error);
    await abandonLessonTest(
      "Der Test konnte nicht sicher gespeichert werden. " +
      "Es wurde kein neuer Betrag gutgeschrieben."
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

  state.testRunState = null;
  await loadTestEligibility(lessonId);
  renderItem();

  showMessage(
    `Lektionstest abgeschlossen. Endscore: ${finalScore.toFixed(2)}. ` +
    `Gültiger Betrag: ${formatTestReward(finalReward)}. ` +
    "Die Auszahlung wird später manuell geprüft."
  );
}

setRecordingCallbacks({
  abandonLessonTest,
  advanceLessonTest,
  loadLearnerProgress
});

$("login-form").addEventListener("submit", async event => {
  event.preventDefault();
  $("login-message").textContent = "Anmeldung wird geprüft …";

  state.currentApiKey = null;

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

  state.currentApiKey = apiKey;

  try {
    await enterApp(data.user);
    $("login-message").textContent = "";
  } catch (profileError) {
    console.error(profileError);
    state.currentApiKey = null;
    await supabaseClient.auth.signOut();
    $("login-message").textContent =
      profileError.message || "Profil konnte nicht geladen werden.";
  }
});

$("lesson-select").addEventListener("change", async event => {
  if (state.testRunState?.active || state.wordCheckArmed) return;
  await loadItems(event.target.value);
});

$("reveal-button").addEventListener("click", revealTranslation);
$("play-audio-button").addEventListener("click", playTts);

$("record-button").addEventListener("click", () => {
  if (state.testRunState?.active) {
    startTestRecording();
  } else if (state.wordCheckArmed) {
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
  if (!state.testRunState?.active || state.isBusy || state.mediaRecorder) {
    return;
  }

  const confirmed = window.confirm(
    "Test abbrechen? Die vorläufige Summe dieses Durchgangs wird verworfen; " +
    "ein früheres gültiges Ergebnis bleibt erhalten."
  );

  if (confirmed) {
    await abandonLessonTest(
      "Test abgebrochen. Die vorläufige Summe wurde verworfen."
    );
  }
});

$("repeat-button").addEventListener("click", async () => {
  const item = currentItem();
  if (
    !item ||
    state.isBusy ||
    state.mediaRecorder ||
    state.wordCheckArmed ||
    state.testRunState?.active
  ) {
    return;
  }

  await logEvent("item_repeated", item, { index: state.currentIndex });
  renderItem();
});

$("skip-button").addEventListener("click", async () => {
  if (
    !state.items.length ||
    state.isBusy ||
    state.mediaRecorder ||
    state.wordCheckArmed ||
    state.testRunState?.active
  ) {
    return;
  }

  const item = currentItem();

  if (item) {
    await logEvent("item_skipped", item, { index: state.currentIndex });
  }

  state.currentIndex = (state.currentIndex + 1) % state.items.length;
  renderItem();
});

// TEMPORÄR: Reset-Button für die Testphase; später entfernen
$("reset-tests-button")?.addEventListener("click", async () => {
  if (state.isBusy || state.mediaRecorder) return;

  const confirmed = window.confirm(
    "Alle gespeicherten Endtests und Wort-Checks zurücksetzen? " +
    "(Übungserfolge bleiben erhalten.)"
  );

  if (!confirmed) return;

  setBusy(true);
  showMessage("Gespeicherte Tests werden zurückgesetzt …");

  const { error } = await resetAllTests();

  if (error) {
    console.error("Could not reset tests:", error);
    setBusy(false);
    showMessage(
      "Zurücksetzen fehlgeschlagen (wurde das SQL für reset_my_tests " +
      "ausgeführt?): " + error.message,
      true
    );
    return;
  }

  state.testRunState = null;
  state.wordCheckArmed = false;

  const lessonId = $("lesson-select").value;
  await loadLearnerProgress();
  await loadTestEligibility(lessonId);

  setBusy(false);
  renderItem();
  showMessage("Alle Endtests und Wort-Checks wurden zurückgesetzt.", false);
});

$("logout-button").addEventListener("click", async () => {
  state.currentApiKey = null;
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
