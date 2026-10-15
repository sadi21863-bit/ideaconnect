const DEFAULT_DAILY_TPD_LIMIT = 200_000;

function readDailyTpdLimit(): number {
  const raw = process.env.GROQ_DAILY_TPD_LIMIT;
  if (!raw) return DEFAULT_DAILY_TPD_LIMIT;

  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_DAILY_TPD_LIMIT;
}

export const QUOTA_CONFIG = {
  // Fraction of daily TPD budget reserved for the AI Lab.
  // Remaining 35% is buffer against measurement lag and manual ops runs.
  AI_LAB_BUDGET_FRACTION: 0.65,

  // Absolute daily token limit. Set GROQ_DAILY_TPD_LIMIT in env to override.
  // Groq's free-plan TPD for the GPT-OSS models used by the Lab is 200,000:
  // https://console.groq.com/docs/rate-limits
  DAILY_TPD_LIMIT: readDailyTpdLimit(),
} as const;
