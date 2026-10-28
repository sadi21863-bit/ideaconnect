import { callGroq } from "./groq";
import { callOpenRouter } from "./openrouter";
import { stripThinkingTags, normalizeHyphens } from "../response-cleaner";
import type { Agent } from "../personas";

/** Errors that should trigger fallback to the small Groq model. */
function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : "";
  const status = (err as { status?: number })?.status;
  // 429 = rate limit, 5xx = server error, ETIMEDOUT/ECONNRESET = network
  if (status === 429 || (status && status >= 500 && status < 600)) return true;
  return /rate.?limit|timeout|econnreset|etimedout|service unavailable/.test(msg);
}

// Models that support response_format: { type: "json_object" } on Groq.
// Re-verified 2026-07-16 via scripts/verify-groq-json-mode.ts against live Groq API
// (ahead of the qwen/qwen3-32b deprecation on 2026-07-17):
//   openai/gpt-oss-120b       ✓ PASS — no longer 400s; Groq's validator no longer
//                                trips on this model's reasoning-tag output.
//   qwen/qwen3.6-27b          ✓ PASS, but preview-tier per Groq docs — not wired
//                                into production agent config, so omitted here.
// 2026-08-22: llama-3.3-70b-versatile removed from this set — Groq retired the
// model entirely (404 on all calls; absent from /v1/models). Scout/Conductor/
// Research migrated to gpt-oss models in personas.ts.
// 2026-10-15: openai/gpt-oss-20b removed — with response_format json_object the
// model spends thousands of reasoning tokens before emitting the answer (2,153
// of a 2,500 cap in a live probe). On large prompts (archive pass 1, post_idea)
// the cap is exhausted mid-JSON and Groq 400s "json_validate_failed" with an
// EMPTY failed_generation. The 2026-07-16 probe only used tiny prompts, where
// the burn is small. Without response_format the same prompt spent 381
// reasoning + 385 answer tokens and parsed cleanly. All gpt-oss-20b paths
// already parse via json-helpers (parseJsonResponse), so prompt-instructed
// JSON is the correct path for this model.
const JSON_MODE_SUPPORTED = new Set([
  "openai/gpt-oss-120b",
  // OpenRouter free tier — verified live 2026-08-22 (scripts/test-openrouter-json.ts)
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "nvidia/nemotron-3.5-lightning",
  "nvidia/nemotron-3.5-lightning:free",
  "nvidia/nemotron-3-nano-30b-a3b:free",
  // 2026-10-27: super-vl verified with response_format json_object (valid
  // title/pitch/content JSON, 535 completion tokens) as Scout's fallback.
  "nvidia/nemotron-3.5-super-vl:free",
  // The free router filters candidates by capability when response_format is
  // present. JSON validity is only ~50% (probed 2026-10-27), which is why it is
  // the LAST fallback entry, never a primary.
  "openrouter/free",
]);

// GPT-OSS is a reasoning model that can consume many tokens on chain-of-thought
// before producing visible output. Raise its floor to avoid empty responses.
const GPTOSS_MODEL = "openai/gpt-oss-120b";
// Raised 1200 → 2500: post_idea requires 500–800 tokens of JSON output (title +
// pitch + 200–500 word content field). GPT-OSS burns 400–800 tokens of internal
// chain-of-thought first. At 1200 the reasoning overhead exhausted the budget,
// truncating the JSON and causing every post_idea to fail with "Invalid JSON".
// Comments worked because their output (~300 tokens) fit within the old floor.
// Extra headroom for short outputs costs nothing — models stop when done.
const GPTOSS_MIN_TOKENS = 2500;

// Fallback model for transient errors (GitHub Models down, Groq 429/5xx).
// llama-3.1-8b-instant → openai/gpt-oss-20b 2026-07-16, alongside the
// qwen/qwen3-32b deprecation cleanup (see JSON_MODE_SUPPORTED above for
// verification — gpt-oss-20b passes Groq's native JSON mode).
const FALLBACK_MODEL = process.env.AGENT_MODEL_FALLBACK ?? "openai/gpt-oss-20b";

