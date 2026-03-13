import { readFile } from "node:fs/promises";

import { loadModeCardMap } from "../infra/mode-card-map.js";
import { readCardExitPrompt } from "./prompt-reader.js";
const KILOCODEMODES_URL = new URL("../../../.kilocodemodes", import.meta.url);

let modesFileCache: string | null = null;

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
  if (normalized.length === 0) return null;

  // Trim trailing lines that look like YAML metadata keys (e.g. source:, whenToUse:, groups:).
  // These can leak into the extracted section when Punch Card Exit Conditions is the last
  // section in customInstructions and the next YAML key follows without a ## header boundary.
  const YAML_META_KEYS = /^(source|whenToUse|groups|fileRegex|slug|name|roleDefinition|customInstructions)\s*:/;
  const lines = normalized.split("\n");
  let end = lines.length;
  while (end > 0 && (YAML_META_KEYS.test(lines[end - 1].trim()) || lines[end - 1].trim() === "")) {
    end--;
  }
  const trimmed = lines.slice(0, end).join("\n").trim();
  return trimmed.length > 0 ? trimmed : null;
}

export interface CardExitPromptResolution {
  cardId: string | null;
  prompt: string | null;
  source: "compiled" | "static" | "none";
}

export async function resolveCardExitPrompt(
  mode: string | undefined,
  cardIdOverride?: string,
): Promise<CardExitPromptResolution> {
  if (!mode) {
    return { cardId: null, prompt: null, source: "none" };
  }

  const modeMap = await loadModeCardMap();
  const cardId = cardIdOverride || (modeMap[mode] ?? null);

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
