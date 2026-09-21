import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── DB mock ──────────────────────────────────────────────────────────
const capturedInserts: Array<Record<string, unknown>> = [];

const mockInsertValues = vi.hoisted(() =>
  vi.fn().mockImplementation((data: Record<string, unknown>) => {
    capturedInserts.push(data);
    return Promise.resolve(undefined);
  })
);

const mockDbInsert = vi.hoisted(() =>
  vi.fn().mockReturnValue({ values: mockInsertValues })
);

// Generic chainable select mock — created AFTER vi.hoisted so makeSelectChain
// is available at the point makeSelectChain is called (in beforeEach, not at hoist time).
// Fully fluent: any sequence of .from/.where/.orderBy/.limit resolves correctly.
function makeSelectChain(result: unknown = []) {
  const chain: Record<string, unknown> = {};
  chain.from    = () => chain;
  chain.where   = () => chain;
  chain.orderBy = () => chain;
  chain.limit   = () => Promise.resolve(result);
  return chain;
}

// Initialized without a default — each test's beforeEach sets mockReturnValue
const mockDbSelect = vi.hoisted(() => vi.fn());

vi.mock("@/db", () => ({
  db: {
    select: mockDbSelect,
    insert: mockDbInsert,
  },
}));

import {
  queueThemeSelection,
  queueDailyIdeas,
  queueCommentsOnIdea,
  queueQualityReview,
  queueDailyArchive,
  queueWeeklyRollup,
  queueMonthlyRollup,
  queueMemoryReflection,
} from "@/lib/agents/scheduler";

// ─── Helpers ──────────────────────────────────────────────────────────

function resetCaptures() {
  capturedInserts.length = 0;
}

function lastInsert() {
  return capturedInserts[capturedInserts.length - 1];
}

// ─── Theme selection ──────────────────────────────────────────────────

describe("queueThemeSelection", () => {
  beforeEach(() => {
    resetCaptures();
    mockDbSelect.mockReturnValue(makeSelectChain([])); // no recent themes
    mockInsertValues.mockImplementation((data) => {
      capturedInserts.push(data);
      return Promise.resolve(undefined);
    });
  });

  it("writes one ai_queue row", async () => {
    await queueThemeSelection();
    expect(capturedInserts).toHaveLength(1);
  });

  it("sets agentId to ai_theme_setter", async () => {
    await queueThemeSelection();
    expect(lastInsert().agentId).toBe("ai_theme_setter");
  });

  it("sets actionType to theme_select", async () => {
    await queueThemeSelection();
    expect(lastInsert().actionType).toBe("theme_select");
  });

  it("sets priority to 1 (critical)", async () => {
    await queueThemeSelection();
    expect(lastInsert().priority).toBe(1);
  });

  it("sets status to pending", async () => {
    await queueThemeSelection();
    expect(lastInsert().status).toBe("pending");
  });

  it("schedules for now (not deferred)", async () => {
    const before = Date.now();
    await queueThemeSelection();
    const after  = Date.now();
    const ts = (lastInsert().scheduledFor as Date).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after + 100);
  });

  it("includes recentThemes from DB in promptContext", async () => {
    mockDbSelect.mockReturnValue(
      makeSelectChain([{ theme: "AI safety" }, { theme: "Quantum" }])
    );
    resetCaptures();
    await queueThemeSelection();
    const ctx = lastInsert().promptContext as Record<string, unknown>;
    expect(ctx.recentThemes).toEqual(["AI safety", "Quantum"]);
  });
});

// ─── Daily ideas ──────────────────────────────────────────────────────

