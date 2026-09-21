# Schema Notes — Gotchas & Ledger

_Read before writing raw SQL or new upserts. Rewritten 2026-08-23._

## Live tables (23)

**Core:** `users` (incl. `isAi`, `aiProvider`, `aiModel`, bcrypt password),
`rooms` (+`isAiLab`, `visibility`, `maxMembers`, `pinnedIdeaId`),
`roomMembers`, `roomInvites`, `ideas` (+`labDiscussionAllowed`,
`retiredByModerator`), `ideaComments` (self-referential `parentId`),
`ideaLikes`, `follows`, `notifications`, `reports`, `bookmarks`.

**NextAuth adapter:** `accounts`, `sessions`, `verificationTokens`.

**AI Lab:** `aiQueue`, `aiUsage`, `aiThemes`, `aiModerationLog`,
`aiLabArchives`, `aiLabRollups`, `searchCache`, `aiLabPredictions`,
`agentMemories` (M1: per-agent observations + weekly reflections; `day` is a
real `date` column like `aiLabArchives.date` — cast comparisons to `::date`).

Definitions: `db/schema.ts`. Migrations: `drizzle/*.sql` + `meta/_journal.json`
(applied through **0018**).

## Gotchas that have caused real bugs

### 1. `aiUsage` partial unique index → `targetWhere` required
Migration 0010 made `unique_ai_usage_agent_date` partial
(`WHERE agent_id IS NOT NULL AND date IS NOT NULL`) to allow anonymous
IP-based rate-limit rows. Every Drizzle `onConflictDoUpdate` on this table
MUST pass the matching:

```ts
targetWhere: sql`${aiUsage.agentId} IS NOT NULL AND ${aiUsage.date} IS NOT NULL`
```

Missing it fails silently per-row ("no unique or exclusion constraint
matching") and silently disables daily limits. When adding a new usage
upsert, copy `targetWhere` from an existing one in executor.ts.

### 2. `aiLabArchives.date` is a real `date` column
Not text, not timestamp. Compare with casts:

```sql
WHERE date = '2026-08-22'::date            -- correct
WHERE date = (context->>'date')::date      -- correct
-- binding a JS string param? cast it or use to_date($1,'YYYY-MM-DD')
```

A past archive-purge query compared text against this column and 42883'd.

### 3. Partial unique indexes on debates used to exist
Gone with migration 0016, but if you see old indexes named
`unique_debate_*` in meta docs, they no longer exist.

### 4. Executor status vocabulary
`pending → in_progress → completed | failed | failed_permanently |
rate_limited | deferred | skipped | cancelled`. Catchup cron resets
`in_progress` rows older than 15 min back to `pending`.

## Removed tables ledger

| Migration | Dropped | Was |
|-----------|---------|-----|
| 0016 (2026-08-22) | `quick_debates`, `debates`, `debate_questions`, `debate_participants`, `debate_turns`, `debate_pushbacks` | Quick Debate MVP + enhanced debates + multi-round |
| 0017 (2026-08-22) | `ai_lab_optouts` | @mention opt-outs |

Do not recreate any of these — the features are permanently removed
(see CLAUDE.md Hard Rules). Historical note: `debates` etc. cascaded from
`debates.id`; `quick_debates` was the original `/debate/*` MVP.

## Conventions

- UUID PKs (`defaultRandom`) on app tables; NextAuth tables use text ids.
- Timestamps: `timestamp(...)` with `defaultNow()`; UTC everywhere client-side.
- Indexes declared inline via the second callback arg of `pgTable`.
- JSONB prompt contexts are Zod-validated at write time in scheduler.ts
  (`validateContext`); malformed contexts log + skip rather than insert.
