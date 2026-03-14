#!/usr/bin/env npx tsx
/**
 * Backfill Dolt telemetry from kilo serve session data for an epic run.
 *
 * Usage:
 *   npx tsx scripts/backfill-epic.ts <EPIC_PARENT_ID> <DECOMP_PARENT_ID>
 *   npx tsx scripts/backfill-epic.ts                  # uses env vars
 *
 * Environment variables (fallback when no CLI args):
 *   EPIC_PARENT   — execution parent session ID
 *   DECOMP_PARENT — decomposition parent session ID
 *   KILO_URL      — kilo serve base URL  (default: http://127.0.0.1:4096)
 *   DOLT_HOST     — Dolt host            (default: 127.0.0.1)
 *   DOLT_PORT     — Dolt port            (default: 3307)
 *   DOLT_DATABASE — Dolt database        (default: factory)
 *
 * Pulls session metadata, messages, and parts from the kilo serve REST API
 * and writes them to Dolt via the same writer the daemon uses.
 *
 * IMPORTANT: Per-session costs are computed by summing the cost field across
 * all assistant turns, NOT by taking the last turn's cumulative snapshot.
 * The kilo message API reports per-turn cost on each assistant message's
 * info.cost field. These must be summed to get the true session total.
 */

import { createOpencodeClient } from "@opencode-ai/sdk/client";
import { createDoltWriter } from "../src/writer/index.js";
import { classifyEvent } from "../src/classifier/index.js";

// ── Config ──────────────────────────────────────────────────────────
const KILO_URL = process.env.KILO_URL ?? "http://127.0.0.1:4096";
const DOLT_HOST = process.env.DOLT_HOST ?? "127.0.0.1";
const DOLT_PORT = Number(process.env.DOLT_PORT ?? "3307");
const DOLT_DB = process.env.DOLT_DATABASE || "factory";

// Session IDs: prefer CLI args, fall back to env vars
const EPIC_PARENT = process.argv[2] ?? process.env.EPIC_PARENT;
const DECOMP_PARENT = process.argv[3] ?? process.env.DECOMP_PARENT;

if (!EPIC_PARENT || !DECOMP_PARENT) {
  console.error(
    "Usage: npx tsx scripts/backfill-epic.ts <EPIC_PARENT_ID> <DECOMP_PARENT_ID>"
  );
  console.error(
    "  Or set EPIC_PARENT and DECOMP_PARENT environment variables."
  );
  process.exit(1);
}

