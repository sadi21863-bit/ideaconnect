import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Mocks ──────────────────────────────────────────────────────────────

function thenableChain(result: unknown) {
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
const mockDbInsert = vi.hoisted(() =>
  vi.fn().mockImplementation((_table: unknown) => ({
    values: (data: Record<string, unknown>) => {
      capturedInserts.push({ data });
      return {
        returning: vi.fn().mockResolvedValue([{ id: "new-row-id" }]),
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      };
    },
  }))
);

vi.mock("@/db", () => ({
  db: { select: mockDbSelect, insert: mockDbInsert },
}));

const mockCallAgent = vi.hoisted(() => vi.fn());
vi.mock("@/lib/agents/providers/index", () => ({
  callAgent: mockCallAgent,
}));

import {
  getRelevantMemories,
  formatMemoryBlock,
  executeMemoryReflection,
} from "@/lib/agents/handlers/memory";
import { ALL_AGENTS } from "@/lib/agents/personas";

function daysAgoStr(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function memRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "mem-1",
    text: "default memory text",
    kind: "observation",
    day: daysAgoStr(1),
    importance: 1,
    ...overrides,
  };
}

const archivist = ALL_AGENTS.find((a) => a.role === "archivist")!;

function reflectItem(date: string) {
  return {
    id: "queue-1",
    agentId: "ai_archivist",
    actionType: "memory_reflect",
    promptContext: { date },
  } as never;
}

// ─── getRelevantMemories ────────────────────────────────────────────────

describe("getRelevantMemories", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns [] for an empty query", async () => {
    mockDbSelect.mockReturnValue(thenableChain([memRow()]));
    const out = await getRelevantMemories("ai_llama", "   ");
    expect(out).toEqual([]);
  });

  it("returns [] when nothing overlaps", async () => {
    mockDbSelect.mockReturnValue(
      thenableChain([memRow({ text: "I debated quantum tunneling effects" })])
    );
    const out = await getRelevantMemories("ai_llama", "federated learning privacy budgets");
    expect(out).toEqual([]);
  });

  it("ranks higher keyword overlap first", async () => {
    mockDbSelect.mockReturnValue(
      thenableChain([
        memRow({ id: "weak", text: "I argued about learning rates today", day: daysAgoStr(0) }),
        memRow({ id: "strong", text: "I clashed over federated learning privacy budgets", day: daysAgoStr(0) }),
      ])
    );
    const out = await getRelevantMemories("ai_llama", "federated learning privacy budgets");
    expect(out.map((m) => m.id)).toEqual(["strong", "weak"]);
  });

  it("breaks overlap ties by recency", async () => {
    mockDbSelect.mockReturnValue(
      thenableChain([
        memRow({ id: "old", text: "federated learning debate notes", day: daysAgoStr(10) }),
        memRow({ id: "new", text: "federated learning debate notes", day: daysAgoStr(0) }),
      ])
    );
    const out = await getRelevantMemories("ai_llama", "federated learning debate");
    expect(out[0].id).toBe("new");
  });

  it("boosts reflections over same-day observations", async () => {
    mockDbSelect.mockReturnValue(
      thenableChain([
        memRow({ id: "obs", kind: "observation", text: "federated learning exchange", day: daysAgoStr(2), importance: 1 }),
        memRow({ id: "ref", kind: "reflection", text: "federated learning exchange", day: daysAgoStr(2), importance: 2 }),
      ])
    );
    const out = await getRelevantMemories("ai_llama", "federated learning exchange");
    expect(out[0].id).toBe("ref");
  });

  it("respects the limit", async () => {
    const rows = Array.from({ length: 8 }, (_, i) =>
      memRow({ id: `m${i}`, text: "federated learning privacy budgets debate", day: daysAgoStr(0) })
    );
    mockDbSelect.mockReturnValue(thenableChain(rows));
    const out = await getRelevantMemories("ai_llama", "federated learning privacy", 3);
    expect(out).toHaveLength(3);
  });
});

// ─── formatMemoryBlock ──────────────────────────────────────────────────

