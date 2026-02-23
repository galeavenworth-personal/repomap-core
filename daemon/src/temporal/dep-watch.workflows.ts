/**
 * Dependency Watch Workflow
 *
 * Scheduled workflow that checks all curated dependencies for new releases.
 * Runs on a cron schedule (default: every 6 hours) and produces a report.
 *
 * Queryable for the latest report at any time.
 */

import {
  proxyActivities,
  defineQuery,
  setHandler,
} from "@temporalio/workflow";
import type * as depActivities from "./dep-watch.activities.js";
import { WATCHLIST } from "./dep-watch.config.js";

const { checkDependencyVersion, formatReport } = proxyActivities<
  typeof depActivities
>({
  startToCloseTimeout: "2 minutes",
  retry: {
    maximumAttempts: 3,
    initialInterval: "5s",
    maximumInterval: "30s",
    backoffCoefficient: 2,
  },
});

// ── Queries ──

export interface DepWatchResult {
  checkedAt: string;
  updatesAvailable: number;
  errors: number;
  report: string;
  results: depActivities.VersionCheck[];
}

export const reportQuery = defineQuery<DepWatchResult | null>("report");

// ── Workflow ──

export async function dependencyWatchWorkflow(): Promise<DepWatchResult> {
  let lastReport: DepWatchResult | null = null;

  setHandler(reportQuery, () => lastReport);

  // Check all dependencies in parallel
  const results = await Promise.all(
    WATCHLIST.map((dep) => checkDependencyVersion(dep))
  );

  const report = {
    checkedAt: new Date().toISOString(),
    results,
    updatesAvailable: results.filter((r) => r.isNewer).length,
    errors: results.filter((r) => r.error !== null).length,
  };

  // Format human-readable report
  const formatted = await formatReport(report);

  lastReport = {
    ...report,
    report: formatted,
  };

  return lastReport;
}
