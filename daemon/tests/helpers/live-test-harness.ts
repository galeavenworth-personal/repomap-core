import mysql from "mysql2/promise";

import { isSessionTerminal } from "./session-completion.js";

export const KILO_HOST = process.env.KILO_HOST ?? "127.0.0.1";
export const KILO_PORT = Number.parseInt(process.env.KILO_PORT ?? "4096", 10);
export const BASE_URL = `http://${KILO_HOST}:${KILO_PORT}`;
export const DOLT_HOST = process.env.DOLT_HOST ?? "127.0.0.1";
export const DOLT_PORT = Number.parseInt(process.env.DOLT_PORT ?? "3307", 10);
export const DOLT_DB = process.env.DOLT_DATABASE ?? "factory";
export const SKIP_LIVE = !process.env.KILO_LIVE;

export const DOLT_CONN_CONFIG = {
  host: DOLT_HOST,
  port: DOLT_PORT,
  database: DOLT_DB,
  user: "root",
} as const;

export function kiloUrl(path: string): string {
  return `${BASE_URL}${path}`;
}

export async function pollUntilComplete(sessionId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const response = await fetch(kiloUrl(`/session/${sessionId}/message`));
    if (!response.ok) continue;
    const messages = (await response.json()) as Array<Record<string, unknown>>;
    if (isSessionTerminal(messages)) return;
  }
  throw new Error(`Session ${sessionId} did not complete within ${timeoutMs}ms`);
}

export async function assertKiloReachable(): Promise<void> {
  const res = await fetch(kiloUrl("/session")).catch(() => null);
  if (!res?.ok) {
    throw new Error(`kilo serve not reachable at ${BASE_URL}`);
  }
}

export async function createDoltConnection(): Promise<mysql.Connection> {
  return mysql.createConnection(DOLT_CONN_CONFIG);
}

/**
 * Creates a mock kilo client whose session.messages returns a single
 * completed edit_file tool call — useful for negative validation tests
 * that expect a forbidden-punch violation.
 */
export function makeForbiddenEditClient() {
  return {
    session: {
      messages: async () => ({
        data: [
          {
            parts: [
              {
                type: "tool",
                tool: "edit_file",
                state: { status: "completed" },
              },
            ],
          },
        ],
      }),
    },
  };
}
