/**
 * Foreman CLI — Operator Control Surface
 *
 * Thin CLI for starting, inspecting, and controlling the foreman workflow.
 * Follows the manual-arg Temporal CLI pattern used by dispatch.ts,
 * monitor.cli.ts, and dep-watch.cli.ts.
 *
 * Usage:
 *   npx tsx src/temporal/foreman.cli.ts start [options]
 *   npx tsx src/temporal/foreman.cli.ts status [--workflow-id <id>]
 *   npx tsx src/temporal/foreman.cli.ts watch [--workflow-id <id>] [--interval <ms>]
 *   npx tsx src/temporal/foreman.cli.ts pause [--workflow-id <id>]
 *   npx tsx src/temporal/foreman.cli.ts resume [--workflow-id <id>]
 *   npx tsx src/temporal/foreman.cli.ts shutdown [--workflow-id <id>] [--reason <text>]
 *   npx tsx src/temporal/foreman.cli.ts approve-dispatch [--workflow-id <id>] --bead <beadId>
 *   npx tsx src/temporal/foreman.cli.ts approve-outcome [--workflow-id <id>] --bead <beadId> --decision <close|retry|skip>
 *
 * Start options:
 *   --epic <epicId>            Epic ID for workflow naming (default: "default")
 *   --poll-interval <ms>       Poll interval in ms (default: 30000)
 *   --max-iterations <n>       Max iterations per continue-as-new (default: 500)
 *   --repo-path <path>         Repository path (default: cwd)
 *   --workflow-id <id>         Custom workflow ID (default: foreman-<epicId>)
 *   --kilo-host <host>         kilo serve host (default: 127.0.0.1)
 *   --kilo-port <port>         kilo serve port (default: 4096)
 *   --max-wall-clock <ms>      Max wall-clock time per run (default: 3600000)
 *   --max-concurrent <n>       Max concurrent dispatches (default: 1)
 *   --default-timeout <ms>     Default dispatch timeout (default: 1800000)
 *   --default-budget <usd>     Default cost budget per dispatch (default: 5)
 *   --max-retries <n>          Max retries per bead (default: 2)
 *   --retry-backoff <ms>       Retry backoff base in ms (default: 60000)
 *   --health-check-interval <ms>  Health check interval (default: 60000)
 *   --health-failure-threshold <n> Consecutive failures before intervention (default: 5)
 *
 * Environment:
 *   TEMPORAL_ADDRESS     Temporal server gRPC address (default: localhost:7233)
 *   TEMPORAL_NAMESPACE   Temporal namespace (default: default)
 *   DOLT_HOST            Dolt server host (default: 127.0.0.1)
 *   DOLT_PORT            Dolt server port (default: 3307)
 *   DOLT_DATABASE        Dolt database name (default: beads_repomap-core)
 */

import { Client, Connection } from "@temporalio/client";
import { formatDuration } from "../infra/cli-format.js";
import type {
  ForemanInput,
  ForemanStatus,
  ForemanPhase,
  HealthCheckResult,
  DispatchOutcome,
  ApprovalDecision,
} from "./foreman.types.js";

// ── Constants ──

const TASK_QUEUE = "agent-tasks";
const DEFAULT_WORKFLOW_ID_PREFIX = "foreman";
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_MAX_ITERATIONS = 500;
const DEFAULT_MAX_WALL_CLOCK_MS = 3_600_000; // 1 hour
const DEFAULT_MAX_CONCURRENT = 1;
const DEFAULT_TIMEOUT_MS = 1_800_000; // 30 min
const DEFAULT_BUDGET_USD = 5;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BACKOFF_MS = 60_000;
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 60_000;
const DEFAULT_HEALTH_FAILURE_THRESHOLD = 5;
const DEFAULT_WATCH_INTERVAL_MS = 2_000;

// ── Arg Parsing ──

interface ParsedArgs {
  command: string | undefined;
  workflowId: string | undefined;
  epic: string;
  pollIntervalMs: number;
  maxIterations: number;
  repoPath: string;
  kiloHost: string;
  kiloPort: number;
  maxWallClockMs: number;
  maxConcurrent: number;
  defaultTimeoutMs: number;
  defaultBudgetUsd: number;
  maxRetries: number;
  retryBackoffMs: number;
  healthCheckIntervalMs: number;
  healthFailureThreshold: number;
  watchIntervalMs: number;
  beadId: string | undefined;
  decision: string | undefined;
  reason: string | undefined;
}

