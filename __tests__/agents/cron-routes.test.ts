import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// Mock executor and scheduler before importing routes
const mockProcessQueue           = vi.hoisted(() => vi.fn().mockResolvedValue({ processed: 1, failed: 0 }));
const mockResetStuckQueueItems   = vi.hoisted(() => vi.fn().mockResolvedValue(0));
const mockQueueThemeSelection = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockQueueDailyIdeas     = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockQueueDailyArchive   = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockQueueWeeklyRollup   = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockQueueMonthlyRollup  = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockQueueMemoryReflection = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("@/lib/agents/executor", () => ({
  processQueue:          mockProcessQueue,
  resetStuckQueueItems:  mockResetStuckQueueItems,
}));

vi.mock("@/lib/agents/scheduler", () => ({
  queueThemeSelection: mockQueueThemeSelection,
  queueDailyIdeas:     mockQueueDailyIdeas,
  queueDailyArchive:   mockQueueDailyArchive,
  queueWeeklyRollup:   mockQueueWeeklyRollup,
  queueMonthlyRollup:  mockQueueMonthlyRollup,
  queueMemoryReflection: mockQueueMemoryReflection,
}));

import { GET  as tickGET }          from "@/app/api/cron/agents/tick/route";
import { GET  as themeGET }         from "@/app/api/cron/agents/theme/route";
import { GET  as seedIdeasGET }     from "@/app/api/cron/agents/seed-ideas/route";
import { GET  as archiveGET }       from "@/app/api/cron/agents/archive/route";
import { GET  as rollupWeeklyGET }  from "@/app/api/cron/agents/rollup-weekly/route";
import { GET  as rollupMonthlyGET } from "@/app/api/cron/agents/rollup-monthly/route";
import { GET  as catchupGET }       from "@/app/api/cron/agents/catchup/route";
import { GET  as memoryReflectGET } from "@/app/api/cron/agents/memory-reflect/route";

// ─── Test helpers ─────────────────────────────────────────────────────

const VALID_SECRET = "test-cron-secret-123";

function makeReq(authHeader?: string): Request {
  const headers: Record<string, string> = {};
  if (authHeader !== undefined) headers["authorization"] = authHeader;
  return new Request("http://localhost/api/cron/test", { headers });
}

// ─── Setup / teardown ─────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET     = VALID_SECRET;
  process.env.AI_LAB_ENABLED  = "true";
});

afterEach(() => {
  delete process.env.CRON_SECRET;
  delete process.env.AI_LAB_ENABLED;
});

// ─── Auth guard (applies to all routes) ──────────────────────────────

describe("cron auth guard", () => {
  it("returns 401 when Authorization header is missing", async () => {
    const res = await tickGET(makeReq());
    expect(res.status).toBe(401);
  });

  it("returns 401 when secret is wrong", async () => {
    const res = await tickGET(makeReq("Bearer wrong-secret"));
    expect(res.status).toBe(401);
  });

  it("returns 401 when Bearer prefix is omitted", async () => {
    const res = await tickGET(makeReq(VALID_SECRET));
    expect(res.status).toBe(401);
  });

  it("returns 503 when AI_LAB_ENABLED is not 'true'", async () => {
    process.env.AI_LAB_ENABLED = "false";
    const res = await tickGET(makeReq(`Bearer ${VALID_SECRET}`));
    expect(res.status).toBe(503);
  });

  it("returns 503 when AI_LAB_ENABLED is missing entirely", async () => {
    delete process.env.AI_LAB_ENABLED;
    const res = await tickGET(makeReq(`Bearer ${VALID_SECRET}`));
    expect(res.status).toBe(503);
  });
});

// ─── /api/cron/agents/tick ────────────────────────────────────────────

describe("GET /api/cron/agents/tick", () => {
  const auth = () => makeReq(`Bearer ${VALID_SECRET}`);

  it("returns 200 with success=true", async () => {
    const res = await tickGET(auth());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it("calls processQueue(5)", async () => {
    await tickGET(auth());
    expect(mockProcessQueue).toHaveBeenCalledWith(5);
  });

  it("includes processed/failed counts in response", async () => {
    mockProcessQueue.mockResolvedValueOnce({ processed: 3, failed: 1 });
    const res = await tickGET(auth());
    const body = await res.json();
    expect(body.processed).toBe(3);
    expect(body.failed).toBe(1);
  });

  it("returns 500 when processQueue throws", async () => {
    mockProcessQueue.mockRejectedValueOnce(new Error("DB unavailable"));
    const res = await tickGET(auth());
    expect(res.status).toBe(500);
  });
});

// ─── /api/cron/agents/theme ───────────────────────────────────────────

describe("GET /api/cron/agents/theme", () => {
  const auth = () => makeReq(`Bearer ${VALID_SECRET}`);

  it("returns 200 with success=true and queued field", async () => {
    const res = await themeGET(auth());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.queued).toBe("theme_select");
  });

  it("calls queueThemeSelection then processQueue(2)", async () => {
    await themeGET(auth());
    expect(mockQueueThemeSelection).toHaveBeenCalledOnce();
    expect(mockProcessQueue).toHaveBeenCalledWith(2);
  });

  it("returns 500 when queueThemeSelection throws", async () => {
    mockQueueThemeSelection.mockRejectedValueOnce(new Error("DB error"));
    const res = await themeGET(auth());
    expect(res.status).toBe(500);
  });

  it("returns 200 with processingError when processQueue throws after queuing", async () => {
    mockProcessQueue.mockRejectedValueOnce(new Error("LLM unavailable"));
    const res = await themeGET(auth());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.processingError).toBeDefined();
  });
});

