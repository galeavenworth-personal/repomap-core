/**
 * Dependency Watchlist Configuration
 *
 * Curated list of hard dependencies with their Atom feed URLs and
 * currently pinned versions. The dependency watch workflow checks
 * these feeds on a schedule and alerts when new versions are available.
 */

export interface WatchedDependency {
  name: string;
  feedUrl: string;
  pinnedVersion: string;
  /** How to extract version from the Atom entry title (default: strip leading 'v') */
  versionPrefix?: string;
  /** npm package name, if applicable (for cross-referencing) */
  npmPackage?: string;
  /** Notes about this dependency */
  notes?: string;
}

export const WATCHLIST: WatchedDependency[] = [
  {
    name: "beads",
    feedUrl: "https://github.com/steveyegge/beads/releases.atom",
    pinnedVersion: "0.55.4",
    versionPrefix: "v",
    notes: "AI-coded issue tracker. Moves fast — breaking changes in hooks, Dolt backend, CGO builds.",
  },
  {
    name: "kilo-cli",
    feedUrl: "https://github.com/Kilo-Org/kilocode/releases.atom",
    pinnedVersion: "7.0.27",
    versionPrefix: "v",
    notes: "Forked from opencode. Model registry, serve API, auth changes.",
  },
  {
    name: "@opencode-ai/sdk",
    feedUrl: "https://github.com/opencode-ai/opencode/releases.atom",
    pinnedVersion: "1.2.10",
    versionPrefix: "v",
    npmPackage: "@opencode-ai/sdk",
    notes: "TypeScript SDK for kilo serve HTTP API. Session API shape, SSE event types.",
  },
  {
    name: "@temporalio/sdk",
    feedUrl: "https://github.com/temporalio/sdk-typescript/releases.atom",
    pinnedVersion: "1.11.0",
    versionPrefix: "v",
    npmPackage: "@temporalio/worker",
    notes: "Durable execution platform. Native Rust bridge = platform-sensitive.",
  },
];
