import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoisted mocks ────────────────────────────────────────────────────

const mockCallAgent = vi.hoisted(() => vi.fn());

const mockQueueCommentsOnIdea = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockQueueQualityReview  = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

const dbState = vi.hoisted(() => ({
  transactionItems: [] as Array<{ id: string }>,
  fullQueueItems:   [] as Array<Record<string, unknown>>,
  usageRows:        [] as Array<Record<string, unknown>>,
  capturedUpdates:  [] as Array<{ id: string; data: Record<string, unknown> }>,
  capturedInserts:  [] as Array<{ table: string; data: Record<string, unknown> }>,
}));

const mockTransaction = vi.hoisted(() =>
  vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
    const mockTxUpdate = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    });
    const mockTxExecute = vi.fn().mockResolvedValue(dbState.transactionItems);
    return cb({ execute: mockTxExecute, update: mockTxUpdate });
  })
);

let selectCallCount = 0;
const mockDbSelect = vi.hoisted(() =>
  vi.fn().mockImplementation(() => {
    const callIndex = selectCallCount++;
    return {
      from: (_table: unknown) => ({
        where: (_cond: unknown) => {
          const isUsageCheck = callIndex > 0;
          return Promise.resolve(isUsageCheck ? dbState.usageRows : dbState.fullQueueItems);
        },
        limit: () => Promise.resolve(dbState.fullQueueItems),
      }),
    };
  })
);

const mockDbUpdate = vi.hoisted(() =>
  vi.fn().mockImplementation((_table: unknown) => ({
    set: (data: Record<string, unknown>) => ({
      where: (cond: unknown) => {
        dbState.capturedUpdates.push({ id: String(cond), data });
        return Promise.resolve(undefined);
      },
    }),
  }))
);

const mockDbInsert = vi.hoisted(() =>
  vi.fn().mockImplementation((table: unknown) => ({
    values: (data: Record<string, unknown>) => {
      dbState.capturedInserts.push({ table: String(table), data });
      return {
        returning: vi.fn().mockResolvedValue([{ id: "new-result-id" }]),
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      };
    },
  }))
);

vi.mock("@/db", () => ({
  db: {
    transaction: mockTransaction,
    select:      mockDbSelect,
    update:      mockDbUpdate,
    insert:      mockDbInsert,
  },
}));

vi.mock("@/lib/agents/providers/index", () => ({
  callAgent: mockCallAgent,
}));

vi.mock("@/lib/agents/scheduler", () => ({
  queueCommentsOnIdea: mockQueueCommentsOnIdea,
  queueQualityReview:  mockQueueQualityReview,
  queueThemeSelection: vi.fn(),
  queueDailyIdeas:     vi.fn(),
  queueDailyArchive:   vi.fn(),
  queueWeeklyRollup:   vi.fn(),
  queueMonthlyRollup:  vi.fn(),
}));

import { processQueue } from "@/lib/agents/executor";

// ─── Helpers ──────────────────────────────────────────────────────────

const LONG_CONTENT = "A".repeat(60);

function resetState() {
  dbState.transactionItems = [];
  dbState.fullQueueItems   = [];
  dbState.usageRows        = [];
  dbState.capturedUpdates  = [];
  dbState.capturedInserts  = [];
  selectCallCount          = 0;
  vi.clearAllMocks();

  mockDbUpdate.mockImplementation((_table: unknown) => ({
    set: (data: Record<string, unknown>) => ({
      where: (cond: unknown) => {
        dbState.capturedUpdates.push({ id: String(cond), data });
        return Promise.resolve(undefined);
      },
    }),
  }));

  mockTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
    const mockTxUpdate = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    });
    const mockTxExecute = vi.fn().mockResolvedValue(dbState.transactionItems);
    return cb({ execute: mockTxExecute, update: mockTxUpdate });
  });

  selectCallCount = 0;
  mockDbSelect.mockImplementation(() => {
    const callIndex = selectCallCount++;
    const rows =
      callIndex > 0 ? dbState.usageRows : dbState.fullQueueItems;
    const whereResult = (_cond: unknown) => ({
      // Memory retrieval (M1) chains .orderBy().limit(); resolve empty.
      orderBy: (_order: unknown) => ({
        limit: () => Promise.resolve([]),
      }),
      limit: () => Promise.resolve(dbState.fullQueueItems),
      then: (resolve: (v: unknown) => void) =>
        Promise.resolve(rows).then(resolve),
    });
    return {
      from: (_table: unknown) => ({
        where: whereResult,
        limit: () => Promise.resolve(dbState.fullQueueItems),
      }),
    };
  });

  mockDbInsert.mockImplementation((table: unknown) => ({
    values: (data: Record<string, unknown>) => {
      dbState.capturedInserts.push({ table: String(table), data });
      return {
        returning: vi.fn().mockResolvedValue([{ id: "new-result-id" }]),
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      };
    },
  }));

  mockQueueCommentsOnIdea.mockResolvedValue(undefined);
  mockQueueQualityReview.mockResolvedValue(undefined);
}

