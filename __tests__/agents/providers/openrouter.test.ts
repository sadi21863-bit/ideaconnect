import { vi, describe, it, expect, beforeEach } from "vitest";

// vi.hoisted ensures mockCreate is available when the vi.mock factory runs (after hoisting)
const mockCreate = vi.hoisted(() => vi.fn());

vi.mock("openai", () => ({
  // Must be a regular function (not arrow) so `new OpenAI(...)` works as a constructor
  default: vi.fn(function (this: Record<string, unknown>, _config: unknown) {
    this.chat = { completions: { create: mockCreate } };
  }),
}));

import OpenAI from "openai";
import { callOpenRouter } from "@/lib/agents/providers/openrouter";

const MockedOpenAI = vi.mocked(OpenAI);

// Constructor is lazy — triggered on first callOpenRouter invocation
describe("callOpenRouter — client initialization", () => {
  it("creates the OpenAI client pointed at openrouter.ai/api/v1", async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: "ok" } }] });
    await callOpenRouter("model", "sys", "usr");
    expect(MockedOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: "https://openrouter.ai/api/v1" })
    );
  });
});

describe("callOpenRouter — requests", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns text and total tokens on success", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "hello from openrouter" } }],
      usage: { total_tokens: 77 },
    });

    const result = await callOpenRouter("nvidia/nemotron-3-super-120b-a12b:free", "sys", "usr");

    expect(result).toEqual({ text: "hello from openrouter", totalTokens: 77 });
  });

  it("throws a transient 502 error when the response has no choices", async () => {
    mockCreate.mockResolvedValueOnce({});

    await expect(callOpenRouter("model", "sys", "usr")).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining("no choices"),
    });
  });
});
