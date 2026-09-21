/**
 * lib/agents/scheduler.ts
 *
 * Handles WHEN actions are queued. Writes rows to ai_queue only —
 * does NOT call any LLM. The executor reads the queue and runs actions.
 *
 * Action type naming follows Section 4.2 of the spec (executor dispatch table):
 *   theme_select | post_idea | comment | quality_review | archive_day
 */

import { db } from "@/db";
import { aiQueue, aiThemes, ideas, ideaComments, searchCache } from "@/db/schema";
import { and, asc, desc, eq, gte, inArray } from "drizzle-orm";
import { z } from "zod";
import { ALL_AGENTS, getAdmins, getConductor, getParticipants } from "./personas";
import { getThemeQuery } from "./research";

const AI_LAB_ROOM_ID = process.env.AI_LAB_ROOM_ID!;

// ─── promptContext Zod schemas ─────────────────────────────────────────────
// One schema per action type. Validated before every db.insert(aiQueue) call.
// If validation fails the queue row is NOT written and the error is logged.

const ThemeResearchContext = z.object({
  date:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  query: z.string().min(1).max(300),
});

const SourceCitationSchema = z.object({
  title:       z.string(),
  summary:     z.string(),
  publishedAt: z.string(),
  source:      z.string(),
  url:         z.string(),
});

const ThemeSelectContext = z.object({
  recentThemes:    z.array(z.string()),
  researchContext: z.array(SourceCitationSchema).max(10).optional(),
});

const PostIdeaContext = z.object({
  theme:           z.string().min(1),
  rationale:       z.string().nullable(),
  suggestedAngles: z.array(z.string()),
});

const LabCommentContext = z.object({
  authorHandle: z.string().min(1),
  ideaTitle:    z.string(),
  ideaPitch:    z.string(),
  ideaContent:  z.string(),
});

const DebateReplyContext = z.object({
  kind:             z.literal("debate_reply"),
  parentCommentId:  z.string().uuid(),
  commenterHandle:  z.string().min(1),
  commenterComment: z.string(),
  ideaTitle:        z.string(),
  ideaPitch:        z.string(),
  ideaContent:      z.string(),
});

const QualityReviewContext = z.object({
  targetType:   z.enum(["idea", "comment"]),
  targetId:     z.string().min(1),
  content:      z.string().min(1),
  theme:        z.string(),
  authorHandle: z.string(),
});

const RollupContext = z.object({
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const ArchiveDayContext = z.object({
  date:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  theme: z.string(),
});

const AILabDebateContext = z.object({
  ideaTitle:   z.string(),
  ideaContent: z.string(),
  theme:       z.string(),
});

const MemoryReflectContext = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
});

// ── Validation helper ──────────────────────────────────────────────────────
// Returns true if valid. Logs the error and returns false if invalid.
// Caller must return/continue early on false so no broken row is written.

function validateContext<T>(
  schema: z.ZodType<T>,
  data:   unknown,
  actionType: string
): data is T {
  const result = schema.safeParse(data);
  if (!result.success) {
    console.error(
      `[scheduler] Invalid promptContext for ${actionType}:`,
      result.error.flatten()
    );
    return false;
  }
  return true;
}

// ─── Theme research ───────────────────────────────────────────────────

/**
 * Queues a themeresearch action (priority 0 — runs before theme_select).
 * Idempotent: skips if today's research is already cached.
 */
export async function queueThemeResearch(date: string): Promise<void> {
  const query      = getThemeQuery();
  const startOfDay = new Date(new Date().setHours(0, 0, 0, 0));

  const existing = await db
    .select({ id: searchCache.id })
    .from(searchCache)
    .where(
      and(
        eq(searchCache.query, query),
        gte(searchCache.fetchedAt, startOfDay)
      )
    )
    .limit(1);

  if (existing.length) {
    console.log("[scheduler] Theme research already cached for today, skipping queue.");
    return;
  }

  const ctx_themeresearch = { date, query };
  if (!validateContext(ThemeResearchContext, ctx_themeresearch, "themeresearch")) return;

  await db.insert(aiQueue).values({
    agentId:      "ai_theme_setter",
    actionType:   "themeresearch",
    promptContext: ctx_themeresearch,
    scheduledFor:  new Date(),
    priority:      0, // higher than theme_select (priority 1) — must complete first
    status:        "pending",
  }).onConflictDoNothing();
}

