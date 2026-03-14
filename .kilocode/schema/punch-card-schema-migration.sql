-- Idempotent punch card schema migration for Dolt SQL server.

CREATE TABLE IF NOT EXISTS tasks (
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

-- Migration: add bead_id to existing tasks tables (idempotent via IF NOT EXISTS)
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS bead_id VARCHAR(100) DEFAULT NULL;

CREATE TABLE IF NOT EXISTS punches (
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

CREATE TABLE IF NOT EXISTS punch_cards (
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

CREATE TABLE IF NOT EXISTS checkpoints (
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

CREATE TABLE IF NOT EXISTS child_relationships (
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

-- Compatibility table used by existing daemon code.
CREATE TABLE IF NOT EXISTS child_rels (
    parent_id VARCHAR(128) NOT NULL,
    child_id VARCHAR(128) NOT NULL,
    PRIMARY KEY (parent_id, child_id),
    INDEX idx_child (child_id)
);

CREATE OR REPLACE VIEW cost_aggregate AS
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
    WHERE tt.depth < 10
)
SELECT
    root_task_id,
    SUM(cost_usd)   AS total_cost_usd,
    COUNT(*)         AS task_count,
    MAX(depth)       AS max_depth
FROM task_tree
GROUP BY root_task_id;

INSERT IGNORE INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, description) VALUES
    ('quality-gates', 'quality-gates', 'gate_pass', 'ruff-format',   TRUE,  'Ruff format check must pass'),
    ('quality-gates', 'quality-gates', 'gate_pass', 'ruff-check',    TRUE,  'Ruff lint check must pass'),
    ('quality-gates', 'quality-gates', 'gate_pass', 'mypy',          TRUE,  'Mypy type check must pass'),
    ('quality-gates', 'quality-gates', 'gate_pass', 'pytest',        TRUE,  'Pytest test suite must pass'),
    ('quality-gates', 'quality-gates', 'cost_checkpoint', '%',       FALSE, 'Cost tracking (optional)');

INSERT IGNORE INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, description) VALUES
    ('land-plane', 'land-plane', 'gate_pass',      'ruff-format',      TRUE,  'Ruff format check must pass'),
    ('land-plane', 'land-plane', 'gate_pass',      'ruff-check',       TRUE,  'Ruff lint check must pass'),
    ('land-plane', 'land-plane', 'gate_pass',      'mypy',             TRUE,  'Mypy type check must pass'),
    ('land-plane', 'land-plane', 'gate_pass',      'pytest',           TRUE,  'Pytest test suite must pass'),
    ('land-plane', 'land-plane', 'step_complete',  'task_exit',        TRUE,  'Task must reach completion'),
    ('land-plane', 'land-plane', 'tool_call',      'update_todo_list', TRUE,  'At least one todo update required'),
    ('land-plane', 'land-plane', 'child_spawn',    '%',                FALSE, 'Child task spawning (optional)'),
    ('land-plane', 'land-plane', 'cost_checkpoint', '%',               FALSE, 'Cost tracking (optional)');

INSERT IGNORE INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, description) VALUES
    ('orchestrate', 'orchestrate', 'child_spawn',     '%',          TRUE,  'Must spawn at least one child'),
    ('orchestrate', 'orchestrate', 'step_complete',   'task_exit',  TRUE,  'Orchestrator must reach completion'),
    ('orchestrate', 'orchestrate', 'cost_checkpoint', '%',          FALSE, 'Cost tracking (optional)');

INSERT IGNORE INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, description) VALUES
    ('validate-plant', 'validate-plant', 'gate_pass',     'workflow-gate',  TRUE,  'Workflow gate must pass'),
    ('validate-plant', 'validate-plant', 'step_complete', 'task_exit',      TRUE,  'Validation must complete');

