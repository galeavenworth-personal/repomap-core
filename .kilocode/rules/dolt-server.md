# Dolt Server — Session Startup Rule

## When This Applies

At the start of **every session** that uses `bd` (beads) commands. The Dolt SQL server must be running before any `bd` command will work.

## How to Start Dolt

```bash
.kilocode/tools/dolt_start.sh
```

That's it. The script is idempotent — it checks if the server is already running and skips if so.

## How to Verify

```bash
.kilocode/tools/dolt_start.sh --check
# or
.kilocode/tools/bd dolt test
```

## How to Stop

```bash
.kilocode/tools/dolt_start.sh --stop
```

## Critical Details

- **Data directory:** `~/.dolt-data/beads/` (user-global, NOT inside the repo)
- **Server:** `127.0.0.1:3307` (MySQL protocol)
- **Database:** `beads_repomap-core`
- **Config:** `.beads/config.yaml`

## What NOT to Do

- **Do NOT** run `bd dolt start` — it looks for `.beads/dolt` which does not exist
- **Do NOT** run `bd init` — the database already exists
- **Do NOT** start Dolt against `.kilocode/dolt` — that contains factory schema definitions, separate from beads
- **Do NOT** spend time debugging Dolt startup — just run the script above

## Two-Database Topology

The Dolt server hosts **two** logical databases:

1. **`beads_repomap-core`** — External dependency owned by the `bd` CLI. Hands-off: do not modify its schema or data directly. This rule file covers starting it.
2. **`factory`** — Internal factory database. Consolidates the former `punch_cards` and `plant` databases into a single canonical name. Stores: sessions, punches, messages, tool_calls, punch_cards, checkpoints, compiled_prompts. Started by `.kilocode/tools/start-stack.sh`.

The `DOLT_DATABASE` environment variable controls which database the daemon and DSPy code connect to. It defaults to `factory`.

Do NOT conflate these. `bd` commands use database 1. The daemon and DSPy use database 2.
