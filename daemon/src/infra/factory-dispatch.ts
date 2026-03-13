/**
 * Factory Dispatch — Orchestration module.
 *
 * Sequences the full dispatch pipeline: pre-flight → prompt build →
 * session create → card exit inject → dispatch → monitor → extract → audit.
 *
 * Kilo HTTP helpers (session creation, prompt dispatch, message fetching,
 * idle detection, result extraction) live in kilo-client.ts.
 * Punch card audit logic lives in punch-card-audit.ts.
 *
 * This module re-exports from both for backward compatibility — all existing
 * imports from factory-dispatch.ts continue to work.
 *
 * See: repomap-core-76q, repomap-core-ovm.7
 */

import { writeFileSync } from "node:fs";
import { createConnection } from "node:net";

import { resolveCardExitPrompt, injectCardExitPrompt } from "../optimization/prompt-injection.js";
import { findRepoRoot, timestamp } from "./utils.js";
import { pm2IsAppOnline } from "./pm2-client.js";

// ── Re-exports: kilo-client.ts ───────────────────────────────────────────
// Backward compatibility — consumers can continue importing from factory-dispatch.

export {
  type PromptPart,
  type PromptPayload,
  type MessagePart,
  type SessionMessage,
  type ChildSession,
  type MonitorResult,
  type Logger,
  buildPromptPayload,
  injectSessionId,
  createSession,
  dispatchPrompt,
  fetchMessages,
  fetchChildren,
  isSessionDone,
  areAllChildrenDone,
  monitorSession,
  extractResult,
} from "./kilo-client.js";

// ── Re-exports: punch-card-audit.ts ──────────────────────────────────────

export {
  type AuditResult,
  runPostSessionAudit,
} from "./punch-card-audit.js";

// ── Direct imports for orchestration ─────────────────────────────────────

import type { PromptPayload, Logger } from "./kilo-client.js";
import {
  buildPromptPayload,
  injectSessionId,
  createSession,
  dispatchPrompt,
  fetchMessages,
  fetchChildren,
  monitorSession,
  extractResult,
} from "./kilo-client.js";
import type { AuditResult } from "./punch-card-audit.js";
import { runPostSessionAudit } from "./punch-card-audit.js";

// ── Configuration ────────────────────────────────────────────────────────

export interface FactoryDispatchConfig {
  /** Agent mode to dispatch to (default: plant-manager) */
  mode: string;
  /** Session title (default: auto-generated) */
  title: string;
  /** Kilo serve host (default: 127.0.0.1) */
  host: string;
  /** Kilo serve port (default: 4096) */
  port: number;
  /** Max wait for completion in seconds (default: 600) */
  maxWait: number;
  /** Poll interval in seconds (default: 10) */
  pollInterval: number;
  /** Suppress progress output (default: false) */
  quiet: boolean;
  /** Fire and forget — print session ID and exit (default: false) */
  noMonitor: boolean;
  /** Output final result as JSON (default: false) */
  jsonOutput: boolean;
  /** Prompt argument — file path or string */
  promptArg: string;
  /** Consecutive idle polls required before declaring completion */
  idleConfirm: number;
  /** Dolt server port for pre-flight check */
  doltPort: number;
  /** Temporal server port for pre-flight check */
  temporalPort: number;
  /** Path to pm2 binary */
  pm2Bin: string;
  /** Override punch card ID (bypasses mode-card-map lookup) */
  cardId: string;
}

export function defaultConfig(): FactoryDispatchConfig {
  const repoRoot = process.env.REPO_ROOT ?? findRepoRoot();
  return {
    mode: "plant-manager",
    title: "",
    host: "127.0.0.1",
    port: 4096,
    maxWait: 600,
    pollInterval: 10,
    quiet: false,
    noMonitor: false,
    jsonOutput: false,
    promptArg: "",
    idleConfirm: Number(process.env.IDLE_CONFIRM ?? "3"),
    doltPort: Number(process.env.DOLT_PORT ?? "3307"),
    temporalPort: Number(process.env.TEMPORAL_PORT ?? "7233"),
    pm2Bin: `${repoRoot}/daemon/node_modules/.bin/pm2`,
    cardId: "",
  };
}

