import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

vi.mock("../src/optimization/prompt-reader.js", () => ({
  readCardExitPrompt: vi.fn(),
}));

const modeMapJson = JSON.stringify({
  code: "execute-subtask",
});

const modesWithStaticSection = `customModes:
  - slug: code
    customInstructions: |
      ## Something Else

      ## Punch Card Exit Conditions

      - Punch card: execute-subtask
      - Before exiting, run check_punch_card.sh

      ## Another Header
`;

describe("prompt injection fallback chain", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
  });

  it("uses compiled prompt when available", async () => {
    const fs = await import("node:fs/promises");
    const promptReader = await import("../src/optimization/prompt-reader.js");

    vi.mocked(fs.readFile)
      .mockResolvedValueOnce(modeMapJson)
      .mockResolvedValueOnce(modesWithStaticSection);
    vi.mocked(promptReader.readCardExitPrompt).mockResolvedValueOnce(
      {
        compiledPrompt: "compiled card exit prompt",
        promptId: "card-exit:execute-subtask",
      },
    );

    const mod = await import("../src/optimization/prompt-injection.js");
    const resolution = await mod.resolveCardExitPrompt("code");

    expect(resolution.source).toBe("compiled");
    expect(resolution.specificity).toBe("generic");
    expect(resolution.cardId).toBe("execute-subtask");
    expect(resolution.prompt).toBe("compiled card exit prompt");
    expect(promptReader.readCardExitPrompt).toHaveBeenCalledWith([
      "card-exit:execute-subtask",
    ]);
  });

  it("falls back to static mode section when compiled prompt missing", async () => {
    const fs = await import("node:fs/promises");
    const promptReader = await import("../src/optimization/prompt-reader.js");

    vi.mocked(fs.readFile).mockImplementation(async (pathLike) => {
      const path = String(pathLike);
      return path.includes("mode-card-map.json")
        ? modeMapJson
        : modesWithStaticSection;
    });
    vi.mocked(promptReader.readCardExitPrompt).mockResolvedValueOnce(null);

    const mod = await import("../src/optimization/prompt-injection.js");
    const resolution = await mod.resolveCardExitPrompt("code");

    expect(resolution.source).toBe("static");
    expect(resolution.specificity).toBe("static");
    expect(resolution.prompt).toContain("## Punch Card Exit Conditions");
  });

  it("returns none when no compiled or static prompt exists", async () => {
    const promptReader = await import("../src/optimization/prompt-reader.js");
    const fs = await import("node:fs/promises");

    vi.mocked(fs.readFile).mockImplementation(async (pathLike) => {
      const path = String(pathLike);
      return (path.includes("mode-card-map.json") ? modeMapJson : "customModes: []") as never;
    });
    vi.mocked(promptReader.readCardExitPrompt).mockResolvedValue(null);

    const mod = await import("../src/optimization/prompt-injection.js");
    const resolution = await mod.resolveCardExitPrompt("code");

    expect(resolution.source).toBe("none");
    expect(resolution.specificity).toBe("none");
    expect(resolution.prompt).toBeNull();
  });
});

describe("cardIdOverride", () => {
  it("uses cardIdOverride instead of mode-card-map lookup", async () => {
    vi.resetModules();
    vi.resetAllMocks();

    const fs = await import("node:fs/promises");
    const promptReader = await import("../src/optimization/prompt-reader.js");

    vi.mocked(fs.readFile)
      .mockResolvedValueOnce(modeMapJson)
      .mockResolvedValueOnce(modesWithStaticSection);
    vi.mocked(promptReader.readCardExitPrompt).mockResolvedValueOnce(
      {
        compiledPrompt: "overridden card exit prompt",
        promptId: "card-exit:pr-review-orchestrate",
      },
    );

    const mod = await import("../src/optimization/prompt-injection.js");
    const resolution = await mod.resolveCardExitPrompt("process-orchestrator", "pr-review-orchestrate");

    expect(resolution.cardId).toBe("pr-review-orchestrate");
    expect(resolution.prompt).toBe("overridden card exit prompt");
    expect(resolution.source).toBe("compiled");
    expect(resolution.specificity).toBe("generic");
    expect(promptReader.readCardExitPrompt).toHaveBeenCalledWith([
      "card-exit:pr-review-orchestrate",
    ]);
  });
});

