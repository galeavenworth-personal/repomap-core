import { execFile, spawnSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * Transient CLI failure — process exit, timeout, or I/O error.
 * Temporal should retry these.
 */
export class BeadsTransientError extends Error {
  public readonly retryable = true;

  constructor(
    message: string,
    public readonly exitCode: number | null,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "BeadsTransientError";
  }
}

/** Result of a bd CLI invocation. */
export interface BdExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Resolve the path to the bd CLI wrapper.
 * The wrapper lives at `.kilocode/tools/bd` relative to the repo root.
 */
export function resolveBdPath(repoPath: string): string {
  return resolve(repoPath, ".kilocode", "tools", "bd");
}

/** Default timeout for bd commands (15 seconds). */
export const BD_TIMEOUT_MS = 15_000;

/**
 * Execute a bd CLI command with proper path resolution and error handling.
 *
 * Uses execFile (no shell) for security. Captures stdout, stderr, and exit code.
 * Throws BeadsTransientError on non-zero exit or process errors.
 */
export function execBd(
  repoPath: string,
  args: string[],
  timeoutMs: number = BD_TIMEOUT_MS,
): Promise<BdExecResult> {
  const bdPath = resolveBdPath(repoPath);

  return new Promise((resolvePromise, reject) => {
    execFile(
      bdPath,
      args,
      {
        cwd: repoPath,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024, // 1MB
        env: { ...process.env },
      },
      (error, stdout, stderr) => {
        if (error) {
          // Timeout
          if (error.killed || error.code === "ETIMEDOUT") {
            reject(
              new BeadsTransientError(
                `bd ${args.join(" ")} timed out after ${timeoutMs}ms`,
                null,
                stderr,
              ),
            );
            return;
          }

          // Non-zero exit
          const exitCode =
            error.code != null && typeof error.code === "number"
              ? error.code
              : (error as NodeJS.ErrnoException & { status?: number }).status ??
                1;
          reject(
            new BeadsTransientError(
              `bd ${args.join(" ")} exited with code ${exitCode}: ${stderr || error.message}`,
              exitCode,
              stderr,
            ),
          );
          return;
        }

        resolvePromise({
          stdout,
          stderr,
          exitCode: 0,
        });
      },
    );
  });
}

/**
 * Canonical async closeBead — runs `bd close <beadId>` via execBd.
 * Single source of truth for bead closure.
 */
export async function closeBeadCore(
  repoPath: string,
  beadId: string,
): Promise<BdExecResult> {
  return execBd(repoPath, ["close", beadId]);
}

/**
 * Synchronous closeBead for callers that cannot go async.
 * Mirrors closeBeadCore semantics using spawnSync.
 */
export function closeBeadSync(
  bdPath: string,
  cwd: string,
  beadId: string,
): { exitCode: number | null } {
  const result = spawnSync(bdPath, ["close", beadId], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  return { exitCode: result.status };
}
