/**
 * Plant Health Non-Dolt Collectors — Quality gate and daemon health sections.
 *
 * Each function independently collects data for one section of the plant
 * health report. Failures are reported in the result structure, never thrown.
 *
 * Sections in this module:
 *   3. Quality Gate Results — last pass/fail per quality gate (reads JSONL file)
 *   6. Daemon Health       — kilo serve, Dolt query latency, Temporal status
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createConnection } from "node:net";
import mysql, { type Connection } from "mysql2/promise";

import { timed } from "../infra/utils.js";
import type { SubsystemHealth } from "./foreman.types.js";
import { buildSubsystemHealth, HEALTH_CHECK_TIMEOUT_MS } from "./health-utils.js";
import type {
  QualityGateStatus,
  QualityGateResult,
  DaemonHealthStatus,
  PlantHealthConfig,
} from "./plant-health.types.js";

// ── Gate Run JSONL Shape ──

interface GateRunEntry {
  gate_id: string;
  status: "pass" | "fail";
  bead_id: string;
  run_timestamp: string;
  elapsed_seconds: number;
}

// ── Helpers ──

function parseTemporalAddress(address: string): {
  host: string;
  port: number;
  display: string;
} {
  const trimmed = address.trim();
  if (!trimmed) {
    return { host: "localhost", port: 7233, display: "localhost:7233" };
  }

  const bracketMatch = /^\[(.+)\](?::(\d+))?$/.exec(trimmed);
  if (bracketMatch) {
    const host = bracketMatch[1] ?? "localhost";
    const parsedPort = Number.parseInt(bracketMatch[2] ?? "7233", 10);
    const port = Number.isFinite(parsedPort) ? parsedPort : 7233;
    return { host, port, display: `${host}:${port}` };
  }

  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon > 0 && lastColon < trimmed.length - 1) {
    const host = trimmed.slice(0, lastColon);
    const parsedPort = Number.parseInt(trimmed.slice(lastColon + 1), 10);
    if (Number.isFinite(parsedPort)) {
      return { host, port: parsedPort, display: `${host}:${parsedPort}` };
    }
  }

  return { host: trimmed, port: 7233, display: `${trimmed}:7233` };
}

// ── Section Collectors ──

/**
 * Collect quality gate results from gate_runs.jsonl.
 *
 * Reads the JSONL file and extracts the last result per gate ID.
 */
