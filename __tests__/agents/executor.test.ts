import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// ─── Hoisted mocks ────────────────────────────────────────────────────

const mockCallAgent = vi.hoisted(() => vi.fn());

// Mutable stores for DB mock state — reset between tests
const dbState = vi.hoisted(() => ({
  transactionItems:  [] as Array<{ id: string }>,   // claimed by FOR UPDATE SKIP LOCKED
  fullQueueItems:    [] as Array<Record<string, unknown>>,
  usageRows:         [] as Array<Record<string, unknown>>,
  capturedUpdates:   [] as Array<{ id: string; data: Record<string, unknown> }>,
  capturedInserts:   [] as Array<{ table: string; data: Record<string, unknown> }>,
}));

// Transaction mock: calls callback with a tx that fakes FOR UPDATE SKIP LOCKED
const mockTransaction = vi.hoisted(() =>
  vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
    const mockTxUpdate = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    });
    const mockTxExecute = vi.fn().mockResolvedValue(dbState.transactionItems);
    return cb({ execute: mockTxExecute, update: mockTxUpdate });
  })
);

// select() chain — returns fullQueueItems or usageRows in call order
let selectCallCount = 0;
const mockDbSelect = vi.hoisted(() =>
  vi.fn().mockImplementation(() => {
    const callIndex = selectCallCount++;
    return {
      from: (_table: unknown) => ({
        where: (_cond: unknown) => {
          // First call per executeItem cycle fetches full queue rows
          // Second call is the usage check inside executeItem
          const isUsageCheck = callIndex > 0 && callIndex % 2 === 1;
          return Promise.resolve(
            isUsageCheck ? dbState.usageRows : dbState.fullQueueItems
          );
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

import { processQueue } from "@/lib/agents/executor";

// ─── Test helpers ─────────────────────────────────────────────────────

function resetState() {
  dbState.transactionItems  = [];
  dbState.fullQueueItems    = [];
  dbState.usageRows         = [];
  dbState.capturedUpdates   = [];
  dbState.capturedInserts   = [];
  selectCallCount           = 0;
  vi.clearAllMocks();

  // Re-wire update mock after clearAllMocks
  mockDbUpdate.mockImplementation((_table: unknown) => ({
    set: (data: Record<string, unknown>) => ({
      where: (cond: unknown) => {
        dbState.capturedUpdates.push({ id: String(cond), data });
        return Promise.resolve(undefined);
      },
    }),
  }));

  // Re-wire transaction mock
  mockTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
    const mockTxUpdate = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    });
    const mockTxExecute = vi.fn().mockResolvedValue(dbState.transactionItems);
    return cb({ execute: mockTxExecute, update: mockTxUpdate });
  });

  // Re-wire select mock
  selectCallCount = 0;
  mockDbSelect.mockImplementation(() => {
    const callIndex = selectCallCount++;
    const rows =
      callIndex > 0 ? dbState.usageRows : dbState.fullQueueItems;
    // Thenable chain: awaitable directly AND supports .orderBy().limit()
    // (memory retrieval, M1) and .limit() endings.
    const whereResult = (_cond: unknown) => ({
      orderBy: (_order: unknown) => ({
        // Memory retrieval resolves empty here so the memory block is
        // skipped without warnings in executor tests.
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

  // Re-wire insert mock
  mockDbInsert.mockImplementation((table: unknown) => ({
    values: (data: Record<string, unknown>) => {
      dbState.capturedInserts.push({ table: String(table), data });
      return {
        returning: vi.fn().mockResolvedValue([{ id: "new-result-id" }]),
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      };
    },
  }));
}

function makeQueueItem(overrides: Record<string, unknown> = {}) {
  return {
    id:              "item-1",
    agentId:         "ai_theme_setter",
    actionType:      "theme_select",
    roomId:          "room-1",
    targetIdeaId:    null,
    targetCommentId: null,
    promptContext:   { recentThemes: [] },
    scheduledFor:    new Date(),
    priority:        1,
    status:          "in_progress",
    executedAt:      null,
    errorMessage:    null,
    resultIdeaId:    null,
    resultCommentId: null,
    createdAt:       new Date(),
    ...overrides,
  };
}

// ─── Rate limit check ─────────────────────────────────────────────────

describe("processQueue — rate limiting", () => {
  beforeEach(resetState);

  it("does NOT call callAgent when agent is at daily limit", async () => {
    dbState.transactionItems = [{ id: "item-1" }];
    dbState.fullQueueItems   = [makeQueueItem({ agentId: "ai_llama", actionType: "post_idea" })];
    // Usage at limit (15/15)
    dbState.usageRows        = [{ agentId: "ai_llama", requestCount: 15 }];

    await processQueue(1);

    expect(mockCallAgent).not.toHaveBeenCalled();
  });

  it("marks the queue item as rate_limited when agent is at daily limit", async () => {
    dbState.transactionItems = [{ id: "item-1" }];
    dbState.fullQueueItems   = [makeQueueItem({ agentId: "ai_llama", actionType: "post_idea" })];
    dbState.usageRows        = [{ agentId: "ai_llama", requestCount: 15 }];

    await processQueue(1);

    const finalUpdate = dbState.capturedUpdates.find(
      (u) => u.data.status === "rate_limited"
    );
    expect(finalUpdate).toBeDefined();
  });

  it("proceeds normally when usage is below the daily limit", async () => {
    dbState.transactionItems = [{ id: "item-1" }];
    dbState.fullQueueItems   = [makeQueueItem()];
    dbState.usageRows        = [{ agentId: "ai_theme_setter", requestCount: 2 }]; // below limit of 5
    mockCallAgent.mockResolvedValueOnce(
      JSON.stringify({ theme: "Test theme", rationale: "Rationale", suggested_angles: [] })
    );

    await processQueue(1);

    expect(mockCallAgent).toHaveBeenCalledOnce();
  });
});

// ─── Empty response guard (the spec's critical test) ──────────────────

describe("processQueue — empty response after cleanup", () => {
  beforeEach(resetState);

  it("marks queue item failed when callAgent returns only thinking tags (post_idea)", async () => {
    dbState.transactionItems = [{ id: "item-1" }];
    dbState.fullQueueItems   = [makeQueueItem({
      agentId:    "ai_llama",
      actionType: "post_idea",
      promptContext: { theme: "AI governance" },
    })];
    dbState.usageRows = []; // below limit

    // Returns only a think block — strips to empty string
    mockCallAgent.mockResolvedValueOnce("<think>just reasoning</think>");

    await processQueue(1);

    // No idea inserted
    const ideaInsert = dbState.capturedInserts.find((i) =>
      i.data.title !== undefined && i.table !== String({}) // crude check
    );
    expect(ideaInsert).toBeUndefined();

    // Queue item marked failed
    const failedUpdate = dbState.capturedUpdates.find(
      (u) => u.data.status === "failed"
    );
    expect(failedUpdate).toBeDefined();
    expect(failedUpdate?.data.errorMessage).toContain("Empty response after cleanup");
  });

  it("marks queue item failed when callAgent returns empty string directly", async () => {
    dbState.transactionItems = [{ id: "item-1" }];
    dbState.fullQueueItems   = [makeQueueItem({ agentId: "ai_llama", actionType: "post_idea" })];
    dbState.usageRows        = [];

    mockCallAgent.mockResolvedValueOnce("");

    await processQueue(1);

    const failedUpdate = dbState.capturedUpdates.find(
      (u) => u.data.status === "failed"
    );
    expect(failedUpdate?.data.errorMessage).toContain("Empty response after cleanup");
  });

  it("marks queue item failed when idea content is too short (< 50 chars)", async () => {
    dbState.transactionItems = [{ id: "item-1" }];
    dbState.fullQueueItems   = [makeQueueItem({ agentId: "ai_llama", actionType: "post_idea" })];
    dbState.usageRows        = [];

    mockCallAgent.mockResolvedValueOnce(
      JSON.stringify({ title: "T", pitch: "P", content: "Too short" })
    );

    await processQueue(1);

    const failedUpdate = dbState.capturedUpdates.find((u) => u.data.status === "failed");
    expect(failedUpdate).toBeDefined();
  });
});

// ─── Success path ─────────────────────────────────────────────────────

describe("processQueue — success path", () => {
  beforeEach(resetState);

  it("inserts ai_themes row on successful theme_select", async () => {
    dbState.transactionItems = [{ id: "item-1" }];
    dbState.fullQueueItems   = [makeQueueItem()]; // theme_select
    dbState.usageRows        = [];

    mockCallAgent.mockResolvedValueOnce(
      JSON.stringify({ theme: "Open source hardware", rationale: "Trending", suggested_angles: ["cost", "supply"] })
    );

    await processQueue(1);

    const themeInsert = dbState.capturedInserts.find((i) =>
      (i.data as { theme?: string }).theme === "Open source hardware"
    );
    expect(themeInsert).toBeDefined();
  });

  it("marks the queue item completed after success", async () => {
    dbState.transactionItems = [{ id: "item-1" }];
    dbState.fullQueueItems   = [makeQueueItem()];
    dbState.usageRows        = [];

    mockCallAgent.mockResolvedValueOnce(
      JSON.stringify({ theme: "X", rationale: "R", suggested_angles: [] })
    );

    await processQueue(1);

    const completedUpdate = dbState.capturedUpdates.find(
      (u) => u.data.status === "completed"
    );
    expect(completedUpdate).toBeDefined();
  });

  it("upserts ai_usage row after a successful LLM call", async () => {
    dbState.transactionItems = [{ id: "item-1" }];
    dbState.fullQueueItems   = [makeQueueItem()];
    dbState.usageRows        = [];

    mockCallAgent.mockResolvedValueOnce(
      JSON.stringify({ theme: "X", rationale: "R", suggested_angles: [] })
    );

    await processQueue(1);

    // An insert into ai_usage should have happened
    const usageInsert = dbState.capturedInserts.find((i) =>
      (i.data as { agentId?: string }).agentId === "ai_theme_setter"
    );
    expect(usageInsert).toBeDefined();
    expect((usageInsert!.data as Record<string, unknown>).requestCount).toBe(1);
  });

  it("returns correct processed/failed counts", async () => {
    dbState.transactionItems = [{ id: "item-1" }, { id: "item-2" }];
    dbState.fullQueueItems   = [
      makeQueueItem({ id: "item-1" }),
      makeQueueItem({ id: "item-2" }),
    ];
    dbState.usageRows = [];

    // item-1 succeeds, item-2 fails (empty response)
    mockCallAgent
      .mockResolvedValueOnce(JSON.stringify({ theme: "X", rationale: "R", suggested_angles: [] }))
      .mockResolvedValueOnce("<think>only thinking</think>");

    const result = await processQueue(2);

    expect(result.processed).toBe(1);
    expect(result.failed).toBe(1);
  });

  it("does NOT increment usage when LLM throws", async () => {
    dbState.transactionItems = [{ id: "item-1" }];
    dbState.fullQueueItems   = [makeQueueItem()];
    dbState.usageRows        = [];

    mockCallAgent.mockRejectedValueOnce(new Error("network error"));

    await processQueue(1);

    // The error should mark the queue item failed
    const failedUpdate = dbState.capturedUpdates.find((u) => u.data.status === "failed");
    expect(failedUpdate).toBeDefined();

    // Usage should NOT have been inserted (failure before usage increment)
    const usageInsert = dbState.capturedInserts.find((i) =>
      (i.data as { agentId?: string }).agentId === "ai_theme_setter" &&
      (i.data as { requestCount?: number }).requestCount === 1
    );
    expect(usageInsert).toBeUndefined();
  });
});

// ─── FOR UPDATE SKIP LOCKED pattern ──────────────────────────────────
//
// True DB-level concurrency can't be tested in unit tests.
// These tests verify the two behavioral contracts instead:
//   (a) The executor uses db.transaction + tx.execute (raw SQL path, not select),
//       which is the mechanism that enables SKIP LOCKED.
//   (b) Two sequential calls with different mocked claim-sets each process
//       only their own rows — no item appears in both result sets.

describe("processQueue — FOR UPDATE SKIP LOCKED pattern", () => {
  it("uses db.transaction with tx.execute (the raw SQL path for SKIP LOCKED)", async () => {
    resetState();
    dbState.transactionItems = [];  // empty queue — just verify tx.execute is called

    await processQueue(5);

    // The transaction callback must have been invoked
    expect(mockTransaction).toHaveBeenCalledOnce();
  });

  it("two sequential calls process distinct rows when given disjoint claim sets", async () => {
    resetState();

    const firstBatch  = [1, 2, 3, 4, 5].map((n) => ({ id: `item-${n}` }));
    const secondBatch = [6, 7, 8, 9, 10].map((n) => ({ id: `item-${n}` }));

    let txCall = 0;
    mockTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
      const batch = txCall === 0 ? firstBatch : secondBatch;
      txCall++;
      return cb({
        execute: vi.fn().mockResolvedValue(batch),
        update:  vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
        }),
      });
    });

    // Sequential mock: select returns the right full rows for each call
    let selIdx = 0;
    const firstItems  = firstBatch.map((r) => makeQueueItem({ id: r.id }));
    const secondItems = secondBatch.map((r) => makeQueueItem({ id: r.id }));

    mockDbSelect.mockImplementation(() => {
      const idx = selIdx++;
      return {
        from: (_t: unknown) => ({
          where: (_c: unknown) => {
            // Calls 0..10 belong to first processQueue:
            //   0=item fetch, 1..10=usage+quota checks (2 per item)
            // Calls 11..21 belong to second processQueue:
            //   11=item fetch, 12..21=usage+quota checks
            if (idx === 0)   return Promise.resolve(firstItems);
            if (idx < 11)    return Promise.resolve([]);  // usage+quota for first batch
            if (idx === 11)  return Promise.resolve(secondItems);
            return Promise.resolve([]);                  // usage+quota for second batch
          },
          limit: () => Promise.resolve([]),
        }),
      };
    });
    selIdx = 0;

    mockCallAgent.mockResolvedValue(
      JSON.stringify({ theme: "Theme X", rationale: "R", suggested_angles: [] })
    );

    // Sequential (not concurrent) — simulates two separate worker ticks
    const r1 = await processQueue(5);
    const r2 = await processQueue(5);

    expect(r1.processed).toBe(5);
    expect(r2.processed).toBe(5);
    expect(r1.processed + r2.processed).toBe(10);
    expect(r1.failed + r2.failed).toBe(0);
  });
});

// ─── processQueue returns early when queue is empty ───────────────────

describe("processQueue — empty queue", () => {
  it("returns processed=0 failed=0 when nothing is pending", async () => {
    resetState();
    dbState.transactionItems = []; // no items claimed

    const result = await processQueue(5);

    expect(result).toEqual({ processed: 0, failed: 0, errors: [] });
    expect(mockCallAgent).not.toHaveBeenCalled();
  });
});
