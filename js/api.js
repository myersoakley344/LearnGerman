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

export async function fetchWordCheckAttempts(userId, itemIds) {
  return supabaseClient
    .from("learn_attempts")
    .select("item_id, final_score, evaluation_status")
    .eq("user_id", userId)
    .in("item_id", itemIds)
    .eq("mode", "word_check")
    .limit(5000);
}

export async function fetchTestRuns(userId, lessonId) {
  return supabaseClient
    .from("learn_test_runs")
    .select(
      "id, status, voided_at, final_score, final_reward_eur, completed_at"
    )
    .eq
