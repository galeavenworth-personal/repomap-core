/**
 * Mode Routing E2E Test
 *
 * Validates that kilo serve correctly routes sessions to custom agents
 * with the expected model assignments from opencode.json.
 *
 * Strategy: Direct dispatch — create one session per agent, send prompt
 * with the agent field set, poll for completion, extract mode/model from
 * the assistant message metadata. No plant-manager middleman needed.
 *
 * This tests the full chain:
 *   opencode.json agent config → kilo serve model selection → response metadata
 *
 * Run with:
 *   KILO_LIVE=1 npx vitest run tests/mode-routing-e2e.test.ts
 *
 * Requires: kilo serve running on localhost:4096 with OAuth credentials (kilo auth login)
 * Skipped by default (no KILO_LIVE env var) so it doesn't break CI.
 */

import { describe, it, expect, beforeAll } from "vitest";

const KILO_HOST = process.env.KILO_HOST ?? "127.0.0.1";
const KILO_PORT = Number.parseInt(process.env.KILO_PORT ?? "4096", 10);
const BASE_URL = `http://${KILO_HOST}:${KILO_PORT}`;
const SKIP = !process.env.KILO_LIVE;

// Expected model routing from ~/.config/kilo/opencode.json
// This is the source of truth — the test validates reality matches config.
const EXPECTED_ROUTING: Record<string, string> = {
  "plant-manager": "kilo/anthropic/claude-opus-4.6",
  "process-orchestrator": "kilo/anthropic/claude-opus-4.6",
  "audit-orchestrator": "kilo/anthropic/claude-opus-4.6",
  architect: "kilo/anthropic/claude-opus-4.6",
  "product-skeptic": "kilo/anthropic/claude-opus-4.6",
  code: "openai/gpt-5.3-codex",
  fitter: "openai/gpt-5.3-codex",
  "code-simplifier": "openai/gpt-5.3-codex",
  "pr-review": "kilo/anthropic/claude-sonnet-4.6",
  "docs-specialist": "kilo/anthropic/claude-sonnet-4.6",
  "thinker-abstract": "openai/gpt-5.2",
  "thinker-adversarial": "openai/gpt-5.2",
  "thinker-systems": "openai/gpt-5.2",
  "thinker-concrete": "openai/gpt-5.2",
  "thinker-epistemic": "openai/gpt-5.2",
};

const AGENTS_TO_TEST = Object.keys(EXPECTED_ROUTING);

function kiloUrl(path: string): string {
  return `${BASE_URL}${path}`;
}

interface SessionMessage {
  info: {
    role: string;
    modelID?: string;
    providerID?: string;
    mode?: string;
    agent?: string;
    cost?: number;
    tokens?: {
      input?: number;
      output?: number;
      reasoning?: number;
      total?: number;
      cache?: { read?: number; write?: number };
    };
  };
  parts: Array<{
    type: string;
    text?: string;
    tool?: string;
    state?: { status?: string; input?: Record<string, unknown> };
  }>;
}

interface ModeReport {
  agent: string;
  sessionId: string;
  reportedMode: string | null;
  reportedAgent: string | null;
  reportedModel: string | null;
  reportedProvider: string | null;
  fullModelId: string | null;
  expectedModel: string;
  cost: number;
  tokensInput: number;
  tokensOutput: number;
  cacheRead: number;
  cacheWrite: number;
  error: string | null;
}

const IDENTITY_PROMPT =
  "You are being tested for mode routing. Do NOT use any tools. Reply with ONLY this exact sentence: MODE_ROUTING_TEST_OK";

function areMessagesComplete(messages: SessionMessage[]): boolean {
  let hasStepFinish = false;
  let hasRunningTools = false;
  for (const msg of messages) {
    for (const part of msg.parts ?? []) {
      if (part.type === "step-finish") hasStepFinish = true;
      if (part.type === "tool" && (part.state?.status === "running" || part.state?.status === "pending")) {
        hasRunningTools = true;
      }
    }
  }
  return hasStepFinish && !hasRunningTools;
}

async function pollUntilDone(
  sessionId: string,
  timeoutMs: number
): Promise<SessionMessage[]> {
  const start = Date.now();
  const interval = 3_000;

  while (Date.now() - start < timeoutMs) {
    const res = await fetch(kiloUrl(`/session/${sessionId}/message`));
    if (!res.ok) {
      await new Promise((r) => setTimeout(r, interval));
      continue;
    }
    const messages = (await res.json()) as SessionMessage[];
    if (areMessagesComplete(messages)) return messages;
    await new Promise((r) => setTimeout(r, interval));
  }

  throw new Error(`Session ${sessionId} did not complete within ${timeoutMs / 1000}s`);
}

