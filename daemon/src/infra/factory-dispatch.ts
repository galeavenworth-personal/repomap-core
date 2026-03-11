/**
 * Factory Dispatch — TypeScript logic module
 *
 * Replaces the 7 Python heredocs and curl calls in factory_dispatch.sh
 * with native Node.js fetch() and JSON manipulation.
 *
 * Responsibilities:
 *   - Pre-flight health check of 5 stack components
 *   - Build prompt payload from JSON file or plain text
 *   - Inject SESSION_ID into prompt text
 *   - Create kilo session
 *   - Dispatch prompt asynchronously
 *   - Monitor session for completion (idle detection)
 *   - Monitor child sessions
 *   - Extract result text
 *   - JSON output with child session IDs
 *
 * See: repomap-core-76q
 */

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { createConnection } from "node:net";

import { resolveCardExitPrompt, injectCardExitPrompt } from "../optimization/prompt-injection.js";
import { PunchCardValidator } from "../governor/punch-card-validator.js";

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

function findRepoRoot(): string {
  try {
    return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  } catch {
    return process.cwd();
  }
}

// ── Types ────────────────────────────────────────────────────────────────

/** A single part in a kilo prompt payload. */
export interface PromptPart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/** The prompt payload sent to kilo serve. */
export interface PromptPayload {
  agent?: string;
  parts: PromptPart[];
  [key: string]: unknown;
}

/** A message part from the kilo session message API. */
export interface MessagePart {
  type: string;
  text?: string;
  reason?: string;
  state?: { status?: string };
  [key: string]: unknown;
}

/** A message from the kilo session message API. */
export interface SessionMessage {
  info?: { role?: string };
  parts?: MessagePart[];
  [key: string]: unknown;
}

/** A child session object from the kilo children API. */
export interface ChildSession {
  id: string;
  [key: string]: unknown;
}

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

