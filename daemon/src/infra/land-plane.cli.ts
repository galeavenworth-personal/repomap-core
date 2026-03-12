#!/usr/bin/env tsx
/**
 * CLI entry point for Beads "land plane" orchestration.
 *
 * Usage:
 *   npx tsx daemon/src/infra/land-plane.cli.ts --bead-id <id> [options]
 *
 * Options:
 *   --bead-id <id>          (required) Beads task ID
 *   --skip-gates            Skip running gates; still requires audit proof exists
 *   --run-timestamp <ts>    ISO 8601 UTC timestamp (required when --skip-gates)
 *   --no-sync               Skip bd sync at the end
 *
 * Exit codes:
 *   0  Success
 *   1  Gate failure
 *   2  Gate fault or argument error
 *   3  Audit proof missing
 *   4  bd sync failure
 */

import { defaultConfig, landPlane } from "./land-plane.js";

function usage(): void {
  console.error(`Usage:
  npx tsx daemon/src/infra/land-plane.cli.ts --bead-id <id> [--skip-gates --run-timestamp <ts>] [--no-sync]

Parameters:
  --bead-id <id>   (required)
  --skip-gates     Skip running gates; still requires audit proof exists.
  --run-timestamp  ISO 8601 UTC timestamp to verify (required when --skip-gates is set)
  --no-sync        Skip bd sync at the end.`);
}

function parseArgs(argv: string[]): {
  beadId: string;
  skipGates: boolean;
  runTimestamp: string;
  noSync: boolean;
} | null {
  let beadId = "";
  let skipGates = false;
  let noSync = false;
  let runTimestamp = "";

  let i = 0;
  while (i < argv.length) {
    switch (argv[i]) {
      case "--bead-id":
        if (i + 1 >= argv.length) {
          console.error("ERROR: --bead-id requires a value");
          usage();
          return null;
        }
        beadId = argv[i + 1];
        i += 2;
        break;

      case "--skip-gates":
        skipGates = true;
        i += 1;
        break;

      case "--no-sync":
        noSync = true;
        i += 1;
        break;

      case "--run-timestamp":
        if (i + 1 >= argv.length) {
          console.error("ERROR: --run-timestamp requires a value");
          usage();
          return null;
        }
        runTimestamp = argv[i + 1];
        i += 2;
        break;

      case "-h":
      case "--help":
        usage();
        process.exit(0);
        break;

      default:
        console.error(`ERROR: unknown arg: ${argv[i]}`);
        usage();
        return null;
    }
  }

  if (!beadId) {
    console.error("ERROR: --bead-id is required");
    usage();
    return null;
  }

  if (skipGates && !runTimestamp) {
    console.error("ERROR: --skip-gates requires --run-timestamp <ts> (gate_run_signature must be specific)");
    usage();
    return null;
  }

  // If no run timestamp provided and not skipping gates, generate one
  if (!runTimestamp) {
    runTimestamp = new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z");
  }

  return { beadId, skipGates, runTimestamp, noSync };
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (args === null) {
    return 2;
  }

  const config = defaultConfig();

  const result = landPlane(
    {
      beadId: args.beadId,
      skipGates: args.skipGates,
      runTimestamp: args.runTimestamp,
      noSync: args.noSync,
    },
    config,
  );

  return result.exitCode;
}

const code = main();
process.exit(code);