function parseArgs(argv: string[]): ParsedArgs {
  let command: string | undefined;
  let workflowId: string | undefined;
  let epic = "default";
  let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
  let maxIterations = DEFAULT_MAX_ITERATIONS;
  let repoPath = process.cwd();
  let kiloHost = "127.0.0.1";
  let kiloPort = 4096;
  let maxWallClockMs = DEFAULT_MAX_WALL_CLOCK_MS;
  let maxConcurrent = DEFAULT_MAX_CONCURRENT;
  let defaultTimeoutMs = DEFAULT_TIMEOUT_MS;
  let defaultBudgetUsd = DEFAULT_BUDGET_USD;
  let maxRetries = DEFAULT_MAX_RETRIES;
  let retryBackoffMs = DEFAULT_RETRY_BACKOFF_MS;
  let healthCheckIntervalMs = DEFAULT_HEALTH_CHECK_INTERVAL_MS;
  let healthFailureThreshold = DEFAULT_HEALTH_FAILURE_THRESHOLD;
  let watchIntervalMs = DEFAULT_WATCH_INTERVAL_MS;
  let beadId: string | undefined;
  let decision: string | undefined;
  let reason: string | undefined;

  const args = argv.slice(2);
  if (args.length > 0 && !args[0].startsWith("--")) {
    command = args[0];
  }

  for (let i = command ? 1 : 0; i < args.length; i++) {
    switch (args[i]) {
      case "--workflow-id":
        workflowId = args[++i];
        break;
      case "--epic":
        epic = args[++i];
        break;
      case "--poll-interval":
        pollIntervalMs = Number.parseInt(args[++i], 10);
        break;
      case "--max-iterations":
        maxIterations = Number.parseInt(args[++i], 10);
        break;
      case "--repo-path":
        repoPath = args[++i];
        break;
      case "--kilo-host":
        kiloHost = args[++i];
        break;
      case "--kilo-port":
        kiloPort = Number.parseInt(args[++i], 10);
        break;
      case "--max-wall-clock":
        maxWallClockMs = Number.parseInt(args[++i], 10);
        break;
      case "--max-concurrent":
        maxConcurrent = Number.parseInt(args[++i], 10);
        break;
      case "--default-timeout":
        defaultTimeoutMs = Number.parseInt(args[++i], 10);
        break;
      case "--default-budget":
        defaultBudgetUsd = Number.parseFloat(args[++i]);
        break;
      case "--max-retries":
        maxRetries = Number.parseInt(args[++i], 10);
        break;
      case "--retry-backoff":
        retryBackoffMs = Number.parseInt(args[++i], 10);
        break;
      case "--health-check-interval":
        healthCheckIntervalMs = Number.parseInt(args[++i], 10);
        break;
      case "--health-failure-threshold":
        healthFailureThreshold = Number.parseInt(args[++i], 10);
        break;
      case "--interval":
        watchIntervalMs = Number.parseInt(args[++i], 10);
        break;
      case "--bead":
        beadId = args[++i];
        break;
      case "--decision":
        decision = args[++i];
        break;
      case "--reason":
        reason = args[++i];
        break;
      case "--help":
        command = "help";
        break;
      default:
        // Unknown flag — ignore
        break;
    }
  }

  return {
    command,
    workflowId,
    epic,
    pollIntervalMs,
    maxIterations,
    repoPath,
    kiloHost,
    kiloPort,
    maxWallClockMs,
    maxConcurrent,
    defaultTimeoutMs,
    defaultBudgetUsd,
    maxRetries,
    retryBackoffMs,
    healthCheckIntervalMs,
    healthFailureThreshold,
    watchIntervalMs,
    beadId,
    decision,
    reason,
  };
}

// ── Formatting ──

function formatPhase(phase: ForemanPhase): string {
  const icons: Record<ForemanPhase, string> = {
    polling: "[poll]",
    health_check: "[health]",
    selecting: "[select]",
    dispatching: "[dispatch]",
    monitoring: "[monitor]",
    completing: "[complete]",
    failing: "[fail]",
    retrying: "[retry]",
    escalating: "[escalate]",
    idle: "[idle]",
    paused: "[PAUSED]",
    shutting_down: "[SHUTDOWN]",
    awaiting_intervention: "[INTERVENTION]",
    awaiting_approval: "[APPROVAL]",
  };
  return icons[phase] ?? `[${phase}]`;
}

function formatHealthStatus(health: HealthCheckResult): string {
  const lines: string[] = [
    `  overall: ${health.overall}`,
    `  checked: ${health.checkedAt}`,
  ];
  for (const [name, sub] of Object.entries(health.subsystems)) {
    lines.push(`    ${name}: ${sub.status}${sub.message ? ` — ${sub.message}` : ""}${sub.latencyMs != null ? ` (${sub.latencyMs}ms)` : ""}`);
  }
  return lines.join("\n");
}