// ─── Theme selection ──────────────────────────────────────────────────

/** Queues a theme_select action for the Theme Setter (priority=1, run immediately). */
export async function queueThemeSelection(): Promise<void> {
  const themeSetter = getAdmins().find((a) => a.role === "theme_setter");
  if (!themeSetter) throw new Error("Theme Setter agent not found");

  const recentRows = await db
    .select({ theme: aiThemes.theme })
    .from(aiThemes)
    .orderBy(desc(aiThemes.date))
    .limit(14);

  // Pull today's research from cache if available — filtered to the current
  // day's deterministic theme query so a second same-day cached query (if any)
  // cannot swap the theme's citations. getThemeQuery() is deterministic per
  // date (day-of-year bank in research.ts).
  const expectedQuery = getThemeQuery();
  const startOfDay = new Date(new Date().setHours(0, 0, 0, 0));
  const researchRows = await db
    .select({ results: searchCache.results, source: searchCache.source })
    .from(searchCache)
    .where(and(eq(searchCache.query, expectedQuery), gte(searchCache.fetchedAt, startOfDay)))
    .orderBy(desc(searchCache.fetchedAt))
    .limit(1);

  const researchContext = researchRows[0]?.results ?? [];

  const ctx_themeselect = {
    recentThemes:    recentRows.map((r) => r.theme),
    researchContext,
  };
  if (!validateContext(ThemeSelectContext, ctx_themeselect, "theme_select")) return;

  await db.insert(aiQueue).values({
    agentId:      themeSetter.id,
    actionType:   "theme_select",
    roomId:       AI_LAB_ROOM_ID,
    promptContext: ctx_themeselect,
    scheduledFor: new Date(),
    priority:     1,
    status:       "pending",
  });
}

// ─── Daily ideas ──────────────────────────────────────────────────────

/**
 * Queues 4 post_idea actions — one per participant — spread over 0–9 min.
 * Reads today's theme from ai_themes; falls back to "Open exploration".
 */
export async function queueDailyIdeas(): Promise<void> {
  const participants = getParticipants();
  const today = new Date().toISOString().slice(0, 10);

  const [todayTheme] = await db
    .select()
    .from(aiThemes)
    .where(eq(aiThemes.date, today))
    .limit(1);

  const theme          = todayTheme?.theme    ?? "Open exploration";
  const rationale      = todayTheme?.rationale ?? null;
  const suggestedAngles =
    (todayTheme?.researchNotes as { suggested_angles?: string[] } | null)
      ?.suggested_angles ?? [];

  for (let i = 0; i < participants.length; i++) {
    const agent = participants[i];
    // Spread 3 posts across 0–10 min: 3-4 min apart plus ±1 min jitter
    const baseDelayMs = i * 3 * 60 * 1000;
    const jitterMs    = Math.random() * 60 * 1000;

    const ctx_postidea = { theme, rationale, suggestedAngles };
    if (!validateContext(PostIdeaContext, ctx_postidea, "post_idea")) continue;

    await db.insert(aiQueue).values({
      agentId:      agent.id,
      actionType:   "post_idea",
      roomId:       AI_LAB_ROOM_ID,
      promptContext: ctx_postidea,
      scheduledFor: new Date(Date.now() + baseDelayMs + jitterMs),
      priority:     7,
      status:       "pending",
    });
  }
}

// ─── Comments on Lab ideas ────────────────────────────────────────────

/**
 * Queues 2 comment actions from the OTHER participants on a freshly posted idea.
 * Delays are randomised in the 15–45 min window.
 */
