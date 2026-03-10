-- =============================================================================
-- Punch Card Schema — Dolt DDL
-- =============================================================================
-- Plant infrastructure: durable memory layer for punch card semantics.
-- All tables live in a Dolt database under .kilocode/dolt/
--
-- Design principles:
--   - Append-only for punches (ledger entries)
--   - Minimal tables (5 tables + 1 view)
--   - Idempotent inserts via source_hash deduplication
--   - Dolt commit boundaries at gate passes
--
-- Usage:
--   dolt init
--   dolt sql < .kilocode/schema/punch-card-schema.sql
--   dolt add .
--   dolt commit -m "Initialize punch card schema"
--
-- Date: 2026-02-18
-- Revision: v1.0
-- =============================================================================

-- -----------------------------------------------------------------------------
-- tasks: One row per Kilo task (parent or child)
-- -----------------------------------------------------------------------------
-- Inserted when a task is first observed by the replication daemon.
-- Updated on completion (status, completed_at, cost_usd).
-- task_id is the Kilo task UUID from the tasks/ directory name.

-- PUNCH_CARD_SCHEMA TABLES START

CREATE TABLE tasks (
    task_id        VARCHAR(50)  NOT NULL PRIMARY KEY,
    parent_task_id VARCHAR(50)  DEFAULT NULL,
    mode           VARCHAR(30)  NOT NULL,
    model          VARCHAR(50)  NOT NULL DEFAULT 'unknown',
    status         ENUM('running', 'completed', 'failed', 'abandoned') NOT NULL DEFAULT 'running',
    cost_usd       DECIMAL(10,4) NOT NULL DEFAULT 0.0000,
    started_at     DATETIME     NOT NULL,
    completed_at   DATETIME     DEFAULT NULL,
    punch_card_id  VARCHAR(50)  DEFAULT NULL,

    INDEX idx_parent (parent_task_id),
    INDEX idx_status (status)
);

-- -----------------------------------------------------------------------------
-- punches: Append-only ledger of observed execution events
-- -----------------------------------------------------------------------------
-- Each row is a single punch minted by the replication daemon when it
-- observes a qualifying event in Kilo session data.
--
-- Punches cannot be faked. They can only be caused.
-- source_hash provides idempotent insert (UNIQUE constraint).

CREATE TABLE punches (
    punch_id    INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
    task_id     VARCHAR(50)  NOT NULL,
    punch_type  ENUM(
        'tool_call',
        'command_exec',
        'mcp_call',
        'gate_pass',
        'gate_fail',
        'child_spawn',
        'child_complete',
        'cost_checkpoint',
        'step_complete',
        'governor_kill',
        'session_lifecycle',
        'message'
    ) NOT NULL,
    punch_key   VARCHAR(200) NOT NULL,
    observed_at DATETIME     NOT NULL,
    source_hash CHAR(64)     NOT NULL,

    UNIQUE INDEX idx_source_hash (source_hash),
    INDEX idx_task_type (task_id, punch_type),
    INDEX idx_task (task_id)
);

-- -----------------------------------------------------------------------------
-- punch_cards: Definitions of required punches per workflow
-- -----------------------------------------------------------------------------
-- Static configuration rows. Seeded at schema creation, modified when
-- workflows evolve. NOT per-task — per-workflow.
--
-- punch_key_pattern supports SQL LIKE patterns (% wildcard).
-- required = TRUE means the punch MUST exist for the card to validate.

CREATE TABLE punch_cards (
    card_id           VARCHAR(50)  NOT NULL,
    workflow_name     VARCHAR(50)  NOT NULL,
    punch_type        ENUM(
        'tool_call',
        'command_exec',
        'mcp_call',
        'gate_pass',
        'gate_fail',
        'child_spawn',
        'child_complete',
        'cost_checkpoint',
        'step_complete',
        'governor_kill',
        'session_lifecycle',
        'message'
    ) NOT NULL,
    punch_key_pattern VARCHAR(200) NOT NULL,
    required          BOOLEAN      NOT NULL DEFAULT TRUE,
    forbidden         BOOLEAN      NOT NULL DEFAULT FALSE,
    description       VARCHAR(200) DEFAULT NULL,

    enforced          BOOLEAN      NOT NULL DEFAULT FALSE,

    PRIMARY KEY (card_id, punch_type, punch_key_pattern)
);

