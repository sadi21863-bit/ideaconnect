import { db } from "@/db";
import {
  aiQueue, aiThemes, ideas, ideaComments, searchCache,
  aiLabArchives, aiLabRollups, aiUsage, users,
} from "@/db/schema";
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { getAgent } from "../personas";
import { callGroq } from "../providers/groq";
import { callAgent } from "../providers/index";
import {
  buildIdeaSummaryPrompt,
  buildQualityReviewArchivePrompt,
  buildQualityReviewRollupPrompt,
} from "../prompts";
import { stripThinkingTags } from "../response-cleaner";
import { parseJsonResponse } from "../json-helpers";
import { fetchResearch, formatResearchBlock, type SourceCitation } from "../research";
import type { AIQueue } from "@/db/schema";
import { AI_LAB_ROOM_ID } from "./shared";
import { restoreVoiceLabels } from "../voice-labels";

interface ArchivistOutput {
  theme:             string;
  narrative_arc:     string;
  key_disagreements: Array<{ between: string[]; topic: string; resolution: string }>;
  key_questions:     string[];
  memorable_quotes:  Array<{ agent: string; text: string; context: string }>;
  stats:             { ideas_count: number; comments_count: number; participants_active: number; longest_thread_idea_id: string };
  strongest_voice_agent_handle?: string | null;
}

// ─── archive_day self-contained handler (Week 4) ─────────────────────
//
// Fetches the day's full Lab activity from DB, builds a rich narrative prompt,
// calls the Archivist, parses the structured JSON response, inserts the archive
// row as status='draft', and auto-queues a quality_review_archive action.
//
// This bypasses the generic callAgent path in executeItem — it manages its own
// LLM call and usage tracking.

