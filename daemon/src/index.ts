/**
 * oc-daemon — OpenCode Replication Daemon
 *
 * Connects to a running `kilo serve` instance via SSE event stream,
 * classifies session events into punch types, and writes punches to Dolt.
 *
 * Architecture:
 *   kilo serve (SSE) → Event Classifier → Punch Minter → Dolt Writer
 *
 * Dependencies:
 *   - @opencode-ai/sdk: Type-safe client for kilo serve HTTP API
 *   - mysql2: Dolt wire-protocol client (MySQL compatible)
 *
 * Related:
 *   - Schema: ../.kilocode/schema/punch-card-schema.sql
 *   - Research: ../docs/research/kilo-cli-server-daemon-integration-2026-02-19.md
 */

import { createDaemon } from "./lifecycle/daemon.js";

const daemon = createDaemon({
  kiloPort: parseInt(process.env.KILO_PORT || "4096", 10),
  kiloHost: process.env.KILO_HOST || "127.0.0.1",
  doltPort: parseInt(process.env.DOLT_PORT || "3307", 10),
  doltHost: process.env.DOLT_HOST || "127.0.0.1",
  doltDatabase: process.env.DOLT_DATABASE || "plant",
  doltUser: process.env.DOLT_USER || "root",
  doltPassword: process.env.DOLT_PASSWORD || undefined,
});

// Register signal handlers BEFORE starting the blocking SSE loop,
// otherwise they'd only fire after start() returns (which blocks on for-await).
process.on("SIGINT", () => daemon.stop());
process.on("SIGTERM", () => daemon.stop());

await daemon.start();
