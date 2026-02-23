/**
 * Temporal Worker — Agent Task Queue
 *
 * Long-running process that polls the "agent-tasks" task queue and executes
 * workflows + activities. This is the Temporal equivalent of the daemon process.
 *
 * Usage:
 *   npx tsx src/temporal/worker.ts
 *
 * Environment:
 *   TEMPORAL_ADDRESS — Temporal server gRPC address (default: localhost:7233)
 *   TEMPORAL_NAMESPACE — Temporal namespace (default: default)
 */

import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./activities.js";

export const TASK_QUEUE = "agent-tasks";

async function main() {
  const address = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
  const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";

  console.log(`[temporal-worker] Connecting to Temporal at ${address}...`);

  const connection = await NativeConnection.connect({ address });

  const worker = await Worker.create({
    connection,
    namespace,
    taskQueue: TASK_QUEUE,
    workflowsPath: new URL("./workflows.ts", import.meta.url).pathname,
    activities,
    maxConcurrentActivityTaskExecutions: 10,
    maxConcurrentWorkflowTaskExecutions: 5,
  });

  console.log(`[temporal-worker] Worker started on task queue: ${TASK_QUEUE}`);
  console.log(`[temporal-worker] Namespace: ${namespace}`);
  console.log("[temporal-worker] Waiting for work...");

  // Graceful shutdown
  const shutdown = async () => {
    console.log("[temporal-worker] Shutting down...");
    worker.shutdown();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await worker.run();
  console.log("[temporal-worker] Worker stopped.");
}

main().catch((err) => {
  console.error("[temporal-worker] Fatal error:", err);
  process.exit(1);
});
