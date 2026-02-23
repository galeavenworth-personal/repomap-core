/**
 * Dependency Watch Activities
 *
 * Fetches Atom/RSS feeds from GitHub releases, parses the latest version,
 * and compares against pinned versions. Each activity is independently
 * retryable by Temporal.
 */

import { log } from "@temporalio/activity";
import { type WatchedDependency } from "./dep-watch.config.js";

export interface VersionCheck {
  name: string;
  pinnedVersion: string;
  latestVersion: string | null;
  feedUrl: string;
  isNewer: boolean;
  releaseUrl: string | null;
  releaseTitle: string | null;
  releasedAt: string | null;
  error: string | null;
}

export interface DepWatchReport {
  checkedAt: string;
  results: VersionCheck[];
  updatesAvailable: number;
  errors: number;
}

/**
 * Fetch a single dependency's Atom feed and extract the latest version.
 */
export async function checkDependencyVersion(
  dep: WatchedDependency
): Promise<VersionCheck> {
  try {
    const response = await fetch(dep.feedUrl, {
      headers: { Accept: "application/atom+xml" },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      return {
        name: dep.name,
        pinnedVersion: dep.pinnedVersion,
        latestVersion: null,
        feedUrl: dep.feedUrl,
        isNewer: false,
        releaseUrl: null,
        releaseTitle: null,
        releasedAt: null,
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    const xml = await response.text();

    // Parse the first <entry> from the Atom feed
    const titleMatch = xml.match(/<entry>[\s\S]*?<title>(.*?)<\/title>/);
    const linkMatch = xml.match(
      /<entry>[\s\S]*?<link[^>]*rel="alternate"[^>]*href="([^"]*)"[^>]*\/>/
    );
    const updatedMatch = xml.match(
      /<entry>[\s\S]*?<updated>(.*?)<\/updated>/
    );

    const rawTitle = titleMatch?.[1] ?? null;
    const releaseUrl = linkMatch?.[1] ?? null;
    const releasedAt = updatedMatch?.[1] ?? null;

    // Extract version from title (strip prefix like 'v')
    let latestVersion: string | null = null;
    if (rawTitle) {
      const prefix = dep.versionPrefix ?? "v";
      latestVersion = rawTitle.startsWith(prefix)
        ? rawTitle.slice(prefix.length)
        : rawTitle;
    }

    const isNewer =
      latestVersion !== null &&
      latestVersion !== dep.pinnedVersion &&
      compareVersions(latestVersion, dep.pinnedVersion) > 0;

    if (isNewer) {
      log.info(
        `${dep.name}: NEW VERSION ${latestVersion} (pinned: ${dep.pinnedVersion})`
      );
    } else {
      log.info(`${dep.name}: up to date (${dep.pinnedVersion})`);
    }

    return {
      name: dep.name,
      pinnedVersion: dep.pinnedVersion,
      latestVersion,
      feedUrl: dep.feedUrl,
      isNewer,
      releaseUrl,
      releaseTitle: rawTitle,
      releasedAt,
      error: null,
    };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.warn(`${dep.name}: feed check failed — ${errorMsg}`);
    return {
      name: dep.name,
      pinnedVersion: dep.pinnedVersion,
      latestVersion: null,
      feedUrl: dep.feedUrl,
      isNewer: false,
      releaseUrl: null,
      releaseTitle: null,
      releasedAt: null,
      error: errorMsg,
    };
  }
}

/**
 * Format a report as a human-readable summary.
 */
export async function formatReport(report: DepWatchReport): Promise<string> {
  const lines: string[] = [
    `# Dependency Watch Report`,
    `Checked: ${report.checkedAt}`,
    `Updates available: ${report.updatesAvailable}`,
    `Errors: ${report.errors}`,
    "",
  ];

  for (const r of report.results) {
    if (r.error) {
      lines.push(`❌ ${r.name}: ERROR — ${r.error}`);
    } else if (r.isNewer) {
      lines.push(
        `⬆️  ${r.name}: ${r.pinnedVersion} → ${r.latestVersion} (released ${r.releasedAt ?? "unknown"})`
      );
      if (r.releaseUrl) lines.push(`   ${r.releaseUrl}`);
    } else {
      lines.push(`✅ ${r.name}: ${r.pinnedVersion} (up to date)`);
    }
  }

  const summary = lines.join("\n");
  log.info(summary);
  return summary;
}

/**
 * Compare two semver-ish version strings.
 * Returns >0 if a > b, <0 if a < b, 0 if equal.
 */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  const len = Math.max(pa.length, pb.length);

  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}
