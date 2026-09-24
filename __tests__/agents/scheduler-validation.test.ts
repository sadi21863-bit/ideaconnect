import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── DB mock — same pattern as scheduler.test.ts ─────────────────────
const capturedInserts: Array<Record<string, unknown>> = [];

const mockInsertValues = vi.hoisted(() =>
  vi.fn().mockImplementation((data: Record<string, unknown>) => {
    capturedInserts.push(data);
    return Promise.resolve(undefined);
  })
);

const mockInsertOnConflict = vi.hoisted(() =>
  vi.fn().mockReturnValue(Promise.resolve(undefined))
);

const mockDbInsert = vi.hoisted(() =>
  vi.fn().mockReturnValue({
    values: vi.fn().mockReturnValue({
      onConflictDoNothing: mockInsertOnConflict,
    }),
  })
);

function makeSelectChain(result: unknown = []) {
  const chain: Record<string, unknown> = {};
  chain.from    = () => chain;
  chain.where   = () => chain;
  chain.orderBy = () => chain;
  chain.limit   = () => Promise.resolve(result);
  return chain;
}

const mockDbSelect = vi.hoisted(() => vi.fn());

vi.mock("@/db", () => ({
  db: {
    select: mockDbSelect,
    insert: mockDbInsert,
  },
}));

vi.mock("@/db/schema", () => ({
  aiQueue: {}, aiThemes: {}, ideas: {}, ideaComments: {}, searchCache: {},
}));

function resetCaptures() {
  capturedInserts.length = 0;
  mockDbInsert.mockReturnValue({ values: mockInsertValues });
  mockInsertValues.mockImplementation((data: Record<string, unknown>) => {
    capturedInserts.push(data);
    return Promise.resolve(undefined);
  });
}

function lastInsert() {
  return capturedInserts[capturedInserts.length - 1];
}

// ─── Tests ────────────────────────────────────────────────────────────

describe("promptContext Zod validation — bad date in queueThemeResearch", () => {
  beforeEach(() => {
    resetCaptures();
    // No existing cache entry → function proceeds to validation
    mockDbSelect.mockReturnValue(makeSelectChain([]));
  });

  it("logs console.error and skips insert for a malformed date", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { queueThemeResearch } = await import("@/lib/agents/scheduler");

    await queueThemeResearch("not-a-date");

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[scheduler] Invalid promptContext for themeresearch:"),
      expect.anything()
    );
    expect(capturedInserts).toHaveLength(0);
    consoleSpy.mockRestore();
  }, 15_000);

  it("does NOT log a validation error for a valid date", async () => {
    // queueThemeResearch ends with .onConflictDoNothing() — wire the chain
    const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn().mockReturnValue({ onConflictDoNothing });
    mockDbInsert.mockReturnValue({ values });

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { queueThemeResearch } = await import("@/lib/agents/scheduler");

    await queueThemeResearch("2026-05-11");

    expect(consoleSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("[scheduler] Invalid promptContext for themeresearch:"),
      expect.anything()
    );
    consoleSpy.mockRestore();
  });
});


describe("promptContext Zod validation — bad date in queueDailyArchive", () => {
  beforeEach(() => {
    resetCaptures();
    mockDbSelect.mockReturnValue(makeSelectChain([{ theme: "Test theme" }]));
  });

  it("logs console.error and skips insert for a malformed archive date", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { queueDailyArchive } = await import("@/lib/agents/scheduler");

    // Force a bad date by monkey-patching — call with a non-YYYY-MM-DD string
    await queueDailyArchive("2026/05/11"); // slashes not accepted

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[scheduler] Invalid promptContext for archive_day:"),
      expect.anything()
    );
    expect(capturedInserts).toHaveLength(0);
    consoleSpy.mockRestore();
  });

  it("writes one row for a valid archive date", async () => {
    const { queueDailyArchive } = await import("@/lib/agents/scheduler");

    await queueDailyArchive("2026-05-11");

    expect(capturedInserts).toHaveLength(1);
    expect(lastInsert().actionType).toBe("archive_day");
  });
});
