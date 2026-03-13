import { execFileSync } from "node:child_process";

/** Return the git repo root, falling back to cwd. */
export function findRepoRoot(): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    return process.cwd();
  }
}

/** Async delay for `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** HH:MM:SS wall-clock timestamp. */
export function timestamp(): string {
  return new Date().toTimeString().slice(0, 8);
}

/** Time an async function, returning result and elapsed milliseconds. */
export async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; elapsedMs: number }> {
  const start = performance.now();
  const result = await fn();
  return { result, elapsedMs: Math.round(performance.now() - start) };
}

/** Recursively sort object keys for deterministic serialization. */
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
