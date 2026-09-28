import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));

import { THEME_QUERY_BANK, getThemeQueryForDay } from "@/lib/agents/research";

describe("theme research rotation", () => {
  it("contains 14 distinct research domains", () => {
    expect(THEME_QUERY_BANK).toHaveLength(14);
    expect(new Set(THEME_QUERY_BANK).size).toBe(14);
  });

  it("does not repeat a domain inside a 14-day window", () => {
    const queries = Array.from({ length: 14 }, (_, offset) => getThemeQueryForDay(offset));
    expect(new Set(queries).size).toBe(14);
    expect(getThemeQueryForDay(14)).toBe(getThemeQueryForDay(0));
  });

  it("wraps negative day numbers deterministically", () => {
    expect(getThemeQueryForDay(-1)).toBe(THEME_QUERY_BANK[13]);
    expect(getThemeQueryForDay(-14)).toBe(THEME_QUERY_BANK[0]);
  });
});