// ── Helpers ─────────────────────────────────────────────────────────
function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function pickNumber(
  r: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const k of keys) {
    const v = r[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

function pickString(
  r: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const k of keys) {
    const v = r[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function pickTimestamp(record: Record<string, unknown>): number {
  const ts = pickNumber(record, "ts", "timestamp", "createdAtMs");
  if (typeof ts === "number") return ts;
  const timeObj = record.time;
  if (timeObj && typeof timeObj === "object") {
    const t = timeObj as Record<string, unknown>;
    const nested = pickNumber(
      t,
      "start",
      "end",
      "created",
      "updated",
      "completed"
    );
    if (typeof nested === "number") return nested;
  }
  return Date.now();
}

interface KiloSession {
  id: string;
  parentID?: string;
  title?: string;
  time?: { created?: number; updated?: number };
  summary?: { additions?: number; deletions?: number; files?: number };
  [key: string]: unknown;
}

/** Accumulated cost/token totals for a session, summed across assistant turns. */
interface SessionAccumulator {
  totalCost: number;
  tokensIn: number;
  tokensOut: number;
  tokensReasoning: number;
  mode?: string;
  model?: string;
  status?: string;
  outcome?: string;
  completedAt?: Date;
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  const client = createOpencodeClient({ baseUrl: KILO_URL });
  const writer = createDoltWriter({
    host: DOLT_HOST,
    port: DOLT_PORT,
    database: DOLT_DB,
  });

  await writer.connect();
  console.log(
    `[backfill] Connected to Dolt at ${DOLT_HOST}:${DOLT_PORT}/${DOLT_DB}`
  );
  console.log(`[backfill] Epic parent:   ${EPIC_PARENT}`);
  console.log(`[backfill] Decomp parent: ${DECOMP_PARENT}`);

  // 1. List all sessions, filter to epic tree
  const { data: allSessions, error: listErr } = await client.session.list();
  if (listErr || !allSessions) {
    console.error("[backfill] Failed to list sessions:", listErr);
    process.exit(1);
  }

  const sessions = (allSessions as unknown as KiloSession[]).filter((s) => {
    return (
      s.id === EPIC_PARENT ||
      s.id === DECOMP_PARENT ||
      s.parentID === EPIC_PARENT ||
      s.parentID === DECOMP_PARENT
    );
  });

  console.log(`[backfill] Found ${sessions.length} epic sessions to backfill`);

  let totalPunches = 0;
  let totalMessages = 0;
  let totalToolCalls = 0;
  let totalSessions = 0;
  let totalChildren = 0;
  let totalCostAllSessions = 0;

  for (const session of sessions) {
    const sid = session.id;
    const createdMs = session.time?.created;
    const title = session.title ?? "(untitled)";
    console.log(
      `\n[backfill] Processing: ${sid} — ${title.slice(0, 60)}`
    );

    // 2. Write initial session row (metadata only, no cost yet)
    await writer.writeSession({
      sessionId: sid,
      taskId: sid,
      startedAt: createdMs ? new Date(createdMs) : undefined,
    });
    totalSessions++;

    // 3. Write parent→child relationship
    if (session.parentID) {
      await writer.writeChildRelation(session.parentID, sid);
      totalChildren++;
    }

    // 4. Emit synthetic lifecycle punches
    const createdPunch = classifyEvent({
      type: "session.created",
      properties: { info: session },
    });
    if (createdPunch) {
      await writer.writePunch(createdPunch);
      totalPunches++;
    }

    const updatedPunch = classifyEvent({
      type: "session.updated",
      properties: { info: session },
    });
    if (updatedPunch) {
      await writer.writePunch(updatedPunch);
      totalPunches++;
    }

    // 5. Fetch messages for this session
    let messages: unknown[] = [];
    try {
      const { data: msgs, error: msgErr } = await client.session.messages({
        path: { id: sid },
      });
      if (!msgErr && msgs) {
        messages = msgs as unknown[];
      }
    } catch (e) {
      console.warn(
        `[backfill]   ⚠ Could not fetch messages for ${sid}:`,
        e
      );
    }

    console.log(`[backfill]   ${messages.length} messages`);

    // 6. Process messages — accumulate costs across all assistant turns
    const acc: SessionAccumulator = {
      totalCost: 0,
      tokensIn: 0,
      tokensOut: 0,
      tokensReasoning: 0,
    };

    for (const msg of messages) {
      const msgWrapper = asRecord(msg);
      const msgInfo = asRecord(msgWrapper.info);
      const role = pickString(msgInfo, "role") ?? "assistant";

      if (role === "assistant") {
        // Sum per-turn cost and tokens into the accumulator
        const turnCost = pickNumber(msgInfo, "cost") ?? 0;
        const tokens = asRecord(msgInfo.tokens);
        const turnIn = pickNumber(tokens, "input") ?? 0;
        const turnOut = pickNumber(tokens, "output") ?? 0;
        const turnReasoning = pickNumber(tokens, "reasoning") ?? 0;

        acc.totalCost += turnCost;
        acc.tokensIn += turnIn;
        acc.tokensOut += turnOut;
        acc.tokensReasoning += turnReasoning;

        // Keep last non-null values for metadata fields
        acc.mode = pickString(msgInfo, "mode") ?? acc.mode;
        acc.model = pickString(msgInfo, "modelID") ?? acc.model;

        const finish = pickString(msgInfo, "finish");
        if (finish) {
          acc.outcome = finish;
          acc.status = finish === "end" ? "completed" : finish;

          const timeObj = asRecord(msgInfo.time);
          const completedMs = pickNumber(timeObj, "completed");
          if (completedMs) acc.completedAt = new Date(completedMs);

          // Classify as message.updated for punch tracking
          const msgPunch = classifyEvent({
            type: "message.updated",
            properties: { info: { ...msgInfo, sessionID: sid } },
          });
          if (msgPunch) {
            await writer.writePunch(msgPunch);
            totalPunches++;
          }
        }
      }

      // 7. Process message parts (text messages, tool calls)
      const parts = (msgWrapper.parts as unknown[]) ?? [];
      for (const part of parts) {
        const partRec = asRecord(part);
        const partType = pickString(partRec, "type");

        const punch = classifyEvent({
          type: "message.part.updated",
          properties: { part: { ...partRec, sessionID: sid } },
        });
        if (punch) {
          await writer.writePunch(punch);
          totalPunches++;
        }

        // Write text messages
        if (partType === "text") {
          const text = pickString(partRec, "text", "content") ?? "";
          await writer.writeMessage({
            sessionId: sid,
            role: pickString(partRec, "role") ?? role,
            contentType: "text",
            contentPreview: text.slice(0, 512),
            ts: pickTimestamp(partRec),
            cost: pickNumber(partRec, "cost") ?? punch?.cost,
            tokensIn:
              pickNumber(asRecord(partRec.tokens), "input") ??
              punch?.tokensInput,
            tokensOut:
              pickNumber(asRecord(partRec.tokens), "output") ??
              punch?.tokensOutput,
          });
          totalMessages++;
        }

        // Write tool calls
        if (partType === "tool") {
          const state = asRecord(partRec.state);
          const toolName =
            pickString(partRec, "tool") ?? punch?.punchKey ?? "unknown_tool";
          const stateTime = asRecord(state.time);
          const startMs = pickNumber(stateTime, "start");
          const endMs = pickNumber(stateTime, "end");
          const durationMs =
            startMs && endMs
              ? endMs - startMs
              : pickNumber(partRec, "durationMs");

          await writer.writeToolCall({
            sessionId: sid,
            toolName,
            argsSummary: state.input
              ? JSON.stringify(state.input).slice(0, 1024)
              : undefined,
            status: pickString(state, "status"),
            error: pickString(state, "error"),
            durationMs,
            cost: punch?.cost,
            ts: pickTimestamp(partRec),
          });
          totalToolCalls++;
        }
      }
    }

    // 8. Write final session row with SUMMED costs
    await writer.writeSession({
      sessionId: sid,
      taskId: sid,
      mode: acc.mode,
      model: acc.model,
      status: acc.status,
      totalCost: acc.totalCost > 0 ? acc.totalCost : undefined,
      tokensIn: acc.tokensIn > 0 ? acc.tokensIn : undefined,
      tokensOut: acc.tokensOut > 0 ? acc.tokensOut : undefined,
      tokensReasoning: acc.tokensReasoning > 0 ? acc.tokensReasoning : undefined,
      completedAt: acc.completedAt,
      outcome: acc.outcome,
    });

    totalCostAllSessions += acc.totalCost;
    console.log(
      `[backfill]   cost=$${acc.totalCost.toFixed(4)} | in=${acc.tokensIn.toLocaleString()} | out=${acc.tokensOut.toLocaleString()}`
    );
  }

  // 9. Sync child_rels from punches
  const synced = await writer.syncChildRelsFromPunches();

  await writer.disconnect();

  console.log("\n[backfill] ═══════════════════════════════════════");
  console.log(`[backfill] Sessions:     ${totalSessions}`);
  console.log(`[backfill] Children:     ${totalChildren}`);
  console.log(`[backfill] Punches:      ${totalPunches}`);
  console.log(`[backfill] Messages:     ${totalMessages}`);
  console.log(`[backfill] Tool calls:   ${totalToolCalls}`);
  console.log(`[backfill] Child rels:   ${synced} (from punch sync)`);
  console.log(
    `[backfill] Total cost:   $${totalCostAllSessions.toFixed(4)} (summed across all turns)`
  );
  console.log("[backfill] ═══════════════════════════════════════");
  console.log("[backfill] Done.");
}

main().catch((err) => {
  console.error("[backfill] Fatal:", err);
  process.exit(1);
});
