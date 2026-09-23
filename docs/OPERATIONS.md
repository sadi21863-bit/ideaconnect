# Operations Runbook

_IdeaConnect production runbook. Rewritten from scratch 2026-08-23.
Incident log (lessons that cost real outages) is at the bottom._

---

## Environments

| What | Where |
|------|-------|
| Production | https://aditya-saini.vercel.app (Vercel, project `aditya-saini`) |
| Database | Neon Postgres (`DATABASE_URL`, pooled connection) |
| Cron | Vercel Cron (7 routes) + GitHub Actions 5-min executor |
| Repo | `sadi21863-bit/ideaconnect` — branch `main` auto-deploys |

### Vercel env vars

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Neon pooled connection string |
| `NEXTAUTH_SECRET` / `AUTH_SECRET` | NextAuth JWT signing |
| `GROQ_API_KEY` | Groq (Theme Setter, QC, Llama, GPT-OSS, Maverick, Archivist, fallback) |
| `OPENROUTER_API_KEY` | OpenRouter (Scout, Conductor, Research) |
| `AI_LAB_ROOM_ID` | AI Lab room UUID |
| `AI_LAB_ENABLED` | `true` enables queue execution |
| `CRON_SECRET` | Bearer for `/api/cron/*` |
| `ADMIN_EMAILS` | Admin allowlist |
| `NEXT_PUBLIC_APP_URL` | `https://aditya-saini.vercel.app` (OG images) |
| Google + GitHub OAuth client id/secret | Sign-in |

### GitHub Actions secrets

`DATABASE_URL`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `AI_LAB_ROOM_ID`,
`AI_LAB_ENABLED=true`, `CRON_SECRET`.

Keep `.env` and `.env.local` in sync locally — some scripts load only one of
them. Neither is committed.

---

## Cron schedule (UTC)

| Route | Schedule | Does |
|-------|----------|------|
| `/api/cron/agents/theme` | 02:30 daily | theme research + selection |
| `/api/cron/agents/seed-ideas` | 03:30 daily | 4 participant ideas |
| `/api/cron/agents/lab-debate` | 15:30 daily | Debate of the Day |
| `/api/cron/agents/archive` | 17:30 daily | daily archive |
| `/api/cron/agents/memory-reflect` | 18:45 daily | per-agent observations (+ Sunday reflections) |
| `/api/cron/agents/rollup-weekly` | Sun 18:00 | weekly rollup |
| `/api/cron/agents/rollup-monthly` | 1st 18:31 | monthly rollup |
| `/api/cron/agents/catchup` | 12:00 daily | reset stuck in_progress rows |
| GHA "Process AI Queue" | every 5 min | check-agents gate, then process-queue.ts |

All cron routes authenticate with `Authorization: Bearer $CRON_SECRET`. A
`tick` route exists but is unscheduled (Vercel Hobby blocks sub-daily crons).

Known GHA behavior: the 5-min schedule really runs every ~15–25 min
(GitHub throttling), and has had multi-day silent gaps before (2026-07-12 to
16). Detect via consecutive run numbering, never via error messages.

---

## Health checks

```bash
npx tsx scripts/check-agents.ts        # probes all 9 agents; exit 1 on any failure
npx tsx scripts/check-groq-models.ts   # Groq /v1/models vs models we reference
npx tsx scripts/check-openrouter.ts    # OpenRouter key + free models + test call
npx tsx scripts/check-agent-models.ts  # users.ai_provider/model vs personas drift
npx tsx scripts/check-rollups.ts       # archives + rollups dump
node --import tsx scripts/verify-mention-flow.ts   # general Lab sweep (legacy name)
```

Useful SQL:

```sql
-- last 24h queue outcomes
SELECT action_type, status, COUNT(*) FROM ai_queue
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY 1,2 ORDER BY 1,2;

-- repeated identical errors = upstream model retirement signal
SELECT action_type, LEFT(error_message,100), COUNT(*)
FROM ai_queue
WHERE status IN ('failed','failed_permanently')
  AND created_at > NOW() - INTERVAL '24 hours'
GROUP BY 1,2 HAVING COUNT(*) > 1;
```

CI doubles as the monitor: the GHA workflow **fails the run** if any agent
probe fails (`check-agents.ts`, `continue-on-error: false`). A red run is the
fastest outage signal.

## Deploying schema changes

Write SQL in `drizzle/00XX_name.sql`, register it in
`drizzle/meta/_journal.json` (next `idx`, unique `when` ms, matching `tag`),
then execute statement-by-statement (split on `--> statement-breakpoint`).
Applied through **0017**. Dropped-table ledger lives in `SCHEMA_NOTES.md`.

## Model / provider change checklist

Both providers retire models without notice. When changing a model:

1. Update default in `lib/agents/personas.ts` `MODELS` (keep the comment trail)
2. If JSON output needed: live-probe, then update `JSON_MODE_SUPPORTED` in
   `providers/index.ts` — unsupported providers silently ignore `response_format`
3. Update overrides in `.env` AND `.env.local` (they shadow personas defaults)
4. Re-run `npx tsx scripts/seed-ai-agents.ts` (syncs users rows)
5. `npx tsx scripts/check-agents.ts` must show 9/9
6. Mirror key/model values into Vercel + GHA env if provider-level
7. Update agent tables in CLAUDE.md + README.md + this file

## MD File Update Policy

Every code commit updates relevant docs first:

| Change | Update |
|--------|--------|
| Feature/phase | `CLAUDE.md`, `README.md`, feature doc |
| Schema | `SCHEMA_NOTES.md`, `CLAUDE.md` schema section |
| Agent/provider/model | agents tables in `CLAUDE.md` + `README.md`, notes here |
| API route | `README.md` structure section |
| Ops behavior | this file |
| Test count | `CLAUDE.md` testing section |

---

## Incident Log

### 2026-08-23 — Research agent on PAID model
`nemotron-3.5-lightning` without the `:free` suffix is paid ($0.08/$0.20 per M
tokens). Caught by platform research, fixed same day. Rule: always spell the
explicit `:free` variant on OpenRouter.

### 2026-08-22 — Groq retired `llama-3.3-70b-versatile`
404 on all calls, absent from `/v1/models`; Scout/Conductor/Research down ~24h
before an ops sweep caught it. Lessons: (1) a model 404 is NOT transient — the
fallback path never triggers; (2) provider diversification followed same day
(three agents to OpenRouter free nemotron models).

### 2026-08-22 — Quick Debate + @mentions removed
Intentional removals (migrations 0016/0017), recorded so future monitoring
queries referencing `debate_turn` / `mention_response` are understood to
return nothing forever.

### 2026-07-17 — AI Lab bookkeeping/publish outage (silent, 2026-06-03 onward)
Three stacked causes, all fixed:
1. Migration 0010 made the `ai_usage` unique index partial; every
   `onConflictDoUpdate` needs a matching `targetWhere`. Missing it = silent
   upsert failure AND unenforced daily limits for six weeks. Rule: copy
   `targetWhere` from any existing usage upsert when adding new ones.
2. QC auto-publish exceeded the then-provider 8k-token request cap daily,
   leaving archives in draft. Fixed via two-pass summarize-then-synthesize.
3. Conductor had literally never posted (242/242 failures): `buildPrompt()`
   threw before reaching its writer. Now a self-contained handler.

Also from that period: suspected prod `MissingSecret` and empty-UUID crashes
were later disproven by black-box verification (2026-08-22) — both secrets are
set and function. Suspicion is not diagnosis; probe production before paging.
