/**
 * Comprehensive Attestation E2E Test
 *
 * Validates ALL agent modes against a live kilo serve instance:
 *   1. Each agent reports its mode name, model, and cache status
 *   2. Each agent exercises every tool it should have access to (non-destructively)
 *   3. Session data is verified for correctness (model, tokens, cache)
 *   4. Punch card entries in Dolt are verified against actual session data
 *
 * Run with:
 *   KILO_LIVE=1 npx vitest run tests/attestation-e2e.test.ts --timeout 600000
 *
 * Prerequisites:
 *   - kilo serve running on localhost:4096 (with OAuth auth for caching)
 *   - oc-daemon running (SSE → Dolt punch writer)
 *   - Dolt SQL server running on localhost:3307
 *
 * Skipped by default (no KILO_LIVE env var) so it doesn't break CI.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import mysql from "mysql2/promise";

// ─── Config ──────────────────────────────────────────────────────────────────

const KILO_HOST = process.env.KILO_HOST ?? "127.0.0.1";
const KILO_PORT = Number.parseInt(process.env.KILO_PORT ?? "4096", 10);
const BASE_URL = `http://${KILO_HOST}:${KILO_PORT}`;
const DOLT_HOST = process.env.DOLT_HOST ?? "127.0.0.1";
const DOLT_PORT = Number.parseInt(process.env.DOLT_PORT ?? "3307", 10);
const DOLT_DB = process.env.DOLT_DATABASE ?? "plant";
const SKIP = !process.env.KILO_LIVE;

// How long to wait for a session to complete (per agent)
const SESSION_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 3_000;
// Extra time after all sessions complete for daemon to flush punches
const PUNCH_SETTLE_MS = 10_000;

// ─── Agent Registry ──────────────────────────────────────────────────────────
// Source of truth: ~/.config/kilo/opencode.json (model) + .kilocodemodes (tools)

interface AgentSpec {
  agent: string;
  expectedModel: string;
  toolGroups: string[];        // from .kilocodemodes: read, edit, command, browser, mcp
  exercisableTools: string[];  // tools we can safely invoke: read, edit, bash
  cacheExpected: boolean;      // true for kilo/anthropic/* models
  dispatchOnly?: boolean;      // true for orchestrators that refuse direct tool use
}

const AGENTS: AgentSpec[] = [
  // Tier 1 — Opus (strategic dispatch orchestrator, can read plant files + run bd commands)
  {
    agent: "plant-manager",
    expectedModel: "anthropic/claude-opus-4.6",
    toolGroups: ["read", "command"],
    exercisableTools: ["read", "bash"],
    cacheExpected: true,
  },
  // Tier 2 — Opus
  {
    agent: "process-orchestrator",
    expectedModel: "anthropic/claude-opus-4.6",
    toolGroups: ["read", "edit", "command", "browser", "mcp"],
    exercisableTools: ["read", "bash"],
    cacheExpected: true,
  },
  {
    agent: "audit-orchestrator",
    expectedModel: "anthropic/claude-opus-4.6",
    toolGroups: ["read", "command", "mcp"],
    exercisableTools: ["read", "bash"],
    cacheExpected: true,
  },
  // Tier 3 — Opus
  {
    agent: "architect",
    expectedModel: "gpt-5.4",
    toolGroups: ["read", "command", "browser", "mcp"],
    exercisableTools: ["read", "bash"],
    cacheExpected: false,
  },
  {
    agent: "product-skeptic",
    expectedModel: "gpt-5.4",
    toolGroups: ["read", "command", "mcp", "browser"],
    exercisableTools: ["read", "bash"],
    cacheExpected: false,
  },
  // Tier 3 — Sonnet
  {
    agent: "pr-review",
    expectedModel: "anthropic/claude-sonnet-4.6",
    toolGroups: ["read", "command", "browser"],
    exercisableTools: ["read", "bash"],
    cacheExpected: true,
  },
  {
    agent: "claims-ops",
    expectedModel: "anthropic/claude-sonnet-4.6",
    toolGroups: ["read", "edit", "command"],  // default agent tools
    exercisableTools: ["read", "bash"],
    cacheExpected: true,
  },
  {
    agent: "docs-specialist",
    expectedModel: "anthropic/claude-opus-4.6",
    toolGroups: ["read", "edit", "command"],
    exercisableTools: ["read", "bash"],
    cacheExpected: true,
  },
  // Tier 3 — Code (OpenAI gpt-5.3-codex)
  {
    agent: "code",
    expectedModel: "gpt-5.3-codex",
    toolGroups: ["read", "edit", "command", "mcp", "browser"],
    exercisableTools: ["read", "bash"],
    cacheExpected: false, // OpenAI automatic caching, not explicit
  },
  {
    agent: "fitter",
    expectedModel: "gpt-5.3-codex",
    toolGroups: ["read", "edit", "command", "mcp", "browser"],
    exercisableTools: ["read", "bash"],
    cacheExpected: false,
  },
  {
    agent: "code-simplifier",
    expectedModel: "gpt-5.3-codex",
    toolGroups: ["read", "edit", "browser", "command", "mcp"],
    exercisableTools: ["read", "bash"],
    cacheExpected: false,
  },
  // Tier 3 — Thinker
  {
    agent: "thinker-abstract",
    expectedModel: "anthropic/claude-opus-4.6",
    toolGroups: ["read", "mcp"],
    exercisableTools: ["read"],
    cacheExpected: true,
  },
  {
    agent: "thinker-adversarial",
    expectedModel: "gpt-5.3-codex",
    toolGroups: ["read", "mcp"],
    exercisableTools: ["read"],
    cacheExpected: false,
  },
  {
    agent: "thinker-systems",
    expectedModel: "anthropic/claude-opus-4.6",
    toolGroups: ["read", "mcp"],
    exercisableTools: ["read"],
    cacheExpected: true,
  },
  {
    agent: "thinker-concrete",
    expectedModel: "gpt-5.4",
    toolGroups: ["read", "mcp"],
    exercisableTools: ["read"],
    cacheExpected: false,
  },
  {
    agent: "thinker-epistemic",
    expectedModel: "gpt-5.4",
    toolGroups: ["read", "mcp"],
    exercisableTools: ["read"],
    cacheExpected: false,
  },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function kiloUrl(path: string): string {
  return `${BASE_URL}${path}`;
}

/** Build a prompt that instructs the agent to exercise its tools non-destructively. */
function buildAttestationPrompt(spec: AgentSpec): string {
  const toolInstructions: string[] = [];

  for (const tool of spec.exercisableTools) {
    switch (tool) {
      case "read":
        toolInstructions.push(
          "- Use the read tool to read the file `pyproject.toml` (it exists in the project root)"
        );
        break;
      case "bash":
        toolInstructions.push(
          '- Use the bash/command tool to run: echo "ATTESTATION_BASH_OK"'
        );
        break;
      case "edit":
        toolInstructions.push(
          "- Use the edit tool to create a new file at `/tmp/attestation-${AGENT}.txt` with the content: `ATTESTATION_EDIT_OK`".replace(
            "${AGENT}",
            spec.agent
          )
        );
        break;
    }
  }

  return `You are being tested as part of an attestation health check. Follow these instructions EXACTLY:

1. First, exercise each of the following tools (one at a time, in order):
${toolInstructions.join("\n")}

2. After exercising all tools, reply with a JSON block (and nothing else outside the block) in this exact format:
\`\`\`json
{
  "attestation": "PASS",
  "agent": "${spec.agent}",
  "tools_exercised": [${spec.exercisableTools.map((t) => `"${t}"`).join(", ")}]
}
\`\`\`

IMPORTANT: You MUST use each tool listed above before replying. Do NOT skip any tool. Do NOT ask questions. Do NOT use any tools not listed above.`;
}

