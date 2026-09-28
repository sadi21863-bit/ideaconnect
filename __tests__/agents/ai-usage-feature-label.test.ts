import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

describe("AI Lab usage budget labels", () => {
  it("labels every AI Lab usage insert with feature=ai_lab", () => {
    for (const file of sourceFiles("lib/agents")) {
      const source = readFileSync(file, "utf8");
      let index = source.indexOf("insert(aiUsage)");
      while (index !== -1) {
        const end = source.indexOf(".onConflictDoUpdate", index);
        const window = source.slice(index, end === -1 ? index + 600 : end);
        expect(window, `${file} @ ${index}`).toMatch(/\bfeature\b/);
        if (end !== -1) {
          const updateWindow = source.slice(end, end + 500);
          expect(updateWindow, `${file} @ ${index}`).toMatch(/\bfeature\b/);
        }
        index = source.indexOf("insert(aiUsage)", index + 1);
      }
    }
  });

  it("sums the budget by feature and current date", () => {
    const source = readFileSync("lib/agents/executor.ts", "utf8");
    expect(source).toContain("eq(aiUsage.feature, featureLabel)");
    expect(source).toContain("eq(aiUsage.date, today)");
  });
});