-- -----------------------------------------------------------------------------
-- checkpoints: Commit boundary records
-- -----------------------------------------------------------------------------
-- Written when a punch card validates. The dolt_commit_hash is populated
-- after CALL DOLT_COMMIT() succeeds.

CREATE TABLE checkpoints (
    checkpoint_id    INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
    task_id          VARCHAR(50)  NOT NULL,
    card_id          VARCHAR(50)  NOT NULL,
    status           ENUM('pass', 'fail') NOT NULL,
    validated_at     DATETIME     NOT NULL,
    dolt_commit_hash CHAR(40)     DEFAULT NULL,
    missing_punches  TEXT         DEFAULT NULL,
    violations       TEXT         DEFAULT NULL,

    INDEX idx_task (task_id),
    INDEX idx_card (card_id)
);

-- -----------------------------------------------------------------------------
-- child_relationships: Delegation proof linking parent → child
-- -----------------------------------------------------------------------------
-- Inserted when parent spawns child via new_task.
-- Updated when child completes and its punch card is evaluated.
-- child_checkpoint_hash is the Dolt commit hash from the child's
-- successful validation — the cryptographic delegation proof.

CREATE TABLE child_relationships (
    parent_task_id       VARCHAR(50) NOT NULL,
    child_task_id        VARCHAR(50) NOT NULL,
    spawned_at           DATETIME    NOT NULL,
    completed_at         DATETIME    DEFAULT NULL,
    child_card_valid     BOOLEAN     NOT NULL DEFAULT FALSE,
    child_checkpoint_hash CHAR(40)   DEFAULT NULL,

    PRIMARY KEY (parent_task_id, child_task_id),
    INDEX idx_parent (parent_task_id),
    INDEX idx_child (child_task_id)
);

-- PUNCH_CARD_SCHEMA TABLES END

-- -----------------------------------------------------------------------------
-- cost_aggregate: Recursive cost rollup view
-- -----------------------------------------------------------------------------
-- Returns total cost for a task including all descendants.
-- Usage: SELECT * FROM cost_aggregate WHERE root_task_id = 'your-task-id';
--
-- NOTE: Dolt supports recursive CTEs. If your Dolt version does not,
-- replace with a two-level JOIN as a stopgap.

-- PUNCH_CARD_SCHEMA VIEWS START

CREATE VIEW cost_aggregate AS
WITH RECURSIVE task_tree AS (
    SELECT
        task_id AS root_task_id,
        task_id,
        parent_task_id,
        cost_usd,
        0 AS depth
    FROM tasks

    UNION ALL

    SELECT
        tt.root_task_id,
        t.task_id,
        t.parent_task_id,
        t.cost_usd,
        tt.depth + 1
    FROM tasks t
    JOIN task_tree tt ON t.parent_task_id = tt.task_id
    WHERE tt.depth < 10  -- Safety: max 10 levels of nesting
)
SELECT
    root_task_id,
    SUM(cost_usd)   AS total_cost_usd,
    COUNT(*)         AS task_count,
    MAX(depth)       AS max_depth
FROM task_tree
GROUP BY root_task_id;

-- PUNCH_CARD_SCHEMA VIEWS END


-- =============================================================================
-- Seed Data: Initial Punch Card Definitions
-- =============================================================================

-- PUNCH_CARD_SCHEMA SEEDS START

-- Quality Gates card (observational — enforced=FALSE)
INSERT INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, description, enforced) VALUES
    ('quality-gates', 'quality-gates', 'gate_pass', 'ruff-format',   TRUE,  'Ruff format check must pass', FALSE),
    ('quality-gates', 'quality-gates', 'gate_pass', 'ruff-check',    TRUE,  'Ruff lint check must pass', FALSE),
    ('quality-gates', 'quality-gates', 'gate_pass', 'mypy',          TRUE,  'Mypy type check must pass', FALSE),
    ('quality-gates', 'quality-gates', 'gate_pass', 'pytest',        TRUE,  'Pytest test suite must pass', FALSE),
    ('quality-gates', 'quality-gates', 'cost_checkpoint', '%',       FALSE, 'Cost tracking (optional)', FALSE);