INSERT IGNORE INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, description) VALUES
    ('fix-ci', 'fix-ci', 'gate_pass', 'ruff-format',   TRUE,  'Ruff format check must pass'),
    ('fix-ci', 'fix-ci', 'gate_pass', 'ruff-check',    TRUE,  'Ruff lint check must pass'),
    ('fix-ci', 'fix-ci', 'gate_pass', 'mypy',          TRUE,  'Mypy type check must pass'),
    ('fix-ci', 'fix-ci', 'gate_pass', 'pytest',        TRUE,  'Pytest test suite must pass'),
    ('fix-ci', 'fix-ci', 'cost_checkpoint', '%',       FALSE, 'Cost tracking (optional)');

INSERT IGNORE INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, description) VALUES
    ('fitter-line-health', 'fitter-line-health', 'gate_pass',      'workflow-gate',  TRUE,  'At least one gate must be restored'),
    ('fitter-line-health', 'fitter-line-health', 'step_complete',  'task_exit',      TRUE,  'Restoration must complete'),
    ('fitter-line-health', 'fitter-line-health', 'cost_checkpoint', '%',             FALSE, 'Cost tracking (optional)');

INSERT IGNORE INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, description) VALUES
    ('friction-audit', 'friction-audit', 'mcp_call',         'process_thought',  TRUE,  'Sequential thinking required for audit'),
    ('friction-audit', 'friction-audit', 'step_complete',    'task_exit',        TRUE,  'Audit must complete'),
    ('friction-audit', 'friction-audit', 'cost_checkpoint',  '%',               FALSE, 'Cost tracking (optional)');

INSERT IGNORE INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, description) VALUES
    ('refactor', 'refactor', 'gate_pass',        'ruff-format',          TRUE,  'Ruff format check must pass'),
    ('refactor', 'refactor', 'gate_pass',        'ruff-check',           TRUE,  'Ruff lint check must pass'),
    ('refactor', 'refactor', 'gate_pass',        'mypy',                 TRUE,  'Mypy type check must pass'),
    ('refactor', 'refactor', 'gate_pass',        'pytest',               TRUE,  'Pytest test suite must pass'),
    ('refactor', 'refactor', 'mcp_call',         'process_thought',      TRUE,  'Sequential thinking required for refactoring'),
    ('refactor', 'refactor', 'mcp_call',         'codebase___retrieval', TRUE,  'Codebase exploration required'),
    ('refactor', 'refactor', 'cost_checkpoint',  '%',                    FALSE, 'Cost tracking (optional)');

INSERT IGNORE INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, description) VALUES
    ('respond-to-pr-review', 'respond-to-pr-review', 'gate_pass',        'ruff-format',  TRUE,  'Ruff format check must pass'),
    ('respond-to-pr-review', 'respond-to-pr-review', 'gate_pass',        'ruff-check',   TRUE,  'Ruff lint check must pass'),
    ('respond-to-pr-review', 'respond-to-pr-review', 'gate_pass',        'mypy',         TRUE,  'Mypy type check must pass'),
    ('respond-to-pr-review', 'respond-to-pr-review', 'gate_pass',        'pytest',       TRUE,  'Pytest test suite must pass'),
    ('respond-to-pr-review', 'respond-to-pr-review', 'cost_checkpoint',  '%',            FALSE, 'Cost tracking (optional)');

-- PR Review Orchestration card (Tier 2: Tactical — phased PR review — ENFORCED)
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
    ('pr-review-orchestrate', 'pr-review-orchestrate', 'cost_checkpoint', '%',                      FALSE, FALSE, 'Cost tracking (optional)', FALSE)
ON DUPLICATE KEY UPDATE
    workflow_name = VALUES(workflow_name),
    required = VALUES(required),
    forbidden = VALUES(forbidden),
    description = VALUES(description),
    enforced = VALUES(enforced);

