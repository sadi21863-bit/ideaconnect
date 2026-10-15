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
import { callGroq } from "@/lib/agents/providers/groq";

const MockedOpenAI = vi.mocked(OpenAI);

// Constructor is lazy — triggered on first callGroq invocation
describe("callGroq — client initialization", () => {
  it("creates the OpenAI client pointed at api.groq.com/openai/v1", async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: "ok" } }] });
    await callGroq("model", "sys", "usr");
    expect(MockedOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: "https://api.groq.com/openai/v1" })
    );
  });
});

describe("callGroq — requests", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends model, system message, and user message to chat.completions.create", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "hello from groq" } }],
      usage: { total_tokens: 42 },
    });

    const result = await callGroq("qwen/qwen3-32b", "You are helpful.", "Say hi");

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "qwen/qwen3-32b",
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user",   content: "Say hi" },
        ],
      }),
      expect.anything()
    );
    expect(result).toEqual({ text: "hello from groq", totalTokens: 42 });
  });

  it("defaults temperature to 0.8 and max_tokens to 600", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "ok" } }],
    });

    await callGroq("some-model", "system", "user");

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ temperature: 0.8, max_tokens: 600 }),
      expect.anything()
    );
  });

  it("respects custom temperature and maxTokens opts", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "ok" } }],
    });

    await callGroq("some-model", "system", "user", { temperature: 0.2, maxTokens: 200 });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ temperature: 0.2, max_tokens: 200 }),
      expect.anything()
    );
  });

  it("forwards reasoningEffort as Groq's reasoning_effort param", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "ok" } }],
    });

    await callGroq("openai/gpt-oss-20b", "sys", "usr", { reasoningEffort: "low" });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ reasoning_effort: "low" }),
      expect.anything()
    );
  });

  it("omits reasoning_effort when reasoningEffort is not set", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "ok" } }],
    });

    await callGroq("openai/gpt-oss-20b", "sys", "usr");

    const params = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(params).not.toHaveProperty("reasoning_effort");
  });

  it("returns empty string when content is null", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: null } }],
    });

    const result = await callGroq("model", "sys", "usr");
    expect(result).toEqual({ text: "", totalTokens: null });
  });

  it("throws a transient 502 error when the response has no choices", async () => {
    mockCreate.mockResolvedValueOnce({});

    await expect(callGroq("model", "sys", "usr")).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining("no choices"),
    });
  });

  it("propagates errors from the underlying OpenAI client", async () => {
    const rateLimitErr = Object.assign(new Error("rate limit exceeded"), { status: 429 });
    mockCreate.mockRejectedValueOnce(rateLimitErr);

    await expect(callGroq("model", "sys", "usr")).rejects.toThrow("rate limit exceeded");
  });

  it("attaches the failed_generation snippet to Groq JSON-validation errors", async () => {
    // Real Groq body shape (probed 2026-10-15): error = {message, type, code, failed_generation}
    const validationErr = Object.assign(new Error("400 Failed to validate JSON."), {
      status: 400,
      error: {
        message: "Failed to validate JSON.",
        type: "invalid_request_error",
        code: "json_validate_failed",
        failed_generation: '{"summary": "truncated mid-',
      },
    });
    mockCreate.mockRejectedValueOnce(validationErr);

    await expect(
      callGroq("openai/gpt-oss-20b", "sys", "usr", { jsonMode: true })
    ).rejects.toMatchObject({
      message: expect.stringContaining('failed_generation: {"summary": "truncated mid-'),
    });
  });

  it("does not append anything when failed_generation is an empty string", async () => {
    // Groq reports failed_generation: "" when validation kills an empty
    // generation (observed 2026-10-15) — the suffix must not be added.
    const validationErr = Object.assign(new Error("400 Failed to validate JSON."), {
      status: 400,
      error: { message: "Failed to validate JSON.", code: "json_validate_failed", failed_generation: "" },
    });
    mockCreate.mockRejectedValueOnce(validationErr);

    const caught = (await callGroq("openai/gpt-oss-20b", "sys", "usr").catch((e: unknown) => e)) as Error;
    expect(caught.message).toBe("400 Failed to validate JSON.");
    expect(caught.message).not.toContain("failed_generation:");
  });

  it("leaves errors without failed_generation untouched", async () => {
    const plainErr = Object.assign(new Error("some other 400"), { status: 400 });
    mockCreate.mockRejectedValueOnce(plainErr);

    await expect(callGroq("model", "sys", "usr")).rejects.toThrow("some other 400");
  });
});
