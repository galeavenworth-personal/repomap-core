/**
 * Tests for Factory Dispatch — TypeScript logic module.
 *
 * These tests verify the core logic by mocking fetch() for each phase.
 * No running kilo serve, Dolt, or Temporal is required.
 */

import { describe, expect, it, vi, beforeEach, afterAll } from "vitest";
import type { Mock } from "vitest";
import {
  type FactoryDispatchConfig,
  type PromptPayload,
  type SessionMessage,
  type ChildSession,
  defaultConfig,
  buildPromptPayload,
  injectSessionId,
  isSessionDone,
  extractResult,
  fetchChildren,
  fetchMessages,
  areAllChildrenDone,
  monitorSession,
  createSession,
  dispatchPrompt,
  ExitCode,
  checkPort,
} from "../src/infra/factory-dispatch.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";

// ── Helpers ──────────────────────────────────────────────────────────────

function makeTestConfig(overrides: Partial<FactoryDispatchConfig> = {}): FactoryDispatchConfig {
  return {
    ...defaultConfig(),
    quiet: true,
    pollInterval: 0.01, // fast polling for tests
    maxWait: 1,
    idleConfirm: 1,
    ...overrides,
  };
}

function mockFetchResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("FactoryDispatch", () => {
  describe("defaultConfig", () => {
    it("returns a config with expected defaults", () => {
      const config = defaultConfig();
      expect(config.mode).toBe("plant-manager");
      expect(config.host).toBe("127.0.0.1");
      expect(config.port).toBe(4096);
      expect(config.maxWait).toBe(600);
      expect(config.pollInterval).toBe(10);
      expect(config.quiet).toBe(false);
      expect(config.noMonitor).toBe(false);
      expect(config.jsonOutput).toBe(false);
      expect(config.idleConfirm).toBeGreaterThan(0);
    });
  });

  describe("buildPromptPayload", () => {
    const testDir = join(tmpdir(), `factory-dispatch-test-${Date.now()}`);

    beforeEach(() => {
      mkdirSync(testDir, { recursive: true });
    });

    it("wraps a plain text string with agent and parts", () => {
      const payload = buildPromptPayload("Hello world", "code");
      expect(payload.agent).toBe("code");
      expect(payload.parts).toHaveLength(1);
      expect(payload.parts[0].type).toBe("text");
      expect(payload.parts[0].text).toBe("Hello world");
    });

    it("reads a JSON file and preserves existing agent", () => {
      const filePath = join(testDir, "test-prompt.json");
      writeFileSync(
        filePath,
        JSON.stringify({
          agent: "custom-agent",
          parts: [{ type: "text", text: "Test prompt" }],
        }),
      );

      const payload = buildPromptPayload(filePath, "plant-manager");
      expect(payload.agent).toBe("custom-agent");
      expect(payload.parts[0].text).toBe("Test prompt");
    });

    it("injects agent into JSON file when missing", () => {
      const filePath = join(testDir, "no-agent.json");
      writeFileSync(
        filePath,
        JSON.stringify({
          parts: [{ type: "text", text: "No agent here" }],
        }),
      );

      const payload = buildPromptPayload(filePath, "plant-manager");
      expect(payload.agent).toBe("plant-manager");
    });

    it("throws for a non-existent JSON file", () => {
      expect(() => buildPromptPayload("/nonexistent/path.json", "code")).toThrow(
        "Prompt file not found",
      );
    });

    // Cleanup
    afterAll(() => {
      rmSync(testDir, { recursive: true, force: true });
    });
  });

  describe("injectSessionId", () => {
    it("prepends session context to the first text part", () => {
      const payload: PromptPayload = {
        agent: "code",
        parts: [{ type: "text", text: "Hello" }],
      };
      injectSessionId(payload, "sess-123");
      expect(payload.parts[0].text).toContain("SESSION_ID: sess-123");
      expect(payload.parts[0].text).toContain("Hello");
    });

    it("replaces $SESSION_ID template variables", () => {
      const payload: PromptPayload = {
        agent: "code",
        parts: [{ type: "text", text: "Check $SESSION_ID now" }],
      };
      injectSessionId(payload, "sess-abc");
      expect(payload.parts[0].text).toContain("Check sess-abc now");
      expect(payload.parts[0].text).not.toContain("$SESSION_ID");
    });

    it("replaces ${SESSION_ID} template variables", () => {
      const payload: PromptPayload = {
        agent: "code",
        parts: [{ type: "text", text: "Use ${SESSION_ID} here" }],
      };
      injectSessionId(payload, "sess-xyz");
      expect(payload.parts[0].text).toContain("Use sess-xyz here");
    });

    it("replaces {{SESSION_ID}} template variables", () => {
      const payload: PromptPayload = {
        agent: "code",
        parts: [{ type: "text", text: "ID is {{SESSION_ID}}" }],
      };
      injectSessionId(payload, "sess-42");
      expect(payload.parts[0].text).toContain("ID is sess-42");
    });

    it("inserts context part when no text parts exist", () => {
      const payload: PromptPayload = {
        agent: "code",
        parts: [{ type: "image", text: undefined }],
      };
      injectSessionId(payload, "sess-999");
      expect(payload.parts[0].type).toBe("text");
      expect(payload.parts[0].text).toContain("SESSION_ID: sess-999");
    });
  });

  describe("isSessionDone", () => {
    it("returns false for empty messages", () => {
      expect(isSessionDone([])).toBe(false);
    });

    it("returns true for end_turn step-finish with no running tools", () => {
      const messages: SessionMessage[] = [
        {
          parts: [{ type: "step-finish", reason: "end_turn" }],
        },
      ];
      expect(isSessionDone(messages)).toBe(true);
    });

    it("returns true for stop step-finish", () => {
      const messages: SessionMessage[] = [
        {
          parts: [{ type: "step-finish", reason: "stop" }],
        },
      ];
      expect(isSessionDone(messages)).toBe(true);
    });

    it("returns true for max_tokens step-finish", () => {
      const messages: SessionMessage[] = [
        {
          parts: [{ type: "step-finish", reason: "max_tokens" }],
        },
      ];
      expect(isSessionDone(messages)).toBe(true);
    });

    it("returns true for empty reason step-finish", () => {
      const messages: SessionMessage[] = [
        {
          parts: [{ type: "step-finish", reason: "" }],
        },
      ];
      expect(isSessionDone(messages)).toBe(true);
    });

    it("returns false when tool-calls resets terminal finish", () => {
      const messages: SessionMessage[] = [
        {
          parts: [
            { type: "step-finish", reason: "end_turn" },
            { type: "step-finish", reason: "tool-calls" },
          ],
        },
      ];
      expect(isSessionDone(messages)).toBe(false);
    });

    it("returns false when there are running tools", () => {
      const messages: SessionMessage[] = [
        {
          parts: [
            { type: "step-finish", reason: "end_turn" },
            { type: "tool", state: { status: "running" } },
          ],
        },
      ];
      expect(isSessionDone(messages)).toBe(false);
    });

    it("returns false when there are pending tools", () => {
      const messages: SessionMessage[] = [
        {
          parts: [
            { type: "step-finish", reason: "end_turn" },
            { type: "tool", state: { status: "pending" } },
          ],
        },
      ];
      expect(isSessionDone(messages)).toBe(false);
    });

    it("returns true with completed tools and terminal finish", () => {
      const messages: SessionMessage[] = [
        {
          parts: [
            { type: "tool", state: { status: "completed" } },
            { type: "step-finish", reason: "end_turn" },
          ],
        },
      ];
      expect(isSessionDone(messages)).toBe(true);
    });
  });

  describe("extractResult", () => {
    it("returns null for empty messages", () => {
      expect(extractResult([])).toBeNull();
    });

    it("returns null when no assistant messages exist", () => {
      const messages: SessionMessage[] = [
        { info: { role: "user" }, parts: [{ type: "text", text: "Hello" }] },
      ];
      expect(extractResult(messages)).toBeNull();
    });

    it("prefers substantial text (>100 chars)", () => {
      const shortText = "Short";
      const longText = "A".repeat(150);
      const messages: SessionMessage[] = [
        {
          info: { role: "assistant" },
          parts: [{ type: "text", text: shortText }],
        },
        {
          info: { role: "assistant" },
          parts: [{ type: "text", text: longText }],
        },
      ];
      expect(extractResult(messages)).toBe(longText);
    });

    it("falls back to any assistant text when no substantial text exists", () => {
      const messages: SessionMessage[] = [
        {
          info: { role: "assistant" },
          parts: [{ type: "text", text: "Short answer" }],
        },
      ];
      expect(extractResult(messages)).toBe("Short answer");
    });

    it("returns the LAST assistant message text", () => {
      const messages: SessionMessage[] = [
        {
          info: { role: "assistant" },
          parts: [{ type: "text", text: "A".repeat(200) }],
        },
        {
          info: { role: "assistant" },
          parts: [{ type: "text", text: "B".repeat(200) }],
        },
      ];
      expect(extractResult(messages)).toBe("B".repeat(200));
    });
  });

  describe("fetchChildren", () => {
    it("returns children from successful response", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        mockFetchResponse([{ id: "child-1" }, { id: "child-2" }]),
      );
      const children = await fetchChildren("http://localhost:4096", "sess-1", mockFetch);
      expect(children).toHaveLength(2);
      expect(children[0].id).toBe("child-1");
    });

    it("returns empty array on error", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("Network error"));
      const children = await fetchChildren("http://localhost:4096", "sess-1", mockFetch);
      expect(children).toHaveLength(0);
    });

    it("returns empty array on non-ok response", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response("Not found", { status: 404 }),
      );
      const children = await fetchChildren("http://localhost:4096", "sess-1", mockFetch);
      expect(children).toHaveLength(0);
    });
  });

  describe("fetchMessages", () => {
    it("returns messages from successful response", async () => {
      const msgs: SessionMessage[] = [
        { info: { role: "assistant" }, parts: [{ type: "text", text: "Hi" }] },
      ];
      const mockFetch = vi.fn().mockResolvedValue(mockFetchResponse(msgs));
      const result = await fetchMessages("http://localhost:4096", "sess-1", mockFetch);
      expect(result).toHaveLength(1);
    });

    it("returns empty array on error", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("fail"));
      const result = await fetchMessages("http://localhost:4096", "sess-1", mockFetch);
      expect(result).toHaveLength(0);
    });
  });

  describe("areAllChildrenDone", () => {
    it("returns true when all children have no running tools", async () => {
      const children: ChildSession[] = [{ id: "c1" }, { id: "c2" }];
      const msgs: SessionMessage[] = [
        { parts: [{ type: "tool", state: { status: "completed" } }] },
      ];
      const mockFetch = vi.fn().mockResolvedValue(mockFetchResponse(msgs));
      expect(await areAllChildrenDone("http://localhost:4096", children, mockFetch)).toBe(true);
    });

    it("returns false when a child has running tools", async () => {
      const children: ChildSession[] = [{ id: "c1" }];
      const msgs: SessionMessage[] = [
        { parts: [{ type: "tool", state: { status: "running" } }] },
      ];
      const mockFetch = vi.fn().mockResolvedValue(mockFetchResponse(msgs));
      expect(await areAllChildrenDone("http://localhost:4096", children, mockFetch)).toBe(false);
    });

    it("returns true for empty children list", async () => {
      const mockFetch = vi.fn();
      expect(await areAllChildrenDone("http://localhost:4096", [], mockFetch)).toBe(true);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("createSession", () => {
    it("returns session ID from successful response", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        mockFetchResponse({ id: "sess-new-123" }),
      );
      const id = await createSession("http://localhost:4096", "Test Session", mockFetch);
      expect(id).toBe("sess-new-123");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:4096/session",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ title: "Test Session" }),
        }),
      );
    });

    it("throws on non-ok response", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response("Error", { status: 500 }),
      );
      await expect(createSession("http://localhost:4096", "Test", mockFetch)).rejects.toThrow(
        "Failed to create session",
      );
    });

    it("throws when response has no id", async () => {
      const mockFetch = vi.fn().mockResolvedValue(mockFetchResponse({}));
      await expect(createSession("http://localhost:4096", "Test", mockFetch)).rejects.toThrow(
        "missing 'id' field",
      );
    });
  });

  describe("dispatchPrompt", () => {
    it("succeeds on 2xx response", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response("", { status: 202 }),
      );
      await expect(
        dispatchPrompt("http://localhost:4096", "sess-1", { parts: [] }, mockFetch),
      ).resolves.toBeUndefined();
    });

    it("throws on non-2xx response", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response("Error", { status: 400 }),
      );
      await expect(
        dispatchPrompt("http://localhost:4096", "sess-1", { parts: [] }, mockFetch),
      ).rejects.toThrow("Prompt dispatch failed (HTTP 400)");
    });
  });

  describe("monitorSession", () => {
    it("completes when session is done", async () => {
      const config = makeTestConfig({ maxWait: 2, pollInterval: 0.01, idleConfirm: 1 });
      const log = vi.fn();

      // First call: children endpoint, second: messages endpoint
      let callCount = 0;
      const mockFetch = vi.fn(async (url: string | URL | Request) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/children")) {
          return mockFetchResponse([]);
        }
        if (urlStr.includes("/message")) {
          callCount++;
          if (callCount >= 1) {
            return mockFetchResponse([
              { parts: [{ type: "step-finish", reason: "end_turn" }] },
            ]);
          }
          return mockFetchResponse([]);
        }
        return mockFetchResponse([]);
      }) as Mock;

      const result = await monitorSession(
        "http://localhost:4096",
        "sess-1",
        config,
        log,
        mockFetch,
      );
      expect(result.completed).toBe(true);
    });

    it("times out when session never completes", async () => {
      const config = makeTestConfig({ maxWait: 0.05, pollInterval: 0.01, idleConfirm: 1 });
      const log = vi.fn();

      const mockFetch = vi.fn(async (url: string | URL | Request) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/children")) {
          return mockFetchResponse([]);
        }
        // Always return "not done"
        return mockFetchResponse([
          { parts: [{ type: "tool", state: { status: "running" } }] },
        ]);
      }) as Mock;

      const result = await monitorSession(
        "http://localhost:4096",
        "sess-1",
        config,
        log,
        mockFetch,
      );
      expect(result.completed).toBe(false);
    });

    it("tracks child count changes", async () => {
      const config = makeTestConfig({ maxWait: 2, pollInterval: 0.01, idleConfirm: 1 });
      const log = vi.fn();

      let pollCount = 0;
      const mockFetch = vi.fn(async (url: string | URL | Request) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/children")) {
          pollCount++;
          if (pollCount <= 1) return mockFetchResponse([]);
          return mockFetchResponse([{ id: "child-1" }]);
        }
        if (urlStr.includes("/message")) {
          if (pollCount >= 2) {
            return mockFetchResponse([
              { parts: [{ type: "step-finish", reason: "end_turn" }] },
            ]);
          }
          return mockFetchResponse([]);
        }
        return mockFetchResponse([]);
      }) as Mock;

      const result = await monitorSession(
        "http://localhost:4096",
        "sess-1",
        config,
        log,
        mockFetch,
      );
      expect(result.completed).toBe(true);
      expect(result.childCount).toBe(1);
    });
  });

  describe("checkPort", () => {
    it("returns true when a port is listening", async () => {
      const server = createServer();
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;

      try {
        const result = await checkPort("127.0.0.1", port, 1000);
        expect(result).toBe(true);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("returns false when no port is listening", async () => {
      // Use a port unlikely to be in use
      const result = await checkPort("127.0.0.1", 19998, 500);
      expect(result).toBe(false);
    });
  });

  describe("ExitCode", () => {
    it("has the correct values matching the shell script", () => {
      expect(ExitCode.SUCCESS).toBe(0);
      expect(ExitCode.USAGE_ERROR).toBe(1);
      expect(ExitCode.HEALTH_CHECK_FAILED).toBe(2);
      expect(ExitCode.SESSION_CREATION_FAILED).toBe(3);
      expect(ExitCode.PROMPT_DISPATCH_FAILED).toBe(4);
      expect(ExitCode.TIMEOUT).toBe(5);
      expect(ExitCode.NO_RESPONSE).toBe(6);
    });
  });
});