-- Build PR Ledger card (Tier 3: Specialist — pr-review child Phase 0 — ENFORCED)
INSERT INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, forbidden, description, enforced) VALUES
    ('build-pr-ledger', 'build-pr-ledger', 'tool_call',       'bash%gh %',        TRUE,  FALSE, 'Must use gh CLI to fetch PR comments', TRUE),
    ('build-pr-ledger', 'build-pr-ledger', 'step_complete',   'task_exit',        TRUE,  FALSE, 'Phase must complete', TRUE),
    ('build-pr-ledger', 'build-pr-ledger', 'tool_call',       'edit_file%',       TRUE,  TRUE,  'FORBIDDEN: Must not edit files (ledger building only)', TRUE),
    ('build-pr-ledger', 'build-pr-ledger', 'tool_call',       'apply_diff%',      TRUE,  TRUE,  'FORBIDDEN: Must not apply diffs (ledger building only)', TRUE),
    ('build-pr-ledger', 'build-pr-ledger', 'tool_call',       'write_to_file%',   TRUE,  TRUE,  'FORBIDDEN: Must not write files (ledger building only)', TRUE),
    ('build-pr-ledger', 'build-pr-ledger', 'cost_checkpoint', '%',               FALSE, FALSE, 'Cost tracking (optional)', FALSE)
ON DUPLICATE KEY UPDATE
    workflow_name = VALUES(workflow_name),
    required = VALUES(required),
    forbidden = VALUES(forbidden),
    description = VALUES(description),
    enforced = VALUES(enforced);

-- Acknowledge PR Ledger card (Tier 3: Specialist — pr-review child Phase 5 — ENFORCED)
INSERT INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, forbidden, description, enforced) VALUES
    ('acknowledge-pr-ledger', 'acknowledge-pr-ledger', 'tool_call',       'bash%gh %',        TRUE,  FALSE, 'Must use gh CLI to reply to PR comments', TRUE),
    ('acknowledge-pr-ledger', 'acknowledge-pr-ledger', 'step_complete',   'task_exit',        TRUE,  FALSE, 'Phase must complete', TRUE),
    ('acknowledge-pr-ledger', 'acknowledge-pr-ledger', 'tool_call',       'edit_file%',       TRUE,  TRUE,  'FORBIDDEN: Must not edit files (acknowledgement only)', TRUE),
    ('acknowledge-pr-ledger', 'acknowledge-pr-ledger', 'tool_call',       'apply_diff%',      TRUE,  TRUE,  'FORBIDDEN: Must not apply diffs (acknowledgement only)', TRUE),
    ('acknowledge-pr-ledger', 'acknowledge-pr-ledger', 'tool_call',       'write_to_file%',   TRUE,  TRUE,  'FORBIDDEN: Must not write files (acknowledgement only)', TRUE),
    ('acknowledge-pr-ledger', 'acknowledge-pr-ledger', 'cost_checkpoint', '%',               FALSE, FALSE, 'Cost tracking (optional)', FALSE)
ON DUPLICATE KEY UPDATE
    workflow_name = VALUES(workflow_name),
    required = VALUES(required),
    forbidden = VALUES(forbidden),
    description = VALUES(description),
    enforced = VALUES(enforced);

INSERT INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, forbidden, description, enforced) VALUES
    ('plant-orchestrate', 'plant-orchestrate', 'child_spawn',    '%orchestrator%',        TRUE,  FALSE, '[v2] Must delegate to an orchestrator child', TRUE),
    ('plant-orchestrate', 'plant-orchestrate', 'child_complete',  'child_return',        TRUE,  FALSE, 'Must receive child completion', TRUE),
    ('plant-orchestrate', 'plant-orchestrate', 'step_complete',   'task_exit',           TRUE,  FALSE, 'Plant manager must reach completion', TRUE),
    ('plant-orchestrate', 'plant-orchestrate', 'tool_call',       'edit_file%',          TRUE,  TRUE,  'FORBIDDEN: Must not edit files directly', TRUE),
    ('plant-orchestrate', 'plant-orchestrate', 'tool_call',       'apply_diff%',         TRUE,  TRUE,  'FORBIDDEN: Must not apply diffs directly', TRUE),
    ('plant-orchestrate', 'plant-orchestrate', 'tool_call',       'write_to_file%',      TRUE,  TRUE,  'FORBIDDEN: Must not write files directly', TRUE),
    ('plant-orchestrate', 'plant-orchestrate', 'mcp_call',        '%codebase___retrieval%', TRUE, TRUE, 'FORBIDDEN: Must not explore codebase directly', TRUE),
    ('plant-orchestrate', 'plant-orchestrate', 'cost_checkpoint', '%',                   FALSE, FALSE, 'Cost tracking (optional)', FALSE)