function formatStatus(status: ForemanStatus): string {
  const lines: string[] = [
    `phase              : ${formatPhase(status.phase)} ${status.phase}`,
    `current bead       : ${status.currentBeadId ?? "none"}`,
    `current workflow    : ${status.currentWorkflowId ?? "none"}`,
    `iteration          : ${status.iterationCount} (lifetime: ${status.lifetimeIterations})`,
    `dispatches         : ${status.lifetimeDispatches}`,
    `completions        : ${status.lifetimeCompletions}`,
    `failures           : ${status.lifetimeFailures}`,
    `escalations        : ${status.lifetimeEscalations}`,
    `uptime             : ${formatDuration(status.uptime)}`,
    `paused             : ${status.paused}`,
    `shutting down      : ${status.shuttingDown}`,
  ];

  if (status.interventionReason) {
    lines.push(`intervention       : ${status.interventionReason}`);
    lines.push(`awaiting since     : ${status.awaitingInterventionSince ?? "unknown"}`);
  }

  if (status.lastHealthCheck) {
    lines.push(`health:`);
    lines.push(formatHealthStatus(status.lastHealthCheck));
  }

  if (status.retryLedger.length > 0) {
    lines.push(`retry ledger:`);
    for (const entry of status.retryLedger) {
      lines.push(`  ${entry.beadId}: ${entry.attempts}/${entry.maxAttempts} attempts${entry.exhausted ? " [EXHAUSTED]" : ""}`);
    }
  }

  if (status.recentOutcomes.length > 0) {
    lines.push(`recent outcomes (last ${status.recentOutcomes.length}):`);
    for (const outcome of status.recentOutcomes.slice(-5)) {
      const result = outcome.result.kind;
      lines.push(`  ${outcome.beadId}: ${result} (${formatDuration(outcome.durationMs)}, $${outcome.totalCost.toFixed(2)})`);
    }
  }

  return lines.join("\n");
}

// ── Temporal Client ──

async function createClient(): Promise<Client> {
  if (temporalClient) {
    return temporalClient;
  }

  const address = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
  const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
  temporalConnection = await Connection.connect({ address });
  temporalClient = new Client({ connection: temporalConnection, namespace });
  return temporalClient;
}

let temporalConnection: Connection | null = null;
let temporalClient: Client | null = null;

async function closeTemporalConnection(): Promise<void> {
  const conn = temporalConnection;
  temporalClient = null;
  temporalConnection = null;
  if (!conn) {
    return;
  }

  try {
    await conn.close();
  } catch {
    // Best-effort close on CLI shutdown
  }
}

function resolveWorkflowId(parsed: ParsedArgs): string {
  if (parsed.workflowId) return parsed.workflowId;
  return `${DEFAULT_WORKFLOW_ID_PREFIX}-${parsed.epic}`;
}

// ── Command Handlers ──

async function handleStart(parsed: ParsedArgs): Promise<void> {
  const client = await createClient();

  const doltHost = process.env.DOLT_HOST ?? "127.0.0.1";
  const doltPort = Number.parseInt(process.env.DOLT_PORT ?? "3307", 10);
  const doltDatabase = process.env.DOLT_DATABASE ?? "beads_repomap-core";

  const wfId = resolveWorkflowId(parsed);

  const input: ForemanInput = {
    workflowId: wfId,
    repoPath: parsed.repoPath,
    taskQueue: TASK_QUEUE,
    kiloHost: parsed.kiloHost,
    kiloPort: parsed.kiloPort,
    doltHost,
    doltPort,
    doltDatabase,
    pollIntervalMs: parsed.pollIntervalMs,
    healthCheckIntervalMs: parsed.healthCheckIntervalMs,
    maxIterations: parsed.maxIterations,
    maxWallClockMs: parsed.maxWallClockMs,
    maxConcurrentDispatches: parsed.maxConcurrent,
    defaultTimeoutMs: parsed.defaultTimeoutMs,
    defaultCostBudgetUsd: parsed.defaultBudgetUsd,
    maxRetriesPerBead: parsed.maxRetries,
    retryBackoffMs: parsed.retryBackoffMs,
    healthFailureThreshold: parsed.healthFailureThreshold,
    carriedState: null,
  };

  console.log(`[foreman] Starting workflow: ${wfId}`);
  console.log(`[foreman] Repo: ${parsed.repoPath}`);
  console.log(`[foreman] Task queue: ${TASK_QUEUE}`);
  console.log(`[foreman] Poll interval: ${parsed.pollIntervalMs}ms`);
  console.log(`[foreman] Max iterations: ${parsed.maxIterations}`);

  const handle = await client.workflow.start("foremanWorkflow", {
    taskQueue: TASK_QUEUE,
    workflowId: wfId,
    args: [input],
  });

  console.log(`[foreman] Workflow started: ${handle.workflowId}`);
  console.log(`[foreman] Run ID: ${handle.firstExecutionRunId}`);
  console.log(`[foreman] View: http://localhost:8233/namespaces/default/workflows/${wfId}`);
}

