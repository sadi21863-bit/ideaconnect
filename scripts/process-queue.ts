/**
 * scripts/process-queue.ts
 *
 * Queue processor for GitHub Actions (no function timeout).
 * Self-healing: checks whether today's theme and ideas have been seeded
 * and queues them if missing — so a missed Vercel cron is recovered within
 * the next 5-minute GHA run, without any manual intervention.
 *
 * Usage: npx tsx scripts/process-queue.ts
 *
 * Required env vars (set as GitHub Secrets):
 *   DATABASE_URL, GROQ_API_KEY, GH_MODELS_TOKEN, AI_LAB_ROOM_ID, AI_LAB_ENABLED
 */

import * as dotenv from "dotenv";
import * as path from "path";
dotenv.config({ path: path.resolve(process.cwd(), ".env") });
dotenv.config({ path: path.resolve(process.cwd(), ".env.local"), override: true });

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { processQueue, resetStuckQueueItems } from "@/lib/agents/executor";
import {
  queueThemeResearch,
  queueThemeSelection,
  queueDailyIdeas,
  queueAILabDebateOfDay,
  queueDailyArchive,
  queueWeeklyRollup,
  queueMonthlyRollup,
  queueMemoryReflection,
} from "@/lib/agents/scheduler";
import { getParticipants } from "@/lib/agents/personas";
import { HANDLED_QUEUE_STATUSES_SQL } from "../lib/agents/queue-statuses";

const client = postgres(process.env.DATABASE_URL!, { prepare: false });
const rawDb  = drizzle(client);

/** yyyy-mm-dd in UTC — matches how AI Lab crons schedule work */
function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Self-healing check: if today's theme or ideas are missing from the queue
 * and the DB, queue them now. This recovers from missed Vercel crons without
 * any manual intervention, within the next 5-minute GHA window.
 */
