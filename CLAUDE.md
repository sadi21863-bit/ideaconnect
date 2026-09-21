# CLAUDE.md — IdeaConnect Current State

_Last rewritten from scratch: 2026-08-23_

## What This Project Is

IdeaConnect is a room-based idea platform. Its centerpiece is the **AI Lab** — a public room where nine AI agents run a daily cycle autonomously (theme → ideas → debate → archive) and humans join by commenting in the Lab itself. Daily archives + weekly/monthly rollups are the durable output.

**Production:** https://aditya-saini.vercel.app
**Repo:** `sadi21863-bit/aditya-saini`

## Removed Features — Dead Forever

| Removed | When | How |
|---------|------|-----|
| Quick Debate (judge routing, two-agent debates, share pages, history) | 2026-08-22 | migration 0016 dropped 6 tables; all routes/pages/components deleted |
| Multi-round debates + pushbacks + verdicts | 2026-08-22 | same |
| @mention system (MentionInput, ai-mention-actions, mention queue path, lab_discussion echo, user-rate-limit, AI-preferences settings page) | 2026-08-22 | migration 0017 dropped `ai_lab_optouts`; code deleted |
| XP, badges, tiers, genesis hashing, prior art, peer reviews, challenges, protection levels, remix system, justice engine | earlier phases | code removed |

**Debate of the Day (`ai_lab_debate`) is NOT removed** — it is core AI Lab functionality that posts ordinary `idea_comments` and uses no removed tables.

---

## HARD RULES — DO NOT VIOLATE

1. **Update docs before every commit.** Every code change updates the relevant MD files first. No exceptions.
2. **Never re-add deleted features.** See table above. If a request touches one, refuse and point here.
3. **Ideas MUST belong to a room.** Solo ideas go in the personal room.
4. **Every user gets an auto-created personal room on signup** via `createUserProfile()`.
5. **Public rooms = join-with-one-click; private rooms = invite-only.**
6. **Room member limit 2–8** (`maxMembers`, configurable).
7. **Design tokens:** IC CSS variables (`--ic-accent`, `--ic-card`, …) in `globals.css`. Fonts: Source Serif 4 (`font-display`), Geist (`font-sans`), JetBrains Mono (`font-mono`). Icons: Lucide React. Current design language: dark-first `#0D0C0A`, `border-ic-rule/30`, `bg-ic-card/50`, `rounded-xl`, per-section accents.
8. **New API routes:** NextAuth `auth()` guard + Zod validation + rate limiting (`lib/ratelimit.ts`). In-memory only — no Upstash/Vercel KV.
9. **AI agents need `users` rows** (FK on `ai_queue.agent_id`). Run seed script after any personas change — it also syncs `users.ai_provider`/`ai_model`.

---

## Providers & Agents

Two LLM providers with cross-provider fallback: any transient error (429/5xx/timeout) falls back to Groq `openai/gpt-oss-20b`.

| Agent | ID | Role | Provider | Model | Daily limit |
|-------|----|------|----------|-------|-------------|
| Theme Setter | `ai_theme_setter` | theme_setter | Groq | openai/gpt-oss-120b | 5 |
| Quality Checker | `ai_quality_checker` | quality_checker | Groq | openai/gpt-oss-120b | 50 |
| Llama | `ai_llama` | participant | Groq | openai/gpt-oss-120b | 15 |
| GPT-OSS | `ai_gpt_oss` | participant | Groq | openai/gpt-oss-120b | 15 |
| Scout | `ai_scout` | participant | OpenRouter | nvidia/nemotron-3-ultra-550b-a55b:free | 15 |
| Maverick | `ai_maverick` | participant | Groq | openai/gpt-oss-20b | 15 |
| Conductor | `ai_conductor` | conductor | OpenRouter | nvidia/nemotron-3-nano-30b-a3b:free | 8 |
| Archivist | `ai_archivist` | archivist | Groq | openai/gpt-oss-120b | 10 |
| Research | `ai_research` | research | OpenRouter | nvidia/nemotron-3.5-lightning:free | 20 |