ON DUPLICATE KEY UPDATE
    workflow_name = VALUES(workflow_name),
    required = VALUES(required),
    forbidden = VALUES(forbidden),
    description = VALUES(description),
    enforced = VALUES(enforced);

INSERT INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, forbidden, description, enforced) VALUES
    ('audit-orchestrate', 'audit-orchestrate', 'child_spawn',    'product-skeptic',      TRUE,  FALSE, '[v2] Must delegate adversarial phases to product-skeptic', TRUE),
    ('audit-orchestrate', 'audit-orchestrate', 'child_spawn',    'architect',            TRUE,  FALSE, '[v2] Must delegate synthesis phases to architect', TRUE),
    ('audit-orchestrate', 'audit-orchestrate', 'child_complete', 'child_return',         TRUE,  FALSE, '[v2] Must receive child completions', TRUE),
    ('audit-orchestrate', 'audit-orchestrate', 'step_complete',  'task_exit',            TRUE,  FALSE, '[v2] Audit orchestrator must complete', TRUE),
    ('audit-orchestrate', 'audit-orchestrate', 'tool_call',      'edit_file%',           TRUE,  TRUE,  '[v2] FORBIDDEN: Must not edit files directly', TRUE),
    ('audit-orchestrate', 'audit-orchestrate', 'tool_call',      'apply_diff%',          TRUE,  TRUE,  '[v2] FORBIDDEN: Must not apply diffs directly', TRUE),
    ('audit-orchestrate', 'audit-orchestrate', 'tool_call',      'write_to_file%',       TRUE,  TRUE,  '[v2] FORBIDDEN: Must not write files directly', TRUE),
    ('audit-orchestrate', 'audit-orchestrate', 'mcp_call',       '%codebase___retrieval%', TRUE, TRUE, '[v2] FORBIDDEN: Must not explore codebase directly', TRUE),
    ('audit-orchestrate', 'audit-orchestrate', 'cost_checkpoint','%',                    FALSE, FALSE, 'Cost tracking (optional)', FALSE)
ON DUPLICATE KEY UPDATE
    workflow_name = VALUES(workflow_name),
    required = VALUES(required),
    forbidden = VALUES(forbidden),
    description = VALUES(description),
    enforced = VALUES(enforced);

INSERT INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, forbidden, description, enforced) VALUES
    ('start-task-orchestrate', 'start-task-orchestrate', 'child_spawn',     'architect',              TRUE,  FALSE, 'Must delegate prep phases to architect', TRUE),
    ('start-task-orchestrate', 'start-task-orchestrate', 'child_complete',  'child_return',           TRUE,  FALSE, 'Must receive child completions', TRUE),
    ('start-task-orchestrate', 'start-task-orchestrate', 'step_complete',   'task_exit',              TRUE,  FALSE, 'Orchestrator must reach completion', TRUE),
    ('start-task-orchestrate', 'start-task-orchestrate', 'tool_call',       'edit_file%',             TRUE,  TRUE,  'FORBIDDEN: Must not edit files directly', TRUE),
    ('start-task-orchestrate', 'start-task-orchestrate', 'tool_call',       'apply_diff%',            TRUE,  TRUE,  'FORBIDDEN: Must not apply diffs directly', TRUE),
    ('start-task-orchestrate', 'start-task-orchestrate', 'tool_call',       'write_to_file%',         TRUE,  TRUE,  'FORBIDDEN: Must not write files directly', TRUE),
    ('start-task-orchestrate', 'start-task-orchestrate', 'mcp_call',        '%codebase___retrieval%', TRUE,  TRUE,  'FORBIDDEN: Must not explore codebase directly', TRUE),
    ('start-task-orchestrate', 'start-task-orchestrate', 'cost_checkpoint', '%',                      FALSE, FALSE, 'Cost tracking (optional)', FALSE)
