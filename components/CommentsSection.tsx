"use client";

import React, { useState, useTransition } from "react";
import { Trash2, MessageCircle, Send, CornerDownRight, Pencil, X, Check } from "lucide-react";
import { addComment, deleteComment, updateComment } from "@/app/actions/commentActions";
import { relativeTime } from "@/lib/time";

interface CommentUser {
  id: string | null;
  name: string | null;
  handle: string | null;
  image: string | null;
}

interface Comment {
  id: string;
  content: string;
  createdAt: Date | null;
  updatedAt: Date | null;
  parentId: string | null;
  user: CommentUser;
}

interface CommentsSectionProps {
  ideaId: string;
  ideaOwnerId?: string;
  viewerId: string;
  initialComments: Comment[];
  viewerName?: string | null;
  viewerHandle?: string | null;
  viewerImage?: string | null;
  onCountChange?: (count: number) => void;
  /** Replaces the top-level compose box. Use for AI Lab @mention input. */
  commentInput?: React.ReactNode;
  isAiLab?: boolean;
}

interface CommentRowProps {
  c: Comment;
  isReply: boolean;
  isAiLab: boolean;
  viewerId: string;
  ideaOwnerId?: string;
  editingId: string | null;
  editText: string;
  isPending: boolean;
  replyingTo: string | null;
  setReplyingTo: (id: string | null) => void;
  setEditingId: (id: string | null) => void;
  setEditText: (t: string) => void;
  onEdit: (commentId: string) => void;
  onDelete: (commentId: string) => void;
}

const COLLAPSE_AFTER = 3;

// ── AI agent styling lookup — only applied when isAiLab === true ────────
const AI_AGENT_CLASSES: Record<string, {
  rowBg: string; rowBorder: string;
  nameFg: string; avatarBg: string; avatarFg: string; glyph: string;
}> = {
  "llama":    { rowBg: "bg-ic-ai-llama-bg",    rowBorder: "border-l-ic-ai-llama-accent",    nameFg: "text-ic-ai-llama-fg",    avatarBg: "bg-ic-ai-llama-bg",    avatarFg: "text-ic-ai-llama-fg",    glyph: "◆" },
  "gpt-oss":  { rowBg: "bg-ic-ai-gptoss-bg",   rowBorder: "border-l-ic-ai-gptoss-accent",   nameFg: "text-ic-ai-gptoss-fg",   avatarBg: "bg-ic-ai-gptoss-bg",   avatarFg: "text-ic-ai-gptoss-fg",   glyph: "◈" },
  "scout":    { rowBg: "bg-ic-ai-scout-bg",    rowBorder: "border-l-ic-ai-scout-accent",    nameFg: "text-ic-ai-scout-fg",    avatarBg: "bg-ic-ai-scout-bg",    avatarFg: "text-ic-ai-scout-fg",    glyph: "▲" },
  "maverick": { rowBg: "bg-ic-ai-maverick-bg", rowBorder: "border-l-ic-ai-maverick-accent", nameFg: "text-ic-ai-maverick-fg", avatarBg: "bg-ic-ai-maverick-bg", avatarFg: "text-ic-ai-maverick-fg", glyph: "◉" },
  "research": { rowBg: "bg-ic-ai-research-bg", rowBorder: "border-l-ic-ai-research-accent", nameFg: "text-ic-ai-research-fg", avatarBg: "bg-ic-ai-research-bg", avatarFg: "text-ic-ai-research-fg", glyph: "⬡" },
};
const CONDUCTOR_HANDLE = "conductor";


function wasEdited(c: Comment) {
  if (!c.updatedAt || !c.createdAt) return false;
  return new Date(c.updatedAt).getTime() - new Date(c.createdAt).getTime() > 5000;
}

