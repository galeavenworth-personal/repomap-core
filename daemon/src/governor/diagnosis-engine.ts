/**
 * Failure Diagnosis Engine — Classify line issue type from session state.
 *
 * After killing a runaway session, the diagnosis engine inspects its state
 * to classify the failure for intelligent re-dispatch.
 *
 * Diagnosis categories:
 *   - stuck_on_approval: agent waiting for permission that never comes
 *   - infinite_retry: same tool call failing repeatedly with same error
 *   - scope_creep: agent wandered off-task (blast radius expanding)
 *   - context_exhaustion: cache full, agent re-reading same files
 *   - model_confusion: contradictory tool calls or hallucinated paths
 *
 * Input: session messages from kilo serve API + KillConfirmation
 * Output: DiagnosisReport with category, confidence, suggested_action
 */

import { createOpencodeClient } from "@opencode-ai/sdk/client";

import type {
  DiagnosisCategory,
  DiagnosisReport,
  KillConfirmation,
  ToolPattern,
} from "./types.js";

export interface DiagnosisConfig {
  kiloHost: string;
  kiloPort: number;
}

interface PartInfo {
  type: string;
  tool?: string;
  status?: string;
  error?: string;
  content?: string;
}

/**
 * Diagnose why a killed session was running away.
 *
 * Fetches session messages from kilo serve and analyzes tool call
 * patterns to classify the failure mode.
 */
export async function diagnoseSession(
  config: DiagnosisConfig,
  kill: KillConfirmation
): Promise<DiagnosisReport> {
  const parts = await fetchSessionParts(config, kill.sessionId);
  const toolPatterns = buildToolPatterns(parts);

  // Run all classifiers — highest confidence wins
  const classifiers: Array<() => DiagnosisCandidate | null> = [
    () => detectStuckOnApproval(parts),
    () => detectInfiniteRetry(parts, toolPatterns),
    () => detectContextExhaustion(parts, kill),
    () => detectScopeCreep(parts),
    () => detectModelConfusion(parts, toolPatterns),
  ];

  let best: DiagnosisCandidate | null = null;
  for (const classify of classifiers) {
    const candidate = classify();
    if (candidate && (!best || candidate.confidence > best.confidence)) {
      best = candidate;
    }
  }

  // Fallback if no classifier matched
  if (!best) {
    best = {
      category: "model_confusion",
      confidence: 0.3,
      summary: "Unable to classify failure — defaulting to model_confusion",
      suggestedAction: "Re-dispatch with simplified prompt and different model",
    };
  }

  return {
    sessionId: kill.sessionId,
    category: best.category,
    confidence: best.confidence,
    summary: best.summary,
    suggestedAction: best.suggestedAction,
    toolPatterns,
    diagnosedAt: new Date(),
  };
}

// ── Classifiers ──

interface DiagnosisCandidate {
  category: DiagnosisCategory;
  confidence: number;
  summary: string;
  suggestedAction: string;
}

/**
 * Detect stuck_on_approval: session stopped producing tool calls,
 * last part type suggests waiting for user input.
 */
function detectStuckOnApproval(parts: PartInfo[]): DiagnosisCandidate | null {
  if (parts.length < 5) return null;

  // Look for a pattern where the last N parts are all text (no tools)
  const tail = parts.slice(-10);
  const textOnly = tail.filter((p) => p.type === "text");
  const toolParts = tail.filter((p) => p.type === "tool");

  // If the tail is mostly text with no tool completions, likely waiting
  if (textOnly.length >= 7 && toolParts.length === 0) {
    return {
      category: "stuck_on_approval",
      confidence: 0.75,
      summary: "Session appears stuck waiting for approval — no tool calls in last 10 parts",
      suggestedAction: "Re-dispatch with auto-approve permissions for file operations",
    };
  }

  // Check if any text content mentions permissions/approval
  const approvalKeywords = ["permission", "approve", "confirm", "proceed", "allow"];
  const mentionsApproval = tail.some((p) =>
    p.content && approvalKeywords.some((kw) =>
      p.content!.toLowerCase().includes(kw)
    )
  );

  if (mentionsApproval && toolParts.length <= 2) {
    return {
      category: "stuck_on_approval",
      confidence: 0.65,
      summary: "Session mentions approval/permission keywords with minimal tool activity",
      suggestedAction: "Re-dispatch with auto-approve permissions",
    };
  }

  return null;
}

