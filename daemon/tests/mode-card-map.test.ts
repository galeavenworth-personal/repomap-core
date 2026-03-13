import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

import { readFile } from "node:fs/promises";
import { _resetModeCardMapCache, loadModeCardMap } from "../src/infra/mode-card-map.js";

const readFileMock = vi.mocked(readFile);

describe("mode-card-map", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetModeCardMapCache();
  });

  it("loads and caches a valid string-to-string map", async () => {
    readFileMock.mockResolvedValue('{"code":"execute-subtask"}' as never);

    await expect(loadModeCardMap()).resolves.toEqual({ code: "execute-subtask" });
  });

  it("rejects array payloads and uses fallback", async () => {
    readFileMock.mockResolvedValue('["not","a","map"]' as never);

    await expect(loadModeCardMap({ code: "fallback" })).resolves.toEqual({ code: "fallback" });
  });

  it("rejects non-string values and uses fallback", async () => {
    readFileMock.mockResolvedValue('{"code":123}' as never);

    await expect(loadModeCardMap({ code: "fallback" })).resolves.toEqual({ code: "fallback" });
  });
});
