/**
 * lib/agents/executor.ts
 *
 * Reads from ai_queue and executes pending actions.
 * Called every 5 min by /api/cron/agents/tick (and on-demand by seed-ideas, catchup, theme, archive).
 *
 * Concurrency safety: uses FOR UPDATE SKIP LOCKED inside a short transaction
 * to atomically claim rows. Two concurrent workers will never process the
 * same row — each worker skips rows that are already locked by another.
 *
 * ─── Privacy isolation audit log convention ──────────────────────────────────
 * All 4 layers of private-room isolation (see app/actions/ai-mention-actions.ts)
 * log their enforcement decisions to ai_moderation_log with:
 *   moderatorAgentId = 'system'   (NOT a real user — no FK on this column)
 *   verdict          = 'isolated'
 *   target_type      = 'mention'         (Layer 2: server-action override)
 *                    | 'queue_action'    (Layer 4: executor refusal)
 *   reason           human-readable description of the block
 * This creates an audit trail that can be queried via admin dashboard.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { db } from "@/db";
import { aiQueue, aiUsage, aiModerationLog } from "@/db/schema";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { getAgent } from "./personas";
import { callAgent } from "./providers/index";
import { buildPrompt } from "./prompts";
import { stripThinkingTags } from "./response-cleaner";
import { fetchResearch, formatResearchBlock } from "./research";
import type { AIQueue } from "@/db/schema";
import { QUOTA_CONFIG } from "@/lib/config";

// ── Handler imports ─────────────────────────────────────────────────────────
import { upsertUsage, shouldFetchResearch, writeResearchComment, MIN_CONTENT_LENGTH } from "./handlers/shared";
import { executeArchiveDay, executeQualityReviewArchive } from "./handlers/archive";
import { executeRollupWeek, executeRollupMonth } from "./handlers/rollup";
import { executeAILabDebate } from "./handlers/ai-lab-debate";
import { executeMemoryReflection, getRelevantMemories, formatMemoryBlock } from "./handlers/memory";
import {
  writeThemeSelect, writePostIdea, writeComment,
  writeQualityReview,
  writeConductorQuestion,
} from "./handlers/writers";

// ─── Public entry point ───────────────────────────────────────────────

export async function processQueue(
  limit = 5
): Promise<{ processed: number; failed: number; errors: Array<{ id: string; agentId: string; actionType: string; error: string }> }> {
  // Step 1: Atomically claim pending rows.
  // FOR UPDATE SKIP LOCKED ensures no two concurrent workers process the same row.
  const claimedIds = await db.transaction(async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      SELECT id FROM ai_queue
      WHERE  status       = 'pending'
        AND  scheduled_for <= now()
      ORDER  BY priority ASC, scheduled_for ASC
      LIMIT  ${limit}
      FOR UPDATE SKIP LOCKED
    `);

    const ids = (rows as Array<{ id: string }>).map((r) => r.id);
    if (ids.length === 0) return [];

    // Mark as in_progress while still in the same transaction
    await tx
      .update(aiQueue)
      .set({ status: "in_progress" })
      .where(inArray(aiQueue.id, ids));

    return ids;
  });

  if (claimedIds.length === 0) return { processed: 0, failed: 0, errors: [] };

  // Step 2: Fetch full rows for claimed IDs
  const items = await db
    .select()
    .from(aiQueue)
    .where(inArray(aiQueue.id, claimedIds));

  let processed = 0;
  let failed    = 0;
  const errors: Array<{ id: string; agentId: string; actionType: string; error: string }> = [];

  for (const item of items) {
    try {
      await executeItem(item);
      await db
        .update(aiQueue)
        .set({ status: "completed", executedAt: new Date() })
        .where(eq(aiQueue.id, item.id));
      processed++;
    } catch (err) {
      const message       = err instanceof Error ? err.message : String(err);
      const isRateLimited = message.startsWith("rate_limited");
      const newRetryCount = (item.retryCount ?? 0) + 1;
      const isPermanent   = !isRateLimited && newRetryCount >= 3;
      const status        = isRateLimited
        ? "rate_limited"
        : isPermanent
          ? "failed_permanently"
          : "failed";

      await db
        .update(aiQueue)
        .set({ status, errorMessage: message, executedAt: new Date(), retryCount: newRetryCount })
        .where(eq(aiQueue.id, item.id));

      if (isPermanent) {
        console.error(
          `[ai-lab] DEAD LETTER: job ${item.id} (${item.actionType} / ${item.agentId}) failed permanently after ${newRetryCount} attempts. Last error: ${message}`
        );
      }

      errors.push({ id: item.id, agentId: item.agentId, actionType: item.actionType, error: message });
      failed++;
    }
  }

  return { processed, failed, errors };
}

/**
 * Resets queue rows stuck in `in_progress` for longer than 10 minutes.
 * Vercel function timeouts leave rows claimed but never completed — this
 * is the safety net. Called by the catchup cron before processQueue.
 * Uses scheduledFor (never null) rather than executedAt (null on first claim).
 */
