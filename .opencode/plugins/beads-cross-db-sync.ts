/**
 * Beads cross-DB status sync plugin for Kilo CLI.
 *
 * Propagates issue status changes (close, update) across Beads databases
 * so that multi-clone setups (e.g. Windsurf + Kilo) stay in sync without
 * requiring a full `bd sync` round-trip through the beads-sync branch.
 *
 * Hooks:
 *   tool.execute.before — captures `bd close|update <id>` invocations
 *   tool.execute.after  — reads authoritative state from current DB,
 *                          then propagates to all peer DBs via Dolt SQL
 *
 * Assumptions:
 *   - Local Dolt SQL server running at 127.0.0.1:3307 (no auth)
 *   - Beads databases follow `beads_<prefix>` naming convention
 *   - Peer prefixes are listed in the `routes` table of the current DB
 *
 * Relationship to beads-sync.ts:
 *   beads-sync.ts handles JSONL ↔ Dolt export/import around git operations.
 *   This plugin handles cross-DB propagation of issue state changes.
 *
 * Limitations:
 *   - Hooks execute sequentially; propagation adds latency per peer DB
 *   - Local-only: does not push to remote or trigger beads-sync branch updates
 */
import type { Plugin } from "@kilocode/plugin";

const BD_WRAPPER = ".kilocode/tools/bd";

const pendingBdStatusOps = new Map<string, string>();

type IssueState = {
  status: string;
  closedAt: string | null;
  closeReason: string | null;
  updatedAt: string;
};

const parseCsvRows = (stdout: string): string[][] => {
  return stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => line.split(","));
};

const outputToString = (result: unknown): string => {
  if (typeof result === "string") return result;

  const maybeStdout = (result as { stdout?: unknown } | undefined)?.stdout;
  if (typeof maybeStdout === "string") return maybeStdout;

  if (maybeStdout instanceof Uint8Array) {
    return new TextDecoder().decode(maybeStdout);
  }

  if (
    maybeStdout !== null &&
    typeof maybeStdout === "object" &&
    "toString" in (maybeStdout as Record<string, unknown>)
  ) {
    return (maybeStdout as { toString: () => string }).toString();
  }

  return "";
};

const readIssuePrefix = async (
  catConfig: () => Promise<unknown>
): Promise<string | null> => {
  try {
    const configRaw = outputToString(await catConfig());
    const match = configRaw.match(/^\s*issue-prefix:\s*"?([^"\n#]+)"?\s*$/m);
    return match?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
};

const sqlEscape = (value: string): string => value.replace(/'/g, "''");

const sqlString = (value: string): string => `'${sqlEscape(value)}'`;

const sqlNullableString = (value: string | null): string =>
  value === null ? "NULL" : sqlString(value);

const sqlIdentifier = (value: string): string => `\`${value.replace(/`/g, "``")}\``;

const normalizeCell = (value: string | undefined): string | null => {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed || /^null$/i.test(trimmed)) return null;
  return trimmed;
};

const isValidPrefix = (s: string): boolean => /^[A-Za-z][A-Za-z0-9_-]*$/.test(s);

const extractBdStatusIssueId = (command: string): string | null => {
  const match = command.match(
    /(?:^|[\s;&|])(?:\S*\/)?bd\s+(?:close|update)\s+([A-Za-z][A-Za-z0-9-]*)\b/
  );
  return match?.[1] ?? null;
};

