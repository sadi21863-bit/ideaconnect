/**
 * Tests for the agent profile query helper (lib/agents/agent-profile.ts).
 * DB access is mocked; personas import is static and safe.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── DB mock ─────────────────────────────────────────────────────────

function makeChain(data: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.where    = () => makeChain(data);
  chain.leftJoin = () => makeChain(data);
  chain.orderBy  = () => makeChain(data);
  chain.limit    = () => makeChain(data);
  chain.offset   = () => Promise.resolve(data);
  const p = Promise.resolve(data) as Promise<unknown[]> & typeof chain;
  Object.assign(p, chain);
  return p;
}

const mockDbSelect = vi.hoisted(() => vi.fn());

vi.mock("@/db", () => ({
  db: { select: mockDbSelect },
}));

import { getAgentProfile } from "@/lib/agents/agent-profile";

// ─── Fixtures ────────────────────────────────────────────────────────

function selectOnce(rows: unknown[]) {
  mockDbSelect.mockReturnValueOnce({
    from: (_t: unknown) => makeChain(rows),
  });
}

function queueProfileSelects(opts: {
  ideas?: number;
  comments?: number;
  memories?: number;
  wins?: Array<{ id: string; date: string; theme: string }>;
  recentIdeas?: Array<{ id: string; title: string; createdAt: Date | null }>;
  recentComments?: Array<{ id: string; ideaId: string; content: string; createdAt: Date | null; ideaTitle: string }>;
} = {}) {
  const {
    ideas = 4,
    comments = 12,
    memories = 7,
    wins = [{ id: "a1", date: "2026-08-10", theme: "AI governance" }],
    recentIdeas = [{ id: "i1", title: "Idea one", createdAt: new Date("2026-08-12T10:00:00Z") }],
    recentComments = [{
      id: "c1", ideaId: "i1", content: "A thoughtful comment about the idea",
      createdAt: new Date("2026-08-12T11:00:00Z"), ideaTitle: "Idea one",
    }],
  } = opts;
  // Call order in getAgentProfile: 3 counts (Promise.all), wins, ideas, comments
  selectOnce([{ n: ideas }]);
  selectOnce([{ n: comments }]);
  selectOnce([{ n: memories }]);
  selectOnce(wins);
  selectOnce(recentIdeas);
  selectOnce(recentComments);
}

// ─── Tests ───────────────────────────────────────────────────────────

describe("getAgentProfile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null for an unknown handle without touching the DB", async () => {
    const profile = await getAgentProfile("no-such-agent");
    expect(profile).toBeNull();
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it("returns the agent with mapped stats", async () => {
    queueProfileSelects();
    const profile = await getAgentProfile("llama");
    expect(profile).not.toBeNull();
    expect(profile!.agent.handle).toBe("llama");
    expect(profile!.stats).toEqual({
      ideasPosted: 4,
      commentsPosted: 12,
      debatesWon: 1,
      memoriesKept: 7,
    });
  });

  it("maps recent ideas, comments, and wins", async () => {
    queueProfileSelects();
    const profile = await getAgentProfile("scout");
    expect(profile!.recentIdeas).toHaveLength(1);
    expect(profile!.recentIdeas[0].title).toBe("Idea one");
    expect(profile!.recentComments).toHaveLength(1);
    expect(profile!.recentComments[0].excerpt).toContain("thoughtful comment");
    expect(profile!.recentComments[0].ideaTitle).toBe("Idea one");
    expect(profile!.recentWins).toHaveLength(1);
    expect(profile!.recentWins[0].theme).toBe("AI governance");
  });

  it("handles an agent with no activity yet", async () => {
    queueProfileSelects({
      ideas: 0, comments: 0, memories: 0,
      wins: [], recentIdeas: [], recentComments: [],
    });
    const profile = await getAgentProfile("maverick");
    expect(profile!.stats).toEqual({
      ideasPosted: 0,
      commentsPosted: 0,
      debatesWon: 0,
      memoriesKept: 0,
    });
    expect(profile!.recentIdeas).toEqual([]);
    expect(profile!.recentComments).toEqual([]);
    expect(profile!.recentWins).toEqual([]);
  });
});
