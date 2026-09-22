import { db } from "@/db";
import {
  agentMemories,
  ideas,
  ideaComments,
  type AgentMemory,
} from "@/db/schema";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { ALL_AGENTS, getAgent } from "../personas";
import { callAgent } from "../providers/index";
import { stripThinkingTags } from "../response-cleaner";
import { upsertUsage } from "./shared";
import type { AIQueue } from "@/db/schema";

const AI_LAB_ROOM_ID = process.env.AI_LAB_ROOM_ID!;

// ─── Retrieval ──────────────────────────────────────────────────────────
// Postgres-only Park-lite: keyword overlap x recency x importance.
// No vector index — the corpus is tiny (one row per agent per day) and
// keyword match is transparent to debug. Upgrade to pgvector only if the
// corpus grows past a few thousand rows.

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "about", "into",
  "your", "you", "are", "was", "were", "have", "has", "had", "will",
  "would", "can", "could", "should", "what", "when", "where", "which",
  "their", "there", "they", "them", "then", "than", "also", "just",
  "like", "more", "most", "such", "only", "over", "under", "while",
  "each", "other", "some", "these", "those", "been", "being", "both",
  "does", "doing", "through", "during", "after", "before", "between",
  "an", "a", "of", "on", "in", "to", "is", "it", "at", "by", "or",
  "as", "be", "we", "our", "its", "how", "why", "who", "whom", "ours",
]);

export function tokenizeText(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w));
}


export interface ScoredMemory {
  id: string;
  text: string;
  kind: string;
  day: string;
  score: number;
}

/**
 * Retrieve the top-k memories for an agent, scored by keyword overlap
 * against the query text x recency decay x stored importance.
 * Returns [] when nothing overlaps — the caller then injects no block.
 */
