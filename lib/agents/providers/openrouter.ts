import OpenAI from "openai";
import type { ProviderResult } from "./groq";

// Lazy-initialized so module import during `next build` doesn't throw when
// OPENROUTER_API_KEY is not set in the build environment (only needed at runtime).
let _openrouter: OpenAI | null = null;
function getOpenRouter(): OpenAI {
  if (!_openrouter) {
    _openrouter = new OpenAI({
      apiKey:  process.env.OPENROUTER_API_KEY ?? process.env.OPEN_ROUTER_API_KEY,
      baseURL: "https://openrouter.ai/api/v1",
    });
  }
  return _openrouter;
}

export async function callOpenRouter(
  model: string,
  system: string,
  user: string,
  opts: {
    temperature?: number;
    maxTokens?: number;
    jsonMode?: boolean;
    timeoutMs?: number;
    /** OpenRouter priority-ordered fallbacks, sent as the `models` array. */
    fallbackModels?: string[];
  } = {}
): Promise<ProviderResult> {
  const openrouter = getOpenRouter();
  const fallbacks = (opts.fallbackModels ?? []).filter((m) => m && m !== model);
  // `model` and `models` are mutually exclusive on OpenRouter. With `models`,
  // the primary must be the first entry; OpenRouter falls through on 404/429/
  // 5xx/moderation and reports the model that served in `response.model`.
  const params: Record<string, unknown> = {
    messages: [
      { role: "system", content: system },
      { role: "user",   content: user },
    ],
    temperature: opts.temperature ?? 0.8,
    max_tokens:  opts.maxTokens  ?? 600,
    stream:      false,
  };
  if (fallbacks.length > 0) {
    params.models = [model, ...fallbacks];
  } else {
    params.model = model;
  }

  // response_format passthrough — OpenRouter forwards it to providers that
  // support native JSON mode. Verified live 2026-08-22 via
  // scripts/test-openrouter-json.ts:
  //
  //   nvidia/nemotron-3-ultra-550b-a55b:free   ✓ SUPPORTED (~4.5s)
  //   nvidia/nemotron-3.5-lightning            ✓ SUPPORTED (~1.4s, fastest)
  //   nvidia/nemotron-3-nano-30b-a3b:free      ✓ SUPPORTED (~1.7s)
  //   google/gemma-4-31b-it:free               ✓ SUPPORTED but flaky 429s — avoid
  //   z-ai/glm-5.2:free                        ✗ persistent 429 rate-limited
  //   thinkingmachines/inkling:free            ✗ 403 agentic-harness only
  //
  // The authoritative gate used by callAgent is JSON_MODE_SUPPORTED in
  // providers/index.ts; for anything not listed there,
  // lib/agents/json-helpers.ts sanitizer + extractor handles prompt-only JSON.
  if (opts.jsonMode) {
    // @ts-ignore — response_format is valid per OpenAI-compatible APIs
    params.response_format = { type: "json_object" };
  }

  // Optional headers per OpenRouter docs (attribution); harmless if unset.
  const extraHeaders = {
    "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL ?? "https://ideaconnect.local",
    "X-Title": "IdeaConnect AI Lab",
  };

  const response = await openrouter.chat.completions.create(
    params as unknown as Parameters<typeof openrouter.chat.completions.create>[0],
    {
      signal: AbortSignal.timeout(opts.timeoutMs ?? 45_000),
      // @ts-ignore — extra headers allowed per-request
      headers: extraHeaders,
    }
  ) as unknown as {
    choices?: Array<{ message: { content: string | null } }>;
    usage?: { total_tokens?: number };
    model?: string;
  };
  // A 200 response without `choices` is malformed (provider/proxy hiccup).
  // Throw a 502-class error so isTransientError triggers the Groq fallback
  // instead of dead-lettering a bare TypeError. See OPERATIONS incident log.
  const choice = response.choices?.[0];
  if (!choice) {
    throw Object.assign(
      new Error(`OpenRouter returned no choices for ${model} (malformed 200 response)`),
      { status: 502 }
    );
  }
  // With a fallback chain the response reports the concrete model that served.
  // Log only when the chain fired so a retirement is visible in production logs
  // without editing code (and without adding noise on the normal path).
  if (fallbacks.length > 0 && response.model && response.model !== model) {
    console.warn(
      `[openrouter] primary ${model} unavailable; served by ${response.model}`
    );
  }
  const text = choice.message?.content ?? "";
  const totalTokens =
    typeof response.usage?.total_tokens === "number" ? response.usage.total_tokens : null;
  return { text, totalTokens };
}