-- Task Landing card (extends quality gates — observational)
INSERT INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, description, enforced) VALUES
    ('land-plane', 'land-plane', 'gate_pass',      'ruff-format',      TRUE,  'Ruff format check must pass', FALSE),
    ('land-plane', 'land-plane', 'gate_pass',      'ruff-check',       TRUE,  'Ruff lint check must pass', FALSE),
    ('land-plane', 'land-plane', 'gate_pass',      'mypy',             TRUE,  'Mypy type check must pass', FALSE),
    ('land-plane', 'land-plane', 'gate_pass',      'pytest',           TRUE,  'Pytest test suite must pass', FALSE),
    ('land-plane', 'land-plane', 'step_complete',  'task_exit',        TRUE,  'Task must reach completion', FALSE),
    ('land-plane', 'land-plane', 'tool_call',      'update_todo_list', TRUE,  'At least one todo update required', FALSE),
    ('land-plane', 'land-plane', 'child_spawn',    '%',                FALSE, 'Child task spawning (optional)', FALSE),
    ('land-plane', 'land-plane', 'cost_checkpoint', '%',               FALSE, 'Cost tracking (optional)', FALSE);

-- Orchestrator card (parent tasks that spawn children — observational)
INSERT INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, description, enforced) VALUES
    ('orchestrate', 'orchestrate', 'child_spawn',     '%',          TRUE,  'Must spawn at least one child', FALSE),
    ('orchestrate', 'orchestrate', 'step_complete',   'task_exit',  TRUE,  'Orchestrator must reach completion', FALSE),
    ('orchestrate', 'orchestrate', 'cost_checkpoint', '%',          FALSE, 'Cost tracking (optional)', FALSE);
    -- NOTE: child_card_valid is checked via child_relationships, not as a punch

-- Plant validation card (plant-manager mode — observational)
INSERT INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, description, enforced) VALUES
    ('validate-plant', 'validate-plant', 'gate_pass',     'workflow-gate',  TRUE,  'Workflow gate must pass', FALSE),
    ('validate-plant', 'validate-plant', 'step_complete', 'task_exit',      TRUE,  'Validation must complete', FALSE);

-- Fix CI card (observational)
INSERT INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, description, enforced) VALUES
    ('fix-ci', 'fix-ci', 'gate_pass', 'ruff-format',   TRUE,  'Ruff format check must pass', FALSE),
    ('fix-ci', 'fix-ci', 'gate_pass', 'ruff-check',    TRUE,  'Ruff lint check must pass', FALSE),
    ('fix-ci', 'fix-ci', 'gate_pass', 'mypy',          TRUE,  'Mypy type check must pass', FALSE),
    ('fix-ci', 'fix-ci', 'gate_pass', 'pytest',        TRUE,  'Pytest test suite must pass', FALSE),
    ('fix-ci', 'fix-ci', 'cost_checkpoint', '%',       FALSE, 'Cost tracking (optional)', FALSE);

-- Fitter Line Health card (observational)
INSERT INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, description, enforced) VALUES
    ('fitter-line-health', 'fitter-line-health', 'gate_pass',      'workflow-gate',  TRUE,  'At least one gate must be restored', FALSE),
    ('fitter-line-health', 'fitter-line-health', 'step_complete',  'task_exit',      TRUE,  'Restoration must complete', FALSE),
    ('fitter-line-health', 'fitter-line-health', 'cost_checkpoint', '%',             FALSE, 'Cost tracking (optional)', FALSE);

-- Friction Audit card (observational)
INSERT INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, description, enforced) VALUES
    ('friction-audit', 'friction-audit', 'mcp_call',         'process_thought',  TRUE,  'Sequential thinking required for audit', FALSE),
    ('friction-audit', 'friction-audit', 'step_complete',    'task_exit',        TRUE,  'Audit must complete', FALSE),
    ('friction-audit', 'friction-audit', 'cost_checkpoint',  '%',               FALSE, 'Cost tracking (optional)', FALSE);

-- Refactor card (observational)
INSERT INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, description, enforced) VALUES
    ('refactor', 'refactor', 'gate_pass',        'ruff-format',          TRUE,  'Ruff format check must pass', FALSE),
    ('refactor', 'refactor', 'gate_pass',        'ruff-check',           TRUE,  'Ruff lint check must pass', FALSE),
    ('refactor', 'refactor', 'gate_pass',        'mypy',                 TRUE,  'Mypy type check must pass', FALSE),
    ('refactor', 'refactor', 'gate_pass',        'pytest',               TRUE,  'Pytest test suite must pass', FALSE),
    ('refactor', 'refactor', 'mcp_call',         'process_thought',      TRUE,  'Sequential thinking required for refactoring', FALSE),
    ('refactor', 'refactor', 'mcp_call',         'codebase___retrieval', TRUE,  'Codebase exploration required', FALSE),
    ('refactor', 'refactor', 'cost_checkpoint',  '%',                    FALSE, 'Cost tracking (optional)', FALSE);

