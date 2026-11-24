import { blobToBase64 } from "./audio.js";
import {
  PRONUNCIATION_ENDPOINT,
  PRONUNCIATION_MODEL,
  RECORDING_BUCKET,
  TTS_BUCKET,
  state,
  supabaseClient
} from "./state.js";

export function costFromObject(data) {
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

export function costFromHeaders(headers) {
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

export async function lookupNanoCost(apiKey, requestId) {
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

export function readTokenCount(usage, fields) {
  if (!usage) return null;

  for (const field of fields) {
    const value = Number(usage[field]);
    if (Number.isFinite(value)) return value;
  }

  return null;
}

export async function logEvent(eventType, item = null, payload = {}) {
  if (!state.currentUser) return;

  const { error } = await supabaseClient
    .from("learn_events")
    .insert({
      client_event_id: crypto.randomUUID(),
      user_id: state.currentUser.id,
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

export async function logApiUsage({
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
  if (!state.currentUser) return;

  const { error } = await supabaseClient
    .from("learn_api_usage")
    .insert({
      client_request_id: crypto.randomUUID(),
      user_id: state.currentUser.id,
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

export async function getProfile(user) {
  const { data, error } = await supabaseClient
    .from("learn_profiles")
    .select("display_name, role")
    .eq("id", user.id)
    .single();

  if (error) throw error;
  return data;
}

export function getTtsUrl(path) {
  if (!path) return null;

  return supabaseClient
    .storage
    .from(TTS_BUCKET)
    .getPublicUrl(path)
    .data
    .publicUrl;
}

export async function fetchPublishedLessons() {
  return supabaseClient
    .from("learn_lessons")
    .select("id, slug, title, order_index")
    .eq("is_published", true)
    .order("order_index");
}

export async function fetchLessonItems(lessonId) {
  return supabaseClient
    .from("learn_learner_items")
    .select(
      "id, lesson_id, order_index, prompt_mg, target_de, " +
      "tts_audio_path, max_reward_eur"
    )
    .eq("lesson_id", lessonId)
    .order("order_index");
}

export async function fetchLearnerAttempts(userId, itemIds) {
  return supabaseClient
    .from("learn_attempts")
    .select(
      "item_id, mode, final_score, evaluation_status, " +
      "used_translation, used_tts_audio"
    )
    .eq("user_id", userId)
    .in("item_id", itemIds)
    .in("mode", ["practice", "word_check"])
    .limit(5000);
}

export async function fetchTestRuns(userId, lessonId) {
  return supabaseClient
    .from("learn_test_runs")
    .select(
      "id, status, voided_at, final_score, final_reward_eur, completed_at"
    )
    .eq("user_id", userId)
    .eq("lesson_id", lessonId)
    .order("started_at", { ascending: false })
    .limit(100);
}

export async function createTestRun(userId, lessonId) {
  return supabaseClient
    .from("learn_test_runs")
    .insert({
      user_id: userId,
      lesson_id: lessonId,
      status: "in_progress"
    })
    .select("id")
    .single();
}

export async function updateTestRun(runId, userId, values) {
  return supabaseClient
    .from("learn_test_runs")
    .update(values)
    .eq("id", runId)
    .eq("user_id", userId);
}

export async function completeTestRun(runId, finalScore, finalRewardEur) {
  return supabaseClient.rpc("complete_learn_test_run", {
    p_run_id: runId,
    p_final_score: finalScore,
    p_final_reward_eur: finalRewardEur
  });
}

// TEMPORÄR: Reset für Testphase; später entfernen
export async function resetAllTests() {
  return supabaseClient.rpc("reset_my_tests");
}

export async function insertAttempt(row, { returnId = false } = {}) {
  const query = supabaseClient
    .from("learn_attempts")
    .insert(row);

  if (returnId) {
    return query.select("id").single();
  }

  return query;
}

export async function uploadRecording(path, blob) {
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

export async function getNextAttemptNumber(itemId, mode) {
  const { count, error } = await supabaseClient
    .from("learn_attempts")
    .select("id", { count: "exact", head: true })
    .eq("user_id", state.currentUser.id)
    .eq("item_id", itemId)
    .eq("mode", mode);

  if (error) {
    console.warn("Could not count previous attempts:", error);
    return 1;
  }

  return (count || 0) + 1;
}

export async function callPronunciationModel({ apiKey, item, wavBlob }) {
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
