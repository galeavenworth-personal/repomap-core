/**
 * Soft enforcement end-to-end validation.
 *
 * Live scenarios require:
 *   KILO_LIVE=1 npm test -- soft-enforcement-e2e.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";

import { validateFromKiloLog } from "../src/governor/kilo-verified-validator.js";
import { resolveCardExitPrompt } from "../src/optimization/prompt-injection.js";
import {
  assertKiloReachable,
  createDoltConnection,
  DOLT_CONN_CONFIG,
  DOLT_HOST,
  DOLT_PORT,
  DOLT_DB,
  kiloUrl,
  pollUntilComplete,
  SKIP_LIVE,
} from "./helpers/live-test-harness.js";

describe("soft enforcement prompt injection", () => {
  let conn: mysql.Connection;
  let promptConn: mysql.Connection;

  beforeAll(async () => {
    conn = await mysql.createConnection({
      host: DOLT_HOST,
      port: DOLT_PORT,
      database: DOLT_DB,
      user: "root",
    });
    promptConn = await mysql.createConnection({
      host: DOLT_HOST,
      port: DOLT_PORT,
      database: "factory",
      user: "root",
    });
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS compiled_prompts (
        prompt_id VARCHAR(100) NOT NULL PRIMARY KEY,
        module_name VARCHAR(100) NOT NULL,
        signature_name VARCHAR(100) NOT NULL,
        compiled_prompt TEXT NOT NULL,
        compiled_at DATETIME NOT NULL,
        dspy_version VARCHAR(20) NOT NULL
      )
    `);
    await promptConn.execute(`
      CREATE TABLE IF NOT EXISTS compiled_prompts (
        prompt_id VARCHAR(100) NOT NULL PRIMARY KEY,
        module_name VARCHAR(100) NOT NULL,
        signature_name VARCHAR(100) NOT NULL,
        compiled_prompt TEXT NOT NULL,
        compiled_at DATETIME NOT NULL,
        dspy_version VARCHAR(20) NOT NULL
      )
    `);
  });

  afterAll(async () => {
    await conn.execute(`DELETE FROM compiled_prompts WHERE prompt_id IN (?, ?)`, [
      "card-exit:execute-subtask",
      "card-exit:plant-orchestrate",
    ]);
    await promptConn.execute(`DELETE FROM compiled_prompts WHERE prompt_id IN (?, ?)`, [
      "card-exit:execute-subtask",
      "card-exit:plant-orchestrate",
    ]);
    await conn.end();
    await promptConn.end();
  });

  it("scenario 4: reads DSPy compiled prompt from Dolt", async () => {
    await conn.execute(
      `INSERT INTO compiled_prompts (prompt_id, module_name, signature_name, compiled_prompt, compiled_at, dspy_version)
       VALUES (?, 'card_exit', 'PunchCardExitSignature', ?, NOW(), '3.1.3')
       ON DUPLICATE KEY UPDATE compiled_prompt = VALUES(compiled_prompt), compiled_at = VALUES(compiled_at)`,
      ["card-exit:execute-subtask", "compiled exit prompt for execute-subtask"],
    );
    await promptConn.execute(
      `INSERT INTO compiled_prompts (prompt_id, module_name, signature_name, compiled_prompt, compiled_at, dspy_version)
       VALUES (?, 'card_exit', 'PunchCardExitSignature', ?, NOW(), '3.1.3')
       ON DUPLICATE KEY UPDATE compiled_prompt = VALUES(compiled_prompt), compiled_at = VALUES(compiled_at)`,
      ["card-exit:execute-subtask", "compiled exit prompt for execute-subtask"],
    );

    const resolution = await resolveCardExitPrompt("code");
    expect(resolution.source).toBe("compiled");
    expect(resolution.prompt).toContain("compiled exit prompt");
  });

  it("scenario 5: falls back to static mode section when compiled prompt missing", async () => {
    await conn.execute(`DELETE FROM compiled_prompts WHERE prompt_id = ?`, [
      "card-exit:execute-subtask",
    ]);
    await promptConn.execute(`DELETE FROM compiled_prompts WHERE prompt_id = ?`, [
      "card-exit:execute-subtask",
    ]);

    const resolution = await resolveCardExitPrompt("code");
    expect(["static", "none"]).toContain(resolution.source);
  });
});

describe.skipIf(SKIP_LIVE)("soft enforcement live scenarios", () => {
  let conn: mysql.Connection;

  beforeAll(async () => {
    await assertKiloReachable();
    conn = await createDoltConnection();
  });

  afterAll(async () => {
    await conn.end();
  });

  it("scenario 1: code agent completes with self-check loop guidance (KILO_LIVE)", async () => {
    const createRes = await fetch(kiloUrl("/session"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: `soft-enforcement-code-${Date.now()}` }),
    });
    expect(createRes.ok).toBe(true);
    const session = (await createRes.json()) as { id: string };

    const promptRes = await fetch(kiloUrl(`/session/${session.id}/prompt_async`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent: "code",
        parts: [
          {
            type: "text",
            text: "Run a no-op validation flow: perform one harmless read, then finish cleanly.",
          },
        ],
      }),
    });
    expect(promptRes.ok).toBe(true);

    await pollUntilComplete(session.id, 180_000);

    const [rows] = await conn.query(
      `SELECT COUNT(*) AS count
       FROM punches
       WHERE task_id = ?
         AND punch_type = 'command_exec'
         AND punch_key LIKE '%check_punch_card.sh%'`,
      [session.id],
    );
    const count = Number((rows as Array<{ count: number }>)[0]?.count ?? 0);
    expect(count).toBeGreaterThan(0);
  });

  it("scenario 2: plant-manager delegation enforcement (KILO_LIVE)", async () => {
    const createRes = await fetch(kiloUrl("/session"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: `soft-enforcement-plant-${Date.now()}` }),
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
            text: "Dispatch one bounded orchestration child and return a short completion summary.",
          },
        ],
      }),
    });
    expect(promptRes.ok).toBe(true);

    await pollUntilComplete(session.id, 180_000);

    const [spawnRows] = await conn.query(
      `SELECT punch_key
       FROM punches
       WHERE task_id = ?
         AND punch_type = 'child_spawn'`,
      [session.id],
    );
    const spawns = (spawnRows as Array<{ punch_key: string }>).map((row) => row.punch_key);
    expect(spawns.length).toBeGreaterThan(0);
  });

  it("scenario 3: negative test with forced card failure", async () => {
    const taskId = `soft-enforce-neg-${Date.now()}`;
    const kiloClient = {
      session: {
        messages: async () => ({
          data: [
            {
              parts: [
                {
                  type: "tool",
                  tool: "edit_file",
                  state: { status: "completed" },
                },
              ],
            },
          ],
        }),
      },
    };
    const result = await validateFromKiloLog(
      taskId,
      kiloClient,
      DOLT_CONN_CONFIG,
      "plant-orchestrate",
    );
    expect(result.status).toBe("fail");
    expect(
      result.violations.some(
        (v) => v.punchType === "tool_call" && v.punchKeyPattern === "edit_file%",
      ),
    ).toBe(true);
  });
});
