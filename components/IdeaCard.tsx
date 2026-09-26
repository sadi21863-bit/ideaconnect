"use client";

import Link from "next/link";
import { useState } from "react";
import { Eye, Heart, Link2, Check } from "lucide-react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { sparkIdea } from "@/app/actions/ideaActions";
import type { Idea } from "@/db/schema";
import { catClass } from "@/lib/categories";

interface Author {
  name:      string | null;
  handle:    string | null;
  isAi?:     boolean;
  avatarUrl?: string | null;
}

interface IdeaCardProps {
  idea: Idea;
  author?: Author | null;
  viewerId?: string;
  hasLiked?: boolean;
}

export default function IdeaCard({
  idea, author, viewerId = "", hasLiked = false,
}: IdeaCardProps) {
  const [liked, setLiked]       = useState(hasLiked);
  const [likeCount, setLikeCount] = useState(idea.totalLikes ?? 0);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied]     = useState(false);
  const reduce = useReducedMotion();

  const isTouch = typeof window !== "undefined" &&
    window.matchMedia?.("(hover: none)").matches;

  async function handleSpark(e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    if (liked || !viewerId) return;
    setLiked(true);
    setLikeCount((n) => n + 1);
    try {
      const r = await sparkIdea(idea.id);
      if (!r?.success) { setLiked(false); setLikeCount((n) => n - 1); }
    } catch {
      setLiked(false);
      setLikeCount((n) => n - 1);
    }
  }

  function copyLink() {
    navigator.clipboard.writeText(`${window.location.origin}/ai-lab`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpanded((v) => !v); } }}
      className="bg-ic-card border border-ic-rule rounded-2xl px-5 py-4 hover:border-ic-accent transition-colors duration-200 cursor-pointer"
      onMouseEnter={() => !isTouch && setExpanded(true)}
      onMouseLeave={() => !isTouch && setExpanded(false)}
      onClick={() => isTouch && setExpanded((v) => !v)}
    >
      <div className="grid grid-cols-[40px_1fr] gap-4">

        {/* LEFT — spark / like gutter */}
        <button
          onClick={handleSpark}
          aria-pressed={liked}
          aria-label={liked ? "Sparked" : "Spark this idea"}
          className="flex flex-col items-center gap-1 pt-1 group"
        >
          <motion.span
            whileTap={reduce ? {} : { scale: 1.4 }}
            whileHover={reduce ? {} : { scale: 1.1 }}
            transition={{ duration: 0.1, ease: "easeOut" }}
            className="inline-flex"
          >
            <Heart size={16} className={liked ? "fill-current text-ic-accent-bright" : "text-ic-muted group-hover:text-ic-ink transition-colors"} />
          </motion.span>
          <span className={`font-mono text-[13px] font-semibold ${liked ? "text-ic-accent-bright" : "text-ic-ink"}`}>
            {likeCount}
          </span>
        </button>

        {/* RIGHT — content */}
        <div className="min-w-0">

          {/* Meta row */}
          <div className="flex items-center gap-2 flex-wrap mb-2">
            {/* Category chip */}
            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded font-mono text-[10px] font-medium tracking-wide ${catClass(idea.category)}`}>
              <span className="w-1 h-1 rounded-[1px] bg-current opacity-[0.55]" />
              {idea.category ?? "general"}
            </span>

            {/* Draft badge */}
            {idea.status === "draft" && (
              <span className="font-mono text-[10px] font-medium px-1.5 py-0.5 rounded border ic-badge-draft">
                Draft
              </span>
            )}

            {/* AI author badge */}
            {author?.isAi && (
              <span className="font-mono text-[10px] font-semibold px-1.5 py-0.5 rounded bg-ic-accent text-white leading-none">
                AI
              </span>
            )}

            <span className="flex-1" />

            {/* Views */}
            <span className="flex items-center gap-1 font-mono text-[11px] text-ic-muted">
              <Eye size={10} /> {idea.views ?? 0}
            </span>
          </div>

          {/* Title */}
          <h3
            title={idea.title ?? undefined}
            className="font-display text-xl font-[500] text-ic-ink leading-snug truncate mb-0.5"
          >
            {idea.title}
          </h3>

          {/* Expand panel — hover on desktop, tap on touch */}
          <AnimatePresence>
            {expanded && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: reduce ? 0 : 0.2, ease: "easeOut" }}
                className="overflow-hidden"
              >
                <div className="mt-2">
                  {/* Pitch / context */}
                  {idea.context ? (
                    <p className="text-sm text-ic-ink-soft line-clamp-3 mb-3">{idea.context}</p>
                  ) : (
                    <p className="text-sm text-ic-muted italic mb-3">No pitch added.</p>
                  )}

                  {/* Author */}
                  {author && (
                    author.isAi ? (
                      <div className="flex items-center gap-2 mb-3 w-fit">
                        <div className="relative w-6 h-6 shrink-0">
                          <div className="absolute inset-0 rounded bg-ic-paper-deep border border-ic-rule flex items-center justify-center font-mono text-[10px] font-bold text-ic-muted">
                            {author.handle?.[0]?.toUpperCase() ?? "?"}
                          </div>
                          {author.avatarUrl && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={author.avatarUrl}
                              alt=""
                              className="absolute inset-0 w-full h-full rounded object-cover"
                              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                            />
                          )}
                        </div>
                        <div className="flex items-center gap-1.5">
                          <p className="font-mono text-[12px] font-semibold text-ic-ink leading-none">@{author.handle ?? "ai"}</p>
                          <span className="font-mono text-[10px] font-semibold px-1.5 py-0.5 rounded bg-ic-accent text-white leading-none">AI</span>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 mb-3 w-fit">
                        <div className="w-6 h-6 rounded bg-ic-paper-deep border border-ic-rule flex items-center justify-center font-mono text-[10px] font-semibold text-ic-muted">
                          {author.name?.[0]?.toUpperCase() ?? "?"}
                        </div>
                        <div>
                          <p className="font-mono text-[12px] font-semibold text-ic-ink leading-none">{author.name ?? "Anonymous"}</p>
                          <p className="font-mono text-[11px] text-ic-muted">@{author.handle ?? "unknown"}</p>
                        </div>
                      </div>
                    )
                  )}

                  {/* Actions bar */}
                  <div className="flex items-center gap-1.5 pt-2 border-t border-ic-rule-soft">
                    <Link
                      href="/ai-lab"
                      onClick={(e) => e.stopPropagation()}
                      className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-white bg-ic-accent rounded-lg hover:opacity-90 transition"
                    >
                      <Eye size={12} /> View Lab
                    </Link>
                    <button
                      onClick={(e) => { e.stopPropagation(); copyLink(); }}
                      className="flex items-center gap-1 text-xs text-ic-muted hover:text-ic-ink transition-colors px-2 py-1.5"
                      title="Copy link"
                    >
                      {copied
                        ? <Check size={12} className="text-ic-accent" />
                        : <Link2 size={12} />
                      }
                    </button>

                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
