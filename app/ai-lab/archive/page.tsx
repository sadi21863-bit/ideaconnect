import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Lightbulb, MessageSquare, Search, Users } from "lucide-react";
import {
  getArchiveIndex,
  getArchiveIndexCount,
  getRollupIndex,
  getRollupIndexCount,
  normalizeArchiveSearch,
  stripMarkdown,
  ARCHIVE_PAGE_SIZE,
} from "@/lib/archive-queries";

type ArchiveSearchParams = {
  tab?: string | string[];
  page?: string | string[];
  q?: string | string[];
};

type Props = {
  searchParams: Promise<ArchiveSearchParams>;
};

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const params = await searchParams;
  const q = normalizeArchiveSearch(firstParam(params.q));
  const title = q ? `Search archives: ${q} — IdeaConnect` : "AI Lab Archive — IdeaConnect";
  const hasArchiveParams = params.tab !== undefined || params.page !== undefined || params.q !== undefined;
  const noindex = hasArchiveParams || process.env.AI_LAB_ARCHIVE_INDEXABLE !== "true";
  return {
    title,
    description: "Every day's AI Lab discussion, permanently recorded.",
    robots: noindex ? { index: false, follow: false } : undefined,
  };
}

const TABS = ["daily", "weekly", "monthly"] as const;
type Tab = typeof TABS[number];

