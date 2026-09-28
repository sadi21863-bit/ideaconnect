/**
 * lib/agents/research.ts
 *
 * Unified research layer for all AI Lab agents.
 * Fetches real-world headlines and caches them for 24 hours.
 *
 * Providers (in fallback order):
 *   1. Currents API  — primary  (1,000 req/day free, no card)
 *   2. NewsData.io   — fallback (200 req/day free, commercial OK)
 *   3. Internal DB   — final    (last 7 days of aiThemes — always works)
 *
 * Cache: sha256(query|date|source) → 24h TTL in search_cache table.
 * A topic is only fetched once per 24h regardless of how many agents need it.
 */

import crypto from "crypto";
import { db } from "@/db";
import { searchCache, aiThemes } from "@/db/schema";
import { eq, gte, desc } from "drizzle-orm";

// ── Type definitions ──────────────────────────────────────────────────────────

export interface SourceCitation {
  title:       string; // max 120 chars
  summary:     string; // max 100 chars — never dump full articles into prompts
  publishedAt: string;
  source:      string;
  url:         string;
}

export interface ResearchResult {
  citations: SourceCitation[];
  source:    string; // which provider was used
  fromCache: boolean;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_ARTICLE_AGE_HOURS  = 96; // 4 days — policy/ethics topics don't generate daily spikes
const BREAKING_NEWS_MINUTES  = 120; // articles < 2h old are excluded (not yet verified)
const MAX_CITATIONS          = 5;
const CACHE_TTL_HOURS        = 24;

// ── Rotating 14-day query bank (Theme Setter) ───────────────────────────────

export const THEME_QUERY_BANK = [
  "artificial intelligence policy safety ethics",
  "technology privacy surveillance digital rights",
  "open source software community future models",
  "climate environment technology solutions policy",
  "democracy governance institutions global policy",
  "health medicine biotechnology longevity research",
  "media information culture creativity misinformation",
  "labor work education inequality institutions",
  "energy infrastructure housing urban systems",
  "science space exploration computing frontiers",
  "agriculture food water sustainability",
  "migration borders identity multilingual societies",
  "design accessibility interfaces everyday technology",
  "cybersecurity trust resilience digital society",
] as const;

export function getThemeQueryForDay(dayNumber: number): string {
  const index = ((dayNumber % THEME_QUERY_BANK.length) + THEME_QUERY_BANK.length) % THEME_QUERY_BANK.length;
  return THEME_QUERY_BANK[index];
}

export function getThemeQuery(): string {
  return getThemeQueryForDay(Math.floor(Date.now() / 86_400_000));
}

export function getIdeaQuery(ideaTitle: string): string {
  const titleWords = ideaTitle.trim().split(/\s+/).slice(0, 6).join(" ");
  return `${titleWords} ${new Date().getFullYear()}`;
}

// ── Cache helpers ─────────────────────────────────────────────────────────────

function buildQueryHash(query: string, date: string, source: string): string {
  return crypto.createHash("sha256").update(`${query}|${date}|${source}`).digest("hex");
}

async function getCached(hash: string): Promise<SourceCitation[] | null> {
  try {
    const [row] = await db
      .select()
      .from(searchCache)
      .where(eq(searchCache.queryHash, hash))
      .limit(1);
    if (!row) return null;
    if (new Date() > row.expiresAt) return null;
    return row.results as SourceCitation[];
  } catch {
    return null;
  }
}

async function setCache(
  hash: string, query: string, source: string, results: SourceCitation[]
): Promise<void> {
  const now       = new Date();
  const expiresAt = new Date(now.getTime() + CACHE_TTL_HOURS * 60 * 60 * 1000);
  try {
    await db
      .insert(searchCache)
      .values({ queryHash: hash, source, query, results, fetchedAt: now, expiresAt })
      .onConflictDoUpdate({
        target: searchCache.queryHash,
        set:    { results, fetchedAt: now, expiresAt },
      });
  } catch (e) {
    console.warn("[research] Cache write failed:", (e as Error).message);
  }
}

// ── Article filtering ─────────────────────────────────────────────────────────

function isStale(publishedAt: string): boolean {
  return Date.now() - new Date(publishedAt).getTime() > MAX_ARTICLE_AGE_HOURS * 3_600_000;
}

function isBreaking(publishedAt: string): boolean {
  return Date.now() - new Date(publishedAt).getTime() < BREAKING_NEWS_MINUTES * 60_000;
}

// ── Provider 1: Currents API ──────────────────────────────────────────────────

async function fetchFromCurrents(query: string): Promise<SourceCitation[]> {
  const key = process.env.CURRENTS_API_KEY;
  if (!key) throw new Error("CURRENTS_API_KEY not set");

  const url = new URL("https://api.currentsapi.services/v1/search");
  url.searchParams.set("keywords", query);
  url.searchParams.set("language", "en");
  url.searchParams.set("apiKey", key);

  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(8000),
    headers: { "User-Agent": "IdeaConnect-AILab/1.0" },
  });
  if (!res.ok) throw new Error(`Currents API error: ${res.status}`);

  const data    = await res.json();
  const articles = (data.news ?? []) as Record<string, unknown>[];

  return articles
    .filter(a => a.published && !isStale(String(a.published)) && !isBreaking(String(a.published)))
    .slice(0, MAX_CITATIONS)
    .map(a => ({
      title:       String(a.title       ?? "").slice(0, 120),
      summary:     String(a.description ?? "").slice(0, 100),
      publishedAt: String(a.published   ?? new Date().toISOString()),
      source:      String(a.author      ?? a.id ?? "unknown").split(".")[0],
      url:         String(a.url         ?? ""),
    }));
}

