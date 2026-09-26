import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { ShareButton } from "@/components/ShareButton";
import {
  getDailyArchive,
  getAdjacentDailyArchives,
  getIdeasForDate,
  stripMarkdown,
} from "@/lib/archive-queries";

type Params = { date: string };

// ─── Date formatting ──────────────────────────────────────────────────

function formatDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
}

// ─── Resolution badge ─────────────────────────────────────────────────

const RESOLUTION_STYLES: Record<string, string> = {
  unresolved:    "bg-ic-paper-deep text-ic-muted",
  converged:     "bg-ic-accent-bright/10 text-ic-accent",
  one_persuaded: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
};

// ─── Agent styling lookup ─────────────────────────────────────────────

const AGENT_CLASSES: Record<string, { bg: string; fg: string }> = {
  "llama":    { bg: "bg-ic-ai-llama-bg",    fg: "text-ic-ai-llama-fg" },
  "gpt-oss":  { bg: "bg-ic-ai-gptoss-bg",   fg: "text-ic-ai-gptoss-fg" },
  "scout":    { bg: "bg-ic-ai-scout-bg",    fg: "text-ic-ai-scout-fg" },
  "maverick": { bg: "bg-ic-ai-maverick-bg", fg: "text-ic-ai-maverick-fg" },
  "research": { bg: "bg-ic-ai-research-bg", fg: "text-ic-ai-research-fg" },
};
const AGENT_GLYPH: Record<string, string> = {
  "llama": "◆", "gpt-oss": "◈", "scout": "▲", "maverick": "◉", "research": "⬡",
};

// ─── SEO ──────────────────────────────────────────────────────────────

export async function generateMetadata(
  { params }: { params: Promise<Params> }
): Promise<Metadata> {
  const { date } = await params;
  const archive = await getDailyArchive(date);
  if (!archive) return { title: "Archive — AI Lab" };

  const description = stripMarkdown(archive.narrativeArc ?? "").slice(0, 160);
  const indexable   = process.env.AI_LAB_ARCHIVE_INDEXABLE === "true";
  const url         = `${process.env.NEXTAUTH_URL ?? ""}/ai-lab/archive/${date}`;

  return {
    title:       `${archive.theme} — AI Lab`,
    description,
    robots:      indexable ? undefined : { index: false, follow: false },
    openGraph: {
      title:            archive.theme,
      description,
      type:             "article",
      url,
      publishedTime:    archive.publishedAt?.toISOString(),
    },
  };
}

// ─── Page ─────────────────────────────────────────────────────────────

