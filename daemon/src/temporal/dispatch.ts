/**
 * Temporal Dispatch CLI — Start Agent Task Workflows
 *
 * CLI tool to start agentTaskWorkflow executions via Temporal.
 * Replaces the manual factory_dispatch.sh → poll → verify loop.
 *
 * Usage:
 *   npx tsx src/temporal/dispatch.ts [options] <prompt>
 *
 * Options:
 *   --agent <mode>       Agent mode (default: plant-manager)
 *   --title <title>      Session title
 *   --host <host>        kilo serve host (default: 127.0.0.1)
 *   --port <port>        kilo serve port (default: 4096)
 *   --timeout <ms>       Workflow timeout in ms (default: 1800000)
 *   --poll <ms>          Poll interval in ms (default: 10000)
 *   --no-wait            Start workflow and exit (fire-and-forget)
 *   --workflow-id <id>   Custom workflow ID (default: auto-generated)
 *
 * Environment:
 *   TEMPORAL_ADDRESS     Temporal server gRPC address (default: localhost:7233)
 *   TEMPORAL_NAMESPACE   Temporal namespace (default: default)
 */

import { Client, Connection } from "@temporalio/client";
import { TASK_QUEUE } from "./worker.js";
import type { AgentTaskInput, AgentTaskResult, AgentTaskStatus } from "./workflows.js";

async function main() {
  const args = process.argv.slice(2);

  // Parse options
  let agent = "plant-manager";
  let title: string | undefined;
  let kiloHost = "127.0.0.1";
  let kiloPort = 4096;
  let timeoutMs = 1_800_000;
  let pollIntervalMs = 10_000;
  let noWait = false;
  let workflowId: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--agent":
        agent = args[++i];
        break;
      case "--title":
        title = args[++i];
        break;
      case "--host":
        kiloHost = args[++i];
        break;
      case "--port":
        kiloPort = parseInt(args[++i], 10);
        break;
      case "--timeout":
        timeoutMs = parseInt(args[++i], 10);
        break;
      case "--poll":
        pollIntervalMs = parseInt(args[++i], 10);
        break;
      case "--no-wait":
        noWait = true;
        break;
      case "--workflow-id":
        workflowId = args[++i];
        break;
      default:
        positional.push(args[i]);
    }
  }

  const prompt = positional.join(" ");
  if (!prompt) {
    console.error("Usage: npx tsx src/temporal/dispatch.ts [options] <prompt>");
    console.error("  or pipe prompt via stdin");
    process.exit(1);
  }

  const address = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
  const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";

  console.log(`[dispatch] Connecting to Temporal at ${address}...`);
  const connection = await Connection.connect({ address });
  const client = new Client({ connection, namespace });

  const wfId = workflowId ?? `agent-task-${Date.now()}`;

  const input: AgentTaskInput = {
    prompt,
    agent,
    title: title ?? `${agent}: ${prompt.slice(0, 60)}...`,
    kiloHost,
    kiloPort,
    pollIntervalMs,
    timeoutMs,
  };

  console.log(`[dispatch] Starting workflow: ${wfId}`);
  console.log(`[dispatch] Agent: ${agent}`);
  console.log(`[dispatch] Prompt: ${prompt.length} chars`);
  console.log(`[dispatch] kilo serve: ${kiloHost}:${kiloPort}`);

  const handle = await client.workflow.start("agentTaskWorkflow", {
    taskQueue: TASK_QUEUE,
    workflowId: wfId,
    args: [input],
  });

  console.log(`[dispatch] Workflow started: ${handle.workflowId}`);
  console.log(`[dispatch] Run ID: ${handle.firstExecutionRunId}`);

  if (noWait) {
    console.log("[dispatch] Fire-and-forget mode. Exiting.");
    console.log(`[dispatch] Query status: temporal workflow query --workflow-id ${wfId} --query status`);
    console.log(`[dispatch] View in UI: http://localhost:8233/namespaces/default/workflows/${wfId}`);
    process.exit(0);
  }

  // Wait for completion with periodic status queries
  console.log("[dispatch] Waiting for completion...");
  const statusInterval = setInterval(async () => {
    try {
      const status = await handle.query<AgentTaskStatus>("status");
      const elapsed = Math.round(status.elapsedMs / 1000);
      console.log(
        `[dispatch] [${elapsed}s] Phase: ${status.phase}, tools: ${status.toolCalls}, parts: ${status.totalParts}`
      );
    } catch {
      // Query may fail briefly during transitions
    }
  }, 15_000);

  try {
    const result: AgentTaskResult = await handle.result();
    clearInterval(statusInterval);

    console.log("\n[dispatch] ═══ Result ═══");
    console.log(`[dispatch] Status: ${result.status}`);
    console.log(`[dispatch] Session: ${result.sessionId}`);
    console.log(`[dispatch] Tools: ${result.toolCalls}`);
    console.log(`[dispatch] Parts: ${result.totalParts}`);
    console.log(`[dispatch] Duration: ${Math.round(result.durationMs / 1000)}s`);
    if (result.error) {
      console.log(`[dispatch] Error: ${result.error}`);
    }

    process.exit(result.status === "completed" ? 0 : 1);
  } catch (err) {
    clearInterval(statusInterval);
    console.error("[dispatch] Workflow failed:", err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[dispatch] Fatal error:", err);
  process.exit(1);
});