// ── Single comment row — module-level so React gets a stable component identity ──
function CommentRow({
  c, isReply, isAiLab, viewerId, ideaOwnerId,
  editingId, editText, isPending,
  replyingTo, setReplyingTo,
  setEditingId, setEditText,
  onEdit, onDelete,
}: CommentRowProps) {
  const isOwn = c.user.id === viewerId;
  const isOP  = !!ideaOwnerId && c.user.id === ideaOwnerId;
  const name  = c.user.handle ?? c.user.name ?? "Anonymous";
  const init  = (name[0] ?? "?").toUpperCase();

  // AI Lab–specific agent/conductor detection
  const handle       = c.user.handle ?? "";
  const agentInfo    = isAiLab ? (AI_AGENT_CLASSES[handle] ?? null) : null;
  const isConductor  = isAiLab && handle === CONDUCTOR_HANDLE;

  // ── Conductor card ─────────────────────────────────────────────────
  if (isConductor) {
    return (
      <div className="bg-ic-paper-deep border-l-[3px] border-l-ic-muted rounded-r-xl px-4 py-3">
        <div className="flex items-center gap-2 mb-2">
          <span className="font-mono text-[10px] uppercase tracking-widest text-ic-muted font-semibold">
            Conductor
          </span>
          <span className="font-mono text-[10px] text-ic-muted ml-auto">
            {relativeTime(c.createdAt)}
          </span>
        </div>
        <p className="font-display italic text-ic-ink-soft text-sm leading-relaxed">
          &ldquo;{c.content}&rdquo;
        </p>
        <p className="font-mono text-[10px] text-ic-muted mt-2">
          Auto-fires when a thread stalls · doesn&apos;t take positions
        </p>
      </div>
    );
  }

  // ── AI agent card ───────────────────────────────────────────────────
  if (agentInfo) {
    return (
      <div className={`border-l-4 ${agentInfo.rowBorder} ${agentInfo.rowBg} pl-4 py-3 rounded-r-xl`}>
        <div className="flex items-center gap-2 mb-1.5">
          <span className={`inline-flex items-center justify-center w-6 h-6 rounded ${agentInfo.avatarBg} ${agentInfo.avatarFg} font-mono text-xs font-semibold shrink-0`}>
            {agentInfo.glyph}
          </span>
          <span className={`font-mono text-[12px] font-semibold ${agentInfo.nameFg}`}>
            @{handle}
          </span>
          <span className={`font-mono text-[9px] uppercase px-1 py-0.5 rounded ${agentInfo.avatarBg} ${agentInfo.nameFg}`}>
            AI
          </span>
          <span className="font-mono text-[10px] text-ic-muted ml-auto">
            {relativeTime(c.createdAt)}
          </span>
        </div>
        <p className="font-sans text-sm text-ic-ink leading-relaxed">{c.content}</p>
      </div>
    );
  }

  // ── Human comment row ───────────────────────────────────────────────
  return (
    <div className={`flex gap-3 ${isAiLab ? "bg-ic-card border border-ic-rule rounded-xl px-4 py-3" : ""}`}>
      <div className={`${isReply ? "w-6 h-6 text-[10px]" : "w-8 h-8 text-xs"} rounded-full
        bg-ic-paper-deep border border-ic-rule flex items-center justify-center
        shrink-0 mt-0.5 font-mono font-semibold text-ic-muted`}>
        {init}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="font-mono text-[12px] font-semibold text-ic-ink">@{name}</span>
          {isOP && (
            <span className="font-mono text-[10px] font-bold bg-ic-accent/20 text-ic-accent px-1.5 py-0.5 rounded">
              OP
            </span>
          )}
          <span className="font-mono text-[10px] text-ic-muted">{relativeTime(c.createdAt)}</span>
          {wasEdited(c) && (
            <span className="font-mono text-[10px] italic text-ic-muted opacity-60">edited</span>
          )}
        </div>

        {editingId === c.id ? (
          <div className="mt-2">
            <textarea
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              maxLength={1000}
              rows={3}
              className="w-full px-3 py-2 rounded-lg border border-ic-rule bg-ic-paper-deep
                text-ic-ink text-sm resize-none focus:outline-none focus:border-ic-accent transition"
            />
            <div className="flex gap-2 mt-1.5">
              <button onClick={() => onEdit(c.id)} disabled={isPending}
                className="flex items-center gap-1 px-3 py-1 rounded-lg bg-ic-accent
                  text-white text-xs font-medium hover:opacity-90 disabled:opacity-50 transition">
                <Check size={11} /> Save
              </button>
              <button onClick={() => setEditingId(null)}
                className="flex items-center gap-1 px-3 py-1 rounded-lg bg-ic-paper-deep border border-ic-rule
                  text-ic-muted text-xs hover:border-ic-accent transition">
                <X size={11} /> Cancel
              </button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-ic-ink-soft mt-1 leading-relaxed whitespace-pre-wrap">
            {c.content}
          </p>
        )}

        {!isReply && editingId !== c.id && (
          <button
            onClick={() => setReplyingTo(replyingTo === c.id ? null : c.id)}
            className="flex items-center gap-1 mt-1.5 font-mono text-[11px] text-ic-muted
              hover:text-ic-accent transition-colors">
            <CornerDownRight size={11} /> Reply
          </button>
        )}
      </div>

      {isOwn && editingId !== c.id && (
        <div className="flex gap-1 shrink-0 self-start mt-0.5">
          <button
            onClick={() => { setEditingId(c.id); setEditText(c.content); }}
            disabled={isPending} title="Edit"
            className="p-1.5 rounded-lg text-ic-muted hover:text-ic-accent hover:bg-ic-paper-deep transition-colors">
            <Pencil size={12} />
          </button>
          <button onClick={() => onDelete(c.id)} disabled={isPending} title="Delete"
            className="p-1.5 rounded-lg text-ic-muted hover:text-ic-danger hover:bg-ic-paper-deep transition-colors">
            <Trash2 size={12} />
          </button>
        </div>
      )}
    </div>
  );
}

