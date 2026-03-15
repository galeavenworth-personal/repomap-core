# Checkpoint: 1ax.2-pour-and-dispatch

**Task:** repomap-core-1ax.2
**Date:** 2026-03-14

## Summary

Validated the full lifecycle from cook to pour to dispatch and confirmed persistence in the `factory.tasks` table with explicit `bead_id` linkage. The dispatch row exists for `task_id=ses_31216871dffe0B7H56ooxHv3X1` and links to `bead_id=repomap-core-mol-srx8`. Molecule structure remains intact post-dispatch, and the build-ledger step bead remains open.

## Phase 1: Cook validation (compile + runtime dry-run + runtime JSON output)

Cook compile dry-run:

```text
Dry run: would cook formula respond_to_pr_review as proto respond_to_pr_review (compile-time mode)

Steps (3) [{{variables}} shown as placeholders]:
  ├── build-ledger: Build ledger [from: respond_to_pr_review@steps[0]]
  ├── fix-items: Fix items [depends: build-ledger] [from: respond_to_pr_review@steps[1]]
  └── acknowledge-ledger: Acknowledge ledger [depends: fix-items] [from: respond_to_pr_review@steps[2]]

Variables used: pr_number, owner_repo, head_ref_name, bead_id
```

Cook runtime dry-run:

```text
Dry run: would cook formula respond_to_pr_review as proto respond_to_pr_review (runtime mode)

Steps (3) [variables substituted]:
  ├── build-ledger: Build ledger [from: respond_to_pr_review@steps[0]]
  ├── fix-items: Fix items [depends: build-ledger] [from: respond_to_pr_review@steps[1]]
  └── acknowledge-ledger: Acknowledge ledger [depends: fix-items] [from: respond_to_pr_review@steps[2]]

Variables used: pr_number, owner_repo, head_ref_name, bead_id

Variable values:
  {{bead_id}} = test-bead
  {{pr_number}} = 999
  {{owner_repo}} = test/repo
  {{head_ref_name}} = test-branch
```

Cook runtime JSON (full output):

```json
{
  "formula": "respond_to_pr_review",
  "description": "Respond to PR review feedback: build ledger, fix items, acknowledge",
  "version": 1,
  "type": "workflow",
  "steps": [
    {
      "id": "build-ledger",
      "title": "Build ledger",
      "description": "Build Comment Ledger for PR 999 in test/repo including SonarQube quality gate status",
      "labels": ["mode:pr-review", "card:build-pr-ledger", "phase:1"]
    },
    {
      "id": "fix-items",
      "title": "Fix items",
      "description": "Fix ledger items marked disposition=fix for PR 999 in test/repo on head test-branch",
      "labels": ["mode:code", "card:execute-subtask", "phase:2"],
      "depends_on": ["build-ledger"]
    },
    {
      "id": "acknowledge-ledger",
      "title": "Acknowledge ledger",
      "description": "Reply to each review comment for PR 999 in test/repo with fix references and bead test-bead context",
      "labels": ["mode:pr-review", "card:acknowledge-pr-ledger", "phase:3"],
      "depends_on": ["fix-items"]
    }
  ],
  "source": "/home/galeavenworth/Projects-Employee-1/repomap-core/.beads/formulas/respond-to-pr-review.formula.json"
}
```

## Phase 2: Pour + molecule structure

Pour output:

```text
✓ Poured mol: created 4 issues
  Root issue: repomap-core-mol-d9jz
  Phase: liquid (persistent in .beads/)
```

Mol show (human-readable):

```text
🧪 Molecule: respond_to_pr_review
   ID: repomap-core-mol-d9jz
   Steps: 4

🌲 Structure:
   respond_to_pr_review (root)
   ├── Acknowledge ledger
   ├── Build ledger
   └── Fix items
```

Children output:

```text
○ repomap-core-mol-d9jz ● P2 [epic] respond_to_pr_review
├── ○ repomap-core-mol-cpnd ● P2 Acknowledge ledger
├── ○ repomap-core-mol-srx8 ● P2 Build ledger
└── ○ repomap-core-mol-wi63 ● P2 Fix items

Total: 4 issues (4 open, 0 in progress)
```

Resolved IDs and dependency chain:

- Molecule ID: `repomap-core-mol-d9jz`
- Step bead IDs:
  - `build-ledger` -> `repomap-core-mol-srx8`
  - `fix-items` -> `repomap-core-mol-wi63`
  - `acknowledge-ledger` -> `repomap-core-mol-cpnd`
- Dependencies: `build-ledger` -> `fix-items` -> `acknowledge-ledger`

## Phase 3: Dispatch with --bead-id

Dispatch output:

