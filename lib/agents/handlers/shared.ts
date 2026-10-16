import { db } from "@/db";
import { aiUsage, ideaComments, ideas } from "@/db/schema";
import { and, eq, gte, sql } from "drizzle-orm";
import { getResearchAgent } from "../personas";
import { callGroq } from "../providers/groq";
import type { SourceCitation } from "../research";

export const AI_LAB_ROOM_ID = process.env.AI_LAB_ROOM_ID!;

/** Minimum text length accepted for ideas and comments. */
export const MIN_CONTENT_LENGTH = 50;

// ── Shared usage upsert ──────────────────────────────────────────────────────

export async function upsertUsage(
  agentId:  string,
  date:     string,
  provider  = "groq",
  feature   = "ai_lab",
  tokens    = 0,
): Promise<void> {
  await db
    .insert(aiUsage)
    .values({ agentId, date, requestCount: 1, lastRequestAt: new Date(), lastProvider: provider, feature, tokens })
    .onConflictDoUpdate({
      target: [aiUsage.agentId, aiUsage.date],
      targetWhere: sql`${aiUsage.agentId} IS NOT NULL AND ${aiUsage.date} IS NOT NULL`,
      set: {
        requestCount: sql`${aiUsage.requestCount} + 1`,
        lastRequestAt: new Date(),
        lastProvider: provider,
        tokens: sql`${aiUsage.tokens} + ${tokens}`,
        feature,
      },
    });
}

// ── Research pre-call ────────────────────────────────────────────────────────

export async function shouldFetchResearch(
  ideaTitle: string,
  theme: string,
  actionType: string,
  usageAgentId?: string
): Promise<{ needsResearch: boolean; query: string } | null> {
  try {
    const prompt = `You are deciding whether a response to the following debate topic needs current real-world data.

DEBATE TOPIC: "${ideaTitle}"
TODAY'S THEME: "${theme}"
ACTION: ${actionType}

Does responding well to this topic require looking up current facts, statistics, or recent events?
Only say yes if the topic involves specific empirical claims, recent developments, or data that changes over time.
Say no for topics that are philosophical, speculative, or based entirely on reasoning.

Respond in JSON only:
{"needsResearch": true/false, "query": "2-5 word search query if yes, null if no"}`;

    // jsonMode off + reasoningEffort low: gpt-oss-20b 400s / empties under
    // response_format and hidden reasoning at this tiny cap (2026-10-15
    // incident class); failures here were swallowed as "no research needed".
    const res = await callGroq(
      process.env.AGENT_MODEL_FALLBACK ?? "openai/gpt-oss-20b",
      "You are a research triage assistant. Respond in JSON only.",
      prompt,
      { maxTokens: 200, reasoningEffort: "low" }
    );
    if (usageAgentId) {
      await upsertUsage(
        usageAgentId,
        new Date().toISOString().slice(0, 10),
        "groq",
        "ai_lab",
        res.totalTokens ?? 0
      );
    }
    const parsed = JSON.parse(res.text.trim());
    return { needsResearch: Boolean(parsed.needsResearch), query: String(parsed.query ?? "") };
  } catch {
    return null;
  }
}

export async function writeResearchComment(
  ideaId:    string,
  citations: SourceCitation[],
  ideaTitle: string,
): Promise<void> {
  const researchAgent = getResearchAgent();
  const today = new Date().toISOString().slice(0, 10);

  // Dedup: only one @research comment per idea per day regardless of how many
  // participants trigger research. Without this, all 4 participants posting on
  // an empirical topic each post their own @research comment.
  const [existing] = await db
    .select({ id: ideaComments.id })
    .from(ideaComments)
    .where(
      and(
        eq(ideaComments.ideaId, ideaId),
        eq(ideaComments.userId, researchAgent.id),
        gte(ideaComments.createdAt, new Date(`${today}T00:00:00Z`))
      )
    )
    .limit(1);
  if (existing) {
    console.log(`[executor] @research already posted for idea ${ideaId} today — skipping`);
    return;
  }

  const citationText = citations
    .slice(0, 3)
    .map((c, i) => `${i + 1}. [${c.source}] ${c.title} — ${c.summary}`)
    .join("\n");

  const synthesisPrompt = `Synthesize these recent headlines into a factual 120-150 word summary relevant to this debate:

DEBATE TOPIC: "${ideaTitle}"

RECENT HEADLINES:
${citationText}

Format:
@research — [topic in brackets]:
[3-4 sentences presenting facts, contradictions, and unknowns]
Current evidence: [one neutral sentence]

No opinions. No predictions. Facts only.`;

  try {
    // reasoningEffort low + raised cap: the 120-150 word synthesis needs
    // ~200-250 tokens on top of hidden reasoning, which previously could
    // empty or truncate the @research comment (2026-10-15 incident class).
    const res = await callGroq(
      process.env.AGENT_MODEL_FALLBACK ?? "openai/gpt-oss-20b",
      researchAgent.persona,
      synthesisPrompt,
      { maxTokens: 600, reasoningEffort: "low" }
    );

    const [newComment] = await db
      .insert(ideaComments)
      .values({ ideaId, userId: researchAgent.id, content: res.text.trim(), parentId: null })
      .returning({ id: ideaComments.id });

    if (newComment) {
      await db
        .update(ideas)
        .set({ totalComments: sql`${ideas.totalComments} + 1` })
        .where(eq(ideas.id, ideaId));
    }

    await upsertUsage(researchAgent.id, today, "groq", "ai_lab", res.totalTokens ?? 0);
    console.log(`[executor] @research posted for idea ${ideaId}`);
  } catch (e) {
    console.error("[executor] writeResearchComment failed:", (e as Error).message);
  }
}