async function handleStatus(parsed: ParsedArgs): Promise<void> {
  const client = await createClient();
  const wfId = resolveWorkflowId(parsed);
  const handle = client.workflow.getHandle(wfId);
  const status = await handle.query<ForemanStatus>("foreman.status");
  console.log(formatStatus(status));
}

async function handleWatch(parsed: ParsedArgs): Promise<void> {
  const client = await createClient();
  const wfId = resolveWorkflowId(parsed);
  const handle = client.workflow.getHandle(wfId);
  let lastRendered = "";

  const terminalPhases = new Set<ForemanPhase>(["shutting_down"]);
  const terminalWorkflowStatuses = new Set([
    "COMPLETED", "FAILED", "CANCELLED", "TERMINATED", "TIMED_OUT",
  ]);

  console.log(`[foreman] Watching workflow: ${wfId} (interval: ${parsed.watchIntervalMs}ms)`);

  while (true) {
    try {
      const status = await handle.query<ForemanStatus>("foreman.status");
      const rendered = formatStatus(status);
      if (rendered !== lastRendered) {
        console.log(`\n[foreman] ${new Date().toISOString()}`);
        console.log(rendered);
        lastRendered = rendered;
      }

      // Check for terminal phase
      if (terminalPhases.has(status.phase)) {
        console.log("\n[foreman] Workflow reached terminal phase.");
        return;
      }

      // Check Temporal execution status
      try {
        const described = await handle.describe();
        const rawStatus = described.status?.name ?? "";
        if (terminalWorkflowStatuses.has(rawStatus)) {
          console.log(`\n[foreman] Workflow execution terminal: ${rawStatus}`);
          return;
        }
      } catch {
        // describe may fail transiently
      }
    } catch (err) {
      console.error(`[foreman] Query failed: ${err instanceof Error ? err.message : String(err)}`);

      // If query fails, check if workflow is terminal
      try {
        const described = await handle.describe();
        const rawStatus = described.status?.name ?? "";
        if (terminalWorkflowStatuses.has(rawStatus)) {
          console.log(`\n[foreman] Workflow execution terminal: ${rawStatus}`);
          return;
        }
      } catch {
        // If describe also fails, keep polling
      }
    }

    await new Promise((resolve) => setTimeout(resolve, parsed.watchIntervalMs));
  }
}

async function handlePause(parsed: ParsedArgs): Promise<void> {
  const client = await createClient();
  const wfId = resolveWorkflowId(parsed);
  const handle = client.workflow.getHandle(wfId);
  await handle.signal("foreman.pause");
  console.log(`[foreman] Pause signal sent: ${wfId}`);
  console.log("[foreman] The foreman will finish its current dispatch before pausing.");
}

async function handleResume(parsed: ParsedArgs): Promise<void> {
  const client = await createClient();
  const wfId = resolveWorkflowId(parsed);
  const handle = client.workflow.getHandle(wfId);
  await handle.signal("foreman.resume");
  console.log(`[foreman] Resume signal sent: ${wfId}`);
}

async function handleShutdown(parsed: ParsedArgs): Promise<void> {
  const client = await createClient();
  const wfId = resolveWorkflowId(parsed);
  const handle = client.workflow.getHandle(wfId);
  const reason = parsed.reason ?? "Operator-initiated shutdown";
  await handle.signal("foreman.shutdown", { reason });
  console.log(`[foreman] Shutdown signal sent: ${wfId}`);
  console.log(`[foreman] Reason: ${reason}`);
  console.log("[foreman] The foreman will finish its current bead before exiting.");
}

async function handleApproveDispatch(parsed: ParsedArgs): Promise<void> {
  if (!parsed.beadId) {
    console.error("[foreman] ERROR: --bead <beadId> is required for approve-dispatch");
    process.exit(1);
  }
  const client = await createClient();
  const wfId = resolveWorkflowId(parsed);
  const handle = client.workflow.getHandle(wfId);
  await handle.signal("foreman.approveDispatch", { beadId: parsed.beadId });
  console.log(`[foreman] Dispatch approved: bead ${parsed.beadId} on workflow ${wfId}`);
}

