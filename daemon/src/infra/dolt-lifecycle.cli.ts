#!/usr/bin/env tsx
/**
 * CLI entry point for Dolt server lifecycle management.
 *
 * Usage:
 *   npx tsx daemon/src/infra/dolt-lifecycle.cli.ts [command]
 *
 * Commands:
 *   ensure   (default) Ensure the correct Dolt server is running
 *   check    Check server health status
 *   stop     Stop the Dolt server
 *
 * Exit codes:
 *   0  Success
 *   1  Server is unhealthy or failed to start
 */

import {
  checkServerHealth,
  defaultConfig,
  ensureHealthy,
  stopServer,
} from "./dolt-lifecycle.js";

const command = process.argv[2] ?? "ensure";

async function main(): Promise<number> {
  const config = defaultConfig();

  switch (command) {
    case "ensure": {
      const result = await ensureHealthy(config);
      return result.action === "failed" ? 1 : 0;
    }

    case "check":
    case "--check": {
      const status = await checkServerHealth(config);
      switch (status.state) {
        case "healthy":
          console.log(
            `✓ Dolt server running on ${config.host}:${config.port} (databases verified)`,
          );
          console.log(`  Data dir: ${config.dataDir}`);
          return 0;
        case "rogue":
          console.log(
            `⚠ Dolt server on ${config.host}:${config.port} but MISSING required databases!`,
          );
          console.log(`  Required: ${config.requiredDatabases.join(", ")}`);
          console.log(`  Missing:  ${status.missing.join(", ")}`);
          console.log(
            `  Likely a rogue server. Run: npx tsx daemon/src/infra/dolt-lifecycle.cli.ts ensure`,
          );
          return 1;
        case "down":
          console.log("✗ Dolt server not running");
          return 1;
      }
      break;
    }

    case "stop":
    case "--stop": {
      await stopServer(config);
      return 0;
    }

    case "--help":
    case "-h":
      console.log(
        "Usage: npx tsx daemon/src/infra/dolt-lifecycle.cli.ts [ensure|check|stop]",
      );
      console.log("  ensure  (default) Ensure the correct Dolt server is running");
      console.log("  check   Check server health status");
      console.log("  stop    Stop the Dolt server");
      return 0;

    default:
      console.error(`Unknown command: ${command}. Use --help for usage.`);
      return 1;
  }
  return 0;
}

const code = await main();
process.exit(code);
