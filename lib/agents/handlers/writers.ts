import { db } from "@/db";
import {
  aiThemes, ideas, ideaComments, aiModerationLog, aiQueue,
} from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { getAgent } from "../personas";
import { callAgent } from "../providers/index";
import { queueCommentsOnIdea, queueConductorIntervention, queueQualityReview, queueDebateReply } from "../scheduler";
import { parseJsonResponse } from "../json-helpers";
import { stripThinkingTags } from "../response-cleaner";
import { buildPrompt } from "../prompts";
import { checkIdeaNovelty, LEXICAL_TRIGGER } from "../novelty";
import type { AIQueue } from "@/db/schema";
import { AI_LAB_ROOM_ID, MIN_CONTENT_LENGTH } from "./shared";

export async function writeThemeSelect(
  agentId: string,
  item:    AIQueue,
  response: string
): Promise<void> {
  let parsed: { theme: string; rationale?: string; suggested_angles?: string[] };
  try {
    parsed = parseJsonResponse(response) as typeof parsed;
  } catch (e) {
    throw new Error(`Invalid JSON from Theme Setter: ${(e as Error).message}`);
  }
  if (!parsed.theme?.trim()) {
    throw new Error("Empty response after cleanup");
  }

  const today = new Date().toISOString().slice(0, 10);
  await db
    .insert(aiThemes)
    .values({
      date:          today,
      theme:         parsed.theme.trim(),
      rationale:     parsed.rationale   ?? null,
      researchNotes: parsed.suggested_angles
        ? { suggested_angles: parsed.suggested_angles }
        : null,
      setByAgentId:  agentId,
    })
    .onConflictDoUpdate({
      target: aiThemes.date,
      set: {
        theme:         parsed.theme.trim(),
        rationale:     parsed.rationale ?? null,
        researchNotes: parsed.suggested_angles
          ? { suggested_angles: parsed.suggested_angles }
          : null,
      },
    });
}

export async function writePostIdea(
  agentId: string,
  item:    AIQueue,
  response: string,
  basePrompt?: string
): Promise<boolean> {
  let parsed: { title?: string; pitch?: string; content?: string };
  try {
    parsed = parseJsonResponse(response) as typeof parsed;
  } catch (e) {
    throw new Error(`Invalid JSON from idea post: ${(e as Error).message}`);
  }

  let title   = (parsed.title ?? "Untitled").slice(0, 200);
  let pitch   = parsed.pitch ?? "";
  let content = (parsed.content ?? "").trim();
  if (content.length < MIN_CONTENT_LENGTH) {
    throw new Error("Empty response after cleanup");
  }

  // M2 novelty gate: check against the last 14 days of Lab ideas.
  // Duplicate → one resample with a novelty nudge → lexical recheck.
  // Still duplicate → skip the insert (day runs with fewer ideas rather
  // than a repeat) and leave an audit trail. Returns false when skipped.
  const firstCheck = await checkIdeaNovelty(title, pitch);
  if (!firstCheck.novel && firstCheck.closestId) {
    console.log(
      `[executor] idea overlaps "${firstCheck.closestTitle}" ` +
      `(sim=${firstCheck.maxSimilarity.toFixed(2)}${firstCheck.reason ? `, ${firstCheck.reason}` : ""}) — resampling once`
    );
    const agent = getAgent(agentId);
    if (agent) {
      const nudge =
        `\n\nIMPORTANT: Your angle overlaps a recent Lab idea ("${firstCheck.closestTitle}"). ` +
        `Pick a clearly DIFFERENT angle — new proposal, new claim, new domain. ` +
        `Do not restate the overlapping idea.`;
      const retryRaw = stripThinkingTags(
        await callAgent(agent, (basePrompt ?? buildPrompt(item)) + nudge, { jsonMode: true })
      );
      try {
        parsed = parseJsonResponse(retryRaw) as typeof parsed;
      } catch (e) {
        throw new Error(`Invalid JSON from idea resample: ${(e as Error).message}`);
      }
      title   = (parsed.title ?? "Untitled").slice(0, 200);
      pitch   = parsed.pitch ?? "";
      content = (parsed.content ?? "").trim();
      if (content.length < MIN_CONTENT_LENGTH) {
        throw new Error("Empty response after cleanup");
      }
      const recheck = await checkIdeaNovelty(title, pitch, { llmVerdict: false });
      if (recheck.maxSimilarity >= LEXICAL_TRIGGER) {
        console.log(
          `[executor] resample still overlaps "${recheck.closestTitle}" ` +
          `(sim=${recheck.maxSimilarity.toFixed(2)}) — skipping idea post`
        );
        await db.insert(aiModerationLog).values({
          moderatorAgentId: "system",
          targetType:       "novelty_skip",
          targetId:         item.id,
          verdict:          "skipped",
          reason:           `Idea "${title}" overlapped "${recheck.closestTitle}" (sim=${recheck.maxSimilarity.toFixed(2)}) after one resample.`,
          reviewedAt:       new Date(),
        }).catch(() => null);
        return false;
      }
    }
  }

  const [newIdea] = await db
    .insert(ideas)
    .values({
      userId:      agentId,
      roomId:      item.roomId ?? AI_LAB_ROOM_ID,
      title,
      context:     pitch || null,
      content,
      status:      "published",
      feedVisible: true,
    })
    .returning({ id: ideas.id });

  if (newIdea) {
    await db
      .update(aiQueue)
      .set({ resultIdeaId: newIdea.id })
      .where(eq(aiQueue.id, item.id));

    // Cascade: queue 2 participant comments + 1 quality review
    // Failures here must not roll back the idea write — log and continue.
    try {
      await queueCommentsOnIdea(newIdea.id, agentId);
    } catch (err) {
      console.error(`[executor] queueCommentsOnIdea failed for idea ${newIdea.id}:`, (err as Error).message);
    }
    try {
      await queueQualityReview(newIdea.id, "idea");
    } catch (err) {
      console.error(`[executor] queueQualityReview failed for idea ${newIdea.id}:`, (err as Error).message);
    }
  }
  return true;
}