ON DUPLICATE KEY UPDATE
    workflow_name = VALUES(workflow_name),
    required = VALUES(required),
    forbidden = VALUES(forbidden),
    description = VALUES(description),
    enforced = VALUES(enforced);

INSERT INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, forbidden, description, enforced) VALUES
    ('process-orchestrate', 'process-orchestrate', 'child_spawn',    'code',               TRUE,  FALSE, 'Must delegate execute phase to code mode', TRUE),
    ('process-orchestrate', 'process-orchestrate', 'child_complete', 'child_return',       TRUE,  FALSE, 'Must receive child completions', TRUE),
    ('process-orchestrate', 'process-orchestrate', 'step_complete',  'task_exit',          TRUE,  FALSE, 'Orchestrator must reach completion', TRUE),
    ('process-orchestrate', 'process-orchestrate', 'tool_call',      'edit_file%',         TRUE,  TRUE,  'FORBIDDEN: Must not edit files directly', TRUE),
    ('process-orchestrate', 'process-orchestrate', 'tool_call',      'apply_diff%',        TRUE,  TRUE,  'FORBIDDEN: Must not apply diffs directly', TRUE),
    ('process-orchestrate', 'process-orchestrate', 'tool_call',      'write_to_file%',     TRUE,  TRUE,  'FORBIDDEN: Must not write files directly', TRUE),
    ('process-orchestrate', 'process-orchestrate', 'cost_checkpoint', '%',                 FALSE, FALSE, 'Cost tracking (optional)', FALSE)
ON DUPLICATE KEY UPDATE
    workflow_name = VALUES(workflow_name),
    required = VALUES(required),
    forbidden = VALUES(forbidden),
    description = VALUES(description),
    enforced = VALUES(enforced);

INSERT INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, forbidden, description, enforced) VALUES
    ('discover-phase', 'discover-phase', 'mcp_call',       '%codebase___retrieval%', TRUE,  FALSE, 'Must use Augment context engine for discovery', TRUE),
    ('discover-phase', 'discover-phase', 'tool_call',      'read_file',             TRUE,  FALSE, 'Must read at least one file', TRUE),
    ('discover-phase', 'discover-phase', 'step_complete',  'task_exit',             TRUE,  FALSE, 'Phase must complete', TRUE),
    ('discover-phase', 'discover-phase', 'child_spawn',    '%',                     TRUE,  TRUE,  'FORBIDDEN: Specialist must not delegate', TRUE),
    ('discover-phase', 'discover-phase', 'cost_checkpoint', '%',                    FALSE, FALSE, 'Cost tracking (optional)', FALSE)
ON DUPLICATE KEY UPDATE
    workflow_name = VALUES(workflow_name),
    required = VALUES(required),
    forbidden = VALUES(forbidden),
    description = VALUES(description),
    enforced = VALUES(enforced);

INSERT INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, forbidden, description, enforced) VALUES
    ('explore-phase', 'explore-phase', 'mcp_call',       '%codebase___retrieval%', TRUE,  FALSE, 'Must use Augment context engine for exploration', TRUE),
    ('explore-phase', 'explore-phase', 'step_complete',  'task_exit',             TRUE,  FALSE, 'Phase must complete', TRUE),
    ('explore-phase', 'explore-phase', 'child_spawn',    '%',                     TRUE,  TRUE,  'FORBIDDEN: Specialist must not delegate', TRUE),
    ('explore-phase', 'explore-phase', 'cost_checkpoint', '%',                    FALSE, FALSE, 'Cost tracking (optional)', FALSE)
ON DUPLICATE KEY UPDATE
    workflow_name = VALUES(workflow_name),
    required = VALUES(required),
    forbidden = VALUES(forbidden),
    description = VALUES(description),
    enforced = VALUES(enforced);