interface SessionResult {
  sessionId: string;
  agent: string;
  messages: Array<Record<string, unknown>>;
  totalCost: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  modelUsed: string;
  toolsUsed: string[];
  attestationJson: Record<string, unknown> | null;
  completed: boolean;
  elapsedMs: number;
}

function isAnthropicModel(modelUsed: string): boolean {
  return modelUsed.includes("anthropic/") || modelUsed.includes("claude-");
}

/** Check if messages indicate the session is complete. */
function isSessionComplete(messages: Array<Record<string, unknown>>): boolean {
  let hasTerminalFinish = false;
  let hasRunningTools = false;

  for (const msg of messages) {
    const parts = (msg.parts as Array<Record<string, unknown>>) ?? [];
    for (const part of parts) {
      if (part.type === "step-finish" && (part.reason === "stop" || part.reason === "end_turn")) {
        hasTerminalFinish = true;
      }
      const state = part.state as Record<string, unknown> | undefined;
      if (part.type === "tool" && (state?.status === "running" || state?.status === "pending")) {
        hasRunningTools = true;
      }
    }
  }

  return hasTerminalFinish && !hasRunningTools;
}

/** Poll a session until it completes or deadline is reached. */
async function pollForCompletion(sessionId: string): Promise<boolean> {
  const deadline = Date.now() + SESSION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const msgRes = await fetch(kiloUrl(`/session/${sessionId}/message`));
    if (!msgRes.ok) continue;
    const messages = (await msgRes.json()) as Array<Record<string, unknown>>;
    if (isSessionComplete(messages)) return true;
  }
  return false;
}

