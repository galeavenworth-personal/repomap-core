/**
 * Factory Dispatch — Orchestration module
 *
 * Main entry point for factory dispatch pipeline.
 * Delegates session transport to kilo-client.ts and
 * post-session validation to punch-card-audit.ts.
 *
 * See: repomap-core-76q
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import * as childProcess from "node:child_process";
import { promisify } from "node:util";
import { createConnection as createMysqlConnection } from "mysql2/promise";
import { findRepoRoot, timestamp } from "./utils.js";
import { withPm2Connection, isAppOnline } from "./pm2-client.js";
import {
  createSession,
  dispatchPrompt,
  fetchChildren,
  fetchMessages,
  monitorSession,
  extractResult,
} from "./kilo-client.js";
import type { ChildSession } from "./kilo-client.js";

import { resolveCardExitPrompt, injectCardExitPrompt } from "../optimization/prompt-injection.js";
import { runPostSessionAudit } from "./punch-card-audit.js";
import type { AuditResult } from "./punch-card-audit.js";

export interface FactoryDispatchConfig {
  mode: string;
  title: string;
  host: string;
  port: number;
  maxWait: number;
  pollInterval: number;
  quiet: boolean;
  noMonitor: boolean;
  jsonOutput: boolean;
  promptArg: string;
  formula: string;
  vars: string[];
  idleConfirm: number;
  doltPort: number;
  temporalPort: number;
  pm2Bin: string;
  cardId: string;
  beadId: string;
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
    formula: "",
    vars: [],
    idleConfirm: Number(process.env.IDLE_CONFIRM ?? "3"),
    doltPort: Number(process.env.DOLT_PORT ?? "3307"),
    temporalPort: Number(process.env.TEMPORAL_PORT ?? "7233"),
    pm2Bin: `${repoRoot}/daemon/node_modules/.bin/pm2`,
    cardId: "",
    beadId: "",
  };
}

export interface PromptPart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface PromptPayload {
  agent?: string;
  parts: PromptPart[];
  bead_id?: string;
  [key: string]: unknown;
}

export interface PreflightComponent {
  name: string;
  ok: boolean;
  detail: string;
}

export interface PreflightResult {
  ok: boolean;
  components: PreflightComponent[];
}

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

// Formula step as parsed from bd mol show output
interface MoleculeStep {
  id: string;
  title: string;
  description: string;
  labels: string[];
  status?: string;
}

// Aggregate result for molecule dispatch
export interface MoleculeDispatchResult {
  molecule_id: string;
  formula: string;
  steps: Array<{
    step_id: string;
    bead_id: string;
    mode: string;
    card?: string;
    session_id?: string;
    status: "dispatched" | "skipped" | "failed" | "completed";
    result?: string;
    elapsed_seconds?: number;
    error?: string;
  }>;
  total_steps: number;
  dispatched_steps: number;
  skipped_steps: number;
  failed_steps: number;
}

export const ExitCode = {
  SUCCESS: 0,
  GENERAL_ERROR: 1,
  USAGE_ERROR: 1,
  HEALTH_CHECK_FAILED: 2,
  SESSION_CREATION_FAILED: 3,
  PROMPT_DISPATCH_FAILED: 4,
  TIMEOUT: 5,
  NO_RESPONSE: 6,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export {
  createSession,
  dispatchPrompt,
  isSessionDone,
  fetchChildren,
  fetchMessages,
  areAllChildrenDone,
  monitorSession,
  extractResult,
} from "./kilo-client.js";
export type {
  MessagePart,
  SessionMessage,
  ChildSession,
  MonitorResult,
} from "./kilo-client.js";
export { runPostSessionAudit } from "./punch-card-audit.js";
export type { AuditResult } from "./punch-card-audit.js";

export type Logger = (msg: string) => void;

const execFileAsync = promisify(childProcess.execFile);

function makeLogger(quiet: boolean): Logger {
  return (msg: string) => {
    if (!quiet) {
      process.stderr.write(`[factory] ${msg}\n`);
    }
  };
}

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

export async function isPm2AppOnline(_pm2Bin: string, appName: string): Promise<boolean> {
  try {
    return await withPm2Connection(() => isAppOnline(appName));
  } catch {
    return false;
  }
}

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
    if (resp.status === 401) {
      // 401 means kilo is alive but needs auth — treat as healthy
      log(`${timestamp()}   ✅ kilo serve (alive, auth required)`);
      components.push({ name: "kilo serve", ok: true, detail: "alive (auth required)" });
    } else if (resp.ok) {
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
  const ocdOk = await isPm2AppOnline(config.pm2Bin, "oc-daemon");
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
  const twOk = await isPm2AppOnline(config.pm2Bin, "temporal-worker");
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

function reportPreflightFailure(missing: PreflightComponent[]): ExitCodeValue {
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

function resolvePayload(config: FactoryDispatchConfig, log: Logger): PromptPayload | ExitCodeValue {
  try {
    const payload = buildPromptPayload(config.promptArg, config.mode);
    if (config.promptArg.endsWith(".json")) {
      log(`${timestamp()} Loaded prompt from: ${config.promptArg}`);
    } else {
      log(`${timestamp()} Built prompt from string (${config.promptArg.length} chars)`);
    }
    return payload;
  } catch (e) {
    process.stderr.write(`ERROR: ${(e as Error).message}\n`);
    return ExitCode.USAGE_ERROR;
  }
}

async function resolveSessionId(
  baseUrl: string,
  title: string,
  fetchFn: typeof fetch,
): Promise<string | null> {
  try {
    return await createSession(baseUrl, title, fetchFn);
  } catch {
    process.stderr.write("ERROR: Failed to create session\n");
    return null;
  }
}

async function writeInitialTask(
  config: FactoryDispatchConfig,
  sessionId: string,
  log: Logger,
): Promise<void> {
  const database = process.env.DOLT_DATABASE ?? "factory";

  try {
    const conn = await createMysqlConnection({
      host: config.host,
      port: config.doltPort,
      user: process.env.DOLT_USER ?? "root",
      password: process.env.DOLT_PASSWORD ?? "",
      database,
    });

    try {
      await conn.execute(
        `INSERT INTO tasks (task_id, mode, started_at, punch_card_id, bead_id)
         VALUES (?, ?, NOW(), ?, ?)
         ON DUPLICATE KEY UPDATE
           punch_card_id = COALESCE(VALUES(punch_card_id), punch_card_id),
           bead_id = COALESCE(VALUES(bead_id), bead_id)`,
        [sessionId, config.mode, config.cardId || null, config.beadId || null],
      );

      log(
        `${timestamp()} Task row created: ${sessionId}` +
          (config.beadId ? ` (bead: ${config.beadId})` : ""),
      );
    } finally {
      await conn.end();
    }
  } catch (e) {
    log(`${timestamp()} Warning: failed to create task row: ${(e as Error).message}`);
  }
}

/**
 * Derive hierarchy depth from a bead ID convention: dots indicate nesting.
 * "repomap-core-1ax" → 1, "repomap-core-1ax.3" → 2, "repomap-core-mol-d9jz.2" → 2
 */
