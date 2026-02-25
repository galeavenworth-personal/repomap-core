/**
 * Fitter Dispatch — Dispatch bounded line fitter sessions to recover from failures.
 *
 * After a runaway session is killed and diagnosed, the fitter dispatch module
 * generates a laser-focused prompt and dispatches a fresh, bounded session
 * to fix what the original session failed to do.
 *
 * Each diagnosis category maps to a specialized prompt template and session
 * configuration:
 *   - stuck_on_approval  → re-dispatch with auto-approve permissions
 *   - infinite_retry     → include error message + fix hint in prompt
 *   - scope_creep        → narrow scope + explicit constraints
 *   - context_exhaustion → split task into smaller subtasks
 *   - model_confusion    → switch model + simplified prompt
 *
 * Design: uses a SessionDispatcher interface for the actual session creation,
 * allowing Temporal workflow integration or direct kilo serve SDK calls.
 *
 * Cost reference: decomposed bounded tasks cost ~$0.42/100k vs monolithic
 * $0.72/100k (42% savings).
 */

import type {
  DiagnosisCategory,
  DiagnosisReport,
  FitterDispatchInput,
  FitterResult,
  ToolPattern,
} from "./types.js";

// ── Session Dispatcher Interface ──

/**
 * Abstraction over the external session creation mechanism.
 *
 * Production implementations dispatch via Temporal workflows or the
 * kilo serve SDK. Tests can supply a mock that returns canned results.
 */
export interface SessionDispatcher {
  /** Create a new bounded session with the given prompt and config. */
  createSession(request: SessionRequest): Promise<SessionResponse>;
}

/** Request to create a bounded fitter session. */
export interface SessionRequest {
  /** The prompt to send to the agent. */
  prompt: string;
  /** Maximum context budget in tokens. */
  maxTokenBudget: number;
  /** Timeout in milliseconds. */
  timeoutMs: number;
  /** Agent mode override (e.g. "code", "architect"). */
  agentMode: string;
  /** Model override, if applicable. */
  model?: string;
  /** Whether to auto-approve file operations. */
  autoApprove: boolean;
  /** kilo serve connection info. */
  kiloHost: string;
  kiloPort: number;
}

/** Response from session creation. */
export interface SessionResponse {
  sessionId: string;
  success: boolean;
  cost: number;
  filesChanged: string[];
  durationMs: number;
  error: string | null;
}

// ── Configuration ──

export interface FitterDispatchConfig {
  /** Default kilo serve host (default: "localhost"). */
  kiloHost: string;
  /** Default kilo serve port (default: 42069). */
  kiloPort: number;
  /** Default maximum context budget in tokens (default: 100_000). */
  defaultTokenBudget: number;
  /** Default agent mode (default: "code"). */
  defaultAgentMode: string;
  /** Base timeout in ms per estimated dollar of work (default: 60_000). */
  timeoutMsPerDollar: number;
  /** Minimum timeout in ms (default: 30_000). */
  minTimeoutMs: number;
  /** Maximum timeout in ms (default: 300_000). */
  maxTimeoutMs: number;
}

export const DEFAULT_FITTER_CONFIG: FitterDispatchConfig = {
  kiloHost: "localhost",
  kiloPort: 42069,
  defaultTokenBudget: 100_000,
  defaultAgentMode: "code",
  timeoutMsPerDollar: 60_000,
  minTimeoutMs: 30_000,
  maxTimeoutMs: 300_000,
};

// ── Prompt Templates ──

/**
 * Generate a fitter prompt based on the diagnosis category.
 *
 * Each template follows the pattern:
 *   "Fix X because Y. Do not touch Z. Commit and exit."
 */
function buildFitterPrompt(report: DiagnosisReport): string {
  switch (report.category) {
    case "stuck_on_approval":
      return buildStuckOnApprovalPrompt(report);
    case "infinite_retry":
      return buildInfiniteRetryPrompt(report);
    case "scope_creep":
      return buildScopeCreepPrompt(report);
    case "context_exhaustion":
      return buildContextExhaustionPrompt(report);
    case "model_confusion":
      return buildModelConfusionPrompt(report);
  }
}

function buildStuckOnApprovalPrompt(report: DiagnosisReport): string {
  const tools = formatToolSummary(report.toolPatterns);
  return [
    `RECOVERY TASK: Complete the work that session ${report.sessionId} could not finish.`,
    "",
    `Problem: ${report.summary}`,
    `The previous session was stuck waiting for approval that never came.`,
    "",
    `Action: ${report.suggestedAction}`,
    "",
    `Previous session tool activity:`,
    tools,
    "",
    `You have full auto-approve permissions for all file operations.`,
    `Complete the pending changes, verify correctness, commit, and exit.`,
  ].join("\n");
}

