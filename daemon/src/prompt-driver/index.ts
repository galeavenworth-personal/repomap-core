import { createOpencodeClient, type Config } from "@opencode-ai/sdk/client";

export interface PromptDriverConfig {
  kiloPort: number;
  kiloHost: string;
}

export interface PromptDriver {
  sendPrompt(
    sessionId: string,
    content: string,
    options?: {
      agent?: string;
      noReply?: boolean;
    }
  ): Promise<void>;

  executeCommand(sessionId: string, command: string): Promise<void>;

  updateConfig(config: Record<string, unknown>): Promise<void>;

  listSessions(): Promise<Array<{ id: string; [key: string]: unknown }>>;
}

export function createPromptDriver(config: PromptDriverConfig): PromptDriver {
  const client = createOpencodeClient({
    baseUrl: `http://${config.kiloHost}:${config.kiloPort}`,
  });

  return {
    async sendPrompt(sessionId, content, options) {
      await client.session.prompt({
        path: { id: sessionId },
        body: {
          parts: [{ type: "text", text: content }],
          agent: options?.agent,
          noReply: options?.noReply,
        },
      });
    },

    async executeCommand(sessionId, command) {
      if (!command || command.trim().length === 0) {
        throw new Error("Command string cannot be empty");
      }
      const firstSpaceIndex = command.indexOf(" ");
      const parsedCommand =
        firstSpaceIndex === -1 ? command : command.slice(0, firstSpaceIndex);
      const args =
        firstSpaceIndex === -1 ? "" : command.slice(firstSpaceIndex + 1);

      await client.session.command({
        path: { id: sessionId },
        body: {
          command: parsedCommand,
          arguments: args,
        },
      });
    },

    async updateConfig(newConfig) {
      await client.config.update({
        /**
         * Cast to unknown then Config is necessary because the SDK expects a strict Config type,
         * but we are passing a partial or loose configuration object.
         */
        body: newConfig as unknown as Config,
      });
    },

    async listSessions() {
      const response = await client.session.list();
      return (response.data ?? []).map((session) => ({
        ...(session as Record<string, unknown>),
        id: (session as { id: string }).id,
      }));
    },
  };
}