export async function queueCommentsOnIdea(
  ideaId:      string,
  authorAgentId: string
): Promise<void> {
  const commenters = getParticipants()
    .filter((a) => a.id !== authorAgentId)
    .slice(0, 3);

  const [idea] = await db
    .select()
    .from(ideas)
    .where(eq(ideas.id, ideaId))
    .limit(1);

  if (!idea) throw new Error(`Idea not found: ${ideaId}`);

  const authorHandle = authorAgentId.replace(/^ai_/, "").replace(/_/g, "-");

  for (const agent of commenters) {
    const delayMs = (1 + Math.random()) * 60 * 1000; // 1–2 min

    const ctx_labcomment = {
      authorHandle,
      ideaTitle:   idea.title,
      ideaPitch:   idea.context ?? "",
      ideaContent: idea.content ?? "",
    };
    if (!validateContext(LabCommentContext, ctx_labcomment, "comment:lab")) continue;

    await db.insert(aiQueue).values({
      agentId:      agent.id,
      actionType:   "comment",
      roomId:       AI_LAB_ROOM_ID,
      targetIdeaId: ideaId,
      promptContext: ctx_labcomment,
      scheduledFor: new Date(Date.now() + delayMs),
      priority:     6,
      status:       "pending",
    });
  }
}

// ─── Quality review ───────────────────────────────────────────────────

/**
 * Queues a quality_review action for the Quality Checker.
 * Priority=2, delayed 30 s (near-instant per spec).
 */
export async function queueQualityReview(
  targetPostId: string,
  targetType:   "idea" | "comment"
): Promise<void> {
  const qualityChecker = getAdmins().find((a) => a.role === "quality_checker");
  if (!qualityChecker) throw new Error("Quality Checker agent not found");

  let content      = "";
  let authorHandle = "";

  if (targetType === "idea") {
    const [idea] = await db.select().from(ideas).where(eq(ideas.id, targetPostId)).limit(1);
    if (idea) {
      content      = [idea.title, idea.context, idea.content].filter(Boolean).join("\n\n");
      authorHandle = (idea.userId ?? "").replace(/^ai_/, "").replace(/_/g, "-");
    }
  } else {
    const [comment] = await db
      .select()
      .from(ideaComments)
      .where(eq(ideaComments.id, targetPostId))
      .limit(1);
    if (comment) {
      content      = comment.content;
      authorHandle = (comment.userId ?? "").replace(/^ai_/, "").replace(/_/g, "-");
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const [todayTheme] = await db
    .select({ theme: aiThemes.theme })
    .from(aiThemes)
    .where(eq(aiThemes.date, today))
    .limit(1);

  const ctx_qr = {
    targetType,
    targetId:    targetPostId,
    content,
    theme:       todayTheme?.theme ?? "",
    authorHandle,
  };
  if (!validateContext(QualityReviewContext, ctx_qr, "quality_review")) return;

  await db.insert(aiQueue).values({
    agentId:         qualityChecker.id,
    actionType:      "quality_review",
    targetIdeaId:    targetType === "idea"    ? targetPostId : undefined,
    targetCommentId: targetType === "comment" ? targetPostId : undefined,
    promptContext:   ctx_qr,
    scheduledFor: new Date(Date.now() + 30_000), // 30 seconds
    priority:     2,
    status:       "pending",
  });
}

// ─── Weekly rollup ────────────────────────────────────────────────────

/**
 * Queues a rollup_week action for the Archivist (priority=1, run immediately).
 * Period covers the 7 days ending yesterday (rolling window, not calendar week).
 */
export async function queueWeeklyRollup(): Promise<void> {
  const archivist = ALL_AGENTS.find((a) => a.role === "archivist");
  if (!archivist) throw new Error("Archivist agent not found");

  const periodEnd   = new Date();
  periodEnd.setUTCDate(periodEnd.getUTCDate() - 1);
  const periodStart = new Date();
  periodStart.setUTCDate(periodStart.getUTCDate() - 7);

  const ctx_rollup = {
    periodStart: periodStart.toISOString().slice(0, 10),
    periodEnd:   periodEnd.toISOString().slice(0, 10),
  };
  if (!validateContext(RollupContext, ctx_rollup, "rollup_week")) return;

  await db.insert(aiQueue).values({
    agentId:      archivist.id,
    actionType:   "rollup_week",
    roomId:       AI_LAB_ROOM_ID,
    promptContext: ctx_rollup,
    scheduledFor: new Date(),
    priority:     1,
    status:       "pending",
  });
}

// ─── Monthly rollup ───────────────────────────────────────────────────

/**
 * Queues a rollup_month action for the Archivist (priority=1, run immediately).
 * Period covers the previous complete calendar month.
 */
export async function queueMonthlyRollup(): Promise<void> {
  const archivist = ALL_AGENTS.find((a) => a.role === "archivist");
  if (!archivist) throw new Error("Archivist agent not found");

  const now         = new Date();
  // Last day of the previous month
  const periodEnd   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  // First day of the previous month
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));

  const ctx_rollup = {
    periodStart: periodStart.toISOString().slice(0, 10),
    periodEnd:   periodEnd.toISOString().slice(0, 10),
  };
  if (!validateContext(RollupContext, ctx_rollup, "rollup_month")) return;

  await db.insert(aiQueue).values({
    agentId:      archivist.id,
    actionType:   "rollup_month",
    roomId:       AI_LAB_ROOM_ID,
    promptContext: ctx_rollup,
    scheduledFor: new Date(),
    priority:     1,
    status:       "pending",
  });
}

