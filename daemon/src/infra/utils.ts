/**
 * Shared utility functions for the infra layer.
 *
 * Pure utility leaf — no imports from other daemon modules.
 */

import { execFileSync } from "node:child_process";

/**
 * Find the repository root via `git rev-parse --show-toplevel`.
 * Falls back to `process.cwd()` if git is unavailable.
 */
export function findRepoRoot(): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    return process.cwd();
  }
}

/**
 * Async sleep for the given number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Return the current wall-clock time as HH:MM:SS.
 */
export function timestamp(): string {
  return new Date().toTimeString().slice(0, 8);
}

/**
 * Run an async function and measure its wall-clock elapsed time.
 * Returns the result and elapsed time in milliseconds.
 */
export async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; elapsedMs: number }> {
  const start = performance.now();
  const result = await fn();
  return { result, elapsedMs: Math.round(performance.now() - start) };
}

/**
 * Recursively sort object keys for canonical JSON serialization.
 * Arrays are mapped element-wise; primitives pass through unchanged.
 */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort((a, b) => a.localeCompare(b))
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}
