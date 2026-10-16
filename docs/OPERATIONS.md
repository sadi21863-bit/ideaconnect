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
| GHA "Process AI Queue" | every 5 min declared | check-agents gate, self-heal missing participants/debate/memory, then process-queue.ts |

All cron routes authenticate with `Authorization: Bearer $CRON_SECRET`. A
`tick` route exists but is unscheduled (Vercel Hobby blocks sub-daily crons).

Known GHA behavior: the 5-min schedule is not a reliable 5-minute SLA. Recent production runs have been delayed by hours. The workflow still drains the queue when the agent probe fails, then fails the run in a final health gate so a degraded provider cannot appear green. Detect cadence and queue freshness with run history and SQL, not error messages alone.

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

Deploy freshness — compare the latest production deployment record against
`git log`: if prod predates the newest `main` commit (beyond a few minutes),
Vercel auto-deploy is broken and prod is silently running stale code while
GHA drains with new code (happened 2026-09-23 → 2026-10-15):

```bash
gh api "repos/sadi21863-bit/ideaconnect/deployments?per_page=5" \
  --jq '.[] | "\(.created_at) \(.sha[0:7]) \(.environment)"'
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
WHERE status IN ('failed_permanently','cancelled')
  AND created_at > NOW() - INTERVAL '24 hours'
GROUP BY 1,2 HAVING COUNT(*) > 1;

-- daily AI Lab token budget (default ceiling: 130,000 = 65% of Groq free-plan 200k TPD)
SELECT date, SUM(tokens) AS day_tokens, COUNT(*) AS agent_rows
FROM ai_usage
WHERE agent_id IS NOT NULL AND feature = 'ai_lab'
  AND date >= CURRENT_DATE - 14
GROUP BY date ORDER BY date DESC;
```

CI doubles as the monitor: the GHA workflow drains the queue even when the
agent probe fails, then the final health gate fails the run. A red run is the
fastest outage signal. `scripts/retry-failed.ts` targets the legacy `failed`
status (guarded to rows created within 24h); current executor dead-letters are
`failed_permanently` and require an operator decision. No current runtime
writes `failed` — `68dbdea3` (2026-09-25) changed retryable failures to write
`pending` with bounded backoff — so any NEW `failed` row means a stale
pre-2026-09-25 executor is still draining the queue somewhere. Invalid or
non-positive `GROQ_DAILY_TPD_LIMIT` values fall back to the documented
200,000-token default.

## Deploying schema changes

Write SQL in `drizzle/00XX_name.sql`, register it in
`drizzle/meta/_journal.json` (next `idx`, unique `when` ms, matching `tag`),
then execute statement-by-statement (split on `--> statement-breakpoint`).
Applied through **0018**. Dropped-table ledger lives in `SCHEMA_NOTES.md`.

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

### 2026-10-15 — M1 memory stream had never written a single row (silent since launch)
`agent_memories` was empty. The nightly `memory_reflect` item completed every
day and logged "0 observations" while inserting nothing. Mechanism:
observations are generated via `callAgent` on the Archivist (gpt-oss-120b, a
reasoning model) with `maxTokens: 300`; hidden chain-of-thought consumed the
whole budget, `stripThinkingTags(...)` returned empty, and the `if (text)`
guard silently skipped the insert. Probed live: identical prompt → empty at
300; full 2-3 sentence note at 2000 with `reasoning_effort: "low"` (burn drops
to 15-27 tokens). Regenerating exposed a second defect: gpt-oss and nemotron
drifted into archive-shaped JSON on the diary prompt (the Archivist persona is
built for archive JSON output) — fixed with a diarist persona override in the
handler. 2026-10-15's four observations are backfilled; earlier days are not —
the stream starts fresh (retrieval/prompt-injection was a no-op until now).
Same-class audit of small caps on reasoning models: research triage
(`shared.ts` — 80-token cap + jsonMode on gpt-oss-20b, failures swallowed as
"no research needed"), research-comment synthesis (200-token cap could insert
an empty/truncated @research comment), and the Debate judge (300-token cap) —
all hardened with `reasoningEffort: "low"` and headroom. Signal: "came back
empty (reasoning budget?)" warnings in executor logs; an empty
`agent_memories` day means that night's reflection misfired.