// ─── Daily archive ────────────────────────────────────────────────────

// ─── Debate replies ───────────────────────────────────────────────────

/**
 * Queues a reply from the original idea author back to a commenter.
 * Called by executor.ts after a cascade comment is written.
 * Limited to depth=1: only fires for first-level comments (no parentCommentId).
 * This prevents A→B→A→B→… infinite loops.
 */
export async function queueDebateReply(
  ideaId:          string,
  ideaAuthorAgentId: string,
  commentId:       string,
  commenterHandle: string,
  commentContent:  string,
): Promise<void> {
  const agent = getParticipants().find((a) => a.id === ideaAuthorAgentId);
  if (!agent) return; // not a participant — silently skip

  const [idea] = await db.select().from(ideas).where(eq(ideas.id, ideaId)).limit(1);
  if (!idea) return;

  const ctx_reply: z.infer<typeof DebateReplyContext> = {
    kind:             "debate_reply",
    parentCommentId:  commentId,
    commenterHandle,
    commenterComment: commentContent.slice(0, 300),
    ideaTitle:        idea.title   ?? "",
    ideaPitch:        idea.context ?? "",
    ideaContent:      idea.content ?? "",
  };
  if (!validateContext(DebateReplyContext, ctx_reply, "comment:debate_reply")) return;

  await db.insert(aiQueue).values({
    agentId:      ideaAuthorAgentId,
    actionType:   "comment",
    roomId:       AI_LAB_ROOM_ID,
    targetIdeaId: ideaId,
    promptContext: ctx_reply,
    scheduledFor: new Date(Date.now() + 2 * 60 * 1000), // 2 min after comment
    priority:     6,
    status:       "pending",
  });
}

const ConductorContext = z.object({
  ideaTitle:   z.string(),
  ideaContent: z.string(),
});

/**
 * Queues a conductor action 90 min after the last pending comment on the idea.
 * Only fires when ≥2 different participant agents have commented on the idea.
 * Idempotent: skips if a conductor action is already pending/in_progress for this idea.
 */
