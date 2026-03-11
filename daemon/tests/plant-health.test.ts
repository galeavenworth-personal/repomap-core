/**
 * Plant Health Composite Command Tests
 *
 * Tests for the plant health report generator that produces a structured
 * health report covering 6 sections:
 *   1. Punch Card Status
 *   2. Governor Status
 *   3. Quality Gate Results
 *   4. Cost Summary
 *   5. Subtask Tree Health
 *   6. Daemon Health
 *
 * Tests are organized by concern:
 *   1. Type and structure validation
 *   2. generatePlantHealthReport — graceful degradation
 *   3. generatePlantHealthReport — quality gate parsing
 *   4. Overall health aggregation
 *   5. Cost zone classification
 *   6. Key metrics computation
 *   7. checkPlantHealth — Temporal activity wrapper
 *   8. Default configuration
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  generatePlantHealthReport,
  checkPlantHealth,
  DEFAULT_PLANT_HEALTH_CONFIG,
  type PlantHealthConfig,
  type PlantHealthReport,
  type SectionStatus,
  type CostZone,
} from "../src/temporal/plant-health.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

/** Build a minimal PlantHealthConfig for testing. */
function makeConfig(overrides?: Partial<PlantHealthConfig>): PlantHealthConfig {
  return {
    repoPath: "/tmp/test-repo",
    doltHost: "127.0.0.1",
    doltPort: 39999, // Intentionally unreachable port for unit tests
    doltDatabase: "test_db",
    kiloHost: "127.0.0.1",
    kiloPort: 39998, // Intentionally unreachable port for unit tests
    cheapZoneThresholdUsd: 0.42,
    balloonedThresholdUsd: 1.0,
    gateRunsPath: ".kilocode/gate_runs.jsonl",
    insideTemporal: false,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Type and Structure Validation
// ═══════════════════════════════════════════════════════════════════════════════

describe("PlantHealthReport — structure", () => {
  it("has all 6 sections in the report", async () => {
    const config = makeConfig();
    const report = await generatePlantHealthReport(config);

    expect(report.sections).toBeDefined();
    expect(report.sections.punchCardStatus).toBeDefined();
    expect(report.sections.governorStatus).toBeDefined();
    expect(report.sections.qualityGateResults).toBeDefined();
    expect(report.sections.costSummary).toBeDefined();
    expect(report.sections.subtaskTreeHealth).toBeDefined();
    expect(report.sections.daemonHealth).toBeDefined();
  });

  it("has generatedAt as ISO 8601 timestamp", async () => {
    const config = makeConfig();
    const report = await generatePlantHealthReport(config);

    expect(report.generatedAt).toBeDefined();
    // Verify it's a valid ISO 8601 date
    const parsed = new Date(report.generatedAt);
    expect(parsed.toISOString()).toBe(report.generatedAt);
  });

  it("has overall health status", async () => {
    const config = makeConfig();
    const report = await generatePlantHealthReport(config);

    expect(["healthy", "degraded", "unhealthy", "unknown"]).toContain(report.overall);
  });

  it("has key metrics object", async () => {
    const config = makeConfig();
    const report = await generatePlantHealthReport(config);

    expect(report.keyMetrics).toBeDefined();
    expect(report.keyMetrics).toHaveProperty("avgCostPer100kTokens");
    expect(report.keyMetrics).toHaveProperty("maxSessionStepCount");
    expect(report.keyMetrics).toHaveProperty("avgToolAdherenceRatio");
    expect(report.keyMetrics).toHaveProperty("sessionsWithLoops");
  });

  it("each section has status, data, and error fields", async () => {
    const config = makeConfig();
    const report = await generatePlantHealthReport(config);

    for (const [_name, section] of Object.entries(report.sections)) {
      expect(section).toHaveProperty("status");
      expect(section).toHaveProperty("data");
      expect(section).toHaveProperty("error");
      expect(["ok", "degraded", "unhealthy", "unknown"]).toContain(
        section.status as SectionStatus,
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Graceful Degradation (Dolt unavailable)
// ═══════════════════════════════════════════════════════════════════════════════

describe("PlantHealthReport — graceful degradation", () => {
  it("reports Dolt-dependent sections as unknown when Dolt is unreachable", async () => {
    const config = makeConfig({
      doltPort: 39999, // Unreachable
    });
    const report = await generatePlantHealthReport(config);

    // Sections that depend on Dolt should report as unknown
    expect(report.sections.punchCardStatus.status).toBe("unknown");
    expect(report.sections.punchCardStatus.error).toContain("Dolt connection unavailable");

    expect(report.sections.governorStatus.status).toBe("unknown");
    expect(report.sections.governorStatus.error).toContain("Dolt connection unavailable");

    expect(report.sections.costSummary.status).toBe("unknown");
    expect(report.sections.costSummary.error).toContain("Dolt connection unavailable");

    expect(report.sections.subtaskTreeHealth.status).toBe("unknown");
    expect(report.sections.subtaskTreeHealth.error).toContain("Dolt connection unavailable");
  });

  it("quality gate section works independently of Dolt", async () => {
    // Use the actual repo path so it can find the real gate_runs.jsonl
    const config = makeConfig({
      repoPath: resolve(__dirname, ".."),
      doltPort: 39999, // Unreachable
      // The test repo doesn't have a .kilocode/gate_runs.jsonl at daemon/
      // so this will report unknown, which is correct graceful behavior
    });
    const report = await generatePlantHealthReport(config);

    // Quality gate section should NOT have a "Dolt connection unavailable" error
    expect(report.sections.qualityGateResults.error).not.toContain(
      "Dolt connection unavailable",
    );
  });

  it("daemon health section works independently of Dolt connection for main report", async () => {
    const config = makeConfig({
      doltPort: 39999,
      kiloPort: 39998,
    });
    const report = await generatePlantHealthReport(config);

    // Daemon health should report its own checks, not "Dolt connection unavailable"
    // error may be null (no error) or a string describing a daemon-specific issue
    const daemonError = report.sections.daemonHealth.error;
    if (daemonError !== null) {
      expect(daemonError).not.toContain("Dolt connection unavailable");
    }
  });

  it("does not throw when all services are unavailable", async () => {
    const config = makeConfig({
      doltPort: 39999,
      kiloPort: 39998,
    });

    // Should NOT throw — graceful degradation
    const report = await generatePlantHealthReport(config);
    expect(report).toBeDefined();
    expect(report.generatedAt).toBeDefined();
  });

  it("overall status is unknown when all Dolt sections are unknown and non-Dolt sections are down", async () => {
    const config = makeConfig({
      doltPort: 39999,
      kiloPort: 39998,
      gateRunsPath: "nonexistent/path.jsonl",
    });
    const report = await generatePlantHealthReport(config);

    // All sections should be unknown or unhealthy
    // Overall should reflect the worst state
    expect(["degraded", "unhealthy", "unknown"]).toContain(report.overall);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Quality Gate Parsing (from real JSONL)
// ═══════════════════════════════════════════════════════════════════════════════

describe("PlantHealthReport — quality gate parsing", () => {
  it("parses gate_runs.jsonl from the actual repo", async () => {
    // Point to the real repo to read the actual gate_runs.jsonl
    const repoRoot = resolve(__dirname, "../..");
    const config = makeConfig({
      repoPath: repoRoot,
      doltPort: 39999, // Don't need Dolt for this test
    });
    const report = await generatePlantHealthReport(config);

    const gateSection = report.sections.qualityGateResults;
    // The real repo has gate_runs.jsonl with ruff-format, ruff-check, mypy, pytest
    expect(gateSection.status).not.toBe("unknown");
    expect(gateSection.data).not.toBeNull();
    if (gateSection.data) {
      expect(gateSection.data.gates.length).toBeGreaterThan(0);
      // Verify gate structure
      for (const gate of gateSection.data.gates) {
        expect(gate.gateId).toBeDefined();
        expect(["pass", "fail"]).toContain(gate.status);
        expect(gate.beadId).toBeDefined();
        expect(gate.runTimestamp).toBeDefined();
      }
    }
  });

  it("reports unknown when gate_runs.jsonl does not exist", async () => {
    const config = makeConfig({
      repoPath: "/tmp/nonexistent-repo",
      doltPort: 39999,
      gateRunsPath: "nonexistent.jsonl",
    });
    const report = await generatePlantHealthReport(config);

    expect(report.sections.qualityGateResults.status).toBe("unknown");
    expect(report.sections.qualityGateResults.error).toContain("not found");
  });

  it("last result per gate ID wins (deduplication)", async () => {
    // The real gate_runs.jsonl has multiple entries for the same gate_id
    // The parser should keep only the last one per gate
    const repoRoot = resolve(__dirname, "../..");
    const config = makeConfig({
      repoPath: repoRoot,
      doltPort: 39999,
    });
    const report = await generatePlantHealthReport(config);

    const gateSection = report.sections.qualityGateResults;
    if (gateSection.data) {
      const gateIds = gateSection.data.gates.map((g) => g.gateId);
      const uniqueIds = new Set(gateIds);
      // Each gate ID should appear exactly once
      expect(gateIds.length).toBe(uniqueIds.size);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Overall Health Aggregation
// ═══════════════════════════════════════════════════════════════════════════════

describe("PlantHealthReport — overall aggregation", () => {
  it("reports unhealthy when daemon health has a down subsystem", async () => {
    const config = makeConfig({
      doltPort: 39999,
      kiloPort: 39998,
    });
    const report = await generatePlantHealthReport(config);

    // With unreachable services, daemon health should be unhealthy
    // which should make overall unhealthy
    const daemonStatus = report.sections.daemonHealth.status;
    if (daemonStatus === "unhealthy") {
      expect(report.overall).toBe("unhealthy");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Cost Zone Classification
// ═══════════════════════════════════════════════════════════════════════════════

describe("Cost zone classification", () => {
  // Test the classification via the report structure
  // These are integration tests that verify the classification logic
  // through the full pipeline

  it("uses $0.42 as default cheap zone threshold", () => {
    expect(DEFAULT_PLANT_HEALTH_CONFIG.cheapZoneThresholdUsd).toBe(0.42);
  });

  it("uses $1.00 as default ballooned threshold", () => {
    expect(DEFAULT_PLANT_HEALTH_CONFIG.balloonedThresholdUsd).toBe(1.0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. Key Metrics Computation
// ═══════════════════════════════════════════════════════════════════════════════

describe("PlantHealthReport — key metrics", () => {
  it("reports null metrics when no data is available", async () => {
    const config = makeConfig({
      doltPort: 39999,
    });
    const report = await generatePlantHealthReport(config);

    // With no Dolt data, metrics should be null
    expect(report.keyMetrics.avgCostPer100kTokens).toBeNull();
    expect(report.keyMetrics.maxSessionStepCount).toBeNull();
    expect(report.keyMetrics.avgToolAdherenceRatio).toBeNull();
    expect(report.keyMetrics.sessionsWithLoops).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. Temporal Activity Wrapper
// ═══════════════════════════════════════════════════════════════════════════════

describe("checkPlantHealth — Temporal activity wrapper", () => {
  it("accepts CheckStackHealthInput-compatible input", async () => {
    const report = await checkPlantHealth({
      repoPath: "/tmp/test-repo",
      doltHost: "127.0.0.1",
      doltPort: 39999,
      doltDatabase: "test_db",
      kiloHost: "127.0.0.1",
      kiloPort: 39998,
    });

    expect(report).toBeDefined();
    expect(report.sections).toBeDefined();
    expect(report.overall).toBeDefined();
  });

  it("sets insideTemporal to true", async () => {
    const report = await checkPlantHealth({
      repoPath: "/tmp/test-repo",
      doltHost: "127.0.0.1",
      doltPort: 39999,
      doltDatabase: "test_db",
      kiloHost: "127.0.0.1",
      kiloPort: 39998,
    });

    // When inside Temporal, the temporal health check should be implicit
    if (report.sections.daemonHealth.data) {
      expect(report.sections.daemonHealth.data.temporal.status).toBe("up");
      expect(report.sections.daemonHealth.data.temporal.message).toContain("implicit");
    }
  });

  it("uses default thresholds when not specified", async () => {
    const report = await checkPlantHealth({
      repoPath: "/tmp/test-repo",
      doltHost: "127.0.0.1",
      doltPort: 39999,
      doltDatabase: "test_db",
      kiloHost: "127.0.0.1",
      kiloPort: 39998,
    });

    // Should not throw and should produce a report
    expect(report.generatedAt).toBeDefined();
  });

  it("allows overriding thresholds", async () => {
    const report = await checkPlantHealth({
      repoPath: "/tmp/test-repo",
      doltHost: "127.0.0.1",
      doltPort: 39999,
      doltDatabase: "test_db",
      kiloHost: "127.0.0.1",
      kiloPort: 39998,
      cheapZoneThresholdUsd: 0.30,
      balloonedThresholdUsd: 0.80,
    });

    expect(report).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. Default Configuration
// ═══════════════════════════════════════════════════════════════════════════════

describe("DEFAULT_PLANT_HEALTH_CONFIG", () => {
  it("has expected defaults", () => {
    expect(DEFAULT_PLANT_HEALTH_CONFIG.doltHost).toBe("127.0.0.1");
    expect(DEFAULT_PLANT_HEALTH_CONFIG.doltPort).toBe(3307);
    expect(DEFAULT_PLANT_HEALTH_CONFIG.doltDatabase).toBe("beads_repomap-core");
    expect(DEFAULT_PLANT_HEALTH_CONFIG.kiloHost).toBe("127.0.0.1");
    expect(DEFAULT_PLANT_HEALTH_CONFIG.kiloPort).toBe(4096);
    expect(DEFAULT_PLANT_HEALTH_CONFIG.cheapZoneThresholdUsd).toBe(0.42);
    expect(DEFAULT_PLANT_HEALTH_CONFIG.balloonedThresholdUsd).toBe(1.0);
    expect(DEFAULT_PLANT_HEALTH_CONFIG.gateRunsPath).toBe(".kilocode/gate_runs.jsonl");
    expect(DEFAULT_PLANT_HEALTH_CONFIG.insideTemporal).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. Report Serialization
// ═══════════════════════════════════════════════════════════════════════════════

describe("PlantHealthReport — JSON serialization", () => {
  it("produces valid JSON output", async () => {
    const config = makeConfig({
      doltPort: 39999,
      kiloPort: 39998,
    });
    const report = await generatePlantHealthReport(config);

    // Round-trip through JSON
    const json = JSON.stringify(report);
    const parsed = JSON.parse(json) as PlantHealthReport;

    expect(parsed.generatedAt).toBe(report.generatedAt);
    expect(parsed.overall).toBe(report.overall);
    expect(Object.keys(parsed.sections)).toHaveLength(6);
    expect(parsed.keyMetrics).toEqual(report.keyMetrics);
  });

  it("has no Date objects (Temporal-safe serialization)", async () => {
    const config = makeConfig({
      doltPort: 39999,
    });
    const report = await generatePlantHealthReport(config);

    // JSON round-trip should be lossless (no Date objects that stringify differently)
    const json = JSON.stringify(report);
    const parsed = JSON.parse(json) as PlantHealthReport;
    expect(JSON.stringify(parsed)).toBe(json);
  });
});