/** Post-session audit result. */
export interface AuditResult {
  cardId: string;
  status: "pass" | "fail";
  missing: string[];
  violations: string[];
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

function timestamp(): string {
  const now = new Date();
  return now.toTimeString().slice(0, 8);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type Logger = (msg: string) => void;

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
 * Check if a pm2 app is online by parsing pm2 jlist output.
 */
export function isPm2AppOnline(pm2Bin: string, appName: string): boolean {
  try {
    const output = execSync(`"${pm2Bin}" jlist 2>/dev/null`, {
      encoding: "utf8",
      timeout: 5000,
    });
    const procs: Array<{ name: string; pm2_env?: { status?: string } }> =
      JSON.parse(output);
    return procs.some(
      (p) => p.name === appName && p.pm2_env?.status === "online",
    );
  } catch {
    return false;
  }
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

  // 3. oc-daemon (flight recorder)
  const ocdOk = isPm2AppOnline(config.pm2Bin, "oc-daemon");
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

  // 4. Temporal server
  const temporalOk = await checkPort(config.host, config.temporalPort);
  if (temporalOk) {
    log(`${timestamp()}   ✅ Temporal server (port ${config.temporalPort})`);
  }
  components.push({
    name: "Temporal server",
    ok: temporalOk,
    detail: temporalOk ? `port ${config.temporalPort}` : `NOT listening on port ${config.temporalPort}`,
  });

  // 5. Temporal worker
  const twOk = isPm2AppOnline(config.pm2Bin, "temporal-worker");
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

// ── Phase 2: Build prompt payload ────────────────────────────────────────

/**
 * Build the prompt payload from a JSON file path or a plain text string.
 */
export function buildPromptPayload(promptArg: string, mode: string): PromptPayload {
  if (promptArg.endsWith(".json")) {
    try {
      const raw = readFileSync(promptArg, "utf8");
      const data = JSON.parse(raw) as PromptPayload;
      if (!data.agent) {
        data.agent = mode;
      }
      return data;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        throw new Error(`Prompt file not found: ${promptArg}`);
      }
      // Invalid JSON — fall through to treat .json path as plain text prompt
    }
  }

  // Plain text string
  return {
    agent: mode,
    parts: [{ type: "text", text: promptArg }],
  };
}

// ── Phase 3: Inject SESSION_ID ───────────────────────────────────────────

/**
 * Inject SESSION_ID into prompt parts for punch card tracking.
 * Modifies the payload in-place.
 */
export function injectSessionId(payload: PromptPayload, sessionId: string): void {
  const sessionContext =
    `Dispatch context:\n- SESSION_ID: ${sessionId}\n` +
    "Use this exact SESSION_ID when running punch card self-check commands.";

  const parts = Array.isArray(payload.parts) ? payload.parts : [];
  let injected = false;

  for (const part of parts) {
    if (part.type !== "text" || typeof part.text !== "string") continue;

    let text = part.text;
    text = text.replaceAll("$SESSION_ID", sessionId);
    text = text.replaceAll("${SESSION_ID}", sessionId);
    text = text.replaceAll("{{SESSION_ID}}", sessionId);

    if (!injected) {
      text = `${sessionContext}\n\n${text}`;
      injected = true;
    }
    part.text = text;
  }

  if (!injected) {
    parts.unshift({ type: "text", text: sessionContext });
  }

  payload.parts = parts;
}

// ── Phase 3+4: Create session & dispatch ─────────────────────────────────

/**
 * Create a new kilo session. Returns the session ID.
 */
export async function createSession(
  baseUrl: string,
  title: string,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const resp = await fetchFn(`${baseUrl}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });

  if (!resp.ok) {
    throw new Error(`Failed to create session (HTTP ${resp.status})`);
  }

  const data = (await resp.json()) as { id: string };
  if (!data.id) {
    throw new Error("Session response missing 'id' field");
  }

  return data.id;
}

/**
 * Dispatch a prompt to a session asynchronously.
 * Uses the prompt_async endpoint so we can monitor via polling.
 */
export async function dispatchPrompt(
  baseUrl: string,
  sessionId: string,
  payload: PromptPayload,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const resp = await fetchFn(`${baseUrl}/session/${sessionId}/prompt_async`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  // Any 2xx is success
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`Prompt dispatch failed (HTTP ${resp.status})`);
  }
}

// ── Phase 6: Monitor for completion ──────────────────────────────────────

/**
 * Check if a session's messages indicate it is done processing.
 * A session is done when it has a terminal step-finish (end_turn/stop, not tool-calls)
 * and no running/pending tools.
 */
export function isSessionDone(messages: SessionMessage[]): boolean {
  let hasTerminalFinish = false;
  let hasRunningTools = false;

  for (const msg of messages) {
    for (const part of msg.parts ?? []) {
      if (part.type === "tool") {
        const status = part.state?.status;
        if (status === "running" || status === "pending") {
          hasRunningTools = true;
        }
      }
      if (part.type === "step-finish") {
        const reason = part.reason ?? "";
        if (reason === "tool-calls") {
          hasTerminalFinish = false; // reset — more work coming
        } else if (reason === "end_turn" || reason === "stop" || reason === "max_tokens" || reason === "") {
          hasTerminalFinish = true;
        }
      }
    }
  }

  return hasTerminalFinish && !hasRunningTools;
}

/**
 * Fetch the children of a session. Returns array of child session objects.
 */
export async function fetchChildren(
  baseUrl: string,
  sessionId: string,
  fetchFn: typeof fetch = fetch,
): Promise<ChildSession[]> {
  try {
    const resp = await fetchFn(`${baseUrl}/session/${sessionId}/children`);
    if (!resp.ok) return [];
    return (await resp.json()) as ChildSession[];
  } catch {
    return [];
  }
}

/**
 * Fetch session messages.
 */
export async function fetchMessages(
  baseUrl: string,
  sessionId: string,
  fetchFn: typeof fetch = fetch,
): Promise<SessionMessage[]> {
  try {
    const resp = await fetchFn(`${baseUrl}/session/${sessionId}/message`);
    if (!resp.ok) return [];
    return (await resp.json()) as SessionMessage[];
  } catch {
    return [];
  }
}

/**
 * Check if ALL child sessions are done (no running/pending tools).
 */
export async function areAllChildrenDone(
  baseUrl: string,
  children: ChildSession[],
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  for (const child of children) {
    if (!child.id) continue;
    const messages = await fetchMessages(baseUrl, child.id, fetchFn);
    // Check if any tool is running/pending
    const hasRunning = messages.some((msg) =>
      (msg.parts ?? []).some(
        (p) => p.type === "tool" && (p.state?.status === "running" || p.state?.status === "pending"),
      ),
    );
    if (hasRunning) return false;
  }
  return true;
}

export interface MonitorResult {
  completed: boolean;
  elapsed: number;
  childCount: number;
}

/**
 * Monitor a session for completion with idle detection and child monitoring.
 */
export async function monitorSession(
  baseUrl: string,
  sessionId: string,
  config: FactoryDispatchConfig,
  log: Logger,
  fetchFn: typeof fetch = fetch,
): Promise<MonitorResult> {
  log(`${timestamp()} Monitoring session (poll=${config.pollInterval}s, timeout=${config.maxWait}s)...`);

  let elapsed = 0;
  let lastChildCount = 0;
  let idleCount = 0;

  while (elapsed < config.maxWait) {
    await sleep(config.pollInterval * 1000);
    elapsed += config.pollInterval;

    // Count children
    const children = await fetchChildren(baseUrl, sessionId, fetchFn);
    const childCount = children.length;

    if (childCount !== lastChildCount) {
      log(`${timestamp()} Children spawned: ${childCount} (was ${lastChildCount})`);
      lastChildCount = childCount;
    }

    // Check session messages
    const messages = await fetchMessages(baseUrl, sessionId, fetchFn);
    let doneStatus: "yes" | "no" | "error";
    try {
      doneStatus = isSessionDone(messages) ? "yes" : "no";
    } catch {
      doneStatus = "error";
    }

    if (doneStatus === "yes") {
      idleCount++;
      if (idleCount < config.idleConfirm) {
        log(`${timestamp()} [${elapsed}s] Idle check ${idleCount}/${config.idleConfirm}, confirming...`);
        await sleep(config.pollInterval * 1000);
        elapsed += config.pollInterval;
        if (elapsed >= config.maxWait) break;
        continue;
      }

      // Confirmed idle — verify all children are done
      let allChildrenDone = true;
      if (childCount > 0) {
        allChildrenDone = await areAllChildrenDone(baseUrl, children, fetchFn);
      }

      if (allChildrenDone) {
        log(
          `${timestamp()} All sessions idle (${idleCount}/${config.idleConfirm} confirmations) — completed in ${elapsed}s`,
        );
        return { completed: true, elapsed, childCount: lastChildCount };
      }
      // Children still running, reset
      idleCount = 0;
    } else {
      idleCount = 0;
    }

    if (doneStatus === "error") {
      log(`${timestamp()} [${elapsed}s] Warning: status check failed, retrying...`);
    } else {
      log(`${timestamp()} [${elapsed}s] Parent done: ${doneStatus}, children: ${childCount}, idle: ${idleCount}/${config.idleConfirm}`);
    }
  }

  return { completed: false, elapsed, childCount: lastChildCount };
}

// ── Phase 7: Extract result ──────────────────────────────────────────────

/**
 * Extract the final assistant response text from session messages.
 * First looks for substantial text (>100 chars), then falls back to any text.
 */
export function extractResult(messages: SessionMessage[]): string | null {
  // First pass: find last assistant message with substantial text
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.info?.role !== "assistant") continue;
    for (const part of msg.parts ?? []) {
      if (part.type === "text" && typeof part.text === "string" && part.text.length > 100) {
        return part.text;
      }
    }
  }

  // Fallback: any assistant text
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.info?.role !== "assistant") continue;
    for (const part of msg.parts ?? []) {
      if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
        return part.text;
      }
    }
  }

  return null;
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
  let children: ChildSession[] = [];
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

// ── Phase 10: Post-session punch card audit ──────────────────────────────

/**
 * Run a punch card audit after session completion.
 * Validates the session's punches against the resolved card and writes
 * the result to Dolt's checkpoints table.
 *
 * This is the "governor without kill" — post-hoc enforcement that creates
 * the training signal DSPy needs to learn from workflow deviations.
 */
export async function runPostSessionAudit(
  sessionId: string,
  cardId: string,
  config: FactoryDispatchConfig,
  log: Logger,
): Promise<AuditResult | null> {
  const validator = new PunchCardValidator({
    host: config.host === "127.0.0.1" ? config.host : "127.0.0.1",
    port: config.doltPort,
    database: process.env.DOLT_DATABASE ?? "beads_repomap-core",
    user: "root",
  });

  try {
    await validator.connect();
    const result = await validator.validatePunchCard(sessionId, cardId);
    const audit: AuditResult = {
      cardId,
      status: result.status,
      missing: result.missing.map((m) => `${m.punchType}:${m.punchKeyPattern}`),
      violations: result.violations.map((v) => `${v.punchType}:${v.punchKeyPattern} (${v.count}x)`),
    };

    if (result.status === "pass") {
      log(`${timestamp()} ✅ AUDIT PASS: card=${cardId} session=${sessionId}`);
    } else {
      log(`${timestamp()} ❌ AUDIT FAIL: card=${cardId} session=${sessionId}`);
      if (audit.missing.length > 0) {
        log(`${timestamp()}   Missing: ${audit.missing.join(", ")}`);
      }
      if (audit.violations.length > 0) {
        log(`${timestamp()}   Violations: ${audit.violations.join(", ")}`);
      }
    }

    return audit;
  } catch (e) {
    log(`${timestamp()} Warning: post-session audit failed: ${(e as Error).message}`);
    return null;
  } finally {
    await validator.disconnect();
  }
}

// ── Prompt file writing (used by thin shell wrapper) ─────────────────────

/**
 * Write a prompt payload to a temporary JSON file.
 * Returns the path to the file.
 */
export function writePromptFile(payload: PromptPayload, path: string): void {
  writeFileSync(path, JSON.stringify(payload));
}
