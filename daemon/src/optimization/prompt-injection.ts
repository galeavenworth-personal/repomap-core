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
  specificity: "formula+depth" | "formula" | "depth" | "generic" | "static" | "none";
}

function resolveSpecificity(
  promptId: string,
): CardExitPromptResolution["specificity"] {
  const hasFormula = promptId.includes(":formula-");
  const hasDepth = promptId.includes(":depth-");
  if (hasFormula && hasDepth) return "formula+depth";
  if (hasFormula) return "formula";
  if (hasDepth) return "depth";
  return "generic";
}

export async function resolveCardExitPrompt(
  mode: string | undefined,
  cardIdOverride?: string,
  depth?: number,
  formulaId?: string,
): Promise<CardExitPromptResolution> {
  if (!mode) {
    return { cardId: null, prompt: null, source: "none", specificity: "none" };
  }

  const modeMap = await loadModeCardMap();
  const cardId = cardIdOverride || (modeMap[mode] ?? null);

  if (cardId) {
    const candidates: string[] = [];
    const hasFormula = Boolean(formulaId && formulaId.length > 0);
    const hasDepth = depth !== undefined;

    if (hasFormula && hasDepth) {
      candidates.push(`card-exit:${cardId}:formula-${formulaId}:depth-${depth}`);
    }
    if (hasFormula) {
      candidates.push(`card-exit:${cardId}:formula-${formulaId}`);
    }
    if (hasDepth) {
      candidates.push(`card-exit:${cardId}:depth-${depth}`);
    }
    candidates.push(`card-exit:${cardId}`);

    try {
      const match = await readCardExitPrompt(candidates);
      if (match) {
        const specificity = resolveSpecificity(match.promptId);
        console.log(
          `[prompt-resolution] Resolved prompt: ${match.promptId} (specificity: ${specificity})`,
        );
        return { cardId, prompt: match.compiledPrompt, source: "compiled", specificity };
      }
    } catch {
      // Ignore and continue to static fallback.
    }
  }

  const modesContent = await loadModesFile();
  const staticPrompt = extractStaticCardExitSection(mode, modesContent);
  if (staticPrompt) {
    return { cardId, prompt: staticPrompt, source: "static", specificity: "static" };
  }

  return { cardId, prompt: null, source: "none", specificity: "none" };
}

export function injectCardExitPrompt(basePrompt: string, exitPrompt: string | null): string {
  if (!exitPrompt) {
    return basePrompt;
  }
  return `${exitPrompt}\n\n${basePrompt}`;
}
