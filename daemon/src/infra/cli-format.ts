/**
 * Shared CLI formatting helpers.
 *
 * Extracted from monitor.cli.ts and foreman.cli.ts to avoid duplication.
 */

/** Format a millisecond duration as a human-readable "Xh Ym Zs" string. */
export function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