-- Respond to PR Review card (observational — standalone or child-level)
INSERT INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, description, enforced) VALUES
    ('respond-to-pr-review', 'respond-to-pr-review', 'gate_pass',        'ruff-format',  TRUE,  'Ruff format check must pass', FALSE),
    ('respond-to-pr-review', 'respond-to-pr-review', 'gate_pass',        'ruff-check',   TRUE,  'Ruff lint check must pass', FALSE),
    ('respond-to-pr-review', 'respond-to-pr-review', 'gate_pass',        'mypy',         TRUE,  'Mypy type check must pass', FALSE),
    ('respond-to-pr-review', 'respond-to-pr-review', 'gate_pass',        'pytest',       TRUE,  'Pytest test suite must pass', FALSE),
    ('respond-to-pr-review', 'respond-to-pr-review', 'cost_checkpoint',  '%',            FALSE, 'Cost tracking (optional)', FALSE);

-- PR Review Orchestration card (Tier 2: Tactical — phased PR review — ENFORCED)
-- Delegates ledger building to pr-review, fixes to code, acknowledgement to pr-review.
-- The orchestrator never touches GitHub, never edits code, never queries SonarQube.
INSERT INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, forbidden, description, enforced) VALUES
    ('pr-review-orchestrate', 'pr-review-orchestrate', 'child_spawn',     'pr-review',              TRUE,  FALSE, 'Must delegate ledger/acknowledge phases to pr-review mode', TRUE),
    ('pr-review-orchestrate', 'pr-review-orchestrate', 'child_spawn',     'code',                   TRUE,  FALSE, 'Must delegate fix phase to code mode', TRUE),
    ('pr-review-orchestrate', 'pr-review-orchestrate', 'child_complete',  'child_return',           TRUE,  FALSE, 'Must receive child completions', TRUE),
    ('pr-review-orchestrate', 'pr-review-orchestrate', 'step_complete',   'task_exit',              TRUE,  FALSE, 'Orchestrator must reach completion', TRUE),
    ('pr-review-orchestrate', 'pr-review-orchestrate', 'tool_call',       'edit_file%',             TRUE,  TRUE,  'FORBIDDEN: Must not edit files directly', TRUE),
    ('pr-review-orchestrate', 'pr-review-orchestrate', 'tool_call',       'apply_diff%',            TRUE,  TRUE,  'FORBIDDEN: Must not apply diffs directly', TRUE),
    ('pr-review-orchestrate', 'pr-review-orchestrate', 'tool_call',       'write_to_file%',         TRUE,  TRUE,  'FORBIDDEN: Must not write files directly', TRUE),
    ('pr-review-orchestrate', 'pr-review-orchestrate', 'mcp_call',        '%codebase___retrieval%', TRUE,  TRUE,  'FORBIDDEN: Must not explore codebase directly', TRUE),
    ('pr-review-orchestrate', 'pr-review-orchestrate', 'tool_call',       'bash%gh %',              TRUE,  TRUE,  'FORBIDDEN: Must not call GitHub CLI directly', TRUE),
    ('pr-review-orchestrate', 'pr-review-orchestrate', 'cost_checkpoint', '%',                      FALSE, FALSE, 'Cost tracking (optional)', FALSE);

-- Build PR Ledger card (Tier 3: Specialist — pr-review child Phase 0 — ENFORCED)
-- Fetches GitHub comments + SonarQube gate → returns structured ledger. No code edits.
INSERT INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, forbidden, description, enforced) VALUES
    ('build-pr-ledger', 'build-pr-ledger', 'tool_call',       'bash%gh %',        TRUE,  FALSE, 'Must use gh CLI to fetch PR comments', TRUE),
    ('build-pr-ledger', 'build-pr-ledger', 'step_complete',   'task_exit',        TRUE,  FALSE, 'Phase must complete', TRUE),
    ('build-pr-ledger', 'build-pr-ledger', 'tool_call',       'edit_file%',       TRUE,  TRUE,  'FORBIDDEN: Must not edit files (ledger building only)', TRUE),
    ('build-pr-ledger', 'build-pr-ledger', 'tool_call',       'apply_diff%',      TRUE,  TRUE,  'FORBIDDEN: Must not apply diffs (ledger building only)', TRUE),
    ('build-pr-ledger', 'build-pr-ledger', 'tool_call',       'write_to_file%',   TRUE,  TRUE,  'FORBIDDEN: Must not write files (ledger building only)', TRUE),
    ('build-pr-ledger', 'build-pr-ledger', 'cost_checkpoint', '%',               FALSE, FALSE, 'Cost tracking (optional)', FALSE);

