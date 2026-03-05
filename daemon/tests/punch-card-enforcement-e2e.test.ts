/**
 * Punch Card Enforcement E2E Smoke Test
 *
 * Run with:
 *   KILO_LIVE=1 npx vitest run tests/punch-card-enforcement-e2e.test.ts --timeout 600000
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";

import { PunchCardValidator } from "../src/governor/punch-card-validator.js";

const KILO_HOST = process.env.KILO_HOST ?? "127.0.0.1";
const KILO_PORT = Number.parseInt(process.env.KILO_PORT ?? "4096", 10);
const BASE_URL = `http://${KILO_HOST}:${KILO_PORT}`;
const DOLT_HOST = process.env.DOLT_HOST ?? "127.0.0.1";
const DOLT_PORT = Number.parseInt(process.env.DOLT_PORT ?? "3307", 10);
const DOLT_DB = process.env.DOLT_DATABASE ?? "plant";
const SKIP = !process.env.KILO_LIVE;

function kiloUrl(path: string): string {
  return `${BASE_URL}${path}`;
}

function extractSessionDone(messages: Array<Record<string, unknown>>): boolean {
  let hasStepFinish = false;
  let hasRunningTool = false;

  for (const message of messages) {
    const parts = (message.parts as Array<Record<string, unknown>>) ?? [];
    for (const part of parts) {
      if (part.type === "step-finish") hasStepFinish = true;
      const state = (part.state as Record<string, unknown>) ?? {};
      if (part.type === "tool" && (state.status === "running" || state.status === "pending")) {
        hasRunningTool = true;
      }
    }
  }

  return hasStepFinish && !hasRunningTool;
}

async function pollUntilComplete(sessionId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const response = await fetch(kiloUrl(`/session/${sessionId}/message`));
    if (!response.ok) continue;
    const messages = (await response.json()) as Array<Record<string, unknown>>;
    if (extractSessionDone(messages)) return;
  }
  throw new Error(`Session ${sessionId} did not complete within ${timeoutMs}ms`);
}

describe.skipIf(SKIP)("Punch card enforcement loop", () => {
  let conn: mysql.Connection;

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
  });

  afterAll(async () => {
    await conn.end();
  });

  it("dispatches plant-manager and records delegation checkpoint", async () => {
    const createRes = await fetch(kiloUrl("/session"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "punch-card-enforcement-smoke" }),
    });
    expect(createRes.ok).toBe(true);
    const session = (await createRes.json()) as { id: string };

    const promptRes = await fetch(kiloUrl(`/session/${session.id}/prompt_async`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent: "plant-manager",
        parts: [
          {
            type: "text",
            text: "Dispatch one bounded process-orchestrator child to run a no-op delegation smoke and return immediately.",
          },
        ],
      }),
    });
    expect(promptRes.ok).toBe(true);

    await pollUntilComplete(session.id, 180_000);
    await new Promise((resolve) => setTimeout(resolve, 10_000));

    const [spawnRows] = await conn.query(
      `SELECT punch_type, punch_key
       FROM punches
       WHERE task_id = ? AND punch_type = 'child_spawn'`,
      [session.id]
    );

    const spawns = spawnRows as Array<{ punch_type: string; punch_key: string }>;
    expect(spawns.some((row) => row.punch_key === "process-orchestrator")).toBe(true);

    const [forbiddenRows] = await conn.query(
      `SELECT punch_key
       FROM punches
       WHERE task_id = ?
         AND punch_type = 'tool_call'
         AND punch_key IN ('edit_file', 'apply_diff', 'write_to_file')`,
      [session.id]
    );
    expect((forbiddenRows as Array<unknown>).length).toBe(0);

    const [checkpointRows] = await conn.query(
      `SELECT card_id, status
       FROM checkpoints
       WHERE task_id = ?
       ORDER BY checkpoint_id DESC
       LIMIT 1`,
      [session.id]
    );

    const checkpoints = checkpointRows as Array<{ card_id: string; status: "pass" | "fail" }>;
    expect(checkpoints.length).toBeGreaterThan(0);
    expect(checkpoints[0]?.card_id).toBe("plant-orchestrate");
    expect(checkpoints[0]?.status).toBe("pass");
  });

  it("fails validation when forbidden orchestrator punch exists", async () => {
    const validator = new PunchCardValidator({
      host: DOLT_HOST,
      port: DOLT_PORT,
      database: DOLT_DB,
      user: "root",
    });

    const taskId = `neg-${Date.now()}`;
    await conn.execute(
      `INSERT INTO punches (task_id, punch_type, punch_key, observed_at, source_hash)
       VALUES (?, 'tool_call', 'edit_file', NOW(), SHA2(CONCAT(?, '-forbidden'), 256))`,
      [taskId, taskId]
    );

    try {
      await validator.connect();
      const result = await validator.validatePunchCard(taskId, "plant-orchestrate");
      expect(result.status).toBe("fail");
      expect(result.violations.some((v) => v.punchType === "tool_call" && v.punchKeyPattern === "edit_file%")).toBe(true);
    } finally {
      await validator.disconnect();
    }
  });
});