async function ensureDailyWorkQueued(): Promise<void> {
  const today = todayUTC();

  // ── Research (priority 0 — must run before theme selection) ──────────
  const [researchQueued] = await rawDb.execute(sql`
    SELECT 1 FROM ai_queue
    WHERE  action_type = 'themeresearch'
      AND  DATE(scheduled_for AT TIME ZONE 'UTC') = ${today}
      AND  status IN (${sql.raw(HANDLED_QUEUE_STATUSES_SQL)})
    LIMIT 1
  `) as unknown as [unknown?];

  const [researchCached] = await rawDb.execute(sql`
    SELECT 1 FROM search_cache
    WHERE  DATE(fetched_at AT TIME ZONE 'UTC') = ${today}
    LIMIT 1
  `) as unknown as [unknown?];

  if (!researchQueued && !researchCached) {
    await queueThemeResearch(today);
    console.log(`[process-queue] Queued themeresearch for ${today}`);
  }

  // ── Theme ────────────────────────────────────────────────────────────
  // Primary check: theme row in ai_themes (most reliable — means it was processed).
  // Secondary check: any handled queue item for today (generation in flight or terminal).
  const [themeInDb] = await rawDb.execute(sql`
    SELECT 1 FROM ai_themes WHERE date = ${today} LIMIT 1
  `) as unknown as [unknown?];

  const [themeInQueue] = await rawDb.execute(sql`
    SELECT 1 FROM ai_queue
    WHERE  action_type   = 'theme_select'
      AND  scheduled_for >= (${today}::date)
      AND  status        IN (${sql.raw(HANDLED_QUEUE_STATUSES_SQL)})
    LIMIT 1
  `) as unknown as [unknown?];

  if (!themeInDb && !themeInQueue) {
    console.log(`[process-queue] No theme for ${today} — queuing theme selection`);
    await queueThemeSelection();
  }

  // ── Ideas ────────────────────────────────────────────────────────────
  // Only seed ideas once the theme is in the DB (ideas reference the theme).
  if (themeInDb) {
    const participantIds = getParticipants().map((agent) => agent.id);
    const ideaAuthors = await rawDb.execute(sql`
      SELECT DISTINCT user_id
      FROM ideas
      WHERE  room_id = ${process.env.AI_LAB_ROOM_ID}
        AND  DATE(created_at AT TIME ZONE 'UTC') = ${today}
        AND  status = 'published'
    `) as unknown as Array<{ user_id: string | null }>;
    const completedParticipantIds = new Set(
      ideaAuthors.map((row) => row.user_id).filter((id): id is string => Boolean(id))
    );
    const missingParticipantIds = participantIds.filter((id) => !completedParticipantIds.has(id));

    if (missingParticipantIds.length > 0) {
      const activeIdeaAgents = await rawDb.execute(sql`
        SELECT DISTINCT agent_id
        FROM ai_queue
        WHERE  action_type = 'post_idea'
          AND  created_at >= (${today}::date)
          AND  status IN (${sql.raw(HANDLED_QUEUE_STATUSES_SQL)})
      `) as unknown as Array<{ agent_id: string | null }>;
      const activeAgentIds = new Set(
        activeIdeaAgents.map((row) => row.agent_id).filter((id): id is string => Boolean(id))
      );
      const stillMissing = missingParticipantIds.filter((id) => !activeAgentIds.has(id));

      if (stillMissing.length > 0) {
        console.log(`[process-queue] Requeueing missing participant ideas for ${today}: ${stillMissing.join(", ")}`);
        await queueDailyIdeas(stillMissing);
      }
    }
  }

  // ── Archive ───────────────────────────────────────────────────────────
  // Primary check: row in ai_lab_archives (archive was generated — most reliable).
  // Secondary check: pending/in_progress queue item (generation in flight).
  //
  // IMPORTANT: completed/dead-lettered rows are also treated as handled here.
  // The archive table remains the source of truth; including terminal queue
  // states prevents a dead-lettered archive from being recreated every beat.
  const nowUTC   = new Date();
  const yesterday = new Date(Date.UTC(
    nowUTC.getUTCFullYear(), nowUTC.getUTCMonth(), nowUTC.getUTCDate() - 1,
  ));
  const yesterdayStr = yesterday.toISOString().slice(0, 10);

  const [yesterdayArchiveInDb] = await rawDb.execute(sql`
    SELECT 1 FROM ai_lab_archives WHERE date = ${yesterdayStr} LIMIT 1
  `) as unknown as [unknown?];

  const [yesterdayArchiveInQueue] = await rawDb.execute(sql`
    SELECT 1 FROM ai_queue
    WHERE  action_type           = 'archive_day'
      AND  prompt_context->>'date' = ${yesterdayStr}
      AND  status                IN (${sql.raw(HANDLED_QUEUE_STATUSES_SQL)})
    LIMIT 1
  `) as unknown as [unknown?];

  if (!yesterdayArchiveInDb && !yesterdayArchiveInQueue) {
    console.log(`[process-queue] No archive for ${yesterdayStr} — queuing archive`);
    await queueDailyArchive(yesterdayStr);
  }

  // Check today's archive: only attempt after 18:00 UTC (30-min buffer past the 17:30 cron).
  if (nowUTC.getUTCHours() >= 18) {
    const [todayArchiveInDb] = await rawDb.execute(sql`
      SELECT 1 FROM ai_lab_archives WHERE date = ${today} LIMIT 1
    `) as unknown as [unknown?];

    const [todayArchiveInQueue] = await rawDb.execute(sql`
      SELECT 1 FROM ai_queue
      WHERE  action_type           = 'archive_day'
        AND  prompt_context->>'date' = ${today}
        AND  status                IN (${sql.raw(HANDLED_QUEUE_STATUSES_SQL)})
      LIMIT 1
    `) as unknown as [unknown?];

    if (!todayArchiveInDb && !todayArchiveInQueue) {
      console.log(`[process-queue] No archive for ${today} — queuing archive`);
      await queueDailyArchive(today);
    }
  }

  if (nowUTC.getUTCHours() >= 16) {
    const [debateInQueue] = await rawDb.execute(sql`
      SELECT 1
      FROM ai_queue q
      JOIN ideas i ON i.id = q.target_idea_id
      WHERE q.action_type = 'ai_lab_debate'
        AND DATE(i.created_at AT TIME ZONE 'UTC') = ${today}
      LIMIT 1
    `) as unknown as [unknown?];

    if (!debateInQueue) {
      console.log(`[process-queue] Ensuring Debate of the Day for ${today}`);
      await queueAILabDebateOfDay(today);
    }
  }

  if (nowUTC.getUTCHours() >= 19) {
    const [memoryInQueue] = await rawDb.execute(sql`
      SELECT 1
      FROM ai_queue
      WHERE action_type = 'memory_reflect'
        AND created_at >= (${today}::date)
      LIMIT 1
    `) as unknown as [unknown?];

    if (!memoryInQueue) {
      console.log(`[process-queue] Ensuring memory reflection for ${today}`);
      await queueMemoryReflection(today);
    }
  }
}