function buildInfiniteRetryPrompt(report: DiagnosisReport): string {
  // Extract the failing tool and error from the summary
  const errorMatch = report.summary.match(/Last error: (.+)/);
  const lastError = errorMatch?.[1] ?? "unknown error";
  const toolMatch = report.summary.match(/Tool "([^"]+)"/);
  const failingTool = toolMatch?.[1] ?? "unknown tool";
  const tools = formatToolSummary(report.toolPatterns);

  return [
    `RECOVERY TASK: Fix the error that caused session ${report.sessionId} to loop.`,
    "",
    `Problem: ${report.summary}`,
    `The previous session kept retrying "${failingTool}" and hitting the same error.`,
    "",
    `Error message: ${lastError}`,
    `Hint: Do NOT retry the same approach. The previous session already tried it ${extractRetryCount(report)} times and failed.`,
    `Analyze the error, understand the root cause, and apply a different fix.`,
    "",
    `Previous session tool activity:`,
    tools,
    "",
    `Fix the underlying issue, verify the fix works, commit, and exit.`,
  ].join("\n");
}

function buildScopeCreepPrompt(report: DiagnosisReport): string {
  const tools = formatToolSummary(report.toolPatterns);

  return [
    `RECOVERY TASK: Complete ONLY the core fix from session ${report.sessionId}.`,
    "",
    `Problem: ${report.summary}`,
    `The previous session expanded scope far beyond the original task.`,
    "",
    `Previous session tool activity:`,
    tools,
    "",
    `Action: ${report.suggestedAction}`,
    "",
    `Do NOT:`,
    `- Refactor unrelated code`,
    `- Add features not directly required by the fix`,
    `- Expand scope beyond the original task`,
    "",
    `Make the minimal change needed, verify it, commit, and exit.`,
  ].join("\n");
}

function buildContextExhaustionPrompt(report: DiagnosisReport): string {
  const tools = formatToolSummary(report.toolPatterns);

  return [
    `RECOVERY TASK: Complete the work from session ${report.sessionId} using a focused approach.`,
    "",
    `Problem: ${report.summary}`,
    `The previous session exhausted its context window re-reading the same content.`,
    "",
    `Previous session tool activity:`,
    tools,
    "",
    `Strategy: Work on ONE file at a time. Do not read files you don't need to edit.`,
    "",
    `Plan:`,
    `1. Identify which file needs the primary fix`,
    `2. Make the change in that file`,
    `3. If dependent files need updating, handle them one at a time`,
    `4. Commit after each logical change`,
    `5. Exit when the task is complete`,
    "",
    `Do not search the codebase broadly. Stay focused on the task.`,
  ].join("\n");
}

function buildModelConfusionPrompt(report: DiagnosisReport): string {
  const tools = formatToolSummary(report.toolPatterns);

  return [
    `RECOVERY TASK: Fix what session ${report.sessionId} could not.`,
    "",
    `Problem: ${report.summary}`,
    `The previous session was confused and producing contradictory changes.`,
    "",
    `Previous session tool activity:`,
    tools,
    "",
    `SIMPLIFIED INSTRUCTIONS:`,
    `1. Gather context on the task`,
    `2. Identify what needs to change`,
    `3. Make the change`,
    `4. Commit and exit`,
    "",
    `Suggested approach: ${report.suggestedAction}`,
    "",
    `Keep it simple. One change at a time. Do not over-think.`,
  ].join("\n");
}

// ── Prompt Helpers ──

function formatToolSummary(patterns: ToolPattern[]): string {
  if (patterns.length === 0) return "  (no tool activity recorded)";
  return patterns
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
    .map((p) => `  - ${p.tool}: ${p.count} calls${p.errorCount > 0 ? ` (${p.errorCount} errors)` : ""}`)
    .join("\n");
}

function extractRetryCount(report: DiagnosisReport): number {
  // Try to extract retry count from tool patterns
  const failingPatterns = report.toolPatterns.filter(
    (p) => p.errorCount > 0
  );
  if (failingPatterns.length === 0) return 3; // default estimate
  return Math.max(...failingPatterns.map((p) => p.errorCount));
}

// ── Session Configuration ──

/** Determine the agent mode based on diagnosis category. */
function resolveAgentMode(
  _category: DiagnosisCategory,
  override?: string
): string {
  if (override) return override;
  // All fitter sessions currently use code mode
  return "code";
}

/** Determine whether to switch models for this category. */
function resolveModel(category: DiagnosisCategory): string | undefined {
  switch (category) {
    case "model_confusion":
      // Switch to a different model to avoid repeating the same confusion
      return "anthropic/claude-sonnet-4";
    default:
      return undefined;
  }
}

/** Should the fitter session auto-approve file operations? */
function resolveAutoApprove(_category: DiagnosisCategory): boolean {
  // All fitter sessions get auto-approve — they operate on known files
  // with bounded scope and are supervised by the governor
  return true;
}

