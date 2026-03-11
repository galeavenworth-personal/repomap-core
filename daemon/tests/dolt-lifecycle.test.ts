/**
 * Tests for Dolt server lifecycle management.
 *
 * These tests verify the core logic without requiring a running Dolt server.
 * Integration tests that actually start/stop servers are marked with .skip
 * and can be enabled manually.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  type DoltLifecycleConfig,
  defaultConfig,
  clearBdStateFiles,
  queryServerDatabases,
  checkServerHealth,
  getProcessCwd,
} from "../src/infra/dolt-lifecycle.js";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeTestConfig(overrides: Partial<DoltLifecycleConfig> = {}): DoltLifecycleConfig {
  return {
    ...defaultConfig(),
    ...overrides,
  };
}

describe("DoltLifecycle", () => {
  describe("defaultConfig", () => {
    it("returns a config with required fields", () => {
      const config = defaultConfig();
      expect(config.host).toBe("127.0.0.1");
      expect(config.port).toBe(3307);
      expect(config.user).toBe("root");
      expect(config.password).toBe("");
      expect(config.requiredDatabases).toContain("beads_repomap-core");
      expect(config.requiredDatabases).toContain("punch_cards");
      expect(config.dataDir).toMatch(/\.dolt-data\/beads$/);
    });
  });

  describe("clearBdStateFiles", () => {
    const testDir = join(tmpdir(), `dolt-lifecycle-test-${Date.now()}`);
    const beadsDir = join(testDir, ".beads");

    beforeEach(() => {
      mkdirSync(beadsDir, { recursive: true });
      // Create some state files
      writeFileSync(join(beadsDir, "dolt-server.port"), "13396");
      writeFileSync(join(beadsDir, "dolt-server.pid"), "12345");
      writeFileSync(join(beadsDir, "dolt-server.lock"), "");
      writeFileSync(join(beadsDir, "dolt-monitor.pid"), "12346");
    });

    afterEach(() => {
      rmSync(testDir, { recursive: true, force: true });
    });

    it("removes all bd state files", () => {
      const config = makeTestConfig({ beadsDirs: [beadsDir] });
      const cleared = clearBdStateFiles(config);

      expect(cleared).toBe(4);
      expect(existsSync(join(beadsDir, "dolt-server.port"))).toBe(false);
      expect(existsSync(join(beadsDir, "dolt-server.pid"))).toBe(false);
      expect(existsSync(join(beadsDir, "dolt-server.lock"))).toBe(false);
      expect(existsSync(join(beadsDir, "dolt-monitor.pid"))).toBe(false);
    });

    it("returns 0 when no state files exist", () => {
      // Clean up first
      rmSync(beadsDir, { recursive: true, force: true });
      mkdirSync(beadsDir, { recursive: true });

      const config = makeTestConfig({ beadsDirs: [beadsDir] });
      const cleared = clearBdStateFiles(config);
      expect(cleared).toBe(0);
    });

    it("skips non-existent beads directories", () => {
      const config = makeTestConfig({
        beadsDirs: ["/nonexistent/path/.beads"],
      });
      const cleared = clearBdStateFiles(config);
      expect(cleared).toBe(0);
    });
  });

  describe("queryServerDatabases", () => {
    it("returns null when server is unreachable", async () => {
      const config = makeTestConfig({ port: 19999 }); // unlikely to have a server
      const result = await queryServerDatabases(config, 1000);
      expect(result).toBeNull();
    });

    // This test requires a running Dolt server
    it.skipIf(!process.env.DOLT_LIVE)(
      "returns databases from a live server",
      async () => {
        const config = makeTestConfig();
        const result = await queryServerDatabases(config);
        expect(result).not.toBeNull();
        expect(result).toContain("beads_repomap-core");
        expect(result).toContain("punch_cards");
      },
    );
  });

  describe("checkServerHealth", () => {
    it("returns 'down' when no server is running", async () => {
      const config = makeTestConfig({ port: 19999 });
      const status = await checkServerHealth(config);
      expect(status.state).toBe("down");
    });

    // This test requires a running Dolt server
    it.skipIf(!process.env.DOLT_LIVE)(
      "returns 'healthy' for a correctly configured server",
      async () => {
        const config = makeTestConfig();
        const status = await checkServerHealth(config);
        expect(status.state).toBe("healthy");
        if (status.state === "healthy") {
          expect(status.databases).toContain("beads_repomap-core");
          expect(status.databases).toContain("punch_cards");
        }
      },
    );
  });

  describe("getProcessCwd", () => {
    it("returns cwd for the current process", () => {
      const cwd = getProcessCwd(process.pid);
      // May be null on non-Linux or permission issues, but on Linux should work
      if (cwd !== null) {
        expect(typeof cwd).toBe("string");
        expect(cwd.length).toBeGreaterThan(0);
      }
    });

    it("returns null for non-existent PID", () => {
      const cwd = getProcessCwd(999999);
      expect(cwd).toBeNull();
    });
  });
});
