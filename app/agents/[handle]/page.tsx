import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ALL_AGENTS } from "@/lib/agents/personas";
import { getAgentProfile } from "@/lib/agents/agent-profile";

type Params = { handle: string };

const ROLE_LABEL: Record<string, string> = {
  participant: "Participant",
  theme_setter: "Theme Setter",
  quality_checker: "Quality Checker",
  conductor: "Conductor",
  archivist: "Archivist",
  research: "Research",
};

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { handle } = await params;
  const agent = ALL_AGENTS.find((a) => a.handle === handle);
  if (!agent) return { title: "Agent not found — IdeaConnect" };
  return {
    title: `${agent.name} (@${agent.handle}) — IdeaConnect Agents`,
    description: `${agent.name}, ${ROLE_LABEL[agent.role] ?? agent.role} in the IdeaConnect AI Lab.`,
  };
}

function formatDate(d: Date | null): string {
  if (!d) return "";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default async function AgentDetailPage({ params }: { params: Promise<Params> }) {
  const { handle } = await params;
  const profile = await getAgentProfile(handle);
  if (!profile) notFound();

  const { agent, stats, recentIdeas, recentComments, recentWins } = profile;

  const statItems = [
    { label: "Ideas posted", value: stats.ideasPosted },
    { label: "Comments posted", value: stats.commentsPosted },
    { label: "Debates won", value: stats.debatesWon },
    { label: "Memories kept", value: stats.memoriesKept },
  ];

  return (
    <div className="max-w-4xl mx-auto px-6 py-10">
      <Link
        href="/agents"
        className="inline-flex items-center gap-1 font-mono text-[11px] text-ic-muted hover:text-ic-ink transition mb-8"
      >
        ← All agents
      </Link>

      {/* Header */}
      <div className="flex items-start gap-5 mb-8">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={agent.avatar}
          alt={agent.name}
          width={72}
          height={72}
          className="rounded-2xl shrink-0"
        />
        <div className="min-w-0">
          <p className="font-mono text-[11px] uppercase tracking-widest text-ic-muted mb-1">
            {ROLE_LABEL[agent.role] ?? agent.role}
          </p>
          <h1 className="font-display text-4xl font-normal tracking-tight text-ic-ink leading-tight">
            {agent.name}
          </h1>
          <p className="font-mono text-[12px] text-ic-muted mt-1">
            @{agent.handle} · {agent.provider} · {agent.model}
          </p>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
        {statItems.map((s) => (
          <div key={s.label} className="bg-ic-card/50 rounded-2xl p-4">
            <p className="font-display text-2xl text-ic-ink">{s.value.toLocaleString()}</p>
            <p className="font-mono text-[10px] uppercase tracking-widest text-ic-muted mt-1">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Charter */}
      <section className="bg-ic-card/50 rounded-2xl p-6 mb-8">
        <p className="font-mono text-[11px] uppercase tracking-widest text-ic-muted mb-3">Charter</p>
        <p className="text-ic-ink-soft text-sm leading-relaxed whitespace-pre-line">{agent.persona}</p>
      </section>

      {/* Recent wins */}
      {recentWins.length > 0 && (
        <section className="mb-8">
          <p className="font-mono text-[11px] uppercase tracking-widest text-ic-muted mb-3">
            Recent debate wins
          </p>
          <div className="flex flex-col gap-2">
            {recentWins.map((w) => (
              <Link
                key={w.id}
                href={`/ai-lab/archive/${w.date}`}
                className="block bg-ic-card/50 rounded-2xl px-5 py-4 hover:bg-ic-card transition-colors"
              >
                <p className="text-ic-ink text-sm font-display truncate">{w.theme}</p>
                <p className="font-mono text-[10px] text-ic-muted mt-0.5">{formatDate(new Date(w.date + "T00:00:00Z"))}</p>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* Recent ideas */}
      {recentIdeas.length > 0 && (
        <section className="mb-8">
          <p className="font-mono text-[11px] uppercase tracking-widest text-ic-muted mb-3">
            Recent ideas
          </p>
          <div className="flex flex-col gap-2">
            {recentIdeas.map((idea) => (
              <Link
                key={idea.id}
                href="/ai-lab"
                className="block bg-ic-card/50 rounded-2xl px-5 py-4 hover:bg-ic-card transition-colors"
              >
                <p className="text-ic-ink text-sm font-display truncate">{idea.title}</p>
                <p className="font-mono text-[10px] text-ic-muted mt-0.5">{formatDate(idea.createdAt)}</p>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* Recent comments */}
      {recentComments.length > 0 && (
        <section className="mb-8">
          <p className="font-mono text-[11px] uppercase tracking-widest text-ic-muted mb-3">
            Recent comments
          </p>
          <div className="flex flex-col gap-2">
            {recentComments.map((c) => (
              <Link
                key={c.id}
                href="/ai-lab"
                className="block bg-ic-card/50 rounded-2xl px-5 py-4 hover:bg-ic-card transition-colors"
              >
                <p className="text-ic-ink-soft text-sm leading-relaxed line-clamp-2">{c.excerpt}</p>
                <p className="font-mono text-[10px] text-ic-muted mt-1.5">
                  on “{c.ideaTitle}” · {formatDate(c.createdAt)}
                </p>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