/**
 * Compute timeout based on the cost of the killed session.
 *
 * When the actual cost from KillConfirmation is available, we budget
 * the fitter at ~50% of that cost (bounded fitters should be cheaper).
 * Falls back to a synthetic estimate from tool patterns if no actual
 * cost is provided.
 */
function computeTimeout(
  report: DiagnosisReport,
  config: FitterDispatchConfig,
  actualCostUsd?: number
): number {
  // Prefer actual session cost from KillConfirmation when available
  const estimatedCost = actualCostUsd != null
    ? actualCostUsd * 0.5 // fitter should cost ~50% of original
    : report.toolPatterns.reduce(
        (sum, p) => sum + p.count * 0.001,
        0.1 // minimum baseline (fallback only)
      );

  const rawTimeout = estimatedCost * config.timeoutMsPerDollar;
  return Math.min(
    config.maxTimeoutMs,
    Math.max(config.minTimeoutMs, rawTimeout)
  );
}

// ── Fitter Dispatch ──

export interface FitterDispatchDeps {
  config?: Partial<FitterDispatchConfig>;
  dispatcher: SessionDispatcher;
}

/**
 * Dispatch a bounded line fitter session to recover from a diagnosed failure.
 *
 * Takes a DiagnosisReport (from the diagnosis engine) and dispatches a
 * fresh session with a category-specific prompt, bounded context budget,
 * and appropriate timeout.
 *
 * Returns a FitterResult with sessionId, cost, success, and files_changed.
 */
export class FitterDispatch {
  private readonly config: FitterDispatchConfig;
  private readonly dispatcher: SessionDispatcher;

  constructor(deps: FitterDispatchDeps) {
    this.config = { ...DEFAULT_FITTER_CONFIG, ...deps.config };
    this.dispatcher = deps.dispatcher;
  }

  /**
   * Dispatch a fitter session for the given diagnosis report.
   *
   * Steps:
   *   1. Generate category-specific prompt
   *   2. Resolve session configuration (mode, model, budget, timeout)
   *   3. Dispatch bounded session via SessionDispatcher
   *   4. Return structured FitterResult
   */
  async dispatch(report: DiagnosisReport): Promise<FitterResult>;
  async dispatch(input: FitterDispatchInput): Promise<FitterResult>;
  async dispatch(
    reportOrInput: DiagnosisReport | FitterDispatchInput
  ): Promise<FitterResult> {
    const { report, input } = normalizeInput(reportOrInput);

    const prompt = buildFitterPrompt(report);
    const agentMode = resolveAgentMode(report.category, input?.agentMode);
    const model = resolveModel(report.category);
    const autoApprove = resolveAutoApprove(report.category);
    const tokenBudget =
      input?.maxTokenBudget ?? this.config.defaultTokenBudget;
    const actualCost = input?.killConfirmation?.finalMetrics?.totalCost;
    const timeoutMs = computeTimeout(report, this.config, actualCost);
    const kiloHost = input?.kiloHost ?? this.config.kiloHost;
    const kiloPort = input?.kiloPort ?? this.config.kiloPort;

    console.log(
      `[governor] Dispatching fitter for ${report.sessionId} ` +
        `(${report.category}, confidence=${report.confidence.toFixed(2)}, ` +
        `budget=${tokenBudget}tok, timeout=${timeoutMs}ms)`
    );

    try {
      const response = await this.dispatcher.createSession({
        prompt,
        maxTokenBudget: tokenBudget,
        timeoutMs,
        agentMode,
        model,
        autoApprove,
        kiloHost,
        kiloPort,
      });

      console.log(
        `[governor] Fitter ${response.sessionId} completed: ` +
          `success=${response.success}, cost=$${response.cost.toFixed(2)}, ` +
          `files=${response.filesChanged.length}, duration=${response.durationMs}ms`
      );

      return {
        sessionId: response.sessionId,
        success: response.success,
        cost: response.cost,
        filesChanged: response.filesChanged,
        durationMs: response.durationMs,
        error: response.error,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[governor] Fitter dispatch failed for ${report.sessionId}: ${msg}`
      );

      return {
        sessionId: `fitter-failed-${report.sessionId}`,
        success: false,
        cost: 0,
        filesChanged: [],
        durationMs: 0,
        error: msg,
      };
    }
  }
}

// ── Input Normalization ──

/**
 * Accept either a bare DiagnosisReport or a full FitterDispatchInput.
 * Returns both the report and optional input overrides.
 */
function normalizeInput(reportOrInput: DiagnosisReport | FitterDispatchInput): {
  report: DiagnosisReport;
  input: FitterDispatchInput | null;
} {
  if ("diagnosis" in reportOrInput) {
    return {
      report: reportOrInput.diagnosis,
      input: reportOrInput,
    };
  }
  return { report: reportOrInput, input: null };
}