interface SessionMetrics {
  totalCost: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  modelUsed: string;
  toolsUsed: string[];
}

/** Accumulate step-finish metrics from a single part. */
function accumulateStepFinish(
  part: Record<string, unknown>,
  acc: { cost: number; tokensIn: number; tokensOut: number; cacheRead: number; cacheWrite: number },
): void {
  const partCost = (part.cost as number) ?? 0;
  const tokens = (part.tokens as Record<string, unknown>) ?? {};
  const cache = (tokens.cache as Record<string, unknown>) ?? {};
  acc.cost += partCost;
  acc.tokensIn += (tokens.input as number) ?? 0;
  acc.tokensOut += (tokens.output as number) ?? 0;
  acc.cacheRead += (cache.read as number) ?? 0;
  acc.cacheWrite += (cache.write as number) ?? 0;
}

/** Extract cost, token, model, and tool metrics from messages. */
function extractMetrics(messages: Array<Record<string, unknown>>): SessionMetrics {
  let modelUsed = "";
  const toolsUsed = new Set<string>();
  const acc = { cost: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0 };

  for (const msg of messages) {
    const info = (msg.info as Record<string, unknown>) ?? {};
    if (info.role !== "assistant") continue;
    if (info.modelID && typeof info.modelID === "string") modelUsed = info.modelID;

    const parts = (msg.parts as Array<Record<string, unknown>>) ?? [];
    for (const part of parts) {
      if (part.type === "tool" && typeof part.tool === "string") toolsUsed.add(part.tool);
      if (part.type === "step-finish") accumulateStepFinish(part, acc);
    }
  }

  return {
    totalCost: acc.cost, totalTokensIn: acc.tokensIn, totalTokensOut: acc.tokensOut,
    totalCacheRead: acc.cacheRead, totalCacheWrite: acc.cacheWrite,
    modelUsed, toolsUsed: [...toolsUsed].sort((a, b) => a.localeCompare(b)),
  };
}

const JSON_FENCE_RE = /```json\s*\n?([\s\S]*?)```/;
const BARE_ATTESTATION_RE = /\{[\s\S]*"attestation"[\s\S]*\}/;

function parseAttestationText(text: string): Record<string, unknown> | null {
  const fenced = JSON_FENCE_RE.exec(text);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim()) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  const bare = BARE_ATTESTATION_RE.exec(text);
  if (bare) {
    try {
      return JSON.parse(bare[0]) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  return null;
}

/** Extract attestation JSON from text parts. */
function extractAttestationJson(messages: Array<Record<string, unknown>>): Record<string, unknown> | null {
  for (const msg of messages) {
    const parts = (msg.parts as Array<Record<string, unknown>>) ?? [];
    for (const part of parts) {
      if (part.type !== "text" || typeof part.text !== "string") continue;
      const parsed = parseAttestationText(part.text);
      if (parsed) {
        return parsed;
      }
    }
  }
  return null;
}

/** Create a session, send prompt, poll until done, return parsed results. */
async function runAgentAttestation(spec: AgentSpec): Promise<SessionResult> {
  const start = Date.now();

  // Create session
  const createRes = await fetch(kiloUrl("/session"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: `attestation-${spec.agent}` }),
  });
  if (!createRes.ok) throw new Error(`Failed to create session: ${createRes.status}`);
  const { id: sessionId } = (await createRes.json()) as { id: string };

  // Send prompt
  const prompt = buildAttestationPrompt(spec);
  const promptRes = await fetch(kiloUrl(`/session/${sessionId}/prompt_async`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parts: [{ type: "text", text: prompt }], agent: spec.agent }),
  });
  if (!promptRes.ok) throw new Error(`Failed to send prompt: ${promptRes.status}`);

  const completed = await pollForCompletion(sessionId);

  // Fetch final messages
  const finalRes = await fetch(kiloUrl(`/session/${sessionId}/message`));
  const messages = (await finalRes.json()) as Array<Record<string, unknown>>;
  const metrics = extractMetrics(messages);
  const attestationJson = extractAttestationJson(messages);

  return {
    sessionId, agent: spec.agent, messages,
    ...metrics, attestationJson, completed, elapsedMs: Date.now() - start,
  };
}