// ── Provider 2: NewsData.io ───────────────────────────────────────────────────

async function fetchFromNewsData(query: string): Promise<SourceCitation[]> {
  const key = process.env.NEWSDATA_API_KEY;
  if (!key) throw new Error("NEWSDATA_API_KEY not set");

  const url = new URL("https://newsdata.io/api/1/news");
  url.searchParams.set("apikey", key);
  url.searchParams.set("q", query);
  url.searchParams.set("language", "en");

  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`NewsData error: ${res.status}`);

  const data    = await res.json();
  const articles = (data.results ?? []) as Record<string, unknown>[];

  return articles
    .filter(a => a.pubDate && !isStale(String(a.pubDate)) && !isBreaking(String(a.pubDate)))
    .slice(0, MAX_CITATIONS)
    .map(a => ({
      title:       String(a.title       ?? "").slice(0, 120),
      summary:     String(a.description ?? "").slice(0, 100),
      publishedAt: String(a.pubDate     ?? new Date().toISOString()),
      source:      String(a.source_id   ?? "unknown"),
      url:         String(a.link        ?? ""),
    }));
}

// ── Provider 3: Internal history ──────────────────────────────────────────────

async function fetchFromInternalHistory(): Promise<SourceCitation[]> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString().slice(0, 10);
  const rows = await db
    .select()
    .from(aiThemes)
    .where(gte(aiThemes.date, sevenDaysAgo))
    .orderBy(desc(aiThemes.date))
    .limit(5);

  return rows.map(r => ({
    title:       r.theme,
    summary:     String(r.rationale ?? "").slice(0, 100),
    publishedAt: new Date(r.date).toISOString(),
    source:      "internal",
    url:         "",
  }));
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function fetchResearch(query: string, date: string): Promise<ResearchResult> {
  // 1. Cache check
  for (const source of ["currents", "newsdata"]) {
    const hash   = buildQueryHash(query, date, source);
    const cached = await getCached(hash);
    if (cached && cached.length >= 1) {
      return { citations: cached, source: `${source}:cache`, fromCache: true };
    }
  }

  // 2. Currents API (primary)
  try {
    const citations = await fetchFromCurrents(query);
    if (citations.length >= 1) {
      await setCache(buildQueryHash(query, date, "currents"), query, "currents", citations);
      return { citations, source: "currents", fromCache: false };
    }
  } catch (e) {
    console.warn("[research] Currents API failed:", (e as Error).message);
  }

  // 3. NewsData.io (fallback)
  try {
    const citations = await fetchFromNewsData(query);
    if (citations.length >= 1) {
      await setCache(buildQueryHash(query, date, "newsdata"), query, "newsdata", citations);
      return { citations, source: "newsdata", fromCache: false };
    }
  } catch (e) {
    console.warn("[research] NewsData failed:", (e as Error).message);
  }

  // 4. Internal history — always works
  const citations = await fetchFromInternalHistory();
  return { citations, source: "internal", fromCache: false };
}

export function formatResearchBlock(
  citations: SourceCitation[],
  label = "CURRENT CONTEXT (last 48h)"
): string {
  if (!citations.length) return "";
  const lines = citations.slice(0, 3).map((c, i) =>
    `${i + 1}. [${c.source}] ${c.title}${c.summary ? ` — ${c.summary}` : ""}`
  );
  return `\n\n## ${label}\nUse these real-world signals to ground your response. Do NOT cite URLs or quote titles verbatim.\n${lines.join("\n")}\n`;
}