async function handleApproveOutcome(parsed: ParsedArgs): Promise<void> {
  if (!parsed.beadId) {
    console.error("[foreman] ERROR: --bead <beadId> is required for approve-outcome");
    process.exit(1);
  }
  if (!parsed.decision) {
    console.error("[foreman] ERROR: --decision <close|retry|skip> is required for approve-outcome");
    process.exit(1);
  }
  const validDecisions: ApprovalDecision[] = ["close", "retry", "skip"];
  if (!validDecisions.includes(parsed.decision as ApprovalDecision)) {
    console.error(`[foreman] ERROR: --decision must be one of: ${validDecisions.join(", ")}`);
    process.exit(1);
  }
  const client = await createClient();
  const wfId = resolveWorkflowId(parsed);
  const handle = client.workflow.getHandle(wfId);
  await handle.signal("foreman.approveOutcome", {
    beadId: parsed.beadId,
    decision: parsed.decision as ApprovalDecision,
  });
  console.log(`[foreman] Outcome approval sent: bead ${parsed.beadId}, decision=${parsed.decision} on workflow ${wfId}`);
}

// ── Help ──

function printUsage(): void {
  console.log(`Foreman CLI — Operator Control Surface

Usage:
  npx tsx src/temporal/foreman.cli.ts <command> [options]

Commands:
  start              Start a new foreman workflow instance
  status             Query the foreman workflow for current status
  watch              Live-poll status updates
  pause              Send pause signal to foreman workflow
  resume             Send resume signal to foreman workflow
  shutdown           Send shutdown signal to foreman workflow
  approve-dispatch   Send approveDispatch signal with bead ID
  approve-outcome    Send approveOutcome signal with bead ID and decision

Common options:
  --workflow-id <id>   Workflow ID (default: foreman-<epicId>)
  --help               Show this help

Start options:
  --epic <epicId>                    Epic ID (default: "default")
  --repo-path <path>                 Repository path (default: cwd)
  --poll-interval <ms>               Poll interval (default: 30000)
  --max-iterations <n>               Max iterations (default: 500)
  --kilo-host <host>                 kilo serve host (default: 127.0.0.1)
  --kilo-port <port>                 kilo serve port (default: 4096)
  --max-wall-clock <ms>              Wall-clock limit (default: 3600000)
  --max-concurrent <n>               Concurrent dispatches (default: 1)
  --default-timeout <ms>             Dispatch timeout (default: 1800000)
  --default-budget <usd>             Cost budget per dispatch (default: 5)
  --max-retries <n>                  Retries per bead (default: 2)
  --retry-backoff <ms>               Retry backoff base (default: 60000)
  --health-check-interval <ms>       Health check interval (default: 60000)
  --health-failure-threshold <n>     Failures before intervention (default: 5)

Watch options:
  --interval <ms>    Poll interval for watch (default: 2000)

Approve-dispatch options:
  --bead <beadId>    Bead ID to approve

Approve-outcome options:
  --bead <beadId>              Bead ID
  --decision <close|retry|skip>  Outcome decision

Shutdown options:
  --reason <text>    Shutdown reason (default: "Operator-initiated shutdown")

Environment:
  TEMPORAL_ADDRESS     Temporal server gRPC (default: localhost:7233)
  TEMPORAL_NAMESPACE   Temporal namespace (default: default)
  DOLT_HOST            Dolt host (default: 127.0.0.1)
  DOLT_PORT            Dolt port (default: 3307)
  DOLT_DATABASE        Dolt database (default: beads_repomap-core)`);
}

// ── Main ──

const COMMAND_HANDLERS: Record<string, (parsed: ParsedArgs) => Promise<void>> = {
  start: handleStart,
  status: handleStatus,
  watch: handleWatch,
  pause: handlePause,
  resume: handleResume,
  shutdown: handleShutdown,
  "approve-dispatch": handleApproveDispatch,
  "approve-outcome": handleApproveOutcome,
};

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);

  if (!parsed.command || parsed.command === "help") {
    printUsage();
    process.exit(parsed.command === "help" ? 0 : 1);
  }

  const handler = COMMAND_HANDLERS[parsed.command];
  if (!handler) {
    console.error(`[foreman] Unknown command: ${parsed.command}`);
    printUsage();
    process.exit(1);
  }

  try {
    await handler(parsed);
  } finally {
    await closeTemporalConnection();
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("[foreman] Fatal error:", err);
  process.exit(1);
});
