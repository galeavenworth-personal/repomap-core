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
  runDispatch,
  runSingleDispatch,
  parseLabelValue,
  isParentOnlyStep,
  extractStepConfig,
  buildCookCommand,
  buildPourCommand,
  ExitCode,
  checkPort,
  isPm2AppOnline,
} from "../src/infra/factory-dispatch.js";
import { parseArgs } from "../src/infra/factory-dispatch.cli.ts";
import * as pm2Client from "../src/infra/pm2-client.js";
import {
  makeTestConfig,
  mockFetchResponse,
  startHealthyStack,
  mockBdPipeline,
  captureStdout,
  moleculeTestConfig,
} from "./helpers/factory-dispatch-helpers.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";

type FetchInput = string | URL | Request;

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
      expect(config.formula).toBe("");
      expect(config.vars).toEqual([]);
      expect(config.idleConfirm).toBeGreaterThan(0);
      expect(config.cardId).toBe("");
    });
  });

  describe("parseArgs", () => {
    it("sets formula from --formula", () => {
      const config = parseArgs(["node", "script", "--formula", "my-formula"]);
      expect(config.formula).toBe("my-formula");
    });

    it("accumulates repeated --var values", () => {
      const config = parseArgs([
        "node",
        "script",
        "--formula",
        "my-formula",
        "--var",
        "foo=bar",
        "--var",
        "baz=qux",
      ]);
      expect(config.vars).toEqual(["foo=bar", "baz=qux"]);
    });

    it("does not error when formula is provided without positional prompt", () => {
      const config = parseArgs(["node", "script", "--formula", "my-formula"]);
      expect(config.formula).toBe("my-formula");
      expect(config.promptArg).toBe("");
    });

    it("still errors when neither formula nor positional prompt is provided", () => {
      const exitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation(((code?: number | string | null) => {
          throw new Error(`process.exit:${code ?? ""}`);
        }) as never);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      expect(() => parseArgs(["node", "script"]))
        .toThrowError("process.exit:1");
      expect(errorSpy).toHaveBeenCalledWith("ERROR: No prompt or formula provided. Use --help for usage.");

      exitSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it("keeps legacy positional-prompt behavior and existing flags", () => {
      const config = parseArgs([
        "node",
        "script",
        "--mode",
        "code",
        "--wait",
        "30",
        "--poll",
        "3",
        "hello world",
      ]);
      expect(config.mode).toBe("code");
      expect(config.maxWait).toBe(30);
      expect(config.pollInterval).toBe(3);
      expect(config.promptArg).toBe("hello world");
      expect(config.formula).toBe("");
      expect(config.vars).toEqual([]);
    });

    it("parses all legacy flags together", () => {
      const config = parseArgs([
        "node",
        "script",
        "--mode",
        "code",
        "--title",
        "Legacy title",
        "--card",
        "execute-subtask",
        "--bead-id",
        "repomap-core-123",
        "--quiet",
        "--json",
        "--no-monitor",
        "--wait",
        "45",
        "--poll",
        "2",
        "legacy prompt",
      ]);

      expect(config.mode).toBe("code");
      expect(config.title).toBe("Legacy title");
      expect(config.cardId).toBe("execute-subtask");
      expect(config.beadId).toBe("repomap-core-123");
      expect(config.quiet).toBe(true);
      expect(config.jsonOutput).toBe(true);
      expect(config.noMonitor).toBe(true);
      expect(config.maxWait).toBe(45);
      expect(config.pollInterval).toBe(2);
      expect(config.promptArg).toBe("legacy prompt");
      expect(config.formula).toBe("");
    });

    it("accepts prompt without formula for legacy dispatch", () => {
      const config = parseArgs(["node", "script", "prompt only"]);
      expect(config.promptArg).toBe("prompt only");
      expect(config.formula).toBe("");
    });

    it("accepts both formula and prompt, preserving both values", () => {
      const config = parseArgs([
        "node",
        "script",
        "--formula",
        "my-formula",
        "fallback prompt",
      ]);
      expect(config.formula).toBe("my-formula");
      expect(config.promptArg).toBe("fallback prompt");
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
      const mockFetch = vi.fn(async (url: FetchInput) => {
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

      const mockFetch = vi.fn(async (url: FetchInput) => {
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
      const mockFetch = vi.fn(async (url: FetchInput) => {
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

  describe("isPm2AppOnline", () => {
    it("returns false when PM2 connection fails", async () => {
      vi.spyOn(pm2Client, "withPm2Connection").mockRejectedValue(new Error("pm2 daemon unreachable"));

      await expect(isPm2AppOnline("pm2", "oc-daemon")).resolves.toBe(false);
    });
  });

  describe("runSingleDispatch", () => {
    it("runs single-session lifecycle with mocked fetch dependencies", async () => {
      const config = makeTestConfig({
        promptArg: "Run diagnostic",
        noMonitor: true,
        host: "127.0.0.1",
        doltPort: 1,
      });
      const log = vi.fn();

      const mockFetch = vi.fn(async (input: FetchInput, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/session") && init?.method === "POST") {
          return mockFetchResponse({ id: "sess-single-1" });
        }
        if (url.includes("/prompt_async") && init?.method === "POST") {
          return new Response("", { status: 202 });
        }
        return new Response("Not found", { status: 404 });
      });

      const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        const code = await runSingleDispatch({
          config,
          baseUrl: "http://localhost:4096",
          log,
          fetchFn: mockFetch,
        });

        expect(code).toBe(ExitCode.SUCCESS);
        expect(mockFetch).toHaveBeenCalledTimes(2);
        const [, dispatchInit] = mockFetch.mock.calls[1] as [FetchInput, RequestInit];
        const payload = JSON.parse((dispatchInit.body as string) || "{}") as PromptPayload;
        expect(payload.parts[0].text).toContain("SESSION_ID: sess-single-1");
      } finally {
        stdoutSpy.mockRestore();
      }
    });

    it("keeps legacy DispatchResult JSON shape for monitored single dispatch", async () => {
      const config = makeTestConfig({
        promptArg: "Run diagnostic",
        noMonitor: false,
        jsonOutput: true,
        mode: "code",
        cardId: "",
      });
      const log = vi.fn();

      const mockFetch = vi.fn(async (input: FetchInput, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/session") && init?.method === "POST") {
          return mockFetchResponse({ id: "sess-single-2" });
        }
        if (url.includes("/prompt_async") && init?.method === "POST") {
          return new Response("", { status: 202 });
        }
        if (url.includes("/children")) {
          return mockFetchResponse([]);
        }
        if (url.includes("/message")) {
          return mockFetchResponse([
            {
              info: { role: "assistant" },
              parts: [
                { type: "step-finish", reason: "end_turn" },
                { type: "text", text: "Legacy output" },
              ],
            },
          ]);
        }
        return new Response("Not found", { status: 404 });
      });

      const stdoutChunks: string[] = [];
      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk: string | Uint8Array) => {
          stdoutChunks.push(String(chunk));
          return true;
        });
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      try {
        const code = await runSingleDispatch({
          config,
          baseUrl: "http://localhost:4096",
          log,
          fetchFn: mockFetch,
        });

        expect(code).toBe(ExitCode.SUCCESS);
        const output = JSON.parse(stdoutChunks.join("")) as Record<string, unknown>;
        expect(output).toMatchObject({
          session_id: "sess-single-2",
          mode: "code",
          title: expect.any(String),
          children: 0,
          elapsed_seconds: expect.any(Number),
          result: "Legacy output",
          child_session_ids: [],
        });
        expect(output).toHaveProperty("session_id");
        expect(output).toHaveProperty("mode");
        expect(output).toHaveProperty("title");
        expect(output).toHaveProperty("children");
        expect(output).toHaveProperty("elapsed_seconds");
        expect(output).toHaveProperty("result");
        expect(output).toHaveProperty("child_session_ids");
      } finally {
        stdoutSpy.mockRestore();
        stderrSpy.mockRestore();
      }
    });
  });

  describe("runDispatch", () => {
    it("uses single-dispatch path when formula is empty", async () => {
      const stack = await startHealthyStack();
      const config = makeTestConfig({
        promptArg: "legacy prompt",
        mode: "code",
        formula: "",
        doltPort: stack.doltPort,
        temporalPort: stack.temporalPort,
      });
      const execBdFn = vi.fn();
      const runSingleDispatchFn = vi.fn().mockResolvedValue(ExitCode.SUCCESS);

      try {
        const code = await runDispatch(config, stack.mockFetch, {
          execBdFn,
          runSingleDispatchFn,
        });

        expect(code).toBe(ExitCode.SUCCESS);
        expect(execBdFn).not.toHaveBeenCalled();
        expect(runSingleDispatchFn).toHaveBeenCalledTimes(1);

        const [call] = runSingleDispatchFn.mock.calls[0] as Array<[{ config: FactoryDispatchConfig; baseUrl: string }]>;
        expect(call.config.promptArg).toBe("legacy prompt");
        expect(call.baseUrl).toBe(`http://${config.host}:${config.port}`);
      } finally {
        await stack.cleanup();
      }
    });

    it("takes formula branch, supports label overrides, and writes molecule JSON summary", async () => {
      const stack = await startHealthyStack();
      const config = moleculeTestConfig(stack, {
        formula: "demo-formula",
        promptArg: "legacy prompt should be ignored",
        mode: "code",
        cardId: "default-card",
      });
      const execBdFn = mockBdPipeline({
        protoId: "proto-123",
        moleculeId: "mol-123",
        steps: [
          { id: "bead-1", title: "Step one", description: "First prompt", labels: ["mode:architect", "card:execute-subtask", "phase:1"] },
          { id: "bead-parent", title: "Parent only", description: "Parent work", labels: ["action:parent", "phase:2"] },
          { id: "bead-2", title: "Step two", description: "Second prompt", labels: ["phase:3"] },
        ],
      });

      const runSingleDispatchFn = vi
        .fn()
        .mockResolvedValueOnce({
          code: ExitCode.SUCCESS,
          session_id: "sess-1",
          result: "first done",
          elapsed_seconds: 3,
        })
        .mockResolvedValueOnce({
          code: ExitCode.SUCCESS,
          session_id: "sess-2",
          result: "second done",
          elapsed_seconds: 5,
        });

      const stdout = captureStdout();

      try {
        const code = await runDispatch(config, stack.mockFetch, {
          execBdFn,
          runSingleDispatchFn,
        });

        expect(code).toBe(ExitCode.SUCCESS);
        expect(execBdFn).toHaveBeenNthCalledWith(1, ["cook", "demo-formula", "--json"]);
        expect(execBdFn).toHaveBeenNthCalledWith(2, [
          "cook",
          "demo-formula",
          "--persist",
          "--force",
          "--json",
        ]);
        expect(execBdFn).toHaveBeenNthCalledWith(3, ["mol", "pour", "proto-123", "--json"]);
        expect(execBdFn).toHaveBeenNthCalledWith(4, ["mol", "show", "mol-123", "--json"]);
        expect(runSingleDispatchFn).toHaveBeenCalledTimes(2);

        const [firstCall] = runSingleDispatchFn.mock.calls[0] as Array<{
          config: FactoryDispatchConfig;
          suppressOutput?: boolean;
        }>;
        expect(firstCall.config.mode).toBe("architect");
        expect(firstCall.config.cardId).toBe("execute-subtask");
        expect(firstCall.config.promptArg).toBe("First prompt");
        expect(firstCall.suppressOutput).toBe(true);

        const [secondCall] = runSingleDispatchFn.mock.calls[1] as Array<{
          config: FactoryDispatchConfig;
          suppressOutput?: boolean;
        }>;
        expect(secondCall.config.mode).toBe("code");
        expect(secondCall.config.cardId).toBe("default-card");
        expect(secondCall.config.promptArg).toBe("Second prompt");
        expect(secondCall.suppressOutput).toBe(true);

        const output = stdout.json();

        expect(output.total_steps).toBe(3);
        expect(output.dispatched_steps).toBe(2);
        expect(output.skipped_steps).toBe(1);
        expect(output.failed_steps).toBe(0);

        const dispatched = output.steps.find((step) => step.step_id === "bead-1");
        expect(dispatched).toMatchObject({
          step_id: "bead-1",
          bead_id: "bead-1",
          mode: "architect",
          card: "execute-subtask",
          status: "completed",
          session_id: "sess-1",
          result: "first done",
          elapsed_seconds: 3,
        });
      } finally {
        stdout.spy.mockRestore();
        await stack.cleanup();
      }
    });

    it("marks parent-only-only formulas as skipped with zero dispatches", async () => {
      const stack = await startHealthyStack();
      const config = moleculeTestConfig(stack, {
        formula: "demo-formula",
        mode: "code",
        cardId: "default-card",
      });
      const execBdFn = mockBdPipeline({
        protoId: "proto-123",
        moleculeId: "mol-123",
        steps: [
          { id: "bead-parent-1", title: "Parent one", description: "P1", labels: ["action:parent"] },
          { id: "bead-parent-2", title: "Parent two", description: "P2", labels: ["action:parent", "card:decompose-epic"] },
        ],
      });
      const runSingleDispatchFn = vi.fn();

      const stdout = captureStdout();

      try {
        const code = await runDispatch(config, stack.mockFetch, {
          execBdFn,
          runSingleDispatchFn,
        });

        expect(code).toBe(ExitCode.SUCCESS);
        expect(runSingleDispatchFn).not.toHaveBeenCalled();

        const output = stdout.json();
        expect(output.total_steps).toBe(2);
        expect(output.dispatched_steps).toBe(0);
        expect(output.skipped_steps).toBe(2);
        expect(output.failed_steps).toBe(0);
        expect(output.steps.every((step) => step.status === "skipped")).toBe(true);
      } finally {
        stdout.spy.mockRestore();
        await stack.cleanup();
      }
    });

    it("continues after step failure and returns GENERAL_ERROR for mixed outcomes", async () => {
      const stack = await startHealthyStack();
      const config = moleculeTestConfig(stack, { formula: "demo-formula" });
      const execBdFn = mockBdPipeline({
        protoId: "proto-123",
        moleculeId: "mol-123",
        steps: [
          { id: "bead-ok", title: "Ok", description: "one", labels: [] },
          { id: "bead-bad", title: "Bad", description: "two", labels: [] },
        ],
      });
      const runSingleDispatchFn = vi
        .fn()
        .mockResolvedValueOnce({ code: ExitCode.SUCCESS, session_id: "sess-ok", result: "ok", elapsed_seconds: 1 })
        .mockResolvedValueOnce(ExitCode.PROMPT_DISPATCH_FAILED);

      const stdout = captureStdout();

      try {
        const code = await runDispatch(config, stack.mockFetch, {
          execBdFn,
          runSingleDispatchFn,
        });

        expect(code).toBe(ExitCode.GENERAL_ERROR);

        const output = stdout.json();
        expect(output.dispatched_steps).toBe(1);
        expect(output.failed_steps).toBe(1);
        expect(output.steps.find((step) => step.step_id === "bead-ok")?.status).toBe("completed");
        expect(output.steps.find((step) => step.step_id === "bead-bad")?.status).toBe("failed");
      } finally {
        stdout.spy.mockRestore();
        await stack.cleanup();
      }
    });

    it("returns GENERAL_ERROR when bd cook fails", async () => {
      const stack = await startHealthyStack();
      const config = makeTestConfig({
        formula: "demo-formula",
        promptArg: "",
        doltPort: stack.doltPort,
        temporalPort: stack.temporalPort,
      });
      const execBdFn = vi.fn().mockRejectedValue(new Error("cook failed"));
      const runSingleDispatchFn = vi.fn();
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      try {
        const code = await runDispatch(config, stack.mockFetch, {
          execBdFn,
          runSingleDispatchFn,
        });
        expect(code).toBe(ExitCode.GENERAL_ERROR);
        expect(runSingleDispatchFn).not.toHaveBeenCalled();
      } finally {
        stderrSpy.mockRestore();
        await stack.cleanup();
      }
    });

    it("returns GENERAL_ERROR when bd mol pour fails", async () => {
      const stack = await startHealthyStack();
      const config = makeTestConfig({
        formula: "demo-formula",
        promptArg: "",
        doltPort: stack.doltPort,
        temporalPort: stack.temporalPort,
      });
      const execBdFn = vi
        .fn()
        .mockResolvedValueOnce({ id: "proto-123" })
        .mockRejectedValueOnce(new Error("pour failed"));
      const runSingleDispatchFn = vi.fn();
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      try {
        const code = await runDispatch(config, stack.mockFetch, {
          execBdFn,
          runSingleDispatchFn,
        });
        expect(code).toBe(ExitCode.GENERAL_ERROR);
        expect(runSingleDispatchFn).not.toHaveBeenCalled();
      } finally {
        stderrSpy.mockRestore();
        await stack.cleanup();
      }
    });

    it("returns GENERAL_ERROR when bd mol show output is malformed", async () => {
      const stack = await startHealthyStack();
      const config = makeTestConfig({
        formula: "demo-formula",
        promptArg: "",
        doltPort: stack.doltPort,
        temporalPort: stack.temporalPort,
      });
      const execBdFn = vi
        .fn()
        .mockResolvedValueOnce({ id: "proto-123" })
        .mockResolvedValueOnce({ id: "proto-123" })
        .mockResolvedValueOnce({ molecule_id: "mol-123" })
        .mockResolvedValueOnce("not-json");
      const runSingleDispatchFn = vi.fn();
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      try {
        const code = await runDispatch(config, stack.mockFetch, {
          execBdFn,
          runSingleDispatchFn,
        });
        expect(code).toBe(ExitCode.GENERAL_ERROR);
        expect(runSingleDispatchFn).not.toHaveBeenCalled();
      } finally {
        stderrSpy.mockRestore();
        await stack.cleanup();
      }
    });

    it("returns GENERAL_ERROR when all dispatched molecule steps fail", async () => {
      const stack = await startHealthyStack();
      const config = moleculeTestConfig(stack, { formula: "demo-formula" });
      const execBdFn = mockBdPipeline({
        protoId: "proto-123",
        moleculeId: "mol-123",
        steps: [
          { id: "bead-1", title: "S1", description: "Prompt 1", labels: [] },
          { id: "bead-2", title: "S2", description: "Prompt 2", labels: [] },
        ],
      });
      const runSingleDispatchFn = vi
        .fn()
        .mockResolvedValueOnce(ExitCode.PROMPT_DISPATCH_FAILED)
        .mockResolvedValueOnce(ExitCode.TIMEOUT);

      const stdout = captureStdout();
      try {
        const code = await runDispatch(config, stack.mockFetch, {
          execBdFn,
          runSingleDispatchFn,
        });
        expect(code).toBe(ExitCode.GENERAL_ERROR);
      } finally {
        stdout.spy.mockRestore();
        await stack.cleanup();
      }
    });

    it("passes vars through cook/pour commands for empty and multi-var cases", async () => {
      const stack = await startHealthyStack();
      const execBdEmptyVars = mockBdPipeline({
        protoId: "proto-empty",
        moleculeId: "mol-empty",
        steps: [],
      });
      const runSingleDispatchFn = vi.fn();

      const stdout = captureStdout();
      try {
        await runDispatch(
          moleculeTestConfig(stack, { formula: "demo-formula", vars: [] }),
          stack.mockFetch,
          { execBdFn: execBdEmptyVars, runSingleDispatchFn },
        );
        expect(execBdEmptyVars).toHaveBeenNthCalledWith(1, ["cook", "demo-formula", "--json"]);
        expect(execBdEmptyVars).toHaveBeenNthCalledWith(2, [
          "cook",
          "demo-formula",
          "--persist",
          "--force",
          "--json",
        ]);
        expect(execBdEmptyVars).toHaveBeenNthCalledWith(3, ["mol", "pour", "proto-empty", "--json"]);

        const execBdWithVars = mockBdPipeline({
          protoId: "proto-vars",
          moleculeId: "mol-vars",
          steps: [],
        });

        await runDispatch(
          moleculeTestConfig(stack, { formula: "demo-formula", vars: ["foo=bar", "baz=qux"] }),
          stack.mockFetch,
          { execBdFn: execBdWithVars, runSingleDispatchFn },
        );
        expect(execBdWithVars).toHaveBeenNthCalledWith(1, [
          "cook",
          "demo-formula",
          "--var",
          "foo=bar",
          "--var",
          "baz=qux",
          "--json",
        ]);
        expect(execBdWithVars).toHaveBeenNthCalledWith(2, [
          "cook",
          "demo-formula",
          "--persist",
          "--force",
          "--var",
          "foo=bar",
          "--var",
          "baz=qux",
          "--json",
        ]);
        expect(execBdWithVars).toHaveBeenNthCalledWith(3, [
          "mol",
          "pour",
          "proto-vars",
          "--var",
          "foo=bar",
          "--var",
          "baz=qux",
          "--json",
        ]);
      } finally {
        stdout.spy.mockRestore();
        await stack.cleanup();
      }
    });
  });

  describe("molecule helpers", () => {
    it("parseLabelValue extracts prefixed values", () => {
      const labels = ["mode:architect", "card:explore-phase", "phase:1"];
      expect(parseLabelValue(labels, "mode")).toBe("architect");
      expect(parseLabelValue(labels, "card")).toBe("explore-phase");
      expect(parseLabelValue(labels, "missing")).toBeUndefined();
    });

    it("isParentOnlyStep recognizes action:parent", () => {
      expect(isParentOnlyStep(["action:parent", "phase:1"])).toBe(true);
      expect(isParentOnlyStep(["mode:architect"])).toBe(false);
    });

    it("extractStepConfig parses mode/card/parent flags", () => {
      expect(extractStepConfig(["mode:architect", "card:discover-phase", "action:parent"]))
        .toEqual({ mode: "architect", card: "discover-phase", isParent: true });
      expect(extractStepConfig(["phase:1"]))
        .toEqual({ mode: undefined, card: undefined, isParent: false });
    });

    it("buildCookCommand builds args with vars and json", () => {
      expect(buildCookCommand("demo-formula", ["foo=bar", "baz=qux"]))
        .toEqual(["cook", "demo-formula", "--var", "foo=bar", "--var", "baz=qux", "--json"]);
      expect(buildCookCommand("demo-formula", ["foo=bar"], true))
        .toEqual(["cook", "demo-formula", "--persist", "--force", "--var", "foo=bar", "--json"]);
      expect(buildCookCommand("demo-formula", []))
        .toEqual(["cook", "demo-formula", "--json"]);
    });

    it("buildPourCommand builds args with vars and json", () => {
      expect(buildPourCommand("proto-123", ["foo=bar"]))
        .toEqual(["mol", "pour", "proto-123", "--var", "foo=bar", "--json"]);
      expect(buildPourCommand("proto-123", []))
        .toEqual(["mol", "pour", "proto-123", "--json"]);
    });
  });

  describe("ExitCode", () => {
    it("has the correct values matching the shell script", () => {
      expect(ExitCode.SUCCESS).toBe(0);
      expect(ExitCode.GENERAL_ERROR).toBe(1);
      expect(ExitCode.USAGE_ERROR).toBe(1);
      expect(ExitCode.HEALTH_CHECK_FAILED).toBe(2);
      expect(ExitCode.SESSION_CREATION_FAILED).toBe(3);
      expect(ExitCode.PROMPT_DISPATCH_FAILED).toBe(4);
      expect(ExitCode.TIMEOUT).toBe(5);
      expect(ExitCode.NO_RESPONSE).toBe(6);
    });
  });
});