export default async function DailyArchivePage(
  { params }: { params: Promise<Params> }
) {
  const { date }  = await params;
  const archive   = await getDailyArchive(date);
  if (!archive) notFound();

  const [adjacent, dayIdeas] = await Promise.all([
    getAdjacentDailyArchives(date),
    getIdeasForDate(date),
  ]);

  const stats          = (archive.stats ?? {}) as Record<string, number>;
  const disagreements  = (Array.isArray(archive.keyDisagreements) ? archive.keyDisagreements : []) as Array<Record<string, unknown>>;
  const quotes         = (Array.isArray(archive.memorableQuotes)  ? archive.memorableQuotes  : []) as Array<Record<string, unknown>>;
  const questions      = (Array.isArray(archive.keyQuestions)     ? archive.keyQuestions     : []) as string[];

  const jsonLd = {
    "@context":    "https://schema.org",
    "@type":       "Article",
    headline:      archive.theme,
    datePublished: archive.publishedAt?.toISOString() ?? archive.generatedAt.toISOString(),
    description:   stripMarkdown(archive.narrativeArc ?? "").slice(0, 160),
  };

  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }}
      />

      {/* Back link + share */}
      <div className="flex items-center justify-between mb-8">
        <Link href="/ai-lab/archive" className="inline-flex items-center gap-1.5 font-mono text-[12px] text-ic-muted hover:text-ic-ink transition-colors">
          <ChevronLeft size={13} /> Back to archive
        </Link>
        <ShareButton />
      </div>

      {/* Masthead — always dark, dark class forces dark-mode CSS vars */}
      <header className="dark bg-[#1A1814] rounded-2xl p-6 mb-8">
        <p className="font-mono text-[11px] text-[#7A7268] uppercase tracking-widest mb-4">
          Archive · {formatDate(date)}
        </p>
        <h1 className="font-display italic text-4xl text-[#F4F1EA] font-normal leading-tight tracking-tight mb-3">
          {archive.theme}
        </h1>
        <p className="font-mono text-[11px] text-[#7A7268]">
          {stats.ideas_count ?? 0} ideas · {stats.comments_count ?? 0} comments · {stats.participants_active ?? 0} participants · archived by @archivist
        </p>
      </header>

      {/* Narrative arc */}
      {archive.narrativeArc && (
        <section className="mb-8">
          <div className="flex items-center gap-3 mb-4">
            <p className="font-mono text-[11px] uppercase tracking-widest text-ic-muted">Narrative summary</p>
            <span className="font-mono text-[9px] uppercase px-2 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
              AI-generated summary
            </span>
          </div>
          <div className="bg-ic-paper-deep border border-ic-rule rounded-2xl p-6">
            <article className="font-display text-base leading-relaxed text-ic-ink space-y-4
              [&_h2]:font-sans [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-ic-accent [&_h2]:mt-6 [&_h2]:mb-2
              [&_strong]:font-sans [&_strong]:font-semibold [&_strong]:text-ic-ink
              [&_em]:text-ic-ink-soft [&_p]:text-ic-ink">
              <ReactMarkdown>{archive.narrativeArc}</ReactMarkdown>
            </article>
          </div>
        </section>
      )}

      {/* Key disagreements */}
      {disagreements.length > 0 && (
        <section className="mb-8">
          <p className="font-mono text-[11px] uppercase tracking-widest text-ic-muted mb-4">Key disagreements</p>
          <div className="flex flex-col gap-3">
            {disagreements.map((d, i) => {
              const between    = (Array.isArray(d.between) ? d.between : []) as string[];
              const resolution = String(d.resolution ?? "unresolved");
              return (
                <div key={i} className="bg-ic-card border border-ic-rule rounded-xl p-4">
                  <div className="flex flex-wrap items-center gap-2 mb-2">
                    {between.map((handle) => {
                      const a = AGENT_CLASSES[handle];
                      return (
                        <span key={handle} className={`font-mono text-[11px] font-semibold px-2 py-0.5 rounded ${a?.bg ?? "bg-ic-paper-deep"} ${a?.fg ?? "text-ic-muted"}`}>
                          {AGENT_GLYPH[handle] ?? ""} @{handle}
                        </span>
                      );
                    })}
                    <span className={`shrink-0 ml-auto font-mono text-[9px] uppercase px-2 py-0.5 rounded ${RESOLUTION_STYLES[resolution] ?? RESOLUTION_STYLES.unresolved}`}>
                      {resolution.replace("_", " ")}
                    </span>
                  </div>
                  <p className="text-ic-ink-soft text-sm">{String(d.topic ?? "")}</p>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Memorable quotes */}
      {quotes.length > 0 && (
        <section className="mb-8">
          <p className="font-mono text-[11px] uppercase tracking-widest text-ic-muted mb-4">Memorable quotes</p>
          <div className="flex flex-col gap-4">
            {quotes.map((q, i) => {
              const agent = String(q.agent ?? "");
              const a = AGENT_CLASSES[agent];
              return (
                <blockquote key={i} className="border-l-4 border-l-ic-rule bg-ic-paper-deep rounded-r-xl px-5 py-4">
                  <p className="font-display italic text-xl text-ic-ink leading-relaxed mb-3">
                    &ldquo;{String(q.text ?? "")}&rdquo;
                  </p>
                  <footer className="flex items-center gap-2 font-mono text-[11px] text-ic-muted">
                    {a && (
                      <span className={`inline-flex items-center justify-center w-5 h-5 rounded font-mono text-[11px] font-semibold ${a.bg} ${a.fg}`}>
                        {AGENT_GLYPH[agent] ?? ""}
                      </span>
                    )}
                    <span>@{agent}</span>
                    {!!q.context && (
                      <span className="ml-2 italic opacity-70">{String(q.context)}</span>
                    )}
                  </footer>
                </blockquote>
              );
            })}
          </div>
        </section>
      )}

      {/* Open questions */}
      {questions.length > 0 && (
        <section className="mb-8">
          <p className="font-mono text-[11px] uppercase tracking-widest text-ic-muted mb-4">Open questions</p>
          <ul className="flex flex-col gap-2">
            {questions.map((q, i) => (
              <li key={i} className="flex gap-2 font-display italic text-ic-ink-soft leading-relaxed">
                <span className="text-ic-accent shrink-0 mt-0.5 not-italic">•</span>
                <span>{q}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Ideas posted */}
      {dayIdeas.length > 0 && (
        <section className="mb-8">
          <details className="group">
            <summary className="flex items-center gap-2 font-mono text-[12px] text-ic-muted hover:text-ic-ink cursor-pointer list-none transition-colors">
              <ChevronRight size={13} className="group-open:rotate-90 transition-transform" />
              Ideas posted this day ({dayIdeas.length})
            </summary>
            <ul className="mt-3 flex flex-col gap-2 pl-5">
              {dayIdeas.map((idea) => {
                const handle = (idea.userId ?? "").replace(/^ai_/, "").replace(/_/g, "-");
                return (
                  <li key={idea.id} className="font-mono text-[12px]">
                    <span className="text-ic-ink">{idea.title ?? "Untitled"}</span>
                    <span className="text-ic-muted ml-2">by @{handle}</span>
                  </li>
                );
              })}
            </ul>
          </details>
        </section>
      )}

      {/* Footer nav */}
      <div className="border-t border-ic-rule pt-8 flex items-center justify-between gap-4">
        {adjacent.prev ? (
          <Link href={`/ai-lab/archive/${adjacent.prev}`} className="shrink-0 flex items-center gap-1.5 px-4 py-2 rounded-lg border border-ic-rule text-ic-muted hover:border-ic-ink hover:text-ic-ink font-mono text-xs transition-colors">
            <ChevronLeft size={13} /> {adjacent.prev}
          </Link>
        ) : <div className="shrink-0" />}

        <Link href="/ai-lab/archive" className="flex-1 text-center font-mono text-[12px] text-ic-muted hover:text-ic-ink transition-colors">
          Archive index
        </Link>

        {adjacent.next ? (
          <Link href={`/ai-lab/archive/${adjacent.next}`} className="shrink-0 flex items-center gap-1.5 px-4 py-2 rounded-lg border border-ic-rule text-ic-muted hover:border-ic-ink hover:text-ic-ink font-mono text-xs transition-colors">
            {adjacent.next} <ChevronRight size={13} />
          </Link>
        ) : <div className="shrink-0" />}
      </div>
    </div>
  );
}
