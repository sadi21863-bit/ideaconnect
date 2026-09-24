/**
 * Tests for AI author treatment on idea pages.
 *
 * The idea detail page passes `isAiLabIdea` to IdeaDetailClient
 * and `commentInput=<MentionInput>` to CommentsSection for AI Lab ideas.
 *
 * These tests verify the logic that determines isAiLabIdea and the
 * author fields available from the DB (is_ai, ai_role, avatar_url).
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── DB mock ─────────────────────────────────────────────────────────

let mockUserRow: Record<string, unknown> | null = null;

function makeChain(data: unknown[]) {
  const p = Promise.resolve(data) as Promise<unknown[]> & Record<string, unknown>;
  p.where    = () => makeChain(data);
  p.leftJoin = () => makeChain(data);
  p.orderBy  = () => makeChain(data);
  p.limit    = () => Promise.resolve(data);
  p.offset   = () => Promise.resolve(data);
  return p;
}

const mockDbSelect = vi.hoisted(() =>
  vi.fn().mockImplementation(() => ({
    from: () => makeChain(mockUserRow ? [mockUserRow] : []),
  }))
);

vi.mock("@/db", () => ({
  db: { select: mockDbSelect },
}));

// ─── Auth mock ────────────────────────────────────────────────────────

vi.mock("@/lib/auth", () => ({
  getAuthenticatedUserId: vi.fn().mockResolvedValue(null),
}));

// ─── Users schema (need for import) ──────────────────────────────────

vi.mock("@/db/schema", () => ({
  users:    { id: "users.id" },
  ideas:    { id: "ideas.id" },
  ideaLikes: {},
  rooms:    {},
  ideaComments: {},
  aiThemes: {},
}));

function reset() {
  mockUserRow = null;
  vi.clearAllMocks();
  mockDbSelect.mockImplementation(() => ({
    from: () => makeChain([]),
  }));
}

// ─── Tests ────────────────────────────────────────────────────────────

describe("getAILabIdeas — author fields from DB join", () => {
  beforeEach(reset);

  it("AI-authored row has isAi=true on author", async () => {
    const { getAILabIdeas } = await import("@/lib/ai-lab-queries");

    let dbData: unknown[] = [];
    mockDbSelect.mockImplementation(() => ({
      from: () => makeChain(dbData),
    }));

    dbData = [{
      id: "i1", title: "AI idea", context: null, content: "x",
      totalLikes: 0, totalComments: 0, createdAt: new Date(),
      userId: "ai_llama", handle: "llama", name: "Llama",
      isAi: true, aiRole: "participant", avatarUrl: "/agents/llama.png",
    }];

    const result = await getAILabIdeas("2026-04-29");
    expect(result[0].author.isAi).toBe(true);
    expect(result[0].author.aiRole).toBe("participant");
    expect(result[0].author.avatarUrl).toBe("/agents/llama.png");
  }, 15_000);

  it("human-authored row has isAi=false on author (regression check)", async () => {
    const { getAILabIdeas } = await import("@/lib/ai-lab-queries");

    let dbData: unknown[] = [];
    mockDbSelect.mockImplementation(() => ({
      from: () => makeChain(dbData),
    }));

    dbData = [{
      id: "i2", title: "Human idea", context: null, content: "y",
      totalLikes: 0, totalComments: 0, createdAt: new Date(),
      userId: "human-1", handle: "alice", name: "Alice",
      isAi: false, aiRole: null, avatarUrl: null,
    }];

    const result = await getAILabIdeas("2026-04-29");
    expect(result[0].author.isAi).toBe(false);
    expect(result[0].author.aiRole).toBeNull();
  });
});

describe("isAiLabIdea detection", () => {
  it("isAiLabIdea is true when idea.roomId matches AI_LAB_ROOM_ID", () => {
    const AI_LAB_ROOM_ID = "test-lab-room-id";
    const idea = { roomId: "test-lab-room-id" };
    const isAiLabIdea = !!AI_LAB_ROOM_ID && idea.roomId === AI_LAB_ROOM_ID;
    expect(isAiLabIdea).toBe(true);
  });

  it("isAiLabIdea is false for a normal room idea", () => {
    const AI_LAB_ROOM_ID = "test-lab-room-id";
    const idea = { roomId: "other-room-id" };
    const isAiLabIdea = !!AI_LAB_ROOM_ID && idea.roomId === AI_LAB_ROOM_ID;
    expect(isAiLabIdea).toBe(false);
  });

  it("isAiLabIdea is false when AI_LAB_ROOM_ID is empty", () => {
    const AI_LAB_ROOM_ID = "";
    const idea = { roomId: "" };
    const isAiLabIdea = !!AI_LAB_ROOM_ID && idea.roomId === AI_LAB_ROOM_ID;
    expect(isAiLabIdea).toBe(false);
  });
});
