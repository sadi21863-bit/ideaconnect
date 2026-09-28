import { vi, describe, it, expect, beforeEach } from "vitest";

const dbState = vi.hoisted(() => ({
  selectResponses: [] as unknown[][],
  capturedInserts: [] as Array<{ data: Record<string, unknown> }>,
}));

let selectCall = 0;
const mockDbSelect = vi.hoisted(() =>
  vi.fn().mockImplementation(() => {
    const rows = dbState.selectResponses[selectCall++] ?? [];
    const chain = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>;
    chain.where = () => chain;
    chain.orderBy = () => chain;
    chain.limit = () => chain;
    return { from: () => chain };
  })
);

const mockDbInsert = vi.hoisted(() =>
  vi.fn().mockImplementation(() => ({
    values: (data: Record<string, unknown>) => {
      dbState.capturedInserts.push({ data });
      const chain = Promise.resolve() as Promise<void> & Record<string, unknown>;
      chain.returning = () => Promise.resolve([{ id: "comment-1" }]);
      chain.onConflictDoUpdate = () => Promise.resolve();
      return chain;
    },
  }))
);

const mockDbUpdate = vi.hoisted(() =>
  vi.fn().mockImplementation(() => ({
    set: () => ({ where: () => Promise.resolve() }),
  }))
);

vi.mock("@/db", () => ({
  db: { select: mockDbSelect, insert: mockDbInsert, update: mockDbUpdate },
}));

const mockCallAgent = vi.hoisted(() => vi.fn());
vi.mock("@/lib/agents/providers/index", () => ({ callAgent: mockCallAgent }));

vi.mock("@/lib/agents/scheduler", () => ({
  queueCommentsOnIdea: vi.fn(),
  queueQualityReview: vi.fn(),
  queueConductorIntervention: vi.fn(),
  queueDebateReply: vi.fn(),
}));

import { writeConductorQuestion } from "@/lib/agents/handlers/writers";
import type { AIQueue } from "@/db/schema";

function makeItem(): AIQueue {
  return {
    id: "queue-1",
    agentId: "ai_conductor",
    actionType: "conductor",
    roomId: "lab-room",
    targetIdeaId: "idea-1",
    targetCommentId: null,
    promptContext: {},
    scheduledFor: new Date(),
    priority: 1,
    status: "in_progress",
    executedAt: null,
    errorMessage: null,
    resultIdeaId: null,
    resultCommentId: null,
    createdAt: new Date(),
  } as AIQueue;
}

describe("writeConductorQuestion", () => {
  beforeEach(() => {
    dbState.selectResponses = [
      [{ id: "idea-1", title: "A proposal", context: null }],
      [
        { userId: "ai_llama", content: "This will fail." },
        { userId: "ai_scout", content: "The assumption is wrong." },
      ],
    ];
    dbState.capturedInserts = [];
    selectCall = 0;
    vi.clearAllMocks();
    mockCallAgent.mockImplementation(async (_agent: unknown, _prompt: string, options: { usageOut?: { tokens: number } }) => {
      if (options.usageOut) options.usageOut.tokens = 42;
      return "What constraint would invalidate this proposal?";
    });
  });

  it("records the Conductor call against the AI Lab budget", async () => {
    await writeConductorQuestion("ai_conductor", makeItem());

    expect(mockCallAgent).toHaveBeenCalledOnce();
    const usageInsert = dbState.capturedInserts.find((insert) => insert.data.feature === "ai_lab");
    expect(usageInsert?.data).toMatchObject({ agentId: "ai_conductor", tokens: 42, feature: "ai_lab" });
  });
});
