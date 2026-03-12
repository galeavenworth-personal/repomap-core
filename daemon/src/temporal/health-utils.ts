/**
 * Health Utilities — Shared helpers for health-check modules.
 *
 * Extracted from plant-health.ts and foreman.activities.ts to eliminate
 * duplication of buildSubsystemHealth and related constants.
 *
 * Pure utility leaf — imports only from foreman.types.ts for the
 * SubsystemHealth type.
 */

import type { SubsystemHealth } from "./foreman.types.js";

/** Timeout for individual subsystem health checks (5 seconds). */
export const HEALTH_CHECK_TIMEOUT_MS = 5_000;

/** Latency threshold above which a subsystem is classified as degraded (3 seconds). */
export const DEGRADED_LATENCY_THRESHOLD_MS = 3_000;

/**
 * Build a SubsystemHealth from a check result.
 * Applies the latency degradation threshold automatically:
 * if status is "up" but latency exceeds the threshold, classifies as "degraded".
 */
export function buildSubsystemHealth(
  status: "up" | "down",
  latencyMs: number | null,
  message: string | null,
): SubsystemHealth {
  const effectiveStatus =
    status === "up" && latencyMs !== null && latencyMs > DEGRADED_LATENCY_THRESHOLD_MS
      ? "degraded"
      : status;
  return { status: effectiveStatus, message, latencyMs };
}
