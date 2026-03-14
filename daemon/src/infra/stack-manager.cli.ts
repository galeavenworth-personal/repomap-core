#!/usr/bin/env tsx
/**
 * CLI entry point for stack manager.
 *
 * Usage:
 *   npx tsx daemon/src/infra/stack-manager.cli.ts [command]
 *
 * Commands:
 *   start      (default) Ensure full stack is running (starts kilo serve if needed)
 *   ensure     Alias for start
 *   check      Check stack health status
 *   stop       Stop managed components
 *   with-kilo  Alias for start
 *
 * Exit codes:
 *   0  Success / stack healthy
 *   1  Stack unhealthy or failed to start
 *
 * See: repomap-core-76q.2
 */

import {
  checkStack,
  defaultConfig,
  ensureStack,
  stopStack,
  type StackConfig,
} from "./stack-manager.js";

const command = process.argv[2] ?? "start";

async function runEnsureStack(config: StackConfig): Promise<number> {
  const result = await ensureStack(config);
  if (result.action === "failed") {
    for (const err of result.errors) {
      console.error(`ERROR: ${err}`);
    }
    return 1;
  }
  return 0;
}

async function main(): Promise<number> {
  const config: StackConfig = defaultConfig();

  switch (command) {
    case "check":
    case "--check": {
      const health = await checkStack(config);
      for (const c of health.components) {
        const icon = c.ok ? "✅" : "❌";
        console.log(`${icon} ${c.name}: ${c.detail}`);
      }
      console.log("");
      if (health.ok) {
        console.log(`Stack is healthy. (${health.healthy}/${health.total} components)`);
        return 0;
      }
      console.log(`Stack is NOT healthy. (${health.healthy}/${health.total} components)`);
      return 1;
    }

    case "ensure":
    case "--ensure":
    case "start":
    case "with-kilo":
    case "--with-kilo": {
      return runEnsureStack(config);
    }

    case "stop":
    case "--stop": {
      await stopStack(config);
      return 0;
    }

    case "--help":
    case "-h":
      console.log("Usage: npx tsx daemon/src/infra/stack-manager.cli.ts [command]");
      console.log("  start      (default) Idempotent full stack startup (all 5 components)");
      console.log("  check      Check stack health status");
      console.log("  stop       Stop managed components");
      return 0;

    default:
      console.error(`Unknown command: ${command}. Use --help for usage.`);
      return 1;
  }
}

const code = await main();
process.exit(code);
