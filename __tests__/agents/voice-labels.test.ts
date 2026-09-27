import { describe, expect, it } from "vitest";
import { restoreVoiceLabels } from "@/lib/agents/voice-labels";

describe("restoreVoiceLabels", () => {
  const mapping = new Map([
    ["Voice A", "llama"],
    ["Voice B", "scout"],
  ]);

  it("restores labels in narrative strings", () => {
    expect(restoreVoiceLabels("Voice A challenged Voice B.", mapping)).toBe("llama challenged scout.");
    expect(restoreVoiceLabels("@Voice A spoke", mapping)).toBe("@llama spoke");
  });

  it("restores labels in nested archive fields", () => {
    const value = {
      narrative: "Voice A opened.",
      quotes: [{ agent: "Voice A", text: "A claim" }],
      between: ["Voice A", "Voice B"],
      count: 2,
    };

    expect(restoreVoiceLabels(value, mapping)).toEqual({
      narrative: "llama opened.",
      quotes: [{ agent: "llama", text: "A claim" }],
      between: ["llama", "scout"],
      count: 2,
    });
  });

  it("leaves unknown labels untouched", () => {
    expect(restoreVoiceLabels("Voice Z remains", mapping)).toBe("Voice Z remains");
  });
});