interface MessageAccum {
  mode: string | null;
  agent: string | null;
  model: string | null;
  provider: string | null;
  cost: number;
  tokensInput: number;
  tokensOutput: number;
  cacheRead: number;
  cacheWrite: number;
}

function accumulateAssistantInfo(msg: SessionMessage, acc: MessageAccum): void {
  const info = msg.info;
  if (!info || info.role !== "assistant") return;
  if (!acc.mode && info.mode) acc.mode = info.mode;
  if (!acc.agent && info.agent) acc.agent = info.agent;
  if (!acc.model && info.modelID) acc.model = info.modelID;
  if (!acc.provider && info.providerID) acc.provider = info.providerID;
  acc.cost += info.cost ?? 0;
  acc.tokensInput += info.tokens?.input ?? 0;
  acc.tokensOutput += info.tokens?.output ?? 0;
  acc.cacheRead += info.tokens?.cache?.read ?? 0;
  acc.cacheWrite += info.tokens?.cache?.write ?? 0;
}

function extractReport(
  agent: string,
  sessionId: string,
  messages: SessionMessage[]
): ModeReport {
  const acc: MessageAccum = {
    mode: null, agent: null, model: null, provider: null,
    cost: 0, tokensInput: 0, tokensOutput: 0, cacheRead: 0, cacheWrite: 0,
  };
  for (const msg of messages) accumulateAssistantInfo(msg, acc);

  const fullModelId = acc.provider && acc.model ? `${acc.provider}/${acc.model}` : acc.model;

  return {
    agent, sessionId,
    reportedMode: acc.mode, reportedAgent: acc.agent,
    reportedModel: acc.model, reportedProvider: acc.provider,
    fullModelId, expectedModel: EXPECTED_ROUTING[agent],
    cost: acc.cost, tokensInput: acc.tokensInput, tokensOutput: acc.tokensOutput,
    cacheRead: acc.cacheRead, cacheWrite: acc.cacheWrite,
    error: null,
  };
}

