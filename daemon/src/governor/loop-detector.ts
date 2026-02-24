/**
 * Loop Detector — Real-time runaway session detection.
 *
 * Monitors a punch stream for four classes of runaway behavior:
 *   1. step_overflow  — step count exceeds threshold
 *   2. cost_overflow  — cumulative cost exceeds budget
 *   3. tool_cycle     — repeated tool pattern (e.g. bash→edit→bash→edit)
 *   4. cache_plateau  — sliding window of source hashes shows no new information
 *
 * The detector is stateful per session. Feed it punches via `ingest()` and
 * check `detect()` after each punch (or batch).
 *
 * Design: pure computation, no I/O. Suitable for use inside Temporal
 * workflows (deterministic) or standalone.
 */

import type { Punch } from "../classifier/index.js";
import {
  DEFAULT_THRESHOLDS,
  type GovernorThresholds,
  type LoopClassification,
  type LoopDetection,
  type SessionMetrics,
} from "./types.js";

export interface LoopDetectorOptions {
  sessionId: string;
  thresholds?: Partial<GovernorThresholds>;
}

/**
 * Per-session loop detector. Accumulates punch data and checks for
 * loop signatures on each `detect()` call.
 */
export class LoopDetector {
  readonly sessionId: string;
  private readonly thresholds: GovernorThresholds;

  // Accumulation state
  private stepCount = 0;
  private totalCost = 0;
  private toolCallCount = 0;
  private toolHistory: string[] = [];
  private sourceHashes: string[] = [];
  private startTime: number;

  constructor(options: LoopDetectorOptions) {
    this.sessionId = options.sessionId;
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
    this.startTime = Date.now();
  }

  /** Feed a classified punch into the detector. */
  ingest(punch: Punch): void {
    if (punch.punchType === "step_complete") {
      this.stepCount++;
    }

    if (punch.punchType === "tool_call") {
      this.toolCallCount++;
      this.toolHistory.push(punch.punchKey);
    }

    if (punch.cost != null) {
      this.totalCost += punch.cost;
    }

    this.sourceHashes.push(punch.sourceHash);
  }

  /** Return current accumulated metrics. */
  getMetrics(): SessionMetrics {
    const windowSize = this.thresholds.cacheWindowSize;
    const recentTools = this.toolHistory.slice(-windowSize);
    const recentHashes = this.sourceHashes.slice(-windowSize);
    const uniqueSourceHashes = new Set(recentHashes).size;

    return {
      stepCount: this.stepCount,
      totalCost: this.totalCost,
      toolCalls: this.toolCallCount,
      recentTools,
      uniqueSourceHashes,
      elapsedMs: Date.now() - this.startTime,
    };
  }

  /**
   * Check all heuristics and return the first detected loop, or null.
   *
   * Priority order: cost_overflow > step_overflow > tool_cycle > cache_plateau.
   * Cost is checked first because it has the most direct financial impact.
   */
  detect(): LoopDetection | null {
    return (
      this.detectCostOverflow() ??
      this.detectStepOverflow() ??
      this.detectToolCycle() ??
      this.detectCachePlateau()
    );
  }

  // ── Individual Heuristics ──

  private detectStepOverflow(): LoopDetection | null {
    if (this.stepCount <= this.thresholds.maxSteps) return null;
    return this.makeDetection(
      "step_overflow",
      `Step count ${this.stepCount} exceeds threshold ${this.thresholds.maxSteps}`
    );
  }

  private detectCostOverflow(): LoopDetection | null {
    if (this.totalCost <= this.thresholds.maxCostUsd) return null;
    return this.makeDetection(
      "cost_overflow",
      `Cost $${this.totalCost.toFixed(2)} exceeds budget $${this.thresholds.maxCostUsd.toFixed(2)}`
    );
  }

  /**
   * Detect repeating tool call patterns.
   *
   * Looks for a pattern of length L (minCycleLength..maxCycleLength)
   * that repeats at least `cycleRepetitions` times consecutively
   * at the tail of the tool history.
   */
  private detectToolCycle(): LoopDetection | null {
    const history = this.toolHistory;
    const { minCycleLength, maxCycleLength, cycleRepetitions } = this.thresholds;

    for (let len = minCycleLength; len <= maxCycleLength; len++) {
      const needed = len * cycleRepetitions;
      if (history.length < needed) continue;

      const tail = history.slice(-needed);
      const pattern = tail.slice(0, len);

      let isRepeating = true;
      for (let rep = 1; rep < cycleRepetitions; rep++) {
        for (let i = 0; i < len; i++) {
          if (tail[rep * len + i] !== pattern[i]) {
            isRepeating = false;
            break;
          }
        }
        if (!isRepeating) break;
      }

      if (isRepeating) {
        const cycleStr = pattern.join("→");
        return this.makeDetection(
          "tool_cycle",
          `Tool cycle detected: [${cycleStr}] repeated ${cycleRepetitions}× (pattern length ${len})`
        );
      }
    }

    return null;
  }

  /**
   * Detect cache plateau — the context window is full and no new
   * information is being added.
   *
   * Heuristic: if the ratio of unique source hashes to window size
   * drops below the threshold, the agent is re-reading the same content.
   */
  private detectCachePlateau(): LoopDetection | null {
    const { cacheWindowSize, cachePlateuRatio } = this.thresholds;
    if (this.sourceHashes.length < cacheWindowSize) return null;

    const window = this.sourceHashes.slice(-cacheWindowSize);
    const uniqueCount = new Set(window).size;
    const ratio = uniqueCount / cacheWindowSize;

    if (ratio >= cachePlateuRatio) return null;

    return this.makeDetection(
      "cache_plateau",
      `Cache plateau: ${uniqueCount}/${cacheWindowSize} unique hashes (ratio ${ratio.toFixed(2)} < ${cachePlateuRatio})`
    );
  }

  // ── Helpers ──

  private makeDetection(
    classification: LoopClassification,
    reason: string
  ): LoopDetection {
    return {
      sessionId: this.sessionId,
      classification,
      reason,
      metrics: this.getMetrics(),
      detectedAt: new Date(),
    };
  }
}
