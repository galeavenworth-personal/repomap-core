/**
 * Beads JSONL ↔ Dolt sync plugin for Kilo CLI.
 *
 * Replaces git hooks (pre-commit, post-merge) with agent-event-driven sync.
 * Uses the pinned bd wrapper at .kilocode/tools/bd — never resolves via PATH.
 *
 * Lifecycle:
 *   tool.execute.before  (git commit) → bd export + git add .beads/issues.jsonl
 *   tool.execute.before  (git push)   → bd export --check (validate JSONL is current)
 *   tool.execute.after   (git pull/merge/rebase) → bd import
 *   session.idle event   → bd export (session-boundary sync)
 *
 * Coverage: All agent-initiated git operations (~90% of agentic workflow).
 * Gap: Manual `git commit` in a terminal bypasses this plugin entirely.
 *       Mitigation: `bd sync` in the landing-the-plane workflow (AGENTS.md).
 *
 * @see docs/research/beads-hooks-to-opencode-plugins-2026-02-20.md
 */

import type { Plugin } from "@kilocode/plugin";

const BD_WRAPPER = ".kilocode/tools/bd";

/**
 * Track git-relevant tool calls by callID so we can detect
 * git pull/merge/rebase completions in tool.execute.after
 * (which doesn't receive the original args).
 */
const pendingGitMergeOps = new Set<string>();

export const BeadsSyncPlugin: Plugin = async ({ $, directory }) => {
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
      `[beads-sync] bd wrapper not found at ${bd} — plugin disabled. ` +
        `Run .kilocode/tools/beads_install.sh to set up.`
    );
    return {};
  }

  return {
    // ─── Pre-commit: export Dolt → JSONL, stage it ─────────────────────
    // ─── Pre-push: validate JSONL is current ───────────────────────────
    // ─── Track git pull/merge/rebase for post-merge import ─────────────
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "bash") return;
      const cmd = output.args.command as string;

      // Pre-commit: export + stage
      if (/git\s+commit/.test(cmd)) {
        try {
          await $`${bd} export`.quiet();
          await $`git add .beads/issues.jsonl`.quiet();
        } catch (err) {
          // Never let sync failure block a commit.
          console.warn(`[beads-sync] pre-commit export failed:`, err);
        }
      }

      // Pre-push: validate
      if (/git\s+push/.test(cmd)) {
        try {
          const result = await $`${bd} export --check`.quiet();
          if (result.exitCode !== 0) {
            console.warn(
              `[beads-sync] JSONL may be out of sync with Dolt. ` +
                `Run '.kilocode/tools/bd export' to reconcile.`
            );
          }
        } catch (err) {
          // Warn but don't block push
          console.warn(`[beads-sync] pre-push check failed:`, err);
        }
      }

      // Track git pull/merge/rebase calls for post-merge import.
      // tool.execute.after doesn't receive args, so we track by callID.
      if (/git\s+(pull|merge|rebase)/.test(cmd)) {
        pendingGitMergeOps.add(input.callID);
      }
    },

    // ─── Post-merge: import JSONL → Dolt ───────────────────────────────
    "tool.execute.after": async (input) => {
      if (input.tool !== "bash") return;

      // Check if this callID was a git merge operation we tracked
      if (pendingGitMergeOps.has(input.callID)) {
        pendingGitMergeOps.delete(input.callID);
        try {
          await $`${bd} import`.quiet();
        } catch (err) {
          console.warn(`[beads-sync] post-merge import failed:`, err);
        }
      }
    },

    // ─── Session boundary sync ─────────────────────────────────────────
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        try {
          await $`${bd} export`.quiet();
        } catch {
          // Silent: session-idle sync is best-effort
        }
      }
    },
  };
};
