/**
 * Shared async loader for the mode → punch-card-ID map.
 *
 * Both daemon.ts (checkpoint validation) and prompt-injection.ts
 * (card-exit prompt resolution) load the same JSON file with
 * identical logic. This module owns that single implementation.
 *
 * The sync file-based loader in dispatch.ts (CLI context) is
 * intentionally separate — it uses readFileSync.
 */

import { readFile } from "node:fs/promises";

export type ModeCardMap = Record<string, string>;

const MODE_CARD_MAP_URL = new URL(
  "../../../.kilocode/mode-card-map.json",
  import.meta.url,
);

let cache: ModeCardMap | null = null;

/**
 * Load and cache the mode-card map from disk.
 *
 * @param fallback — optional default map returned when the JSON file
 *   is missing or unparseable. Defaults to `{}`.
 */
export async function loadModeCardMap(
  fallback: ModeCardMap = {},
): Promise<ModeCardMap> {
  if (cache) return cache;

  try {
    const raw = await readFile(MODE_CARD_MAP_URL, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      cache = parsed as ModeCardMap;
      return cache;
    }
  } catch {
    // Graceful fallback — caller-supplied defaults or empty map.
  }

  cache = fallback;
  return cache;
}

/** Reset the cache (useful for tests). */
export function _resetModeCardMapCache(): void {
  cache = null;
}
