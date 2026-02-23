import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  promptMock,
  commandMock,
  listMock,
  configUpdateMock,
  createOpencodeClientMock,
} = vi.hoisted(() => {
  const promptMock = vi.fn();
  const commandMock = vi.fn();
  const listMock = vi.fn();
  const configUpdateMock = vi.fn();
  const createOpencodeClientMock = vi.fn(() => ({
    session: { prompt: promptMock, command: commandMock, list: listMock },
    config: { update: configUpdateMock },
  }));
  return {
    promptMock,
    commandMock,
    listMock,
    configUpdateMock,
    createOpencodeClientMock,
  };
});

vi.mock("@opencode-ai/sdk/client", () => ({
  createOpencodeClient: createOpencodeClientMock,
}));

import { createPromptDriver } from "../src/prompt-driver/index.js";

describe("prompt driver", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    promptMock.mockResolvedValue({ data: { info: {}, parts: [] } });
    commandMock.mockResolvedValue({ data: { info: {}, parts: [] } });
    configUpdateMock.mockResolvedValue({ data: {} });
    listMock.mockResolvedValue({ data: [{ id: "sess-1", title: "Test" }] });
  });

  it("creates the SDK client with correct baseUrl", () => {
    createPromptDriver({ kiloHost: "127.0.0.1", kiloPort: 4096 });

    expect(createOpencodeClientMock).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.1:4096",
    });
  });

  it("sendPrompt calls session.prompt with correct path and body", async () => {
    const driver = createPromptDriver({ kiloHost: "127.0.0.1", kiloPort: 4096 });

    await driver.sendPrompt("sess-1", "hello world");

    expect(promptMock).toHaveBeenCalledWith({
      path: { id: "sess-1" },
      body: {
        parts: [{ type: "text", text: "hello world" }],
        agent: undefined,
        noReply: undefined,
      },
    });
  });

  it("sendPrompt passes agent and noReply options through", async () => {
    const driver = createPromptDriver({ kiloHost: "127.0.0.1", kiloPort: 4096 });

    await driver.sendPrompt("sess-1", "hello", {
      agent: "claude",
      noReply: true,
    });

    expect(promptMock).toHaveBeenCalledWith({
      path: { id: "sess-1" },
      body: {
        parts: [{ type: "text", text: "hello" }],
        agent: "claude",
        noReply: true,
      },
    });
  });

  it("executeCommand calls session.command with parsed command and arguments", async () => {
    const driver = createPromptDriver({ kiloHost: "127.0.0.1", kiloPort: 4096 });

    await driver.executeCommand("sess-1", "/checkpoint create");

    expect(commandMock).toHaveBeenCalledWith({
      path: { id: "sess-1" },
      body: {
        command: "/checkpoint",
        arguments: "create",
      },
    });
  });

  it("executeCommand handles command with no arguments", async () => {
    const driver = createPromptDriver({ kiloHost: "127.0.0.1", kiloPort: 4096 });

    await driver.executeCommand("sess-1", "/help");

    expect(commandMock).toHaveBeenCalledWith({
      path: { id: "sess-1" },
      body: {
        command: "/help",
        arguments: "",
      },
    });
  });

  it("updateConfig calls config.update with body", async () => {
    const driver = createPromptDriver({ kiloHost: "127.0.0.1", kiloPort: 4096 });

    await driver.updateConfig({ defaultAgent: "claude", maxTokens: 2048 });

    expect(configUpdateMock).toHaveBeenCalledWith({
      body: { defaultAgent: "claude", maxTokens: 2048 },
    });
  });

  it("listSessions calls session.list and returns session array", async () => {
    const driver = createPromptDriver({ kiloHost: "127.0.0.1", kiloPort: 4096 });

    const sessions = await driver.listSessions();

    expect(listMock).toHaveBeenCalledTimes(1);
    expect(sessions).toEqual([{ id: "sess-1", title: "Test" }]);
  });

  it("propagates SDK errors from sendPrompt", async () => {
    const driver = createPromptDriver({ kiloHost: "127.0.0.1", kiloPort: 4096 });
    const error = new Error("SDK prompt failed");
    promptMock.mockRejectedValueOnce(error);

    await expect(driver.sendPrompt("sess-1", "hello")).rejects.toThrow(
      "SDK prompt failed"
    );
  });
});
