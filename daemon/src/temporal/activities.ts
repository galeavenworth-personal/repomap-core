/**
 * Temporal Activities — Thin Client for kilo serve
 *
 * Activities contain all I/O: HTTP calls to kilo serve, polling, health checks.
 * Each activity is independently retryable by Temporal. The workflow orchestrates
 * the sequence; activities do the actual work.
 *
 * This is a thin durability wrapper. All orchestration intelligence lives in
 * the kilo serve mode system (.kilocodemodes), contracts, and workflows.
 * Temporal adds: retry, durability, observability. Nothing else.
 */

import { createOpencodeClient } from "@opencode-ai/sdk/client";
import { heartbeat, log } from "@temporalio/activity";

import {
  injectCardExitPrompt,
  resolveCardExitPrompt,
} from "../optimization/prompt-injection.js";
import type { DoltConfig } from "../writer/index.js";
import type { AgentTaskHeartbeatProgress } from "./workflows.js";

export interface KiloConfig {
  kiloHost: string;
  kiloPort: number;
}

export interface SessionInfo {
  sessionId: string;
  title?: string;
}

export interface ProgressSnapshot {
  totalParts: number;
  toolCalls: number;
  completedTools: number;
  runningTools: number;
  lastToolName: string | null;
  done: boolean;
  thinking: boolean;
  totalCost: number;
  tokensInput: number;
  tokensOutput: number;
}

export interface ActiveLeafProgress {
  sessionId: string;
  label: string;
  phase: "thinking" | "tools_running" | "working" | "idle";
  runningTools: number;
  completedTools: number;
  lastToolName: string | null;
  done: boolean;
  thinking: boolean;
}

export interface AgentResult {
  sessionId: string;
  totalParts: number;
  toolCalls: number;
  durationMs: number;
  totalCost: number;
  tokensInput: number;
  tokensOutput: number;
  childCount: number;
  idleConfirmations: number;
  requiredIdleConfirmations: number;
  lastProgressAt: string;
  activeLeaf: ActiveLeafProgress;
}

function createKiloClient(config: KiloConfig) {
  return createOpencodeClient({
    baseUrl: `http://${config.kiloHost}:${config.kiloPort}`,
  });
}

function kiloUrl(config: KiloConfig, path: string): string {
  return `http://${config.kiloHost}:${config.kiloPort}${path}`;
}

/**
 * Health check — verify kilo serve is responding.
 */
export async function healthCheck(config: KiloConfig): Promise<string> {
  const res = await fetch(kiloUrl(config, "/session"));
  if (!res.ok) {
    throw new Error(`kilo serve health check failed: HTTP ${res.status}`);
  }
  log.info("kilo serve health check passed");
  return "ok";
}

/**
 * Create a new kilo serve session.
 */
export async function createSession(
  config: KiloConfig,
  title?: string
): Promise<SessionInfo> {
  const res = await fetch(kiloUrl(config, "/session"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(title ? { title } : {}),
  });
  if (!res.ok) {
    throw new Error(`Failed to create session: HTTP ${res.status}`);
  }
  const data = await res.json() as Record<string, unknown>;
  const sessionId = data.id as string;
  const titleSuffix = title ? ` (${title})` : "";
  log.info(`Session created: ${sessionId}${titleSuffix}`);

  return { sessionId, title };
}

/**
 * Find all child session IDs for a given parent.
 */
async function getChildSessionIds(config: KiloConfig, parentId: string): Promise<string[]> {
  try {
    const res = await fetch(kiloUrl(config, `/session/${parentId}/children`));
    if (!res.ok) return [];
    const sessions = (await res.json()) as Array<Record<string, unknown>>;
    return sessions.map((s) => s.id as string);
  } catch {
    return [];
  }
}

/**
 * Abort a single kilo serve session.
 */
async function abortOne(
  config: KiloConfig,
  sessionId: string
): Promise<boolean> {
  try {
    const res = await fetch(kiloUrl(config, `/session/${sessionId}/abort`), { method: "POST" });
    log.info(`Session ${sessionId} abort: HTTP ${res.status}`);
    return res.ok;
  } catch (err) {
    log.warn(`Failed to abort session ${sessionId}: ${err}`);
    return false;
  }
}