describe("resolution cascade", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
  });

  it("resolves formula+depth when both params provided and most-specific match exists", async () => {
    const fs = await import("node:fs/promises");
    const promptReader = await import("../src/optimization/prompt-reader.js");

    vi.mocked(promptReader.readCardExitPrompt).mockReset();
    vi.mocked(fs.readFile).mockImplementation(async (pathLike) => {
      const path = String(pathLike);
      return path.includes("mode-card-map.json")
        ? modeMapJson
        : modesWithStaticSection;
    });
    vi.mocked(promptReader.readCardExitPrompt).mockResolvedValue({
      compiledPrompt: "formula+depth prompt",
      promptId: "card-exit:execute-subtask:formula-optimize:depth-2",
    });

    const mod = await import("../src/optimization/prompt-injection.js");
    const resolution = await mod.resolveCardExitPrompt(
      "code",
      undefined,
      2,
      "optimize",
    );

    expect(resolution.source).toBe("compiled");
    expect(resolution.specificity).toBe("formula+depth");
    expect(resolution.prompt).toBe("formula+depth prompt");
    expect(promptReader.readCardExitPrompt).toHaveBeenCalledWith([
      "card-exit:execute-subtask:formula-optimize:depth-2",
      "card-exit:execute-subtask:formula-optimize",
      "card-exit:execute-subtask:depth-2",
      "card-exit:execute-subtask",
    ]);
  });

  it("resolves formula-only when only formulaId provided", async () => {
    const fs = await import("node:fs/promises");
    const promptReader = await import("../src/optimization/prompt-reader.js");

    vi.mocked(promptReader.readCardExitPrompt).mockReset();
    vi.mocked(fs.readFile).mockImplementation(async (pathLike) => {
      const path = String(pathLike);
      return path.includes("mode-card-map.json")
        ? modeMapJson
        : modesWithStaticSection;
    });
    vi.mocked(promptReader.readCardExitPrompt).mockResolvedValue({
      compiledPrompt: "formula prompt",
      promptId: "card-exit:execute-subtask:formula-optimize",
    });

    const mod = await import("../src/optimization/prompt-injection.js");
    const resolution = await mod.resolveCardExitPrompt(
      "code",
      undefined,
      undefined,
      "optimize",
    );

    expect(resolution.specificity).toBe("formula");
    expect(resolution.prompt).toBe("formula prompt");
    expect(promptReader.readCardExitPrompt).toHaveBeenCalledWith([
      "card-exit:execute-subtask:formula-optimize",
      "card-exit:execute-subtask",
    ]);
  });

  it("resolves depth-only when only depth provided", async () => {
    const fs = await import("node:fs/promises");
    const promptReader = await import("../src/optimization/prompt-reader.js");

    vi.mocked(promptReader.readCardExitPrompt).mockReset();
    vi.mocked(fs.readFile).mockImplementation(async (pathLike) => {
      const path = String(pathLike);
      return path.includes("mode-card-map.json")
        ? modeMapJson
        : modesWithStaticSection;
    });
    vi.mocked(promptReader.readCardExitPrompt).mockResolvedValue({
      compiledPrompt: "depth prompt",
      promptId: "card-exit:execute-subtask:depth-3",
    });

    const mod = await import("../src/optimization/prompt-injection.js");
    const resolution = await mod.resolveCardExitPrompt("code", undefined, 3);

    expect(resolution.specificity).toBe("depth");
    expect(resolution.prompt).toBe("depth prompt");
    expect(promptReader.readCardExitPrompt).toHaveBeenCalledWith([
      "card-exit:execute-subtask:depth-3",
      "card-exit:execute-subtask",
    ]);
  });

  it("falls through cascade to static when no compiled prompts match", async () => {
    const fs = await import("node:fs/promises");
    const promptReader = await import("../src/optimization/prompt-reader.js");

    vi.mocked(promptReader.readCardExitPrompt).mockReset();
    vi.mocked(fs.readFile).mockImplementation(async (pathLike) => {
      const path = String(pathLike);
      return path.includes("mode-card-map.json")
        ? modeMapJson
        : modesWithStaticSection;
    });
    vi.mocked(promptReader.readCardExitPrompt).mockResolvedValue(null);

    const mod = await import("../src/optimization/prompt-injection.js");
    const resolution = await mod.resolveCardExitPrompt(
      "code",
      undefined,
      2,
      "optimize",
    );

    expect(resolution.source).toBe("static");
    expect(resolution.specificity).toBe("static");
    expect(resolution.prompt).toContain("## Punch Card Exit Conditions");
    expect(promptReader.readCardExitPrompt).toHaveBeenCalledWith([
      "card-exit:execute-subtask:formula-optimize:depth-2",
      "card-exit:execute-subtask:formula-optimize",
      "card-exit:execute-subtask:depth-2",
      "card-exit:execute-subtask",
    ]);
  });
});
