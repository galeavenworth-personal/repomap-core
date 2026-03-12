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
    vi.clearAllMocks();
  });

  it("uses compiled prompt when available", async () => {
    const fs = await import("node:fs/promises");
    const promptReader = await import("../src/optimization/prompt-reader.js");

    vi.mocked(fs.readFile)
      .mockResolvedValueOnce(modeMapJson)
      .mockResolvedValueOnce(modesWithStaticSection);
    vi.mocked(promptReader.readCardExitPrompt).mockResolvedValueOnce(
      "compiled card exit prompt",
    );

    const mod = await import("../src/optimization/prompt-injection.js");
    const resolution = await mod.resolveCardExitPrompt("code");

    expect(resolution.source).toBe("compiled");
    expect(resolution.cardId).toBe("execute-subtask");
    expect(resolution.prompt).toBe("compiled card exit prompt");
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
    expect(resolution.prompt).toBeNull();
  });
});

describe("cardIdOverride", () => {
  it("uses cardIdOverride instead of mode-card-map lookup", async () => {
    vi.resetModules();
    vi.clearAllMocks();

    const fs = await import("node:fs/promises");
    const promptReader = await import("../src/optimization/prompt-reader.js");

    vi.mocked(fs.readFile)
      .mockResolvedValueOnce(modeMapJson)
      .mockResolvedValueOnce(modesWithStaticSection);
    vi.mocked(promptReader.readCardExitPrompt).mockResolvedValueOnce(
      "overridden card exit prompt",
    );

    const mod = await import("../src/optimization/prompt-injection.js");
    const resolution = await mod.resolveCardExitPrompt("process-orchestrator", "pr-review-orchestrate");

    expect(resolution.cardId).toBe("pr-review-orchestrate");
    expect(resolution.prompt).toBe("overridden card exit prompt");
    expect(resolution.source).toBe("compiled");
    expect(promptReader.readCardExitPrompt).toHaveBeenCalledWith("pr-review-orchestrate");
  });
});
