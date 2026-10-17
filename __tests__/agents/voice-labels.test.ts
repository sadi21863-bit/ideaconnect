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

  it("restores compact labels (whole-string agent fields)", () => {
    expect(restoreVoiceLabels("voicea", mapping)).toBe("llama");
    expect(restoreVoiceLabels("voiceB", mapping)).toBe("scout");
    expect(
      restoreVoiceLabels({ quotes: [{ agent: "voicea", text: "x" }] }, mapping)
    ).toEqual({ quotes: [{ agent: "llama", text: "x" }] });
  });

  it("restores compact uppercase labels mid-prose", () => {
    expect(restoreVoiceLabels("VoiceA challenged VoiceB.", mapping)).toBe("llama challenged scout.");
  });

  it("restores separator variants (_ - and space)", () => {
    expect(restoreVoiceLabels("voice_a said so", mapping)).toBe("llama said so");
    expect(restoreVoiceLabels("voices-b pushed back", mapping)).toBe("scout pushed back");
    expect(restoreVoiceLabels("voice A opened", mapping)).toBe("llama opened");
  });

  it("restores plural conjunctions", () => {
    expect(restoreVoiceLabels("Voices A and B clashed.", mapping)).toBe("llama and scout clashed.");
    expect(restoreVoiceLabels("Voice A & B agreed.", mapping)).toBe("llama and scout agreed.");
    expect(restoreVoiceLabels("voices a and b clashed.", mapping)).toBe("llama and scout clashed.");
  });

  it("never touches ordinary English near-collisions", () => {
    expect(restoreVoiceLabels("voiced a concern", mapping)).toBe("voiced a concern");
    expect(restoreVoiceLabels("the voice a listener hears", mapping)).toBe("the voice a listener hears");
    expect(restoreVoiceLabels("invoices were paid", mapping)).toBe("invoices were paid");
    expect(restoreVoiceLabels("voices of dissent grew", mapping)).toBe("voices of dissent grew");
  });
});
