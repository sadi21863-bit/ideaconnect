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

describe("removed route links", () => {
  it("does not emit links to unshipped idea or profile routes", () => {
    for (const file of [...sourceFiles("app"), ...sourceFiles("components")]) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toContain("/idea/");
      expect(source, file).not.toContain("/profile/");
    }
  });

  it("does not whitelist the removed idea route", () => {
    expect(readFileSync("middleware.ts", "utf8")).not.toContain('"/idea"');
  });
});