function beadDepth(beadId: string): number {
  const base = beadId.replace(/^repomap-core-/, "");
  const dotCount = (base.match(/\./g) ?? []).length;
  return dotCount + 1;
}

/**
 * Look up formula_id from beads DB metadata for a given bead.
 * Returns { formulaId, depth } or nulls on any failure.
 */
async function lookupBeadContext(
  beadId: string,
  doltHost: string,
  doltPort: number,
): Promise<{ formulaId: string | undefined; depth: number }> {
  const depth = beadDepth(beadId);
  try {
    const conn = await createMysqlConnection({
      host: doltHost,
      port: doltPort,
      user: process.env.DOLT_USER ?? "root",
      password: process.env.DOLT_PASSWORD ?? "",
      database: "beads_repomap-core",
      connectTimeout: 2000,
    });
    try {
      const [rows] = await conn.execute(
        "SELECT JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.formula_id')) AS formula_id FROM issues WHERE id = ?",
        [beadId],
      );
      const row = (rows as Array<{ formula_id: string | null }>)[0];
      const formulaId = row?.formula_id && row.formula_id !== "null" ? row.formula_id : undefined;
      return { formulaId, depth };
    } finally {
      await conn.end();
    }
  } catch {
    return { formulaId: undefined, depth };
  }
}