export async function executeArchiveDay(
  agent: ReturnType<typeof getAgent> & object,
  item:  AIQueue,
  today: string
): Promise<void> {
  const c    = (item.promptContext as Record<string, unknown>) ?? {};
  const date = String(c.date ?? today);

  // ── 1. Fetch the day's Lab data ────────────────────────────────────────────
  const [todayTheme] = await db.select().from(aiThemes).where(eq(aiThemes.date, date)).limit(1);
  const themeStr = todayTheme?.theme ?? "(no theme set)";

  const labIdeas = await db
    .select()
    .from(ideas)
    .where(
      and(
        eq(ideas.roomId, AI_LAB_ROOM_ID),
        eq(ideas.status, "published"),
        sql`DATE(${ideas.createdAt} AT TIME ZONE 'UTC') = ${date}`
      )
    );

  if (labIdeas.length === 0) {
    console.log(`[executor] archive_day: no ideas for ${date}, marking completed`);
    await db.update(aiQueue).set({ status: "completed" }).where(eq(aiQueue.id, item.id));
    return;
  }

  const allCommentRows = await db
    .select({ id: ideaComments.id, ideaId: ideaComments.ideaId, userId: ideaComments.userId, content: ideaComments.content })
    .from(ideaComments)
    .where(inArray(ideaComments.ideaId, labIdeas.map((i) => i.id)));

  // ── 2. Fetch cached research for the archive date (not necessarily today) ──
  const startOfDay = new Date(`${date}T00:00:00Z`);
  const endOfDay   = new Date(`${date}T23:59:59Z`);
  const [archiveResearchRow] = await db
    .select({ results: searchCache.results })
    .from(searchCache)
    .where(and(gte(searchCache.fetchedAt, startOfDay), lte(searchCache.fetchedAt, endOfDay)))
    .orderBy(desc(searchCache.fetchedAt))
    .limit(1);
  const researchBlock = archiveResearchRow?.results
    ? formatResearchBlock(archiveResearchRow.results as SourceCitation[], "TODAY'S REAL-WORLD CONTEXT")
    : "";

  // ── PASS 1: per-idea debate summaries (gpt-oss-20b, ~1,500–2,000 tokens each) ──
  // GitHub Models enforces an 8,000 token hard per-request limit on all free-tier models.
  // The full prompt (9k–13k tokens on busy days) exceeds this. Summarising each idea
  // individually keeps every Pass 1 call well within budget.
  // 2026-08-07: GitHub Models retired → openai/gpt-oss-20b on Groq (JSON mode verified live).
  const ideaSummaries: Array<{
    title:   string;
    summary: string;
    quotes:  Array<{ agent: string; text: string; context: string }>;
  }> = [];

  // Token accounting for this handler (G1 fix — aiUsage.tokens was never populated)
  const usage = { tokens: 0 };

  // Blind-judging roster: anonymize participant handles as "Voice A/B/…" so the
  // Archivist cannot favor same-lineage models by name (MT-Bench self-enhancement bias).
  const participantHandles = Array.from(
    new Set(
      allCommentRows
        .map((r) => r.userId)
        .filter((id): id is string => !!id && id.startsWith("ai_"))
        .map((id) => id.replace(/^ai_/, "").replace(/_/g, "-"))
    )
  );
  const shuffled = [...participantHandles].sort(() => Math.random() - 0.5);
  const voiceLabels = ["Voice A", "Voice B", "Voice C", "Voice D", "Voice E", "Voice F", "Voice G", "Voice H", "Voice I"];
  const handleToVoice = new Map<string, string>();
  shuffled.forEach((h, i) => handleToVoice.set(h, voiceLabels[i] ?? `Voice ${i + 1}`));
  const voiceToHandle = new Map([...handleToVoice.entries()].map(([h, v]) => [v, h]));
  const scrubHandles = (text: string): string => {
    let out = text;
    for (const [h, v] of handleToVoice) {
      out = out.replaceAll(`@${h}`, v).replaceAll(h, v);
    }
    return out;
  };

  for (const idea of labIdeas) {
    const commentList = allCommentRows
      .filter((r) => r.ideaId === idea.id)
      .map((r) => ({
        handle:     (r.userId ?? "unknown").replace(/^ai_/, "").replace(/_/g, "-"),
        content:    r.content ?? "",
        isResearch: r.userId === "ai_research",
      }));

    const summaryPrompt = buildIdeaSummaryPrompt(
      idea.title   ?? "(untitled)",
      idea.content ?? idea.context ?? "",
      commentList
    );

    try {
      const res     = await callGroq(
        "openai/gpt-oss-20b",
        "You are a precise debate analyst. Respond with JSON only. No markdown fences.",
        summaryPrompt,
        { temperature: 0.3, maxTokens: 400, jsonMode: true }
      );
      usage.tokens += res.totalTokens ?? 0;
      const p = parseJsonResponse(res.text) as { summary: string; quotes: Array<{ agent: string; text: string; context: string }> };
      ideaSummaries.push({
        title:   idea.title ?? "(untitled)",
        summary: String(p.summary ?? ""),
        quotes:  Array.isArray(p.quotes) ? p.quotes : [],
      });
    } catch (e) {
      console.warn(`[executor] archive Pass 1 failed for idea ${idea.id}:`, (e as Error).message);
      ideaSummaries.push({ title: idea.title ?? "(untitled)", summary: "(summary unavailable)", quotes: [] });
    }
  }

  // ── PASS 2: synthesis (openai/gpt-oss-120b, ~3,000 tokens) ──────────────────────
  // Structured summaries from Pass 1 replace the raw idea/comment dump.
  // Input is ~3k tokens. JSON mode enforced natively (gpt-oss-120b verified).
  // 2026-08-07: GitHub Models retired → Groq openai/gpt-oss-120b.
  const summaryBlock = ideaSummaries
    .map((s, i) =>
      `IDEA ${i + 1}: "${scrubHandles(s.title ?? "")}"\n${scrubHandles(s.summary)}${
        s.quotes.length > 0
          ? `\nQuote candidates: ${s.quotes
              .map((q) => `${handleToVoice.get(q.agent) ?? scrubHandles(`@${q.agent}`)}: "${q.text}"`)
              .join(" | ")}`
          : ""
      }`
    )
    .join("\n\n---\n\n");

  const synthesisPrompt = `Generate the archive for the AI Lab session on ${date}.

THEME: ${themeStr}
${researchBlock}
DEBATE SUMMARIES (${labIdeas.length} ideas, ${allCommentRows.length} total comments):

${summaryBlock}

STATS:
- ideas_count: ${labIdeas.length}
- comments_count: ${allCommentRows.length}
- participants_active: ${new Set(allCommentRows.map((r) => r.userId).filter(Boolean)).size}

Write the full archive narrative following your Archivist instructions.
Use the quote candidates above for memorable_quotes — copy verbatim, do not paraphrase.
IMPORTANT — anonymized judging: participant names have been replaced with labels
(Voice A, Voice B, …). Judge ONLY the argument quality in the text; if any real
name leaked through, ignore it for scoring. Use the Voice labels consistently
in the JSON; the publishing layer restores the real handles before storage.
Include a "strongest_voice" field set to exactly one of these labels:
${[...voiceToHandle.keys()].join(", ")}.
Pick the single voice whose argument was most incisive, original, or
well-supported today. If no one clearly stood out, omit the field or null.
Output ONLY the JSON object.`;

  const rawResponse = await callGroq(
    agent.model,   // openai/gpt-oss-120b
    agent.persona,
    synthesisPrompt,
    { temperature: 0.7, maxTokens: agent.maxTokens ?? 4000, jsonMode: true }
  );
  usage.tokens += rawResponse.totalTokens ?? 0;

  if (!rawResponse.text.trim()) throw new Error("Empty response from archivist synthesis");

  // ── 4. Parse ──────────────────────────────────────────────────────────────
  let parsed: ArchivistOutput;
  try {
    parsed = parseJsonResponse(rawResponse.text) as unknown as ArchivistOutput;
  } catch (e) {
    throw new Error(`Archivist produced invalid JSON: ${(e as Error).message}`);
  }

  const narrativeArc = stripThinkingTags(String(parsed.narrative_arc ?? "")).trim();
  if (!narrativeArc) throw new Error("Empty narrative_arc after cleanup");

  const publishedNarrative = restoreVoiceLabels(narrativeArc, voiceToHandle);
  const publishedDisagreements = restoreVoiceLabels(
    (parsed.key_disagreements ?? []) as unknown as Record<string, unknown>[],
    voiceToHandle
  );
  const publishedQuotes = restoreVoiceLabels(
    (parsed.memorable_quotes ?? []) as unknown as Record<string, unknown>[],
    voiceToHandle
  );
  const publishedQuestions = restoreVoiceLabels(parsed.key_questions ?? [], voiceToHandle);
  const publishedStats = restoreVoiceLabels(
    (parsed.stats ?? {}) as unknown as Record<string, unknown>,
    voiceToHandle
  );

  // De-anonymize strongest_voice label → users.id. Accept legacy handle form too.
  let winnerAgentId: string | null = null;
  const strongestRaw = String((parsed as unknown as Record<string, unknown>).strongest_voice
    ?? (parsed as unknown as Record<string, unknown>).strongest_voice_agent_handle ?? "").trim();
  if (strongestRaw) {
    const lower = strongestRaw.toLowerCase();
    const withoutAt = strongestRaw.replace(/^@/, "");
    const resolvedHandle =
      voiceToHandle.get(strongestRaw)
      ?? voiceToHandle.get(withoutAt)
      ?? voiceToHandle.get(lower)
      ?? lower.replace(/^@/, "");
    if (resolvedHandle) {
      const [winnerRow] = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.handle, resolvedHandle), eq(users.isAi, true)))
        .limit(1);
      winnerAgentId = winnerRow?.id ?? null;
    }
  }

  // ── 5. Insert archive row as published ──────────────────────────────
  // 2026-08-07: archives are published immediately — the QC approval gate
  // (quality_review_archive) was removed. Every daily archive since 06-10
  // was stuck in 'flagged' due to quote-fidelity nits, blocking rollups.
  const now = new Date();
  const [newArchive] = await db
    .insert(aiLabArchives)
    .values({
      date,
      theme:            String(parsed.theme ?? themeStr),
      summaryMarkdown:  publishedNarrative,
      narrativeArc:     publishedNarrative,
      keyDisagreements: publishedDisagreements,
      keyQuestions:     publishedQuestions,
      memorableQuotes:  publishedQuotes,
      stats:            publishedStats,
      status:           "published",
      publishedAt:      now,
      generatedAt:      now,
      winnerAgentId,
    })
    .onConflictDoUpdate({
      target: aiLabArchives.date,
      set: {
        theme:           String(parsed.theme ?? themeStr),
        summaryMarkdown: publishedNarrative,
        narrativeArc:    publishedNarrative,
        keyDisagreements: publishedDisagreements,
        keyQuestions:    publishedQuestions,
        memorableQuotes: publishedQuotes,
        stats:           publishedStats,
        status:          "published",
        publishedAt:     now,
        generatedAt:     now,
        winnerAgentId,
      },
    })
    .returning({ id: aiLabArchives.id });

  console.log(`[ai-lab] Archive for ${date} published (id: ${newArchive?.id})`);

  // ── 7. Increment usage (self-contained handlers manage their own) ───
  await db
    .insert(aiUsage)
    .values({
      agentId:       agent.id,
      date:          today,
      requestCount:  1,
      lastRequestAt: new Date(),
      lastProvider:  agent.provider,
      tokens:        usage.tokens,
    })
    .onConflictDoUpdate({
      target: [aiUsage.agentId, aiUsage.date],
      targetWhere: sql`${aiUsage.agentId} IS NOT NULL AND ${aiUsage.date} IS NOT NULL`,
      set: {
        requestCount:  sql`${aiUsage.requestCount} + 1`,
        lastRequestAt: new Date(),
        lastProvider:  agent.provider,
        tokens:        sql`${aiUsage.tokens} + ${usage.tokens}`,
      },
    });
}