/**
 * Detect infinite_retry: same tool failing repeatedly with same/similar error.
 */
function detectInfiniteRetry(
  parts: PartInfo[],
  patterns: ToolPattern[]
): DiagnosisCandidate | null {
  // Find tools with high error rates
  const failingTools = patterns.filter(
    (p) => p.count >= 3 && p.errorCount / p.count >= 0.5
  );

  if (failingTools.length === 0) return null;

  // Check if the same tool is being called back-to-back with errors
  const toolParts = parts.filter((p) => p.type === "tool");
  const lastN = toolParts.slice(-10);
  const errorStreak = countTrailingErrors(lastN);

  if (errorStreak >= 3) {
    const failingTool = lastN[lastN.length - 1]?.tool ?? "unknown";
    const lastError = lastN[lastN.length - 1]?.error ?? "unknown error";
    return {
      category: "infinite_retry",
      confidence: 0.85,
      summary: `Tool "${failingTool}" failing repeatedly (${errorStreak} consecutive errors). Last error: ${truncate(lastError, 200)}`,
      suggestedAction: `Include error message and fix hint for "${failingTool}" in re-dispatch prompt`,
    };
  }

  // Lower confidence: tools with high error rates but not necessarily consecutive
  const worstTool = failingTools.sort(
    (a, b) => b.errorCount / b.count - a.errorCount / a.count
  )[0];
  return {
    category: "infinite_retry",
    confidence: 0.6,
    summary: `Tool "${worstTool.tool}" has ${worstTool.errorCount}/${worstTool.count} errors`,
    suggestedAction: `Include error context for "${worstTool.tool}" in re-dispatch prompt`,
  };
}

/**
 * Detect context_exhaustion: session re-reading same files, cache plateau.
 */
function detectContextExhaustion(
  parts: PartInfo[],
  kill: KillConfirmation
): DiagnosisCandidate | null {
  // If the loop detector already flagged cache_plateau, high confidence
  if (kill.trigger.classification === "cache_plateau") {
    return {
      category: "context_exhaustion",
      confidence: 0.9,
      summary: "Cache plateau detected — agent re-reading same content with no new information",
      suggestedAction: "Split task into smaller subtasks to reduce context window pressure",
    };
  }

  // Check for repeated read-type tool calls
  const readTools = parts.filter(
    (p) =>
      p.type === "tool" &&
      (p.tool === "read" || p.tool === "readFile" || p.tool === "Read" ||
       p.tool === "cat" || p.tool === "grep" || p.tool === "Grep")
  );

  if (readTools.length < 10) return null;

  // High ratio of reads to total tools suggests context searching
  const totalTools = parts.filter((p) => p.type === "tool").length;
  const readRatio = readTools.length / totalTools;

  if (readRatio > 0.7) {
    return {
      category: "context_exhaustion",
      confidence: 0.7,
      summary: `${Math.round(readRatio * 100)}% of tool calls are reads — agent searching for context`,
      suggestedAction: "Split task and provide explicit file paths in re-dispatch prompt",
    };
  }

  return null;
}

/**
 * Detect scope_creep: excessive edit operations suggest the agent
 * expanded beyond its original task scope.
 *
 * NOTE: Blast radius (file-level impact analysis) will be a first-class
 * repomap artifact. This classifier uses edit count as a lightweight proxy.
 */
function detectScopeCreep(
  parts: PartInfo[]
): DiagnosisCandidate | null {
  const editTools = parts.filter(
    (p) =>
      p.type === "tool" &&
      (p.tool === "edit" || p.tool === "editFile" || p.tool === "Edit" ||
       p.tool === "write" || p.tool === "Write" || p.tool === "writeFile")
  );

  if (editTools.length > 15) {
    return {
      category: "scope_creep",
      confidence: 0.75,
      summary: `${editTools.length} edit operations — scope likely expanded beyond original task`,
      suggestedAction: "Re-dispatch with narrowed file scope and explicit constraints",
    };
  }

  if (editTools.length > 8) {
    return {
      category: "scope_creep",
      confidence: 0.5,
      summary: `${editTools.length} edit operations — possible scope creep`,
      suggestedAction: "Re-dispatch with narrowed file scope",
    };
  }

  return null;
}