/**
 * Self-healing check for weekly/monthly rollups (added 2026-08-07).
 *
 * WHY: Vercel Hobby silently drops crons beyond the first two, so the
 * rollup-weekly / rollup-monthly Vercel crons were never firing — the last
 * rollup_week queue item was 2026-07-05. The GHA 5-minute run is the reliable
 * beat, so it now owns rollup scheduling: on Sundays it ensures the weekly
 * rollup is queued, on the 1st of the month the monthly one — mirroring the
 * old cron schedule (0 18 * * 0 / 31 18 1 * *), self-healed within 5 minutes
 * if a run was missed.
 *
 * FORCE_ROLLUP_WEEK / FORCE_ROLLUP_MONTH env vars (set via workflow_dispatch
 * inputs) queue the latest period immediately regardless of day — used to
 * backfill the rollups missed since 2026-07-05.
 */
async function ensureRollupQueued(): Promise<void> {
  const nowUTC = new Date();
  const forceWeek  = process.env.FORCE_ROLLUP_WEEK  === "true";
  const forceMonth = process.env.FORCE_ROLLUP_MONTH === "true";

  if (forceWeek || nowUTC.getUTCDay() === 0) {
    const periodEnd   = new Date(Date.UTC(nowUTC.getUTCFullYear(), nowUTC.getUTCMonth(), nowUTC.getUTCDate() - 1));
    const periodStart = new Date(Date.UTC(nowUTC.getUTCFullYear(), nowUTC.getUTCMonth(), nowUTC.getUTCDate() - 7));
    await queueRollupIfMissing("rollup_week", "weekly", periodStart, periodEnd, forceWeek);
  }

  if (forceMonth || nowUTC.getUTCDate() === 1) {
    const periodStart = new Date(Date.UTC(nowUTC.getUTCFullYear(), nowUTC.getUTCMonth() - 1, 1));
    const periodEnd   = new Date(Date.UTC(nowUTC.getUTCFullYear(), nowUTC.getUTCMonth(), 0));
    await queueRollupIfMissing("rollup_month", "monthly", periodStart, periodEnd, forceMonth);
  }
}

async function queueRollupIfMissing(
  actionType:  "rollup_week" | "rollup_month",
  periodType:  "weekly" | "monthly",
  periodStart: Date,
  periodEnd:   Date,
  force:       boolean
): Promise<void> {
  const pStart = periodStart.toISOString().slice(0, 10);
  const pEnd   = periodEnd.toISOString().slice(0, 10);

  if (!force) {
    const [rollupInDb] = await rawDb.execute(sql`
      SELECT 1 FROM ai_lab_rollups
      WHERE  period_type   = ${periodType}
        AND  period_start  = ${pStart}::date
      LIMIT 1
    `) as unknown as [unknown?];

    const [rollupInQueue] = await rawDb.execute(sql`
      SELECT 1 FROM ai_queue
      WHERE  action_type                  = ${actionType}
        AND  prompt_context->>'periodStart' = ${pStart}
        AND  status IN (${sql.raw(HANDLED_QUEUE_STATUSES_SQL)})
      LIMIT 1
    `) as unknown as [unknown?];

    if (rollupInDb || rollupInQueue) return;
  }

  console.log(`[process-queue] ${force ? "Forcing" : "Queuing"} ${actionType} for ${pStart}..${pEnd}`);
  if (actionType === "rollup_week") {
    await queueWeeklyRollup();
  } else {
    await queueMonthlyRollup();
  }
}

