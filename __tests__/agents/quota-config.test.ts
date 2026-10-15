import { afterEach, describe, expect, it, vi } from "vitest";

const originalLimit = process.env.GROQ_DAILY_TPD_LIMIT;

afterEach(() => {
  vi.resetModules();
  if (originalLimit === undefined) delete process.env.GROQ_DAILY_TPD_LIMIT;
  else process.env.GROQ_DAILY_TPD_LIMIT = originalLimit;
});

describe("AI Lab quota configuration", () => {
  it("defaults to Groq's 200k free-plan TPD", async () => {
    delete process.env.GROQ_DAILY_TPD_LIMIT;
    vi.resetModules();
    const { QUOTA_CONFIG } = await import("@/lib/config");

    expect(QUOTA_CONFIG.DAILY_TPD_LIMIT).toBe(200_000);
    expect(Math.floor(QUOTA_CONFIG.DAILY_TPD_LIMIT * QUOTA_CONFIG.AI_LAB_BUDGET_FRACTION)).toBe(130_000);
  });

  it.each(["not-a-number", "0", "-1", "12.5"])(
    "falls back to the default for invalid override %s",
    async (value) => {
      process.env.GROQ_DAILY_TPD_LIMIT = value;
      vi.resetModules();
      const { QUOTA_CONFIG } = await import("@/lib/config");

      expect(QUOTA_CONFIG.DAILY_TPD_LIMIT).toBe(200_000);
    }
  );

  it("honors an explicit dashboard override", async () => {
    process.env.GROQ_DAILY_TPD_LIMIT = "123456";
    vi.resetModules();
    const { QUOTA_CONFIG } = await import("@/lib/config");

    expect(QUOTA_CONFIG.DAILY_TPD_LIMIT).toBe(123_456);
  });
});