export const BeadsCrossDbSyncPlugin: Plugin = async ({ $, directory }) => {
  const bd = `${directory}/${BD_WRAPPER}`;

  // Preflight: verify the bd wrapper is present and executable.
  // If not, the plugin degrades to a no-op rather than crashing the server.
  let bdAvailable = false;
  try {
    const check = await $`test -x ${bd}`.quiet();
    bdAvailable = check.exitCode === 0;
  } catch {
    bdAvailable = false;
  }

  if (!bdAvailable) {
    console.warn(
      `[beads-cross-db-sync] bd wrapper not found at ${bd} — plugin disabled. ` +
        `See AGENTS.md for Beads setup instructions.`
    );
    return {};
  }

  const doltSql = (query: string) =>
    $`DOLT_CLI_PASSWORD="" timeout 30s dolt --host 127.0.0.1 --port 3307 --user root --no-tls sql --result-format csv -q ${query}`.quiet();

  const readIssueState = async (
    currentPrefix: string,
    issueId: string
  ): Promise<IssueState | null> => {
    const dbName = `beads_${currentPrefix}`;
    const query =
      `USE ${sqlIdentifier(dbName)}; ` +
      `SELECT status, closed_at, close_reason, updated_at FROM issues ` +
      `WHERE id = ${sqlString(issueId)};`;

    const result = await doltSql(query);
    const rows = parseCsvRows(outputToString(result));
    if (rows.length < 2) return null;

    const firstDataRow = rows[1];
    if (firstDataRow.length < 4) return null;
    const status = normalizeCell(firstDataRow[0]);
    const updatedAt = normalizeCell(firstDataRow[3]);

    if (!status || !updatedAt) {
      return null;
    }

    return {
      status,
      closedAt: normalizeCell(firstDataRow[1]),
      closeReason: normalizeCell(firstDataRow[2]),
      updatedAt,
    };
  };

  const readPeerPrefixes = async (currentPrefix: string): Promise<string[]> => {
    const dbName = `beads_${currentPrefix}`;
    const query = `USE ${sqlIdentifier(dbName)}; SELECT prefix FROM routes;`;

    const result = await doltSql(query);
    const rows = parseCsvRows(outputToString(result));
    if (rows.length < 2) return [];

    const prefixes = rows
      .slice(1)
      .map((row) => normalizeCell(row[0]))
      .filter((prefix): prefix is string => prefix !== null && isValidPrefix(prefix));

    return [...new Set(prefixes)];
  };

  const propagateIssueState = async (
    issueId: string,
    state: IssueState,
    peerPrefixes: string[]
  ): Promise<void> => {
    for (const peerPrefix of peerPrefixes) {
      try {
        const dbName = `beads_${peerPrefix}`;
        const updateQuery =
          `USE ${sqlIdentifier(dbName)}; ` +
          `UPDATE issues SET ` +
          `status=${sqlString(state.status)}, ` +
          `closed_at=${sqlNullableString(state.closedAt)}, ` +
          `close_reason=${sqlNullableString(state.closeReason)}, ` +
          `updated_at=${sqlString(state.updatedAt)} ` +
          `WHERE id = ${sqlString(issueId)};`;

        await doltSql(updateQuery);

        // Check if there are actual changes to commit
        const statusQuery =
          `USE ${sqlIdentifier(dbName)}; ` +
          `SELECT * FROM dolt_status;`;
        const statusResult = await doltSql(statusQuery);
        const statusRows = parseCsvRows(outputToString(statusResult));
        if (statusRows.length < 2) {
          // No changes in working set — skip commit
          continue;
        }

        try {
          const commitQuery =
            `USE ${sqlIdentifier(dbName)}; ` +
            `CALL dolt_commit('-Am', ${sqlString(
              `cross-db-sync: ${issueId} status=${state.status}`
            )});`;
          await doltSql(commitQuery);
        } catch (commitErr) {
          const msg = String(commitErr);
          if (msg.includes("nothing to commit")) {
            // Expected when issue state is already in sync
            continue;
          }
          throw commitErr;
        }
      } catch (err) {
        console.warn(
          `[beads-cross-db-sync] failed syncing ${issueId} to ${peerPrefix}:`,
          err
        );
      }
    }
  };

  return {
    "tool.execute.before": async (input) => {
      if (input.tool !== "bash") return;
      const cmd =
        (((input as Record<string, unknown>).args as
          | Record<string, unknown>
          | undefined)?.command as string) ?? "";

      const issueId = extractBdStatusIssueId(cmd);
      if (issueId) {
        pendingBdStatusOps.set(input.callID, issueId);
      }
    },

    "tool.execute.after": async (input) => {
      if (input.tool !== "bash") return;

      const issueId = pendingBdStatusOps.get(input.callID);
      if (!issueId) return;
      pendingBdStatusOps.delete(input.callID);

      try {
        const exitCode =
          ((input as Record<string, unknown>).output as
            | Record<string, unknown>
            | undefined)?.exitCode;
        if (typeof exitCode !== "number" || exitCode !== 0) {
          return;
        }

        const currentPrefix = await readIssuePrefix(() =>
          $`cat ${`${directory}/.beads/config.yaml`}`.quiet()
        );
        if (!currentPrefix || !isValidPrefix(currentPrefix)) {
          console.warn(
            `[beads-cross-db-sync] unable to read issue-prefix from .beads/config.yaml`
          );
          return;
        }

        const issueState = await readIssueState(currentPrefix, issueId);
        if (!issueState) {
          console.warn(
            `[beads-cross-db-sync] issue ${issueId} not found in beads_${currentPrefix}; skipping propagation`
          );
          return;
        }

        const peerPrefixes = (await readPeerPrefixes(currentPrefix)).filter(
          (prefix) => prefix !== currentPrefix
        );
        if (peerPrefixes.length === 0) return;

        await propagateIssueState(issueId, issueState, peerPrefixes);
      } catch (err) {
        // Never let cross-db sync failure block the original tool operation.
        console.warn(`[beads-cross-db-sync] post-exec sync failed:`, err);
      }
    },
  };
};
