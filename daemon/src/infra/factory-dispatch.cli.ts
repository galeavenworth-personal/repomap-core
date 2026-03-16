#!/usr/bin/env tsx
/**
 * CLI entry point for Factory Dispatch.
 *
 * Usage:
 *   npx tsx daemon/src/infra/factory-dispatch.cli.ts [OPTIONS] [<prompt-file-or-string>]
 *
 * Options:
 *   -m, --mode MODE        Agent mode to dispatch to (default: plant-manager)
 *   -t, --title TITLE      Session title (default: auto-generated)
 *   -h, --host HOST        Kilo serve host (default: 127.0.0.1)
 *   -p, --port PORT        Kilo serve port (default: 4096)
 *   -w, --wait SECONDS     Max wait for completion (default: 600)
 *   -q, --quiet            Suppress progress output
 *   --card CARD_ID         Override punch card ID (bypasses mode-card-map)
 *   --bead-id BEAD_ID      Optional bead ID to thread into payload metadata
 *   --formula NAME         Formula name or path to cook and pour as a molecule
 *   --var KEY=VALUE        Variable for formula cooking (repeatable)
 *   --poll SECONDS         Poll interval (default: 10)
 *   --no-monitor           Fire and forget — print session ID and exit
 *   --json                 Output final result as JSON instead of text
 *   --help                 Show this help
 *
 * Exit codes:
 *   0  Success
 *   1  Usage error or missing dependency
 *   2  Health check failed (kilo serve not reachable)
 *   3  Session creation failed
 *   4  Prompt dispatch failed
 *   5  Timeout waiting for completion
 *   6  Session completed but no assistant response found
 */

import { defaultConfig, runDispatch } from "./factory-dispatch.js";
import { pathToFileURL } from "node:url";

function showHelp(): void {
  console.log(`Usage: npx tsx daemon/src/infra/factory-dispatch.cli.ts [OPTIONS] [<prompt>]

Prompt:
  <prompt>               Prompt string or .json payload file (optional with --formula)

Options:
  -m, --mode MODE        Agent mode to dispatch to (default: plant-manager)
  -t, --title TITLE      Session title (default: auto-generated)
  -h, --host HOST        Kilo serve host (default: 127.0.0.1)
  -p, --port PORT        Kilo serve port (default: 4096)
  -w, --wait SECONDS     Max wait for completion (default: 600)
  -q, --quiet            Suppress progress output
  --card CARD_ID         Override punch card ID (bypasses mode-card-map)
  --bead-id BEAD_ID      Optional bead ID to thread into payload metadata
  --formula <name>       Formula name or path to cook and pour as a molecule
  --var <key=value>      Variable for formula cooking (repeatable)
  --poll SECONDS         Poll interval (default: 10)
  --no-monitor           Fire and forget — print session ID and exit
  --json                 Output final result as JSON instead of text
  --help                 Show this help

Exit codes:
  0  Success
  1  Usage error or missing dependency
  2  Health check failed
  3  Session creation failed
  4  Prompt dispatch failed
  5  Timeout waiting for completion
  6  No assistant response found`);
}

export function parseArgs(argv: string[]): ReturnType<typeof defaultConfig> {
  const config = defaultConfig();
  const args = argv.slice(2); // skip node and script path

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case "-m":
      case "--mode":
        if (i + 1 >= args.length) throw new Error(`Missing value for ${arg}`);
        config.mode = args[++i];
        break;
      case "-t":
      case "--title":
        if (i + 1 >= args.length) throw new Error(`Missing value for ${arg}`);
        config.title = args[++i];
        break;
      case "-h":
      case "--host":
        if (i + 1 >= args.length) throw new Error(`Missing value for ${arg}`);
        config.host = args[++i];
        break;
      case "-p":
      case "--port":
        if (i + 1 >= args.length) throw new Error(`Missing value for ${arg}`);
        config.port = Number(args[++i]);
        break;
      case "-w":
      case "--wait":
        if (i + 1 >= args.length) throw new Error(`Missing value for ${arg}`);
        config.maxWait = Number(args[++i]);
        break;
      case "-q":
      case "--quiet":
        config.quiet = true;
        break;
      case "--poll":
        if (i + 1 >= args.length) throw new Error(`Missing value for ${arg}`);
        config.pollInterval = Number(args[++i]);
        break;
      case "--card":
        if (i + 1 >= args.length) throw new Error(`Missing value for ${arg}`);
        config.cardId = args[++i];
        break;
      case "--bead-id":
        if (i + 1 >= args.length) throw new Error(`Missing value for ${arg}`);
        config.beadId = args[++i];
        break;
      case "--formula":
        if (i + 1 >= args.length) throw new Error(`Missing value for ${arg}`);
        config.formula = args[++i];
        break;
      case "--var":
        if (i + 1 >= args.length) throw new Error(`Missing value for ${arg}`);
        config.vars.push(args[++i]);
        break;
      case "--no-monitor":
        config.noMonitor = true;
        break;
      case "--json":
        config.jsonOutput = true;
        break;
      case "--help":
        showHelp();
        process.exit(0);
        break;
      default:
        if (arg.startsWith("-")) {
          console.error(`ERROR: Unknown option: ${arg}`);
          process.exit(1);
        }
        config.promptArg = arg;
        break;
    }
    i++;
  }

  if (!config.promptArg && !config.formula) {
    console.error("ERROR: No prompt or formula provided. Use --help for usage.");
    process.exit(1);
  }

  return config;
}

async function main(): Promise<number> {
  const config = parseArgs(process.argv);
  return runDispatch(config);
}

const shouldRunAsCli =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (shouldRunAsCli) {
  const code = await main();
  process.exit(code);
}