-- Acknowledge PR Ledger card (Tier 3: Specialist — pr-review child Phase 5 — ENFORCED)
-- Replies to GitHub comments with fix references. No code edits.
INSERT INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, forbidden, description, enforced) VALUES
    ('acknowledge-pr-ledger', 'acknowledge-pr-ledger', 'tool_call',       'bash%gh %',        TRUE,  FALSE, 'Must use gh CLI to reply to PR comments', TRUE),
    ('acknowledge-pr-ledger', 'acknowledge-pr-ledger', 'step_complete',   'task_exit',        TRUE,  FALSE, 'Phase must complete', TRUE),
    ('acknowledge-pr-ledger', 'acknowledge-pr-ledger', 'tool_call',       'edit_file%',       TRUE,  TRUE,  'FORBIDDEN: Must not edit files (acknowledgement only)', TRUE),
    ('acknowledge-pr-ledger', 'acknowledge-pr-ledger', 'tool_call',       'apply_diff%',      TRUE,  TRUE,  'FORBIDDEN: Must not apply diffs (acknowledgement only)', TRUE),
    ('acknowledge-pr-ledger', 'acknowledge-pr-ledger', 'tool_call',       'write_to_file%',   TRUE,  TRUE,  'FORBIDDEN: Must not write files (acknowledgement only)', TRUE),
    ('acknowledge-pr-ledger', 'acknowledge-pr-ledger', 'cost_checkpoint', '%',               FALSE, FALSE, 'Cost tracking (optional)', FALSE);

-- =============================================================================
-- Phase-Level Delegation Enforcement Cards
-- =============================================================================
-- These cards enforce the three-tier delegation architecture:
--   plant-manager → process-orchestrator → specialist children
-- Each tier has REQUIRED punches (must happen) and FORBIDDEN punches
-- (must NOT happen — anti-delegation detection).

-- Plant Manager Orchestration card (Tier 1: Strategic — ENFORCED)
-- Plant manager must delegate to tactical orchestrators, never implement directly.
INSERT INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, forbidden, description, enforced) VALUES
    ('plant-orchestrate', 'plant-orchestrate', 'child_spawn',    '%orchestrator%',        TRUE,  FALSE, '[v2] Must delegate to an orchestrator child', TRUE),
    ('plant-orchestrate', 'plant-orchestrate', 'child_complete',  'child_return',        TRUE,  FALSE, 'Must receive child completion', TRUE),
    ('plant-orchestrate', 'plant-orchestrate', 'step_complete',   'task_exit',           TRUE,  FALSE, 'Plant manager must reach completion', TRUE),
    ('plant-orchestrate', 'plant-orchestrate', 'tool_call',       'edit_file%',          TRUE,  TRUE,  'FORBIDDEN: Must not edit files directly', TRUE),
    ('plant-orchestrate', 'plant-orchestrate', 'tool_call',       'apply_diff%',         TRUE,  TRUE,  'FORBIDDEN: Must not apply diffs directly', TRUE),
    ('plant-orchestrate', 'plant-orchestrate', 'tool_call',       'write_to_file%',      TRUE,  TRUE,  'FORBIDDEN: Must not write files directly', TRUE),
    ('plant-orchestrate', 'plant-orchestrate', 'mcp_call',        '%codebase___retrieval%', TRUE, TRUE, 'FORBIDDEN: Must not explore codebase directly', TRUE),
    ('plant-orchestrate', 'plant-orchestrate', 'cost_checkpoint', '%',                   FALSE, FALSE, 'Cost tracking (optional)', FALSE);

