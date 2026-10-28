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
2. Update the agent's `fallbackModels` chain (OpenRouter only): priority order,
   every entry `:free` or `openrouter/free`, last entry `openrouter/free`
3. If JSON output needed: live-probe, then update `JSON_MODE_SUPPORTED` in
   `providers/index.ts` — unsupported providers silently ignore `response_format`
4. Update overrides in `.env` AND `.env.local` (they shadow personas defaults)
5. Re-run `npx tsx scripts/seed-ai-agents.ts` (syncs users rows)
6. `npx tsx scripts/check-agents.ts` must show 9/9. "OK via fallback" means the
   primary is retired but production still serves — prune the chain, not an outage
7. Mirror key/model values into Vercel + GHA env if provider-level
8. Update agent tables in CLAUDE.md + README.md + this file

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

### 2026-10-27 — `openrouter/free` evaluated; retirement-proof fallback chains adopted
Question: can every OpenRouter call site use the Free Models Router
(`openrouter/free`) so free-tier retirements stop requiring code changes?
Docs: it randomly selects among available free models, filtering only on
capability (vision/tools/structured output) — not on quality or persona fit.
Probed 16 requests with our real prompt shapes: **6/16 usable**. JSON idea
output was 2/4 (one invalid, one HTTP 200 with EMPTY content after burning all
2,500 tokens); research triage at 200 tokens was 0/3 (all empty); conductor at
2,000 was 3/3 but with random models. The pool included
`nvidia/nemotron-3.5-content-safety:free` (returned "User Safety: safe" instead
of content), `liquid/lfm-2.5-2.6b:free` (2.6B, empty at 200), and code-tuned
models. Verdict: **rejected as a primary** — random selection breaks persona
consistency and JSON reliability.

Adopted instead: OpenRouter's `models` fallback array (priority order, falls
through on 404/429/5xx/moderation, response reports the concrete `model`).
Every OpenRouter agent now carries `fallbackModels`, ending in
`openrouter/free` as a last resort. The array is capped at **3 entries total**
(primary + 2); a 4th returns HTTP 400 `'models' array must have 3 items or
fewer` — caught by the probe, not by types. Verified: retired
`super-120b:free` first → served by `super-vl:free` in ~1.8s. Caveats: fallback
does NOT trigger on HTTP 200 with empty content (reasoning burn still needs
adequate budgets), and an unknown model ID 400s the whole request (retired
`:free` variants of known base slugs are tolerated). `scripts/check-agents.ts`
probes the same chain and now reports "OK via fallback" plus a `::warning::`
instead of reddening the run when only the primary is retired; it fails only if
the entire chain fails.

### 2026-10-27 — OpenRouter retired `nemotron-3-super-120b-a12b:free`; probe gate reddened every GHA run
The super slug followed the nano variant into limited retirement: 404
"Provider returned error" on every call while still listed in `/v1/models`
(the known listed-but-unavailable pattern). Because `process-queue.yml`
deliberately finishes red when the agent probe fails, **every scheduled run
appeared as a failure** for days while the queue itself processed normally —
check the "Fail if agent health check failed" step before assuming the
pipeline is down. Conductor moved to `nvidia/nemotron-3.5-super-vl:free`.
Critical: at the old 600-token cap this model (like lightning) returns HTTP
200 with EMPTY content — ~490 completion tokens go to hidden reasoning before
the answer, and the writer treats empty text as "debate resolved → SKIP", so
the break would be silent. The conductor writer now budgets 2000. The probe
`scripts/check-agents.ts` only requests 10 tokens, so it cannot catch
empty-output-at-budget — when swapping a reasoning model, probe it directly
with the real cap. Also rejected: `google/gemma-4-31b-it:free` (429) and
`thinkingmachines/inkling:free` (403, "agentic harnesses only"). Verified 9/9
probe + real conductor prompt (correct @handle question, ~6s). Separately, the
workflow's health-report step is inert: `APP_URL`/`CRON_SECRET` resolve empty
in GHA (`secrets.NEXT_PUBLIC_APP_URL` unset), so
`/api/internal/agent-health-report` is never called.

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
parsed via json-helpers; cap raised to 3000 on 2026-10-17 after ~1-in-50
verbose summaries still truncated at 2000 — see campaign note below); `callGroq`
now appends non-empty `failed_generation`
snippets to validator errors for triage. Archive 2026-10-15 regenerated
(id `276f0b96`): 4/4 quotes verified verbatim against source comments.
Signal: `json_validate_failed` in `ai_queue.error_message` → suspect reasoning
burn, not prompt size.

