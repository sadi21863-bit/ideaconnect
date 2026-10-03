export const HANDLED_QUEUE_STATUSES = [
  "pending",
  "in_progress",
  "rate_limited",
  "deferred",
  "completed",
  "failed_permanently",
  "cancelled",
  "skipped",
] as const;

export const HANDLED_QUEUE_STATUSES_SQL = HANDLED_QUEUE_STATUSES
  .map((status) => `'${status}'`)
  .join(", ");