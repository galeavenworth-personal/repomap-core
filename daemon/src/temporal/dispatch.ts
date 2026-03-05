/**
 * Temporal Dispatch CLI — Thin Client for kilo serve
 *
 * CLI tool to start agentTaskWorkflow executions via Temporal.
 * This is a thin durability wrapper — all orchestration intelligence
 * lives in the kilo serve mode system.
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
import { execFileSync } from "node:child_process";
import { createConnection } from "node:net";
import type { AgentTaskInput, AgentTaskResult, AgentTaskStatus } from "./workflows.js";

const TASK_QUEUE = "agent-tasks";

interface ParsedArgs {
  agent: string;
  title: string | undefined;
  kiloHost: string;
  kiloPort: number;
  timeoutMs: number;
  pollIntervalMs: number;
  noWait: boolean;
  workflowId: string | undefined;
  prompt: string;
}

function parseDispatchArgs(args: string[]): ParsedArgs {
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
        kiloPort = Number.parseInt(args[++i], 10);
        break;
      case "--timeout":
        timeoutMs = Number.parseInt(args[++i], 10);
        break;
      case "--poll":
        pollIntervalMs = Number.parseInt(args[++i], 10);
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

  return {
    agent,
    title,
    kiloHost,
    kiloPort,
    timeoutMs,
    pollIntervalMs,
    noWait,
    workflowId,
    prompt: positional.join(" "),
  };
}

async function canConnectTcp(host: string, port: number): Promise<boolean> {
  try {
    await new Promise<void>((resolve, reject) => {
      const sock = createConnection({ host, port }, () => {
        sock.destroy();
        resolve();
      });
      sock.on("error", reject);
      sock.setTimeout(2000, () => {
        sock.destroy();
        reject(new Error("timeout"));
      });
    });
    return true;
  } catch {
    return false;
  }
}

async function runPreflightChecks(
  kiloHost: string,
  kiloPort: number,
  doltPort: number,
  address: string,
): Promise<boolean> {
  console.log("[dispatch] Pre-flight: checking all 5 stack components...");
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  try {
    const res = await fetch(`http://${kiloHost}:${kiloPort}/session`);
    checks.push({ name: "kilo serve", ok: res.ok, detail: `${kiloHost}:${kiloPort}` });
  } catch {
    checks.push({ name: "kilo serve", ok: false, detail: `${kiloHost}:${kiloPort} unreachable` });
  }

  const doltOk = await canConnectTcp("127.0.0.1", doltPort);
  checks.push({
    name: "Dolt server",
    ok: doltOk,
    detail: doltOk ? `port ${doltPort}` : `port ${doltPort} not listening`,
  });

  let ocDaemonOk = false;
  try {
    execFileSync("pgrep", ["-f", "tsx.*oc-daemon/src/index.ts"], { stdio: "pipe" });
    ocDaemonOk = true;
  } catch {
    try {
      execFileSync("pgrep", ["-f", "node.*oc-daemon/build/index.js"], { stdio: "pipe" });
      ocDaemonOk = true;
    } catch {
      // neither process found
    }
  }
  checks.push({
    name: "oc-daemon",
    ok: ocDaemonOk,
    detail: ocDaemonOk ? "SSE → Dolt" : "NOT running (no flight recorder!)",
  });

  const [host, portStr] = address.split(":");
  const temporalOk = await canConnectTcp(host, Number.parseInt(portStr, 10));
  checks.push({
    name: "Temporal server",
    ok: temporalOk,
    detail: temporalOk ? address : `${address} not reachable`,
  });

  try {
    execFileSync("pgrep", ["-f", "tsx.*src/temporal/worker.ts"], { stdio: "pipe" });
    checks.push({ name: "Temporal worker", ok: true, detail: "polling agent-tasks" });
  } catch {
    checks.push({ name: "Temporal worker", ok: false, detail: "NOT running" });
  }

  let allOk = true;
  for (const c of checks) {
    const icon = c.ok ? "✅" : "❌";
    console.log(`[dispatch]   ${icon} ${c.name}: ${c.detail}`);
    if (!c.ok) allOk = false;
  }
  return allOk;
}

async function main() {
  const parsed = parseDispatchArgs(process.argv.slice(2));
  const {
    agent,
    title,
    kiloHost,
    kiloPort,
    timeoutMs,
    pollIntervalMs,
    noWait,
    workflowId,
    prompt,
  } = parsed;
  if (!prompt) {
    console.error("Usage: npx tsx src/temporal/dispatch.ts [options] <prompt>");
    console.error("  or pipe prompt via stdin");
    process.exit(1);
  }

  const address = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
  const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
  const doltPort = Number.parseInt(process.env.DOLT_PORT ?? "3307", 10);

  const allOk = await runPreflightChecks(kiloHost, kiloPort, doltPort, address);

  if (!allOk) {
    console.error("\n═══════════════════════════════════════════════════════════");
    console.error(" DISPATCH BLOCKED — Stack is incomplete");
    console.error("═══════════════════════════════════════════════════════════");
    console.error("Start the full stack first:");
    console.error("  .kilocode/tools/start-stack.sh");
    console.error("Or check status with:");
    console.error("  .kilocode/tools/start-stack.sh --check");
    console.error("═══════════════════════════════════════════════════════════");
    process.exit(2);
  }

  console.log("[dispatch] Pre-flight passed (5/5 components healthy)");

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
    console.log(`[dispatch] Cost: $${result.totalCost?.toFixed(2) ?? "??"}`);
    console.log(`[dispatch] Tokens: ${((result.tokensInput ?? 0) + (result.tokensOutput ?? 0)).toLocaleString()} (in: ${(result.tokensInput ?? 0).toLocaleString()}, out: ${(result.tokensOutput ?? 0).toLocaleString()})`);
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