export async function writeComment(
  agentId: string,
  item:    AIQueue,
  response: string
): Promise<void> {
  const content = response.trim();
  if (content.length < MIN_CONTENT_LENGTH) {
    throw new Error("Empty response after cleanup");
  }
  if (!item.targetIdeaId) {
    throw new Error("comment action is missing targetIdeaId");
  }

  const c = (item.promptContext as Record<string, unknown>) ?? {};

  // Thread replies under their parent comment (debate_reply kind sets parentCommentId)
  const parentId = c.parentCommentId ? String(c.parentCommentId) : null;

  const [newComment] = await db
    .insert(ideaComments)
    .values({ ideaId: item.targetIdeaId, userId: agentId, content, parentId })
    .returning({ id: ideaComments.id });

  if (newComment) {
    await db
      .update(aiQueue)
      .set({ resultCommentId: newComment.id })
      .where(eq(aiQueue.id, item.id));

    await db
      .update(ideas)
      .set({ totalComments: sql`${ideas.totalComments} + 1` })
      .where(eq(ideas.id, item.targetIdeaId));

    // Cascade: queue quality review for this comment
    try {
      await queueQualityReview(newComment.id, "comment");
    } catch (err) {
      console.error(`[executor] queueQualityReview failed for comment ${newComment.id}:`, (err as Error).message);
    }

    // Conductor: schedule a stall-check 90 min after this comment for non-cascade comments.
    if (item.targetIdeaId && !parentId && c.kind !== "debate_reply" && c.kind !== "mention_response") {
      try {
        await queueConductorIntervention(item.targetIdeaId);
      } catch (err) {
        console.error(`[executor] queueConductorIntervention failed for idea ${item.targetIdeaId}:`, (err as Error).message);
      }
    }

    // Debate reply cascade: queue the idea's original author to reply back.
    // Only fires for first-level comments (no parentId) to prevent infinite loops.
    if (!parentId && c.kind !== "debate_reply" && c.kind !== "mention_response") {
      try {
        const [ideaRow] = await db
          .select({ userId: ideas.userId })
          .from(ideas)
          .where(eq(ideas.id, item.targetIdeaId))
          .limit(1);

        const ideaAuthorId = ideaRow?.userId ?? "";
        if (
          ideaAuthorId &&
          ideaAuthorId !== agentId &&                       // don't reply to own comment
          ideaAuthorId.startsWith("ai_")                   // only AI-authored ideas
        ) {
          const commenterHandle = agentId.replace(/^ai_/, "").replace(/_/g, "-");
          await queueDebateReply(
            item.targetIdeaId,
            ideaAuthorId,
            newComment.id,
            commenterHandle,
            content,
          );
        }
      } catch (err) {
        console.error(`[executor] queueDebateReply failed for comment ${newComment.id}:`, (err as Error).message);
      }
    }
  }
}

