import OpenAI from "openai";

// Lazy-initialized so module import during `next build` doesn't throw when
// GROQ_API_KEY is not set in the build environment (only needed at runtime).
let _groq: OpenAI | null = null;
function getGroq(): OpenAI {
  if (!_groq) {
    _groq = new OpenAI({
      apiKey:  process.env.GROQ_API_KEY,
      baseURL: "https://api.groq.com/openai/v1",
    });
  }
  return _groq;
}

export interface ProviderResult {
  text: string;
  /** Total tokens reported by the provider for this call (null if unavailable). */
  totalTokens: number | null;
}

/**
 * Groq's JSON validator 400s ("Failed to validate JSON") carry the offending
 * generation in `error.failed_generation`. Surface a snippet on the thrown
 * error so dead-letter rows are triageable (truncation vs malformed output).
 * 2026-10-15: pass-1 archive truncation at maxTokens:400 was invisible without
 * this — see OPERATIONS incident log.
 */
function enrichGroqError(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  const body  = (err as { error?: Record<string, unknown> }).error;
  const inner = (body?.error ?? body) as Record<string, unknown> | undefined;
  const gen   = inner?.failed_generation;
  if (typeof gen !== "string" || gen.length === 0) return err;
  const snippet = gen.length > 300 ? `${gen.slice(0, 300)}…` : gen;
  err.message = `${err.message} | failed_generation: ${snippet}`;
  return err;
}

export async function callGroq(
  model: string,
  system: string,
  user: string,
  opts: {
    temperature?: number;
    maxTokens?: number;
    jsonMode?: boolean;
    timeoutMs?: number;
    /** Groq extension for reasoning models (gpt-oss): bounds the hidden
     *  chain-of-thought burn. Probed 2026-10-15: gpt-oss-20b reasoning varied
     *  507–1132 tokens per call and occasionally exceeded the cap entirely
     *  (empty content); "low" pinned it to 15–27 tokens with no output loss. */
    reasoningEffort?: "low" | "medium" | "high";
  } = {}
): Promise<ProviderResult> {
  const groq = getGroq();
  const params: Parameters<typeof groq.chat.completions.create>[0] = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user",   content: user },
    ],
    temperature: opts.temperature ?? 0.8,
    max_tokens:  opts.maxTokens  ?? 600,
    stream:      false,
  };

  // response_format: { type: "json_object" } — Groq model support matrix.
  // Re-verified 2026-07-16 against live Groq API via scripts/verify-groq-json-mode.ts
  // (qwen/qwen3-32b deprecates 2026-07-17; see JSON_MODE_SUPPORTED in providers/index.ts,
  // the actual gate used by callAgent — this comment documents the raw model behavior):
  //
  //   llama-3.3-70b-versatile    ✗ retired by Groq 2026-08-22 (404 — moot)
  //   openai/gpt-oss-120b        ✓ SUPPORTED — previously 400'd (2026-04-25 probe); Groq's
  //                                validator no longer trips on this model's reasoning output
  //   openai/gpt-oss-20b         ✗ AVOID — under response_format json_object the model burns
  //                                thousands of reasoning tokens, exhausts the cap mid-JSON,
  //                                and 400s json_validate_failed (probed 2026-10-15: 2,153/2,500
  //                                reasoning tokens; w/o jsonMode: 381 reasoning + clean parse).
  //                                Kept out of JSON_MODE_SUPPORTED; use prompt JSON + json-helpers.
  //   qwen/qwen3.6-27b           ✓ SUPPORTED, but preview-tier — not wired into prod config
  //   qwen/qwen3-32b             ✗ 400 error (deprecated 2026-07-17 — moot)
  //
  // For any future model not in JSON_MODE_SUPPORTED, rely on
  // lib/agents/json-helpers.ts sanitizer + extractor instead.
  //
  // TODO (before Phase 3): centralise per-model config into lib/agents/model-config.ts
  // so adding new models in Phase 3 doesn't require auditing scattered conditionals.
  if (opts.jsonMode) {
    // @ts-ignore — response_format is valid per Groq's OpenAI-compatible API
    params.response_format = { type: "json_object" };
  }
  if (opts.reasoningEffort) {
    // @ts-ignore — reasoning_effort is a Groq extension for reasoning models
    params.reasoning_effort = opts.reasoningEffort;
  }

  // Cast through unknown: create() returns ChatCompletion|Stream union; we never use streaming.
  type ChatBody = {
    choices?: Array<{ message: { content: string | null } }>;
    usage?: { total_tokens?: number };
  };
  let response: ChatBody;
  try {
    response = await groq.chat.completions.create(params, { signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000) }) as unknown as ChatBody;
  } catch (err) {
    throw enrichGroqError(err);
  }
  // A 200 response without `choices` is malformed (provider/proxy hiccup).
  // Throw a 502-class error so isTransientError triggers the Groq fallback
  // instead of dead-lettering a bare TypeError. See OPERATIONS incident log.
  const choice = response.choices?.[0];
  if (!choice) {
    throw Object.assign(
      new Error(`Groq returned no choices for ${model} (malformed 200 response)`),
      { status: 502 }
    );
  }
  const text = choice.message?.content ?? "";
  const totalTokens =
    typeof response.usage?.total_tokens === "number" ? response.usage.total_tokens : null;
  return { text, totalTokens };
}
