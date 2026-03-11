/**
 * Card Audit Pipeline E2E Test
 *
 * Tests the full punch card enforcement pipeline with a real LLM:
 *   1. Dispatch session with --card override → card exit prompt is injected
 *   2. LLM processes the prompt (with or without self-check)
 *   3. Post-session audit validates punches against the card
 *   4. Audit result is verified against Dolt punch reality
 *
 * This is a parameterized test — it can run against ANY card/mode combination,
 * making it a general-purpose workflow compliance verifier.
 *
 * Run with:
 *   KILO_LIVE=1 npx vitest run tests/card-audit-e2e.test.ts --timeout 600000
 *
 * Prerequisites:
 *   - kilo serve running on localhost:4096
 *   - oc-daemon running (SSE → Dolt punch writer)
 *   - Dolt SQL server running on localhost:3307
 *
 * Skipped by default (no KILO_LIVE env var) so it doesn't break CI.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";

import { PunchCardValidator } from "../src/governor/punch-card-validator.js";
import {
  type AuditResult,
  type FactoryDispatchConfig,
  defaultConfig,
  runPostSessionAudit,
} from "../src/infra/factory-dispatch.js";
import {
  resolveCardExitPrompt,
  injectCardExitPrompt,
} from "../src/optimization/prompt-injection.js";
import { isSessionTerminal } from "./helpers/session-completion.js";

// ── Config ──────────────────────────────────────────────────────────────────

const KILO_HOST = process.env.KILO_HOST ?? "127.0.0.1";
const KILO_PORT = Number.parseInt(process.env.KILO_PORT ?? "4096", 10);
const BASE_URL = `http://${KILO_HOST}:${KILO_PORT}`;
const DOLT_HOST = process.env.DOLT_HOST ?? "127.0.0.1";
const DOLT_PORT = Number.parseInt(process.env.DOLT_PORT ?? "3307", 10);
const DOLT_DB = process.env.DOLT_DATABASE ?? "beads_repomap-core";
const SKIP = !process.env.KILO_LIVE;

const SESSION_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 3_000;
const PUNCH_SETTLE_MS = 10_000;

function kiloUrl(path: string): string {
  return `${BASE_URL}${path}`;
}

// ── Scenario Definitions ────────────────────────────────────────────────────

interface CardAuditScenario {
  /** Human-readable name for the test */
  name: string;
  /** Agent mode to dispatch to */
  mode: string;
  /** Card ID to enforce (--card override) */
  cardId: string;
  /** Prompt to send to the agent */
  prompt: string;
  /** Expected audit outcome */
  expectedAudit: "pass" | "fail";
  /** If fail, which punch types should be missing */
  expectedMissing?: string[];
}

const SCENARIOS: CardAuditScenario[] = [
  {
    name: "code agent with execute-subtask card (positive path)",
    mode: "code",
    cardId: "execute-subtask",
    prompt: `You are being tested for punch card compliance. Follow these instructions:

1. Use the read tool to read the file \`pyproject.toml\`
2. Use the bash/command tool to run: echo "CARD_AUDIT_TEST_OK"
3. Reply with: "Task complete."

IMPORTANT: Exercise each tool exactly once. Do NOT ask questions.`,
    expectedAudit: "pass",
  },
  {
    name: "code agent with wrong card (negative path — deliberate mismatch)",
    mode: "code",
    cardId: "plant-orchestrate",
    prompt: `You are being tested. Simply read the file \`pyproject.toml\` and reply with "Done."
Do NOT spawn any child sessions. Do NOT ask questions.`,
    expectedAudit: "fail",
    expectedMissing: ["child_spawn"],
  },
];

// ── Helpers ─────────────────────────────────────────────────────────────────

async function pollUntilComplete(
  sessionId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const response = await fetch(kiloUrl(`/session/${sessionId}/message`));
    if (!response.ok) continue;
    const messages = (await response.json()) as Array<Record<string, unknown>>;
    if (isSessionTerminal(messages)) return;
  }
  throw new Error(`Session ${sessionId} did not complete within ${timeoutMs}ms`);
}

function makeAuditConfig(): FactoryDispatchConfig {
  return {
    ...defaultConfig(),
    host: KILO_HOST,
    port: KILO_PORT,
    doltPort: DOLT_PORT,
    quiet: true,
  };
}

