/**
 * Session Audit — Post-workflow anomaly detection from Dolt punch data.
 *
 * After any workflow run, queries Dolt punch data and flags anomalies:
 *   1. Missing quality gate punches (no typecheck/lint/test/build recorded)
 *   2. Cost anomalies (session exceeded cheap zone threshold)
 *   3. Loop signatures (repeated tool patterns, step count spikes)
 *   4. Tool adherence deviation (edit count outside expected range)
 *   5. Incomplete subtask trees (parent completed but children missing/failed)
 *   6. Stall detection (long gaps between punches)
 *
 * Reuses Dolt connection/query patterns from CostBudgetMonitor.
 * Designed for use as a Temporal post-workflow activity or standalone.
 *
 * Anomaly thresholds (from Experiment A/B data):
 *   - Cost per 100k tokens target: ≤$0.42 in cheap zone; >$1.00 is ballooned
 *   - Tool adherence: high edit-to-overhead ratio is healthy
 *   - Session step count: >50 for bounded tasks is anomalous
 *   - Loop detection: repeated tool patterns within short windows
 *   - Stall: >60s gap between punches suggests stuck or confused
 */

import type { DoltConfig } from "../writer/index.js";
import type {
  AuditFinding,
  AuditSeverity,
  AuditVerdict,
  SessionAuditConfig,
  SessionAuditReport,
} from "./types.js";
import {
  BaseDoltClient,
  toNumber,
  parseEnvFloat,
  parseEnvInt,
  type MysqlNumeric,
  type CostAggRow,
  type ChildRow,
} from "./dolt-utils.js";

// ── Configuration ──

export const DEFAULT_AUDIT_CONFIG: SessionAuditConfig = {
  cheapZonePercentileUsd: 0.42,
  costAnomalyThresholdUsd: 1,
  maxExpectedSteps: 50,
  loopMinPatternLength: 2,
  loopMaxPatternLength: 6,
  loopMinRepetitions: 3,
  expectedEditRange: [1, 30],
  maxPunchGapSeconds: 60,
  requiredQualityGates: [
    "gate_pass:typecheck",
    "gate_pass:lint",
    "gate_pass:test",
    "gate_pass:build",
  ],
};

/**
 * Load audit config from environment variables, falling back to defaults.
 *
 * Environment variables:
 *   AUDIT_CHEAP_ZONE_USD          — cost per 100k tokens target (default: 0.42)
 *   AUDIT_COST_ANOMALY_USD        — absolute cost anomaly threshold (default: 1.00)
 *   AUDIT_MAX_EXPECTED_STEPS      — max steps for bounded tasks (default: 50)
 *   AUDIT_MAX_PUNCH_GAP_SECONDS   — max gap between punches (default: 60)
 */
export function loadAuditConfig(
  overrides?: Partial<SessionAuditConfig>,
): SessionAuditConfig {
  return {
    cheapZonePercentileUsd: overrides?.cheapZonePercentileUsd
      ?? parseEnvFloat("AUDIT_CHEAP_ZONE_USD", DEFAULT_AUDIT_CONFIG.cheapZonePercentileUsd),
    costAnomalyThresholdUsd: overrides?.costAnomalyThresholdUsd
      ?? parseEnvFloat("AUDIT_COST_ANOMALY_USD", DEFAULT_AUDIT_CONFIG.costAnomalyThresholdUsd),
    maxExpectedSteps: overrides?.maxExpectedSteps
      ?? parseEnvInt("AUDIT_MAX_EXPECTED_STEPS", DEFAULT_AUDIT_CONFIG.maxExpectedSteps),
    loopMinPatternLength: overrides?.loopMinPatternLength
      ?? DEFAULT_AUDIT_CONFIG.loopMinPatternLength,
    loopMaxPatternLength: overrides?.loopMaxPatternLength
      ?? DEFAULT_AUDIT_CONFIG.loopMaxPatternLength,
    loopMinRepetitions: overrides?.loopMinRepetitions
      ?? DEFAULT_AUDIT_CONFIG.loopMinRepetitions,
    expectedEditRange: overrides?.expectedEditRange
      ?? DEFAULT_AUDIT_CONFIG.expectedEditRange,
    maxPunchGapSeconds: overrides?.maxPunchGapSeconds
      ?? parseEnvInt("AUDIT_MAX_PUNCH_GAP_SECONDS", DEFAULT_AUDIT_CONFIG.maxPunchGapSeconds),
    requiredQualityGates: overrides?.requiredQualityGates
      ?? DEFAULT_AUDIT_CONFIG.requiredQualityGates,
  };
}