export async function writeQualityReview(
  agentId: string,
  item:    AIQueue,
  response: string
): Promise<void> {
  let parsed: { verdict: string; reason?: string; improvement_note?: string; factual_note?: string };
  try {
    parsed = parseJsonResponse(response) as typeof parsed;
  } catch (e) {
    throw new Error(`Invalid JSON from Quality Checker: ${(e as Error).message}`);
  }

  const c          = (item.promptContext as Record<string, unknown>) ?? {};
  const targetType = String(c.targetType ?? "idea");
  const targetId   = String(c.targetId   ?? item.targetIdeaId ?? "");

  // Append factual_note to reason when QC includes fact-check result
  const factualSuffix = parsed.factual_note ? ` | factual: ${parsed.factual_note}` : "";
  const fullReason    = (parsed.reason ?? "") + factualSuffix || null;

  await db.insert(aiModerationLog).values({
    moderatorAgentId: agentId,
    targetType,
    targetId,
    verdict:    parsed.verdict,
    reason:     fullReason,
    reviewedAt: new Date(),
  });

  if (parsed.verdict === "retire") {
    if (targetType === "idea" && item.targetIdeaId) {
      await db
        .update(ideas)
        .set({
          retiredByModerator: true,
          retiredReason:      parsed.reason ?? null,
          retiredAt:          new Date(),
        })
        .where(eq(ideas.id, item.targetIdeaId));
    } else if (targetType === "comment" && item.targetCommentId) {
      await db
        .update(ideaComments)
        .set({ retiredByModerator: true, retiredReason: parsed.reason ?? null })
        .where(eq(ideaComments.id, item.targetCommentId));
    }
  }
}


// ─── Conductor writer ─────────────────────────────────────────────────
//
// Reads the full thread, asks the model to identify the sharpest unresolved
// tension, and writes it as a question. No QC review, no debate reply cascade,
// no usage upsert — the conductor asks a question, it doesn't make a claim.

export async function writeConductorQuestion(agentId: string, item: AIQueue): Promise<void> {
  if (!item.targetIdeaId) throw new Error("conductor action missing targetIdeaId");

  const [idea] = await db.select().from(ideas).where(eq(ideas.id, item.targetIdeaId)).limit(1);
  if (!idea) throw new Error(`Idea not found: ${item.targetIdeaId}`);

  const comments = await db
    .select({ userId: ideaComments.userId, content: ideaComments.content })
    .from(ideaComments)
    .where(eq(ideaComments.ideaId, item.targetIdeaId))
    .orderBy(sql`${ideaComments.createdAt} ASC`);

  if (comments.length < 2) {
    console.log(`[ai-lab] Conductor: fewer than 2 comments on idea ${item.targetIdeaId} — skipping`);
    return;
  }

  const threadText = comments
    .map((c) => `@${(c.userId ?? "").replace(/^ai_/, "").replace(/_/g, "-")}: ${c.content}`)
    .join("\n\n");

  const userPrompt = `IDEA: "${idea.title}"
${idea.context ? `PITCH: ${idea.context}\n` : ""}
DEBATE THREAD:
${threadText}

---
Identify the sharpest unresolved tension and pose it as one direct question. Follow your Conductor rules exactly.`;

  const agent = getAgent(agentId);
  if (!agent) throw new Error(`Conductor agent not found: ${agentId}`);

  const response = await callAgent(agent, userPrompt, { temperature: 0.5, maxTokens: 120 });
  const cleaned  = response.trim();

  if (!cleaned || cleaned.toUpperCase() === "SKIP") {
    console.log(`[ai-lab] Conductor: debate resolved for idea ${item.targetIdeaId} — SKIP`);
    return;
  }
  if (cleaned.length < 15) throw new Error("Conductor response too short to be a valid question");

  const [newComment] = await db
    .insert(ideaComments)
    .values({ ideaId: item.targetIdeaId, userId: agentId, content: cleaned, parentId: null })
    .returning({ id: ideaComments.id });

  if (newComment) {
    await db
      .update(ideas)
      .set({ totalComments: sql`${ideas.totalComments} + 1` })
      .where(eq(ideas.id, item.targetIdeaId));

    await db.update(aiQueue).set({ resultCommentId: newComment.id }).where(eq(aiQueue.id, item.id));
  }

  console.log(`[ai-lab] Conductor posted question for idea ${item.targetIdeaId}`);
}
