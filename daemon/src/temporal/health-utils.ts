import type { SubsystemHealth } from "./foreman.types.js";

export const DEGRADED_LATENCY_THRESHOLD_MS = 3_000;

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