// ── Row Types (module-local, not shared) ──

interface PunchRow {
  punch_type: string;
  punch_key: string;
  observed_at: string | Date;
  cost: MysqlNumeric;
}

interface ChildStatusRow {
  child_id: string;
  punch_count: MysqlNumeric;
  has_quality_gate: MysqlNumeric;
}

interface TimestampRow {
  min_at: string | Date | null;
  max_at: string | Date | null;
}

// ── Session Audit ──

/**
 * SessionAudit — Post-workflow anomaly detection from Dolt punch data.
 *
 * Usage:
 *   const audit = new SessionAudit(doltConfig, auditConfig);
 *   await audit.connect();
 *   const report = await audit.runAudit(sessionId);
 *   await audit.disconnect();
 */
export class SessionAudit extends BaseDoltClient {
  private readonly auditConfig: SessionAuditConfig;

  constructor(
    doltConfig: DoltConfig,
    auditConfig?: Partial<SessionAuditConfig>,
  ) {
    super(doltConfig);
    this.auditConfig = loadAuditConfig(auditConfig);
  }

  /** Get the current audit configuration. */
  getConfig(): Readonly<SessionAuditConfig> {
    return { ...this.auditConfig };
  }

  /**
   * Run a full audit on a completed session.
   * Executes all anomaly detectors and produces a structured report.
   */
  async runAudit(sessionId: string): Promise<SessionAuditReport> {
    const findings: AuditFinding[] = [];

    // Gather session metrics
    const metrics = await this.getSessionMetrics(sessionId);
    const childCount = (await this.getChildIds(sessionId)).length;

    // Run all detectors in parallel where possible
    const [
      qualityGateFindings,
      costFindings,
      loopFindings,
      toolAdherenceFindings,
      subtreeFindings,
      stallFindings,
    ] = await Promise.all([
      this.detectMissingQualityGates(sessionId),
      this.detectCostAnomalies(sessionId, metrics),
      this.detectLoopSignatures(sessionId),
      this.detectToolAdherenceDeviation(sessionId),
      this.detectIncompleteSubtaskTree(sessionId),
      this.detectStalls(sessionId),
    ]);

    findings.push(
      ...qualityGateFindings,
      ...costFindings,
      ...loopFindings,
      ...toolAdherenceFindings,
      ...subtreeFindings,
      ...stallFindings,
    );

    // Determine verdict
    const hasCritical = findings.some((f) => f.severity === "critical");
    const hasWarningOrInfo = findings.length > 0;
    let verdict: AuditVerdict = "pass";
    if (hasCritical) {
      verdict = "fail";
    } else if (hasWarningOrInfo) {
      verdict = "warn";
    }

    return {
      sessionId,
      auditedAt: new Date(),
      verdict,
      findings,
      metrics: {
        totalCost: metrics.totalCost,
        stepCount: metrics.stepCount,
        punchCount: metrics.punchCount,
        tokensInput: metrics.tokensInput,
        tokensOutput: metrics.tokensOutput,
        tokensReasoning: metrics.tokensReasoning,
        durationMs: metrics.durationMs,
        childCount,
      },
    };
  }

  // ── Metrics Queries ──