**Impact & recovery (audit 2026-10-16).** The burn bug had been failing pass 1
quietly since ~2026-08-09 (the Groq gpt-oss migration): early-August archives
carry 1–2 quotes/day, everything after is mostly zero. Audit of published
content found 31 of 43 days (Aug 9–Sep 30) with zero quotes, two October days
with fabricated quotes (Oct 6, Oct 13), and one weekly rollup (Oct 4–10) whose
quotes had leaked "Voice A/B" anonymization labels into public text — degraded
daily narratives can contain unmapped Voice labels when pass 2 hallucinates
voices beyond the day's participant set, and rollups copy them. Recovery is
data-only via `scripts/backfill-archives.ts` (rewritten as a thin wrapper over
`executeArchiveDay` / `executeRollupWeek` / `executeRollupMonth`; the previous
version duplicated the pipeline and hardcoded a retired model). Regenerated
and quote-verified: dailies 2026-09-20…10-15 (all grounded, 0 ungrounded of
~90 quotes), weekly rollups 2026-09-20…10-10, September monthly. An early
script version aligned weeks Mon–Sun and created two misaligned rollups — the
executor uses Sunday–Saturday (`periodEnd = yesterday`, `periodStart =
yesterday − 6`); they were deleted as garbage. Campaign progress (2026-10-17,
dailies regenerate via upsert — no queue rows involved): batches **Aug 30–Sep
19** (21 days) and **Aug 20–29** done; `2026-08-27` is a genuinely empty lab
day (no ideas, no archive row — nothing to regenerate); weeklies Aug 16–22 and
Aug 23–29 regenerated from clean sources; September monthly final. Verified by
quote-grounding audit: **Aug 20 → Oct 16 = 57 days, ~200 quotes, 2 marginal
paraphrase misses (Sep 11, Sep 15)** — everything else verbatim. Production
end-to-end confirmed on 2026-10-16 crons with fixed code (archive 2/2 quotes
grounded; memory stream wrote 5 prose observations — first rows ever from a
scheduled run). Remaining (quota-bound, Groq gpt-oss-120b TPD 200k): dailies
**2026-08-09…08-19** (11 days), then week Aug 9–15 and the August monthly
final pass. Script gotcha: the fake queue-item id in
`scripts/backfill-archives.ts` must be a valid UUID — no-idea days hit the
handler's early-return path and `UPDATE ai_queue WHERE id = '__backfill__'`
throws on the uuid column (Aug 27, fixed with the all-zeros UUID). Residual
pass-1 parse failures (~3–4% of calls, unescaped-quote class) degrade one
idea's quotes to a placeholder; the day still publishes — accepted, not chased.
A post-campaign CONTENT audit (2026-10-17) then found two defect classes the
quote-grounding check cannot see, both fixed and re-verified: (1) compact and
separator label variants (`voicea`, `voicec` as published quote authors) and
plural prose (`Voices A and B`) bypassed `restoreVoiceLabels`, which only
replaced exact strings — it now normalizes compact/underscore/dash/plural forms
with English-collision guards (`voiced`, `the voice a listener hears`,
`invoices` untouched; 5 new unit tests, 8 total); (2) pass 2 narrated a failed
pass-1 input as "its summary was unavailable" in public prose (Aug 22).
Aug 22, Aug 23 and Sep 12 were regenerated after the fix and re-verified (real
agent handles, zero voice-label hits, all quotes grounded). A rollup-wide scan
(19 rows, May→Oct) found zero remaining voice leaks.
**Campaign complete (2026-10-25):** dailies 2026-08-09…08-19 regenerated and
verified — Aug 13 (aborted) and Aug 18 (stale ungrounded quotes after a lost
pass 1) needed retries; Aug 16 keeps one tolerated paraphrase. Week Aug 9–15
regenerated (7/7 quotes ground) and the August monthly rebuilt last (8/8 quotes
ground against the weekly rollup narratives it actually sources — monthlies
read weeklies, not dailies; verify monthlies against weekly text, not daily
text). Production has since run the fixed code for 8 consecutive days
(2026-10-17…10-24): every daily published with 2–6 grounded quotes, 5 memory
observations per day (10 on Sunday reflections), and weeklies auto-built with
11 and 4 quotes. Only pre-incident July rollups (0 quotes) remain untouched.
Operational note: gpt-oss free tier also caps **TPM at 8,000** — when batch
regenerating, pacing matters (back-to-back days eventually 429 or abort on the
20b pass-1 call; retry the affected day once cool).

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
