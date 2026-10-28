import { vi, describe, it, expect, beforeEach } from "vitest";

const mockCallGroq = vi.hoisted(() => vi.fn());

vi.mock("@/lib/agents/providers/groq", () => ({
  callGroq: mockCallGroq,
}));

import { callAgent } from "@/lib/agents/providers/index";
import type { Agent } from "@/lib/agents/personas";

// ─── Test fixtures ────────────────────────────────────────────────────

const groqAgent: Agent = {
  id:         "ai_llama",
  name:       "Llama",
  handle:     "llama",
  provider:   "groq",
  model:      "openai/gpt-oss-120b",
  role:       "participant",
  persona:    "You are Llama.",
  dailyLimit: 15,
  avatar:     "/agents/llama.png",
};

const gptOssAgent: Agent = {
  id:         "ai_gpt_oss",
  name:       "GPT-OSS",
  handle:     "gpt-oss",
  provider:   "groq",
  model:      "openai/gpt-oss-120b",
  role:       "participant",
  persona:    "You are GPT-OSS.",
  dailyLimit: 15,
  avatar:     "/agents/gpt-oss.png",
};

// ─── Groq primary ─────────────────────────────────────────────────────

describe("callAgent — Groq primary agents (success path)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls Groq and returns on success", async () => {
    mockCallGroq.mockResolvedValueOnce({ text: "groq response", totalTokens: 10 });

    const result = await callAgent(groqAgent, "What do you think?");

    expect(mockCallGroq).toHaveBeenCalledOnce();
    expect(mockCallGroq).toHaveBeenCalledWith(
      groqAgent.model,
      groqAgent.persona,
      "What do you think?",
      expect.anything()
    );
    expect(result).toBe("groq response");
  });

  it("passes jsonMode when model supports it", async () => {
    mockCallGroq.mockResolvedValueOnce({ text: '{"key":"value"}', totalTokens: 10 });

    await callAgent(groqAgent, "prompt", { jsonMode: true });

    expect(mockCallGroq).toHaveBeenCalledWith(
      groqAgent.model,
      groqAgent.persona,
      "prompt",
      expect.objectContaining({ jsonMode: true })
    );
  });

  it("strips thinking tags from response", async () => {
    mockCallGroq.mockResolvedValueOnce({ text: "<think>reasoning</think>The real answer.", totalTokens: 10 });

    const result = await callAgent(groqAgent, "prompt");
    expect(result).toBe("The real answer.");
  });

  it("uses GPTOSS_MIN_TOKENS floor for GPT-OSS models", async () => {
    mockCallGroq.mockResolvedValueOnce({ text: "response", totalTokens: 10 });

    await callAgent(gptOssAgent, "prompt");

    expect(mockCallGroq).toHaveBeenCalledWith(
      gptOssAgent.model,
      gptOssAgent.persona,
      "prompt",
      expect.objectContaining({ maxTokens: 2500 })
    );
  });
});

// ─── Groq fallback ────────────────────────────────────────────────────

describe("callAgent — Groq fallback on transient errors", () => {
  beforeEach(() => vi.clearAllMocks());

  it("falls back to Groq openai/gpt-oss-20b on 429 rate-limit error", async () => {
    const rateLimitErr = Object.assign(new Error("rate limit"), { status: 429 });
    mockCallGroq
      .mockRejectedValueOnce(rateLimitErr)
      .mockResolvedValueOnce({ text: "fallback answer", totalTokens: 10 });

    const result = await callAgent(groqAgent, "prompt");

    expect(mockCallGroq).toHaveBeenCalledTimes(2);
    expect(mockCallGroq).toHaveBeenNthCalledWith(
      2,
      "openai/gpt-oss-20b",
      groqAgent.persona,
      "prompt",
      // Carries the primary's resolved budget (GPTOSS floor 2500), not 600.
      expect.objectContaining({ maxTokens: 2500 })
    );
    expect(result).toBe("fallback answer");
  });

  it("falls back to Groq openai/gpt-oss-20b on 503 server error", async () => {
    const serverErr = Object.assign(new Error("service unavailable"), { status: 503 });
    mockCallGroq
      .mockRejectedValueOnce(serverErr)
      .mockResolvedValueOnce({ text: "fallback ok", totalTokens: 10 });

    const result = await callAgent(groqAgent, "prompt");

    expect(mockCallGroq).toHaveBeenCalledTimes(2);
    expect(mockCallGroq).toHaveBeenNthCalledWith(2,
      "openai/gpt-oss-20b",
      expect.any(String),
      "prompt",
      expect.objectContaining({ maxTokens: 2500 })
    );
    expect(result).toBe("fallback ok");
  });

  it("falls back on network timeout error (ETIMEDOUT in message)", async () => {
    const timeoutErr = new Error("ETIMEDOUT: connection timed out");
    mockCallGroq
      .mockRejectedValueOnce(timeoutErr)
      .mockResolvedValueOnce({ text: "ok", totalTokens: 10 });

    await callAgent(groqAgent, "prompt");

    expect(mockCallGroq).toHaveBeenCalledTimes(2);
    expect(mockCallGroq).toHaveBeenNthCalledWith(2,
      "openai/gpt-oss-20b",
      expect.any(String),
      "prompt",
      expect.objectContaining({ maxTokens: 2500 })
    );
  });

  it("carries an explicit caller budget (e.g. conductor 2000) to the fallback", async () => {
    const rateLimitErr = Object.assign(new Error("rate limit"), { status: 429 });
    mockCallGroq
      .mockRejectedValueOnce(rateLimitErr)
      .mockResolvedValueOnce({ text: "fallback answer", totalTokens: 10 });

    await callAgent(groqAgent, "prompt", { maxTokens: 2000 });

    expect(mockCallGroq).toHaveBeenNthCalledWith(
      2,
      "openai/gpt-oss-20b",
      groqAgent.persona,
      "prompt",
      expect.objectContaining({ maxTokens: 2000 })
    );
  });

  it("does NOT fall back on 401 auth error — propagates original error", async () => {
    const authErr = Object.assign(new Error("invalid api key"), { status: 401 });
    mockCallGroq.mockRejectedValueOnce(authErr);

    await expect(callAgent(groqAgent, "prompt")).rejects.toThrow("invalid api key");
    expect(mockCallGroq).toHaveBeenCalledOnce();
  });

  it("does NOT fall back on 400 bad request — propagates original error", async () => {
    const badReqErr = Object.assign(new Error("bad request"), { status: 400 });
    mockCallGroq.mockRejectedValueOnce(badReqErr);

    await expect(callAgent(groqAgent, "prompt")).rejects.toThrow("bad request");
    expect(mockCallGroq).toHaveBeenCalledOnce();
  });

  it("throws original error when fallback also fails", async () => {
    const rateLimitErr = Object.assign(new Error("rate limit"), { status: 429 });
    const fallbackErr  = Object.assign(new Error("fallback failed"), { status: 503 });
    mockCallGroq
      .mockRejectedValueOnce(rateLimitErr)
      .mockRejectedValueOnce(fallbackErr);

    await expect(callAgent(groqAgent, "prompt")).rejects.toThrow("rate limit");
    expect(mockCallGroq).toHaveBeenCalledTimes(2);
  });
});
