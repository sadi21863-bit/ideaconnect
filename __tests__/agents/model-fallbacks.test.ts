import { describe, expect, it } from "vitest";
import { ALL_AGENTS } from "@/lib/agents/personas";

// Retirement-proofing guard rails. OpenRouter free variants disappear without
// notice (nano 2026-10-15, super-120b 2026-10-27), so every OpenRouter agent
// ships a priority-ordered `models` chain instead of a single hardcoded slug.
const openrouterAgents = ALL_AGENTS.filter((a) => a.provider === "openrouter");

describe("OpenRouter fallback chains", () => {
  it("covers every OpenRouter agent", () => {
    expect(openrouterAgents.map((a) => a.handle).sort()).toEqual(
      ["conductor", "research", "scout"]
    );
    for (const agent of openrouterAgents) {
      expect(agent.fallbackModels?.length, `${agent.handle} has no fallbacks`).toBeGreaterThan(0);
    }
  });

  it("keeps every entry free and unique", () => {
    for (const agent of openrouterAgents) {
      const chain = [agent.model, ...(agent.fallbackModels ?? [])];
      expect(new Set(chain).size, `${agent.handle} has duplicate slugs`).toBe(chain.length);
      for (const slug of chain) {
        const free = slug.endsWith(":free") || slug === "openrouter/free";
        expect(free, `${agent.handle} fallback ${slug} is not free`).toBe(true);
      }
    }
  });

  it("never trusts the random free router as a primary", () => {
    for (const agent of openrouterAgents) {
      expect(agent.model).not.toBe("openrouter/free");
      // Last resort only: it scored 6/16 usable on our real prompts
      // (content-safety classifier, 2.6B model, empty 200s).
      expect(agent.fallbackModels?.at(-1)).toBe("openrouter/free");
    }
  });

  it("respects OpenRouter's 3-entry `models` cap", () => {
    for (const agent of openrouterAgents) {
      const chain = [agent.model, ...(agent.fallbackModels ?? [])];
      expect(chain.length, `${agent.handle} has ${chain.length} entries`).toBeLessThanOrEqual(3);
    }
  });

  it("keeps Groq agents on Groq (fallbacks are OpenRouter-only)", () => {
    for (const agent of ALL_AGENTS.filter((a) => a.provider !== "openrouter")) {
      expect(agent.fallbackModels, `${agent.handle}`).toBeUndefined();
    }
  });
});