describe.skipIf(SKIP)(
  "Mode Routing E2E — direct dispatch per agent, verify model routing",
  () => {
    const reports: ModeReport[] = [];

    beforeAll(async () => {
      const res = await fetch(kiloUrl("/session")).catch(() => null);
      if (!res?.ok) {
        throw new Error(
          `kilo serve not reachable at ${BASE_URL}. Start it first.`
        );
      }
    });

    // Dispatch all agents in parallel — each gets its own session
    it(
      "dispatches one session per agent and collects identity reports",
      async () => {
        const dispatches = AGENTS_TO_TEST.map(async (agent) => {
          try {
            // Create session
            const createRes = await fetch(kiloUrl("/session"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                title: `mode-routing-test: ${agent}`,
              }),
            });
            if (!createRes.ok) throw new Error(`Create failed: ${createRes.status}`);
            const session = (await createRes.json()) as { id: string };

            // Send prompt with agent field
            const promptRes = await fetch(
              kiloUrl(`/session/${session.id}/prompt_async`),
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  parts: [{ type: "text", text: IDENTITY_PROMPT }],
                  agent,
                }),
              }
            );
            if (promptRes.status < 200 || promptRes.status >= 300) {
              throw new Error(`Prompt dispatch failed: ${promptRes.status}`);
            }

            console.log(`[mode-routing] Dispatched ${agent} → ${session.id}`);

            // Poll until done (60s per agent — they just need to reply)
            const msgs = await pollUntilDone(session.id, 60_000);
            return extractReport(agent, session.id, msgs);
          } catch (err) {
            console.error(`[mode-routing] ${agent}: ${(err as Error).message}`);
            return {
              agent,
              sessionId: "FAILED",
              reportedMode: null,
              reportedAgent: null,
              reportedModel: null,
              reportedProvider: null,
              fullModelId: null,
              expectedModel: EXPECTED_ROUTING[agent],
              cost: 0,
              tokensInput: 0,
              tokensOutput: 0,
              cacheRead: 0,
              cacheWrite: 0,
              error: (err as Error).message,
            } satisfies ModeReport;
          }
        });

        const results = await Promise.all(dispatches);
        reports.push(...results);

        const completed = reports.filter((r) => r.error === null);
        console.log(
          `[mode-routing] ${completed.length}/${reports.length} agents completed`
        );
        expect(completed.length).toBeGreaterThan(0);
      },
      120_000
    );

    it("prints mode routing report", () => {
      expect(reports.length).toBeGreaterThan(0);

      console.log("\n══════════════════════════════════════════════════════════════════════════════════════");
      console.log("  MODE ROUTING REPORT");
      console.log("══════════════════════════════════════════════════════════════════════════════════════");

      let totalCost = 0;
      let totalInput = 0;
      let totalOutput = 0;
      let totalCacheRead = 0;
      let totalCacheWrite = 0;
      let matchCount = 0;
      let mismatchCount = 0;
      let failCount = 0;

      // Sort by agent name for readability
      const sorted = [...reports].sort((a, b) => a.agent.localeCompare(b.agent));

      for (const r of sorted) {
        totalCost += r.cost;
        totalInput += r.tokensInput;
        totalOutput += r.tokensOutput;
        totalCacheRead += r.cacheRead;
        totalCacheWrite += r.cacheWrite;

        if (r.error) {
          failCount++;
          console.log(
            `💀 ${r.agent.padEnd(25)} | ERROR: ${r.error}`
          );
          continue;
        }

        // Check: did the agent field match what we requested?
        const agentMatch = r.reportedAgent === r.agent;
        // Check: did the model match expected routing?
        const modelMatch = r.fullModelId === r.expectedModel;
        const routedCorrectly = agentMatch && modelMatch;

        if (routedCorrectly) matchCount++;
        else mismatchCount++;

        const icon = routedCorrectly ? "✅" : "❌";
        const agentStatus = agentMatch ? r.reportedAgent : `${r.reportedAgent} (wanted ${r.agent})`;
        console.log(
          `${icon} ${r.agent.padEnd(25)} | agent=${(agentStatus ?? "???").padEnd(25)} | model=${(r.fullModelId ?? "???").padEnd(35)} | expected=${r.expectedModel.padEnd(35)} | $${r.cost.toFixed(4)} | cache_r=${r.cacheRead} cache_w=${r.cacheWrite}`
        );
      }

      console.log("──────────────────────────────────────────────────────────────────────────────────────");
      console.log(
        `Total cost:    $${totalCost.toFixed(4)} | input: ${totalInput.toLocaleString()} | output: ${totalOutput.toLocaleString()}`
      );
      console.log(
        `Cache:         read=${totalCacheRead.toLocaleString()} write=${totalCacheWrite.toLocaleString()}`
      );
      console.log(
        `Routing:       ${matchCount} correct | ${mismatchCount} misrouted | ${failCount} failed`
      );
      console.log("══════════════════════════════════════════════════════════════════════════════════════\n");
    });

    it("validates all agents got correct model routing", () => {
      expect(reports.length).toBe(AGENTS_TO_TEST.length);

      const problems: string[] = [];

      for (const r of reports) {
        if (r.error) {
          problems.push(`${r.agent}: dispatch error — ${r.error}`);
          continue;
        }

        // Agent routing: the session must report the agent we requested
        if (r.reportedAgent !== r.agent) {
          problems.push(
            `${r.agent}: agent mismatch — got agent="${r.reportedAgent}" (expected "${r.agent}")`
          );
        }

        // Model routing: the session must use the model from opencode.json
        if (r.fullModelId !== r.expectedModel) {
          problems.push(
            `${r.agent}: model mismatch — got ${r.fullModelId} (expected ${r.expectedModel})`
          );
        }
      }

      if (problems.length > 0) {
        console.error("\n[mode-routing] ROUTING FAILURES:");
        for (const p of problems) {
          console.error(`  ✗ ${p}`);
        }
      }

      expect(problems).toEqual([]);
    });

    it("validates prompt caching is active for Anthropic models", () => {
      const anthropicReports = reports.filter(
        (r) => !r.error && r.fullModelId?.includes("anthropic")
      );

      if (anthropicReports.length === 0) {
        console.log("[mode-routing] No Anthropic sessions to check caching on");
        return;
      }

      const hasCaching = anthropicReports.some(
        (r) => r.cacheRead > 0 || r.cacheWrite > 0
      );

      console.log(
        `[mode-routing] Anthropic cache status: ${hasCaching ? "ACTIVE" : "INACTIVE"} (${anthropicReports.length} sessions checked)`
      );

      // Soft check — Kilo Gateway currently does NOT forward cache_control
      // to Anthropic upstream. OpenAI models DO get caching.
      // Log the result but don't fail the suite over it.
      if (!hasCaching) {
        console.warn(
          "[mode-routing] KNOWN ISSUE: Kilo Gateway does not forward cache_control to Anthropic."
        );
      }
    });
  }
);