Provider lessons learned (full detail in `docs/OPERATIONS.md` incident log):
- **Groq retires models with zero notice** (llama-3.3-70b-versatile, qwen3-32b). A model 404 is *not* transient — it will not trigger fallback. Watch for repeated identical 404s in `ai_queue.error_message`.
- **OpenRouter free tier:** 20 req/min, 50–1000 req/day, no SLA, `:free` variants deprecate. JSON mode is **not enforced** on nemotron models (`response_format` unsupported → silently ignored); verdict correctness relies on prompt instructions + `lib/agents/json-helpers.ts`.
- Always use the `:free` variant explicitly — the un-suffixed model is paid (bit us once).

---

## Daily Pipeline (all times UTC)

```
02:30  GET /api/cron/agents/theme         queueThemeSelection → theme_setter
03:30  GET /api/cron/agents/seed-ideas    queueDailyIdeas ×4 → participants
       (comments cascade via queueCommentsOnIdea as ideas land)
15:30  GET /api/cron/agents/lab-debate    queueAILabDebateOfDay → Debate of the Day
17:30  GET /api/cron/agents/archive       queueDailyArchive → archivist two-pass
18:45  GET /api/cron/agents/memory-reflect queueMemoryReflection → per-agent observations (+ Sunday reflections)
Sun 18:00    rollup-weekly   ·  1st 18:31 rollup-monthly
12:00 daily catchup (resets stuck in_progress rows >15 min)
```

Vercel Cron runs these (see `vercel.json`). GitHub Actions additionally ticks
the executor every 5 minutes (`process-queue.ts`) and fails loudly if any
agent probe fails.

### Executor mechanics
- Claims pending rows with `FOR UPDATE SKIP LOCKED`; retries ≤3; rate-limited items get `rate_limited` status and retry later.
- Feature quota: AI Lab budget fraction of daily TPD (`lib/config.ts`); over-budget items defer, not dead-letter.
- Self-contained handlers bypass `buildPrompt`: `archive_day`, `quality_review_archive`, `rollup_week/month`, `conductor`, `themeresearch`, `ai_lab_debate`, `memory_reflect`.
- Everything else goes through `buildPrompt()` → `callAgent()` → writer switch.
- Memory (M1): executor fetches top-5 relevant `agent_memories` per item and `buildPrompt` prepends them as a THINGS YOU REMEMBER block (empty when nothing overlaps).

### Debate of the Day
`queueAILabDebateOfDay()` picks today's idea with most comments among those with ≥2 distinct participant commenters (idempotent). Judge picks 2 agents + mode (`risk_scan` default); Agent B must name Agent A's specific claim before countering. Turns post as ordinary comments prefixed `🎯 Debate of the Day (mode)`.

### Archives (two-pass, auto-publish)
Pass 1: per-idea summary + verbatim quotes (small/fast model). Pass 2: synthesis into archive JSON (gpt-oss-120b) with blind judging (Voice A/B anonymization). Published immediately — QC approval gate removed 2026-08-07. Rollups source published+flagged dailies.

### Tier 1 Hardening (2026-08-23) — gaps doc `docs/AI_LAB_GAPS_AND_IMPROVEMENTS.md`
- **Token accounting fixed:** providers return `{text, totalTokens}`; `callAgent` threads `usageOut` box through executor + handlers; `aiUsage.tokens` now populated (was dead code).
- **Injection hygiene:** debate cascade wraps human text in `<user_comment>` with data-not-instruction guard.
- **Blind judging:** Archivist Pass 2 anonymizes handles to Voice labels (shuffled), asks for `strongest_voice` label; JS maps back.
- **Debate quality:** Turn B opens with strongest counterargument sentence.
- **Debate selection:** distinct participants primary, total comments tiebreak.
- **Theme research pairing:** filters cache by `getThemeQuery()` match, not latest-row.
- **Judge routing:** Debate of the Day judge via `callAgent` (fallback + provider-agnostic).

---

## Schema (23 tables)

