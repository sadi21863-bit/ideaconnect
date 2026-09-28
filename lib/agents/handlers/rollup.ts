import { db } from "@/db";
import { aiLabArchives, aiLabRollups, aiUsage } from "@/db/schema";
import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { getAgent } from "../personas";
import { callAgent } from "../providers/index";
import { buildRollupWeekPrompt, buildRollupMonthPrompt } from "../prompts";
import { stripThinkingTags } from "../response-cleaner";
import { parseJsonResponse } from "../json-helpers";
import type { AIQueue } from "@/db/schema";

interface ArchivistOutput {
  theme:             string;
  narrative_arc:     string;
  key_disagreements: Array<{ between: string[]; topic: string; resolution: string }>;
  key_questions:     string[];
  memorable_quotes:  Array<{ agent: string; text: string; context: string }>;
  stats:             { ideas_count: number; comments_count: number; participants_active: number; longest_thread_idea_id: string };
  strongest_voice_agent_handle?: string | null;
}

// ─── rollup_week self-contained handler (Week 4 Step 5) ──────────────
//
// Fetches last 7 daily published archives in the period, builds a week-level
// synthesis prompt, calls the Archivist, inserts to ai_lab_rollups as draft,
// and auto-queues quality_review_archive. If 0 archives exist, skips silently.

export async function executeRollupWeek(
  agent: ReturnType<typeof getAgent> & object,
  item:  AIQueue,
  today: string
): Promise<void> {
  const c           = (item.promptContext as Record<string, unknown>) ?? {};
  const periodEnd   = String(c.periodEnd   ?? (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })());
  const periodStart = String(c.periodStart ?? (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() - 7); return d.toISOString().slice(0, 10); })());

  // ── 1. Fetch published/flagged daily archives in the period ─────────
  // 2026-08-07: include flagged archives too. The QC has flagged every daily
  // archive since 2026-06-10 (quote-fidelity nits) — requiring 'published'
  // made weekly rollups silently skip every week. Flagged archives are still
  // valid content records; the rollup is a synthesis and has its own QC pass.
  const archives = await db.select().from(aiLabArchives).where(
    and(
      inArray(aiLabArchives.status, ["published", "flagged"]),
      gte(aiLabArchives.date, periodStart),
      lte(aiLabArchives.date, periodEnd)
    )
  ).orderBy(asc(aiLabArchives.date));

  if (archives.length === 0) {
    console.log(`[ai-lab] Weekly rollup ${periodStart}–${periodEnd}: no archives, skipping`);
    return;
  }

  const hasGap = archives.length < 3;

  // ── 2. Build synthesis prompt ────────────────────────────────────────
  const prompt = buildRollupWeekPrompt(
    archives.map((a) => ({ date: String(a.date), theme: a.theme, narrativeArc: a.narrativeArc, keyDisagreements: a.keyDisagreements })),
    periodStart,
    periodEnd,
    hasGap,
  );

  // ── 3. Call Archivist — token budget from agent.maxTokens (4000 for GPT-OSS) ──
  // jsonMode: true (gpt-oss-120b verified) — the old GitHub gpt-4o path repeatedly
  // produced invalid JSON for weekly rollups; native JSON enforcement removes that.
  const usage = { tokens: 0 };
  const rawResponse = await callAgent(agent as Parameters<typeof callAgent>[0], prompt, {
    temperature: 0.7,
    jsonMode:    true,
    usageOut:    usage,
  });

  if (!rawResponse.trim()) throw new Error("Empty response from Archivist for weekly rollup");

  let parsed: ArchivistOutput;
  try {
    parsed = parseJsonResponse(rawResponse) as unknown as ArchivistOutput;
  } catch (e) {
    throw new Error(`Archivist produced invalid JSON for weekly rollup: ${(e as Error).message}`);
  }

  const narrativeArc = stripThinkingTags(String(parsed.narrative_arc ?? "")).trim();
  if (!narrativeArc) throw new Error("Empty narrative_arc from Archivist for weekly rollup");

  // ── 4. Insert rollup row as published ─────────────────────────────────
  // 2026-08-07: rollups published directly — QC approval gate removed.
  const title = `Week of ${periodStart} – ${periodEnd}`;
  const now = new Date();

  const [newRollup] = await db
    .insert(aiLabRollups)
    .values({
      periodType:       "weekly",
      periodStart,
      periodEnd,
      title,
      summaryMarkdown:  narrativeArc,
      narrativeArc,
      keyDisagreements: (parsed.key_disagreements ?? []) as unknown as Record<string, unknown>[],
      keyQuestions:     (parsed.key_questions     ?? []) as unknown as string[],
      memorableQuotes:  (parsed.memorable_quotes  ?? []) as unknown as Record<string, unknown>[],
      status:           "published",
      publishedAt:      now,
      generatedAt:      now,
    })
    .onConflictDoUpdate({
      target: [aiLabRollups.periodType, aiLabRollups.periodStart],
      set: {
        summaryMarkdown:  narrativeArc,
        narrativeArc,
        keyDisagreements: (parsed.key_disagreements ?? []) as unknown as Record<string, unknown>[],
        keyQuestions:     (parsed.key_questions     ?? []) as unknown as string[],
        memorableQuotes:  (parsed.memorable_quotes  ?? []) as unknown as Record<string, unknown>[],
        status:           "published",
        publishedAt:      now,
        generatedAt:      now,
      },
    })
    .returning({ id: aiLabRollups.id });

  console.log(`[ai-lab] Weekly rollup ${periodStart}–${periodEnd} published (id: ${newRollup?.id})`);

  // ── 5. Increment usage ───────────────────────────────────────────────
  await db
    .insert(aiUsage)
    .values({ agentId: agent.id, date: today, requestCount: 1, lastRequestAt: now, lastProvider: agent.provider, tokens: usage.tokens, feature: "ai_lab" })
    .onConflictDoUpdate({
      target: [aiUsage.agentId, aiUsage.date],
      targetWhere: sql`${aiUsage.agentId} IS NOT NULL AND ${aiUsage.date} IS NOT NULL`,
      set: { requestCount: sql`${aiUsage.requestCount} + 1`, lastRequestAt: now, lastProvider: agent.provider, tokens: sql`${aiUsage.tokens} + ${usage.tokens}`, feature: "ai_lab" },
    });
}