INSERT INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, forbidden, description, enforced) VALUES
    ('audit-orchestrate', 'audit-orchestrate', 'child_spawn',    'product-skeptic',      TRUE,  FALSE, '[v2] Must delegate adversarial phases to product-skeptic', TRUE),
    ('audit-orchestrate', 'audit-orchestrate', 'child_spawn',    'architect',            TRUE,  FALSE, '[v2] Must delegate synthesis phases to architect', TRUE),
    ('audit-orchestrate', 'audit-orchestrate', 'child_complete', 'child_return',         TRUE,  FALSE, '[v2] Must receive child completions', TRUE),
    ('audit-orchestrate', 'audit-orchestrate', 'step_complete',  'task_exit',            TRUE,  FALSE, '[v2] Audit orchestrator must complete', TRUE),
    ('audit-orchestrate', 'audit-orchestrate', 'tool_call',      'edit_file%',           TRUE,  TRUE,  '[v2] FORBIDDEN: Must not edit files directly', TRUE),
    ('audit-orchestrate', 'audit-orchestrate', 'tool_call',      'apply_diff%',          TRUE,  TRUE,  '[v2] FORBIDDEN: Must not apply diffs directly', TRUE),
    ('audit-orchestrate', 'audit-orchestrate', 'tool_call',      'write_to_file%',       TRUE,  TRUE,  '[v2] FORBIDDEN: Must not write files directly', TRUE),
    ('audit-orchestrate', 'audit-orchestrate', 'mcp_call',       '%codebase___retrieval%', TRUE, TRUE, '[v2] FORBIDDEN: Must not explore codebase directly', TRUE),
    ('audit-orchestrate', 'audit-orchestrate', 'cost_checkpoint','%',                    FALSE, FALSE, 'Cost tracking (optional)', FALSE);

-- Start-Task Orchestrator card (Tier 2: Tactical — prep only — ENFORCED)
-- Delegates discover, explore, prepare phases to architect children.
-- Does NOT require code children (that's execute-task's job).
INSERT INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, forbidden, description, enforced) VALUES
    ('start-task-orchestrate', 'start-task-orchestrate', 'child_spawn',     'architect',              TRUE,  FALSE, 'Must delegate prep phases to architect', TRUE),
    ('start-task-orchestrate', 'start-task-orchestrate', 'child_complete',  'child_return',           TRUE,  FALSE, 'Must receive child completions', TRUE),
    ('start-task-orchestrate', 'start-task-orchestrate', 'step_complete',   'task_exit',              TRUE,  FALSE, 'Orchestrator must reach completion', TRUE),
    ('start-task-orchestrate', 'start-task-orchestrate', 'tool_call',       'edit_file%',             TRUE,  TRUE,  'FORBIDDEN: Must not edit files directly', TRUE),
    ('start-task-orchestrate', 'start-task-orchestrate', 'tool_call',       'apply_diff%',            TRUE,  TRUE,  'FORBIDDEN: Must not apply diffs directly', TRUE),
    ('start-task-orchestrate', 'start-task-orchestrate', 'tool_call',       'write_to_file%',         TRUE,  TRUE,  'FORBIDDEN: Must not write files directly', TRUE),
    ('start-task-orchestrate', 'start-task-orchestrate', 'mcp_call',        '%codebase___retrieval%', TRUE,  TRUE,  'FORBIDDEN: Must not explore codebase directly', TRUE),
    ('start-task-orchestrate', 'start-task-orchestrate', 'cost_checkpoint', '%',                      FALSE, FALSE, 'Cost tracking (optional)', FALSE);

-- Execute-Task Orchestrator card (Tier 2: Tactical — execution — ENFORCED)
-- Delegates implementation subtasks to code children.
INSERT INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, forbidden, description, enforced) VALUES
    ('process-orchestrate', 'process-orchestrate', 'child_spawn',    'code',               TRUE,  FALSE, 'Must delegate execute phase to code mode', TRUE),
    ('process-orchestrate', 'process-orchestrate', 'child_complete', 'child_return',       TRUE,  FALSE, 'Must receive child completions', TRUE),
    ('process-orchestrate', 'process-orchestrate', 'step_complete',  'task_exit',          TRUE,  FALSE, 'Orchestrator must reach completion', TRUE),
    ('process-orchestrate', 'process-orchestrate', 'tool_call',      'edit_file%',         TRUE,  TRUE,  'FORBIDDEN: Must not edit files directly', TRUE),
    ('process-orchestrate', 'process-orchestrate', 'tool_call',      'apply_diff%',        TRUE,  TRUE,  'FORBIDDEN: Must not apply diffs directly', TRUE),
    ('process-orchestrate', 'process-orchestrate', 'tool_call',      'write_to_file%',     TRUE,  TRUE,  'FORBIDDEN: Must not write files directly', TRUE),
    ('process-orchestrate', 'process-orchestrate', 'cost_checkpoint', '%',                 FALSE, FALSE, 'Cost tracking (optional)', FALSE);

