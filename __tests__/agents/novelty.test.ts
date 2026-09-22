import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Mocks ──────────────────────────────────────────────────────────

function selectChain(result: unknown) {
  const chain: Record<string, unknown> = {};
  chain.from    = () => chain;
  chain.where   = () => chain;
  chain.orderBy = () => chain;
  chain.limit   = () => Promise.resolve(result);
  chain.then    = (resolve: (v: unknown) => void) => Promise.resolve(result).then(resolve);
  return chain;
}

const mockDbSelect = vi.hoisted(() => vi.fn());

const capturedInserts: Array<{ data: Record<string, unknown> }> = [];
function insertChain(result: unknown = undefined) {
  const chain: Record<string, unknown> = {};
  chain.returning = () => Promise.resolve(result);
  chain.onConflictDoUpdate = () => Promise.resolve(undefined);
  chain.then = (resolve: (v: unknown) => void) => Promise.resolve(result).then(resolve);
  chain.catch = (_fn: (e: unknown) => void) => Promise.resolve(result);
  return chain;
}
const mockDbInsert = vi.hoisted(() =>
  vi.fn().mockImplementation((_table: unknown) => ({
    values: (data: Record<string, unknown>) => {
      capturedInserts.push({ data });
      return insertChain([{ id: "new-idea-id" }]);
    },
  }))
);

const mockDbUpdate = vi.hoisted(() =>
  vi.fn().mockReturnValue({
    set: () => ({ where: () => Promise.resolve(undefined) }),
  })
);

vi.mock("@/db", () => ({
  db: { select: mockDbSelect, insert: mockDbInsert, update: mockDbUpdate },
}));

const mockCallGroq = vi.hoisted(() => vi.fn());
vi.mock("@/lib/agents/providers/groq", () => ({
  callGroq: mockCallGroq,
}));

const mockCallAgent = vi.hoisted(() => vi.fn());
vi.mock("@/lib/agents/providers/index", () => ({
  callAgent: mockCallAgent,
}));

vi.mock("@/lib/agents/scheduler", () => ({
  queueCommentsOnIdea: vi.fn().mockResolvedValue(undefined),
  queueQualityReview: vi.fn().mockResolvedValue(undefined),
  queueConductorIntervention: vi.fn().mockResolvedValue(undefined),
  queueDebateReply: vi.fn().mockResolvedValue(undefined),
}));

import { jaccardSimilarity, checkIdeaNovelty, LEXICAL_TRIGGER } from "@/lib/agents/novelty";
import { writePostIdea } from "@/lib/agents/handlers/writers";
import type { AIQueue } from "@/db/schema";

function makeItem(overrides: Partial<AIQueue> = {}): AIQueue {
  return {
    id:              "queue-1",
    agentId:         "ai_llama",
    actionType:      "post_idea",
    roomId:          "room-1",
    targetIdeaId:    null,
    targetCommentId: null,
    promptContext:   { theme: "Federated learning", rationale: null, suggestedAngles: [] },
    scheduledFor:    new Date(),
    priority:        1,
    status:          "pending",
    executedAt:      null,
    errorMessage:    null,
    resultIdeaId:    null,
    resultCommentId: null,
    createdAt:       new Date(),
    ...overrides,
  } as AIQueue;
}

function ideaJSON(title: string, pitch: string, content: string) {
  return JSON.stringify({ title, pitch, content: content + " ".repeat(120) });
}

const LONG = "This is a sufficiently long body of generated content that easily clears the minimum content length gate. ";

// ─── jaccardSimilarity ──────────────────────────────────────────────