function makeItem(overrides: Record<string, unknown> = {}) {
  return {
    id:              "item-1",
    agentId:         "ai_llama",
    actionType:      "post_idea",
    roomId:          "room-1",
    targetIdeaId:    null,
    targetCommentId: null,
    promptContext:   { theme: "AI governance" },
    scheduledFor:    new Date(),
    priority:        7,
    status:          "in_progress",
    executedAt:      null,
    errorMessage:    null,
    resultIdeaId:    null,
    resultCommentId: null,
    createdAt:       new Date(),
    ...overrides,
  };
}

// ─── post_idea cascade ────────────────────────────────────────────────

describe("post_idea cascade", () => {
  beforeEach(resetState);

  it("queues comments and quality review after a successful post_idea", async () => {
    dbState.transactionItems = [{ id: "item-1" }];
    dbState.fullQueueItems   = [makeItem({ agentId: "ai_llama", actionType: "post_idea" })];
    dbState.usageRows        = [];

    mockCallAgent.mockResolvedValueOnce(
      JSON.stringify({ title: "Test Idea", content: LONG_CONTENT, pitch: "pitch" })
    );

    await processQueue(1);

    expect(mockQueueCommentsOnIdea).toHaveBeenCalledOnce();
    expect(mockQueueCommentsOnIdea).toHaveBeenCalledWith("new-result-id", "ai_llama");
    expect(mockQueueQualityReview).toHaveBeenCalledOnce();
    expect(mockQueueQualityReview).toHaveBeenCalledWith("new-result-id", "idea");
  });

  it("does not crash if queueCommentsOnIdea throws — idea still marked completed", async () => {
    dbState.transactionItems = [{ id: "item-1" }];
    dbState.fullQueueItems   = [makeItem({ agentId: "ai_llama", actionType: "post_idea" })];
    dbState.usageRows        = [];

    mockCallAgent.mockResolvedValueOnce(
      JSON.stringify({ title: "Test Idea", content: LONG_CONTENT, pitch: "pitch" })
    );
    mockQueueCommentsOnIdea.mockRejectedValueOnce(new Error("DB unavailable"));

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result     = await processQueue(1);

    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);
    const completedUpdate = dbState.capturedUpdates.find((u) => u.data.status === "completed");
    expect(completedUpdate).toBeDefined();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[executor] queueCommentsOnIdea failed"),
      expect.any(String),
    );
    consoleSpy.mockRestore();
  });

  it("still queues quality review even when queueCommentsOnIdea throws", async () => {
    dbState.transactionItems = [{ id: "item-1" }];
    dbState.fullQueueItems   = [makeItem({ agentId: "ai_llama", actionType: "post_idea" })];
    dbState.usageRows        = [];

    mockCallAgent.mockResolvedValueOnce(
      JSON.stringify({ title: "Test Idea", content: LONG_CONTENT, pitch: "pitch" })
    );
    mockQueueCommentsOnIdea.mockRejectedValueOnce(new Error("DB unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    await processQueue(1);

    expect(mockQueueQualityReview).toHaveBeenCalledWith("new-result-id", "idea");
  });
});

// ─── comment cascade ──────────────────────────────────────────────────

describe("comment cascade", () => {
  beforeEach(resetState);

  it("queues quality review after a successful comment", async () => {
    dbState.transactionItems = [{ id: "item-1" }];
    dbState.fullQueueItems   = [makeItem({
      agentId:      "ai_gpt_oss",
      actionType:   "comment",
      targetIdeaId: "idea-123",
      promptContext: { authorHandle: "llama", ideaTitle: "Test", ideaPitch: "", ideaContent: "" },
    })];
    dbState.usageRows = [];

    mockCallAgent.mockResolvedValueOnce(LONG_CONTENT);

    await processQueue(1);

    expect(mockQueueQualityReview).toHaveBeenCalledOnce();
    expect(mockQueueQualityReview).toHaveBeenCalledWith("new-result-id", "comment");
    // Comments should NOT trigger queueCommentsOnIdea
    expect(mockQueueCommentsOnIdea).not.toHaveBeenCalled();
  });
});
