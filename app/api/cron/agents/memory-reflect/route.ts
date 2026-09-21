import { checkCronAuth } from "@/lib/agents/cron-auth";
import { queueMemoryReflection } from "@/lib/agents/scheduler";
import { processQueue } from "@/lib/agents/executor";

export async function GET(req: Request) {
  const denied = checkCronAuth(req);
  if (denied) return denied;

  const url   = new URL(req.url);
  const date  = url.searchParams.get("date") ?? undefined;

  try {
    await queueMemoryReflection(date);
  } catch (err) {
    console.error("[cron/memory-reflect] queueMemoryReflection failed:", err);
    return Response.json({ error: "Failed to queue memory_reflect" }, { status: 500 });
  }

  try {
    const result = await processQueue(2);
    return Response.json({ success: true, queued: "memory_reflect", date: date ?? "today", processed: result });
  } catch (err) {
    console.error("[cron/memory-reflect] processQueue failed:", err);
    return Response.json({ success: true, queued: "memory_reflect", date: date ?? "today", processed: 0, processingError: String(err) });
  }
}