describe("jaccardSimilarity", () => {
  it("returns 0 for empty inputs", () => {
    expect(jaccardSimilarity([], ["a", "b"])).toBe(0);
    expect(jaccardSimilarity(["a"], [])).toBe(0);
  });

  it("returns 1 for identical sets", () => {
    expect(jaccardSimilarity(["a", "b", "c"], ["c", "b", "a"])).toBe(1);
  });

  it("returns 0 for disjoint sets", () => {
    expect(jaccardSimilarity(["alpha", "beta"], ["gamma", "delta"])).toBe(0);
  });

  it("computes partial overlap", () => {
    // intersection 1, union 3 → 1/3
    expect(jaccardSimilarity(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3);
  });
});

// ─── checkIdeaNovelty ───────────────────────────────────────────────

describe("checkIdeaNovelty", () => {
  beforeEach(() => {
    capturedInserts.length = 0;
    vi.clearAllMocks();
  });

  it("is novel with an empty corpus and makes no LLM call", async () => {
    mockDbSelect.mockReturnValue(selectChain([]));
    const out = await checkIdeaNovelty("Brand new title here", "A fresh pitch about nothing prior");
    expect(out.novel).toBe(true);
    expect(out.maxSimilarity).toBe(0);
    expect(out.closestId).toBeNull();
    expect(mockCallGroq).not.toHaveBeenCalled();
  });

  it("is novel below the lexical trigger without an LLM call", async () => {
    mockDbSelect.mockReturnValue(
      selectChain([{ id: "old-1", title: "Quantum baking ovens", pitch: "Entangled sourdough starters" }])
    );
    const out = await checkIdeaNovelty("Federated learning for hospitals", "Privacy-preserving medical model training");
    expect(out.novel).toBe(true);
    expect(out.maxSimilarity).toBeLessThan(LEXICAL_TRIGGER);
    expect(mockCallGroq).not.toHaveBeenCalled();
  });

  it("defers to the LLM verdict on a suspicious match — not duplicate", async () => {
    mockDbSelect.mockReturnValue(
      selectChain([{ id: "old-1", title: "Federated learning for hospitals", pitch: "Privacy-preserving medical model training" }])
    );
    mockCallGroq.mockResolvedValueOnce({
      text: JSON.stringify({ duplicate: false, reason: "different angle", matchIndex: null }),
      totalTokens: 10,
    });
    const out = await checkIdeaNovelty("Federated learning for hospitals", "Privacy-preserving medical model training");
    expect(mockCallGroq).toHaveBeenCalledOnce();
    expect(out.novel).toBe(true);
    expect(out.closestId).toBe("old-1");
  });

  it("defers to the LLM verdict on a suspicious match — duplicate", async () => {
    mockDbSelect.mockReturnValue(
      selectChain([{ id: "old-1", title: "Federated learning for hospitals", pitch: "Privacy-preserving medical model training" }])
    );
    mockCallGroq.mockResolvedValueOnce({
      text: JSON.stringify({ duplicate: true, reason: "same proposal", matchIndex: 0 }),
      totalTokens: 10,
    });
    const out = await checkIdeaNovelty("Federated learning for hospitals", "Privacy-preserving medical model training");
    expect(out.novel).toBe(false);
    expect(out.closestId).toBe("old-1");
    expect(out.reason).toBe("same proposal");
  });

  it("fails open when the verdict call throws", async () => {
    mockDbSelect.mockReturnValue(
      selectChain([{ id: "old-1", title: "Federated learning for hospitals", pitch: "Privacy-preserving medical model training" }])
    );
    mockCallGroq.mockRejectedValueOnce(new Error("provider down"));
    const out = await checkIdeaNovelty("Federated learning for hospitals", "Privacy-preserving medical model training");
    expect(out.novel).toBe(true);
    expect(out.reason).toBe("verdict-unavailable");
  });

  it("lexical-only mode decides purely on the trigger threshold", async () => {
    mockDbSelect.mockReturnValue(
      selectChain([{ id: "old-1", title: "Federated learning for hospitals", pitch: "Privacy-preserving medical model training" }])
    );
    const out = await checkIdeaNovelty(
      "Federated learning for hospitals",
      "Privacy-preserving medical model training",
      { llmVerdict: false }
    );
    expect(out.novel).toBe(false);
    expect(mockCallGroq).not.toHaveBeenCalled();
  });
});

// ─── writePostIdea gate ─────────────────────────────────────────────

describe("writePostIdea novelty gate", () => {
  beforeEach(() => {
    capturedInserts.length = 0;
    vi.clearAllMocks();
  });

  it("posts directly when the idea is novel", async () => {
    mockDbSelect.mockReturnValue(selectChain([]));
    const posted = await writePostIdea(
      "ai_llama",
      makeItem(),
      ideaJSON("Completely fresh title here", "A pitch about something never discussed", LONG)
    );
    expect(posted).toBe(true);
    expect(capturedInserts.some((r) => "title" in r.data)).toBe(true);
    expect(mockCallAgent).not.toHaveBeenCalled();
  });

  it("resamples once on duplicate and posts the fresh angle", async () => {
    // First check sees the duplicate; the lexical recheck sees an unrelated corpus
    mockDbSelect.mockReturnValueOnce(
      selectChain([{ id: "old-1", title: "Federated learning for hospitals", pitch: "Privacy-preserving medical model training" }])
    );
    mockDbSelect.mockReturnValue(
      selectChain([{ id: "old-9", title: "Quantum baking ovens", pitch: "Entangled sourdough starters" }])
    );
    mockCallGroq.mockResolvedValueOnce({
      text: JSON.stringify({ duplicate: true, reason: "same proposal", matchIndex: 0 }),
      totalTokens: 10,
    });
    mockCallAgent.mockResolvedValueOnce(
      ideaJSON("Ocean cleanup drone swarms", "Autonomous floating collectors", LONG)
    );
    const posted = await writePostIdea(
      "ai_llama",
      makeItem(),
      ideaJSON("Federated learning for hospitals", "Privacy-preserving medical model training", LONG),
      "BASE PROMPT"
    );
    expect(mockCallAgent).toHaveBeenCalledOnce();
    expect(posted).toBe(true);
    const ideaInsert = capturedInserts.find((r) => "title" in r.data);
    expect(ideaInsert?.data.title).toBe("Ocean cleanup drone swarms");
  });

  it("skips the post and logs moderation when the resample still overlaps", async () => {
    const dupRow = [{ id: "old-1", title: "Federated learning for hospitals", pitch: "Privacy-preserving medical model training" }];
    mockDbSelect.mockReturnValue(selectChain(dupRow));
    mockCallGroq.mockResolvedValue({
      text: JSON.stringify({ duplicate: true, reason: "same proposal", matchIndex: 0 }),
      totalTokens: 10,
    });
    mockCallAgent.mockResolvedValueOnce(
      ideaJSON("Federated learning for hospitals v2", "Privacy-preserving medical model training encore", LONG)
    );
    const posted = await writePostIdea(
      "ai_llama",
      makeItem(),
      ideaJSON("Federated learning for hospitals", "Privacy-preserving medical model training", LONG),
      "BASE PROMPT"
    );
    expect(posted).toBe(false);
    expect(capturedInserts.some((r) => "title" in r.data)).toBe(false);
    expect(capturedInserts.some((r) => r.data.targetType === "novelty_skip")).toBe(true);
  });
});
