import { readFile } from "node:fs/promises";

export type ModeCardMap = Record<string, string>;

export const MODE_CARD_MAP_URL = new URL(
  "../../../.kilocode/mode-card-map.json",
  import.meta.url,
);

export const DEFAULT_MODE_CARD_MAP: ModeCardMap = {
  "plant-manager": "plant-orchestrate",
  "process-orchestrator": "process-orchestrate",
  architect: "discover-phase",
  code: "execute-subtask",
  "audit-orchestrator": "audit-orchestrate",
  fitter: "fitter-line-health",
  "code-simplifier": "refactor",
  "product-skeptic": "friction-audit",
  "pr-review": "respond-to-pr-review",
  "docs-specialist": "land-plane",
  "thinker-abstract": "prepare-phase",
  "thinker-adversarial": "prepare-phase",
  "thinker-systems": "prepare-phase",
  "thinker-concrete": "prepare-phase",
  "thinker-epistemic": "prepare-phase",
};

let modeCardMapCache: ModeCardMap | null = null;

function isModeCardMap(value: unknown): value is ModeCardMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((entry) => typeof entry === "string");
}

export async function loadModeCardMap(
  fallback?: ModeCardMap,
): Promise<ModeCardMap> {
  if (modeCardMapCache) return modeCardMapCache;

  try {
    const raw = await readFile(MODE_CARD_MAP_URL, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (isModeCardMap(parsed)) {
      modeCardMapCache = parsed;
      return modeCardMapCache;
    }
  } catch {
    // Caller provides fallback; no logging here — callers handle their own error policy.
  }

  return fallback ?? {};
}

/** @internal — exposed for testing only */
export function _resetModeCardMapCache(): void {
  modeCardMapCache = null;
}
