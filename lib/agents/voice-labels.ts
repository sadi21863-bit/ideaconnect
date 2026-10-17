export function restoreVoiceLabels<T>(value: T, voiceToHandle: Map<string, string>): T {
  const letterToHandle = new Map<string, string>();
  for (const [label, handle] of voiceToHandle) {
    const letter = label.trim().split(/\s+/).pop() ?? "";
    if (letter) letterToHandle.set(letter.toUpperCase(), handle);
  }
  const lookup = (letter: string): string | undefined => letterToHandle.get(letter.toUpperCase());

  const restoreString = (text: string): string => {
    let out = text;

    // Variant passes run BEFORE the exact legacy loop below: replacing "Voice A"
    // first would erase the prefix that "Voice A & B" needs to match.
    // "Voices A and B" / "Voice A & B" → "llama and scout"
    out = out.replace(/\bVoices?[\s_-]+([a-z])\s*(?:and|&)\s*([a-z])\b/gi, (m, a: string, b: string) => {
      const ha = lookup(a);
      const hb = lookup(b);
      return ha && hb ? `${ha} and ${hb}` : m;
    });

    // Separator forms anywhere: "voice_a", "voice-a", "voice A", "voices b".
    // Lowercase "voice a" / "voice i" with a plain-space separator is left alone:
    // that is ordinary English ("the voice a listener hears"), not a label.
    out = out.replace(/\bVoices?([\s_-]+)([a-z])\b/gi, (m, separator: string, letter: string) => {
      const isPlainSpace = !separator.includes("_") && !separator.includes("-");
      const ambiguous = letter === letter.toLowerCase() && (letter === "a" || letter === "i");
      if (isPlainSpace && ambiguous) return m;
      return lookup(letter) ?? m;
    });

    // Compact with explicit case: "VoiceA", "voiceB" (uppercase letter is never English).
    out = out.replace(/\bVoice([A-Z])\b/g, (m, letter: string) => lookup(letter) ?? m);

    // Whole-string compact labels: agent fields like "voicea"/"voiceC".
    // Anchored, so bare "voiced" inside prose can never match.
    out = out.replace(/^Voices?[_-]?([a-z])$/i, (m, letter: string) => lookup(letter) ?? m);

    // Exact legacy forms last (also covers non-letter labels like "Voice 9").
    for (const [label, handle] of voiceToHandle) {
      out = out.replaceAll(`@${label}`, `@${handle}`).replaceAll(label, handle);
    }

    return out;
  };

  const visit = (input: unknown): unknown => {
    if (typeof input === "string") return restoreString(input);
    if (Array.isArray(input)) return input.map(visit);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>).map(([key, nested]) => [key, visit(nested)])
      );
    }
    return input;
  };

  return visit(value) as T;
}
