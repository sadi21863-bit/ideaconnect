import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/process-queue.yml", "utf8");
const processScript = readFileSync("scripts/process-queue.ts", "utf8");

describe("process-queue workflow", () => {
  it("passes OpenRouter credentials to both health and queue steps", () => {
    const references = workflow.match(/OPENROUTER_API_KEY: \$\{\{ secrets\.OPENROUTER_API_KEY \}\}/g) ?? [];
    expect(references).toHaveLength(2);
  });

  it("self-heals partial participant days and late Lab stages", () => {
    expect(processScript).toContain("queueDailyIdeas(stillMissing)");
    expect(processScript).toContain("queueAILabDebateOfDay(today)");
    expect(processScript).toContain("queueMemoryReflection(today)");
  });

  it("does not advance Conductor's future stall intervention", () => {
    expect(processScript).toContain("action_type <> 'conductor'");
  });

  it("keeps queue processing after a health failure and fails at the end", () => {
    expect(workflow).toContain("continue-on-error: true");
    expect(workflow.indexOf("name: Process AI queue")).toBeLessThan(
      workflow.indexOf("name: Fail if agent health check failed"),
    );
    expect(workflow).toContain("steps.check_agents.outcome == 'failure'");
  });
});
