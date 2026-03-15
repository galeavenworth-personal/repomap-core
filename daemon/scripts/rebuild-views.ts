#!/usr/bin/env npx tsx

import mysql from "mysql2/promise";
import { createOpencodeClient } from "@opencode-ai/sdk/client";

import { replaySessionFromLog, type ReplaySessionRecord } from "../src/lifecycle/replay.js";
import { createDoltWriter } from "../src/writer/index.js";

interface CliOptions {
  sinceHours?: number;
  truncate: boolean;
  dryRun: boolean;
  verbose: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    truncate: false,
    dryRun: false,
    verbose: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--truncate") {
      options.truncate = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--verbose") {
      options.verbose = true;
      continue;
    }
    if (arg === "--since") {
      const raw = argv[i + 1];
      if (!raw) {
        throw new Error("--since requires HOURS");
      }
      const parsed = Number.parseFloat(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid --since HOURS value: ${raw}`);
      }
      options.sinceHours = parsed;
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function resolveUpdatedMs(session: ReplaySessionRecord): number | undefined {
  const updatedMs = session.time?.updated;
  if (typeof updatedMs === "number" && Number.isFinite(updatedMs)) {
    return updatedMs;
  }

  const updatedAt = asRecord(session).updatedAt;
  if (typeof updatedAt === "string") {
    const parsed = new Date(updatedAt).getTime();
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

async function truncateDerivedTables(config: {
  host: string;
  port: number;
  database: string;
  user: string;
  password?: string;
}): Promise<void> {
  const connection = await mysql.createConnection({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
  });

  try {
    await connection.execute("SET FOREIGN_KEY_CHECKS = 0");
    const tables = ["child_rels", "tool_calls", "messages", "punches", "sessions"];
    for (const table of tables) {
      await connection.execute(`TRUNCATE TABLE ${table}`);
    }
    await connection.execute("SET FOREIGN_KEY_CHECKS = 1");
  } finally {
    await connection.end().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const kiloUrl = process.env.KILO_URL ?? "http://127.0.0.1:4096";
  const doltConfig = {
    host: process.env.DOLT_HOST ?? "127.0.0.1",
    port: Number.parseInt(process.env.DOLT_PORT ?? "3307", 10),
    database: process.env.DOLT_DATABASE || "factory",
    user: process.env.DOLT_USER || "root",
    password: process.env.DOLT_PASSWORD || undefined,
  };

  const client = createOpencodeClient({ baseUrl: kiloUrl });
  const writer = options.dryRun ? undefined : createDoltWriter(doltConfig);

  if (options.truncate && !options.dryRun) {
    console.log("[rebuild-views] Truncating derived tables before replay...");
    await truncateDerivedTables(doltConfig);
  }

  if (writer) {
    await writer.connect();
  }

  try {
    const { data: sessions, error } = await client.session.list();
    if (error) {
      throw new Error(`kilo session.list failed: ${String(error)}`);
    }

    const allSessions = Array.isArray(sessions) ? (sessions as ReplaySessionRecord[]) : [];
    const sinceMs =
      typeof options.sinceHours === "number"
        ? Date.now() - options.sinceHours * 60 * 60 * 1000
        : undefined;

    const replaySessions =
      typeof sinceMs === "number"
        ? allSessions.filter((session) => {
            const updatedMs = resolveUpdatedMs(session);
            return typeof updatedMs === "number" && updatedMs >= sinceMs;
          })
        : allSessions;

    let totalPunches = 0;
    let totalRowsWritten = 0;
    let totalMessages = 0;

    for (const session of replaySessions) {
      const result = await replaySessionFromLog(session.id, client, writer, {
        dryRun: options.dryRun,
        verbose: options.verbose,
        session,
        log: (message) => console.log(message),
      });

      totalMessages += result.messagesReplayed;
      totalPunches += result.punchesDerived;
      totalRowsWritten += result.rowsWritten;
    }

    if (writer && !options.dryRun) {
      const synced = await writer.syncChildRelsFromPunches();
      totalRowsWritten += synced;
      console.log(`[rebuild-views] child_rels synced=${synced}`);
    }

    console.log(`[rebuild-views] sessions replayed=${replaySessions.length}`);
    console.log(`[rebuild-views] messages replayed=${totalMessages}`);
    console.log(`[rebuild-views] punches derived=${totalPunches}`);
    console.log(`[rebuild-views] rows written=${totalRowsWritten}`);
    if (options.truncate) {
      console.log("[rebuild-views] truncate mode preserved punch_cards/checkpoints/compiled_prompts");
    }
  } finally {
    if (writer) {
      await writer.disconnect();
    }
  }
}

main().catch((error) => {
  console.error("[rebuild-views] Fatal:", error);
  process.exit(1);
});