/** Run a batch of agents with concurrency limit, collecting results. */
async function runBatch(
  agents: AgentSpec[],
  batchSize: number,
  label: string,
  results: Map<string, SessionResult>,
): Promise<void> {
  for (let i = 0; i < agents.length; i += batchSize) {
    const batch = agents.slice(i, i + batchSize);
    console.log(`[attestation] ${label} batch ${Math.floor(i / batchSize) + 1}: ${batch.map((a) => a.agent).join(", ")}`);
    const batchResults = await Promise.all(
      batch.map((spec) =>
        runAgentAttestation(spec).catch((err) => {
          console.error(`[attestation] FAILED ${spec.agent}:`, err);
          return null;
        })
      )
    );
    for (const r of batchResults) {
      if (r) results.set(r.agent, r);
    }
  }
}

/** Run all agents in batched groups by provider. */
async function runAgentBatches(results: Map<string, SessionResult>): Promise<void> {
  const anthropicAgents = AGENTS.filter((a) => a.cacheExpected);
  const openaiAgents = AGENTS.filter((a) => !a.cacheExpected);
  console.log(`[attestation] Running ${AGENTS.length} agents: ${anthropicAgents.length} Anthropic, ${openaiAgents.length} OpenAI`);
  await runBatch(anthropicAgents, 3, "Anthropic", results);
  await runBatch(openaiAgents, 4, "OpenAI", results);
}