  private async getSessionMetrics(sessionId: string): Promise<{
    totalCost: number;
    stepCount: number;
    punchCount: number;
    tokensInput: number;
    tokensOutput: number;
    tokensReasoning: number;
    durationMs: number;
  }> {
    const conn = this.requireConnection();

    const [costRows] = await conn.execute(
      `SELECT
         COALESCE(SUM(cost), 0)             AS total_cost,
         SUM(CASE WHEN punch_type = 'step_complete' AND punch_key = 'step_finished' THEN 1 ELSE 0 END) AS step_count,
         COALESCE(SUM(tokens_input), 0)     AS tokens_input,
         COALESCE(SUM(tokens_output), 0)    AS tokens_output,
         COALESCE(SUM(tokens_reasoning), 0) AS tokens_reasoning,
         COUNT(*)                            AS punch_count
       FROM punches
       WHERE task_id = ?`,
      [sessionId],
    );

    const rows = costRows as CostAggRow[];
    const row = rows[0];

    // Get duration from first/last punch timestamps
    const [tsRows] = await conn.execute(
      `SELECT
         MIN(observed_at) AS min_at,
         MAX(observed_at) AS max_at
       FROM punches
       WHERE task_id = ?`,
      [sessionId],
    );
    const tsRow = (tsRows as TimestampRow[])[0];
    const minAt = tsRow?.min_at ? new Date(tsRow.min_at).getTime() : 0;
    const maxAt = tsRow?.max_at ? new Date(tsRow.max_at).getTime() : 0;
    const durationMs = minAt > 0 && maxAt > 0 ? maxAt - minAt : 0;

    return {
      totalCost: toNumber(row?.total_cost),
      stepCount: toNumber(row?.step_count),
      punchCount: toNumber(row?.punch_count),
      tokensInput: toNumber(row?.tokens_input),
      tokensOutput: toNumber(row?.tokens_output),
      tokensReasoning: toNumber(row?.tokens_reasoning),
      durationMs,
    };
  }

  private async getChildIds(parentId: string): Promise<string[]> {
    const conn = this.requireConnection();
    const [rowsUnknown] = await conn.execute(
      `SELECT child_id FROM child_rels WHERE parent_id = ?`,
      [parentId],
    );
    return (rowsUnknown as ChildRow[]).map((r) => r.child_id);
  }

  // ── Detector 1: Missing Quality Gates ──

  async detectMissingQualityGates(sessionId: string): Promise<AuditFinding[]> {
    const conn = this.requireConnection();
    const findings: AuditFinding[] = [];

    for (const gate of this.auditConfig.requiredQualityGates) {
      // Parse "gate_pass:typecheck" → punch_type="gate_pass", punch_key pattern
      // Also accepts "gate_fail:typecheck" for checking presence of either outcome.
      const colonIdx = gate.indexOf(":");
      const punchType = colonIdx > 0 ? gate.substring(0, colonIdx) : gate;
      const punchKeyPattern = colonIdx > 0 ? `${gate.substring(colonIdx + 1)}%` : "%";

      // Check for both gate_pass and gate_fail with the same key pattern,
      // since either outcome means the quality gate was executed.
      const [rowsUnknown] = await conn.execute(
        `SELECT COUNT(*) AS count
         FROM punches
         WHERE task_id = ?
           AND punch_type IN ('gate_pass', 'gate_fail')
           AND punch_key LIKE ?`,
        [sessionId, punchKeyPattern],
      );

      const rows = rowsUnknown as Array<{ count: string | number }>;
      const count = toNumber(rows[0]?.count);

      if (count === 0) {
        findings.push({
          type: "missing_quality_gate",
          severity: "critical",
          message: `Missing quality gate punch: ${gate}`,
          evidence: { gate, punchType, punchKeyPattern, count: 0 },
        });
      }
    }

    return findings;
  }

  // ── Detector 2: Cost Anomalies ──

  async detectCostAnomalies(
    sessionId: string,
    metrics?: { totalCost: number; stepCount: number; tokensInput: number; tokensOutput: number },
  ): Promise<AuditFinding[]> {
    const findings: AuditFinding[] = [];
    const m = metrics ?? await this.getSessionMetrics(sessionId);

    const totalTokens = m.tokensInput + m.tokensOutput;
    const costPer100k = totalTokens > 0 ? (m.totalCost / totalTokens) * 100_000 : 0;

    // Check absolute cost threshold
    if (m.totalCost > this.auditConfig.costAnomalyThresholdUsd) {
      findings.push({
        type: "cost_anomaly",
        severity: "critical",
        message: `Session cost $${m.totalCost.toFixed(2)} exceeds anomaly threshold $${this.auditConfig.costAnomalyThresholdUsd.toFixed(2)}`,
        evidence: {
          totalCost: m.totalCost,
          threshold: this.auditConfig.costAnomalyThresholdUsd,
          costPer100kTokens: costPer100k,
          totalTokens,
        },
      });
    } else if (costPer100k > this.auditConfig.cheapZonePercentileUsd && totalTokens >= 50_000) {
      // Only flag cheap-zone deviation if we have meaningful token volume
      findings.push({
        type: "cost_anomaly",
        severity: "warning",
        message: `Cost per 100k tokens ($${costPer100k.toFixed(2)}) exceeds cheap zone target ($${this.auditConfig.cheapZonePercentileUsd.toFixed(2)})`,
        evidence: {
          totalCost: m.totalCost,
          costPer100kTokens: costPer100k,
          cheapZoneTarget: this.auditConfig.cheapZonePercentileUsd,
          totalTokens,
        },
      });
    }

    return findings;
  }

