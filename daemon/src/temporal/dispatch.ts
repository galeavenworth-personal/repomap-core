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
import type { AgentTaskInput, AgentTaskResult, AgentTaskStatus } from "./workflows.js";

const TASK_QUEUE = "agent-tasks";

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
  const doltPort = parseInt(process.env.DOLT_PORT ?? "3307", 10);

  // ── Pre-flight: ALL 5 stack components must be running ──
  // No partial stacks. No unrecorded sessions.
  console.log("[dispatch] Pre-flight: checking all 5 stack components...");
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  // 1. kilo serve
  try {
    const res = await fetch(`http://${kiloHost}:${kiloPort}/session`);
    checks.push({ name: "kilo serve", ok: res.ok, detail: `${kiloHost}:${kiloPort}` });
  } catch {
    checks.push({ name: "kilo serve", ok: false, detail: `${kiloHost}:${kiloPort} unreachable` });
  }

  // 2. Dolt server (TCP check via fetch to MySQL port — will fail HTTP parse but connect succeeds)
  try {
    await new Promise<void>((resolve, reject) => {
      const { createConnection } = require("net") as typeof import("net");
      const sock = createConnection({ host: "127.0.0.1", port: doltPort }, () => {
        sock.destroy();
        resolve();
      });
      sock.on("error", reject);
      sock.setTimeout(2000, () => { sock.destroy(); reject(new Error("timeout")); });
    });
    checks.push({ name: "Dolt server", ok: true, detail: `port ${doltPort}` });
  } catch {
    checks.push({ name: "Dolt server", ok: false, detail: `port ${doltPort} not listening` });
  }

  // 3. oc-daemon (check via process list — exec pgrep)
  try {
    const { execSync } = require("child_process") as typeof import("child_process");
    execSync('pgrep -f "tsx.*oc-daemon/src/index.ts" || pgrep -f "node.*oc-daemon/build/index.js"', { stdio: "pipe" });
    checks.push({ name: "oc-daemon", ok: true, detail: "SSE → Dolt" });
  } catch {
    checks.push({ name: "oc-daemon", ok: false, detail: "NOT running (no flight recorder!)" });
  }

  // 4. Temporal server (we'll know when we try to connect, but pre-check port)
  try {
    await new Promise<void>((resolve, reject) => {
      const { createConnection } = require("net") as typeof import("net");
      const [host, portStr] = address.split(":");
      const sock = createConnection({ host, port: parseInt(portStr, 10) }, () => {
        sock.destroy();
        resolve();
      });
      sock.on("error", reject);
      sock.setTimeout(2000, () => { sock.destroy(); reject(new Error("timeout")); });
    });
    checks.push({ name: "Temporal server", ok: true, detail: address });
  } catch {
    checks.push({ name: "Temporal server", ok: false, detail: `${address} not reachable` });
  }

  // 5. Temporal worker (check via process list)
  try {
    const { execSync } = require("child_process") as typeof import("child_process");
    execSync('pgrep -f "tsx.*src/temporal/worker.ts"', { stdio: "pipe" });
    checks.push({ name: "Temporal worker", ok: true, detail: "polling agent-tasks" });
  } catch {
    checks.push({ name: "Temporal worker", ok: false, detail: "NOT running" });
  }

  // Report and gate
  let allOk = true;
  for (const c of checks) {
    const icon = c.ok ? "✅" : "❌";
    console.log(`[dispatch]   ${icon} ${c.name}: ${c.detail}`);
    if (!c.ok) allOk = false;
  }

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
