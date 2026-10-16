/**
 * scripts/backfill-archives.ts
 *
 * Generates — or with --force regenerates — daily archives and weekly/monthly
 * rollups for a date range, by calling the real production handlers
 * (executeArchiveDay / executeRollupWeek / executeRollupMonth).
 *
 * Replaces the 2026-08 version which duplicated the two-pass pipeline inline
 * and hardcoded llama-3.3-70b-versatile; when Groq retired that model the
 * script silently rotted. This version has no pipeline logic of its own, so
 * it cannot drift from production behaviour.
 *
 * Usage:
 *   npx tsx scripts/backfill-archives.ts --start 2026-10-01 --end 2026-10-14 [--force] [--dry-run] [--archives-only|--rollups-only]
 *
 *   --force  regenerate rows that already exist (handlers upsert on conflict)
 *   Without --force only missing rows are created (gap recovery).
 *
 * Incomplete periods (periodEnd after yesterday) are always skipped — the
 * scheduled Sunday/month-end jobs will generate them from the same data.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

const arg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const FORCE         = process.argv.includes("--force");
const DRY           = process.argv.includes("--dry-run");
const ARCHIVES_ONLY = process.argv.includes("--archives-only");
const ROLLUPS_ONLY  = process.argv.includes("--rollups-only");

function dateRange(start: string, end: string): string[] {
  const dates: string[] = [];
  const d = new Date(start + "T00:00:00Z");
  const e = new Date(end + "T00:00:00Z");
  while (d <= e) {
    dates.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return dates;
}

function weekRanges(start: string, end: string): Array<{ periodStart: string; periodEnd: string }> {
  // Production weeks are Sunday–Saturday: the executor defaults to
  // periodEnd = yesterday, periodStart = yesterday - 6 (see executeRollupWeek).
  const ranges: Array<{ periodStart: string; periodEnd: string }> = [];
  const d = new Date(start + "T00:00:00Z");
  const day = d.getUTCDay(); // 0 = Sunday
  if (day !== 0) d.setUTCDate(d.getUTCDate() - day); // align back to Sunday
  const e = new Date(end + "T00:00:00Z");
  while (d <= e) {
    const weekEnd = new Date(d);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
    ranges.push({
      periodStart: d.toISOString().slice(0, 10),
      periodEnd:   weekEnd.toISOString().slice(0, 10),
    });
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return ranges;
}

function monthRanges(start: string, end: string): Array<{ periodStart: string; periodEnd: string }> {
  const ranges: Array<{ periodStart: string; periodEnd: string }> = [];
  const d = new Date(start.slice(0, 7) + "-01T00:00:00Z");
  const e = new Date(end + "T00:00:00Z");
  while (d <= e) {
    const monthEnd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
    ranges.push({
      periodStart: d.toISOString().slice(0, 10),
      periodEnd:   monthEnd.toISOString().slice(0, 10),
    });
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return ranges;
}

async function main() {
  const start = arg("--start", "");
  const end   = arg("--end", "");
  if (!start || !end) {
    console.error("Usage: npx tsx scripts/backfill-archives.ts --start YYYY-MM-DD --end YYYY-MM-DD [--force] [--dry-run] [--archives-only|--rollups-only]");
    process.exit(1);
  }

  const { executeArchiveDay } = await import("../lib/agents/handlers/archive");
  const { executeRollupWeek, executeRollupMonth } = await import("../lib/agents/handlers/rollup");
  const { getAgent } = await import("../lib/agents/personas");
  const { db } = await import("../db");
  const { aiLabArchives, aiLabRollups } = await import("../db/schema");
  const { eq, and } = await import("drizzle-orm");

  const archivist = getAgent("ai_archivist");
  if (!archivist) { console.error("ai_archivist persona not found"); process.exit(1); }

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  const fakeItem = (ctx: Record<string, unknown>) => ({ id: "__backfill__", promptContext: ctx }) as never;

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Backfill ${start} → ${end}${FORCE ? "  [force]" : ""}${DRY ? "  [dry-run]" : ""}`);
  console.log(`${"=".repeat(60)}`);

  let ok = 0, skipped = 0, failed = 0;

  if (!ROLLUPS_ONLY) {
    console.log(`\n> Daily archives`);
    for (const date of dateRange(start, end)) {
      const [existing] = await db.select({ id: aiLabArchives.id }).from(aiLabArchives)
        .where(eq(aiLabArchives.date, date)).limit(1);
      if (existing && !FORCE) { console.log(`  ${date}: exists - skip`); skipped++; continue; }
      if (DRY) { console.log(`  ${date}: [dry-run] would ${existing ? "regenerate" : "create"}`); continue; }
      const t0 = Date.now();
      try {
        await executeArchiveDay({ ...archivist }, fakeItem({ date }), today);
        console.log(`  ${date}: done (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
        ok++;
      } catch (e) {
        console.error(`  ${date}: FAILED - ${(e as Error).message}`);
        failed++;
      }
    }
  }

  if (!ARCHIVES_ONLY) {
    console.log(`\n> Weekly rollups`);
    for (const w of weekRanges(start, end)) {
      if (w.periodEnd > yesterday) { console.log(`  ${w.periodStart}..${w.periodEnd}: incomplete period - skip`); skipped++; continue; }
      const [existing] = await db.select({ id: aiLabRollups.id }).from(aiLabRollups)
        .where(and(eq(aiLabRollups.periodType, "weekly"), eq(aiLabRollups.periodStart, w.periodStart))).limit(1);
      if (existing && !FORCE) { console.log(`  ${w.periodStart}..${w.periodEnd}: exists - skip`); skipped++; continue; }
      if (DRY) { console.log(`  ${w.periodStart}..${w.periodEnd}: [dry-run] would ${existing ? "regenerate" : "create"}`); continue; }
      try {
        await executeRollupWeek({ ...archivist }, fakeItem(w), today);
        console.log(`  ${w.periodStart}..${w.periodEnd}: done`);
        ok++;
      } catch (e) {
        console.error(`  ${w.periodStart}..${w.periodEnd}: FAILED - ${(e as Error).message}`);
        failed++;
      }
    }

    console.log(`\n> Monthly rollups`);
    for (const m of monthRanges(start, end)) {
      if (m.periodEnd > yesterday) { console.log(`  ${m.periodStart}..${m.periodEnd}: incomplete period - skip`); skipped++; continue; }
      const [existing] = await db.select({ id: aiLabRollups.id }).from(aiLabRollups)
        .where(and(eq(aiLabRollups.periodType, "monthly"), eq(aiLabRollups.periodStart, m.periodStart))).limit(1);
      if (existing && !FORCE) { console.log(`  ${m.periodStart}..${m.periodEnd}: exists - skip`); skipped++; continue; }
      if (DRY) { console.log(`  ${m.periodStart}..${m.periodEnd}: [dry-run] would ${existing ? "regenerate" : "create"}`); continue; }
      try {
        await executeRollupMonth({ ...archivist }, fakeItem(m), today);
        console.log(`  ${m.periodStart}..${m.periodEnd}: done`);
        ok++;
      } catch (e) {
        console.error(`  ${m.periodStart}..${m.periodEnd}: FAILED - ${(e as Error).message}`);
        failed++;
      }
    }
  }

  console.log(`\nSummary: ${ok} generated, ${skipped} skipped, ${failed} failed`);
  await db.$client.end();
}

main().catch((e) => {
  console.error("Fatal:", (e as Error).message);
  process.exit(1);
});