async function maybeInjectCardPrompt(
  payload: PromptPayload,
  config: FactoryDispatchConfig,
  log: Logger,
): Promise<void> {
  try {
    let depth: number | undefined;
    let formulaId: string | undefined;

    if (config.beadId) {
      const ctx = await lookupBeadContext(config.beadId, config.host, config.doltPort);
      depth = ctx.depth;
      formulaId = ctx.formulaId;
    }

    const cardResolution = await resolveCardExitPrompt(
      config.mode,
      config.cardId || undefined,
      depth,
      formulaId,
    );
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
      return;
    }

    const cardSuffix = config.cardId ? ` card=${config.cardId}` : "";
    log(`${timestamp()} No card exit prompt found for mode=${config.mode}${cardSuffix}`);
  } catch (e) {
    log(`${timestamp()} Warning: card exit prompt resolution failed: ${(e as Error).message}`);
  }
}

function outputNoMonitorResult(config: FactoryDispatchConfig, sessionId: string, title: string): ExitCodeValue {
  if (config.jsonOutput) {
    process.stdout.write(
      JSON.stringify({ session_id: sessionId, mode: config.mode, title }) + "\n",
    );
  } else {
    process.stdout.write(sessionId + "\n");
  }
  return ExitCode.SUCCESS;
}