```text
[factory] 15:53:46 Pre-flight: checking all 5 stack components...
[factory] 15:53:46   ✅ kilo serve (100 sessions)
[factory] 15:53:46   ✅ Dolt server (port 3307)
[factory] 15:53:46   ✅ oc-daemon (SSE → Dolt)
[factory] 15:53:46   ✅ Temporal server (port 7233)
[factory] 15:53:46   ✅ Temporal worker
[factory] 15:53:46 Pre-flight passed (5/5 components healthy)
[factory] 15:53:46 Built prompt from string (84 chars)
[factory] 15:53:46 Session created: ses_31216871dffe0B7H56ooxHv3X1
[factory] 15:53:46 Title: factory: pr-review @ 2026-03-14 19:53
[factory] 15:53:47 Task row created: ses_31216871dffe0B7H56ooxHv3X1 (bead: repomap-core-mol-srx8)
[prompt-resolution] Resolved prompt: card-exit:respond-to-pr-review (specificity: generic)
[factory] 15:53:47 Card exit prompt injected (card=respond-to-pr-review, source=compiled)
[factory] 15:53:47 Prompt dispatched to mode: pr-review
{"session_id":"ses_31216871dffe0B7H56ooxHv3X1","mode":"pr-review","title":"factory: pr-review @ 2026-03-14 19:53"}
```

Dispatch verification:

- Dispatch task_id: `ses_31216871dffe0B7H56ooxHv3X1`
- Dispatch confirmed bead_id: `repomap-core-mol-srx8`

## Phase 4: Factory.tasks verification (Dolt query results showing bead_id linkage)

Query by bead_id:

```sql
SELECT task_id, mode, status, bead_id, punch_card_id, started_at
FROM tasks
WHERE bead_id = 'repomap-core-mol-srx8';
```

Result:

```text
+--------------------------------+-----------+-----------+-----------------------+---------------+---------------------+
| task_id                        | mode      | status    | bead_id               | punch_card_id | started_at          |
+--------------------------------+-----------+-----------+-----------------------+---------------+---------------------+
| ses_31216871dffe0B7H56ooxHv3X1 | pr-review | abandoned | repomap-core-mol-srx8 | NULL          | 2026-03-14 15:53:47 |
+--------------------------------+-----------+-----------+-----------------------+---------------+---------------------+
```

Query by task_id:

```sql
SELECT task_id, mode, status, bead_id, punch_card_id, started_at
FROM tasks
WHERE task_id = 'ses_31216871dffe0B7H56ooxHv3X1';
```

Result:

```text
+--------------------------------+-----------+-----------+-----------------------+---------------+---------------------+
| task_id                        | mode      | status    | bead_id               | punch_card_id | started_at          |
+--------------------------------+-----------+-----------+-----------------------+---------------+---------------------+
| ses_31216871dffe0B7H56ooxHv3X1 | pr-review | abandoned | repomap-core-mol-srx8 | NULL          | 2026-03-14 15:53:47 |
+--------------------------------+-----------+-----------+-----------------------+---------------+---------------------+
```

Post-dispatch molecule and step state:

`.kilocode/tools/bd mol show repomap-core-mol-d9jz`:

```text
🧪 Molecule: respond_to_pr_review
   ID: repomap-core-mol-d9jz
   Steps: 4

🌲 Structure:
   respond_to_pr_review (root)
   ├── Acknowledge ledger
   ├── Build ledger
   └── Fix items
```

`.kilocode/tools/bd show repomap-core-mol-srx8`:

```text
○ repomap-core-mol-srx8 · Build ledger   [● P2 · OPEN]
Type: task
Created: 2026-03-14 · Updated: 2026-03-14

DESCRIPTION
Build Comment Ledger for PR 999 in test/repo including SonarQube quality gate status

PARENT
  ↑ ○ repomap-core-mol-d9jz: (EPIC) respond_to_pr_review ● P2

BLOCKS
  ← ○ repomap-core-mol-wi63: Fix items ● P2
```

## Known prerequisites

The workflow depends on all stack components passing pre-flight:

- `kilo serve` (session backend)
- Dolt server on port `3307`
- `oc-daemon` (SSE -> Dolt)
- Temporal server on port `7233`
- Temporal worker

## Formula name note

`pour` uses `respond-to-pr-review` (hyphens), not `respond_to_pr_review` (underscores).

## Conclusion

Full lifecycle persistence is proven for this run: cook expansion and substitution validated, pour created persistent molecule/step beads, dispatch with `--bead-id` created `task_id=ses_31216871dffe0B7H56ooxHv3X1`, and `factory.tasks` persisted the exact bead linkage `bead_id=repomap-core-mol-srx8` as verified by both bead_id and task_id queries. No evidence gaps remain for this objective.