export interface CallAgentOpts {
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  /** Groq extension for reasoning models (gpt-oss): bounds the hidden
   *  chain-of-thought burn. Passed through to callGroq; ignored by
   *  callOpenRouter. See providers/groq.ts for the measured numbers. */
  reasoningEffort?: "low" | "medium" | "high";
  /** Mutable box — callAgent fills it with provider-reported total tokens so
   *  callers can record real usage in aiUsage.tokens. */
  usageOut?: { tokens: number };
}

export async function callAgent(
  agent: Agent,
  userPrompt: string,
  opts?: CallAgentOpts
): Promise<string> {
  // Per-model overrides before calling the primary provider
  const primaryOpts = { ...opts };
  if (primaryOpts.jsonMode && !JSON_MODE_SUPPORTED.has(agent.model)) {
    // Don't forward jsonMode for models that don't support it
    delete primaryOpts.jsonMode;
  }
  // Use opts.maxTokens if given; else fall back to agent.maxTokens; else a
  // budget floor. JSON outputs get 2500: a reasoning model can burn the whole
  // completion budget before emitting the JSON (empty HTTP 200), which
  // json-helpers cannot recover from. Extra headroom is free — models stop.
  const JSON_MIN_TOKENS = 2500;
  if (!primaryOpts.maxTokens) {
    primaryOpts.maxTokens =
      agent.maxTokens ??
      (primaryOpts.jsonMode
        ? JSON_MIN_TOKENS
        : agent.model === GPTOSS_MODEL
          ? GPTOSS_MIN_TOKENS
          : undefined);
  }
  delete (primaryOpts as Partial<CallAgentOpts>).usageOut;

  const callPrimary = () =>
    agent.provider === "openrouter"
      ? callOpenRouter(agent.model, agent.persona, userPrompt, {
          ...primaryOpts,
          // Priority-ordered free fallbacks: a retired primary 404s through to
          // the next slug instead of dead-lettering the item.
          fallbackModels: agent.fallbackModels,
        })
      : callGroq(agent.model, agent.persona, userPrompt, primaryOpts);

  try {
    // normalizeHyphens: GPT-OSS emits U+2011/U+2012 non-breaking hyphens in narrative text.
    // Normalize to standard hyphen-minus before storage.
    const res = await callPrimary();
    if (opts?.usageOut && res.totalTokens) opts.usageOut.tokens += res.totalTokens;
    return normalizeHyphens(stripThinkingTags(res.text));
  } catch (err) {
    if (!isTransientError(err)) throw err;

    // Cross-provider safety net: any transient failure falls back to Groq's
    // small model. OpenRouter free tier 429s/5xx are common — this keeps
    // Scout/Conductor/Research alive during provider brownouts.
    try {
      console.warn(
        `[ai-lab] ${agent.provider} failed for ${agent.handle} (${agent.model}); falling back to Groq ${FALLBACK_MODEL}. Error: ${(err as Error).message}`
      );
      // Gate jsonMode here too: `opts` is the raw caller request, so without
      // this the fallback could forward response_format to a model that 400s
      // on it (gpt-oss-20b since 2026-10-15 — see JSON_MODE_SUPPORTED above).
      //
      // Carry the RESOLVED budget (primaryOpts), not a hardcoded 600. Forcing
      // 600 discarded explicit/computed caps — Conductor 2000 and the JSON-mode
      // 2500 floor — so a provider outage would make gpt-oss-20b burn the whole
      // budget on reasoning and return EMPTY: the conductor then reads that as
      // "debate resolved → SKIP" (silent break). Budgets are still bounded by
      // the caller/agent; the fallback is rare.
      const fbOpts = { ...opts, maxTokens: primaryOpts.maxTokens ?? 600 };
      if (fbOpts.jsonMode && !JSON_MODE_SUPPORTED.has(FALLBACK_MODEL)) delete fbOpts.jsonMode;
      const fb = await callGroq(FALLBACK_MODEL, agent.persona, userPrompt, fbOpts);
      if (opts?.usageOut && fb.totalTokens) opts.usageOut.tokens += fb.totalTokens;
      return normalizeHyphens(stripThinkingTags(fb.text));
    } catch (fallbackErr) {
      console.error(
        `[ai-lab] Groq fallback (${FALLBACK_MODEL}) also failed for ${agent.handle}: ${(fallbackErr as Error).message}`
      );
      throw err;
    }
  }
}
