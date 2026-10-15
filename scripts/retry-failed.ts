import * as dotenv from "dotenv";
import * as path from "path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });
dotenv.config({ path: path.resolve(process.cwd(), ".env.local"), override: true });

async function main() {
  const client = postgres(process.env.DATABASE_URL!, { prepare: false });
  const db     = drizzle(client);

  // Reset failed post_idea rows to pending so the next tick retries them.
  // Guarded to rows created within the last 24h: no current executor writes
  // 'failed' (68dbdea3, 2026-09-25), so any such row is fresh residue from a
  // stale pre-2026-09-25 runtime. Replaying older rows would recreate ideas
  // under the wrong day — the 3,718-row legacy stockpile was cancelled on
  // 2026-10-15 for exactly that reason.
  await db.execute(sql`
    UPDATE ai_queue
    SET    status        = 'pending',
           error_message = NULL,
           executed_at   = NULL,
           scheduled_for = NOW()
    WHERE  action_type = 'post_idea'
      AND  status      = 'failed'
      AND  created_at >= NOW() - INTERVAL '24 hours'
  `);
  console.log("Failed post_idea rows (created within 24h) reset to pending");

  await client.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