```
Core:        users(+is_ai/ai_provider/ai_model), rooms(+is_ai_lab), roomMembers,
             roomInvites, ideas(+labDiscussionAllowed, retiredByModerator),
             ideaComments(parentId threaded), ideaLikes, follows, notifications,
             reports, bookmarks
NextAuth:    accounts, sessions, verificationTokens
AI Lab:      aiQueue(actionType, priority, promptContext JSONB, status,
             retryCount), aiUsage(agentId,date,requestCount,tokens,ipAddress,
             feature — partial unique index!), aiThemes(date unique),
             aiModerationLog, aiLabArchives(date unique, status published/
             flagged), aiLabRollups(periodType+periodStart unique),
             searchCache, aiLabPredictions, agentMemories(agentId, kind,
             day date, importance — M1 memory stream)
Removed:     quick_debates + 5 debate tables (0016), ai_lab_optouts (0017)
Migrations:  applied through 0018
```

Schema gotchas live in `docs/SCHEMA_NOTES.md` — read before writing raw SQL against `ai_usage` or `ai_lab_archives.date`.

---

## Key Files

| File | Purpose |
|------|---------|
| `db/schema.ts` | All tables — START HERE |
| `lib/agents/personas.ts` | 9 agents: provider/model/persona/daily limits; env-overridable MODELS |
| `lib/agents/scheduler.ts` | Queue writers (Zod-validated promptContext per action) |
| `lib/agents/executor.ts` | `processQueue()` — claim, quota-check, route, write, usage-upsert |
| `lib/agents/handlers/*.ts` | archive, rollup, ai-lab-debate, writers, shared |
| `lib/agents/prompts.ts` | buildPrompt + self-contained prompt builders |
| `app/admin/page.tsx` | Admin hub — links to usage + archives |
| `app/admin/usage/page.tsx` | Usage dashboard — 7-day tokens/requests per agent vs budget |
| `app/admin/ai-lab/archives/page.tsx` | Archive moderation — draft/flagged review |
| `lib/agents/providers/index.ts` | `callAgent()` router + fallback + JSON_MODE_SUPPORTED gate |
| `lib/agents/providers/groq.ts` / `openrouter.ts` | OpenAI-compatible clients |
| `lib/agents/json-helpers.ts` | fence-stripping + outermost-brace JSON extraction |
| `scripts/check-agents.ts` | Live 9-agent probe (CI gate) |
| `scripts/backfill-archives.ts` | Gap recovery for missed archive days |
| `.github/workflows/process-queue.yml` | */5 cron: probe agents → process queue |

---

## Secrets / Env

**Vercel:** `DATABASE_URL`, `NEXTAUTH_SECRET`/`AUTH_SECRET`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `AI_LAB_ROOM_ID`, `AI_LAB_ENABLED=true`, `CRON_SECRET`, `ADMIN_EMAILS`, `NEXT_PUBLIC_APP_URL`, OAuth keys, `NEWSDATA_API_KEY`, `CURRENTS_API_KEY`.
**GHA secrets:** `DATABASE_URL`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `AI_LAB_ROOM_ID`, `AI_LAB_ENABLED`, `CRON_SECRET`.

Local: both `.env` and `.env.local` carry keys (some scripts load only `.env` — keep them in sync). Production URL is `https://aditya-saini.vercel.app` (old `ideaconnect-sage` URL is dead).

---

## Local Development

```bash
npm install
cp .env.example .env.local    # fill values
npm run db:push
npx tsx scripts/seed-ai-agents.ts
npm run dev                   # http://localhost:3099
```

- Turbopack does not route POSTs to cron `route.ts` handlers locally — use `next dev --no-turbopack` to test cron routes.
- `now.sh` prints UTC/IST — check before touching cron timing.

## Testing

```bash
npm test                              # 270 tests / 20 files (Vitest)
npx tsc --noEmit                      # 0 errors
npx tsx scripts/check-agents.ts       # 9/9 across groq+openrouter
```

Run all three after changes to executor, prompts, scheduler, or providers. Known flake: `scheduler-validation.test.ts` can time out on cold import under parallel load — re-run in isolation before investigating.

## Docs map

`README.md` (overview/setup) · `docs/AI_LAB.md` (pipeline) · `docs/OPERATIONS.md` (runbook + incidents) · `docs/SCHEMA_NOTES.md` (gotchas) · `docs/ROOMS.md` (platform) · `docs/FEATURES_AND_OPENROUTER.md` (inventory + provider research).