async function main() {
  if (process.env.AI_LAB_ENABLED !== "true") {
    console.log("[process-queue] AI_LAB_ENABLED is not 'true' — skipping.");
    await client.end();
    return;
  }

  // 1. Self-heal: ensure today's theme and ideas are queued
  await ensureDailyWorkQueued();

  // 1b. Self-heal: weekly (Sundays) and monthly (1st) rollups — Vercel Hobby
  //     silently dropped these crons; GHA owns them now.
  await ensureRollupQueued();

  // 2. Purge redundant archive_day queue items that accumulated due to a previous
  //    bug in ensureDailyWorkQueued (used status='done' which doesn't exist, causing
  //    re-queuing on every run after the archive completed). Any pending archive_day
  //    item whose date already has a row in ai_lab_archives is a duplicate — cancel it.
  const purged = await rawDb.execute(sql`
    UPDATE ai_queue
    SET    status = 'cancelled',
           error_message = 'cancelled: duplicate archive_day — archive already exists in ai_lab_archives'
    WHERE  action_type = 'archive_day'
      AND  status      = 'pending'
      AND  EXISTS (
        SELECT 1 FROM ai_lab_archives
        WHERE  date = (prompt_context->>'date')::date
      )
  `);
  const purgedCount = (purged as { rowCount?: number }).rowCount ?? 0;
  if (purgedCount > 0) {
    console.log(`[process-queue] Purged ${purgedCount} redundant archive_day item(s)`);
  }

  // 2b. Same purge for rollups — a pending rollup whose period already has a row
  //     in ai_lab_rollups is a duplicate (executor upserts on conflict, so this
  //     prevents re-running an already-generated period on the next Sunday beat).
  const purgedRollups = await rawDb.execute(sql`
    UPDATE ai_queue
    SET    status = 'cancelled',
           error_message = 'cancelled: duplicate rollup — rollup already exists in ai_lab_rollups'
    WHERE  action_type IN ('rollup_week', 'rollup_month')
      AND  status = 'pending'
      AND  EXISTS (
        SELECT 1 FROM ai_lab_rollups
        WHERE  period_type  = CASE WHEN action_type = 'rollup_week' THEN 'weekly' ELSE 'monthly' END
          AND  period_start = (prompt_context->>'periodStart')::date
      )
  `);
  const purgedRollupsCount = (purgedRollups as { rowCount?: number }).rowCount ?? 0;
  if (purgedRollupsCount > 0) {
    console.log(`[process-queue] Purged ${purgedRollupsCount} redundant rollup item(s)`);
  }

  // 3. Reset any items stuck in_progress from a previous timeout
  const recovered = await resetStuckQueueItems();
  if (recovered > 0) {
    console.log(`[process-queue] Reset ${recovered} stuck in_progress item(s)`);
  }

  // 4. Advance genuinely overdue pending items to now() so processQueue picks them up.
  // Guard: only advance items that are MORE than 15 minutes overdue.
  // Items within their stagger window (idea posts 3–4 min, debate replies 2 min, etc.)
  // are left alone — advancing them early would cause a rate-limit burst.
  const advanced = await rawDb.execute(sql`
    UPDATE ai_queue
    SET    scheduled_for = now()
    WHERE  status        = 'pending'
      AND  scheduled_for < now() - INTERVAL '15 minutes'
     AND  action_type <> 'conductor'
  `);
  const advancedCount = (advanced as { rowCount?: number }).rowCount ?? 0;
  if (advancedCount > 0) {
    console.log(`[process-queue] Advanced ${advancedCount} pending item(s) to now()`);
  }

  // 5. Drain the queue in batches (max 5 passes per run to stay within GHA limits)
  let totalProcessed = 0;
  let totalFailed    = 0;
  const allErrors: Array<{ id: string; agentId: string; actionType: string; error: string }> = [];

  for (let pass = 0; pass < 5; pass++) {
    const result = await processQueue(10);
    totalProcessed += result.processed;
    totalFailed    += result.failed;
    allErrors.push(...result.errors);

    if (result.processed === 0 && result.failed === 0) break;

    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log(`[process-queue] Finished — processed: ${totalProcessed}, failed: ${totalFailed}`);
  if (allErrors.length > 0) {
    console.log("[process-queue] Failed items:");
    for (const e of allErrors) {
      console.log(`  • [${e.actionType}] agent=${e.agentId} id=${e.id} — ${e.error}`);
    }
  }

  await client.end();
}

main().catch((err) => {
  console.error("[process-queue] Fatal:", err);
  process.exit(1);
});
