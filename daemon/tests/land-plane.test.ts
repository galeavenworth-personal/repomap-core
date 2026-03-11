/**
 * Tests for land-plane Beads issue completion orchestrator.
 *
 * These tests verify the core logic by mocking subprocess calls and
 * filesystem access. No actual gates, bd commands, or JSONL files are
 * needed.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import type {
  LandPlaneConfig,
  GateRunRecord,
} from "../src/infra/land-plane.js";
import {
  defaultConfig,
  verifyAuditProof,
  runGate,
  runGates,
  closeBead,
  syncBeads,
  landPlane,
} from "../src/infra/land-plane.js";

// ── Helpers ──────────────────────────────────────────────────────────────

function makeTestDir(): string {
  return mkdtempSync(join(tmpdir(), "land-plane-test-"));
}

function makeTestConfig(testDir: string, overrides: Partial<LandPlaneConfig> = {}): LandPlaneConfig {
  return {
    ...defaultConfig(testDir),
    ...overrides,
  };
}

function writeAuditLog(testDir: string, records: Partial<GateRunRecord>[]): string {
  const auditDir = join(testDir, ".kilocode");
  mkdirSync(auditDir, { recursive: true });
  const auditPath = join(auditDir, "gate_runs.jsonl");
  const content = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(auditPath, content);
  return auditPath;
}

const BEAD_ID = "test-bead-123";
const RUN_TS = "2026-03-11T12:00:00.000Z";
const REQUIRED_GATES = ["ruff-format", "ruff-check", "mypy-src", "pytest"];

function makePassRecords(beadId: string, runTs: string): Partial<GateRunRecord>[] {
  return REQUIRED_GATES.map((gateId) => ({
    schema_version: "gate_run.v1",
    bead_id: beadId,
    run_timestamp: runTs,
    gate_id: gateId,
    status: "pass",
    exit_code: 0,
    elapsed_seconds: 0.1,
    invocation: `python -m ${gateId}`,
    stop_reason: null,
  }));
}

// Suppress log output in tests
const noop = () => {};

// ── Tests ────────────────────────────────────────────────────────────────

describe("LandPlane", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe("defaultConfig", () => {
    it("returns a config with required fields", () => {
      const config = defaultConfig(testDir);
      expect(config.rootDir).toBe(testDir);
      expect(config.bdBin).toContain(".kilocode/tools/bd");
      expect(config.boundedGatePy).toContain("bounded_gate.py");
      expect(config.pythonBin).toContain(".venv/bin/python");
      expect(config.auditLogPath).toContain("gate_runs.jsonl");
      expect(config.gates).toHaveLength(4);
      expect(config.requiredGateIds).toEqual(REQUIRED_GATES);
    });

    it("configures all 4 canonical gates", () => {
      const config = defaultConfig(testDir);
      const gateIds = config.gates.map((g) => g.gateId);
      expect(gateIds).toEqual(["ruff-format", "ruff-check", "mypy-src", "pytest"]);
    });

    it("sets bounded budgets for each gate", () => {
      const config = defaultConfig(testDir);
      // ruff-format: 60s timeout, 30s stall
      expect(config.gates[0].timeoutSeconds).toBe(60);
      expect(config.gates[0].stallSeconds).toBe(30);
      // pytest: 180s timeout, 60s stall
      expect(config.gates[3].timeoutSeconds).toBe(180);
      expect(config.gates[3].stallSeconds).toBe(60);
    });
  });

  describe("verifyAuditProof", () => {
    it("returns ok=true when all required gates have PASS records", () => {
      const auditPath = writeAuditLog(testDir, makePassRecords(BEAD_ID, RUN_TS));
      const config = makeTestConfig(testDir, { auditLogPath: auditPath });

      const result = verifyAuditProof(BEAD_ID, RUN_TS, config, noop);

      expect(result.ok).toBe(true);
      expect(result.missingGates).toEqual([]);
    });

    it("returns ok=false when gate_runs.jsonl does not exist", () => {
      const config = makeTestConfig(testDir, {
        auditLogPath: join(testDir, "nonexistent.jsonl"),
      });

      const result = verifyAuditProof(BEAD_ID, RUN_TS, config, noop);

      expect(result.ok).toBe(false);
      expect(result.missingGates).toEqual(REQUIRED_GATES);
    });

    it("returns ok=false when some gates are missing", () => {
      // Only write records for ruff-format and ruff-check
      const partialRecords = makePassRecords(BEAD_ID, RUN_TS).slice(0, 2);
      const auditPath = writeAuditLog(testDir, partialRecords);
      const config = makeTestConfig(testDir, { auditLogPath: auditPath });

      const result = verifyAuditProof(BEAD_ID, RUN_TS, config, noop);

      expect(result.ok).toBe(false);
      expect(result.missingGates).toContain("mypy-src");
      expect(result.missingGates).toContain("pytest");
      expect(result.missingGates).not.toContain("ruff-format");
      expect(result.missingGates).not.toContain("ruff-check");
    });

    it("ignores records with wrong bead_id", () => {
      const auditPath = writeAuditLog(testDir, makePassRecords("wrong-bead", RUN_TS));
      const config = makeTestConfig(testDir, { auditLogPath: auditPath });

      const result = verifyAuditProof(BEAD_ID, RUN_TS, config, noop);

      expect(result.ok).toBe(false);
      expect(result.missingGates.sort()).toEqual([...REQUIRED_GATES].sort());
    });

    it("ignores records with wrong run_timestamp", () => {
      const auditPath = writeAuditLog(testDir, makePassRecords(BEAD_ID, "2026-01-01T00:00:00.000Z"));
      const config = makeTestConfig(testDir, { auditLogPath: auditPath });

      const result = verifyAuditProof(BEAD_ID, RUN_TS, config, noop);

      expect(result.ok).toBe(false);
      expect(result.missingGates.sort()).toEqual([...REQUIRED_GATES].sort());
    });

    it("ignores records with status != pass", () => {
      const failRecords = REQUIRED_GATES.map((gateId) => ({
        bead_id: BEAD_ID,
        run_timestamp: RUN_TS,
        gate_id: gateId,
        status: "fail",
        exit_code: 1,
      }));
      const auditPath = writeAuditLog(testDir, failRecords as Partial<GateRunRecord>[]);
      const config = makeTestConfig(testDir, { auditLogPath: auditPath });

      const result = verifyAuditProof(BEAD_ID, RUN_TS, config, noop);

      expect(result.ok).toBe(false);
      expect(result.missingGates.sort()).toEqual([...REQUIRED_GATES].sort());
    });

    it("handles malformed JSONL lines gracefully", () => {
      const auditDir = join(testDir, ".kilocode");
      mkdirSync(auditDir, { recursive: true });
      const auditPath = join(auditDir, "gate_runs.jsonl");
      const validRecords = makePassRecords(BEAD_ID, RUN_TS);
      const lines = [
        "not valid json",
        JSON.stringify(validRecords[0]),
        "",
        "{broken",
        JSON.stringify(validRecords[1]),
        JSON.stringify(validRecords[2]),
        JSON.stringify(validRecords[3]),
      ];
      writeFileSync(auditPath, lines.join("\n") + "\n");
      const config = makeTestConfig(testDir, { auditLogPath: auditPath });

      const result = verifyAuditProof(BEAD_ID, RUN_TS, config, noop);

      expect(result.ok).toBe(true);
      expect(result.missingGates).toEqual([]);
    });

    it("handles empty JSONL file", () => {
      const auditDir = join(testDir, ".kilocode");
      mkdirSync(auditDir, { recursive: true });
      const auditPath = join(auditDir, "gate_runs.jsonl");
      writeFileSync(auditPath, "\n");
      const config = makeTestConfig(testDir, { auditLogPath: auditPath });

      const result = verifyAuditProof(BEAD_ID, RUN_TS, config, noop);

      expect(result.ok).toBe(false);
      expect(result.missingGates.sort()).toEqual([...REQUIRED_GATES].sort());
    });
  });

  describe("runGate", () => {
    it("has correct gate definition structure for bounded_gate.py invocation", () => {
      const config = defaultConfig(testDir);
      const gate = config.gates[0]; // ruff-format
      expect(gate.gateId).toBe("ruff-format");
      expect(gate.timeoutSeconds).toBe(60);
      expect(gate.stallSeconds).toBe(30);
      expect(gate.command).toContain("ruff format --check");
    });
  });

  describe("runGates", () => {
    it("returns empty array with no gates configured", () => {
      const config = makeTestConfig(testDir, { gates: [] });

      // With no gates, runGates should return an empty array immediately
      // (no subprocess calls needed)
      const results = runGates(BEAD_ID, RUN_TS, config, noop);
      expect(results).toEqual([]);
    });
  });

  describe("closeBead", () => {
    it("is idempotent — always returns true", () => {
      // closeBead calls bd close with || true semantics
      // We verify the interface contract: it always returns true
      const config = makeTestConfig(testDir);
      // Note: This will fail to find bd binary in test, but closeBead
      // is designed to be idempotent and always return true
      const result = closeBead(BEAD_ID, config, noop);
      expect(result).toBe(true);
    });
  });

  describe("syncBeads", () => {
    it("returns false when bd binary is not found", () => {
      const config = makeTestConfig(testDir, {
        bdBin: join(testDir, "nonexistent-bd"),
      });
      const result = syncBeads(config, noop);
      expect(result).toBe(false);
    });
  });

  describe("landPlane orchestration", () => {
    it("returns exitCode=3 when audit proof is missing (skip-gates mode)", () => {
      // Create preflight script that succeeds
      const toolsDir = join(testDir, ".kilocode/tools");
      mkdirSync(toolsDir, { recursive: true });
      writeFileSync(join(toolsDir, "beads_preflight.sh"), "#!/bin/bash\necho OK\nexit 0\n", { mode: 0o755 });
      writeFileSync(join(toolsDir, "bd"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });

      const config = makeTestConfig(testDir);

      const result = landPlane(
        {
          beadId: BEAD_ID,
          skipGates: true,
          runTimestamp: RUN_TS,
          noSync: true,
        },
        config,
        noop,
      );

      // No gate_runs.jsonl exists, so audit proof is missing
      expect(result.exitCode).toBe(3);
      expect(result.summary).toContain("Audit proof missing");
    });

    it("returns exitCode=0 when skip-gates and audit proof exists", () => {
      // Create preflight script that succeeds
      const toolsDir = join(testDir, ".kilocode/tools");
      mkdirSync(toolsDir, { recursive: true });
      writeFileSync(join(toolsDir, "beads_preflight.sh"), "#!/bin/bash\necho OK\nexit 0\n", { mode: 0o755 });
      writeFileSync(join(toolsDir, "bd"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });

      // Write passing audit records
      const auditPath = writeAuditLog(testDir, makePassRecords(BEAD_ID, RUN_TS));
      const config = makeTestConfig(testDir, { auditLogPath: auditPath });

      const result = landPlane(
        {
          beadId: BEAD_ID,
          skipGates: true,
          runTimestamp: RUN_TS,
          noSync: true,
        },
        config,
        noop,
      );

      expect(result.exitCode).toBe(0);
      expect(result.summary).toContain("LAND PLANE SUMMARY");
      expect(result.summary).toContain("ALL PASS");
      expect(result.summary).toContain("sync: SKIPPED");
    });

    it("returns exitCode=2 when preflight fails", () => {
      // No preflight script exists
      const config = makeTestConfig(testDir);

      const result = landPlane(
        {
          beadId: BEAD_ID,
          skipGates: true,
          runTimestamp: RUN_TS,
          noSync: true,
        },
        config,
        noop,
      );

      expect(result.exitCode).toBe(2);
      expect(result.summary).toContain("Preflight");
    });

    it("returns exitCode=4 when sync fails", () => {
      // Create preflight that succeeds
      const toolsDir = join(testDir, ".kilocode/tools");
      mkdirSync(toolsDir, { recursive: true });
      writeFileSync(join(toolsDir, "beads_preflight.sh"), "#!/bin/bash\necho OK\nexit 0\n", { mode: 0o755 });
      // Create bd that fails on sync
      writeFileSync(join(toolsDir, "bd"), "#!/bin/bash\nif [ \"$1\" = \"close\" ]; then exit 0; fi\nexit 1\n", { mode: 0o755 });

      const auditPath = writeAuditLog(testDir, makePassRecords(BEAD_ID, RUN_TS));
      const config = makeTestConfig(testDir, { auditLogPath: auditPath });

      const result = landPlane(
        {
          beadId: BEAD_ID,
          skipGates: true,
          runTimestamp: RUN_TS,
          noSync: false,
        },
        config,
        noop,
      );

      expect(result.exitCode).toBe(4);
      expect(result.summary).toContain("bd sync failed");
    });

    it("includes correct sync status in summary", () => {
      const toolsDir = join(testDir, ".kilocode/tools");
      mkdirSync(toolsDir, { recursive: true });
      writeFileSync(join(toolsDir, "beads_preflight.sh"), "#!/bin/bash\necho OK\nexit 0\n", { mode: 0o755 });
      writeFileSync(join(toolsDir, "bd"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });

      const auditPath = writeAuditLog(testDir, makePassRecords(BEAD_ID, RUN_TS));
      const config = makeTestConfig(testDir, { auditLogPath: auditPath });

      // With sync enabled
      const resultWithSync = landPlane(
        { beadId: BEAD_ID, skipGates: true, runTimestamp: RUN_TS, noSync: false },
        config,
        noop,
      );
      expect(resultWithSync.exitCode).toBe(0);
      expect(resultWithSync.summary).toContain("sync: YES");

      // With sync disabled
      const resultNoSync = landPlane(
        { beadId: BEAD_ID, skipGates: true, runTimestamp: RUN_TS, noSync: true },
        config,
        noop,
      );
      expect(resultNoSync.exitCode).toBe(0);
      expect(resultNoSync.summary).toContain("sync: SKIPPED");
    });
  });
});
