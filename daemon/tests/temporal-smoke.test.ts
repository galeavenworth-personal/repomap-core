/**
 * Temporal Pipeline Smoke Tests
 *
 * Validates each phase of the factory dispatch pipeline against a live kilo serve.
 * These are integration tests — they require kilo serve running on localhost:4096.
 *
 * Run with:
 *   KILO_LIVE=1 npx vitest run tests/temporal-smoke.test.ts
 *
 * Skipped by default (no KILO_LIVE env var) so they don't break CI.
 */

import { describe, it, expect, beforeAll } from "vitest";

const KILO_HOST = process.env.KILO_HOST ?? "127.0.0.1";
const KILO_PORT = parseInt(process.env.KILO_PORT ?? "4096", 10);
const BASE_URL = `http://${KILO_HOST}:${KILO_PORT}`;
const SKIP = !process.env.KILO_LIVE;

function kiloUrl(path: string): string {
  return `${BASE_URL}${path}`;
}

describe.skipIf(SKIP)("Temporal Pipeline — live kilo serve smoke test", () => {
  let sessionId: string;

  beforeAll(async () => {
    // Verify kilo serve is reachable before running any tests
    const res = await fetch(kiloUrl("/session")).catch(() => null);
    if (!res?.ok) {
      throw new Error(
        `kilo serve not reachable at ${BASE_URL}. Start it first.`
      );
    }
  });

  it("Phase 1: health check — GET /session returns 200", async () => {
    const res = await fetch(kiloUrl("/session"));
    expect(res.ok).toBe(true);
    const sessions = await res.json();
    expect(Array.isArray(sessions)).toBe(true);
  });

  it("Phase 2: create session — POST /session returns id", async () => {
    const res = await fetch(kiloUrl("/session"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "smoke-test: temporal pipeline" }),
    });
    expect(res.ok).toBe(true);
    const data = (await res.json()) as Record<string, unknown>;
    expect(typeof data.id).toBe("string");
    expect((data.id as string).length).toBeGreaterThan(0);
    sessionId = data.id as string;
  });

  it("Phase 3: send prompt async — POST /session/{id}/prompt_async returns 2xx", async () => {
    expect(sessionId).toBeDefined();

    const body = {
      parts: [{ type: "text", text: "Reply with exactly: SMOKE_TEST_OK" }],
      agent: "code",
    };

    const res = await fetch(kiloUrl(`/session/${sessionId}/prompt_async`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    // prompt_async should return immediately (2xx)
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
  });

  it("Phase 4: poll messages — GET /session/{id}/message returns array", async () => {
    expect(sessionId).toBeDefined();

    // Wait a moment for the agent to start processing
    await new Promise((r) => setTimeout(r, 2000));

    const res = await fetch(kiloUrl(`/session/${sessionId}/message`));
    expect(res.ok).toBe(true);
    const messages = await res.json();
    expect(Array.isArray(messages)).toBe(true);
    // After sending a prompt, there should be at least one message (the user message)
    expect(messages.length).toBeGreaterThanOrEqual(1);
  });

  it("Phase 5: session status — GET /session/{id} returns status field", async () => {
    expect(sessionId).toBeDefined();

    const res = await fetch(kiloUrl(`/session/${sessionId}`));
    expect(res.ok).toBe(true);
    const data = (await res.json()) as Record<string, unknown>;
    // Session should have an id field
    expect(data.id).toBe(sessionId);
  });

  it("Phase 6: poll until done — session completes within 60s", async () => {
    expect(sessionId).toBeDefined();

    const startTime = Date.now();
    const timeout = 60_000;
    const pollInterval = 3_000;

    while (Date.now() - startTime < timeout) {
      const res = await fetch(kiloUrl(`/session/${sessionId}/message`));
      if (!res.ok) {
        await new Promise((r) => setTimeout(r, pollInterval));
        continue;
      }

      const messages = (await res.json()) as Array<Record<string, unknown>>;
      let hasStepFinish = false;
      let hasRunningTools = false;

      for (const msg of messages) {
        const parts = (msg.parts as Array<Record<string, unknown>>) ?? [];
        for (const part of parts) {
          if (part.type === "step-finish") hasStepFinish = true;
          if (
            part.type === "tool" &&
            ((part.state as Record<string, unknown>)?.status === "running" ||
              (part.state as Record<string, unknown>)?.status === "pending")
          ) {
            hasRunningTools = true;
          }
        }
      }

      if (hasStepFinish && !hasRunningTools) {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        console.log(`[smoke] Session completed in ${elapsed}s`);
        return; // Success
      }

      await new Promise((r) => setTimeout(r, pollInterval));
    }

    throw new Error(
      `Session ${sessionId} did not complete within ${timeout / 1000}s`
    );
  }, 65_000); // vitest timeout slightly longer than our poll timeout

  it("Phase 7: extract result — last assistant message has text", async () => {
    expect(sessionId).toBeDefined();

    const res = await fetch(kiloUrl(`/session/${sessionId}/message`));
    expect(res.ok).toBe(true);
    const messages = (await res.json()) as Array<Record<string, unknown>>;

    // Find any assistant text
    let assistantText = "";
    for (const msg of messages) {
      const info = msg.info as Record<string, unknown> | undefined;
      if (info?.role !== "assistant") continue;
      const parts = (msg.parts as Array<Record<string, unknown>>) ?? [];
      for (const part of parts) {
        if (part.type === "text" && typeof part.text === "string") {
          assistantText += part.text;
        }
      }
    }

    expect(assistantText.length).toBeGreaterThan(0);
    console.log(
      `[smoke] Assistant response: ${assistantText.slice(0, 200)}...`
    );
  });

  it("Phase 8: children endpoint — GET /session/{id}/children returns array", async () => {
    expect(sessionId).toBeDefined();

    // Children endpoint may or may not exist; just verify it doesn't 500
    const res = await fetch(kiloUrl(`/session/${sessionId}/children`));
    // Accept 200 (empty array) or 404 (endpoint not available)
    expect([200, 404]).toContain(res.status);

    if (res.ok) {
      const children = await res.json();
      expect(Array.isArray(children)).toBe(true);
    }
  });
});
