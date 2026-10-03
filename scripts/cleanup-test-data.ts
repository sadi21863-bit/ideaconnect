/**
 * Deletes test data created during Week 4 and Week 5 verification.
 * Run ONCE before public launch.
 *
 * Targets:
 *   - Week 4 "no activity" archive: 29bf6428-7d06-4da4-8dfc-584e46ad1af4
 *   - Week 4 queue rows left from the verification run
 *   - Week 5 private test room and any ideas inside it
 */
import * as dotenv from "dotenv";
import * as path from "path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });
dotenv.config({ path: path.resolve(process.cwd(), ".env.local"), override: true });

const WEEK4_ARCHIVE_ID = "29bf6428-7d06-4da4-8dfc-584e46ad1af4";

async function main() {
  const client = postgres(process.env.DATABASE_URL!, { prepare: false });
  const db     = drizzle(client);

  // ── Preview mode: show what WILL be deleted ──────────────────────────
  const dryRun = process.argv.includes("--dry-run");
  console.log(dryRun ? "\n[DRY RUN — no changes]\n" : "\n[LIVE — deleting rows]\n");

  // ── Week 4 archive ────────────────────────────────────────────────────
  const archives = await db.execute(sql`
    SELECT id, date, theme, status
    FROM   ai_lab_archives
    WHERE  id = ${WEEK4_ARCHIVE_ID}
  `);
  console.log("Week 4 archive to delete:");
  console.log(archives.length ? archives : "  (not found — already cleaned or ID wrong)");

  // ── Week 4 queue rows (completed/failed from the same day) ────────────
  const queueRows = await db.execute(sql`
    SELECT id, agent_id, action_type, status, created_at
    FROM   ai_queue
    WHERE  status IN ('completed', 'failed', 'cancelled')
      AND  created_at::date = (
        SELECT date FROM ai_lab_archives WHERE id = ${WEEK4_ARCHIVE_ID} LIMIT 1
      )
  `);
  console.log(`\nWeek 4 queue rows to delete: ${queueRows.length}`);
  for (const r of queueRows as unknown[]) console.log(" ", r);

  // ── Week 5 private test room ──────────────────────────────────────────
  const adminUserId = process.env.ADMIN_USER_ID;
  let testRooms: unknown[] = [];
  if (adminUserId) {
    testRooms = await db.execute(sql`
      SELECT id, name, visibility, status, created_at
      FROM   rooms
      WHERE  creator_id = ${adminUserId}
        AND  visibility = 'private'
        AND  name ILIKE '%test%'
      ORDER  BY created_at DESC
      LIMIT  5
    `) as unknown[];
  } else {
    console.log("\nADMIN_USER_ID not set — skipping private test room scan.");
    console.log("To include: add ADMIN_USER_ID=<your_user_id> to .env.local");
  }
  console.log(`\nWeek 5 private test rooms found: ${testRooms.length}`);
  for (const r of testRooms as unknown[]) console.log(" ", r);

  if (dryRun) {
    console.log("\nRun without --dry-run to apply deletions.");
    await client.end();
    return;
  }

  // ── Deletions ─────────────────────────────────────────────────────────
  let deleted = 0;

  if (archives.length > 0) {
    await db.execute(sql`
      DELETE FROM ai_lab_archives WHERE id = ${WEEK4_ARCHIVE_ID}
    `);
    console.log("\n✓ Deleted Week 4 archive");
    deleted++;
  }

  if (queueRows.length > 0) {
    const ids = (queueRows as Array<{ id: string }>).map(r => r.id);
    for (const id of ids) {
      await db.execute(sql`DELETE FROM ai_queue WHERE id = ${id}::uuid`);
    }
    console.log(`✓ Deleted ${ids.length} Week 4 queue rows`);
    deleted += ids.length;
  }

  // Delete test rooms and their ideas (ideas have a cascade or we delete manually)
  for (const room of testRooms as Array<{ id: string; name: string }>) {
    // Delete ideas first (FK constraint)
    const ideaDelete = await db.execute(sql`
      DELETE FROM ideas WHERE room_id = ${room.id}
    `);
    await db.execute(sql`
      DELETE FROM room_members WHERE room_id = ${room.id}
    `);
    await db.execute(sql`
      DELETE FROM room_invites WHERE room_id = ${room.id}
    `);
    await db.execute(sql`
      DELETE FROM rooms WHERE id = ${room.id}
    `);
    console.log(`✓ Deleted test room "${room.name}" (id: ${room.id})`);
    deleted++;
  }

  console.log(`\nDone. Total rows/records removed: ${deleted}`);
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
