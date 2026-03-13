/**
 * Punch Card Audit — Post-session compliance validation.
 *
 * Extracted from factory-dispatch.ts (ovm.7) to isolate the punch card
 * audit concern. This is the "governor without kill" — post-hoc enforcement
 * that creates the training signal DSPy needs to learn from workflow deviations.
 *
 * See: repomap-core-ovm.7
 */

import { PunchCardValidator } from "../governor/punch-card-validator.js";
import type { Logger } from "./kilo-client.js";
import { timestamp } from "./utils.js";

// ── Types ────────────────────────────────────────────────────────────────

/** Post-session audit result. */
export interface AuditResult {
  cardId: string;
  status: "pass" | "fail";
  missing: string[];
  violations: string[];
}

/** Minimal config subset needed by runPostSessionAudit. */
export interface AuditConfig {
  host: string;
  doltPort: number;
}

// ── Audit ────────────────────────────────────────────────────────────────

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
  config: AuditConfig,
  log: Logger,
): Promise<AuditResult | null> {
  const validator = new PunchCardValidator({
    host: config.host || "127.0.0.1",
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
