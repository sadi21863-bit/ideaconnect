export function restoreVoiceLabels<T>(value: T, voiceToHandle: Map<string, string>): T {
  const restoreString = (text: string): string => {
    let out = text;
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