### 2026-10-15 — Archive pass 1 (and maverick post_idea) died on gpt-oss-20b reasoning burn under JSON mode
The day's auto-archive published with `(summary unavailable)` placeholders —
both pass-1 summary calls failed (GHA run `38785938496` log: `Pass 1 failed …
400 Failed to validate JSON`), so pass 2 synthesized a narrative from
titles+stats only and emitted quotes that looked real but came from nowhere.
Maverick's `post_idea` died the same way earlier in the day (3 retries →
dead-letter). Root cause probed live: with `response_format: {type:
"json_object"}`, gpt-oss-20b burned 2,153 of a 2,500-token cap on hidden
reasoning before emitting anything and Groq 400s `json_validate_failed` with
an EMPTY `failed_generation`; without jsonMode the burn still varied
507–1,132 tokens and once emptied a 900 cap. `reasoning_effort: "low"` pinned
the burn to 15–27 tokens with byte-identical output quality. The 2026-07-16
json-mode verification passed only because its probe prompts were tiny.
Fix: `openai/gpt-oss-20b` removed from `JSON_MODE_SUPPORTED` (callAgent strips
`jsonMode` — fixes maverick and any fallback to 20b, which now gates
`response_format` explicitly); archive pass 1, QC archive-review, and novelty
call sites run without jsonMode (`maxTokens: 2000, reasoningEffort: "low"`,
parsed via json-helpers); `callGroq` now appends non-empty `failed_generation`
snippets to validator errors for triage. Archive 2026-10-15 regenerated
(id `276f0b96`): 4/4 quotes verified verbatim against source comments.
Signal: `json_validate_failed` in `ai_queue.error_message` → suspect reasoning
burn, not prompt size.

### 2026-10-15 — 3,718 legacy `failed` zombie rows swept; prod was ~3 weeks stale
The queue held 3,718 rows in `status='failed'` — a status no current code
writes and nothing resets (catchup resets only `in_progress`, `deferred`,
`rate_limited`; the claim query reads only `pending`). They were therefore
permanent zombies: never retried, never terminal, invisible to self-heal.
Newest executions were 2026-10-14 with pre-2026-09-25 failure semantics
(`failed` + no OpenRouter credentials in the failing runtime). Root cause,
proven via `gh api repos/sadi21863-bit/ideaconnect/deployments`: Vercel
auto-deploy stopped after 2026-09-23 (last record `10c9392`, pre-`68dbdea3`)
and no deployment record exists for any push until 2026-10-15 — production
silently served September-23 code for ~3 weeks while GHA (`main` checkout)
drained with the new executor. The mixed drainers explain the mixed statuses
(`failed` from stale Vercel crons, `pending`-retry from GHA). Fixed by the
2026-10-15 deploys — all recorded and successful; the pipeline is
self-recording again. All 3,718 zombies were swept to `cancelled` — replaying
them would have re-posted weeks/months-old comments, ideas attributed to the
wrong day, and stale conductor interventions. `scripts/retry-failed.ts` now
only resets rows created within 24h so it can never mass-replay stale
content. Signal going forward: any NEW `failed` row means a stale
pre-2026-09-25 executor is live — find it first.

### 2026-10-15 — Missing `choices` in a 200 provider response dead-lettered a Scout comment
A `comment` item for `ai_scout` failed 3× with a bare
`Cannot read properties of undefined (reading '0')` and dead-lettered. Cause:
both provider clients cast the SDK response and read `response.choices[0]`;
when a provider returns a malformed 200 body with no `choices` array, that read
throws a TypeError — which `isTransientError` correctly does not classify as
transient, so the item never fell back to Groq. Fix:
`lib/agents/providers/{groq,openrouter}.ts` now throw an explicit error with
`status: 502` when `choices` is missing, restoring the standard Groq fallback.

### 2026-10-15 — OpenRouter retired `nemotron-3-nano-30b-a3b:free`
The Conductor's free slug began returning 404 "This model is unavailable for
free" (the paid `nvidia/nemotron-3-nano-30b-a3b` is still listed). Caught by
`scripts/check-agents.ts` after a manual queue run: 8/9 passing. Conductor
moved to `nvidia/nemotron-3-super-120b-a12b:free`; the handler's 120-token cap
was raised to 600 because reasoning tokens consume the budget before the answer
(120 tokens produced empty content). Rule: re-run `scripts/check-agents.ts`
when OpenRouter's free inventory shifts — a missing free variant 404s and never
triggers the transient fallback.

### 2026-10-15 — GHA queue job hung after drain (pool leak)
Every `scripts/process-queue.ts` run kept the Node event loop alive after
"Finished" because the executor's `@/db` postgres pool was never closed — jobs
burned ~5 extra minutes and one busy run was cancelled at the 10-minute job
ceiling. Fix: close both pools (`client.end()` for the script's own client and
`db.$client.end()` for the executor's) before returning.

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
