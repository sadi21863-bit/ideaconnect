import "dotenv/config";
import { config } from "dotenv";
config({ path: ".env.local" });
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!, { max: 1 });

type StatusCountRow = { status: string; n: number };
type RecentRow = { executed_at: string; agent_id: string; result_comment: string | null };
type CountRow = { n: number };
type ThemeRow = { theme: string | null };
type StatusRow = { status: string | null };
type FailureRow = { action_type: string; status: string; err: string | null; created_at: string };

async function main() {
  // 1. Mention response queue outcomes — last 14 days
  const mentions = await sql.unsafe(`
    SELECT status, COUNT(*)::int AS n
    FROM ai_queue
    WHERE action_type = 'comment'
      AND prompt_context->>'kind' = 'mention_response'
      AND created_at > NOW() - INTERVAL '14 days'
    GROUP BY status ORDER BY n DESC
  `);
  console.log("=== mention_response queue items (14d) ===");
  if (mentions.length === 0) console.log("  (none in last 14 days)");
  for (const r of mentions as unknown as StatusCountRow[]) console.log(`  ${r.status}: ${r.n}`);

  // 2. Most recent successful mention responses — proof of end-to-end flow
  const recent = await sql.unsafe(`
    SELECT q.executed_at, q.agent_id,
           LEFT(q.result_comment_id::text, 8) AS result_comment
    FROM ai_queue q
    WHERE q.action_type = 'comment'
      AND q.prompt_context->>'kind' = 'mention_response'
      AND q.status = 'completed'
      AND q.executed_at IS NOT NULL
    ORDER BY q.executed_at DESC
    LIMIT 5
  `);
  console.log("\n=== last 5 completed mention responses ===");
  if (recent.length === 0) console.log("  (none found)");
  for (const r of recent as unknown as RecentRow[]) {
    const d = new Date(r.executed_at).toISOString().slice(0, 16);
    console.log(`  ${d}Z agent=${r.agent_id} comment=${r.result_comment}...`);
  }

  // 3. Do those result comments actually exist and are visible?
  const comments = await sql.unsafe(`
    SELECT COUNT(*)::int AS n
    FROM idea_comments c
    JOIN ai_queue q ON q.result_comment_id = c.id
    WHERE q.prompt_context->>'kind' = 'mention_response'
      AND q.status = 'completed'
      AND c.created_at > NOW() - INTERVAL '14 days'
  `);
  console.log(`\n=== mention reply comments posted in last 14d: ${(comments[0] as unknown as CountRow).n} ===`);

  // 4. Today's AI Lab health: theme + ideas + archive
  const today = new Date().toISOString().slice(0, 10);
  const theme = await sql.unsafe(`SELECT theme FROM ai_themes WHERE date = '${today}'::date`);
  const ideas = await sql.unsafe(`SELECT COUNT(*)::int AS n FROM ideas WHERE room_id = '${process.env.AI_LAB_ROOM_ID!}'::uuid AND created_at >= '${today}'::date`);
  const archive = await sql.unsafe(`SELECT status FROM ai_lab_archives WHERE date = '${today}'::date`);
  console.log(`\n=== AI Lab today (${today}) ===`);
  console.log(`  theme: ${(theme[0] as unknown as ThemeRow)?.theme ?? "(not set yet)"}`);
  console.log(`  lab ideas posted: ${(ideas[0] as unknown as CountRow).n}`);
  console.log(`  archive: ${(archive[0] as unknown as StatusRow)?.status ?? "(pending — runs 17:30 UTC)"}`);

  // 5. Any failed queue items in last 24h?
  const failures = await sql.unsafe(`
    SELECT action_type, status, LEFT(error_message, 140) AS err, created_at
    FROM ai_queue
    WHERE status IN ('failed_permanently', 'cancelled')
      AND created_at > NOW() - INTERVAL '24 hours'
    ORDER BY created_at DESC
  `);
  console.log("\n=== terminal queue items (24h) ===");
  if (failures.length === 0) console.log("  (none)");
  for (const f of failures as unknown as FailureRow[]) {
    const d = new Date(f.created_at).toISOString().slice(5, 16);
    console.log(`  ${d} | ${f.action_type} | ${f.status}`);
    console.log(`     err: ${f.err ?? "(no message)"}`);
  }

  await sql.end();
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
