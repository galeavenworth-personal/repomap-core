/**
 * Temporal Monitor CLI — Stable progress surface for agentTaskWorkflow.
 *
 * Usage:
 *   npx tsx src/temporal/monitor.cli.ts status <workflow-id>
 *   npx tsx src/temporal/monitor.cli.ts watch <workflow-id>
 *   npx tsx src/temporal/monitor.cli.ts abort <workflow-id>
 *
 * Environment:
 *   TEMPORAL_ADDRESS     Temporal server gRPC address (default: localhost:7233)
 *   TEMPORAL_NAMESPACE   Temporal namespace (default: default)
 */

import { Client, Connection } from "@temporalio/client";
import { Buffer } from "node:buffer";
import type { AgentTaskStatus } from "./workflows.js";

const DEFAULT_INTERVAL_MS = 5000;

type WorkflowHandle = ReturnType<Client["workflow"]["getHandle"]>;
type WorkflowExecutionDescription = Awaited<ReturnType<WorkflowHandle["describe"]>>;

interface HeartbeatProgressPayload {
  progress?: {
    activeLeaf?: {
      completedTools?: number;
      done?: boolean;
      label?: string | null;
      lastToolName?: string | null;
      phase?: AgentTaskStatus["leaf"]["phase"];
      runningTools?: number;
      sessionId?: string | null;
      thinking?: boolean;
    };
    childCount?: number;
    elapsedMs?: number;
    idleConfirmations?: number;
    lastProgressAt?: string | null;
    requiredIdleConfirmations?: number;
    tokensInput?: number;
    tokensOutput?: number;
    toolCalls?: number;
    totalCost?: number;
    totalParts?: number;
  };
}

interface PendingActivityLike {
  activityType?: { name?: string | null } | null;
  heartbeatDetails?: {
    payloads?: Array<{
      data?: string | Uint8Array | null;
    }>;
  } | null;
}

function usage(): never {
  console.error("Usage: npx tsx src/temporal/monitor.cli.ts <status|watch|abort> <workflow-id> [--interval <ms>]");
  process.exit(1);
}

function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatStatus(status: AgentTaskStatus): string {
  const totalTokens = status.tokensInput + status.tokensOutput;
  const leafLabel = status.leaf.label ?? "unknown";
  const session = status.sessionId ?? "pending";
  const progressAt = status.lastProgressAt ?? "n/a";
  return [
    `workflow phase   : ${status.phase}`,
    `session          : ${session}`,
    `elapsed          : ${formatDuration(status.elapsedMs)}`,
    `parts/tools      : ${status.totalParts}/${status.toolCalls}`,
    `children         : ${status.childCount}`,
    `cost/tokens      : $${status.totalCost.toFixed(2)} / ${totalTokens.toLocaleString()} tok`,
    `idle confirmations: ${status.idleConfirmations}/${status.requiredIdleConfirmations}`,
    `active leaf      : ${leafLabel}`,
    `leaf phase       : ${status.leaf.phase}`,
    `leaf tools       : running=${status.leaf.runningTools} completed=${status.leaf.completedTools}`,
    `leaf last tool   : ${status.leaf.lastToolName ?? "none"}`,
    `last progress    : ${progressAt}`,
    `error            : ${status.error ?? "none"}`,
  ].join("\n");
}

async function queryStatus(client: Client, workflowId: string): Promise<AgentTaskStatus> {
  const handle = client.workflow.getHandle(workflowId);
  return handle.query<AgentTaskStatus>("status");
}

function decodeHeartbeatPayload(activity: PendingActivityLike): HeartbeatProgressPayload | null {
  const encoded = activity.heartbeatDetails?.payloads?.[0]?.data;
  if (!encoded) {
    return null;
  }

  try {
    const json = typeof encoded === "string"
      ? Buffer.from(encoded, "base64").toString("utf8")
      : Buffer.from(encoded).toString("utf8");
    return JSON.parse(json) as HeartbeatProgressPayload;
  } catch {
    return null;
  }
}

