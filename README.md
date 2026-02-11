# repomap-core (staging)

This is a **staging snapshot** intended for future export into a pristine, standalone
repository.

## What it is

`repomap-core` is the **canonical core library** for deterministic repository scanning and
artifact generation.

It is also the **intended owner of the primary `repomap` CLI entrypoint** (for `generate`,
`verify`, and later `query`).

## Install

This directory is a **staging snapshot** inside a legacy monorepo.

- It is **not** published from this repository.
- Cross-repo links are intentionally omitted.

In the canonical split, the intended distribution name is `repomap-core`.

## CLI (primary entrypoint: `repomap`)

In the canonical (exported) package, `repomap-core` is intended to publish the `repomap`
console script.

Target command surface:

- `repomap generate <repo-path>` — generate deterministic analysis artifacts.
- `repomap verify <repo-path>` — verify constraints/claims against those artifacts.
- (later) `repomap query ...` — query and explore artifacts/claims.

Packaging note (staging): this monorepo snapshot may not yet include the final
console-script wiring. The statements above describe the intended publishing and CLI
story for the exported repo.

## Claims extension (optional)

Install `repomap-claims` to add claims-related subcommands under the same primary
entrypoint:

In the canonical split, the intended distribution name is `repomap-claims`.

When the extension is installed, it enables `repomap claims ...` under the same
primary CLI entrypoint.

`repomap-core` remains the owner of the `repomap` command; `repomap-claims` extends it.

## Docs / export note

This staging snapshot lives inside a monorepo, but the exported repo should be
self-contained. During export, the following documents are expected to be vendored into
the standalone repos (or replaced with equivalent in-repo references):

- Contract authority: `REPOMAP_CORE_CLAIMS_CONTRACT.md`
- Schema policy: `SCHEMA_VERSION_POLICY.md`

## Scope

Deterministic scanning, parsing, and artifact generation.