function logChildSessionIds(log: Logger, childIds: string[]): void {
  if (childIds.length === 0) {
    return;
  }
  log(`${timestamp()} Child session IDs captured for handoff:`);
  for (const cid of childIds) {
    log(`  - ${cid}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function getStringField(data: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function getArrayField(data: Record<string, unknown>, keys: string[]): unknown[] {
  for (const key of keys) {
    const value = data[key];
    if (Array.isArray(value)) {
      return value;
    }
  }
  return [];
}

function normalizeMoleculeSteps(raw: unknown): MoleculeStep[] {
  const data = asRecord(raw);
  const rawSteps = getArrayField(data, ["steps", "poured_steps", "pouredSteps"]);

  return rawSteps
    .map((item) => {
      const step = asRecord(item);
      const id = getStringField(step, ["bead_id", "beadId", "id"]);
      if (!id) {
        return null;
      }

      const title = getStringField(step, ["title", "name"]) ?? id;
      const description = getStringField(step, ["description", "prompt", "body"]) ?? "";
      const rawLabels = Array.isArray(step.labels) ? step.labels : [];
      const labels = rawLabels.filter((label): label is string => typeof label === "string");
      const status = getStringField(step, ["status"]);
      return { id, title, description, labels, ...(status ? { status } : {}) };
    })
    .filter((step): step is MoleculeStep => step !== null);
}


// Build molecule steps by merging cooked formula steps (with labels) and pour id_mapping (with bead IDs)
function buildStepsFromCookAndPour(cookedOutput: unknown, pouredOutput: unknown, protoId: string): MoleculeStep[] {
  const cooked = asRecord(cookedOutput);
  const poured = asRecord(pouredOutput);
  const idMapping = asRecord(poured.id_mapping);
  const rawSteps = getArrayField(cooked, ["steps"]);

  return rawSteps
    .map((item) => {
      const step = asRecord(item);
      const stepId = getStringField(step, ["id"]);
      if (!stepId) return null;

      // Map formula step ID to poured bead ID via id_mapping
      const mappingKey = `${protoId}.${stepId}`;
      const beadId = getStringField(idMapping, [mappingKey]) ?? stepId;

      const title = getStringField(step, ["title", "name"]) ?? stepId;
      const description = getStringField(step, ["description", "prompt", "body"]) ?? "";
      const rawLabels = Array.isArray(step.labels) ? step.labels : [];
      const labels = rawLabels.filter((label): label is string => typeof label === "string");
      return { id: beadId, title, description, labels };
    })
    .filter((step): step is MoleculeStep => step !== null);
}

function parseCookProtoId(raw: unknown): string | undefined {
  const data = asRecord(raw);
  const nestedProto = asRecord(data.proto);
  return (
    getStringField(data, ["id", "proto_id", "protoId"]) ??
    getStringField(nestedProto, ["id", "proto_id", "protoId"])
  );
}

function parseMoleculeId(raw: unknown): string | undefined {
  const data = asRecord(raw);
  const nestedMolecule = asRecord(data.molecule);
  return (
    getStringField(data, ["molecule_id", "moleculeId", "id", "new_epic_id"]) ??
    getStringField(nestedMolecule, ["id", "molecule_id", "moleculeId"])
  );
}

// Extract value from label like "mode:architect" → "architect"
export function parseLabelValue(labels: string[], prefix: string): string | undefined {
  const needle = `${prefix}:`;
  for (const label of labels) {
    if (label.startsWith(needle)) {
      const value = label.slice(needle.length).trim();
      return value.length > 0 ? value : undefined;
    }
  }
  return undefined;
}

// Check if step has action:parent label
export function isParentOnlyStep(labels: string[]): boolean {
  return labels.includes("action:parent");
}

// Extract dispatch config overrides from step labels
export function extractStepConfig(labels: string[]): { mode?: string; card?: string; isParent: boolean } {
  return {
    mode: parseLabelValue(labels, "mode"),
    card: parseLabelValue(labels, "card"),
    isParent: isParentOnlyStep(labels),
  };
}

// Build bd cook command args
export function buildCookCommand(formula: string, vars: string[], persist = false): string[] {
  const args = ["cook", formula];
  if (persist) {
    args.push("--persist", "--force");
  }
  for (const variable of vars) {
    args.push("--var", variable);
  }
  args.push("--json");
  return args;
}

// Build bd mol pour command args
export function buildPourCommand(protoId: string, vars: string[]): string[] {
  const args = ["mol", "pour", protoId];
  for (const variable of vars) {
    args.push("--var", variable);
  }
  args.push("--json");
  return args;
}

function buildShowCommand(moleculeId: string): string[] {
  return ["mol", "show", moleculeId, "--json"];
}

// Execute a bd command and parse JSON output
export async function execBd(args: string[]): Promise<unknown> {
  const repoRoot = findRepoRoot();
  const bdPath = `${repoRoot}/.kilocode/tools/bd`;

  try {
    const { stdout } = await execFileAsync(bdPath, args, {
      cwd: repoRoot,
      maxBuffer: 10 * 1024 * 1024,
    });

    if (!stdout || stdout.trim().length === 0) {
      throw new Error("bd command returned empty output");
    }

    return JSON.parse(stdout) as unknown;
  } catch (e) {
    const err = e as Error & { stderr?: string };
    const stderr = err.stderr?.trim();
    const detail = stderr && stderr.length > 0 ? `: ${stderr}` : "";
    throw new Error(`bd ${args.join(" ")} failed${detail}`);
  }
}

export interface DispatchDependencies {
  execBdFn: (args: string[]) => Promise<unknown>;
  runSingleDispatchFn: (
    params: RunSingleDispatchParams,
  ) => Promise<ExitCodeValue | MoleculeStepDispatchOutcome>;
}

export interface MoleculeStepDispatchOutcome {
  code: ExitCodeValue;
  session_id?: string;
  result?: string;
  elapsed_seconds?: number;
}

const defaultDispatchDependencies: DispatchDependencies = {
  execBdFn: execBd,
  runSingleDispatchFn: runSingleDispatch,
};

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

async function runMoleculeDispatch(
  config: FactoryDispatchConfig,
  baseUrl: string,
  log: Logger,
  fetchFn: typeof fetch,
  deps: DispatchDependencies,
): Promise<ExitCodeValue> {
  // Two-phase cook: ephemeral (get steps with labels) then persist (get proto_id)
  let cookedOutput: unknown;
  try {
    log(`${timestamp()} Cooking formula: ${config.formula}`);
    cookedOutput = await deps.execBdFn(buildCookCommand(config.formula, config.vars, false));
  } catch (e) {
    process.stderr.write(`ERROR: ${(e as Error).message}\n`);
    return ExitCode.GENERAL_ERROR;
  }

  let persistedOutput: unknown;
  try {
    persistedOutput = await deps.execBdFn(buildCookCommand(config.formula, config.vars, true));
  } catch (e) {
    process.stderr.write(`ERROR: ${(e as Error).message}\n`);
    return ExitCode.GENERAL_ERROR;
  }

  const protoId = parseCookProtoId(persistedOutput);
  if (!protoId) {
    process.stderr.write("ERROR: Failed to parse proto id from bd cook output\n");
    return ExitCode.GENERAL_ERROR;
  }

  let pouredOutput: unknown;
  try {
    log(`${timestamp()} Pouring proto: ${protoId}`);
    pouredOutput = await deps.execBdFn(buildPourCommand(protoId, config.vars));
  } catch (e) {
    process.stderr.write(`ERROR: ${(e as Error).message}\n`);
    return ExitCode.GENERAL_ERROR;
  }

  const moleculeId = parseMoleculeId(pouredOutput);
  if (!moleculeId) {
    process.stderr.write("ERROR: Failed to parse molecule id from bd mol pour output\n");
    return ExitCode.GENERAL_ERROR;
  }

  let showedOutput: unknown;
  try {
    showedOutput = await deps.execBdFn(buildShowCommand(moleculeId));
  } catch (e) {
    process.stderr.write(`ERROR: ${(e as Error).message}\n`);
    return ExitCode.GENERAL_ERROR;
  }

  if (!isObjectLike(showedOutput)) {
    process.stderr.write("ERROR: Failed to parse molecule steps from bd mol show output\n");
    return ExitCode.GENERAL_ERROR;
  }

  // Primary: merge cooked formula steps (with labels) + pour id_mapping (with bead IDs)
  // Fallback: try bd mol show output, then pour output directly
  const cookedSteps = buildStepsFromCookAndPour(cookedOutput, pouredOutput, protoId);
  const showSteps = normalizeMoleculeSteps(showedOutput);
  const pourSteps = normalizeMoleculeSteps(pouredOutput);
  const effectiveSteps = cookedSteps.length > 0 ? cookedSteps : showSteps.length > 0 ? showSteps : pourSteps;
  const result: MoleculeDispatchResult = {
    molecule_id: moleculeId,
    formula: config.formula,
    steps: [],
    total_steps: effectiveSteps.length,
    dispatched_steps: 0,
    skipped_steps: 0,
    failed_steps: 0,
  };

  for (const step of effectiveSteps) {
    const parsed = extractStepConfig(step.labels);
    const mode = parsed.mode ?? config.mode;
    const card = parsed.card ?? config.cardId;

    if (parsed.isParent) {
      log(`${timestamp()} Skipping parent-only step: ${step.id}`);
      result.skipped_steps += 1;
      result.steps.push({
        step_id: step.id,
        bead_id: step.id,
        mode,
        ...(card ? { card } : {}),
        status: "skipped",
      });
      continue;
    }

    const stepConfig: FactoryDispatchConfig = {
      ...config,
      mode,
      cardId: card ?? "",
      beadId: step.id,
      promptArg: step.description,
      title: step.title,
    };

    try {
      const dispatchOutcome = await deps.runSingleDispatchFn({
        config: stepConfig,
        baseUrl,
        log,
        fetchFn,
      });
      const code =
        typeof dispatchOutcome === "number" ? dispatchOutcome : dispatchOutcome.code;
      const stepDetails =
        typeof dispatchOutcome === "number"
          ? {}
          : {
              ...(dispatchOutcome.session_id ? { session_id: dispatchOutcome.session_id } : {}),
              ...(dispatchOutcome.result ? { result: dispatchOutcome.result } : {}),
              ...(typeof dispatchOutcome.elapsed_seconds === "number"
                ? { elapsed_seconds: dispatchOutcome.elapsed_seconds }
                : {}),
            };

      if (code === ExitCode.SUCCESS) {
        result.dispatched_steps += 1;
        result.steps.push({
          step_id: step.id,
          bead_id: step.id,
          mode,
          ...(card ? { card } : {}),
          status: config.noMonitor ? "dispatched" : "completed",
          ...stepDetails,
        });
      } else {
        result.failed_steps += 1;
        result.steps.push({
          step_id: step.id,
          bead_id: step.id,
          mode,
          ...(card ? { card } : {}),
          status: "failed",
          error: `dispatch exit code ${code}`,
          ...stepDetails,
        });
        if (!config.noMonitor) {
          log(`${timestamp()} Step failed: ${step.id} (exit=${code}); continuing`);
        }
      }
    } catch (e) {
      result.failed_steps += 1;
      const message = (e as Error).message;
      result.steps.push({
        step_id: step.id,
        bead_id: step.id,
        mode,
        ...(card ? { card } : {}),
        status: "failed",
        error: message,
      });
      if (!config.noMonitor) {
        log(`${timestamp()} Step failed: ${step.id} (${message}); continuing`);
      }
    }
  }

  if (config.jsonOutput) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(
      `Molecule ${result.molecule_id}: total=${result.total_steps}, dispatched=${result.dispatched_steps}, skipped=${result.skipped_steps}, failed=${result.failed_steps}\n`,
    );
  }

  const attemptedSteps = result.total_steps - result.skipped_steps;
  if (attemptedSteps > 0 && result.failed_steps === attemptedSteps) {
    return ExitCode.GENERAL_ERROR;
  }
  return ExitCode.SUCCESS;
}

function writeDispatchResultOutput(
  config: FactoryDispatchConfig,
  sessionId: string,
  title: string,
  monitor: { childCount: number; elapsed: number },
  result: string,
  childIds: string[],
  audit: AuditResult | null,
): void {
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
    return;
  }
  process.stdout.write(result + "\n");
}

export interface RunSingleDispatchParams {
  config: FactoryDispatchConfig;
  baseUrl: string;
  log: Logger;
  fetchFn?: typeof fetch;
}

export async function runSingleDispatch({
  config,
  baseUrl,
  log,
  fetchFn = fetch,
}: RunSingleDispatchParams): Promise<ExitCodeValue> {
  // Phase 2: Build prompt payload
  const resolvedPayload = resolvePayload(config, log);
  if (typeof resolvedPayload === "number") {
    return resolvedPayload;
  }
  const payload = resolvedPayload;

  // Phase 3: Create session
  const title =
    config.title || `factory: ${config.mode} @ ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;

  const sessionId = await resolveSessionId(baseUrl, title, fetchFn);
  if (!sessionId) {
    return ExitCode.SESSION_CREATION_FAILED;
  }

  log(`${timestamp()} Session created: ${sessionId}`);
  log(`${timestamp()} Title: ${title}`);

  // Create initial task row in Dolt (captures bead_id at dispatch time)
  await writeInitialTask(config, sessionId, log);

  // Inject SESSION_ID into prompt
  injectSessionId(payload, sessionId);

  // Inject bead_id into payload metadata
  if (config.beadId) {
    payload.bead_id = config.beadId;
  }

  // Phase 3b: Inject card exit prompt
  await maybeInjectCardPrompt(payload, config, log);

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
    return outputNoMonitorResult(config, sessionId, title);
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
  writeDispatchResultOutput(config, sessionId, title, monitor, result, childIds, audit);

  // Phase 9: Child session ID capture
  logChildSessionIds(log, childIds);

  log(
    `${timestamp()} Done. Session: ${sessionId} | Children: ${monitor.childCount} | Elapsed: ${monitor.elapsed}s`,
  );
  log(
    `${timestamp()} Handoff: use --parent-session ${sessionId} with punch_engine for deterministic child ID resolution`,
  );

  return ExitCode.SUCCESS;
}

export async function runDispatch(
  config: FactoryDispatchConfig,
  fetchFn: typeof fetch = fetch,
  deps: DispatchDependencies = defaultDispatchDependencies,
): Promise<ExitCodeValue> {
  const log = makeLogger(config.quiet);
  const baseUrl = `http://${config.host}:${config.port}`;

  // Phase 1: Pre-flight
  const pf = await preflight(config, log, fetchFn);
  if (!pf.ok) {
    return reportPreflightFailure(pf.components.filter((c) => !c.ok));
  }

  if (config.formula) {
    return runMoleculeDispatch(config, baseUrl, log, fetchFn, deps);
  }

  const singleOutcome = await deps.runSingleDispatchFn({
    config,
    baseUrl,
    log,
    fetchFn,
  });
  return typeof singleOutcome === "number" ? singleOutcome : singleOutcome.code;
}

export function writePromptFile(payload: PromptPayload, path: string): void {
  writeFileSync(path, JSON.stringify(payload));
}
