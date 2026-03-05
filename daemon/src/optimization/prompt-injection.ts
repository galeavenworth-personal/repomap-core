import { readFile } from "node:fs/promises";

import { readCardExitPrompt } from "./prompt-reader.js";

type ModeCardMap = Record<string, string>;

const MODE_CARD_MAP_URL = new URL("../../../.kilocode/mode-card-map.json", import.meta.url);
const KILOCODEMODES_URL = new URL("../../../.kilocodemodes", import.meta.url);

let modeCardMapCache: ModeCardMap | null = null;
let modesFileCache: string | null = null;

async function loadModeCardMap(): Promise<ModeCardMap> {
  if (modeCardMapCache) {
    return modeCardMapCache;
  }

  try {
    const raw = await readFile(MODE_CARD_MAP_URL, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      modeCardMapCache = parsed as ModeCardMap;
      return modeCardMapCache;
    }
  } catch {
    // Graceful fallback handled by caller.
  }

  modeCardMapCache = {};
  return modeCardMapCache;
}

async function loadModesFile(): Promise<string> {
  if (modesFileCache !== null) {
    return modesFileCache;
  }
  try {
    modesFileCache = await readFile(KILOCODEMODES_URL, "utf8");
    return modesFileCache;
  } catch {
    modesFileCache = "";
    return modesFileCache;
  }
}

export function extractStaticCardExitSection(
  mode: string,
  modesContent: string,
): string | null {
  const slugToken = `- slug: ${mode}`;
  const modeStart = modesContent.indexOf(slugToken);
  if (modeStart < 0) {
    return null;
  }

  const nextModeStart = modesContent.indexOf("\n  - slug:", modeStart + slugToken.length);
  const modeBlock =
    nextModeStart >= 0 ? modesContent.slice(modeStart, nextModeStart) : modesContent.slice(modeStart);

  const markerToken = "## Punch Card Exit Conditions";
  const markerIndex = modeBlock.indexOf(markerToken);
  if (markerIndex < 0) {
    return null;
  }

  const sectionRaw = modeBlock.slice(markerIndex);
  const nextHeaderIndex = sectionRaw.indexOf("\n      ## ", markerToken.length);
  const section = nextHeaderIndex >= 0 ? sectionRaw.slice(0, nextHeaderIndex) : sectionRaw;

  const normalized = section
    .split("\n")
    .map((line) => line.replace(/^\s{6}/, ""))
    .join("\n")
    .trim();
  return normalized.length > 0 ? normalized : null;
}

export interface CardExitPromptResolution {
  cardId: string | null;
  prompt: string | null;
  source: "compiled" | "static" | "none";
}

export async function resolveCardExitPrompt(
  mode: string | undefined,
): Promise<CardExitPromptResolution> {
  if (!mode) {
    return { cardId: null, prompt: null, source: "none" };
  }

  const modeMap = await loadModeCardMap();
  const cardId = modeMap[mode] ?? null;

  if (cardId) {
    try {
      const compiledPrompt = await readCardExitPrompt(cardId);
      if (compiledPrompt) {
        return { cardId, prompt: compiledPrompt, source: "compiled" };
      }
    } catch {
      // Ignore and continue to static fallback.
    }
  }

  const modesContent = await loadModesFile();
  const staticPrompt = extractStaticCardExitSection(mode, modesContent);
  if (staticPrompt) {
    return { cardId, prompt: staticPrompt, source: "static" };
  }

  return { cardId, prompt: null, source: "none" };
}

export function injectCardExitPrompt(basePrompt: string, exitPrompt: string | null): string {
  if (!exitPrompt) {
    return basePrompt;
  }
  return `${exitPrompt}\n\n${basePrompt}`;
}