describe("formatMemoryBlock", () => {
  it("returns empty string for no memories", () => {
    expect(formatMemoryBlock([])).toBe("");
  });

  it("renders day, kind, and text lines under a header", () => {
    const block = formatMemoryBlock([
      { id: "1", text: "I lost to scout", kind: "observation", day: "2026-08-10", score: 3 },
    ]);
    expect(block).toContain("THINGS YOU REMEMBER");
    expect(block).toContain("[2026-08-10 observation]");
    expect(block).toContain("I lost to scout");
  });
});

// ─── executeMemoryReflection ────────────────────────────────────────────

const IDEA = {
  id: "idea-1",
  title: "Federated learning",
  content: "Federate everything",
  context: null,
  userId: "ai_llama",
};
const COMMENT = { ideaId: "idea-1", userId: "ai_llama", content: "Strong take on federation" };

describe("executeMemoryReflection", () => {
  beforeEach(() => {
    capturedInserts.length = 0;
    vi.clearAllMocks();
    // Wipe the persistent mockReturnValue set by the retrieval tests above so
    // each test below is hermetic — only its own once-chains can be consumed.
    mockDbSelect.mockReset();
    mockCallAgent.mockResolvedValue("I took a strong stance on federation today.");
  });

  it("writes one observation for an agent with content (Wednesday — no reflection)", async () => {
    mockDbSelect
      .mockReturnValueOnce(thenableChain([IDEA]))     // today's ideas
      .mockReturnValueOnce(thenableChain([COMMENT]))  // comments on them
      .mockReturnValueOnce(thenableChain([]));        // no existing observation
    await executeMemoryReflection(archivist, reflectItem("2026-08-12"), "2026-08-12");

    const memInserts = capturedInserts.filter((r) => r.data.kind === "observation");
    expect(memInserts).toHaveLength(1);
    expect(memInserts[0].data.agentId).toBe("ai_llama");
    expect(memInserts[0].data.day).toBe("2026-08-12");
    expect(mockCallAgent).toHaveBeenCalledTimes(1);
  });

  it("writes nothing when no agent posted or commented", async () => {
    mockDbSelect
      .mockReturnValueOnce(thenableChain([]))  // no ideas
      .mockReturnValueOnce(thenableChain([])); // no comments
    await executeMemoryReflection(archivist, reflectItem("2026-08-12"), "2026-08-12");

    const memInserts = capturedInserts.filter((r) => r.data.kind === "observation" || r.data.kind === "reflection");
    expect(memInserts).toHaveLength(0);
    expect(mockCallAgent).not.toHaveBeenCalled();
  });

  it("is idempotent — skips agents that already have an observation for the day", async () => {
    mockDbSelect
      .mockReturnValueOnce(thenableChain([IDEA]))
      .mockReturnValueOnce(thenableChain([COMMENT]))
      .mockReturnValueOnce(thenableChain([{ id: "existing" }])); // already exists
    await executeMemoryReflection(archivist, reflectItem("2026-08-12"), "2026-08-12");

    const memInserts = capturedInserts.filter((r) => r.data.kind === "observation" || r.data.kind === "reflection");
    expect(memInserts).toHaveLength(0);
    expect(mockCallAgent).not.toHaveBeenCalled();
  });

  it("writes a weekly reflection on Sundays from the week's observations", async () => {
    mockDbSelect
      .mockReturnValueOnce(thenableChain([IDEA]))
      .mockReturnValueOnce(thenableChain([COMMENT]))
      .mockReturnValueOnce(thenableChain([]))  // no existing observation
      .mockReturnValueOnce(thenableChain([]))  // no existing reflection
      .mockReturnValueOnce(                       // week's observations
        thenableChain([
          { text: "Monday note", day: "2026-08-03" },
          { text: "Friday note", day: "2026-08-07" },
        ])
      );
    await executeMemoryReflection(archivist, reflectItem("2026-08-09"), "2026-08-09");

    const obs = capturedInserts.filter((r) => r.data.kind === "observation");
    const refs = capturedInserts.filter((r) => r.data.kind === "reflection");
    expect(obs).toHaveLength(1);
    expect(refs).toHaveLength(1);
    expect(refs[0].data.importance).toBe(2);
    expect(refs[0].data.ideaId).toBeNull();
    expect(mockCallAgent).toHaveBeenCalledTimes(2);
  });
});