INSERT INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, forbidden, description, enforced) VALUES
    ('prepare-phase', 'prepare-phase', 'mcp_call',       '%process_thought%',     TRUE,  FALSE, 'Must use sequential thinking', TRUE),
    ('prepare-phase', 'prepare-phase', 'mcp_call',       '%export_session%',      TRUE,  FALSE, 'Must export thinking session', TRUE),
    ('prepare-phase', 'prepare-phase', 'step_complete',  'task_exit',             TRUE,  FALSE, 'Phase must complete', TRUE),
    ('prepare-phase', 'prepare-phase', 'child_spawn',    '%',                     TRUE,  TRUE,  'FORBIDDEN: Specialist must not delegate', TRUE),
    ('prepare-phase', 'prepare-phase', 'cost_checkpoint', '%',                    FALSE, FALSE, 'Cost tracking (optional)', FALSE)
ON DUPLICATE KEY UPDATE
    workflow_name = VALUES(workflow_name),
    required = VALUES(required),
    forbidden = VALUES(forbidden),
    description = VALUES(description),
    enforced = VALUES(enforced);

INSERT INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, forbidden, description, enforced) VALUES
    ('execute-subtask', 'execute-subtask', 'mcp_call',       '%codebase___retrieval%', TRUE,  FALSE, 'Must gather context before editing', TRUE),
    ('execute-subtask', 'execute-subtask', 'gate_pass',      'ruff-format',           TRUE,  FALSE, 'Ruff format check must pass', TRUE),
    ('execute-subtask', 'execute-subtask', 'gate_pass',      'ruff-check',            TRUE,  FALSE, 'Ruff lint check must pass', TRUE),
    ('execute-subtask', 'execute-subtask', 'gate_pass',      'mypy',                  TRUE,  FALSE, 'Mypy type check must pass', TRUE),
    ('execute-subtask', 'execute-subtask', 'gate_pass',      'pytest',                TRUE,  FALSE, 'Pytest test suite must pass', TRUE),
    ('execute-subtask', 'execute-subtask', 'step_complete',  'task_exit',             TRUE,  FALSE, '[v2] Subtask must complete', TRUE),
    ('execute-subtask', 'execute-subtask', 'child_spawn',    '%',                     TRUE,  TRUE,  '[v2] FORBIDDEN: Specialist must not delegate', TRUE),
    ('execute-subtask', 'execute-subtask', 'cost_checkpoint', '%',                    FALSE, FALSE, '[v2] Cost tracking (optional)', FALSE)
ON DUPLICATE KEY UPDATE
    workflow_name = VALUES(workflow_name),
    required = VALUES(required),
    forbidden = VALUES(forbidden),
    description = VALUES(description),
    enforced = VALUES(enforced);

INSERT INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, forbidden, description, enforced) VALUES
    ('decompose-epic', 'decompose-epic', 'child_spawn',     'architect',              TRUE,  FALSE, 'Must delegate phases to architect children', TRUE),
    ('decompose-epic', 'decompose-epic', 'child_complete',  'child_return',           TRUE,  FALSE, 'Must receive child completions', TRUE),
    ('decompose-epic', 'decompose-epic', 'step_complete',   'task_exit',              TRUE,  FALSE, 'Must reach completion', TRUE),
    ('decompose-epic', 'decompose-epic', 'tool_call',       'edit_file%',             TRUE,  TRUE,  'FORBIDDEN: Must not edit files directly', TRUE),
    ('decompose-epic', 'decompose-epic', 'tool_call',       'apply_diff%',            TRUE,  TRUE,  'FORBIDDEN: Must not apply diffs directly', TRUE),
    ('decompose-epic', 'decompose-epic', 'tool_call',       'write_to_file%',         TRUE,  TRUE,  'FORBIDDEN: Must not write files directly', TRUE),
    ('decompose-epic', 'decompose-epic', 'mcp_call',        '%codebase___retrieval%', TRUE,  TRUE,  'FORBIDDEN: Must not explore codebase directly', TRUE),
    ('decompose-epic', 'decompose-epic', 'cost_checkpoint', '%',                      FALSE, FALSE, 'Cost tracking (optional)', FALSE)
ON DUPLICATE KEY UPDATE
    workflow_name = VALUES(workflow_name),
    required = VALUES(required),
    forbidden = VALUES(forbidden),
    description = VALUES(description),
    enforced = VALUES(enforced);