  // ── Detector 3: Loop Signatures ──

  async detectLoopSignatures(sessionId: string): Promise<AuditFinding[]> {
    const conn = this.requireConnection();
    const findings: AuditFinding[] = [];

    // Get ordered punch sequence for tool calls
    const [rowsUnknown] = await conn.execute(
      `SELECT punch_type, punch_key, observed_at, cost
       FROM punches
       WHERE task_id = ?
       ORDER BY observed_at ASC`,
      [sessionId],
    );

    const punches = rowsUnknown as PunchRow[];

    // Check step count anomaly
    const stepCount = punches.filter(
      (p) => p.punch_type === "step_complete" && p.punch_key === "step_finished",
    ).length;

    if (stepCount > this.auditConfig.maxExpectedSteps) {
      findings.push({
        type: "loop_signature",
        severity: "critical",
        message: `Step count ${stepCount} exceeds maximum expected ${this.auditConfig.maxExpectedSteps}`,
        evidence: {
          stepCount,
          maxExpected: this.auditConfig.maxExpectedSteps,
        },
      });
    }

    // Check for repeated tool patterns
    const toolSequence = punches
      .filter((p) => p.punch_type === "tool_call")
      .map((p) => p.punch_key);

    if (toolSequence.length >= this.auditConfig.loopMinPatternLength * this.auditConfig.loopMinRepetitions) {
      const detectedPattern = this.findRepeatingPattern(
        toolSequence,
        this.auditConfig.loopMinPatternLength,
        this.auditConfig.loopMaxPatternLength,
        this.auditConfig.loopMinRepetitions,
      );

      if (detectedPattern) {
        findings.push({
          type: "loop_signature",
          severity: "warning",
          message: `Repeating tool pattern detected: [${detectedPattern.pattern.join(", ")}] repeated ${detectedPattern.repetitions} times`,
          evidence: {
            pattern: detectedPattern.pattern,
            repetitions: detectedPattern.repetitions,
            patternLength: detectedPattern.pattern.length,
            totalToolCalls: toolSequence.length,
          },
        });
      }
    }

    return findings;
  }

  /**
   * Find a repeating pattern in a sequence of tool names.
   * Checks pattern lengths from min to max, looking for at least minReps consecutive repetitions.
   */
  private findRepeatingPattern(
    sequence: string[],
    minLen: number,
    maxLen: number,
    minReps: number,
  ): { pattern: string[]; repetitions: number } | null {
    for (let patLen = minLen; patLen <= maxLen; patLen++) {
      // Slide a window across the sequence
      for (let start = 0; start <= sequence.length - patLen * minReps; start++) {
        const pattern = sequence.slice(start, start + patLen);
        let reps = 1;

        for (let offset = start + patLen; offset + patLen <= sequence.length; offset += patLen) {
          const candidate = sequence.slice(offset, offset + patLen);
          if (candidate.every((v, i) => v === pattern[i])) {
            reps++;
          } else {
            break;
          }
        }

        if (reps >= minReps) {
          return { pattern, repetitions: reps };
        }
      }
    }
    return null;
  }

  // ── Detector 4: Tool Adherence Deviation ──

  async detectToolAdherenceDeviation(sessionId: string): Promise<AuditFinding[]> {
    const conn = this.requireConnection();
    const findings: AuditFinding[] = [];

    const [rowsUnknown] = await conn.execute(
      `SELECT COUNT(*) AS count
       FROM punches
       WHERE task_id = ?
         AND punch_type = 'tool_call'
         AND punch_key IN ('write_to_file', 'edit_file', 'apply_diff')`,
      [sessionId],
    );

    const rows = rowsUnknown as Array<{ count: string | number }>;
    const editCount = toNumber(rows[0]?.count);
    const [minEdits, maxEdits] = this.auditConfig.expectedEditRange;

    if (editCount < minEdits) {
      findings.push({
        type: "tool_adherence_deviation",
        severity: "warning",
        message: `Edit count ${editCount} below expected minimum ${minEdits}`,
        evidence: {
          editCount,
          expectedRange: this.auditConfig.expectedEditRange,
          deviation: "below_minimum",
        },
      });
    } else if (editCount > maxEdits) {
      findings.push({
        type: "tool_adherence_deviation",
        severity: "warning",
        message: `Edit count ${editCount} exceeds expected maximum ${maxEdits}`,
        evidence: {
          editCount,
          expectedRange: this.auditConfig.expectedEditRange,
          deviation: "above_maximum",
        },
      });
    }

    return findings;
  }

