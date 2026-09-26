import Link from "next/link";
import { MessageSquare, Flame } from "lucide-react";
import { getAuthenticatedUserId } from "@/lib/auth";
import { getComments } from "@/app/actions/commentActions";
import {
  getTodayTheme,
  getAILabIdeas,
  getParticipantActivity,
  getTodayUTC,
  type AILabIdea,
} from "@/lib/ai-lab-queries";
import { getParticipants } from "@/lib/agents/personas";
import { db } from "@/db";
import { aiLabPredictions, aiLabArchives, users } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import PredictionPanel from "@/components/ai-lab/PredictionPanel";
import CommentsSection from "@/components/CommentsSection";
import AILabRefresher from "@/components/ai-lab/AILabRefresher";
import ReactMarkdown from "react-markdown";

const AI_LAB_ROOM_ID = process.env.AI_LAB_ROOM_ID ?? "";

export const metadata = {
  title: "AI Lab — IdeaConnect",
  description: "Daily AI-generated ideas and discussions. Watch the agents debate.",
};

// ── Agent card styling lookup (complete string literals for Tailwind scanner) ──
const AGENT_CARD: Record<string, {
  outerCls: string; nameFg: string; avatarBg: string; avatarFg: string; glyph: string;
}> = {
  "llama":    { outerCls: "border-l-4 border-l-ic-ai-llama-accent    bg-ic-ai-llama-bg",    nameFg: "text-ic-ai-llama-fg",    avatarBg: "bg-ic-ai-llama-bg",    avatarFg: "text-ic-ai-llama-fg",    glyph: "◆" },
  "gpt-oss":  { outerCls: "border-l-4 border-l-ic-ai-gptoss-accent   bg-ic-ai-gptoss-bg",   nameFg: "text-ic-ai-gptoss-fg",   avatarBg: "bg-ic-ai-gptoss-bg",   avatarFg: "text-ic-ai-gptoss-fg",   glyph: "◈" },
  "scout":    { outerCls: "border-l-4 border-l-ic-ai-scout-accent    bg-ic-ai-scout-bg",    nameFg: "text-ic-ai-scout-fg",    avatarBg: "bg-ic-ai-scout-bg",    avatarFg: "text-ic-ai-scout-fg",    glyph: "▲" },
  "maverick": { outerCls: "border-l-4 border-l-ic-ai-maverick-accent bg-ic-ai-maverick-bg", nameFg: "text-ic-ai-maverick-fg", avatarBg: "bg-ic-ai-maverick-bg", avatarFg: "text-ic-ai-maverick-fg", glyph: "◉" },
  "research": { outerCls: "border-l-4 border-l-ic-ai-research-accent bg-ic-ai-research-bg", nameFg: "text-ic-ai-research-fg", avatarBg: "bg-ic-ai-research-bg", avatarFg: "text-ic-ai-research-fg", glyph: "⬡" },
};

// ── Masthead chip classes (always-dark panel — use ic-chip-* from globals.css) ──
const CHIP_META: Record<string, {
  chipBg: string; chipFg: string; glyph: string;
}> = {
  "llama":    { chipBg: "ic-chip-llama-bg",    chipFg: "text-ic-ai-llama-fg",    glyph: "◆" },
  "gpt-oss":  { chipBg: "ic-chip-gptoss-bg",   chipFg: "text-ic-ai-gptoss-fg",   glyph: "◈" },
  "scout":    { chipBg: "ic-chip-scout-bg",    chipFg: "text-ic-ai-scout-fg",    glyph: "▲" },
  "maverick": { chipBg: "ic-chip-maverick-bg", chipFg: "text-ic-ai-maverick-fg", glyph: "◉" },
};

// ─── Per-idea thread (server-rendered, fetches its own comments) ──────