// ─── rollup_month self-contained handler (Week 4 Step 5) ─────────────
//
// Prefers weekly rollups for the month; falls back to daily archives when
// sparse (< 2 weekly rollups). Skips silently if the period is entirely empty.

export async function executeRollupMonth(
  agent: ReturnType<typeof getAgent> & object,
  item:  AIQueue,
  today: string
): Promise<void> {
  const c           = (item.promptContext as Record<string, unknown>) ?? {};
  const periodStart = String(c.periodStart ?? "");
  const periodEnd   = String(c.periodEnd   ?? "");

  if (!periodStart || !periodEnd) {
    throw new Error("rollup_month requires periodStart and periodEnd in promptContext");
  }

  // ── 1. Try weekly rollups in the period ──────────────────────────────
  // 2026-08-07: include flagged rollups (same rationale as executeRollupWeek —
  // QC flags everything; monthly must not starve).
  const weeklyRollups = await db.select().from(aiLabRollups).where(
    and(
      eq(aiLabRollups.periodType, "weekly"),
      inArray(aiLabRollups.status, ["published", "flagged"]),
      gte(aiLabRollups.periodStart, periodStart),
      lte(aiLabRollups.periodEnd, periodEnd)
    )
  ).orderBy(asc(aiLabRollups.periodStart));

  const isSparse = weeklyRollups.length < 2;
  let sourceItems: Array<{ label: string; theme: string; narrativeArc: string | null }>;
  let usingDailyFallback = false;

  if (isSparse) {
    // ── 2. Fall back to daily archives ───────────────────────────────
    const dailyArchives = await db.select().from(aiLabArchives).where(
      and(
        inArray(aiLabArchives.status, ["published", "flagged"]),
        gte(aiLabArchives.date, periodStart),
        lte(aiLabArchives.date, periodEnd)
      )
    ).orderBy(asc(aiLabArchives.date));

    if (dailyArchives.length === 0 && weeklyRollups.length === 0) {
      console.log(`[ai-lab] Monthly rollup ${periodStart}–${periodEnd}: no data, skipping`);
      return;
    }

    sourceItems = dailyArchives.map((a) => ({
      label:       String(a.date).slice(0, 10),
      theme:       a.theme,
      narrativeArc: a.narrativeArc,
    }));
    usingDailyFallback = true;
  } else {
    sourceItems = weeklyRollups.map((r) => ({
      label:       `Week of ${String(r.periodStart).slice(0, 10)} – ${String(r.periodEnd).slice(0, 10)}`,
      theme:       r.title,
      narrativeArc: r.narrativeArc,
    }));
  }

  // ── 3. Build synthesis prompt ────────────────────────────────────────
  const prompt = buildRollupMonthPrompt(sourceItems, periodStart, periodEnd, usingDailyFallback);

  // ── 4. Call Archivist — token budget from agent.maxTokens (4000 for GPT-OSS) ──
  // jsonMode: true (gpt-oss-120b verified) — native JSON enforcement.
  const usage = { tokens: 0 };
  const rawResponse = await callAgent(agent as Parameters<typeof callAgent>[0], prompt, {
    temperature: 0.7,
    jsonMode:    true,
    usageOut:    usage,
  });

  if (!rawResponse.trim()) throw new Error("Empty response from Archivist for monthly rollup");

  let parsed: ArchivistOutput;
  try {
    parsed = parseJsonResponse(rawResponse) as unknown as ArchivistOutput;
  } catch (e) {
    throw new Error(`Archivist produced invalid JSON for monthly rollup: ${(e as Error).message}`);
  }

  const narrativeArc = stripThinkingTags(String(parsed.narrative_arc ?? "")).trim();
  if (!narrativeArc) throw new Error("Empty narrative_arc from Archivist for monthly rollup");

  // ── 5. Insert rollup row as published ─────────────────────────────────
  // 2026-08-07: rollups published directly — QC approval gate removed.
  const title = `Month of ${periodStart.slice(0, 7)}`;
  const now = new Date();

  const [newRollup] = await db
    .insert(aiLabRollups)
    .values({
      periodType:       "monthly",
      periodStart,
      periodEnd,
      title,
      summaryMarkdown:  narrativeArc,
      narrativeArc,
      keyDisagreements: (parsed.key_disagreements ?? []) as unknown as Record<string, unknown>[],
      keyQuestions:     (parsed.key_questions     ?? []) as unknown as string[],
      memorableQuotes:  (parsed.memorable_quotes  ?? []) as unknown as Record<string, unknown>[],
      status:           "published",
      publishedAt:      now,
      generatedAt:      now,
    })
    .onConflictDoUpdate({
      target: [aiLabRollups.periodType, aiLabRollups.periodStart],
      set: {
        summaryMarkdown:  narrativeArc,
        narrativeArc,
        keyDisagreements: (parsed.key_disagreements ?? []) as unknown as Record<string, unknown>[],
        keyQuestions:     (parsed.key_questions     ?? []) as unknown as string[],
        memorableQuotes:  (parsed.memorable_quotes  ?? []) as unknown as Record<string, unknown>[],
        status:           "published",
        publishedAt:      now,
        generatedAt:      now,
      },
    })
    .returning({ id: aiLabRollups.id });

  console.log(`[ai-lab] Monthly rollup ${periodStart.slice(0, 7)} published (id: ${newRollup?.id})`);

  // ── 6. Increment usage ───────────────────────────────────────────────
  await db
    .insert(aiUsage)
    .values({ agentId: agent.id, date: today, requestCount: 1, lastRequestAt: now, lastProvider: agent.provider, tokens: usage.tokens, feature: "ai_lab" })
    .onConflictDoUpdate({
      target: [aiUsage.agentId, aiUsage.date],
      targetWhere: sql`${aiUsage.agentId} IS NOT NULL AND ${aiUsage.date} IS NOT NULL`,
      set: { requestCount: sql`${aiUsage.requestCount} + 1`, lastRequestAt: now, lastProvider: agent.provider, tokens: sql`${aiUsage.tokens} + ${usage.tokens}`, feature: "ai_lab" },
    });
}
