"use server";

import { db } from "@/db";
import { ideaComments, ideas, users } from "@/db/schema";
import { eq, desc, and, ne, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getAuthenticatedUserId } from "@/lib/auth";
import { createNotification } from "./notificationActions";
import { writeLimiter, lightLimiter } from "@/lib/ratelimit";
import { containsBlockedContent } from "@/lib/moderation";

// ─── ADD COMMENT ────────────────────────────────────────────────────

export async function addComment(ideaId: string, content: string, parentId?: string) {
  const callerId = await getAuthenticatedUserId();
  if (!callerId) return { success: false, error: "Not authenticated" };

  const { success } = await writeLimiter.limit(callerId);
  if (!success) return { success: false, error: "Too many requests. Please slow down." };

  const trimmed = content?.trim();
  if (!trimmed) return { success: false, error: "Comment cannot be empty" };
  if (trimmed.length > 1000) return { success: false, error: "Too long" };
  if (containsBlockedContent(trimmed)) return { success: false, error: "This content cannot be posted." };

  const [idea] = await db
    .select({ id: ideas.id, userId: ideas.userId, title: ideas.title })
    .from(ideas)
    .where(and(eq(ideas.id, ideaId), eq(ideas.status, "published")));
  if (!idea) return { success: false, error: "Idea not found or not published" };

  await db.insert(ideaComments).values({
    ideaId,
    userId: callerId,
    content: trimmed,
    parentId: parentId ?? null,
  });

  await db
    .update(ideas)
    .set({ totalComments: sql`${ideas.totalComments} + 1`, updatedAt: new Date() })
    .where(eq(ideas.id, ideaId));

  // Notify idea owner (skip if commenter IS the owner)
  if (idea.userId && idea.userId !== callerId) {
    await createNotification({
      userId: idea.userId,
      type: "comment",
      body: `Someone commented on your idea "${idea.title}"`,
      link: `/ai-lab`,
    });
  }

  // Notify parent comment author on replies (skip double-notify if same as idea owner)
  if (parentId) {
    const [parent] = await db
      .select({ userId: ideaComments.userId })
      .from(ideaComments)
      .where(eq(ideaComments.id, parentId));

    if (parent?.userId && parent.userId !== callerId && parent.userId !== idea.userId) {
      await createNotification({
        userId: parent.userId,
        type: "comment",
        body: `Someone replied to your comment on "${idea.title}"`,
        link: `/ai-lab`,
      });
    }
  }

  // Notify prior commenters on the same idea (thread subscriptions)
  const priorCommenters = await db
    .selectDistinct({ userId: ideaComments.userId })
    .from(ideaComments)
    .where(
      and(
        eq(ideaComments.ideaId, ideaId),
        ne(ideaComments.userId, callerId),
        ne(ideaComments.userId, idea.userId ?? "")
      )
    );

  for (const { userId } of priorCommenters) {
    if (userId) {
      await createNotification({
        userId,
        type: "reply",
        body: `Someone else commented on an idea you're following`,
        link: `/ai-lab`,
      }).catch(() => {});
    }
  }

  revalidatePath(`/ai-lab`);
  return { success: true };
}

// ─── UPDATE COMMENT ─────────────────────────────────────────────────

export async function updateComment(commentId: string, ideaId: string, content: string) {
  const callerId = await getAuthenticatedUserId();
  if (!callerId) return { success: false, error: "Not authenticated" };

  const { success } = await lightLimiter.limit(callerId);
  if (!success) return { success: false, error: "Too many requests. Please slow down." };

  const trimmed = content?.trim();
  if (!trimmed) return { success: false, error: "Comment cannot be empty" };
  if (trimmed.length > 1000) return { success: false, error: "Too long" };

  const [comment] = await db
    .select({ userId: ideaComments.userId })
    .from(ideaComments)
    .where(eq(ideaComments.id, commentId));
  if (!comment) return { success: false, error: "Not found" };
  if (comment.userId !== callerId) return { success: false, error: "Forbidden" };

  await db
    .update(ideaComments)
    .set({ content: trimmed, updatedAt: new Date() })
    .where(eq(ideaComments.id, commentId));

  revalidatePath(`/ai-lab`);
  return { success: true };
}

// ─── DELETE COMMENT ─────────────────────────────────────────────────

export async function deleteComment(commentId: string, ideaId: string) {
  const callerId = await getAuthenticatedUserId();
  if (!callerId) return { success: false, error: "Not authenticated" };

  const { success } = await lightLimiter.limit(callerId);
  if (!success) return { success: false, error: "Too many requests. Please slow down." };

  const [comment] = await db
    .select({ userId: ideaComments.userId })
    .from(ideaComments)
    .where(eq(ideaComments.id, commentId));
  if (!comment) return { success: false, error: "Not found" };
  if (comment.userId !== callerId) return { success: false, error: "Forbidden" };

  await db.delete(ideaComments).where(eq(ideaComments.id, commentId));

  await db
    .update(ideas)
    .set({ totalComments: sql`GREATEST(${ideas.totalComments} - 1, 0)`, updatedAt: new Date() })
    .where(eq(ideas.id, ideaId));

  revalidatePath(`/ai-lab`);
  return { success: true };
}

// ─── GET COMMENTS ───────────────────────────────────────────────────

export async function getComments(ideaId: string) {
  const rows = await db
    .select({
      id:         ideaComments.id,
      content:    ideaComments.content,
      createdAt:  ideaComments.createdAt,
      updatedAt:  ideaComments.updatedAt,
      parentId:   ideaComments.parentId,
      userId:     ideaComments.userId,
      userName:   users.name,
      userHandle: users.handle,
      userImage:  users.image,
    })
    .from(ideaComments)
    .leftJoin(users, eq(ideaComments.userId, users.id))
    .where(eq(ideaComments.ideaId, ideaId))
    .orderBy(desc(ideaComments.createdAt));

  return rows.map((r) => ({
    id:        r.id,
    content:   r.content,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    parentId:  r.parentId,
    user: {
      id:     r.userId,
      name:   r.userName,
      handle: r.userHandle,
      image:  r.userImage,
    },
  }));
}
