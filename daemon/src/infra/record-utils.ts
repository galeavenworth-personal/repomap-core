export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function pickString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export function pickNumber(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

export function pickDate(record: Record<string, unknown>, ...keys: string[]): Date | undefined {
  for (const key of keys) {
    const value = record[key];
    if (value instanceof Date) return value;
    if (typeof value === "string") {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
  }
  return undefined;
}

export function pickTimestamp(record: Record<string, unknown>): number {
  // Direct numeric timestamp fields
  const ts = pickNumber(record, "ts", "timestamp", "createdAtMs");
  if (typeof ts === "number") return ts;

  // Current SDK shape: nested `time` object with epoch ms fields
  const timeObj = record.time;
  if (timeObj && typeof timeObj === "object") {
    const t = timeObj as Record<string, unknown>;
    const nested = pickNumber(t, "start", "end", "created", "updated", "completed");
    if (typeof nested === "number") return nested;
  }

  // Legacy ISO string dates
  const created = pickDate(record, "createdAt", "updatedAt");
  if (created) return created.getTime();

  return Date.now();
}

/** Extract a non-empty string from an unknown value, or undefined. */
export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Extract a string from an unknown value, or null. Allows empty strings. */
export function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Extract a finite number from an unknown value, or undefined. */
export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Coerce an unknown value to a millisecond timestamp, falling back to Date.now(). */
export function toTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = new Date(value).getTime();
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now();
}

export function summarizeArgs(args: unknown): string | undefined {
  if (typeof args === "string") return args;
  if (args) return JSON.stringify(args).slice(0, 1024);
  return undefined;
}
