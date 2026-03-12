/**
 * Tests for Stack Manager — TypeScript logic module.
 *
 * These tests verify the core logic by mocking external dependencies
 * (fetch, port checks, pm2, child_process). No running stack is required.
 *
 * See: repomap-core-76q.2
 */

import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:net";
import {
  type StackConfig,
  type StackHealth,
  defaultConfig,
  checkKiloHealth,
  checkDoltComponent,
  checkOcDaemon,
  checkTemporalServer,
  checkTemporalWorker,
  checkStack,
  findTemporalCli,
} from "../src/infra/stack-manager.js";

// ── Helpers ──────────────────────────────────────────────────────────────

function makeTestConfig(overrides: Partial<StackConfig> = {}): StackConfig {
  return {
    ...defaultConfig(),
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

describe("StackManager", () => {
  describe("defaultConfig", () => {
    it("returns a config with expected defaults", () => {
      const config = defaultConfig();
      expect(config.kiloHost).toBe("127.0.0.1");
      expect(config.kiloPort).toBe(4096);
      expect(config.doltPort).toBe(3307);
      expect(config.temporalPort).toBe(7233);
      expect(config.temporalUiPort).toBe(8233);
      expect(config.manageKilo).toBe(false);
      expect(config.pm2Bin).toContain("pm2");
      expect(config.ecosystemConfig).toContain("ecosystem.config.cjs");
      expect(config.daemonDir).toContain("daemon");
    });
  });

  describe("checkKiloHealth", () => {
    it("returns healthy when fetch succeeds with valid JSON", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        mockFetchResponse([{ id: "sess-1" }, { id: "sess-2" }]),
      );
      const result = await checkKiloHealth("127.0.0.1", 4096, mockFetch);
      expect(result.name).toBe("kilo serve");
      expect(result.ok).toBe(true);
      expect(result.detail).toContain("2 sessions");
    });

    it("returns unhealthy when fetch returns non-ok status", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response("Not found", { status: 404 }),
      );
      const result = await checkKiloHealth("127.0.0.1", 4096, mockFetch);
      expect(result.ok).toBe(false);
      expect(result.detail).toContain("HTTP 404");
    });

    it("returns unhealthy when fetch throws (server unreachable)", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      const result = await checkKiloHealth("127.0.0.1", 4096, mockFetch);
      expect(result.ok).toBe(false);
      expect(result.detail).toContain("NOT reachable");
    });

    it("returns healthy with zero sessions", async () => {
      const mockFetch = vi.fn().mockResolvedValue(mockFetchResponse([]));
      const result = await checkKiloHealth("127.0.0.1", 4096, mockFetch);
      expect(result.ok).toBe(true);
      expect(result.detail).toContain("0 sessions");
    });
  });

  describe("checkDoltComponent", () => {
    it("returns unhealthy when Dolt server is down (unreachable port)", async () => {
      // Use a port that's definitely not listening for Dolt
      const config = makeTestConfig({
        doltPort: 19876,
        doltConfig: {
          ...defaultConfig().doltConfig,
          port: 19876,
        },
      });
      const result = await checkDoltComponent(config);
      expect(result.name).toBe("Dolt server");
      expect(result.ok).toBe(false);
      expect(result.detail).toContain("NOT running");
    });
  });

  describe("checkOcDaemon", () => {
    it("returns unhealthy when pm2 binary not found", () => {
      // Use a non-existent pm2 binary
      const result = checkOcDaemon("/nonexistent/pm2");
      expect(result.name).toBe("oc-daemon");
      expect(result.ok).toBe(false);
      expect(result.detail).toContain("NOT running");
    });
  });

  describe("checkTemporalServer", () => {
    it("returns healthy when port is listening", async () => {
      const server = createServer();
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;

      try {
        const result = await checkTemporalServer("127.0.0.1", port);
        expect(result.name).toBe("Temporal server");
        expect(result.ok).toBe(true);
        expect(result.detail).toContain(String(port));
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("returns unhealthy when port is not listening", async () => {
      const result = await checkTemporalServer("127.0.0.1", 19877);
      expect(result.ok).toBe(false);
      expect(result.detail).toContain("NOT listening");
    });
  });

  describe("checkTemporalWorker", () => {
    it("returns unhealthy when pm2 binary not found", () => {
      const result = checkTemporalWorker("/nonexistent/pm2");
      expect(result.name).toBe("Temporal worker");
      expect(result.ok).toBe(false);
      expect(result.detail).toContain("NOT running");
    });
  });

  describe("checkStack", () => {
    it("returns structured health report with all 5 components", async () => {
      // Mock fetch to simulate kilo serve being down
      const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

      const config = makeTestConfig({
        kiloPort: 19878,
        doltPort: 19879,
        temporalPort: 19880,
        pm2Bin: "/nonexistent/pm2",
        doltConfig: {
          ...defaultConfig().doltConfig,
          port: 19879,
        },
      });

      const health = await checkStack(config, mockFetch);

      expect(health.total).toBe(5);
      expect(health.components).toHaveLength(5);
      expect(health.ok).toBe(false);
      expect(health.healthy).toBe(0);

      // Verify component names
      const names = health.components.map((c) => c.name);
      expect(names).toContain("kilo serve");
      expect(names).toContain("Dolt server");
      expect(names).toContain("oc-daemon");
      expect(names).toContain("Temporal server");
      expect(names).toContain("Temporal worker");
    });

    it("includes detail strings for each component", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("fail"));
      const config = makeTestConfig({
        kiloPort: 19881,
        doltPort: 19882,
        temporalPort: 19883,
        pm2Bin: "/nonexistent/pm2",
        doltConfig: {
          ...defaultConfig().doltConfig,
          port: 19882,
        },
      });

      const health = await checkStack(config, mockFetch);

      for (const c of health.components) {
        expect(typeof c.detail).toBe("string");
        expect(c.detail.length).toBeGreaterThan(0);
      }
    });

    it("correctly counts healthy components", async () => {
      // Start a TCP server to simulate Temporal
      const server = createServer();
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;

      try {
        const mockFetch = vi.fn().mockRejectedValue(new Error("fail"));
        const config = makeTestConfig({
          kiloPort: 19884,
          doltPort: 19885,
          temporalPort: port,
          pm2Bin: "/nonexistent/pm2",
          doltConfig: {
            ...defaultConfig().doltConfig,
            port: 19885,
          },
        });

        const health = await checkStack(config, mockFetch);

        // Only Temporal server should be healthy (the TCP server we started)
        expect(health.healthy).toBe(1);
        const temporal = health.components.find((c) => c.name === "Temporal server");
        expect(temporal?.ok).toBe(true);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  describe("findTemporalCli", () => {
    it("returns a string or null", () => {
      const result = findTemporalCli();
      if (result !== null) {
        expect(typeof result).toBe("string");
        expect(result.length).toBeGreaterThan(0);
      }
      // If result is null, we've already validated the contract:
      // findTemporalCli returns string | null
      expect(result === null || typeof result === "string").toBe(true);
    });
  });

  describe("StackHealth type shape", () => {
    it("has correct shape for all-down stack", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("down"));
      const config = makeTestConfig({
        kiloPort: 19886,
        doltPort: 19887,
        temporalPort: 19888,
        pm2Bin: "/nonexistent/pm2",
        doltConfig: {
          ...defaultConfig().doltConfig,
          port: 19887,
        },
      });

      const health = await checkStack(config, mockFetch);

      // Verify the shape matches the StackHealth interface
      expect(typeof health.ok).toBe("boolean");
      expect(typeof health.healthy).toBe("number");
      expect(typeof health.total).toBe("number");
      expect(Array.isArray(health.components)).toBe(true);

      for (const c of health.components) {
        expect(typeof c.name).toBe("string");
        expect(typeof c.ok).toBe("boolean");
        expect(typeof c.detail).toBe("string");
      }
    });

    it("can be serialized to JSON", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("down"));
      const config = makeTestConfig({
        kiloPort: 19889,
        doltPort: 19890,
        temporalPort: 19891,
        pm2Bin: "/nonexistent/pm2",
        doltConfig: {
          ...defaultConfig().doltConfig,
          port: 19890,
        },
      });

      const health = await checkStack(config, mockFetch);
      const json = JSON.stringify(health);
      const parsed = JSON.parse(json) as StackHealth;

      expect(parsed.total).toBe(5);
      expect(parsed.components).toHaveLength(5);
    });
  });
});
