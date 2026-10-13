import { vi, describe, it, expect, beforeEach } from "vitest";

const capturedInserts: Array<{ data: Record<string, unknown> }> = [];
const mockDbInsert = vi.hoisted(() =>
  vi.fn().mockImplementation(() => ({
    values: (data: Record<string, unknown>) => {
      capturedInserts.push({ data });
      const chain = Promise.resolve() as Promise<void> & Record<string, unknown>;
      chain.onConflictDoUpdate = () => Promise.resolve();
      return chain;
    },
  }))
);

vi.mock("@/db", () => ({ db: { insert: mockDbInsert } }));

const mockCallGroq = vi.hoisted(() => vi.fn());
vi.mock("@/lib/agents/providers/groq", () => ({ callGroq: mockCallGroq }));

import { shouldFetchResearch } from "@/lib/agents/handlers/shared";

describe("shouldFetchResearch usage accounting", () => {
  beforeEach(() => {
    capturedInserts.length = 0;
    vi.clearAllMocks();
  });

  it("records triage tokens against the calling agent", async () => {
    mockCallGroq.mockResolvedValueOnce({
      text: JSON.stringify({ needsResearch: false, query: null }),
      totalTokens: 17,
    });

    await shouldFetchResearch("A proposal", "A theme", "comment", "ai_llama");

    expect(capturedInserts).toHaveLength(1);
    expect(capturedInserts[0].data).toMatchObject({
      agentId: "ai_llama",
      feature: "ai_lab",
      tokens: 17,
    });
  });

  it("does not write usage when no agent is supplied", async () => {
    mockCallGroq.mockResolvedValueOnce({
      text: JSON.stringify({ needsResearch: true, query: "current data" }),
      totalTokens: 11,
    });

    await shouldFetchResearch("A proposal", "A theme", "comment");

    expect(capturedInserts).toHaveLength(0);
  });
});