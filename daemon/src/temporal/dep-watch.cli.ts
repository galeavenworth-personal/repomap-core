/**
 * Dependency Watch CLI — Schedule & Trigger
 *
 * Usage:
 *   npx tsx src/temporal/dep-watch.cli.ts schedule     # Create/update the cron schedule
 *   npx tsx src/temporal/dep-watch.cli.ts run           # Trigger a one-off check now
 *   npx tsx src/temporal/dep-watch.cli.ts status        # Show last report from schedule
 *   npx tsx src/temporal/dep-watch.cli.ts delete        # Remove the schedule
 *
 * Environment:
 *   TEMPORAL_ADDRESS     Temporal server gRPC address (default: localhost:7233)
 *   TEMPORAL_NAMESPACE   Temporal namespace (default: default)
 *   DEP_WATCH_CRON       Cron expression (default: every 6 hours)
 */

import { Client, Connection, type ScheduleExecutionResult } from "@temporalio/client";

const TASK_QUEUE = "agent-tasks";
const SCHEDULE_ID = "dep-watch";
const DEFAULT_CRON = "0 */6 * * *"; // Every 6 hours

async function handleSchedule(client: Client, cron: string): Promise<void> {
  try {
    const existing = client.schedule.getHandle(SCHEDULE_ID);
    await existing.delete();
    console.log(`[dep-watch] Deleted existing schedule: ${SCHEDULE_ID}`);
  } catch {
    // Schedule doesn't exist yet — that's fine
  }

  await client.schedule.create({
    scheduleId: SCHEDULE_ID,
    spec: { cronExpressions: [cron] },
    action: {
      type: "startWorkflow",
      workflowType: "dependencyWatchWorkflow",
      taskQueue: TASK_QUEUE,
      workflowExecutionTimeout: "10 minutes",
    },
    policies: { overlap: "SKIP", catchupWindow: "1 day" },
    state: {
      note: "Checks curated dependency feeds for new releases",
      paused: false,
    },
  });

  console.log(`[dep-watch] Schedule created: ${SCHEDULE_ID}`);
  console.log(`[dep-watch] Cron: ${cron}`);
  console.log(`[dep-watch] Task queue: ${TASK_QUEUE}`);
  console.log(`[dep-watch] View: http://localhost:8233/namespaces/default/schedules/${SCHEDULE_ID}`);
  process.exit(0);
}

async function handleRun(client: Client): Promise<void> {
  console.log("[dep-watch] Running one-off dependency check...");
  const result = await client.workflow.execute("dependencyWatchWorkflow", {
    taskQueue: TASK_QUEUE,
    workflowId: `dep-watch-manual-${Date.now()}`,
    workflowExecutionTimeout: "5 minutes",
  });

  console.log("\n" + result.report);
  process.exit(result.updatesAvailable > 0 ? 1 : 0);
}

async function printLastRunReport(client: Client, last: ScheduleExecutionResult): Promise<void> {
  if (last.action.type !== "startWorkflow") return;

  try {
    const wfHandle = client.workflow.getHandle(last.action.workflow.workflowId);
    const report = await wfHandle.query("report");
    if (report) {
      console.log("\n" + (report as { report: string }).report);
    }
  } catch {
    console.log("[dep-watch] Could not query last workflow for report");
  }
}

async function handleStatus(client: Client): Promise<void> {
  try {
    const handle = client.schedule.getHandle(SCHEDULE_ID);
    const info = await handle.describe();
    const recent = info.info.recentActions;

    console.log(`[dep-watch] Schedule: ${SCHEDULE_ID}`);
    console.log(`[dep-watch] Paused: ${info.state.paused}`);
    console.log(`[dep-watch] Recent runs: ${recent.length}`);

    if (recent.length === 0) {
      console.log("[dep-watch] No runs yet. Trigger manually: npx tsx src/temporal/dep-watch.cli.ts run");
      return;
    }

    const last = recent[recent.length - 1];
    console.log(`[dep-watch] Last run: ${last.takenAt}`);
    await printLastRunReport(client, last);
  } catch {
    console.log(`[dep-watch] Schedule '${SCHEDULE_ID}' not found. Create it first: npx tsx src/temporal/dep-watch.cli.ts schedule`);
  }
}

async function handleDelete(client: Client): Promise<void> {
  try {
    const handle = client.schedule.getHandle(SCHEDULE_ID);
    await handle.delete();
    console.log(`[dep-watch] Schedule deleted: ${SCHEDULE_ID}`);
  } catch {
    console.log(`[dep-watch] Schedule '${SCHEDULE_ID}' not found.`);
  }
}

const COMMAND_HANDLERS: Record<string, (client: Client, cron: string) => Promise<void>> = {
  schedule: (client, cron) => handleSchedule(client, cron),
  run: (client) => handleRun(client),
  status: (client) => handleStatus(client),
  delete: (client) => handleDelete(client),
};

async function main() {
  const command = process.argv[2];
  const handler = command ? COMMAND_HANDLERS[command] : undefined;
  if (!handler) {
    console.error("Usage: npx tsx src/temporal/dep-watch.cli.ts <schedule|run|status|delete>");
    process.exit(1);
  }

  const address = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
  const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
  const cron = process.env.DEP_WATCH_CRON ?? DEFAULT_CRON;

  const connection = await Connection.connect({ address });
  const client = new Client({ connection, namespace });

  await handler(client, cron);
}

main().catch((err) => {
  console.error("[dep-watch] Fatal error:", err);
  process.exit(1);
});