// ─── quality_review_archive self-contained handler (Week 4 Steps 4–5) ──
//
// Handles QC review for both daily archives and rollups.
// prompt_context must contain either:
//   archiveId + archiveDate  → reviews a daily archive against raw ideas/comments
//   rollupId  + periodStart + periodEnd → reviews a rollup against daily archives
//
// Two verdicts: 'publish' or 'flag'. Retirement is an admin dashboard action.

export async function executeQualityReviewArchive(
  agent: ReturnType<typeof getAgent> & object,
  item:  AIQueue,
  today: string
): Promise<void> {
  const c         = (item.promptContext as Record<string, unknown>) ?? {};
  const archiveId = c.archiveId ? String(c.archiveId) : null;
  const rollupId  = c.rollupId  ? String(c.rollupId)  : null;
  const qcUsage = { tokens: 0 };

  if (!archiveId && !rollupId) {
    throw new Error("quality_review_archive requires archiveId or rollupId in promptContext");
  }

  let prompt: string;
  let applyVerdict: (verdict: string, reason: string | undefined, now: Date) => Promise<void>;

  if (archiveId) {
    // ── Daily archive review path ─────────────────────────────────────
    const archiveDate = String(c.archiveDate ?? today);

    const archiveRows = await db.select().from(aiLabArchives).where(eq(aiLabArchives.id, archiveId));
    const archiveRow  = archiveRows[0];
    if (!archiveRow) throw new Error(`Archive not found: ${archiveId}`);
    if (archiveRow.status === "published") {
      // Already published by a concurrent run — idempotent success
      console.log(`[executor] quality_review_archive: archive ${archiveId} already published, skipping`);
      await db.update(aiQueue).set({ status: "completed" }).where(eq(aiQueue.id, item.id));
      return;
    }
    if (archiveRow.status !== "draft") {
      throw new Error(`Archive ${archiveId} is not reviewable (status: ${archiveRow.status})`);
    }

    const labIdeas = await db.select().from(ideas).where(
      and(
        eq(ideas.roomId, AI_LAB_ROOM_ID),
        eq(ideas.status, "published"),
        sql`DATE(${ideas.createdAt} AT TIME ZONE 'UTC') = ${archiveDate}`
      )
    );

    const commentRows = labIdeas.length > 0
      ? await db
          .select({ id: ideaComments.id, ideaId: ideaComments.ideaId, userId: ideaComments.userId, content: ideaComments.content })
          .from(ideaComments)
          .where(inArray(ideaComments.ideaId, labIdeas.map((i) => i.id)))
      : [];

    // Summarize each idea before building the QC prompt — the old approach dumped
    // every idea's full content + every comment verbatim, which reliably exceeded
    // GitHub Models' 8k-token per-request limit, leaving every archive stuck in
    // 'draft' forever. Same Pass-1 pattern as executeArchiveDay. Quote fidelity is
    // still checked byte-for-byte against commentRows below — only the "what
    // happened" context passed to the LLM is summarized.
    // 2026-08-07: GitHub Models retired → openai/gpt-oss-20b on Groq.
    const ideaSummaries: Array<{ title: string; handle: string; summary: string }> = [];
    for (const idea of labIdeas) {
      const handle = (idea.userId ?? "").replace(/^ai_/, "").replace(/_/g, "-");
      const commentList = commentRows
        .filter((r) => r.ideaId === idea.id)
        .map((r) => ({
          handle:     (r.userId ?? "unknown").replace(/^ai_/, "").replace(/_/g, "-"),
          content:    r.content ?? "",
          isResearch: r.userId === "ai_research",
        }));

      const summaryPrompt = buildIdeaSummaryPrompt(idea.title ?? "(untitled)", idea.content ?? idea.context ?? "", commentList);
      try {
        const res = await callGroq(
          "openai/gpt-oss-20b",
          "You are a precise debate analyst. Respond with JSON only. No markdown fences.",
          summaryPrompt,
          { temperature: 0.3, maxTokens: 400, jsonMode: true }
        );
        qcUsage.tokens += res.totalTokens ?? 0;
        const p = parseJsonResponse(res.text) as { summary: string };
        ideaSummaries.push({ title: idea.title ?? "(untitled)", handle, summary: String(p.summary ?? "") });
      } catch (e) {
        console.warn(`[executor] QC archive-review Pass 1 failed for idea ${idea.id}:`, (e as Error).message);
        ideaSummaries.push({ title: idea.title ?? "(untitled)", handle, summary: "(summary unavailable)" });
      }
    }

    prompt = buildQualityReviewArchivePrompt(
      { narrativeArc: archiveRow.narrativeArc, keyDisagreements: archiveRow.keyDisagreements, memorableQuotes: archiveRow.memorableQuotes },
      ideaSummaries,
      commentRows,
    );

    applyVerdict = async (verdict, reason, now) => {
      if (verdict === "publish") {
        await db.update(aiLabArchives)
          .set({ status: "published", publishedAt: now, reviewedByAgentId: agent.id, reviewedAt: now })
          .where(eq(aiLabArchives.id, archiveId));
      } else {
        await db.update(aiLabArchives)
          .set({ status: "flagged", flaggedReason: reason ?? `QC verdict: ${verdict}`, reviewedByAgentId: agent.id, reviewedAt: now })
          .where(eq(aiLabArchives.id, archiveId));
      }
    };
  } else {
    // ── Rollup review path ────────────────────────────────────────────
    const periodStart = String(c.periodStart ?? "");
    const periodEnd   = String(c.periodEnd   ?? "");

    const rollupRows = await db.select().from(aiLabRollups).where(eq(aiLabRollups.id, rollupId!));
    const rollupRow  = rollupRows[0];
    if (!rollupRow) throw new Error(`Rollup not found: ${rollupId}`);
    if (rollupRow.status === "published") {
      console.log(`[executor] quality_review_archive: rollup ${rollupId} already published, skipping`);
      await db.update(aiQueue).set({ status: "completed" }).where(eq(aiQueue.id, item.id));
      return;
    }
    if (rollupRow.status !== "draft") {
      throw new Error(`Rollup ${rollupId} is not reviewable (status: ${rollupRow.status})`);
    }

    // Source ground truth = published/flagged daily archives in the rollup's period
    // (2026-08-07: flagged included — same rationale as executeRollupWeek).
    const sourceArchives = await db.select().from(aiLabArchives).where(
      and(
        inArray(aiLabArchives.status, ["published", "flagged"]),
        gte(aiLabArchives.date, periodStart),
        lte(aiLabArchives.date, periodEnd)
      )
    ).orderBy(asc(aiLabArchives.date));

    prompt = buildQualityReviewRollupPrompt(
      {
        narrativeArc:    rollupRow.narrativeArc,
        keyDisagreements: rollupRow.keyDisagreements,
        memorableQuotes:  rollupRow.memorableQuotes,
        periodType:       rollupRow.periodType,
      },
      sourceArchives.map((a) => ({ date: String(a.date), theme: a.theme, narrativeArc: a.narrativeArc })),
    );

    applyVerdict = async (verdict, reason, now) => {
      if (verdict === "publish") {
        await db.update(aiLabRollups)
          .set({ status: "published", publishedAt: now, reviewedByAgentId: agent.id, reviewedAt: now })
          .where(eq(aiLabRollups.id, rollupId!));
      } else {
        await db.update(aiLabRollups)
          .set({ status: "flagged", flaggedReason: reason ?? `QC verdict: ${verdict}`, reviewedByAgentId: agent.id, reviewedAt: now })
          .where(eq(aiLabRollups.id, rollupId!));
      }
    };
  }

  // ── Call Quality Checker via Groq (gpt-oss-20b) ──────────────────────
  // 2026-08-07: GitHub Models retired → migrated from openai/gpt-4o-mini.
  // gpt-oss-20b is faster than the QC's default gpt-oss-120b and JSON mode is
  // verified live; keeps load off the 120b TPM pool (participants + theme setter).
  const qcUsageBox = { tokens: 0 };
  const rawResponse = await callAgent(
    { ...agent, provider: "groq", model: "openai/gpt-oss-20b" } as Parameters<typeof callAgent>[0],
    prompt,
    { jsonMode: true, maxTokens: 400, temperature: 0.1, usageOut: qcUsageBox }
  );
  qcUsage.tokens += qcUsageBox.tokens;

  const cleaned = stripThinkingTags(rawResponse);
  if (!cleaned.trim()) throw new Error("Empty response from Quality Checker");

  let parsed: { verdict: string; reason?: string };
  try {
    parsed = parseJsonResponse(cleaned) as typeof parsed;
  } catch (e) {
    throw new Error(`Invalid JSON from Quality Checker: ${(e as Error).message}`);
  }

  const now = new Date();
  await applyVerdict(parsed.verdict, parsed.reason, now);

  // ── Increment usage ──────────────────────────────────────────────────
  await db
    .insert(aiUsage)
    .values({ agentId: agent.id, date: today, requestCount: 1, lastRequestAt: now, lastProvider: agent.provider, tokens: qcUsage.tokens })
    .onConflictDoUpdate({
      target: [aiUsage.agentId, aiUsage.date],
      targetWhere: sql`${aiUsage.agentId} IS NOT NULL AND ${aiUsage.date} IS NOT NULL`,
      set: { requestCount: sql`${aiUsage.requestCount} + 1`, lastRequestAt: now, lastProvider: agent.provider, tokens: sql`${aiUsage.tokens} + ${qcUsage.tokens}` },
    });
}