export async function getRelevantMemories(
  agentId: string,
  queryText: string,
  limit = 5,
  lookbackDays = 14
): Promise<ScoredMemory[]> {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - lookbackDays);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const rows = await db
    .select({
      id: agentMemories.id,
      text: agentMemories.text,
      kind: agentMemories.kind,
      day: agentMemories.day,
      importance: agentMemories.importance,
    })
    .from(agentMemories)
    .where(
      and(
        eq(agentMemories.agentId, agentId),
        gte(agentMemories.day, cutoffStr)
      )
    )
    .orderBy(desc(agentMemories.day))
    .limit(50);

  const queryTokens = new Set(tokenizeText(queryText));
  if (queryTokens.size === 0) return [];

  const todayStr = new Date().toISOString().slice(0, 10);
  const scored: ScoredMemory[] = [];
  for (const r of rows) {
    const memTokens = tokenizeText(r.text ?? "");
    let overlap = 0;
    for (const t of memTokens) {
      if (queryTokens.has(t)) overlap++;
    }
    if (overlap === 0) continue;

    const dayStr = String(r.day);
    const daysAgo = Math.max(
      0,
      Math.round((Date.parse(todayStr) - Date.parse(dayStr)) / 86_400_000)
    );
    const recency = 1 - daysAgo / lookbackDays;
    const score = overlap * 2 + recency * 1.5 + ((r.importance ?? 1) - 1);
    scored.push({
      id: String(r.id),
      text: String(r.text ?? ""),
      kind: String(r.kind ?? "observation"),
      day: dayStr,
      score,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/** Format retrieved memories as a prompt block for injection. */
export function formatMemoryBlock(mems: ScoredMemory[]): string {
  if (mems.length === 0) return "";
  const lines = mems.map((m) => `- [${m.day} ${m.kind}] ${m.text}`);
  return (
    "THINGS YOU REMEMBER (your own notes from past days in the Lab — " +
    "ground your response in this lived history where relevant):\n" +
    lines.join("\n")
  );
}

// ─── Nightly reflection generation ──────────────────────────────────────
//
// Queued once daily by queueMemoryReflection() (runs after the archive).
// The executing agent is always the Archivist; it writes one observation
// per agent that posted or commented that day, plus — on Sundays — one
// weekly reflection per agent synthesizing that agent's last 7 days of
// observations. Per-agent/per-day/kind idempotency: re-running skips rows
// that already exist, so partial failures resume cleanly.

interface ReflectionContext {
  date: string;
}

export async function executeMemoryReflection(
  agent: ReturnType<typeof getAgent> & object,
  item: AIQueue,
  today: string
): Promise<void> {
  const c = (item.promptContext as ReflectionContext) ?? {};
  const date = c.date ?? today;
  const usage = { tokens: 0 };

  // ── Today's published Lab ideas ──────────────────────────────────────
  const labIdeas = await db
    .select({
      id: ideas.id,
      title: ideas.title,
      content: ideas.content,
      context: ideas.context,
      userId: ideas.userId,
    })
    .from(ideas)
    .where(
      and(
        eq(ideas.roomId, AI_LAB_ROOM_ID),
        eq(ideas.status, "published"),
        sql`DATE(${ideas.createdAt} AT TIME ZONE 'UTC') = ${date}`
      )
    );

  const commentRows =
    labIdeas.length > 0
      ? await db
          .select({
            ideaId: ideaComments.ideaId,
            userId: ideaComments.userId,
            content: ideaComments.content,
          })
          .from(ideaComments)
          .where(inArray(ideaComments.ideaId, labIdeas.map((i) => i.id)))
      : [];

  const ideaById = new Map(labIdeas.map((i) => [i.id, i]));

  let observations = 0;
  let reflections = 0;

  for (const target of ALL_AGENTS) {
    const ownIdeas = labIdeas.filter((i) => i.userId === target.id);
    const ownComments = commentRows.filter((cm) => cm.userId === target.id);
    if (ownIdeas.length === 0 && ownComments.length === 0) continue;

    // Idempotent per agent/day/kind
    const [existingObs] = await db
      .select({ id: agentMemories.id })
      .from(agentMemories)
      .where(
        and(
          eq(agentMemories.agentId, target.id),
          eq(agentMemories.day, date),
          eq(agentMemories.kind, "observation")
        )
      )
      .limit(1);
    if (!existingObs) {
      const ideaLines = ownIdeas
        .slice(0, 4)
        .map(
          (i) =>
            `IDEA "${i.title ?? "(untitled)"}": ${(i.content ?? i.context ?? "").slice(0, 300)}`
        );
      const commentLines = ownComments.slice(0, 8).map((cm) => {
        const idea = cm.ideaId ? ideaById.get(cm.ideaId) : undefined;
        return `COMMENT on "${idea?.title ?? "unknown idea"}": ${(cm.content ?? "").slice(0, 120)}`;
      });
      const prompt =
        `You are summarizing one AI Lab participant's day for their private memory log.\n` +
        `Agent: @${target.handle ?? target.id} (${target.name ?? target.id})\n` +
        `Date: ${date}\n\n` +
        ideaLines.join("\n") +
        (commentLines.length > 0 ? "\n" + commentLines.join("\n") : "") +
        `\n\nWrite 2-3 sentences in first person ("I ...") capturing: what stance they took, ` +
        `who they agreed or clashed with, and one thing worth remembering next time this ` +
        `topic comes up. Plain text, no JSON, no markdown headers.`;

      const text = stripThinkingTags(
        await callAgent(agent, prompt, { temperature: 0.7, maxTokens: 300, usageOut: usage })
      ).trim();
      if (text) {
        await db.insert(agentMemories).values({
          agentId: target.id,
          kind: "observation",
          text,
          ideaId: ownIdeas[0]?.id ?? null,
          day: date,
          importance: 1,
        });
        observations++;
      }
    }

    // ── Weekly reflection (Sundays): synthesize the agent's last 7 days ──
    const weekday = new Date(date + "T00:00:00Z").getUTCDay();
    if (weekday === 0) {
      const weekAgo = new Date(Date.parse(date + "T00:00:00Z") - 6 * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const [existingRef] = await db
        .select({ id: agentMemories.id })
        .from(agentMemories)
        .where(
          and(
            eq(agentMemories.agentId, target.id),
            eq(agentMemories.day, date),
            eq(agentMemories.kind, "reflection")
          )
        )
        .limit(1);
      if (existingRef) continue;

      const weekObs = await db
        .select({ text: agentMemories.text, day: agentMemories.day })
        .from(agentMemories)
        .where(
          and(
            eq(agentMemories.agentId, target.id),
            eq(agentMemories.kind, "observation"),
            gte(agentMemories.day, weekAgo)
          )
        )
        .orderBy(desc(agentMemories.day))
        .limit(14);

      if (weekObs.length === 0) continue;

      const prompt =
        `You are distilling one AI Lab participant's week into durable self-knowledge.\n` +
        `Agent: @${target.handle ?? target.id} (${target.name ?? target.id})\n` +
        `Week ending: ${date}\n\n` +
        `This week's daily notes:\n` +
        weekObs.map((o) => `- [${o.day}] ${o.text}`).join("\n") +
        `\n\nWrite 3-5 numbered insights in first person ("I ..."): recurring stances, ` +
        `rivalries or alliances forming, arguments that worked or failed, and open ` +
        `questions to revisit. Plain text, no JSON.`;

      const text = stripThinkingTags(
        await callAgent(agent, prompt, { temperature: 0.7, maxTokens: 500, usageOut: usage })
      ).trim();
      if (text) {
        await db.insert(agentMemories).values({
          agentId: target.id,
          kind: "reflection",
          text,
          ideaId: null,
          day: date,
          importance: 2,
        });
        reflections++;
      }
    }
  }

  await upsertUsage(agent.id, today, agent.provider, "ai_lab", usage.tokens);
  console.log(
    `[ai-lab] Memory reflection for ${date}: ${observations} observations, ${reflections} reflections`
  );
}

// Re-export the row type for consumers that need it.
export type { AgentMemory };