describe("queueDailyIdeas", () => {
  beforeEach(() => {
    resetCaptures();
    // Return a theme for context
    mockDbSelect.mockReturnValue(
      makeSelectChain([{
        date: "2026-04-25",
        theme: "Federated learning",
        rationale: "Privacy matters",
        researchNotes: { suggested_angles: ["medical", "finance"] },
      }])
    );
    mockInsertValues.mockImplementation((data) => {
      capturedInserts.push(data);
      return Promise.resolve(undefined);
    });
  });

  it("queues exactly 4 rows (one per participant)", async () => {
    await queueDailyIdeas();
    expect(capturedInserts).toHaveLength(4);
  });

  it("all rows have actionType post_idea", async () => {
    await queueDailyIdeas();
    for (const row of capturedInserts) {
      expect(row.actionType).toBe("post_idea");
    }
  });

  it("all rows have priority 7", async () => {
    await queueDailyIdeas();
    for (const row of capturedInserts) {
      expect(row.priority).toBe(7);
    }
  });

  it("rows target the 4 different participant agents", async () => {
    await queueDailyIdeas();
    const agentIds = capturedInserts.map((r) => r.agentId as string);
    expect(new Set(agentIds).size).toBe(4);
    expect(agentIds).toEqual(expect.arrayContaining(["ai_llama", "ai_gpt_oss", "ai_scout", "ai_maverick"]));
  });

  it("rows are spread across 0–9 min (scheduledFor increases)", async () => {
    await queueDailyIdeas();
    const timestamps = capturedInserts.map((r) => (r.scheduledFor as Date).getTime());
    // Each subsequent idea should be scheduled later (allow small jitter delta)
    expect(timestamps[1]).toBeGreaterThan(timestamps[0]);
    expect(timestamps[2]).toBeGreaterThan(timestamps[1]);
    expect(timestamps[3]).toBeGreaterThan(timestamps[2]);
  });

  it("promptContext carries the day's theme", async () => {
    await queueDailyIdeas();
    for (const row of capturedInserts) {
      const ctx = row.promptContext as Record<string, unknown>;
      expect(ctx.theme).toBe("Federated learning");
    }
  });
});

// ─── Comments on idea ─────────────────────────────────────────────────

describe("queueCommentsOnIdea", () => {
  const IDEA_ID  = "idea-uuid-123";
  const AUTHOR   = "ai_llama";

  beforeEach(() => {
    resetCaptures();
    mockDbSelect.mockReturnValue(
      makeSelectChain([{
        id:      IDEA_ID,
        title:   "Great idea title",
        context: "The pitch",
        content: "The full content",
        userId:  AUTHOR,
      }])
    );
    mockInsertValues.mockImplementation((data) => {
      capturedInserts.push(data);
      return Promise.resolve(undefined);
    });
  });

  it("queues exactly 3 rows (3 non-author commenters with 4 participants)", async () => {
    await queueCommentsOnIdea(IDEA_ID, AUTHOR);
    expect(capturedInserts).toHaveLength(3);
  });

  it("neither commenter is the original author", async () => {
    await queueCommentsOnIdea(IDEA_ID, AUTHOR);
    for (const row of capturedInserts) {
      expect(row.agentId).not.toBe(AUTHOR);
    }
  });

  it("sets actionType to comment", async () => {
    await queueCommentsOnIdea(IDEA_ID, AUTHOR);
    for (const row of capturedInserts) {
      expect(row.actionType).toBe("comment");
    }
  });

  it("sets priority to 6", async () => {
    await queueCommentsOnIdea(IDEA_ID, AUTHOR);
    for (const row of capturedInserts) {
      expect(row.priority).toBe(6);
    }
  });

  it("sets targetIdeaId to the idea's UUID", async () => {
    await queueCommentsOnIdea(IDEA_ID, AUTHOR);
    for (const row of capturedInserts) {
      expect(row.targetIdeaId).toBe(IDEA_ID);
    }
  });

  it("schedules in the 1–2 min window", async () => {
    await queueCommentsOnIdea(IDEA_ID, AUTHOR);
    const now = Date.now();
    for (const row of capturedInserts) {
      const delayMin = ((row.scheduledFor as Date).getTime() - now) / 60_000;
      expect(delayMin).toBeGreaterThanOrEqual(0.9);
      expect(delayMin).toBeLessThanOrEqual(2.1);
    }
  });
});


describe("queueQualityReview", () => {
  beforeEach(() => {
    resetCaptures();
    // idea lookup + theme lookup
    mockDbSelect
      .mockReturnValueOnce(makeSelectChain([{
        id: "post-uuid", title: "Title", context: "Pitch", content: "Content", userId: "ai_llama",
      }]))
      .mockReturnValueOnce(makeSelectChain([{ theme: "Open source AI" }]));
    mockInsertValues.mockImplementation((data) => {
      capturedInserts.push(data);
      return Promise.resolve(undefined);
    });
  });

  it("sets agentId to ai_quality_checker", async () => {
    await queueQualityReview("post-uuid", "idea");
    expect(lastInsert().agentId).toBe("ai_quality_checker");
  });

  it("sets actionType to quality_review", async () => {
    await queueQualityReview("post-uuid", "idea");
    expect(lastInsert().actionType).toBe("quality_review");
  });

  it("sets priority to 2", async () => {
    await queueQualityReview("post-uuid", "idea");
    expect(lastInsert().priority).toBe(2);
  });

  it("schedules within 30 seconds", async () => {
    const before = Date.now();
    await queueQualityReview("post-uuid", "idea");
    const ts = (lastInsert().scheduledFor as Date).getTime();
    expect(ts - before).toBeLessThanOrEqual(31_000);
  });
});

