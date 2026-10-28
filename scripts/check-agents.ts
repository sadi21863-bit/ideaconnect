import "dotenv/config";
import { config } from "dotenv";
config({ path: ".env.local" });
import { ALL_AGENTS, type Agent } from "../lib/agents/personas";
import OpenAI from "openai";

const PROBE_SYSTEM = "You are a test probe. Respond with exactly one word.";
const PROBE_USER   = "Say OK";

interface Result {
  id:       string;
  handle:   string;
  provider: string;
  model:    string;
  status:   "OK" | "FAIL";
  latencyMs: number;
  error?:   string;
  /** Concrete model that served (OpenRouter reports this for `models` chains). */
  servedBy?: string;
  /** Set when the primary failed and a fallback served — production is fine,
   *  but the chain needs pruning. */
  degraded?: string;
}

function getGroqClient(): OpenAI {
  return new OpenAI({
    apiKey:  process.env.GROQ_API_KEY ?? "",
    baseURL: "https://api.groq.com/openai/v1",
  });
}

function getGitHubClient(): OpenAI {
  return new OpenAI({
    apiKey:  process.env.GH_MODELS_TOKEN ?? process.env.GITHUB_TOKEN ?? "",
    baseURL: "https://models.github.ai/inference",
  });
}

function getOpenRouterClient(): OpenAI {
  return new OpenAI({
    apiKey:  process.env.OPENROUTER_API_KEY ?? process.env.OPEN_ROUTER_API_KEY ?? "",
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: {
      "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL ?? "https://ideaconnect.local",
      "X-Title": "IdeaConnect AI Lab",
    },
  });
}

async function probe(
  client: OpenAI,
  model: string,
  maxTokens = 10,
  timeoutMs = 15_000
): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const start = Date.now();
  try {
    await client.chat.completions.create(
      {
        model,
        messages: [
          { role: "system", content: PROBE_SYSTEM },
          { role: "user",   content: PROBE_USER },
        ],
        max_tokens: maxTokens,
        temperature: 0,
      },
      { signal: AbortSignal.timeout(timeoutMs) }
    );
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, latencyMs: Date.now() - start, error: msg };
  }
}

/** Probe the same `models` chain production uses, so a retired primary is
 *  reported as DEGRADED (still serving) instead of failing the workflow. */
async function probeOpenRouter(
  client: OpenAI,
  agent: Agent,
  timeoutMs = 30_000
): Promise<{
  ok: boolean;
  latencyMs: number;
  error?: string;
  servedBy?: string;
  degraded?: string;
}> {
  const start = Date.now();
  const chain = [agent.model, ...(agent.fallbackModels ?? [])].filter(Boolean);
  try {
    const params: Record<string, unknown> = {
      messages: [
        { role: "system", content: PROBE_SYSTEM },
        { role: "user",   content: PROBE_USER },
      ],
      max_tokens: 10,
      temperature: 0,
    };
    if (chain.length > 1) params.models = chain;
    else params.model = agent.model;

    const res = (await client.chat.completions.create(
      params as unknown as Parameters<typeof client.chat.completions.create>[0],
      { signal: AbortSignal.timeout(timeoutMs) }
    )) as unknown as { model?: string };

    const servedBy = res.model;
    const degraded =
      servedBy && servedBy !== agent.model
        ? `primary ${agent.model} unavailable — served by ${servedBy}`
        : undefined;
    return { ok: true, latencyMs: Date.now() - start, servedBy, degraded };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, latencyMs: Date.now() - start, error: msg };
  }
}

async function main() {
  console.log("\n🔍 IdeaConnect Agent Diagnostic\n");
  console.log(`ENV: GROQ_API_KEY       = ${process.env.GROQ_API_KEY    ? "✓ set" : "✗ MISSING"}`);
  console.log(`ENV: OPENROUTER_API_KEY = ${(process.env.OPENROUTER_API_KEY ?? process.env.OPEN_ROUTER_API_KEY) ? "✓ set" : "✗ MISSING"}`);
  console.log(`ENV: GITHUB_TOKEN       = ${process.env.GITHUB_TOKEN    ? "✓ set" : "✗ MISSING"}`);
  console.log("");

  const groq   = getGroqClient();
  const github = getGitHubClient();
  const openrouter = getOpenRouterClient();

  const results: Result[] = [];

  for (const agent of ALL_AGENTS) {
    process.stdout.write(`  Testing @${agent.handle.padEnd(16)} (${agent.provider.padEnd(10)}) ${agent.model} ... `);

    let client: OpenAI;
    switch (agent.provider) {
      case "groq":       client = groq;   break;
      case "github":     client = github; break;
      case "openrouter": client = openrouter; break;
      default:
        console.log("SKIP (unknown provider)");
        continue;
    }

    const outcome =
      agent.provider === "openrouter"
        ? await probeOpenRouter(openrouter, agent)
        : await probe(client, agent.model);
    const { ok, latencyMs, error } = outcome;
    const { servedBy, degraded } = outcome as { servedBy?: string; degraded?: string };

    const statusStr = ok ? (degraded ? "⚠️  OK via fallback" : "✅ OK") : "❌ FAIL";
    console.log(
      `${statusStr} (${latencyMs}ms)` +
        `${degraded ? ` — ${degraded}` : ""}` +
        `${error ? ` — ${error.slice(0, 120)}` : ""}`
    );
    if (degraded) {
      console.log(
        `::warning::@${agent.handle}: ${degraded}. Update MODEL_FALLBACKS in lib/agents/personas.ts.`
      );
    }

    results.push({
      id:        agent.id,
      handle:    agent.handle,
      provider:  agent.provider,
      model:     agent.model,
      status:    ok ? "OK" : "FAIL",
      latencyMs,
      error,
      servedBy,
      degraded,
    });
  }

  console.log("\n── SUMMARY ─────────────────────────────────────────────────────────");

  const passing = results.filter(r => r.status === "OK");
  const failing = results.filter(r => r.status === "FAIL");
  const degraded = results.filter(r => r.degraded);

  console.log(`  ✅ Passing: ${passing.length}/${results.length}`);
  if (degraded.length) {
    console.log(`  ⚠️  Degraded (primary retired; a fallback served): ${degraded.length}`);
    for (const r of degraded) {
      console.log(`    @${r.handle}: ${r.degraded}`);
    }
  }
  if (failing.length) {
    console.log(`  ❌ Failing: ${failing.length}/${results.length}`);
    console.log("");
    console.log("  Failed agents:");
    for (const r of failing) {
      console.log(`    @${r.handle} (${r.provider} / ${r.model})`);
      if (r.error) console.log(`      Error: ${r.error.slice(0, 200)}`);
    }
  }

  console.log("────────────────────────────────────────────────────────────────────\n");

  process.exit(failing.length > 0 ? 1 : 0);
}

main().catch(err => {
  console.error("Diagnostic failed:", err);
  process.exit(1);
});