export async function resetStuckQueueItems(): Promise<number> {
  const staleThreshold = new Date(Date.now() - 10 * 60 * 1000);

  // Reset items stuck in_progress > 10 min
  const stuckReset = await db
    .update(aiQueue)
    .set({ status: "pending", errorMessage: "reset by catchup — was stuck in_progress" })
    .where(and(
      eq(aiQueue.status, "in_progress"),
      lt(aiQueue.scheduledFor, staleThreshold),
      lt(aiQueue.retryCount, 3),
    ))
    .returning({ id: aiQueue.id });

  // Re-queue deferred items — quota resets at midnight UTC, so they're eligible again
  const deferredReset = await db
    .update(aiQueue)
    .set({ status: "pending", errorMessage: null })
    .where(eq(aiQueue.status, "deferred"))
    .returning({ id: aiQueue.id });

  return stuckReset.length + deferredReset.length;
}

// ─── Per-item execution ───────────────────────────────────────────────

async function executeItem(item: AIQueue): Promise<void> {
  const agent = getAgent(item.agentId);
  if (!agent) throw new Error(`Agent not found: ${item.agentId}`);

  // Rate limit check — throw with "rate_limited:" prefix so outer catch
  // can distinguish it from a real failure and set the correct status.
  const today = new Date().toISOString().slice(0, 10);
  {
    const [usage] = await db
      .select()
      .from(aiUsage)
      .where(and(eq(aiUsage.agentId, agent.id), eq(aiUsage.date, today)));

    if (usage && usage.requestCount >= agent.dailyLimit) {
      throw new Error(`rate_limited: ${agent.handle} has reached daily limit (${agent.dailyLimit})`);
    }
  }

  // Quota enforcement: check feature-level daily token budget before any LLM work.
  // Deferred items are retried at the next queue tick, not dead-lettered.
  const featureLabel = "ai_lab";
  const budgetFraction = QUOTA_CONFIG.AI_LAB_BUDGET_FRACTION;
  const dailyCeiling = Math.floor(QUOTA_CONFIG.DAILY_TPD_LIMIT * budgetFraction);

  const startOfDayUTC = new Date(new Date().setUTCHours(0, 0, 0, 0));
  const [usageRow] = await db
    .select({ total: sql<number>`coalesce(sum(${aiUsage.tokens}), 0)::int` })
    .from(aiUsage)
    .where(and(eq(aiUsage.feature, featureLabel), gte(aiUsage.createdAt, startOfDayUTC)));

  if (Number(usageRow?.total ?? 0) >= dailyCeiling) {
    await db.update(aiQueue)
      .set({ status: "deferred", errorMessage: `quota_exceeded: ${featureLabel} daily budget` })
      .where(eq(aiQueue.id, item.id));
    await db.insert(aiModerationLog).values({
      moderatorAgentId: "system",
      targetType:       "quota",
      targetId:         item.id,
      verdict:          "deferred",
      reason:           `Feature ${featureLabel} exceeded daily budget (${dailyCeiling} TPD). Item deferred.`,
      reviewedAt:       new Date(),
    }).catch(() => null);
    console.log(`[executor] quota_exceeded for ${featureLabel} — item ${item.id} deferred`);
    return;
  }

  // Self-contained handlers — fetch their own data, manage their own LLM calls
  // and usage tracking, then return early, bypassing the generic callAgent path.

  // themeresearch: pure API fetch + cache write. No LLM call, no usage increment.
  if (item.actionType === "themeresearch") {
    const c    = (item.promptContext as { date: string; query: string });
    const date = c.date ?? new Date().toISOString().slice(0, 10);
    const query = c.query ?? "";
    const { citations, source } = await fetchResearch(query, date);
    console.log(`[executor] themeresearch: ${citations.length} citations from ${source}`);
    await db.update(aiQueue).set({ status: "completed" }).where(eq(aiQueue.id, item.id));
    return;
  }

  if (item.actionType === "archive_day") {
    await executeArchiveDay(agent, item, today);
    return;
  }

  if (item.actionType === "quality_review_archive") {
    await executeQualityReviewArchive(agent, item, today);
    return;
  }

  if (item.actionType === "rollup_week") {
    await executeRollupWeek(agent, item, today);
    return;
  }

  if (item.actionType === "rollup_month") {
    await executeRollupMonth(agent, item, today);
    return;
  }

  // conductor: builds its own prompt inline (writeConductorQuestion) and posts
  // directly — never had a buildPrompt() case, so it must short-circuit here
  // rather than falling into the generic callAgent path below, which throws
  // "No prompt template for action type: conductor" before ever reaching the
  // case "conductor" branch in the writer switch further down.
  if (item.actionType === "conductor") {
    await writeConductorQuestion(agent.id, item);
    return;
  }

  if (item.actionType === "ai_lab_debate") {
    await executeAILabDebate(agent, item, today);
    return;
  }

  if (item.actionType === "memory_reflect") {
    await executeMemoryReflection(agent, item, today);
    return;
  }

  // Research pre-call for participant and QC actions.
  // Participants: fetches + posts @research publicly, injects into prompt.
  // QC: fetches silently for fact-checking, does NOT post publicly.
  let researchInjection = "";
  if (item.actionType === "quality_review" && agent.role === "quality_checker") {
    const c2       = (item.promptContext as Record<string, unknown>) ?? {};
    const content  = String(c2.content ?? "");
    const qcTitle  = String(c2.ideaTitle ?? c2.idea_title ?? content.slice(0, 60));
    const qcTheme  = String(c2.theme ?? "");
    if (qcTitle) {
      try {
        const decision = await shouldFetchResearch(qcTitle, qcTheme, "quality_review");
        if (decision?.needsResearch && decision.query) {
          const result = await fetchResearch(decision.query, today);
          if (result.citations.length >= 2) {
            researchInjection = formatResearchBlock(result.citations, "FACT-CHECK CONTEXT — use this to verify factual claims");
          }
        }
      } catch (e) {
        console.warn("[executor] QC research pre-call error:", (e as Error).message);
      }
    }
  }

  if ((item.actionType === "comment" || item.actionType === "debate_reply") && agent.role === "participant") {
    const c2        = (item.promptContext as Record<string, unknown>) ?? {};
    const ideaTitle = String(c2.ideaTitle ?? c2.idea_title ?? "");
    const theme     = String(c2.theme ?? "");
    if (ideaTitle) {
      try {
        const decision = await shouldFetchResearch(ideaTitle, theme, item.actionType);
        if (decision?.needsResearch && decision.query) {
          const date   = today;
          const result = await fetchResearch(decision.query, date);
          if (result.citations.length >= 2 && item.targetIdeaId) {
            await writeResearchComment(item.targetIdeaId, result.citations, ideaTitle);
            researchInjection = formatResearchBlock(result.citations, "CURRENT DATA (@research just posted this)");
            console.log(`[executor] Research injected for ${agent.handle} — ${decision.query}`);
          }
        }
      } catch (e) {
        console.warn("[executor] Research pre-call error:", (e as Error).message);
      }
    }
  }

  // Build prompt and call LLM.
  // jsonMode: true enables response_format: { type: "json_object" } on Groq for
  // models that support it (Llama). Ignored for models that don't (Qwen3, GPT-OSS).
  const JSON_ACTIONS = new Set(["theme_select", "post_idea", "quality_review"]);
  // Memory injection (M1): fetch this agent's relevant past notes for the
  // current context. Best-effort — a retrieval failure must never block
  // the action, and an empty block leaves the prompt unchanged.
  let memoryBlock = "";
  {
    const cMem = (item.promptContext as Record<string, unknown>) ?? {};
    const memQuery = [
      cMem.ideaTitle ?? cMem.idea_title ?? "",
      cMem.theme ?? "",
      cMem.ideaContent ?? cMem.idea_content ?? "",
    ]
      .map(String)
      .join(" ")
      .trim();
    if (memQuery) {
      try {
        const mems = await getRelevantMemories(item.agentId, memQuery, 5);
        memoryBlock = formatMemoryBlock(mems);
      } catch (e) {
        console.warn("[executor] Memory retrieval failed:", (e as Error).message);
      }
    }
  }
  const prompt = buildPrompt(item, researchInjection, memoryBlock);
  const usageOut    = { tokens: 0 };
  const rawResponse = await callAgent(agent, prompt, {
    jsonMode: JSON_ACTIONS.has(item.actionType),
    usageOut,
  });

  // Defense-in-depth: strip thinking tags even though callAgent already does it
  const response = stripThinkingTags(rawResponse);

  if (!response.trim()) {
    throw new Error("Empty response after cleanup");
  }

  // Dispatch to the appropriate writer
  // 'comment' sub-dispatches on prompt_context.kind for mention responses
  const c = (item.promptContext as Record<string, unknown>) ?? {};
  switch (item.actionType) {
    case "theme_select":    await writeThemeSelect(agent.id, item, response); break;
    case "post_idea":       await writePostIdea(agent.id, item, response, prompt); break;
    case "comment":         await writeComment(agent.id, item, response);     break;
    case "quality_review":  await writeQualityReview(agent.id, item, response); break;
    // conductor, archive_day, and quality_review_archive handled by self-contained early returns above
    default:
      throw new Error(`Unknown action type: ${item.actionType}`);
  }

  // Upsert usage record — increment request_count + tokens for (agent, date)
  await db
    .insert(aiUsage)
    .values({
      agentId:       agent.id,
      date:          today,
      requestCount:  1,
      lastRequestAt: new Date(),
      lastProvider:  agent.provider,
      tokens:        usageOut.tokens,
    })
    .onConflictDoUpdate({
      target: [aiUsage.agentId, aiUsage.date],
      targetWhere: sql`${aiUsage.agentId} IS NOT NULL AND ${aiUsage.date} IS NOT NULL`,
      set: {
        requestCount:  sql`${aiUsage.requestCount} + 1`,
        lastRequestAt: new Date(),
        lastProvider:  agent.provider,
        tokens:        sql`${aiUsage.tokens} + ${usageOut.tokens}`,
      },
    });
}