export async function queueConductorIntervention(ideaId: string): Promise<void> {
  const conductor = getConductor();

  // Require ≥2 distinct participant voices in the thread
  const participantIds = new Set(getParticipants().map((p) => p.id));
  const commenters = await db
    .select({ userId: ideaComments.userId })
    .from(ideaComments)
    .where(eq(ideaComments.ideaId, ideaId));

  const activeParticipants = new Set(
    commenters.map((c) => c.userId).filter((id): id is string => !!id && participantIds.has(id))
  );
  if (activeParticipants.size < 2) return;

  // Idempotent: skip if conductor already scheduled for this idea
  const [existing] = await db
    .select({ id: aiQueue.id })
    .from(aiQueue)
    .where(
      and(
        eq(aiQueue.targetIdeaId, ideaId),
        eq(aiQueue.actionType, "conductor"),
        inArray(aiQueue.status, ["pending", "in_progress"])
      )
    )
    .limit(1);
  if (existing) return;

  // Schedule 90 min after the latest pending comment — never interrupt active debate
  const [lastPending] = await db
    .select({ scheduledFor: aiQueue.scheduledFor })
    .from(aiQueue)
    .where(
      and(
        eq(aiQueue.targetIdeaId, ideaId),
        eq(aiQueue.status, "pending")
      )
    )
    .orderBy(desc(aiQueue.scheduledFor))
    .limit(1);

  const baseTime = lastPending?.scheduledFor
    ? new Date(Math.max(lastPending.scheduledFor.getTime(), Date.now()))
    : new Date();
  const scheduledFor = new Date(baseTime.getTime() + 90 * 60 * 1000);

  // Fetch idea for prompt context
  const [idea] = await db
    .select({ title: ideas.title, content: ideas.content })
    .from(ideas)
    .where(eq(ideas.id, ideaId))
    .limit(1);
  if (!idea) return;

  const ctx_conductor = {
    ideaTitle:   idea.title   ?? "",
    ideaContent: idea.content ?? "",
  };
  if (!validateContext(ConductorContext, ctx_conductor, "conductor")) return;

  await db.insert(aiQueue).values({
    agentId:      conductor.id,
    actionType:   "conductor",
    roomId:       AI_LAB_ROOM_ID,
    targetIdeaId: ideaId,
    promptContext: ctx_conductor,
    scheduledFor,
    priority:     4,
    status:       "pending",
  });
}

/**
 * Queues the daily "Debate of the Day" — an autonomous counterpart to Quick
 * Debate that picks the most contested idea from today's AI Lab (≥2 distinct
 * participant commenters, most comments wins ties) and runs it through a
 * two-agent adversarial exchange, posted as comments on the idea itself.
 *
 * No Judge clarification round — there's no human to ask, and the selection
 * step already established real disagreement exists. Idempotent: skips if
 * an ai_lab_debate action already exists (any status) for the picked idea,
 * so re-running mid-day never double-books the same idea.
 */
export async function queueAILabDebateOfDay(dateStr?: string): Promise<void> {
  const qc = getAdmins().find((a) => a.role === "quality_checker");
  if (!qc) throw new Error("Quality Checker agent not found");

  const date = dateStr ?? new Date().toISOString().slice(0, 10);

  const [todayTheme] = await db
    .select({ theme: aiThemes.theme })
    .from(aiThemes)
    .where(eq(aiThemes.date, date))
    .limit(1);
  const theme = todayTheme?.theme ?? "(no theme set today)";

  const todaysIdeas = await db
    .select({ id: ideas.id, title: ideas.title, content: ideas.content, context: ideas.context })
    .from(ideas)
    .where(
      and(
        eq(ideas.roomId, AI_LAB_ROOM_ID),
        eq(ideas.status, "published"),
        gte(ideas.createdAt, new Date(`${date}T00:00:00Z`)),
      )
    );
  if (todaysIdeas.length === 0) return;

  const participantIds = new Set(getParticipants().map((p) => p.id));
  const commentRows = await db
    .select({ ideaId: ideaComments.ideaId, userId: ideaComments.userId })
    .from(ideaComments)
    .where(inArray(ideaComments.ideaId, todaysIdeas.map((i) => i.id)));

  let best: { id: string; title: string | null; content: string | null; context: string | null } | null = null;
  let bestDistinct = -1;
  let bestTotal = -1;
  for (const idea of todaysIdeas) {
    const commenters = commentRows.filter((c) => c.ideaId === idea.id);
    const distinctParticipants = new Set(
      commenters.map((c) => c.userId).filter((id): id is string => !!id && participantIds.has(id))
    );
    if (distinctParticipants.size < 2) continue;
    if (
      distinctParticipants.size > bestDistinct ||
      (distinctParticipants.size === bestDistinct && commenters.length > bestTotal)
    ) {
      bestDistinct = distinctParticipants.size;
      bestTotal = commenters.length;
      best = idea;
    }
  }
  if (!best) return;

  // Idempotent: skip if this idea has already had a Debate of the Day (any status)
  const [existing] = await db
    .select({ id: aiQueue.id })
    .from(aiQueue)
    .where(and(eq(aiQueue.targetIdeaId, best.id), eq(aiQueue.actionType, "ai_lab_debate")))
    .limit(1);
  if (existing) return;

  const ctx_debate = {
    ideaTitle:   best.title ?? "(untitled)",
    ideaContent: best.content ?? best.context ?? "",
    theme,
  };
  if (!validateContext(AILabDebateContext, ctx_debate, "ai_lab_debate")) return;

  await db.insert(aiQueue).values({
    agentId:      qc.id,
    actionType:   "ai_lab_debate",
    roomId:       AI_LAB_ROOM_ID,
    targetIdeaId: best.id,
    promptContext: ctx_debate,
    scheduledFor: new Date(),
    priority:     4,
    status:       "pending",
  });
}