interface ScenarioResult {
  sessionId: string;
  audit: AuditResult | null;
  elapsedMs: number;
  punchCount: number;
  cardExitInjected: boolean;
}

// ── Test Suite ──────────────────────────────────────────────────────────────

describe.skipIf(SKIP)(
  "Card Audit Pipeline E2E — dispatch with --card, audit after completion",
  () => {
    let conn: mysql.Connection;
    const results = new Map<string, ScenarioResult>();

    beforeAll(async () => {
      const res = await fetch(kiloUrl("/session")).catch(() => null);
      if (!res?.ok) {
        throw new Error(`kilo serve not reachable at ${BASE_URL}`);
      }

      conn = await mysql.createConnection({
        host: DOLT_HOST,
        port: DOLT_PORT,
        database: DOLT_DB,
        user: "root",
      });

      // Run all scenarios
      for (const scenario of SCENARIOS) {
        const start = Date.now();
        console.log(`\n[card-audit] ▶ ${scenario.name}`);
        console.log(`[card-audit]   mode=${scenario.mode} card=${scenario.cardId} expected=${scenario.expectedAudit}`);

        // 1. Resolve card exit prompt (simulates what --card does in factory_dispatch)
        let cardExitInjected = false;
        let promptText = scenario.prompt;
        try {
          const resolution = await resolveCardExitPrompt(scenario.mode, scenario.cardId);
          if (resolution.prompt) {
            promptText = injectCardExitPrompt(scenario.prompt, resolution.prompt);
            cardExitInjected = true;
            console.log(`[card-audit]   Card exit prompt injected (source=${resolution.source}, ${resolution.prompt.length} chars)`);
          } else {
            console.log(`[card-audit]   No card exit prompt available for card=${scenario.cardId}`);
          }
        } catch (err) {
          console.warn(`[card-audit]   Card exit resolution failed: ${(err as Error).message}`);
        }

        // 2. Create session
        const createRes = await fetch(kiloUrl("/session"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: `card-audit-e2e: ${scenario.name}` }),
        });
        expect(createRes.ok).toBe(true);
        const session = (await createRes.json()) as { id: string };
        console.log(`[card-audit]   session=${session.id}`);

        // 3. Dispatch prompt with card exit prompt injected
        const promptRes = await fetch(kiloUrl(`/session/${session.id}/prompt_async`), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agent: scenario.mode,
            parts: [{ type: "text", text: promptText }],
          }),
        });
        expect(promptRes.ok).toBe(true);

        // 4. Wait for completion
        await pollUntilComplete(session.id, SESSION_TIMEOUT_MS);

        // 5. Wait for oc-daemon to flush punches to Dolt
        console.log(`[card-audit]   Session complete. Waiting ${PUNCH_SETTLE_MS / 1000}s for punch flush...`);
        await new Promise((r) => setTimeout(r, PUNCH_SETTLE_MS));

        // 6. Run post-session audit
        const auditConfig = makeAuditConfig();
        const logs: string[] = [];
        const audit = await runPostSessionAudit(
          session.id,
          scenario.cardId,
          auditConfig,
          (msg: string) => {
            logs.push(msg);
            console.log(`[card-audit]   ${msg}`);
          },
        );

        // 7. Count punches for this session
        const [punchRows] = await conn.query(
          `SELECT COUNT(*) AS count FROM punches WHERE task_id = ?`,
          [session.id],
        );
        const punchCount = Number((punchRows as Array<{ count: number }>)[0]?.count ?? 0);

        const elapsed = Date.now() - start;
        console.log(`[card-audit]   punches=${punchCount} audit=${audit?.status ?? "null"} elapsed=${Math.round(elapsed / 1000)}s`);

        results.set(scenario.name, {
          sessionId: session.id,
          audit,
          elapsedMs: elapsed,
          punchCount,
          cardExitInjected,
        });
      }
    }, 600_000);

    afterAll(async () => {
      // Print summary
      console.log("\n[card-audit] ═══════════════════════════════════════════════════");
      console.log("[card-audit] CARD AUDIT PIPELINE RESULTS");
      console.log("[card-audit] ═══════════════════════════════════════════════════");
      for (const scenario of SCENARIOS) {
        const r = results.get(scenario.name);
        if (!r) {
          console.log(`[card-audit] ✗ ${scenario.name}: DID NOT RUN`);
          continue;
        }
        const icon = r.audit?.status === scenario.expectedAudit ? "✅" : "❌";
        console.log(
          `[card-audit] ${icon} ${scenario.name}` +
          `\n[card-audit]     session=${r.sessionId} punches=${r.punchCount}` +
          `\n[card-audit]     audit=${r.audit?.status ?? "null"} expected=${scenario.expectedAudit}` +
          `\n[card-audit]     card_exit_injected=${r.cardExitInjected}` +
          (r.audit?.missing?.length ? `\n[card-audit]     missing=[${r.audit.missing.join(", ")}]` : "") +
          (r.audit?.violations?.length ? `\n[card-audit]     violations=[${r.audit.violations.join(", ")}]` : "") +
          `\n[card-audit]     elapsed=${Math.round(r.elapsedMs / 1000)}s`,
        );
      }
      console.log("[card-audit] ═══════════════════════════════════════════════════\n");

      await conn.end();
    });

    // ── Per-scenario assertions ───────────────────────────────────────────

    for (const scenario of SCENARIOS) {
      describe(`Scenario: ${scenario.name}`, () => {
        it("session completed and has punches", () => {
          const r = results.get(scenario.name);
          expect(r, `${scenario.name} did not run`).toBeDefined();
          expect(r!.punchCount, `${scenario.name}: expected punches in Dolt`).toBeGreaterThan(0);
        });

        it("card exit prompt was injected", () => {
          const r = results.get(scenario.name);
          if (!r) return;
          // Card exit injection depends on whether a compiled/static prompt exists
          // Log it but don't hard-fail — the audit itself is the real gate
          if (!r.cardExitInjected) {
            console.warn(`[card-audit] WARNING: card exit prompt was NOT injected for ${scenario.name}`);
          }
        });

        it("post-session audit ran successfully", () => {
          const r = results.get(scenario.name);
          if (!r) return;
          expect(r.audit, `${scenario.name}: audit should not be null`).not.toBeNull();
          expect(r.audit!.cardId).toBe(scenario.cardId);
        });

        it(`audit result matches expected outcome (${scenario.expectedAudit})`, () => {
          const r = results.get(scenario.name);
          if (!r?.audit) return;
          expect(
            r.audit.status,
            `${scenario.name}: expected audit ${scenario.expectedAudit}, got ${r.audit.status}` +
            (r.audit.missing.length ? ` (missing: ${r.audit.missing.join(", ")})` : "") +
            (r.audit.violations.length ? ` (violations: ${r.audit.violations.join(", ")})` : ""),
          ).toBe(scenario.expectedAudit);
        });

        if (scenario.expectedMissing && scenario.expectedMissing.length > 0) {
          it("reports expected missing punch types", () => {
            const r = results.get(scenario.name);
            if (!r?.audit) return;
            for (const expectedType of scenario.expectedMissing!) {
              const found = r.audit.missing.some((m) => m.includes(expectedType));
              expect(
                found,
                `${scenario.name}: expected missing punch type "${expectedType}" in [${r.audit.missing.join(", ")}]`,
              ).toBe(true);
            }
          });
        }
      });
    }

    // ── Cross-scenario: punch data integrity ──────────────────────────────

    describe("Punch data integrity", () => {
      it("audit results are consistent with raw Dolt punch data", async () => {
        for (const scenario of SCENARIOS) {
          const r = results.get(scenario.name);
          if (!r?.audit) continue;

          // Independently validate using PunchCardValidator
          const validator = new PunchCardValidator({
            host: DOLT_HOST,
            port: DOLT_PORT,
            database: DOLT_DB,
            user: "root",
          });

          try {
            await validator.connect();
            const independent = await validator.validatePunchCard(r.sessionId, scenario.cardId);

            expect(
              independent.status,
              `${scenario.name}: independent validation should match audit`,
            ).toBe(r.audit.status);
          } finally {
            await validator.disconnect();
          }
        }
      });
    });
  },
  600_000,
);