// ─── /api/cron/agents/seed-ideas ─────────────────────────────────────

describe("GET /api/cron/agents/seed-ideas", () => {
  const auth = () => makeReq(`Bearer ${VALID_SECRET}`);

  it("returns 200 with success=true and count=3", async () => {
    const res = await seedIdeasGET(auth());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.count).toBe(3);
  });

  it("calls queueDailyIdeas then processQueue(5)", async () => {
    await seedIdeasGET(auth());
    expect(mockQueueDailyIdeas).toHaveBeenCalledOnce();
    expect(mockProcessQueue).toHaveBeenCalledWith(5);
  });
});

// ─── /api/cron/agents/archive ─────────────────────────────────────────

describe("GET /api/cron/agents/archive", () => {
  const auth = () => makeReq(`Bearer ${VALID_SECRET}`);

  it("returns 200 with success=true", async () => {
    const res = await archiveGET(auth());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.queued).toBe("archive_day");
  });

  it("calls queueDailyArchive then processQueue(2)", async () => {
    await archiveGET(auth());
    expect(mockQueueDailyArchive).toHaveBeenCalledOnce();
    expect(mockProcessQueue).toHaveBeenCalledWith(2);
  });
});

// ─── /api/cron/agents/rollup-weekly ──────────────────────────────────

describe("GET /api/cron/agents/rollup-weekly", () => {
  const auth = () => makeReq(`Bearer ${VALID_SECRET}`);

  it("returns 200 with success=true and queued='rollup_week'", async () => {
    const res  = await rollupWeeklyGET(auth());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.queued).toBe("rollup_week");
  });

  it("calls queueWeeklyRollup then processQueue(2)", async () => {
    await rollupWeeklyGET(auth());
    expect(mockQueueWeeklyRollup).toHaveBeenCalledOnce();
    expect(mockProcessQueue).toHaveBeenCalledWith(2);
  });

  it("returns 500 when queueWeeklyRollup throws", async () => {
    mockQueueWeeklyRollup.mockRejectedValueOnce(new Error("DB error"));
    const res = await rollupWeeklyGET(auth());
    expect(res.status).toBe(500);
  });
});

// ─── /api/cron/agents/rollup-monthly ─────────────────────────────────

describe("GET /api/cron/agents/rollup-monthly", () => {
  const auth = () => makeReq(`Bearer ${VALID_SECRET}`);

  it("returns 200 with success=true and queued='rollup_month'", async () => {
    const res  = await rollupMonthlyGET(auth());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.queued).toBe("rollup_month");
  });

  it("calls queueMonthlyRollup then processQueue(2)", async () => {
    await rollupMonthlyGET(auth());
    expect(mockQueueMonthlyRollup).toHaveBeenCalledOnce();
    expect(mockProcessQueue).toHaveBeenCalledWith(2);
  });

  it("returns 500 when queueMonthlyRollup throws", async () => {
    mockQueueMonthlyRollup.mockRejectedValueOnce(new Error("DB error"));
    const res = await rollupMonthlyGET(auth());
    expect(res.status).toBe(500);
  });
});

// ─── /api/cron/agents/memory-reflect ──────────────────────────────────

describe("GET /api/cron/agents/memory-reflect", () => {
  const auth = () => makeReq(`Bearer ${VALID_SECRET}`);

  it("returns 200 with success=true and queued='memory_reflect'", async () => {
    const res  = await memoryReflectGET(auth());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.queued).toBe("memory_reflect");
  });

  it("calls queueMemoryReflection then processQueue(2)", async () => {
    await memoryReflectGET(auth());
    expect(mockQueueMemoryReflection).toHaveBeenCalledOnce();
    expect(mockProcessQueue).toHaveBeenCalledWith(2);
  });

  it("returns 500 when queueMemoryReflection throws", async () => {
    mockQueueMemoryReflection.mockRejectedValueOnce(new Error("DB error"));
    const res = await memoryReflectGET(auth());
    expect(res.status).toBe(500);
  });
});

// ─── /api/cron/agents/catchup ─────────────────────────────────────────

describe("GET /api/cron/agents/catchup", () => {
  const auth = () => makeReq(`Bearer ${VALID_SECRET}`);

  it("returns 401 when Authorization header is missing", async () => {
    const res = await catchupGET(makeReq());
    expect(res.status).toBe(401);
  });

  it("returns 503 when AI_LAB_ENABLED is not 'true'", async () => {
    process.env.AI_LAB_ENABLED = "false";
    const res = await catchupGET(auth());
    expect(res.status).toBe(503);
    process.env.AI_LAB_ENABLED = "true";
  });

  it("returns 200 with processed count when authorized", async () => {
    mockProcessQueue.mockResolvedValueOnce({ processed: 4, failed: 1 });
    const res = await catchupGET(auth());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.processed).toEqual({ processed: 4, failed: 1 });
  });

  it("calls processQueue(20)", async () => {
    await catchupGET(auth());
    expect(mockProcessQueue).toHaveBeenCalledWith(20);
  });

  it("calls resetStuckQueueItems before processQueue", async () => {
    const order: string[] = [];
    mockResetStuckQueueItems.mockImplementationOnce(async () => { order.push("reset"); return 0; });
    mockProcessQueue.mockImplementationOnce(async () => { order.push("process"); return { processed: 0, failed: 0 }; });
    await catchupGET(auth());
    expect(order).toEqual(["reset", "process"]);
  });

  it("includes recovered count in response", async () => {
    mockResetStuckQueueItems.mockResolvedValueOnce(3);
    const res  = await catchupGET(auth());
    const body = await res.json();
    expect(body.recovered).toBe(3);
  });
});
