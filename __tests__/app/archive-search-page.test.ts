import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getArchiveIndex: vi.fn(),
  getArchiveIndexCount: vi.fn(),
  getRollupIndex: vi.fn(),
  getRollupIndexCount: vi.fn(),
  normalizeArchiveSearch: vi.fn((value?: string) => (value ?? "").trim().replace(/\s+/g, " ").slice(0, 100)),
  stripMarkdown: vi.fn((value: string) => value),
  ARCHIVE_PAGE_SIZE: 20,
}));

vi.mock("@/lib/archive-queries", () => mocks);

import ArchiveIndexPage, { generateMetadata } from "@/app/ai-lab/archive/page";

describe("archive search page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getArchiveIndex.mockResolvedValue([
      {
        id: "archive-1",
        date: "2026-09-20",
        theme: "Private computation",
        narrativeArc: "A short narrative",
        summaryMarkdown: "Legacy summary",
        stats: { ideas_count: 3, comments_count: 4, participants_active: 2 },
      },
    ]);
    mocks.getArchiveIndexCount.mockResolvedValue(1);
    mocks.getRollupIndex.mockResolvedValue([]);
    mocks.getRollupIndexCount.mockResolvedValue(0);
  });

  it("normalizes the query, resets invalid pages, and passes it to list and count", async () => {
    const element = await ArchiveIndexPage({
      searchParams: Promise.resolve({ q: "  private   computation  ", page: "not-a-number" }),
    });
    const html = renderToStaticMarkup(element);

    expect(mocks.getArchiveIndex).toHaveBeenCalledWith(1, "private computation");
    expect(mocks.getArchiveIndexCount).toHaveBeenCalledWith("private computation");
    expect(html).toContain("Showing results for “private computation”");
    expect(html).toContain("Private computation");
  }, 15_000);

  it("keeps the query when changing tabs", async () => {
    mocks.getRollupIndex.mockResolvedValue([
      {
        id: "rollup-1",
        periodStart: "2026-09-14",
        periodEnd: "2026-09-20",
        title: "Privacy week",
        narrativeArc: "A weekly narrative",
        summaryMarkdown: "Legacy summary",
      },
    ]);
    mocks.getRollupIndexCount.mockResolvedValue(1);

    const element = await ArchiveIndexPage({
      searchParams: Promise.resolve({ tab: "weekly", q: "privacy" }),
    });
    const html = renderToStaticMarkup(element);

    expect(mocks.getRollupIndex).toHaveBeenCalledWith("weekly", 1, "privacy");
    expect(mocks.getRollupIndexCount).toHaveBeenCalledWith("weekly", "privacy");
    expect(html).toContain("Search weekly archives");
    expect(html).toContain("Privacy week");
  });

  it("shows a search-specific empty state", async () => {
    mocks.getArchiveIndex.mockResolvedValue([]);
    mocks.getArchiveIndexCount.mockResolvedValue(0);

    const element = await ArchiveIndexPage({
      searchParams: Promise.resolve({ q: "missing" }),
    });
    const html = renderToStaticMarkup(element);

    expect(html).toContain("No published daily archives match “missing”.");
  });

  it("noindexes search result pages", async () => {
    process.env.AI_LAB_ARCHIVE_INDEXABLE = "true";
    const metadata = await generateMetadata({
      searchParams: Promise.resolve({ q: "privacy" }),
    });

    expect(metadata.robots).toEqual({ index: false, follow: false });
    delete process.env.AI_LAB_ARCHIVE_INDEXABLE;
  });
});