/**
 * Detect model_confusion: contradictory tool calls, hallucinated paths.
 */
function detectModelConfusion(
  parts: PartInfo[],
  patterns: ToolPattern[]
): DiagnosisCandidate | null {
  // Look for alternating edit-then-revert patterns
  const toolParts = parts.filter((p) => p.type === "tool");

  let flipFlops = 0;
  for (let i = 2; i < toolParts.length; i++) {
    const prev2 = toolParts[i - 2]?.tool;
    const prev1 = toolParts[i - 1]?.tool;
    const curr = toolParts[i]?.tool;
    // edit → undo/revert → edit pattern
    if (
      (prev2 === "edit" || prev2 === "Edit") &&
      (prev1 === "undo" || prev1 === "revert") &&
      (curr === "edit" || curr === "Edit")
    ) {
      flipFlops++;
    }
  }

  if (flipFlops >= 2) {
    return {
      category: "model_confusion",
      confidence: 0.8,
      summary: `Detected ${flipFlops} edit→revert→edit flip-flop cycles — model is confused about what to write`,
      suggestedAction: "Switch to different model with simplified prompt",
    };
  }

  // Check for many errors across diverse tools (shotgun approach)
  const failingToolCount = patterns.filter((p) => p.errorCount > 0).length;
  if (failingToolCount >= 4) {
    return {
      category: "model_confusion",
      confidence: 0.6,
      summary: `${failingToolCount} different tools produced errors — model may be hallucinating tool usage`,
      suggestedAction: "Switch to different model with explicit tool usage examples",
    };
  }

  return null;
}

// ── Data Fetching ──

/** Fetch and flatten session message parts from kilo serve. */
async function fetchSessionParts(
  config: DiagnosisConfig,
  sessionId: string
): Promise<PartInfo[]> {
  try {
    const client = createOpencodeClient({
      baseUrl: `http://${config.kiloHost}:${config.kiloPort}`,
    });

    const { data: messages } = await client.session.messages({
      path: { id: sessionId },
    });

    if (!messages) return [];

    const result: PartInfo[] = [];
    for (const group of messages as unknown[]) {
      const items = Array.isArray(group) ? group : [group];
      for (const msg of items) {
        if (!msg || typeof msg !== "object") continue;
        const msgParts = (msg as Record<string, unknown>).parts as
          | Array<Record<string, unknown>>
          | undefined;
        if (!msgParts) continue;

        for (const part of msgParts) {
          const state = part.state as Record<string, unknown> | undefined;
          result.push({
            type: (part.type as string) ?? "unknown",
            tool: part.tool as string | undefined,
            status: state?.status as string | undefined,
            error: state?.error as string | undefined,
            content: part.content as string | undefined,
          });
        }
      }
    }
    return result;
  } catch {
    return [];
  }
}

// ── Analysis Helpers ──

/** Build tool usage patterns from session parts. */
function buildToolPatterns(parts: PartInfo[]): ToolPattern[] {
  const map = new Map<string, { count: number; errorCount: number; lastStatus: string }>();

  for (const part of parts) {
    if (part.type !== "tool" || !part.tool) continue;

    const existing = map.get(part.tool) ?? { count: 0, errorCount: 0, lastStatus: "unknown" };
    existing.count++;
    if (part.status === "error") existing.errorCount++;
    if (part.status) existing.lastStatus = part.status;
    map.set(part.tool, existing);
  }

  return Array.from(map.entries()).map(([tool, stats]) => ({
    tool,
    ...stats,
  }));
}

/** Count consecutive error status parts at the tail. */
function countTrailingErrors(parts: PartInfo[]): number {
  let count = 0;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].status === "error") {
      count++;
    } else {
      break;
    }
  }
  return count;
}

/** Truncate a string to maxLen, appending "..." if truncated. */
function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen - 3) + "...";
}