function buildLiveStatusFromDescribe(
  described: WorkflowExecutionDescription,
  fallback: AgentTaskStatus | null,
): AgentTaskStatus | null {
  const pending = (described.raw?.pendingActivities ?? []) as PendingActivityLike[];
  const pollActivity = pending.find(
    (activity) => activity.activityType?.name === "pollUntilDone",
  );
  const heartbeat = pollActivity ? decodeHeartbeatPayload(pollActivity) : null;
  const progress = heartbeat?.progress;
  if (!progress) {
    return fallback;
  }

  return {
    phase: fallback?.phase ?? "agent_working",
    sessionId: progress.activeLeaf?.sessionId ?? fallback?.sessionId ?? null,
    toolCalls: progress.toolCalls ?? fallback?.toolCalls ?? 0,
    totalParts: progress.totalParts ?? fallback?.totalParts ?? 0,
    elapsedMs: progress.elapsedMs ?? fallback?.elapsedMs ?? 0,
    childCount: progress.childCount ?? fallback?.childCount ?? 0,
    totalCost: progress.totalCost ?? fallback?.totalCost ?? 0,
    tokensInput: progress.tokensInput ?? fallback?.tokensInput ?? 0,
    tokensOutput: progress.tokensOutput ?? fallback?.tokensOutput ?? 0,
    idleConfirmations: progress.idleConfirmations ?? fallback?.idleConfirmations ?? 0,
    requiredIdleConfirmations:
      progress.requiredIdleConfirmations ?? fallback?.requiredIdleConfirmations ?? 0,
    lastProgressAt: progress.lastProgressAt ?? fallback?.lastProgressAt ?? null,
    leaf: {
      sessionId: progress.activeLeaf?.sessionId ?? fallback?.leaf.sessionId ?? null,
      label: progress.activeLeaf?.label ?? fallback?.leaf.label ?? null,
      phase: progress.activeLeaf?.phase ?? fallback?.leaf.phase ?? "unknown",
      runningTools: progress.activeLeaf?.runningTools ?? fallback?.leaf.runningTools ?? 0,
      completedTools:
        progress.activeLeaf?.completedTools ?? fallback?.leaf.completedTools ?? 0,
      lastToolName: progress.activeLeaf?.lastToolName ?? fallback?.leaf.lastToolName ?? null,
      done: progress.activeLeaf?.done ?? fallback?.leaf.done ?? false,
      thinking: progress.activeLeaf?.thinking ?? fallback?.leaf.thinking ?? false,
    },
    error: fallback?.error ?? null,
  };
}

async function getMonitorStatus(client: Client, workflowId: string): Promise<AgentTaskStatus> {
  const handle = client.workflow.getHandle(workflowId);
  const described = await handle.describe();
  let fallback: AgentTaskStatus | null = null;
  try {
    fallback = await handle.query<AgentTaskStatus>("status");
  } catch {
    fallback = null;
  }

  return (
    buildLiveStatusFromDescribe(described, fallback) ??
    fallback ?? {
      phase: "unknown",
      sessionId: null,
      toolCalls: 0,
      totalParts: 0,
      elapsedMs: 0,
      childCount: 0,
      totalCost: 0,
      tokensInput: 0,
      tokensOutput: 0,
      idleConfirmations: 0,
      requiredIdleConfirmations: 0,
      lastProgressAt: null,
      leaf: {
        sessionId: null,
        label: null,
        phase: "unknown",
        runningTools: 0,
        completedTools: 0,
        lastToolName: null,
        done: false,
        thinking: false,
      },
      error: null,
    }
  );
}

async function handleStatus(client: Client, workflowId: string): Promise<void> {
  const status = await getMonitorStatus(client, workflowId);
  console.log(formatStatus(status));
}

async function handleWatch(client: Client, workflowId: string, intervalMs: number): Promise<void> {
  let lastRendered = "";
  while (true) {
    try {
      const status = await getMonitorStatus(client, workflowId);
      const rendered = formatStatus(status);
      if (rendered !== lastRendered) {
        console.log(`\n[monitor] ${new Date().toISOString()}`);
        console.log(rendered);
        lastRendered = rendered;
      }
      if (["completed", "failed", "aborted", "validation_failed"].includes(status.phase)) {
        return;
      }
    } catch (err) {
      console.error(`[monitor] Query failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function handleAbort(client: Client, workflowId: string): Promise<void> {
  const handle = client.workflow.getHandle(workflowId);
  await handle.signal("abort");
  console.log(`[monitor] Abort signal sent: ${workflowId}`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const workflowId = process.argv[3];
  if (!command || !workflowId) usage();

  let intervalMs = DEFAULT_INTERVAL_MS;
  for (let i = 4; i < process.argv.length; i++) {
    if (process.argv[i] === "--interval") {
      intervalMs = Number.parseInt(process.argv[++i] ?? "", 10);
    }
  }

  const address = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
  const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
  const connection = await Connection.connect({ address });
  const client = new Client({ connection, namespace });

  if (command === "status") {
    await handleStatus(client, workflowId);
    return;
  }
  if (command === "watch") {
    await handleWatch(client, workflowId, intervalMs);
    return;
  }
  if (command === "abort") {
    await handleAbort(client, workflowId);
    return;
  }

  usage();
}

main().catch((err) => {
  console.error("[monitor] Fatal error:", err);
  process.exit(1);
});