export async function collectQualityGateResults(
  repoPath: string,
  gateRunsPath: string,
): Promise<QualityGateStatus> {
  try {
    const fullPath = resolve(repoPath, gateRunsPath);
    let content: string;
    try {
      content = await readFile(fullPath, "utf-8");
    } catch {
      return {
        status: "unknown",
        data: null,
        error: `Quality gate file not found: ${gateRunsPath}`,
      };
    }

    const lines = content.trim().split("\n").filter(Boolean);
    const lastPerGate = new Map<string, GateRunEntry>();

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as GateRunEntry;
        if (entry.gate_id) {
          lastPerGate.set(entry.gate_id, entry);
        }
      } catch {
        // Skip malformed lines
      }
    }

    const gates: QualityGateResult[] = [];
    for (const [gateId, entry] of lastPerGate) {
      gates.push({
        gateId,
        status: entry.status === "pass" ? "pass" : "fail",
        beadId: entry.bead_id ?? "unknown",
        runTimestamp: entry.run_timestamp ?? "unknown",
        elapsedSeconds: entry.elapsed_seconds ?? 0,
      });
    }

    const allPassing = gates.length > 0 && gates.every((g) => g.status === "pass");
    const anyFailing = gates.some((g) => g.status === "fail");

    let status: "unknown" | "degraded" | "ok";
    if (gates.length === 0) {
      status = "unknown";
    } else if (anyFailing) {
      status = "degraded";
    } else {
      status = "ok";
    }

    return {
      status,
      data: { gates, allPassing },
      error: null,
    };
  } catch (e) {
    return {
      status: "unknown",
      data: null,
      error: `Failed to read quality gate results: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** Check kilo serve health via HTTP. */
async function checkKiloServeHealth(config: PlantHealthConfig): Promise<SubsystemHealth> {
  try {
    const { result: res, elapsedMs } = await timed(async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
      try {
        return await fetch(`http://${config.kiloHost}:${config.kiloPort}/session`, {
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
    });
    return res.ok
      ? buildSubsystemHealth("up", elapsedMs, `HTTP ${res.status}`)
      : buildSubsystemHealth("down", elapsedMs, `HTTP ${res.status} ${res.statusText}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: "down", message: `unreachable: ${msg}`, latencyMs: null };
  }
}

/** TCP connect check with timeout. */
async function tcpCheck(host: string, port: number): Promise<number> {
  const { elapsedMs } = await timed(async () => {
    await new Promise<void>((resolveConn, reject) => {
      const sock = createConnection({ host, port }, () => {
        sock.destroy();
        resolveConn();
      });
      sock.on("error", reject);
      sock.setTimeout(HEALTH_CHECK_TIMEOUT_MS, () => {
        sock.destroy();
        reject(new Error("timeout"));
      });
    });
  });
  return elapsedMs;
}

/** Check Dolt health via TCP + query latency probe. */
async function checkDoltHealth(
  config: PlantHealthConfig,
): Promise<{ dolt: SubsystemHealth; doltQueryLatencyMs: number | null }> {
  let doltQueryLatencyMs: number | null = null;
  try {
    const elapsedMs = await tcpCheck(config.doltHost, config.doltPort);
    let dolt: SubsystemHealth = buildSubsystemHealth("up", elapsedMs, `TCP ${config.doltHost}:${config.doltPort}`);

    // Measure query latency via a lightweight query
    try {
      let conn: Connection | null = null;
      try {
        conn = await mysql.createConnection({
          host: config.doltHost,
          port: config.doltPort,
          database: config.doltDatabase,
          user: "root",
          connectTimeout: HEALTH_CHECK_TIMEOUT_MS,
        });
        const activeConn = conn;
        const { elapsedMs: queryMs } = await timed(async () => {
          await activeConn.execute("SELECT 1");
        });
        doltQueryLatencyMs = queryMs;
      } finally {
        if (conn) await conn.end();
      }
    } catch {
      dolt = { status: "degraded", latencyMs: elapsedMs, message: "TCP up, but query latency probe failed" };
    }

    return { dolt, doltQueryLatencyMs };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      dolt: { status: "down", message: `TCP ${config.doltHost}:${config.doltPort} failed: ${msg}`, latencyMs: null },
      doltQueryLatencyMs: null,
    };
  }
}

/** Check Temporal health via TCP or implicit (inside Temporal activity). */
async function checkTemporalHealth(config: PlantHealthConfig): Promise<SubsystemHealth> {
  if (config.insideTemporal) {
    return { status: "up", message: "implicit: running inside Temporal activity", latencyMs: 0 };
  }

  const temporalEndpoint = parseTemporalAddress(process.env.TEMPORAL_ADDRESS ?? "localhost:7233");
  try {
    const elapsedMs = await tcpCheck(temporalEndpoint.host, temporalEndpoint.port);
    return buildSubsystemHealth("up", elapsedMs, `TCP ${temporalEndpoint.display}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: "down", message: `TCP ${temporalEndpoint.display} failed: ${msg}`, latencyMs: null };
  }
}

/** Aggregate subsystem statuses into an overall daemon health status. */
function aggregateDaemonStatus(subsystems: SubsystemHealth[]): "ok" | "degraded" | "unhealthy" {
  if (subsystems.some((s) => s.status === "down")) return "unhealthy";
  if (subsystems.some((s) => s.status === "degraded")) return "degraded";
  return "ok";
}

/**
 * Collect daemon health — kilo serve, Dolt, and Temporal connectivity.
 *
 * Checks kilo serve via HTTP, Dolt via TCP + query, and Temporal via
 * TCP or implicit (when running inside a Temporal activity).
 */
export async function collectDaemonHealth(
  config: PlantHealthConfig,
): Promise<DaemonHealthStatus> {
  try {
    const [kiloServe, doltResult, temporal] = await Promise.all([
      checkKiloServeHealth(config),
      checkDoltHealth(config),
      checkTemporalHealth(config),
    ]);

    const { dolt, doltQueryLatencyMs } = doltResult;

    return {
      status: aggregateDaemonStatus([kiloServe, dolt, temporal]),
      data: { kiloServe, dolt, temporal, doltQueryLatencyMs },
      error: null,
    };
  } catch (e) {
    return {
      status: "unknown",
      data: null,
      error: `Failed to collect daemon health: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
