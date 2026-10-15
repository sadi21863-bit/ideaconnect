import { db } from "@/db";
import { aiThemes, ideas } from "@/db/schema";
import { and, desc, eq, gte, lt } from "drizzle-orm";
import { callGroq } from "./providers/groq";
import { tokenizeText } from "./handlers/memory";
import { parseJsonResponse } from "./json-helpers";

const AI_LAB_ROOM_ID = process.env.AI_LAB_ROOM_ID!;

// ─── Novelty gate (M2) ──────────────────────────────────────────────
// Two stages — no embedding infra required (no free embedding endpoint
// exists on OpenRouter as of 2026-08-23):
//   1. Lexical pre-filter: Jaccard similarity of token sets over
//      title+pitch vs each Lab idea from the last 14 days. Below
//      LEXICAL_TRIGGER the candidate is novel — no LLM call.
//   2. LLM verdict: the top matches go to a small model which decides
//      substantive duplication (same proposal/claim, not just same topic).

/** Jaccard tripwire — at/above this, the candidate needs an LLM verdict. */
export const LEXICAL_TRIGGER = 0.3;
export const THEME_LEXICAL_TRIGGER = 0.5;
/** Lookback window for the recent-idea corpus. */
export const NOVELTY_WINDOW_DAYS = 14;
/** Max candidates sent to the verdict model. */
const VERDICT_CANDIDATES = 3;

export function jaccardSimilarity(aTokens: string[], bTokens: string[]): number {
  if (aTokens.length === 0 || bTokens.length === 0) return 0;
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}

export interface NoveltyCandidate {
  id: string;
  title: string;
  pitch: string;
  similarity: number;
}

export interface NoveltyCheck {
  novel: boolean;
  maxSimilarity: number;
  closestId: string | null;
  closestTitle: string | null;
  reason: string | null;
}

interface NoveltyCorpusItem {
  id: string;
  title: string;
  pitch: string;
}

async function runNoveltyCheck(
  title: string,
  pitch: string,
  corpus: NoveltyCorpusItem[],
  opts: { llmVerdict?: boolean; lexicalTrigger?: number; subject?: "idea" | "theme" } = {}
): Promise<NoveltyCheck> {
  const {
    llmVerdict = true,
    lexicalTrigger = LEXICAL_TRIGGER,
    subject = "idea",
  } = opts;
  const candidateTokens = tokenizeText(`${title} ${pitch}`);
  const scored: NoveltyCandidate[] = corpus.map((r) => ({
    id: r.id,
    title: r.title,
    pitch: r.pitch,
    similarity: jaccardSimilarity(
      candidateTokens,
      tokenizeText(`${r.title} ${r.pitch}`)
    ),
  }));
  scored.sort((x, y) => y.similarity - x.similarity);

  const maxSimilarity = scored.length > 0 ? scored[0].similarity : 0;
  const suspicious = scored.filter((s) => s.similarity >= lexicalTrigger).slice(0, VERDICT_CANDIDATES);

  if (suspicious.length === 0 || !llmVerdict) {
    return {
      novel: maxSimilarity < lexicalTrigger,
      maxSimilarity,
      closestId: scored.length > 0 ? scored[0].id : null,
      closestTitle: scored.length > 0 ? scored[0].title : null,
      reason: null,
    };
  }

  try {
    const prompt =
      `You are deciding whether a newly drafted AI Lab ${subject} is substantively a duplicate of a recent ${subject}.\n\n` +
      `CANDIDATE:\nTitle: "${title}"\nPitch: "${pitch}"\n\n` +
      `RECENT ${subject.toUpperCase()}S (lexically similar):\n` +
      suspicious
        .map((s, i) => `${i + 1}. Title: "${s.title}"\n   Pitch: "${s.pitch}"`)
        .join("\n") +
      `\n\nAre any of these the SAME ${subject} — same proposal, claim, or topic focus, not just the same broad domain? ` +
      `Respond in JSON only:\n{"duplicate": true/false, "reason": "one sentence", "matchIndex": 0-based index or null}`;

    const res = await callGroq(
      process.env.AGENT_MODEL_FALLBACK ?? "openai/gpt-oss-20b",
      "You are a novelty judge. Respond in JSON only. No markdown fences.",
      prompt,
      // jsonMode off (20b 400s under response_format) + low reasoning so the
      // verdict fits the small cap instead of failing open (see providers/index.ts)
      { maxTokens: 150, reasoningEffort: "low" }
    );
    const parsed = parseJsonResponse(res.text.trim()) as {
      duplicate?: unknown;
      reason?: unknown;
      matchIndex?: unknown;
    };
    const duplicate = parsed.duplicate === true;
    const match =
      typeof parsed.matchIndex === "number" && suspicious[parsed.matchIndex]
        ? suspicious[parsed.matchIndex]
        : suspicious[0];
    return {
      novel: !duplicate,
      maxSimilarity,
      closestId: match.id,
      closestTitle: match.title,
      reason: typeof parsed.reason === "string" ? parsed.reason : null,
    };
  } catch (e) {
    console.warn("[novelty] Verdict call failed, failing open:", (e as Error).message);
    return {
      novel: true,
      maxSimilarity,
      closestId: suspicious[0]?.id ?? null,
      closestTitle: suspicious[0]?.title ?? null,
      reason: "verdict-unavailable",
    };
  }
}

export async function checkIdeaNovelty(
  title: string,
  pitch: string,
  opts: { llmVerdict?: boolean } = {}
): Promise<NoveltyCheck> {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - NOVELTY_WINDOW_DAYS);

  const recent = await db
    .select({ id: ideas.id, title: ideas.title, pitch: ideas.context })
    .from(ideas)
    .where(
      and(
        eq(ideas.roomId, AI_LAB_ROOM_ID),
        eq(ideas.status, "published"),
        gte(ideas.createdAt, cutoff)
      )
    )
    .orderBy(desc(ideas.createdAt))
    .limit(60);

  return runNoveltyCheck(
    title,
    pitch,
    recent.map((r) => ({
      id: String(r.id),
      title: String(r.title ?? ""),
      pitch: String(r.pitch ?? ""),
    })),
    opts
  );
}

export async function checkThemeNovelty(
  theme: string,
  opts: { llmVerdict?: boolean } = {}
): Promise<NoveltyCheck> {
  const today = new Date().toISOString().slice(0, 10);
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - NOVELTY_WINDOW_DAYS);
  const cutoffDate = cutoff.toISOString().slice(0, 10);

  const recent = await db
    .select({ date: aiThemes.date, theme: aiThemes.theme, rationale: aiThemes.rationale })
    .from(aiThemes)
    .where(and(gte(aiThemes.date, cutoffDate), lt(aiThemes.date, today)))
    .orderBy(desc(aiThemes.date))
    .limit(20);

  return runNoveltyCheck(
    theme,
    "",
    recent.map((r) => ({
      id: String(r.date),
      title: String(r.theme ?? ""),
      pitch: String(r.rationale ?? ""),
    })),
    { ...opts, lexicalTrigger: THEME_LEXICAL_TRIGGER, subject: "theme" }
  );
}