/**
 * Abort a kilo serve session AND all its children.
 * Used for cancellation cleanup.
 */
export async function abortSession(
  config: KiloConfig,
  sessionId: string
): Promise<boolean> {
  const children = await getChildSessionIds(config, sessionId);
  // Abort children first, then parent
  for (const childId of children) {
    await abortOne(config, childId);
  }
  return abortOne(config, sessionId);
}

/**
 * Send a prompt to a kilo serve session.
 * Uses the ASYNC prompt endpoint (POST /session/{id}/prompt_async) so that
 * this activity returns immediately and pollUntilDone can monitor progress.
 * The sync endpoint (POST /session/{id}/message) blocks until the agent
 * finishes — which prevents pollUntilDone from ever being reached.
 */
export async function sendPrompt(
  config: KiloConfig,
  sessionId: string,
  prompt: string,
  agent?: string
): Promise<void> {
  const exitResolution = await resolveCardExitPrompt(agent);

  const sessionContext =
    `Dispatch context:\n- SESSION_ID: ${sessionId}\n` +
    "Use this exact SESSION_ID when running punch card self-check commands.";
  let promptWithSessionId = injectCardExitPrompt(prompt, exitResolution.prompt)
    .replaceAll("{{SESSION_ID}}", sessionId)
    .replaceAll("${SESSION_ID}", sessionId)
    .replaceAll("$SESSION_ID", sessionId);
  if (!promptWithSessionId.includes("SESSION_ID:")) {
    promptWithSessionId = `${sessionContext}\n\n${promptWithSessionId}`;
  }

  const body = {
    parts: [{ type: "text", text: promptWithSessionId }],
    ...(agent ? { agent } : {}),
  };

  const res = await fetch(kiloUrl(config, `/session/${sessionId}/prompt_async`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Failed to send prompt (HTTP ${res.status}): ${text}`
    );
  }

  log.info(
    `Prompt dispatched async to session ${sessionId} (${promptWithSessionId.length} chars, card_source=${exitResolution.source}, card_id=${exitResolution.cardId ?? "none"})`
  );
}

/**
 * Find the active leaf session in a delegation tree.
 * Agents run serially (by design), so only the deepest child is active.
 * Walks the tree recursively: parent → children → grandchildren → ...
 * Returns the deepest session that has children, or the leaf.
 */
async function findActiveLeaf(config: KiloConfig, sessionId: string): Promise<string> {
  const children = await getChildSessionIds(config, sessionId);
  if (children.length === 0) return sessionId;
  // Last child is typically the most recent delegation
  const lastChild = children.at(-1);
  if (!lastChild) return sessionId;
  return findActiveLeaf(config, lastChild);
}

function classifyLeafPhase(snap: ProgressSnapshot): "thinking" | "tools_running" | "working" {
  if (snap.thinking) {
    return "thinking";
  }
  if (snap.runningTools > 0) {
    return "tools_running";
  }
  return "working";
}

function logActiveLeafProgress(
  elapsedSec: number,
  tree: {
    totalParts: number;
    toolCalls: number;
    totalCost: number;
    tokensInput: number;
    tokensOutput: number;
    childCount: number;
  },
  leafLabel: string,
  leafSnap: ProgressSnapshot,
): void {
  const phase = classifyLeafPhase(leafSnap);
  log.info(
    `[${elapsedSec}s] ${phase} | parts: ${tree.totalParts}, tools: ${tree.toolCalls} | $${tree.totalCost.toFixed(2)} | ${(tree.tokensInput + tree.tokensOutput).toLocaleString()} tok | children: ${tree.childCount}${leafLabel}`
  );
}

function buildActiveLeafProgress(
  rootSessionId: string,
  activeLeafSessionId: string,
  leafSnap: ProgressSnapshot,
  phase: ActiveLeafProgress["phase"],
): ActiveLeafProgress {
  return {
    sessionId: activeLeafSessionId,
    label: activeLeafSessionId === rootSessionId ? "self" : activeLeafSessionId.slice(0, 16),
    phase,
    runningTools: leafSnap.runningTools,
    completedTools: leafSnap.completedTools,
    lastToolName: leafSnap.lastToolName,
    done: leafSnap.done,
    thinking: leafSnap.thinking,
  };
}

function shouldComplete(
  consecutiveIdleCount: number,
  requiredIdleConfirmations: number,
): boolean {
  return consecutiveIdleCount >= requiredIdleConfirmations;
}

function buildHeartbeatProgress(
  elapsedMs: number,
  tree: {
    totalCost: number;
    tokensInput: number;
    tokensOutput: number;
    totalParts: number;
    toolCalls: number;
    childCount: number;
  },
  idleConfirmations: number,
  requiredIdleConfirmations: number,
  activeLeaf: ActiveLeafProgress,
): AgentTaskHeartbeatProgress {
  return {
    elapsedMs,
    totalParts: tree.totalParts,
    toolCalls: tree.toolCalls,
    childCount: tree.childCount,
    totalCost: tree.totalCost,
    tokensInput: tree.tokensInput,
    tokensOutput: tree.tokensOutput,
    idleConfirmations,
    requiredIdleConfirmations,
    lastProgressAt: new Date().toISOString(),
    activeLeaf,
  };
}

/**
 * Collect aggregate cost/token stats for an entire session tree.
 */
async function getTreeStats(
  config: KiloConfig,
  sessionId: string
): Promise<{ totalCost: number; tokensInput: number; tokensOutput: number; totalParts: number; toolCalls: number; childCount: number }> {
  const snap = await getProgressSnapshot(config, sessionId);
  const children = await getChildSessionIds(config, sessionId);
  let totalCost = snap.totalCost;
  let tokensInput = snap.tokensInput;
  let tokensOutput = snap.tokensOutput;
  let totalParts = snap.totalParts;
  let toolCalls = snap.toolCalls;
  let childCount = children.length;

  for (const cid of children) {
    const childStats = await getTreeStats(config, cid);
    totalCost += childStats.totalCost;
    tokensInput += childStats.tokensInput;
    tokensOutput += childStats.tokensOutput;
    totalParts += childStats.totalParts;
    toolCalls += childStats.toolCalls;
    childCount += childStats.childCount;
  }

  return { totalCost, tokensInput, tokensOutput, totalParts, toolCalls, childCount };
}

/**
 * Poll a session tree until it completes. Heartbeats report progress to Temporal.
 *
 * Completion rules:
 * 1. A session with children is NEVER independently "done" — children must
 *    all be idle first. You can't orphan delegated work.
 * 2. Only the active leaf agent is polled for tool/thinking activity.
 *    Agents run serially, so parents naturally idle while children work.
 * 3. An agent with an open step (step-start without step-finish) is
 *    "thinking" and counts as active, even with no running tools.
 * 4. 6 consecutive idle confirmations (60s at 10s intervals) on the active
 *    leaf before declaring the whole tree done.
 */
export async function pollUntilDone(
  config: KiloConfig,
  sessionId: string,
  pollIntervalMs: number = 10_000,
  timeoutMs: number = 1_800_000, // 30 minutes
): Promise<AgentResult> {
  const startTime = Date.now();

  const REQUIRED_IDLE_CONFIRMATIONS = 6;
  let consecutiveIdleCount = 0;
  let lastLeafParts = 0;

  while (true) {
    const elapsed = Date.now() - startTime;
    if (elapsed > timeoutMs) {
      await abortSession(config, sessionId);
      throw new Error(
        `Session ${sessionId} timed out after ${Math.round(elapsed / 1000)}s`
      );
    }

    // ── Walk tree to find the active leaf ──
    const activeLeaf = await findActiveLeaf(config, sessionId);
    const leafSnap = await getProgressSnapshot(config, activeLeaf);

    // ── Aggregate tree stats for heartbeat/reporting ──
    const tree = await getTreeStats(config, sessionId);

    // ── Determine if the active leaf is truly idle ──
    const leafIsActive =
      leafSnap.thinking || leafSnap.runningTools > 0 || !leafSnap.done;
    const leafPhase = leafIsActive ? classifyLeafPhase(leafSnap) : "idle";
    const leafLabel = activeLeaf === sessionId ? "" : ` | leaf: ${activeLeaf.slice(0, 16)}`;
    const elapsedSec = Math.round(elapsed / 1000);
    const activeLeafProgress = buildActiveLeafProgress(sessionId, activeLeaf, leafSnap, leafPhase);
    const heartbeatProgress = buildHeartbeatProgress(
      elapsed,
      tree,
      consecutiveIdleCount,
      REQUIRED_IDLE_CONFIRMATIONS,
      activeLeafProgress,
    );

    // Heartbeat with progress — Temporal uses this to detect liveness
    heartbeat({
      elapsed: Math.round(elapsed / 1000),
      totalParts: tree.totalParts,
      toolCalls: tree.toolCalls,
      cost: tree.totalCost,
      children: tree.childCount,
      activeLeaf: activeLeaf === sessionId ? "self" : activeLeaf.slice(0, 16),
      leafPhase,
      runningTools: leafSnap.runningTools,
      completedTools: leafSnap.completedTools,
      idleConfirmations: consecutiveIdleCount,
      requiredIdleConfirmations: REQUIRED_IDLE_CONFIRMATIONS,
      progress: heartbeatProgress,
    });

    if (leafIsActive) {
      consecutiveIdleCount = 0;
      lastLeafParts = leafSnap.totalParts;
      logActiveLeafProgress(elapsedSec, tree, leafLabel, leafSnap);
    } else {
      if (leafSnap.totalParts !== lastLeafParts) {
        consecutiveIdleCount = 0;
        lastLeafParts = leafSnap.totalParts;
      }
      consecutiveIdleCount++;

      if (shouldComplete(consecutiveIdleCount, REQUIRED_IDLE_CONFIRMATIONS)) {
        log.info(`Session tree completed: root ${sessionId} + ${tree.childCount} children | $${tree.totalCost.toFixed(2)} total | ${elapsedSec}s`);
        return {
          sessionId,
          totalParts: tree.totalParts,
          toolCalls: tree.toolCalls,
          durationMs: elapsed,
          totalCost: tree.totalCost,
          tokensInput: tree.tokensInput,
          tokensOutput: tree.tokensOutput,
          childCount: tree.childCount,
          idleConfirmations: consecutiveIdleCount,
          requiredIdleConfirmations: REQUIRED_IDLE_CONFIRMATIONS,
          lastProgressAt: new Date().toISOString(),
          activeLeaf: buildActiveLeafProgress(sessionId, activeLeaf, leafSnap, "idle"),
        };
      }

      log.info(`[${elapsedSec}s] idle (${consecutiveIdleCount}/${REQUIRED_IDLE_CONFIRMATIONS}) | parts: ${tree.totalParts}, tools: ${tree.toolCalls} | $${tree.totalCost.toFixed(2)}${leafLabel}`);
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

interface PartAccumulator {
  totalParts: number;
  toolCalls: number;
  completedTools: number;
  runningTools: number;
  lastToolName: string | null;
  lastPartType: string | null;
  openSteps: number;
  totalCost: number;
  tokensInput: number;
  tokensOutput: number;
}

/** Extract flat parts from message array (raw HTTP response format: [{info, parts}, ...]). */
function flattenMessageParts(messages: unknown): Array<Record<string, unknown>> {
  if (!messages || !Array.isArray(messages)) return [];

  const parts: Array<Record<string, unknown>> = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;
    // Direct parts array on message object
    const msgParts = m.parts as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(msgParts)) {
      parts.push(...msgParts);
    }
  }
  return parts;
}

/** Accumulate tool statistics and cost/token data from a single part. */
function accumulatePart(acc: PartAccumulator, part: Record<string, unknown>): void {
  acc.totalParts++;
  acc.lastPartType = (part.type as string) ?? null;

  // Track step-start / step-finish balance to detect "thinking" phase.
  // An open step (step-start without matching step-finish) means the agent
  // is actively processing — reasoning, preparing tool calls, etc.
  if (part.type === "step-start") {
    acc.openSteps++;
  }

  // step-finish parts carry cost and token data
  // Format: { cost: number, tokens: { input: number, output: number, reasoning?: number } }
  if (part.type === "step-finish") {
    acc.openSteps = Math.max(0, acc.openSteps - 1);
    if (typeof part.cost === "number") acc.totalCost += part.cost;
    const tokens = part.tokens as Record<string, unknown> | undefined;
    if (tokens) {
      if (typeof tokens.input === "number") acc.tokensInput += tokens.input;
      if (typeof tokens.output === "number") acc.tokensOutput += tokens.output;
    }
  }

  if (part.type !== "tool") return;

  acc.toolCalls++;
  const toolName = (part.tool as string) ?? "unknown";
  const status = (part.state as Record<string, unknown> | undefined)?.status as string | undefined;
  if (status === "completed" || status === "error") {
    acc.completedTools++;
  } else if (status === "running" || status === "pending") {
    acc.runningTools++;
  }
  acc.lastToolName = toolName;
}

/** Determine if the session is in a terminal state. */
function isSessionDone(acc: PartAccumulator): boolean {
  const hasContent = acc.totalParts > 1;
  const noActiveTools = acc.runningTools === 0;
  const isTerminal =
    acc.lastPartType === "step-finish" ||
    acc.lastPartType === "patch" ||
    (acc.lastPartType === "text" && acc.toolCalls > 0);
  return hasContent && noActiveTools && isTerminal;
}

/**
 * Check if a session has no running/pending tools in its messages.
 * kilo serve v7.x has no "status" field on session objects, so we
 * detect idleness from the message stream instead.
 */
async function isSessionIdle(config: KiloConfig, sessionId: string): Promise<boolean> {
  try {
    const res = await fetch(kiloUrl(config, `/session/${sessionId}/message`));
    if (!res.ok) return false;
    const messages = await res.json() as Array<Record<string, unknown>>;
    for (const msg of messages) {
      const parts = (msg.parts as Array<Record<string, unknown>>) ?? [];
      for (const part of parts) {
        if (part.type === "tool") {
          const status = (part.state as Record<string, unknown>)?.status;
          if (status === "running" || status === "pending") {
            return false;
          }
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Get a progress snapshot from session messages.
 */
async function getProgressSnapshot(
  config: KiloConfig,
  sessionId: string
): Promise<ProgressSnapshot> {
  const empty: ProgressSnapshot = { totalParts: 0, toolCalls: 0, completedTools: 0, runningTools: 0, lastToolName: null, done: false, thinking: false, totalCost: 0, tokensInput: 0, tokensOutput: 0 };
  try {
    const client = createKiloClient(config);
    const { data: messages } = await client.session.messages({
      path: { id: sessionId },
    });
    if (!messages) {
      return empty;
    }

    const acc: PartAccumulator = {
      totalParts: 0,
      toolCalls: 0,
      completedTools: 0,
      runningTools: 0,
      lastToolName: null,
      lastPartType: null,
      openSteps: 0,
      totalCost: 0,
      tokensInput: 0,
      tokensOutput: 0,
    };

    for (const part of flattenMessageParts(messages)) {
      accumulatePart(acc, part);
    }

    return {
      totalParts: acc.totalParts,
      toolCalls: acc.toolCalls,
      completedTools: acc.completedTools,
      runningTools: acc.runningTools,
      lastToolName: acc.lastToolName,
      done: isSessionDone(acc),
      thinking: acc.openSteps > 0,
      totalCost: acc.totalCost,
      tokensInput: acc.tokensInput,
      tokensOutput: acc.tokensOutput,
    };
  } catch (err) {
    log.warn(`getProgressSnapshot fetch failed for session ${sessionId}: ${err}`);
    return empty;
  }
}

/**
 * Check cost budget enforcement for a session via Dolt punch data.
 *
 * Queries real-time cost accumulation from the punches table and evaluates
 * against configurable thresholds. Returns a governor intervention directive
 * if any threshold is breached.
 *
 * This activity is designed to be called after pollUntilDone completes
 * for post-completion budget validation.
 */
export async function checkCostBudget(
  doltConfig: Omit<DoltConfig, "password">,
  sessionId: string,
  budgetOverrides?: {
    maxSessionCostUsd?: number;
    maxSessionSteps?: number;
    maxTreeCostUsd?: number;
  },
): Promise<{
  status: "ok" | "warning" | "breach";
  sessionCost: number;
  sessionSteps: number;
  treeCost: number;
  treeSessionCount: number;
  intervention: {
    action: string;
    reason: string;
    classification: string;
    targetSessionId: string;
  } | null;
}> {
  const fullConfig: DoltConfig = {
    ...doltConfig,
    password: process.env.DOLT_DB_PASSWORD,
  };
  const { CostBudgetMonitor } = await import("../governor/cost-budget-monitor.js");
  const monitor = new CostBudgetMonitor(fullConfig, budgetOverrides);
  try {
    await monitor.connect();
    const result = await monitor.checkBudget(sessionId);
    return {
      status: result.status,
      sessionCost: result.sessionSnapshot.totalCost,
      sessionSteps: result.sessionSnapshot.stepCount,
      treeCost: result.treeSnapshot.totalCost,
      treeSessionCount: result.treeSnapshot.sessionCount,
      intervention: result.intervention
        ? {
            action: result.intervention.action,
            reason: result.intervention.reason,
            classification: result.intervention.classification,
            targetSessionId: result.intervention.targetSessionId,
          }
        : null,
    };
  } finally {
    await monitor.disconnect();
  }
}

/**
 * Run post-workflow session audit on Dolt punch data.
 *
 * Queries punch data for a completed session and runs all anomaly detectors:
 *   1. Missing quality gate punches
 *   2. Cost anomalies
 *   3. Loop signatures
 *   4. Tool adherence deviation
 *   5. Incomplete subtask trees
 *   6. Stall detection
 *
 * Returns a structured audit report with findings, severity, and evidence.
 * Designed to be called after pollUntilDone completes.
 */
export async function runSessionAudit(
  doltConfig: Omit<DoltConfig, "password">,
  sessionId: string,
  auditOverrides?: {
    cheapZonePercentileUsd?: number;
    costAnomalyThresholdUsd?: number;
    maxExpectedSteps?: number;
    maxPunchGapSeconds?: number;
    expectedEditRange?: [number, number];
    requiredQualityGates?: string[];
  },
): Promise<{
  verdict: "pass" | "warn" | "fail";
  findingCount: number;
  criticalCount: number;
  warningCount: number;
  infoCount: number;
  findings: Array<{
    type: string;
    severity: string;
    message: string;
    evidence: Record<string, unknown>;
  }>;
  metrics: {
    totalCost: number;
    stepCount: number;
    punchCount: number;
    durationMs: number;
    childCount: number;
  };
}> {
  const fullConfig: DoltConfig = {
    ...doltConfig,
    password: process.env.DOLT_DB_PASSWORD,
  };
  const { SessionAudit } = await import("../governor/session-audit.js");
  const audit = new SessionAudit(fullConfig, auditOverrides);
  try {
    await audit.connect();
    const report = await audit.runAudit(sessionId);
    return {
      verdict: report.verdict,
      findingCount: report.findings.length,
      criticalCount: report.findings.filter((f) => f.severity === "critical").length,
      warningCount: report.findings.filter((f) => f.severity === "warning").length,
      infoCount: report.findings.filter((f) => f.severity === "info").length,
      findings: report.findings.map((f) => ({
        type: f.type,
        severity: f.severity,
        message: f.message,
        evidence: f.evidence,
      })),
      metrics: {
        totalCost: report.metrics.totalCost,
        stepCount: report.metrics.stepCount,
        punchCount: report.metrics.punchCount,
        durationMs: report.metrics.durationMs,
        childCount: report.metrics.childCount,
      },
    };
  } finally {
    await audit.disconnect();
  }
}

export async function validateTaskPunchCard(
  doltConfig: Omit<DoltConfig, "password">,
  taskId: string,
  cardId: string,
  enforcedOnly?: boolean,
): Promise<{ status: "pass" | "fail"; missing: string[]; violations: string[] }> {
  const fullConfig: DoltConfig = {
    ...doltConfig,
    password: process.env.DOLT_DB_PASSWORD,
  };
  const { PunchCardValidator } = await import("../governor/punch-card-validator.js");
  const validator = new PunchCardValidator(fullConfig);
  try {
    await validator.connect();
    const result = await validator.validatePunchCard(taskId, cardId, {
      enforcedOnly: enforcedOnly ?? false,
    });
    return {
      status: result.status,
      missing: result.missing.map((m) => `${m.punchType}:${m.punchKeyPattern}`),
      violations: result.violations.map(
        (v) => `${v.punchType}:${v.punchKeyPattern} (${v.count}x)`
      ),
    };
  } finally {
    await validator.disconnect();
  }
}