export default function CommentsSection({
  ideaId,
  ideaOwnerId,
  viewerId,
  initialComments,
  viewerName = null,
  viewerHandle = null,
  viewerImage = null,
  onCountChange,
  commentInput,
  isAiLab = false,
}: CommentsSectionProps) {
  const [commentList, setCommentList] = useState<Comment[]>(initialComments);
  const [text, setText] = useState("");
  const [topError, setTopError] = useState("");
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyTexts, setReplyTexts] = useState<Record<string, string>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [isPending, startTransition] = useTransition();

  const updateList = (fn: (prev: Comment[]) => Comment[]) =>
    setCommentList((prev) => {
      const next = fn(prev);
      onCountChange?.(next.length);
      return next;
    });

  const makeTemp = (content: string, parentId: string | null): Comment => ({
    id: `temp-${Date.now()}`,
    content,
    createdAt: new Date(),
    updatedAt: null,
    parentId,
    user: { id: viewerId, name: viewerName, handle: viewerHandle, image: viewerImage },
  });

  function handleAdd() {
    if (!text.trim()) return;
    setTopError("");
    startTransition(async () => {
      const res = await addComment(ideaId, text);
      if (res.success) {
        updateList((prev) => [makeTemp(text.trim(), null), ...prev]);
        setText("");
      } else {
        setTopError(res.error ?? "Failed to post");
      }
    });
  }

  function handleReply(parentId: string) {
    const content = replyTexts[parentId]?.trim();
    if (!content) return;
    startTransition(async () => {
      const res = await addComment(ideaId, content, parentId);
      if (res.success) {
        updateList((prev) => [...prev, makeTemp(content, parentId)]);
        setReplyTexts((p) => ({ ...p, [parentId]: "" }));
        setReplyingTo(null);
        setExpanded((p) => new Set([...p, parentId]));
      }
    });
  }

  function handleDelete(commentId: string) {
    startTransition(async () => {
      const res = await deleteComment(commentId, ideaId);
      if (res.success) {
        updateList((prev) =>
          prev.filter((c) => c.id !== commentId && c.parentId !== commentId)
        );
      }
    });
  }

  function handleEdit(commentId: string) {
    if (!editText.trim()) return;
    startTransition(async () => {
      const res = await updateComment(commentId, ideaId, editText);
      if (res.success) {
        updateList((prev) =>
          prev.map((c) =>
            c.id === commentId
              ? { ...c, content: editText.trim(), updatedAt: new Date() }
              : c
          )
        );
        setEditingId(null);
      }
    });
  }

  const topLevel   = commentList.filter((c) => !c.parentId);
  const repliesFor = (id: string) => commentList.filter((c) => c.parentId === id);

  const rowProps = {
    isAiLab,
    viewerId,
    ideaOwnerId,
    editingId,
    editText,
    isPending,
    replyingTo,
    setReplyingTo,
    setEditingId,
    setEditText,
    onEdit: handleEdit,
    onDelete: handleDelete,
  };

  return (
    <section className="mt-10 pt-8 border-t border-ic-rule">
      <h3 className="font-display text-lg font-normal text-ic-ink mb-6 flex items-center gap-2">
        <MessageCircle size={18} className="text-ic-accent" />
        {commentList.length} Comment{commentList.length !== 1 ? "s" : ""}
      </h3>

      {/* Top-level compose — replaced by commentInput when provided (e.g. AI Lab mention input) */}
      {commentInput ?? (
        <div className="flex gap-3 mb-8">
          <div className="w-8 h-8 rounded-full bg-ic-paper-deep border border-ic-rule flex items-center justify-center
            shrink-0 mt-0.5">
            <span className="font-mono text-xs font-semibold text-ic-muted">
              {viewerHandle?.[0]?.toUpperCase() ?? viewerName?.[0]?.toUpperCase() ?? "U"}
            </span>
          </div>
          <div className="flex-1">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Share your thoughts on this idea…"
              aria-label="Comment on this idea"
              maxLength={1000}
              rows={3}
              className="w-full px-4 py-3 rounded-xl border border-ic-rule bg-ic-paper-deep
                text-ic-ink text-sm resize-none focus:outline-none focus:border-ic-accent
                placeholder:text-ic-muted transition"
            />
            {topError && <p className="text-ic-danger text-xs mt-1">{topError}</p>}
            <div className="flex items-center justify-between mt-2">
              <span className="font-mono text-[11px] text-ic-muted">{text.length}/1000</span>
              <button onClick={handleAdd} disabled={isPending || !text.trim()}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-ic-accent text-white
                  font-mono text-xs font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition">
                <Send size={12} />
                {isPending ? "Posting…" : "Post"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Comment list */}
      <div className="flex flex-col gap-6">
        {topLevel.length === 0 && (
          <p className="font-mono text-sm text-ic-muted text-center py-6">
            No comments yet. Be the first to spark a conversation!
          </p>
        )}

        {topLevel.map((comment) => {
          const replies     = repliesFor(comment.id);
          const isExpanded  = expanded.has(comment.id);
          const visible     = isExpanded ? replies : replies.slice(0, COLLAPSE_AFTER);
          const hiddenCount = replies.length - COLLAPSE_AFTER;
          const displayName = comment.user.handle ?? comment.user.name ?? "Anonymous";

          return (
            <div key={comment.id}>
              <CommentRow c={comment} isReply={false} {...rowProps} />

              {/* Inline reply input */}
              {replyingTo === comment.id && (
                <div className="ml-11 mt-3">
                  <p className="font-mono text-[11px] text-ic-muted mb-1.5">
                    Replying to{" "}
                    <span className="text-ic-accent font-medium">@{displayName}</span>
                  </p>
                  {isAiLab && (
                    <p className="font-mono text-[11px] text-ic-ai-maverick-accent/80 mb-1.5">
                      Replies here are public but won&apos;t trigger an AI response.
                      Use the @mention box above to get a reply from an agent.
                    </p>
                  )}
                  <textarea
                    value={replyTexts[comment.id] ?? ""}
                    onChange={(e) =>
                      setReplyTexts((p) => ({ ...p, [comment.id]: e.target.value }))
                    }
                    placeholder="Write a reply…"
                    aria-label={`Reply to ${displayName}`}
                    maxLength={1000}
                    rows={2}
                    className="w-full px-3 py-2 rounded-lg border border-ic-rule bg-ic-paper-deep
                      text-ic-ink text-sm resize-none focus:outline-none focus:border-ic-accent transition"
                  />
                  <div className="flex gap-2 mt-1.5">
                    <button
                      onClick={() => handleReply(comment.id)}
                      disabled={isPending || !replyTexts[comment.id]?.trim()}
                      className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-ic-accent
                        text-white font-mono text-xs font-medium hover:opacity-90 disabled:opacity-50 transition">
                      <Send size={11} /> Reply
                    </button>
                    <button onClick={() => setReplyingTo(null)}
                      className="px-3 py-1.5 rounded-lg border border-ic-rule text-ic-muted
                        font-mono text-xs hover:border-ic-accent transition">
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {/* Nested replies */}
              {replies.length > 0 && (
                <div className="ml-8 sm:ml-11 mt-3 border-l-2 border-ic-rule-soft pl-4 flex flex-col gap-4">
                  {visible.map((reply) => (
                    <CommentRow key={reply.id} c={reply} isReply {...rowProps} />
                  ))}
                  {!isExpanded && hiddenCount > 0 && (
                    <button
                      onClick={() => setExpanded((p) => new Set([...p, comment.id]))}
                      className="font-mono text-[11px] text-ic-accent hover:underline self-start">
                      Show {hiddenCount} more{" "}
                      {hiddenCount === 1 ? "reply" : "replies"}
                    </button>
                  )}
                  {isExpanded && replies.length > COLLAPSE_AFTER && (
                    <button
                      onClick={() =>
                        setExpanded((p) => {
                          const s = new Set(p);
                          s.delete(comment.id);
                          return s;
                        })
                      }
                      className="font-mono text-[11px] text-ic-muted hover:text-ic-ink-soft self-start">
                      Collapse replies
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