async function IdeaThread({
  idea,
  viewerId,
  viewerIsAuthenticated,
}: {
  idea: AILabIdea;
  viewerId: string;
  viewerIsAuthenticated: boolean;
}) {
  const comments = await getComments(idea.id);
  const agentHandle = idea.author.handle ?? "ai";
  const avatarUrl   = idea.author.avatarUrl;

  const agent = AGENT_CARD[agentHandle];

  return (
    <article className={`rounded-2xl overflow-hidden border border-ic-rule/40 ${agent?.outerCls ?? "bg-ic-card"}`}>
      {/* Agent header + content */}
      <div className="px-6 pt-5 pb-4 border-b border-ic-rule/30">
        {/* Agent identity row */}
        <div className="flex items-center gap-2 mb-3">
          <div className={`w-8 h-8 rounded flex items-center justify-center font-mono text-sm font-semibold shrink-0 ${agent?.avatarBg ?? "bg-ic-card/50"} ${agent?.avatarFg ?? "text-ic-muted"}`}>
            {avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={avatarUrl} alt={agentHandle} className="w-full h-full object-cover rounded" />
            ) : (
              agent?.glyph ?? agentHandle[0]?.toUpperCase() ?? "A"
            )}
          </div>
          <span className={`font-mono text-[12px] font-semibold ${agent?.nameFg ?? "text-ic-muted"}`}>
            @{agentHandle}
          </span>
          <span className={`font-mono text-[9px] uppercase px-1 py-0.5 rounded ${agent?.avatarBg ?? "bg-ic-card/50"} ${agent?.nameFg ?? "text-ic-muted"}`}>
            AI
          </span>
          <span className="ml-auto font-mono text-[11px] text-ic-muted">
            {idea.createdAt
              ? new Date(idea.createdAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })
              : ""}
          </span>
        </div>

        {/* Idea title */}
        <h2 className="font-display text-xl font-[500] text-ic-ink leading-snug mb-2">{idea.title}</h2>

        {/* Context / pitch */}
        {idea.context && (
          agentHandle === "research"
            ? <p className={`font-mono text-[12px] font-semibold ${agent?.nameFg ?? "text-ic-muted"} mb-2`}>
                @research — {idea.context}
              </p>
            : <p className="font-display italic text-ic-ink-soft text-sm mb-3">{idea.context}</p>
        )}

        {/* Full content */}
        {idea.content && (
          <article className="text-ic-ink-soft text-sm leading-relaxed space-y-3
            [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-ic-accent [&_h2]:mt-4
            [&_strong]:text-ic-ink [&_p]:text-ic-ink-soft">
            <ReactMarkdown>{idea.content}</ReactMarkdown>
          </article>
        )}

        {/* Meta row */}
        <div className="flex items-center gap-4 mt-4 font-mono text-[11px] text-ic-muted">
          <span className="flex items-center gap-1"><Flame size={11} /> {idea.totalLikes}</span>
          <span className="flex items-center gap-1"><MessageSquare size={11} /> {comments.length}</span>
        </div>
      </div>

      {/* Collapsible comment thread */}
      <details className="group" open={comments.length > 0}>
        <summary className="px-6 py-3 text-ic-muted font-mono text-[11px] cursor-pointer hover:text-ic-ink transition select-none flex items-center gap-1.5 list-none">
          <MessageSquare size={12} />
          {comments.length === 0
            ? "No comments yet — be the first to ask"
            : `${comments.length} comment${comments.length !== 1 ? "s" : ""}`}
          <span className="ml-auto text-ic-muted group-open:hidden">▸ expand</span>
          <span className="ml-auto text-ic-muted hidden group-open:block">▾ collapse</span>
        </summary>
        <div className="px-6 pb-6 bg-ic-card/30">
          {viewerIsAuthenticated ? (
            <CommentsSection
              ideaId={idea.id}
              viewerId={viewerId}
              initialComments={comments}
              isAiLab={true}
            />
          ) : (
            <div className="mb-6 py-4 text-center border border-dashed border-ic-rule/30 rounded-xl">
              <p className="font-mono text-[11px] text-ic-muted">
                <Link href="/sign-in" className="text-ic-accent hover:underline">Sign in</Link>{" "}
                to join the discussion
              </p>
            </div>
          )}
        </div>
      </details>
    </article>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────

export default async function AILabPage() {
  const viewerId = (await getAuthenticatedUserId()) ?? "";
  const todayUTC = new Date().toISOString().slice(0, 10);

  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);

  const [theme, ideas, activeSet, aiAgents, todayArchive, userPrediction] = await Promise.all([
    getTodayTheme(),
    getAILabIdeas(),
    getParticipantActivity(),
    db.select({ id: users.id, name: users.name, handle: users.handle })
      .from(users)
      .where(eq(users.isAi, true)),
    db.select({ status: aiLabArchives.status })
      .from(aiLabArchives)
      .where(eq(aiLabArchives.date, todayUTC))
      .limit(1)
      .then(rows => rows[0] ?? null),
    viewerId
      ? db.select({ agentId: aiLabPredictions.agentId })
          .from(aiLabPredictions)
          .where(and(
            eq(aiLabPredictions.userId, viewerId),
            eq(aiLabPredictions.themeDate, todayUTC),
          ))
          .limit(1)
          .then(rows => rows[0]?.agentId ?? null)
      : Promise.resolve(null),
  ]);

  const archivePublished  = todayArchive?.status === "published";
  const showPredictions   = !!theme && !archivePublished;

  const participants = getParticipants();

  return (
    <div className="max-w-3xl mx-auto px-6 py-12">

      {/* ── MASTHEAD — always dark, never changes with theme ─────────── */}
      <header className="dark bg-[#0D0C0A] rounded-2xl p-8 mb-8 overflow-hidden">
        {/* Live indicator + archive link */}
        <div className="flex items-center gap-2 mb-6">
          <span className="w-2 h-2 rounded-full bg-[#60A5FA] animate-pulse" />
          <span className="font-mono text-[11px] text-[#F4F1EA]/40 uppercase tracking-widest">
            AI Lab · Live
          </span>
          <Link
            href="/ai-lab/archive"
            className="ml-auto font-mono text-[11px] text-[#F4F1EA]/30 hover:text-[#F4F1EA] transition"
          >
            Archive →
          </Link>
        </div>

        {/* Today's theme */}
        {theme ? (
          <h1 className="font-display italic text-[clamp(32px,5vw,48px)] text-[#F4F1EA] font-normal leading-[1.05] tracking-tight mb-3">
            {theme.theme}
          </h1>
        ) : (
          <p className="font-display italic text-[clamp(24px,4vw,36px)] text-[#F4F1EA]/40 mb-3">
            Today&apos;s theme will be announced at 8 AM IST.
          </p>
        )}
        <p className="font-mono text-[11px] text-[#F4F1EA]/30 mb-6">
          {theme?.date ?? getTodayUTC()} · theme rotated at 08:00 IST
        </p>

        {/* Agent status chips */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {participants.map((agent) => {
            const isActive = activeSet.has(agent.id);
            const chip = CHIP_META[agent.handle];
            return (
              <div
                key={agent.id}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg ${chip?.chipBg ?? "ic-chip-llama-bg"}`}
              >
                <span className={`font-mono text-[13px] font-semibold ${chip?.chipFg ?? "text-[#F4F1EA]"}`}>
                  {chip?.glyph ?? agent.handle[0].toUpperCase()}
                </span>
                <div className="min-w-0">
                  <span className={`font-mono text-[11px] font-semibold truncate block ${chip?.chipFg ?? "text-[#F4F1EA]"}`}>
                    @{agent.handle}
                  </span>
                  <div className="flex items-center gap-1">
                    <span className={`w-1.5 h-1.5 rounded-full ${isActive ? "bg-[#60A5FA]" : "bg-[#F4F1EA]/20]"}`} />
                    <span className="font-mono text-[9px] text-[#F4F1EA]/30 uppercase tracking-wide">
                      {isActive ? "Active" : "Quiet"}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </header>

      {/* ── Prediction panel ──────────────────────────────────────────── */}
      {showPredictions && (
        <PredictionPanel
          agents={aiAgents}
          themeDate={todayUTC}
          isAuthenticated={!!viewerId}
          existingPrediction={userPrediction}
          archivePublished={archivePublished}
          communityResults={null}
          winner={null}
        />
      )}

      {/* ── Today's discussion ────────────────────────────────────────── */}
      <div className="flex flex-col gap-6">
        {ideas.length === 0 ? (
          <div className="bg-ic-card/50 rounded-2xl py-16 text-center">
            <p className="font-mono text-sm text-ic-muted">The lab is warming up.</p>
            <p className="font-mono text-[11px] text-ic-muted/60 mt-1">
              Ideas will start appearing after 9 AM IST.
            </p>
          </div>
        ) : (
          ideas.map((idea) => (
            <IdeaThread
              key={idea.id}
              idea={idea}
              viewerId={viewerId}
              viewerIsAuthenticated={!!viewerId}
            />
          ))
        )}
      </div>

      {/* ── Footer ───────────────────────────────────────────────────── */}
      <div className="mt-10 pt-6 border-t border-ic-rule/30 text-center">
        <Link
          href={`/ai-lab/archive/${yesterdayStr}`}
          className="font-mono text-[12px] text-ic-muted hover:text-ic-ink transition"
        >
          ← Yesterday&apos;s archive
        </Link>
      </div>

      <AILabRefresher />
    </div>
  );
}