// ─── Daily archive ────────────────────────────────────────────────────

describe("queueDailyArchive", () => {
  beforeEach(() => {
    resetCaptures();
    mockDbSelect.mockReturnValue(makeSelectChain([{ theme: "Daily topic" }]));
    mockInsertValues.mockImplementation((data) => {
      capturedInserts.push(data);
      return Promise.resolve(undefined);
    });
  });

  it("queues one row", async () => {
    await queueDailyArchive();
    expect(capturedInserts).toHaveLength(1);
  });

  it("sets agentId to ai_archivist", async () => {
    await queueDailyArchive();
    expect(lastInsert().agentId).toBe("ai_archivist");
  });

  it("sets actionType to archive_day", async () => {
    await queueDailyArchive();
    expect(lastInsert().actionType).toBe("archive_day");
  });

  it("sets priority to 1", async () => {
    await queueDailyArchive();
    expect(lastInsert().priority).toBe(1);
  });

  it("schedules for now", async () => {
    const before = Date.now();
    await queueDailyArchive();
    const after  = Date.now();
    const ts = (lastInsert().scheduledFor as Date).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after + 100);
  });
});

// ─── Weekly rollup ────────────────────────────────────────────────────

describe("queueWeeklyRollup", () => {
  beforeEach(() => {
    resetCaptures();
    mockInsertValues.mockImplementation((data) => {
      capturedInserts.push(data);
      return Promise.resolve(undefined);
    });
  });

  it("queues one row with actionType='rollup_week' and agentId='ai_archivist'", async () => {
    await queueWeeklyRollup();
    expect(capturedInserts).toHaveLength(1);
    expect(lastInsert().actionType).toBe("rollup_week");
    expect(lastInsert().agentId).toBe("ai_archivist");
  });

  it("sets priority=1 and schedules for now", async () => {
    const before = Date.now();
    await queueWeeklyRollup();
    expect(lastInsert().priority).toBe(1);
    expect((lastInsert().scheduledFor as Date).getTime()).toBeGreaterThanOrEqual(before);
  });

  it("sets periodEnd to yesterday and periodStart to 7 days ago", async () => {
    const before = new Date();
    await queueWeeklyRollup();
    const ctx       = lastInsert().promptContext as Record<string, string>;
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const sevenAgo  = new Date();
    sevenAgo.setUTCDate(sevenAgo.getUTCDate() - 7);
    expect(ctx.periodEnd).toBe(yesterday.toISOString().slice(0, 10));
    expect(ctx.periodStart).toBe(sevenAgo.toISOString().slice(0, 10));
    void before;
  });
});

// ─── Monthly rollup ───────────────────────────────────────────────────

describe("queueMonthlyRollup", () => {
  beforeEach(() => {
    resetCaptures();
    mockInsertValues.mockImplementation((data) => {
      capturedInserts.push(data);
      return Promise.resolve(undefined);
    });
  });

  it("queues one row with actionType='rollup_month' and agentId='ai_archivist'", async () => {
    await queueMonthlyRollup();
    expect(capturedInserts).toHaveLength(1);
    expect(lastInsert().actionType).toBe("rollup_month");
    expect(lastInsert().agentId).toBe("ai_archivist");
  });

  it("sets period to the previous calendar month", async () => {
    await queueMonthlyRollup();
    const ctx = lastInsert().promptContext as Record<string, string>;
    const now = new Date();
    const expectedEnd   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
    const expectedStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    expect(ctx.periodEnd).toBe(expectedEnd.toISOString().slice(0, 10));
    expect(ctx.periodStart).toBe(expectedStart.toISOString().slice(0, 10));
  });
});

describe("queueMemoryReflection", () => {
  beforeEach(() => {
    resetCaptures();
    mockInsertValues.mockImplementation((data) => {
      capturedInserts.push(data);
      return Promise.resolve(undefined);
    });
  });

  it("queues one row with actionType=memory_reflect for the archivist", async () => {
    mockDbSelect.mockReturnValue(makeSelectChain([])); // no existing row today
    await queueMemoryReflection("2026-08-12");
    expect(capturedInserts).toHaveLength(1);
    expect(lastInsert().actionType).toBe("memory_reflect");
    expect(lastInsert().agentId).toBe("ai_archivist");
    expect((lastInsert().promptContext as Record<string, string>).date).toBe("2026-08-12");
  });

  it("is idempotent � skips when a memory_reflect row was already queued today", async () => {
    mockDbSelect.mockReturnValue(makeSelectChain([{ id: "existing" }]));
    await queueMemoryReflection("2026-08-12");
    expect(capturedInserts).toHaveLength(0);
  });
});