  // ── Detector 5: Incomplete Subtask Tree ──

  async detectIncompleteSubtaskTree(sessionId: string): Promise<AuditFinding[]> {
    const conn = this.requireConnection();
    const findings: AuditFinding[] = [];

    // Get all children of this session
    const childIds = await this.getChildIds(sessionId);
    if (childIds.length === 0) {
      return findings; // No children to verify
    }

    for (const childId of childIds) {
      // Check if each child has any punches at all
      const [rowsUnknown] = await conn.execute(
        `SELECT
           COUNT(*) AS punch_count,
           SUM(CASE WHEN punch_type IN ('gate_pass', 'gate_fail') THEN 1 ELSE 0 END) AS has_quality_gate
         FROM punches
         WHERE task_id = ?`,
        [childId],
      );

      const rows = rowsUnknown as ChildStatusRow[];
      const punchCount = toNumber(rows[0]?.punch_count);
      const hasQualityGate = toNumber(rows[0]?.has_quality_gate);

      if (punchCount === 0) {
        findings.push({
          type: "incomplete_subtask_tree",
          severity: "critical",
          message: `Child task ${childId} has no punches recorded — may not have executed`,
          evidence: {
            parentId: sessionId,
            childId,
            punchCount: 0,
          },
        });
      } else if (hasQualityGate === 0) {
        findings.push({
          type: "incomplete_subtask_tree",
          severity: "warning",
          message: `Child task ${childId} has ${punchCount} punches but no quality gate records`,
          evidence: {
            parentId: sessionId,
            childId,
            punchCount,
            hasQualityGate: false,
          },
        });
      }
    }

    return findings;
  }

  // ── Detector 6: Stall Detection ──

  async detectStalls(sessionId: string): Promise<AuditFinding[]> {
    const conn = this.requireConnection();
    const findings: AuditFinding[] = [];

    const [rowsUnknown] = await conn.execute(
      `SELECT punch_type, punch_key, observed_at, cost
       FROM punches
       WHERE task_id = ?
       ORDER BY observed_at ASC`,
      [sessionId],
    );

    const punches = rowsUnknown as PunchRow[];

    if (punches.length < 2) {
      return findings; // Not enough data for gap analysis
    }

    const maxGapMs = this.auditConfig.maxPunchGapSeconds * 1000;
    let maxObservedGapMs = 0;
    let maxGapStart: Date | null = null;
    let maxGapEnd: Date | null = null;
    let stallCount = 0;

    for (let i = 1; i < punches.length; i++) {
      const prevTime = new Date(punches[i - 1].observed_at).getTime();
      const currTime = new Date(punches[i].observed_at).getTime();
      const gapMs = currTime - prevTime;

      if (gapMs > maxGapMs) {
        stallCount++;
        if (gapMs > maxObservedGapMs) {
          maxObservedGapMs = gapMs;
          maxGapStart = new Date(prevTime);
          maxGapEnd = new Date(currTime);
        }
      }
    }

    if (stallCount > 0) {
      const severity: AuditSeverity = maxObservedGapMs > maxGapMs * 3 ? "critical" : "warning";
      findings.push({
        type: "stall_detected",
        severity,
        message: `Detected ${stallCount} stall(s); longest gap: ${Math.round(maxObservedGapMs / 1000)}s (threshold: ${this.auditConfig.maxPunchGapSeconds}s)`,
        evidence: {
          stallCount,
          maxGapMs: maxObservedGapMs,
          maxGapSeconds: Math.round(maxObservedGapMs / 1000),
          thresholdSeconds: this.auditConfig.maxPunchGapSeconds,
          maxGapStart: maxGapStart?.toISOString() ?? null,
          maxGapEnd: maxGapEnd?.toISOString() ?? null,
          totalPunches: punches.length,
        },
      });
    }

    return findings;
  }
}
