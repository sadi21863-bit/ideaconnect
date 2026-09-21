-- Migration 0018: Agent memory stream (M1).
-- Per-agent nightly observations + weekly reflections. Retrieved at
-- prompt-build time by keyword overlap x recency (see
-- lib/agents/handlers/memory.ts getRelevantMemories).

CREATE TABLE IF NOT EXISTS "agent_memories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "agent_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "text" text NOT NULL,
  "idea_id" uuid REFERENCES "ideas"("id") ON DELETE SET NULL,
  "day" date NOT NULL,
  "importance" integer NOT NULL DEFAULT 1,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_agent_memories_agent_day" ON "agent_memories" ("agent_id", "day");
