#!/usr/bin/env tsx
/**
 * CLI entry point for Dolt punch card schema management.
 *
 * Usage:
 *   npx tsx daemon/src/infra/dolt-schema.cli.ts [command]
 *
 * Commands:
 *   init     (default) Initialize the full punch_cards schema (8 tables, 1 view, 11 seeds)
 *   migrate  Apply SQL migration file from .kilocode/schema/
 *
 * Exit codes:
 *   0  Success
 *   1  Operation failed
 */

import {
  applyMigration,
  defaultSchemaConfig,
  initSchema,
} from "./dolt-schema.js";

const command = process.argv[2] ?? "init";

async function main(): Promise<number> {
  const config = defaultSchemaConfig();

  switch (command) {
    case "init": {
      const result = await initSchema(config);
      if (result.action === "failed") {
        console.error(`FAILED: ${result.message}`);
        return 1;
      }
      return 0;
    }

    case "migrate": {
      const migrationFile =
        process.argv[3] ?? ".kilocode/schema/punch-card-schema-migration.sql";
      const commitMessage =
        process.argv[4] ?? "Apply punch card schema migration";

      const result = await applyMigration(
        config,
        migrationFile,
        commitMessage,
      );
      if (result.action === "failed") {
        console.error(`FAILED: ${result.message}`);
        return 1;
      }
      return 0;
    }

    case "--help":
    case "-h":
      console.log(
        "Usage: npx tsx daemon/src/infra/dolt-schema.cli.ts [init|migrate]",
      );
      console.log(
        "  init     (default) Initialize the full punch_cards schema",
      );
      console.log(
        "  migrate  Apply SQL migration file from .kilocode/schema/",
      );
      console.log("");
      console.log("migrate options:");
      console.log(
        "  npx tsx daemon/src/infra/dolt-schema.cli.ts migrate [file] [commit-message]",
      );
      console.log(
        "  file defaults to: .kilocode/schema/punch-card-schema-migration.sql",
      );
      return 0;

    default:
      console.error(`Unknown command: ${command}. Use --help for usage.`);
      return 1;
  }
}

const code = await main();
process.exit(code);
