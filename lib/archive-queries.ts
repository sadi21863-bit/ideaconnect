/**
 * lib/archive-queries.ts
 *
 * Reusable data-fetching functions for the public AI Lab archive pages.
 * All functions return null (not throw) for missing/unpublished content
 * so page components can call notFound() cleanly.
 */

import { db } from "@/db";
import { aiLabArchives, aiLabRollups, ideas } from "@/db/schema";
import { and, asc, desc, eq, gt, gte, ilike, lt, lte, or, sql } from "drizzle-orm";

export const ARCHIVE_PAGE_SIZE = 20;
const AI_LAB_ROOM_ID = process.env.AI_LAB_ROOM_ID ?? "";

export function normalizeArchiveSearch(search?: string): string {
  return (search ?? "").trim().replace(/\s+/g, " ").slice(0, 100);
}

function archiveSearchPattern(search?: string): string | null {
  const normalized = normalizeArchiveSearch(search);
  if (!normalized) return null;
  return `%${normalized.replace(/[\\%_]/g, "\\$&")}%`;
}

function dailyArchiveIndexCondition(search?: string) {
  const published = eq(aiLabArchives.status, "published");
  const pattern = archiveSearchPattern(search);
  if (!pattern) return published;
  return and(
    published,
    or(
      ilike(aiLabArchives.theme, pattern),
      ilike(aiLabArchives.narrativeArc, pattern),
      ilike(aiLabArchives.summaryMarkdown, pattern),
    ),
  );
}

function rollupIndexCondition(periodType: "weekly" | "monthly", search?: string) {
  const publishedAndType = and(
    eq(aiLabRollups.periodType, periodType),
    eq(aiLabRollups.status, "published"),
  );
  const pattern = archiveSearchPattern(search);
  if (!pattern) return publishedAndType;
  return and(
    publishedAndType,
    or(
      ilike(aiLabRollups.title, pattern),
      ilike(aiLabRollups.narrativeArc, pattern),
      ilike(aiLabRollups.summaryMarkdown, pattern),
    ),
  );
}

// ─── Plain-text excerpt utility ───────────────────────────────────────

/** Strip markdown syntax for og:description and index card previews. */
export function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")          // ## headers
    .replace(/\*\*(.+?)\*\*/g, "$1")       // **bold**
    .replace(/\*(.+?)\*/g, "$1")           // *italic*
    .replace(/`(.+?)`/g, "$1")             // `code`
    .replace(/\[(.+?)\]\(.+?\)/g, "$1")   // [link](url)
    .replace(/^\s*[-*+]\s+/gm, "")        // list bullets
    .replace(/\n+/g, " ")                 // newlines → space
    .trim();
}

// ─── Daily archives ───────────────────────────────────────────────────

/**
 * Returns the published daily archive for a given date, or null.
 * Fetches by date first so non-published rows explicitly return null
 * (enabling a correct 404 vs "draft" distinction if needed).
 */
export async function getDailyArchive(date: string) {
  const rows = await db
    .select()
    .from(aiLabArchives)
    .where(eq(aiLabArchives.date, date));
  const row = rows[0];
  if (!row || row.status !== "published") return null;
  return row;
}

/** Previous and next published daily archive dates (for footer nav). */
export async function getAdjacentDailyArchives(date: string) {
  const [prevRows, nextRows] = await Promise.all([
    db
      .select({ date: aiLabArchives.date })
      .from(aiLabArchives)
      .where(and(eq(aiLabArchives.status, "published"), lt(aiLabArchives.date, date)))
      .orderBy(desc(aiLabArchives.date))
      .limit(1),
    db
      .select({ date: aiLabArchives.date })
      .from(aiLabArchives)
      .where(and(eq(aiLabArchives.status, "published"), gt(aiLabArchives.date, date)))
      .orderBy(asc(aiLabArchives.date))
      .limit(1),
  ]);
  return {
    prev: (prevRows[0]?.date as string | undefined) ?? null,
    next: (nextRows[0]?.date as string | undefined) ?? null,
  };
}

export async function getArchiveIndex(page: number, search?: string) {
  const offset = (page - 1) * ARCHIVE_PAGE_SIZE;
  return db
    .select()
    .from(aiLabArchives)
    .where(dailyArchiveIndexCondition(search))
    .orderBy(desc(aiLabArchives.date))
    .limit(ARCHIVE_PAGE_SIZE)
    .offset(offset);
}

export async function getArchiveIndexCount(search?: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(aiLabArchives)
    .where(dailyArchiveIndexCondition(search));
  return Number(rows[0]?.count ?? 0);
}

// ─── Weekly rollups ───────────────────────────────────────────────────

/** Returns the published weekly rollup whose period_end matches endDate, or null. */
export async function getWeeklyRollup(endDate: string) {
  const rows = await db
    .select()
    .from(aiLabRollups)
    .where(
      and(
        eq(aiLabRollups.periodType, "weekly"),
        eq(aiLabRollups.periodEnd, endDate),
      )
    );
  const row = rows[0];
  if (!row || row.status !== "published") return null;
  return row;
}