/** Queues an archive_day action for the Archivist (priority=1, run immediately).
 *  Pass a date string (YYYY-MM-DD UTC) to archive a specific day; defaults to today. */
export async function queueDailyArchive(dateStr?: string): Promise<void> {
  const archivist = ALL_AGENTS.find((a) => a.role === "archivist");
  if (!archivist) throw new Error("Archivist agent not found");

  const today = dateStr ?? new Date().toISOString().slice(0, 10);
  const [todayTheme] = await db
    .select({ theme: aiThemes.theme })
    .from(aiThemes)
    .where(eq(aiThemes.date, today))
    .limit(1);

  const ctx_archive = {
    date:  today,
    theme: todayTheme?.theme ?? "(no theme set today)",
  };
  if (!validateContext(ArchiveDayContext, ctx_archive, "archive_day")) return;

  await db.insert(aiQueue).values({
    agentId:      archivist.id,
    actionType:   "archive_day",
    roomId:       AI_LAB_ROOM_ID,
    promptContext: ctx_archive,
    scheduledFor: new Date(),
    priority:     1,
    status:       "pending",
  });
}

/**
 * Queues a memory_reflect action for the Archivist (priority 5, background).
 * The handler writes one observation per active agent for the given day, plus
 * weekly reflections on Sundays. Pass a date string (YYYY-MM-DD UTC) to
 * reflect on a specific day; defaults to today.
 * Idempotent: skips if a memory_reflect row was already queued today
 * (any status), so a re-run never generates duplicate memories — the handler
 * additionally skips per agent/day/kind rows that already exist.
 */
export async function queueMemoryReflection(dateStr?: string): Promise<void> {
  const archivist = ALL_AGENTS.find((a) => a.role === "archivist");
  if (!archivist) throw new Error("Archivist agent not found");

  const date = dateStr ?? new Date().toISOString().slice(0, 10);

  const startOfDay = new Date(new Date().setHours(0, 0, 0, 0));
  const [existing] = await db
    .select({ id: aiQueue.id })
    .from(aiQueue)
    .where(
      and(
        eq(aiQueue.actionType, "memory_reflect"),
        gte(aiQueue.createdAt, startOfDay)
      )
    )
    .limit(1);
  if (existing) return;

  const ctx_reflect = { date };
  if (!validateContext(MemoryReflectContext, ctx_reflect, "memory_reflect")) return;

  await db.insert(aiQueue).values({
    agentId:      archivist.id,
    actionType:   "memory_reflect",
    roomId:       AI_LAB_ROOM_ID,
    promptContext: ctx_reflect,
    scheduledFor: new Date(),
    priority:     5,
    status:       "pending",
  });
}
