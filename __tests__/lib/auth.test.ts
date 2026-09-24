import { vi, describe, it, expect, beforeEach } from "vitest";

// Mock next-auth at module level before importing
const mockAuth = vi.hoisted(() => vi.fn());

vi.mock("next-auth", () => ({
  default: vi.fn(() => ({
    handlers: {},
    auth: mockAuth,
    signIn: vi.fn(),
    signOut: vi.fn(),
  })),
}));

vi.mock("@auth/drizzle-adapter", () => ({
  DrizzleAdapter: vi.fn(() => ({})),
}));

vi.mock("@/db", () => ({
  db: { query: { users: { findFirst: vi.fn() } }, select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn() })) })), limit: vi.fn() })) },
}));

vi.mock("@/db/schema", () => ({
  users: {},
  accounts: {},
}));

vi.mock("next-auth/providers/google", () => ({
  default: vi.fn(() => ({})),
}));

vi.mock("next-auth/providers/github", () => ({
  default: vi.fn(() => ({})),
}));

vi.mock("next-auth/providers/credentials", () => ({
  default: vi.fn(() => ({})),
}));

vi.mock("bcryptjs", () => ({
  default: { compare: vi.fn() },
}));

// ─── Tests for auth helper functions ──────────────────────────────────
// We test the logic of isAdmin, requireAuth, getAuthenticatedUserId
// by importing the module and mocking auth().

describe("auth helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ADMIN_EMAILS = "admin@test.com,owner@test.com";
  });

  describe("isAdmin", () => {
    it("returns true when user email matches ADMIN_EMAILS", async () => {
      mockAuth.mockResolvedValueOnce({ user: { email: "admin@test.com" } });
      const { isAdmin } = await import("@/lib/auth");
      const result = await isAdmin();
      expect(result).toBe(true);
    }, 15_000);

    it("returns false when user email is not in ADMIN_EMAILS", async () => {
      mockAuth.mockResolvedValueOnce({ user: { email: "random@test.com" } });
      const { isAdmin } = await import("@/lib/auth");
      const result = await isAdmin();
      expect(result).toBe(false);
    });

    it("returns false when session is null (not logged in)", async () => {
      mockAuth.mockResolvedValueOnce(null);
      const { isAdmin } = await import("@/lib/auth");
      const result = await isAdmin();
      expect(result).toBe(false);
    });

    it("returns false when ADMIN_EMAILS env var is not set", async () => {
      delete process.env.ADMIN_EMAILS;
      mockAuth.mockResolvedValueOnce({ user: { email: "admin@test.com" } });
      const { isAdmin } = await import("@/lib/auth");
      const result = await isAdmin();
      expect(result).toBe(false);
    });

    it("is case-insensitive for email comparison", async () => {
      mockAuth.mockResolvedValueOnce({ user: { email: "Admin@Test.Com" } });
      const { isAdmin } = await import("@/lib/auth");
      const result = await isAdmin();
      expect(result).toBe(true);
    });
  });

  describe("getAuthenticatedUserId", () => {
    it("returns user id when session exists", async () => {
      mockAuth.mockResolvedValueOnce({ user: { id: "user-123" } });
      const { getAuthenticatedUserId } = await import("@/lib/auth");
      const result = await getAuthenticatedUserId();
      expect(result).toBe("user-123");
    });

    it("returns null when session is null", async () => {
      mockAuth.mockResolvedValueOnce(null);
      const { getAuthenticatedUserId } = await import("@/lib/auth");
      const result = await getAuthenticatedUserId();
      expect(result).toBeNull();
    });

    it("returns null when auth() throws", async () => {
      mockAuth.mockRejectedValueOnce(new Error("DB down"));
      const { getAuthenticatedUserId } = await import("@/lib/auth");
      const result = await getAuthenticatedUserId();
      expect(result).toBeNull();
    });
  });

  describe("requireAuth", () => {
    it("returns user id when authenticated", async () => {
      mockAuth.mockResolvedValueOnce({ user: { id: "user-456" } });
      const { requireAuth } = await import("@/lib/auth");
      const result = await requireAuth();
      expect(result).toBe("user-456");
    });

    it("throws when not authenticated", async () => {
      mockAuth.mockResolvedValueOnce(null);
      const { requireAuth } = await import("@/lib/auth");
      await expect(requireAuth()).rejects.toThrow("Authentication required");
    });
  });
});
