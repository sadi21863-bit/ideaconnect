const REPO  = "sadi21863-bit/ideaconnect";
const WF    = "process-queue.yml";
const BRANCH = "main";

// Triggers the GHA process-queue workflow via workflow_dispatch.
// Skips check-agents step (skip_checks=true) since per-item failures are
// handled by the executor — no need to block the whole run on agent health.
// Silent on failure — the 5-minute cron is the fallback.
export async function dispatchQueueProcessor(): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return; // no token in local dev — queue processed by cron or manually

  await fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/${WF}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `token ${token}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
      },
      body: JSON.stringify({ ref: BRANCH, inputs: { skip_checks: "true" } }),
    }
  ).catch(() => {}); // silent — cron fallback handles any dispatch failure
}