-- Discover Phase card (Tier 3: Specialist — architect child — ENFORCED)
INSERT INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, forbidden, description, enforced) VALUES
    ('discover-phase', 'discover-phase', 'mcp_call',       '%codebase___retrieval%', TRUE,  FALSE, 'Must use Augment context engine for discovery', TRUE),
    ('discover-phase', 'discover-phase', 'tool_call',      'read_file',             TRUE,  FALSE, 'Must read at least one file', TRUE),
    ('discover-phase', 'discover-phase', 'step_complete',  'task_exit',             TRUE,  FALSE, 'Phase must complete', TRUE),
    ('discover-phase', 'discover-phase', 'child_spawn',    '%',                     TRUE,  TRUE,  'FORBIDDEN: Specialist must not delegate', TRUE),
    ('discover-phase', 'discover-phase', 'cost_checkpoint', '%',                    FALSE, FALSE, 'Cost tracking (optional)', FALSE);

-- Explore Phase card (Tier 3: Specialist — architect child — ENFORCED)
INSERT INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, forbidden, description, enforced) VALUES
    ('explore-phase', 'explore-phase', 'mcp_call',       '%codebase___retrieval%', TRUE,  FALSE, 'Must use Augment context engine for exploration', TRUE),
    ('explore-phase', 'explore-phase', 'step_complete',  'task_exit',             TRUE,  FALSE, 'Phase must complete', TRUE),
    ('explore-phase', 'explore-phase', 'child_spawn',    '%',                     TRUE,  TRUE,  'FORBIDDEN: Specialist must not delegate', TRUE),
    ('explore-phase', 'explore-phase', 'cost_checkpoint', '%',                    FALSE, FALSE, 'Cost tracking (optional)', FALSE);

-- Prepare Phase card (Tier 3: Specialist — architect child — ENFORCED)
INSERT INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, forbidden, description, enforced) VALUES
    ('prepare-phase', 'prepare-phase', 'mcp_call',       '%process_thought%',     TRUE,  FALSE, 'Must use sequential thinking', TRUE),
    ('prepare-phase', 'prepare-phase', 'mcp_call',       '%export_session%',      TRUE,  FALSE, 'Must export thinking session', TRUE),
    ('prepare-phase', 'prepare-phase', 'step_complete',  'task_exit',             TRUE,  FALSE, 'Phase must complete', TRUE),
    ('prepare-phase', 'prepare-phase', 'child_spawn',    '%',                     TRUE,  TRUE,  'FORBIDDEN: Specialist must not delegate', TRUE),
    ('prepare-phase', 'prepare-phase', 'cost_checkpoint', '%',                    FALSE, FALSE, 'Cost tracking (optional)', FALSE);

-- Execute Subtask card (Tier 3: Specialist — code child — ENFORCED)
INSERT INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, forbidden, description, enforced) VALUES
    ('execute-subtask', 'execute-subtask', 'mcp_call',       '%codebase___retrieval%', TRUE,  FALSE, 'Must gather context before editing', TRUE),
    ('execute-subtask', 'execute-subtask', 'gate_pass',      'ruff-format',           TRUE,  FALSE, 'Ruff format check must pass', TRUE),
    ('execute-subtask', 'execute-subtask', 'gate_pass',      'ruff-check',            TRUE,  FALSE, 'Ruff lint check must pass', TRUE),
    ('execute-subtask', 'execute-subtask', 'gate_pass',      'mypy',                  TRUE,  FALSE, 'Mypy type check must pass', TRUE),
    ('execute-subtask', 'execute-subtask', 'gate_pass',      'pytest',                TRUE,  FALSE, 'Pytest test suite must pass', TRUE),
    ('execute-subtask', 'execute-subtask', 'step_complete',  'task_exit',             TRUE,  FALSE, '[v2] Subtask must complete', TRUE),
    ('execute-subtask', 'execute-subtask', 'child_spawn',    '%',                     TRUE,  TRUE,  '[v2] FORBIDDEN: Specialist must not delegate', TRUE),
    ('execute-subtask', 'execute-subtask', 'cost_checkpoint', '%',                    FALSE, FALSE, '[v2] Cost tracking (optional)', FALSE);

-- PUNCH_CARD_SCHEMA SEEDS END