export async function getAdjacentWeeklyRollups(endDate: string) {
  const [prevRows, nextRows] = await Promise.all([
    db
      .select({ periodEnd: aiLabRollups.periodEnd })
      .from(aiLabRollups)
      .where(and(
        eq(aiLabRollups.periodType, "weekly"),
        eq(aiLabRollups.status, "published"),
        lt(aiLabRollups.periodEnd, endDate),
      ))
      .orderBy(desc(aiLabRollups.periodEnd))
      .limit(1),
    db
      .select({ periodEnd: aiLabRollups.periodEnd })
      .from(aiLabRollups)
      .where(and(
        eq(aiLabRollups.periodType, "weekly"),
        eq(aiLabRollups.status, "published"),
        gt(aiLabRollups.periodEnd, endDate),
      ))
      .orderBy(asc(aiLabRollups.periodEnd))
      .limit(1),
  ]);
  return {
    prev: (prevRows[0]?.periodEnd as string | undefined) ?? null,
    next: (nextRows[0]?.periodEnd as string | undefined) ?? null,
  };
}

/** Published daily archives within a weekly rollup's date range (for "Days this week" list). */
export async function getDailyArchivesInRange(startDate: string, endDate: string) {
  return db
    .select({ date: aiLabArchives.date, theme: aiLabArchives.theme })
    .from(aiLabArchives)
    .where(and(
      eq(aiLabArchives.status, "published"),
      gte(aiLabArchives.date, startDate),
      lte(aiLabArchives.date, endDate),
    ))
    .orderBy(asc(aiLabArchives.date));
}

// ─── Monthly rollups ──────────────────────────────────────────────────

/** Returns the published monthly rollup for a given "YYYY-MM" string, or null. */
export async function getMonthlyRollup(yearMonth: string) {
  const periodStart = `${yearMonth}-01`;
  const rows = await db
    .select()
    .from(aiLabRollups)
    .where(
      and(
        eq(aiLabRollups.periodType, "monthly"),
        eq(aiLabRollups.periodStart, periodStart),
      )
    );
  const row = rows[0];
  if (!row || row.status !== "published") return null;
  return row;
}

export async function getAdjacentMonthlyRollups(yearMonth: string) {
  const periodStart = `${yearMonth}-01`;
  const [prevRows, nextRows] = await Promise.all([
    db
      .select({ periodStart: aiLabRollups.periodStart })
      .from(aiLabRollups)
      .where(and(
        eq(aiLabRollups.periodType, "monthly"),
        eq(aiLabRollups.status, "published"),
        lt(aiLabRollups.periodStart, periodStart),
      ))
      .orderBy(desc(aiLabRollups.periodStart))
      .limit(1),
    db
      .select({ periodStart: aiLabRollups.periodStart })
      .from(aiLabRollups)
      .where(and(
        eq(aiLabRollups.periodType, "monthly"),
        eq(aiLabRollups.status, "published"),
        gt(aiLabRollups.periodStart, periodStart),
      ))
      .orderBy(asc(aiLabRollups.periodStart))
      .limit(1),
  ]);
  const prevPs = (prevRows[0]?.periodStart as string | undefined) ?? null;
  const nextPs = (nextRows[0]?.periodStart as string | undefined) ?? null;
  return {
    prev: prevPs ? prevPs.slice(0, 7) : null,
    next: nextPs ? nextPs.slice(0, 7) : null,
  };
}

/** Published weekly rollups within a month's date range (for "Weeks this month" list). */
export async function getWeeklyRollupsInRange(startDate: string, endDate: string) {
  return db
    .select({
      periodEnd:   aiLabRollups.periodEnd,
      periodStart: aiLabRollups.periodStart,
      title:       aiLabRollups.title,
    })
    .from(aiLabRollups)
    .where(and(
      eq(aiLabRollups.periodType, "weekly"),
      eq(aiLabRollups.status, "published"),
      gte(aiLabRollups.periodStart, startDate),
      lte(aiLabRollups.periodEnd, endDate),
    ))
    .orderBy(asc(aiLabRollups.periodStart));
}

export async function getRollupIndex(periodType: "weekly" | "monthly", page: number, search?: string) {
  const offset = (page - 1) * ARCHIVE_PAGE_SIZE;
  return db
    .select()
    .from(aiLabRollups)
    .where(rollupIndexCondition(periodType, search))
    .orderBy(desc(aiLabRollups.periodStart))
    .limit(ARCHIVE_PAGE_SIZE)
    .offset(offset);
}

export async function getRollupIndexCount(periodType: "weekly" | "monthly", search?: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(aiLabRollups)
    .where(rollupIndexCondition(periodType, search));
  return Number(rows[0]?.count ?? 0);
}

// ─── Ideas for a day (for "Ideas posted" section) ─────────────────────

export async function getIdeasForDate(date: string) {
  return db
    .select({ id: ideas.id, title: ideas.title, userId: ideas.userId })
    .from(ideas)
    .where(and(
      eq(ideas.status, "published"),
      eq(ideas.roomId, AI_LAB_ROOM_ID),
      sql`DATE(${ideas.createdAt} AT TIME ZONE 'UTC') = ${date}`,
    ))
    .orderBy(asc(ideas.createdAt));
}