// ── Types ────────────────────────────────────────────────────────────────

/** Pre-flight check result for a single component. */
export interface PreflightComponent {
  name: string;
  ok: boolean;
  detail: string;
}

/** Overall pre-flight result. */
export interface PreflightResult {
  ok: boolean;
  components: PreflightComponent[];
}

/** Dispatch result for JSON output mode. */
export interface DispatchResult {
  session_id: string;
  mode: string;
  title: string;
  children: number;
  elapsed_seconds: number;
  result: string;
  child_session_ids: string[];
  audit?: AuditResult;
}

/** Exit codes matching the shell script. */
export const ExitCode = {
  SUCCESS: 0,
  USAGE_ERROR: 1,
  HEALTH_CHECK_FAILED: 2,
  SESSION_CREATION_FAILED: 3,
  PROMPT_DISPATCH_FAILED: 4,
  TIMEOUT: 5,
  NO_RESPONSE: 6,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

// ── Helpers ──────────────────────────────────────────────────────────────

function makeLogger(quiet: boolean): Logger {
  return (msg: string) => {
    if (!quiet) {
      process.stderr.write(`[factory] ${msg}\n`);
    }
  };
}

/**
 * Check if a TCP port is listening on localhost.
 * Returns true if a connection can be established within timeoutMs.
 */
export function checkPort(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.on("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * Check if a pm2 app is online via PM2 programmatic API.
 * Delegates to pm2-client.ts for connect/list/disconnect lifecycle.
 */
export async function isPm2AppOnline(_pm2Bin: string, appName: string): Promise<boolean> {
  return pm2IsAppOnline(appName);
}

// ── Phase 1: Pre-flight ──────────────────────────────────────────────────

/**
 * Run pre-flight health check on all 5 stack components.
 */
export async function preflight(
  config: FactoryDispatchConfig,
  log: Logger,
  fetchFn: typeof fetch = fetch,
): Promise<PreflightResult> {
  const baseUrl = `http://${config.host}:${config.port}`;
  const components: PreflightComponent[] = [];

  log(`${timestamp()} Pre-flight: checking all 5 stack components...`);

  // 1. kilo serve
  try {
    const resp = await fetchFn(`${baseUrl}/session`, { signal: AbortSignal.timeout(5000) });
    if (resp.ok) {
      const sessions = (await resp.json()) as unknown[];
      log(`${timestamp()}   ✅ kilo serve (${sessions.length} sessions)`);
      components.push({ name: "kilo serve", ok: true, detail: `${sessions.length} sessions` });
    } else {
      components.push({ name: "kilo serve", ok: false, detail: `NOT reachable at ${baseUrl}` });
    }
  } catch {
    components.push({ name: "kilo serve", ok: false, detail: `NOT reachable at ${baseUrl}` });
  }

  // 2. Dolt server
  const doltOk = await checkPort(config.host, config.doltPort);
  if (doltOk) {
    log(`${timestamp()}   ✅ Dolt server (port ${config.doltPort})`);
  }
  components.push({
    name: "Dolt server",
    ok: doltOk,
    detail: doltOk ? `port ${config.doltPort}` : `NOT listening on port ${config.doltPort}`,
  });

  // 3-5: Run remaining checks in parallel (pm2 checks are async via programmatic API)
  const [ocdOk, temporalOk, twOk] = await Promise.all([
    isPm2AppOnline(config.pm2Bin, "oc-daemon"),
    checkPort(config.host, config.temporalPort),
    isPm2AppOnline(config.pm2Bin, "temporal-worker"),
  ]);

  if (ocdOk) {
    log(`${timestamp()}   ✅ oc-daemon (SSE → Dolt)`);
  }
  components.push({
    name: "oc-daemon",
    ok: ocdOk,
    detail: ocdOk
      ? "SSE → Dolt"
      : "NOT running (no flight recorder — sessions will be unrecorded!)",
  });

  if (temporalOk) {
    log(`${timestamp()}   ✅ Temporal server (port ${config.temporalPort})`);
  }
  components.push({
    name: "Temporal server",
    ok: temporalOk,
    detail: temporalOk ? `port ${config.temporalPort}` : `NOT listening on port ${config.temporalPort}`,
  });

  if (twOk) {
    log(`${timestamp()}   ✅ Temporal worker`);
  }
  components.push({
    name: "Temporal worker",
    ok: twOk,
    detail: twOk ? "online" : "NOT running",
  });

  const ok = components.every((c) => c.ok);
  if (ok) {
    log(`${timestamp()} Pre-flight passed (5/5 components healthy)`);
  }

  return { ok, components };
}

// ── Main orchestrator ────────────────────────────────────────────────────

/**
 * Run the full factory dispatch pipeline.
 * This is the main entry point — mirrors the shell script's behavior.
 *
 * Returns the exit code (0-6).
 */
export async function runDispatch(
  config: FactoryDispatchConfig,
  fetchFn: typeof fetch = fetch,
): Promise<ExitCodeValue> {
  const log = makeLogger(config.quiet);
  const baseUrl = `http://${config.host}:${config.port}`;

  // Phase 1: Pre-flight
  const pf = await preflight(config, log, fetchFn);
  if (!pf.ok) {
    const missing = pf.components.filter((c) => !c.ok);
    process.stderr.write("\n");
    process.stderr.write("═══════════════════════════════════════════════════════════\n");
    process.stderr.write(" DISPATCH BLOCKED — Stack is incomplete\n");
    process.stderr.write("═══════════════════════════════════════════════════════════\n");
    for (const c of missing) {
      process.stderr.write(`  ❌ ${c.name}: ${c.detail}\n`);
    }
    process.stderr.write("Ensure the full stack is healthy first:\n");
    process.stderr.write("  .kilocode/tools/start-stack.sh --ensure\n");
    process.stderr.write("\nOr check status with:\n");
    process.stderr.write("  .kilocode/tools/start-stack.sh --check\n");
    process.stderr.write("═══════════════════════════════════════════════════════════\n");
    return ExitCode.HEALTH_CHECK_FAILED;
  }

  // Phase 2: Build prompt payload
  let payload: PromptPayload;
  try {
    payload = buildPromptPayload(config.promptArg, config.mode);
  } catch (e) {
    process.stderr.write(`ERROR: ${(e as Error).message}\n`);
    return ExitCode.USAGE_ERROR;
  }

  if (config.promptArg.endsWith(".json")) {
    log(`${timestamp()} Loaded prompt from: ${config.promptArg}`);
  } else {
    log(`${timestamp()} Built prompt from string (${config.promptArg.length} chars)`);
  }

  // Phase 3: Create session
  const title = config.title || `factory: ${config.mode} @ ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;

  let sessionId: string;
  try {
    sessionId = await createSession(baseUrl, title, fetchFn);
  } catch {
    process.stderr.write("ERROR: Failed to create session\n");
    return ExitCode.SESSION_CREATION_FAILED;
  }

  log(`${timestamp()} Session created: ${sessionId}`);
  log(`${timestamp()} Title: ${title}`);

  // Inject SESSION_ID into prompt
  injectSessionId(payload, sessionId);

  // Phase 3b: Inject card exit prompt
  try {
    const cardResolution = config.cardId
      ? await resolveCardExitPrompt(config.mode, config.cardId)
      : await resolveCardExitPrompt(config.mode);
    if (cardResolution.prompt) {
      for (const part of payload.parts) {
        if (part.type === "text" && typeof part.text === "string") {
          part.text = injectCardExitPrompt(part.text, cardResolution.prompt);
          break;
        }
      }
      log(
        `${timestamp()} Card exit prompt injected (card=${cardResolution.cardId}, source=${cardResolution.source})`,
      );
    } else {
      log(`${timestamp()} No card exit prompt found for mode=${config.mode}${config.cardId ? ` card=${config.cardId}` : ""}`);
    }
  } catch (e) {
    log(`${timestamp()} Warning: card exit prompt resolution failed: ${(e as Error).message}`);
  }

  // Phase 4: Dispatch prompt
  try {
    await dispatchPrompt(baseUrl, sessionId, payload, fetchFn);
  } catch (e) {
    process.stderr.write(`ERROR: ${(e as Error).message}\n`);
    return ExitCode.PROMPT_DISPATCH_FAILED;
  }

  log(`${timestamp()} Prompt dispatched to mode: ${config.mode}`);

  // Phase 5: No-monitor early exit
  if (config.noMonitor) {
    if (config.jsonOutput) {
      process.stdout.write(
        JSON.stringify({ session_id: sessionId, mode: config.mode, title }) + "\n",
      );
    } else {
      process.stdout.write(sessionId + "\n");
    }
    return ExitCode.SUCCESS;
  }

  // Phase 6: Monitor for completion
  const monitor = await monitorSession(baseUrl, sessionId, config, log, fetchFn);

  if (!monitor.completed) {
    process.stderr.write(
      `ERROR: Timeout after ${config.maxWait}s (session may still be running: ${sessionId})\n`,
    );
    return ExitCode.TIMEOUT;
  }

  // Phase 7: Extract result
  const messages = await fetchMessages(baseUrl, sessionId, fetchFn);
  const result = extractResult(messages);

  if (!result) {
    process.stderr.write("ERROR: Session completed but no assistant response found\n");
    process.stderr.write(`Session ID: ${sessionId}\n`);
    return ExitCode.NO_RESPONSE;
  }

  // Fetch children for Phase 8 + 9
  let children: { id: string; [key: string]: unknown }[] = [];
  let childIds: string[] = [];
  if (monitor.childCount > 0) {
    children = await fetchChildren(baseUrl, sessionId, fetchFn);
    childIds = children.map((c) => c.id).filter(Boolean);
  }

  // Phase 7b: Post-session punch card audit
  let audit: AuditResult | null = null;
  const resolvedCardId = config.cardId || undefined;
  if (resolvedCardId) {
    audit = await runPostSessionAudit(sessionId, resolvedCardId, config, log);
  } else {
    // Try mode-card-map fallback
    try {
      const cardResolution = await resolveCardExitPrompt(config.mode);
      if (cardResolution.cardId) {
        audit = await runPostSessionAudit(sessionId, cardResolution.cardId, config, log);
      }
    } catch {
      // Non-fatal — audit is best-effort
    }
  }

  // Phase 8: Output
  if (config.jsonOutput) {
    const output: DispatchResult = {
      session_id: sessionId,
      mode: config.mode,
      title,
      children: monitor.childCount,
      elapsed_seconds: monitor.elapsed,
      result,
      child_session_ids: childIds,
      ...(audit ? { audit } : {}),
    };
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
  } else {
    process.stdout.write(result + "\n");
  }

  // Phase 9: Child session ID capture
  if (childIds.length > 0) {
    log(`${timestamp()} Child session IDs captured for handoff:`);
    for (const cid of childIds) {
      log(`  - ${cid}`);
    }
  }

  log(
    `${timestamp()} Done. Session: ${sessionId} | Children: ${monitor.childCount} | Elapsed: ${monitor.elapsed}s`,
  );
  log(
    `${timestamp()} Handoff: use --parent-session ${sessionId} with punch_engine for deterministic child ID resolution`,
  );

  return ExitCode.SUCCESS;
}

// ── Prompt file writing (used by thin shell wrapper) ─────────────────────

/**
 * Write a prompt payload to a temporary JSON file.
 * Returns the path to the file.
 */
export function writePromptFile(payload: PromptPayload, path: string): void {
  writeFileSync(path, JSON.stringify(payload));
}