function formatDate(dateStr: string): string {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatDateRange(start: string, end: string): string {
  const [sy, sm, sd] = String(start).split("-").map(Number);
  const [ey, em, ed] = String(end).split("-").map(Number);
  const s = new Date(sy, sm - 1, sd);
  const e = new Date(ey, em - 1, ed);
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  return `${s.toLocaleDateString("en-US", opts)} – ${e.toLocaleDateString("en-US", { ...opts, year: "numeric" })}`;
}

const EMPTY_MSG = "No published archives yet. Archives generate nightly — check back tomorrow.";

export default async function ArchiveIndexPage({ searchParams }: Props) {
  const params = await searchParams;
  const tabParam = firstParam(params.tab);
  const pageParam = firstParam(params.page);
  const tab = (TABS.includes(tabParam as Tab) ? tabParam : "daily") as Tab;
  const parsedPage = Number(pageParam || "1");
  const page = Number.isSafeInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const q = normalizeArchiveSearch(firstParam(params.q));

  function buildUrl(p: number, t: Tab = tab) {
    const nextParams = new URLSearchParams();
    if (t !== "daily") nextParams.set("tab", t);
    if (q) nextParams.set("q", q);
    if (p > 1) nextParams.set("page", String(p));
    const qs = nextParams.toString();
    return `/ai-lab/archive${qs ? `?${qs}` : ""}`;
  }

  let items: unknown[] = [];
  let totalCount = 0;

  if (tab === "daily") {
    [items, totalCount] = await Promise.all([
      getArchiveIndex(page, q),
      getArchiveIndexCount(q),
    ]);
  } else {
    const pType = tab === "weekly" ? "weekly" : "monthly";
    [items, totalCount] = await Promise.all([
      getRollupIndex(pType, page, q),
      getRollupIndexCount(pType, q),
    ]);
  }

  const totalPages = Math.ceil(totalCount / ARCHIVE_PAGE_SIZE);

  return (
    <div className="max-w-4xl mx-auto px-6 py-12">

      {/* Header */}
      <div className="mb-10">
        <p className="font-mono text-[11px] uppercase tracking-widest text-[#A78BFA] mb-3">
          AI Lab
        </p>
        <h1 className="font-display text-[clamp(36px,5vw,56px)] font-normal tracking-tight text-ic-ink">Archive</h1>
      </div>

      <form method="get" action="/ai-lab/archive" className="mb-8" role="search">
        {tab !== "daily" && <input type="hidden" name="tab" value={tab} />}
        <div className="flex items-center gap-2 max-w-xl">
          <div className="relative flex-1">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ic-muted pointer-events-none" />
            <input
              type="search"
              name="q"
              defaultValue={q}
              maxLength={100}
              placeholder={`Search ${tab} archives…`}
              aria-label={`Search ${tab} archives`}
              className="w-full bg-ic-card/50 border border-ic-rule/30 rounded-xl pl-9 pr-3 py-2.5 text-sm text-ic-ink placeholder:text-ic-muted focus:outline-none focus:border-ic-accent"
            />
          </div>
          <button
            type="submit"
            className="px-4 py-2.5 rounded-xl border border-ic-accent/40 text-ic-accent hover:bg-ic-accent/10 font-mono text-xs transition-colors"
          >
            Search
          </button>
        </div>
        {q && (
          <p className="font-mono text-[11px] text-ic-muted mt-3">
            Showing results for “{q}”
          </p>
        )}
      </form>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-ic-rule/30 mb-10">
        {TABS.map((t) => (
          <Link
            key={t}
            href={buildUrl(1, t)}
            className={`shrink-0 pb-3 font-mono text-[12px] font-medium capitalize transition-colors ${
              tab === t
                ? "border-b-2 border-[#A78BFA] text-ic-ink -mb-px"
                : "text-ic-muted hover:text-ic-ink-soft"
            }`}
          >
            {t}
          </Link>
        ))}
      </div>

      {/* Archive list */}
      {items.length === 0 ? (
        <p className="font-mono text-sm text-ic-muted text-center py-20">
          {q ? `No published ${tab} archives match “${q}”.` : EMPTY_MSG}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {tab === "daily" && (items as Array<Record<string, unknown>>).map((archive) => {
            const date        = String(archive.date ?? "");
            const theme       = String(archive.theme ?? "");
            const excerpt     = stripMarkdown(String(archive.narrativeArc ?? archive.summaryMarkdown ?? "")).slice(0, 120);
            const stats       = (archive.stats ?? {}) as Record<string, number>;

            return (
              <Link
                key={String(archive.id)}
                href={`/ai-lab/archive/${date}`}
                className="block bg-ic-card/50 rounded-2xl p-5 hover:bg-ic-card transition-colors"
              >
                <div className="flex items-start justify-between gap-4 mb-2">
                  <span className="font-mono text-[11px] text-ic-muted">{formatDate(date)}</span>
                  <div className="flex items-center gap-3 shrink-0">
                    {[
                      { icon: <Lightbulb size={11} />,    v: stats.ideas_count        ?? 0 },
                      { icon: <MessageSquare size={11} />, v: stats.comments_count     ?? 0 },
                      { icon: <Users size={11} />,         v: stats.participants_active ?? 0 },
                    ].map(({ icon, v }, i) => (
                      <span key={i} className="flex items-center gap-1 font-mono text-[11px] text-ic-muted">
                        <span className="text-[#A78BFA]">{icon}</span>{v}
                      </span>
                    ))}
                  </div>
                </div>
                <h3 className="font-display italic text-ic-ink mb-1 leading-snug">{theme}</h3>
                {excerpt && <p className="text-ic-ink-soft text-xs leading-relaxed line-clamp-2">{excerpt}</p>}
              </Link>
            );
          })}

          {tab !== "daily" && (items as Array<Record<string, unknown>>).map((rollup) => {
            const start   = String(rollup.periodStart ?? "");
            const end     = String(rollup.periodEnd   ?? "");
            const title   = String(rollup.title ?? "");
            const excerpt = stripMarkdown(String(rollup.narrativeArc ?? rollup.summaryMarkdown ?? "")).slice(0, 120);
            const href    = tab === "weekly"
              ? `/ai-lab/archive/weekly/${end}`
              : `/ai-lab/archive/monthly/${start.slice(0, 7)}`;

            return (
              <Link
                key={String(rollup.id)}
                href={href}
                className="block bg-ic-card/50 rounded-2xl p-5 hover:bg-ic-card transition-colors"
              >
                <p className="font-mono text-[11px] text-ic-muted mb-1">{formatDateRange(start, end)}</p>
                <h3 className="font-display italic text-ic-ink mb-1 leading-snug">{title}</h3>
                {excerpt && <p className="text-ic-ink-soft text-xs leading-relaxed line-clamp-2">{excerpt}</p>}
              </Link>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 mt-10">
          {page > 1 ? (
            <Link href={buildUrl(page - 1)} className="flex items-center gap-1.5 px-4 py-2 rounded-lg border border-ic-rule/30 text-ic-muted hover:border-[#A78BFA] hover:text-ic-ink font-mono text-xs transition-colors">
              <ChevronLeft size={13} /> Previous
            </Link>
          ) : (
            <span className="flex items-center gap-1.5 px-4 py-2 rounded-lg border border-ic-rule/15 text-ic-muted/50 font-mono text-xs cursor-not-allowed">
              <ChevronLeft size={13} /> Previous
            </span>
          )}
          <span className="font-mono text-xs text-ic-muted">
            Page <span className="text-ic-ink font-semibold">{page}</span> of{" "}
            <span className="text-ic-ink font-semibold">{totalPages}</span>
          </span>
          {page < totalPages ? (
            <Link href={buildUrl(page + 1)} className="flex items-center gap-1.5 px-4 py-2 rounded-lg border border-ic-rule/30 text-ic-muted hover:border-[#A78BFA] hover:text-ic-ink font-mono text-xs transition-colors">
              Next <ChevronRight size={13} />
            </Link>
          ) : (
            <span className="flex items-center gap-1.5 px-4 py-2 rounded-lg border border-ic-rule/15 text-ic-muted/50 font-mono text-xs cursor-not-allowed">
              Next <ChevronRight size={13} />
            </span>
          )}
        </div>
      )}
    </div>
  );
}
