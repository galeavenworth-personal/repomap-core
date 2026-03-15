/**
 * Punch Card Enforcement E2E Smoke Test
 *
 * Run with:
 *   KILO_LIVE=1 npx vitest run tests/punch-card-enforcement-e2e.test.ts --timeout 600000
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";

import { validateFromKiloLog } from "../src/governor/kilo-verified-validator.js";
import {
  assertKiloReachable,
  createDoltConnection,
  DOLT_CONN_CONFIG,
  kiloUrl,
  makeForbiddenEditClient,
  pollUntilComplete,
  SKIP_LIVE,
} from "./helpers/live-test-harness.js";

describe.skipIf(SKIP_LIVE)("Punch card enforcement loop", () => {
  let conn: mysql.Connection;

  beforeAll(async () => {
    await assertKiloReachable();
    conn = await createDoltConnection();
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
    const taskId = `neg-${Date.now()}`;
    const result = await validateFromKiloLog(
      taskId,
      makeForbiddenEditClient(),
      DOLT_CONN_CONFIG,
      "plant-orchestrate",
    );
    expect(result.status).toBe("fail");
    expect(result.violations.some((v) => v.punchType === "tool_call" && v.punchKeyPattern === "edit_file%")).toBe(true);
  });
});
