#!/usr/bin/env npx tsx

import { createOpencodeClient } from "@opencode-ai/sdk/client";

import { replaySessionFromLog } from "../src/lifecycle/replay.js";
import { createDoltWriter } from "../src/writer/index.js";

interface CliOptions {
  sessionId: string;
  dryRun: boolean;
  verbose: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    sessionId: "",
    dryRun: false,
    verbose: false,
  };

  for (const arg of argv) {
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--verbose") {
      options.verbose = true;
      continue;
    }
    if (!arg.startsWith("--") && !options.sessionId) {
      options.sessionId = arg;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.sessionId) {
    throw new Error("Usage: npx tsx daemon/scripts/replay-session.ts <session_id> [--dry-run] [--verbose]");
  }

  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const client = createOpencodeClient({
    baseUrl: process.env.KILO_URL ?? "http://127.0.0.1:4096",
  });

  const writer = options.dryRun
    ? undefined
    : createDoltWriter({
        host: process.env.DOLT_HOST ?? "127.0.0.1",
        port: Number.parseInt(process.env.DOLT_PORT ?? "3307", 10),
        database: process.env.DOLT_DATABASE || "factory",
        user: process.env.DOLT_USER || "root",
        password: process.env.DOLT_PASSWORD || undefined,
      });

  if (writer) {
    await writer.connect();
  }

  try {
    const result = await replaySessionFromLog(options.sessionId, client, writer, {
      dryRun: options.dryRun,
      verbose: options.verbose,
      log: (message) => console.log(message),
    });

    console.log(`[replay-session] session=${result.sessionId}`);
    console.log(`[replay-session] messages replayed=${result.messagesReplayed}`);
    console.log(`[replay-session] punches derived=${result.punchesDerived}`);
    console.log(`[replay-session] rows written=${result.rowsWritten}`);
  } finally {
    if (writer) {
      await writer.disconnect();
    }
  }
}

main().catch((error) => {
  console.error("[replay-session] Fatal:", error);
  process.exit(1);
});