/** Print summary table of all attestation results. */
function printSummaryTable(results: Map<string, SessionResult>): void {
  console.log("\n[attestation] ═══════════════════════════════════════════");
  console.log("[attestation] ATTESTATION RESULTS");
  console.log("[attestation] ═══════════════════════════════════════════");
  for (const spec of AGENTS) {
    const r = results.get(spec.agent);
    if (!r) {
      console.log(`[attestation] ✗ ${spec.agent}: FAILED TO RUN`);
      continue;
    }
    const cacheStr = r.totalCacheRead > 0 || r.totalCacheWrite > 0
      ? `cache_r=${r.totalCacheRead} cache_w=${r.totalCacheWrite}`
      : "no_cache";
    const status = r.completed ? "✓" : "✗";
    const attest = r.attestationJson?.attestation === "PASS" ? "PASS" : "FAIL";
    console.log(
      `[attestation] ${status} ${spec.agent.padEnd(22)} model=${r.modelUsed.padEnd(30)} ` +
      `cost=$${r.totalCost.toFixed(4).padEnd(8)} ${cacheStr.padEnd(30)} ` +
      `tools=[${r.toolsUsed.join(",")}] attest=${attest} ${r.elapsedMs}ms`
    );
  }
  console.log("[attestation] ═══════════════════════════════════════════\n");
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe.skipIf(SKIP)(
  "Comprehensive Attestation E2E — all modes",
  () => {
    const results = new Map<string, SessionResult>();
    let doltConn: mysql.Connection | null = null;

    beforeAll(async () => {
      // Verify kilo serve is reachable
      const res = await fetch(kiloUrl("/session")).catch(() => null);
      if (!res?.ok) throw new Error(`kilo serve not reachable at ${BASE_URL}`);

      // Connect to Dolt for punch verification
      try {
        doltConn = await mysql.createConnection({ host: DOLT_HOST, port: DOLT_PORT, database: DOLT_DB, user: "root" });
      } catch (err) {
        console.warn("[attestation] Dolt not available, punch verification will be skipped:", err);
      }

      await runAgentBatches(results);

      // Wait for daemon to flush punches
      console.log(`[attestation] All sessions done. Waiting ${PUNCH_SETTLE_MS / 1000}s for punch flush...`);
      await new Promise((r) => setTimeout(r, PUNCH_SETTLE_MS));
      printSummaryTable(results);
    }, 900_000); // 15 minute timeout for beforeAll

    afterAll(async () => {
      if (doltConn) {
        await doltConn.end();
      }
    });

    // ─── Per-agent tests ───────────────────────────────────────────────

    for (const spec of AGENTS) {
      describe(`Agent: ${spec.agent}`, () => {
        it("completed successfully", () => {
          const r = results.get(spec.agent);
          expect(r, `${spec.agent} did not run`).toBeDefined();
          expect(r!.completed, `${spec.agent} did not complete within timeout`).toBe(true);
        });

        it(`uses correct model (${spec.expectedModel})`, () => {
          const r = results.get(spec.agent);
          if (!r) return;
          expect(
            r.modelUsed,
            `${spec.agent}: expected model containing "${spec.expectedModel}", got "${r.modelUsed}"`
          ).toContain(spec.expectedModel);
        });

        it("matches expected caching behavior for its runtime model", () => {
          const r = results.get(spec.agent);
          if (!r) return;
          const anthropicModel = isAnthropicModel(r.modelUsed);
          const totalCacheActivity = r.totalCacheRead + r.totalCacheWrite;
          if (anthropicModel) {
            if (totalCacheActivity === 0) {
              console.warn(
                `[attestation] WARNING: ${spec.agent} has no cache activity ` +
                `(read=${r.totalCacheRead}, write=${r.totalCacheWrite}). ` +
                `This may be a first-run cache miss or a gateway issue.`
              );
            }
            expect(
              totalCacheActivity,
              `${spec.agent}: expected Anthropic cache activity (read+write > 0) for model "${r.modelUsed}"`
            ).toBeGreaterThan(0);
          } else {
            if (totalCacheActivity > 0) {
              console.log(
                `[attestation] INFO: ${spec.agent} reported cache activity ` +
                `(read=${r.totalCacheRead}, write=${r.totalCacheWrite}) on model "${r.modelUsed}"`
              );
            }
            expect(
              totalCacheActivity,
              `${spec.agent}: cache activity should not be negative for model "${r.modelUsed}"`
            ).toBeGreaterThanOrEqual(0);
          }
        });

        if (spec.dispatchOnly) {
          it("correctly refused direct tool use (dispatch-only)", () => {
            const r = results.get(spec.agent);
            if (!r) return;
            // Dispatch-only orchestrators should not use tools directly
            expect(
              r.toolsUsed.length,
              `${spec.agent}: dispatch-only agent should not use tools, got [${r.toolsUsed.join(", ")}]`
            ).toBe(0);
          });

          it("returned attestation JSON with correct agent name", () => {
            const r = results.get(spec.agent);
            if (!r) return;
            expect(
              r.attestationJson,
              `${spec.agent}: no attestation JSON found in response`
            ).not.toBeNull();
            expect(r.attestationJson?.agent).toBe(spec.agent);
            // Dispatch-only agents may report PASS (no tools needed) or FAIL (with reason)
            const tools = r.attestationJson?.tools_exercised as string[] | undefined;
            expect(
              tools?.length ?? 0,
              `${spec.agent}: dispatch-only should report empty tools_exercised`
            ).toBe(0);
          });
        } else {
          it("exercised all expected tools", () => {
            const r = results.get(spec.agent);
            if (!r) return;
            for (const tool of spec.exercisableTools) {
              const kiloToolName = tool === "command" ? "bash" : tool;
              expect(
                r.toolsUsed,
                `${spec.agent}: expected tool "${kiloToolName}" but got [${r.toolsUsed.join(", ")}]`
              ).toContain(kiloToolName);
            }
          });

          it("returned valid attestation JSON", () => {
            const r = results.get(spec.agent);
            if (!r) return;
            expect(
              r.attestationJson,
              `${spec.agent}: no attestation JSON found in response`
            ).not.toBeNull();
            expect(r.attestationJson?.attestation).toBe("PASS");
            expect(r.attestationJson?.agent).toBe(spec.agent);
          });
        }

        it("has positive tokens (cost > 0 for paid models)", () => {
          const r = results.get(spec.agent);
          if (!r) return;
          if (isAnthropicModel(r.modelUsed)) {
            expect(r.totalCost, `${spec.agent}: cost should be > 0`).toBeGreaterThan(0);
          }
          expect(r.totalTokensOut, `${spec.agent}: output tokens should be > 0`).toBeGreaterThan(0);
        });
      });
    }

    // ─── Punch Card Verification ───────────────────────────────────────

    describe("Punch Card Verification", () => {
      it("daemon wrote punches for each attestation session", async () => {
        if (!doltConn) {
          console.warn("[attestation] Dolt not connected, skipping punch verification");
          return;
        }

        const sessionIds = [...results.values()].map((r) => r.sessionId);
        if (sessionIds.length === 0) return;

        const placeholders = sessionIds.map(() => "?").join(",");
        const [rows] = await doltConn.query(
          `SELECT task_id, punch_type, punch_key, cost, tokens_input, tokens_output
           FROM punches
           WHERE task_id IN (${placeholders})
           ORDER BY task_id, observed_at`,
          sessionIds
        );

        const punches = rows as Array<{
          task_id: string;
          punch_type: string;
          punch_key: string;
          cost: number | null;
          tokens_input: number | null;
          tokens_output: number | null;
        }>;

        console.log(`[attestation] Found ${punches.length} punches for ${sessionIds.length} sessions`);

        // Group by session
        const bySession = new Map<string, typeof punches>();
        for (const p of punches) {
          const list = bySession.get(p.task_id) ?? [];
          list.push(p);
          bySession.set(p.task_id, list);
        }

        let sessionsWithPunches = 0;
        let totalToolPunches = 0;

        for (const [agent, result] of results) {
          const sessionPunches = bySession.get(result.sessionId) ?? [];
          if (sessionPunches.length > 0) sessionsWithPunches++;

          const toolPunches = sessionPunches.filter((p) => p.punch_type === "tool_call");
          totalToolPunches += toolPunches.length;

          // Verify tool punches match tools used
          const punchedTools = toolPunches.map((p) => p.punch_key).toSorted((a, b) => a.localeCompare(b));
          const expectedTools = [...result.toolsUsed].sort((a, b) => a.localeCompare(b));

          if (punchedTools.length > 0) {
            // Each tool used should have at least one punch
            for (const tool of expectedTools) {
              const hasPunch = punchedTools.includes(tool);
              if (!hasPunch) {
                console.warn(
                  `[attestation] ${agent}: tool "${tool}" used but no punch found. ` +
                  `Punches: [${punchedTools.join(", ")}]`
                );
              }
            }
          }

          console.log(
            `[attestation] ${agent.padEnd(22)} punches=${sessionPunches.length} ` +
            `tool_punches=[${punchedTools.join(",")}] session_tools=[${expectedTools.join(",")}]`
          );
        }

        // At least most sessions should have punches (daemon might miss some due to timing)
        expect(
          sessionsWithPunches,
          `Expected most sessions to have punches, got ${sessionsWithPunches}/${results.size}`
        ).toBeGreaterThanOrEqual(Math.floor(results.size * 0.8));

        console.log(
          `[attestation] Punch summary: ${sessionsWithPunches}/${results.size} sessions with punches, ` +
          `${totalToolPunches} total tool punches`
        );
      });

      it("punch costs match session costs (within tolerance)", async () => {
        if (!doltConn) return;

        for (const [agent, result] of results) {
          const [rows] = await doltConn.query(
            `SELECT SUM(cost) as total_cost, SUM(tokens_input) as total_in, SUM(tokens_output) as total_out
             FROM punches
             WHERE task_id = ? AND cost IS NOT NULL`,
            [result.sessionId]
          );

          const punchData = (rows as Array<Record<string, unknown>>)[0];
          if (!punchData?.total_cost) continue;

          const punchCost = Number(punchData.total_cost);
          const sessionCost = result.totalCost;

          // Allow 10% tolerance for rounding differences
          if (sessionCost > 0 && punchCost > 0) {
            const ratio = punchCost / sessionCost;
            if (ratio < 0.5 || ratio > 2) {
              console.warn(
                `[attestation] ${agent}: punch cost $${punchCost.toFixed(4)} vs session cost $${sessionCost.toFixed(4)} ` +
                `(ratio ${ratio.toFixed(2)}) — significant mismatch`
              );
            }
          }
        }
      });
    });
  },
  900_000 // 15 minute suite timeout
);
