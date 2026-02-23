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

import { Client, Connection } from "@temporalio/client";

const TASK_QUEUE = "agent-tasks";
const SCHEDULE_ID = "dep-watch";
const DEFAULT_CRON = "0 */6 * * *"; // Every 6 hours

async function main() {
  const command = process.argv[2];
  if (!command || !["schedule", "run", "status", "delete"].includes(command)) {
    console.error("Usage: npx tsx src/temporal/dep-watch.cli.ts <schedule|run|status|delete>");
    process.exit(1);
  }

  const address = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
  const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
  const cron = process.env.DEP_WATCH_CRON ?? DEFAULT_CRON;

  const connection = await Connection.connect({ address });
  const client = new Client({ connection, namespace });

  switch (command) {
    case "schedule": {
      // Delete existing schedule if present, then create fresh
      try {
        const existing = client.schedule.getHandle(SCHEDULE_ID);
        await existing.delete();
        console.log(`[dep-watch] Deleted existing schedule: ${SCHEDULE_ID}`);
      } catch {
        // Schedule doesn't exist yet — that's fine
      }

      await client.schedule.create({
        scheduleId: SCHEDULE_ID,
        spec: {
          cronExpressions: [cron],
        },
        action: {
          type: "startWorkflow",
          workflowType: "dependencyWatchWorkflow",
          taskQueue: TASK_QUEUE,
          workflowExecutionTimeout: "10 minutes",
        },
        policies: {
          overlap: "SKIP",
          catchupWindow: "1 day",
        },
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

    case "run": {
      console.log("[dep-watch] Running one-off dependency check...");
      const result = await client.workflow.execute("dependencyWatchWorkflow", {
        taskQueue: TASK_QUEUE,
        workflowId: `dep-watch-manual-${Date.now()}`,
        workflowExecutionTimeout: "5 minutes",
      });

      console.log("\n" + result.report);
      process.exit(result.updatesAvailable > 0 ? 1 : 0);
    }

    case "status": {
      try {
        const handle = client.schedule.getHandle(SCHEDULE_ID);
        const info = await handle.describe();
        const recent = info.info.recentActions;

        console.log(`[dep-watch] Schedule: ${SCHEDULE_ID}`);
        console.log(`[dep-watch] Paused: ${info.state.paused}`);
        console.log(`[dep-watch] Recent runs: ${recent.length}`);

        if (recent.length > 0) {
          const last = recent[recent.length - 1];
          console.log(`[dep-watch] Last run: ${last.takenAt}`);

          // Try to query the last workflow for its report
          if (last.action && "workflowId" in last.action) {
            try {
              const wfHandle = client.workflow.getHandle(
                last.action.workflowId as string
              );
              const report = await wfHandle.query("report");
              if (report) {
                console.log("\n" + (report as { report: string }).report);
              }
            } catch {
              console.log("[dep-watch] Could not query last workflow for report");
            }
          }
        } else {
          console.log("[dep-watch] No runs yet. Trigger manually: npx tsx src/temporal/dep-watch.cli.ts run");
        }
      } catch {
        console.log(`[dep-watch] Schedule '${SCHEDULE_ID}' not found. Create it first: npx tsx src/temporal/dep-watch.cli.ts schedule`);
      }
      break;
    }

    case "delete": {
      try {
        const handle = client.schedule.getHandle(SCHEDULE_ID);
        await handle.delete();
        console.log(`[dep-watch] Schedule deleted: ${SCHEDULE_ID}`);
      } catch {
        console.log(`[dep-watch] Schedule '${SCHEDULE_ID}' not found.`);
      }
      break;
    }
  }
}

main().catch((err) => {
  console.error("[dep-watch] Fatal error:", err);
  process.exit(1);
});
