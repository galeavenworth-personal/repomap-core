from __future__ import annotations

import fnmatch

from optimization import training_data as td


def _profile(**overrides: object) -> td.TaskProfile:
    base = td.TaskProfile(
        task_id="task-1",
        total_punches=20,
        tool_calls=8,
        step_start_count=10,
        step_finished_count=9,
        gate_pass_count=0,
        gate_fail_count=0,
        child_spawn_count=0,
        child_complete_count=0,
        total_cost=1.2,
        duration_minutes=12,
        distinct_tools=4,
        read_count=5,
        edit_count=3,
        bash_count=2,
        card_id=None,
        card_status=None,
        missing_punches=None,
        mode=None,
        checkpoint_status=None,
        child_modes=None,
        parent_forbidden_tool_violations=None,
        workflow_id=None,
        bead_id=None,
        bead_type=None,
        hierarchy_depth=None,
        parent_bead_id=None,
        formula_id=None,
        epic_outcome=None,
    )
    return td.TaskProfile(**{**base.__dict__, **overrides})


def test_label_task_outcome_success_from_checkpoint_pass() -> None:
    profile = _profile(checkpoint_status="pass")
    assert td.label_task_outcome(profile) == td.SessionOutcome.SUCCESS


def test_label_task_outcome_failure_from_checkpoint_fail() -> None:
    profile = _profile(checkpoint_status="fail")
    assert td.label_task_outcome(profile) == td.SessionOutcome.FAILURE


def test_label_task_outcome_uses_card_status_as_primary_signal() -> None:
    profile = _profile(card_status="pass", checkpoint_status="fail")
    assert td.label_task_outcome(profile) == td.SessionOutcome.SUCCESS


def test_label_task_outcome_failure_from_runaway_cost() -> None:
    profile = _profile(total_cost=9.1)
    assert td.label_task_outcome(profile) == td.SessionOutcome.FAILURE


def test_label_task_outcome_partial_for_mixed_signals() -> None:
    profile = _profile(
        total_cost=4.2,
        duration_minutes=35,
        step_start_count=10,
        step_finished_count=5,
    )
    assert td.label_task_outcome(profile) == td.SessionOutcome.PARTIAL


def test_infer_diagnosis_infinite_retry() -> None:
    profile = _profile(bash_count=14, duration_minutes=10)
    assert td.infer_diagnosis_category(profile) == "infinite_retry"


def test_infer_diagnosis_context_exhaustion() -> None:
    profile = _profile(read_count=40, edit_count=5, duration_minutes=30)
    assert td.infer_diagnosis_category(profile) == "context_exhaustion"


def test_infer_diagnosis_uses_card_missing_punches_context() -> None:
    profile = _profile(
        card_status="fail",
        missing_punches="FORBIDDEN violation: tool_call:edit_file",
    )
    assert td.infer_diagnosis_category(profile) == "scope_creep"


def test_identify_kill_recovery_pairs() -> None:
    failed = td.LabeledTaskProfile(
        profile=_profile(task_id="parent-fail", total_cost=10.0),
        outcome=td.SessionOutcome.FAILURE,
        diagnosis_category="model_confusion",
    )
    recovered = td.LabeledTaskProfile(
        profile=_profile(task_id="child-success", checkpoint_status="pass"),
        outcome=td.SessionOutcome.SUCCESS,
        diagnosis_category="scope_creep",
    )
    pairs = td.identify_kill_recovery_pairs(
        [failed, recovered],
        [("parent-fail", "child-success")],
    )
    assert pairs == [
        td.KillRecoveryPair(
            failed_task_id="parent-fail", recovery_task_id="child-success"
        )
    ]


def test_build_dspy_example_contains_labels() -> None:
    labeled = td.LabeledTaskProfile(
        profile=_profile(
            task_id="t-123",
            total_cost=0.7,
            card_id="execute-subtask",
            card_status="pass",
            missing_punches="",
            mode="code",
        ),
        outcome=td.SessionOutcome.SUCCESS,
        diagnosis_category="scope_creep",
    )
    example = td.build_dspy_example(labeled, {"t-123": True})
    assert example.outcome_label == "success"
    assert example.diagnosis_category == "scope_creep"
    assert example.is_kill_recovery is True
    assert example.card_id == "execute-subtask"
    assert example.card_status == "pass"
    assert example.mode == "code"


# ── New field tests ──────────────────────────────────────────────


def test_task_profile_new_fields_default_none() -> None:
    """New optional fields default to None when not specified."""
    profile = _profile()
    assert profile.child_modes is None
    assert profile.parent_forbidden_tool_violations is None
    assert profile.workflow_id is None
    assert profile.bead_id is None
    assert profile.bead_type is None
    assert profile.hierarchy_depth is None
    assert profile.parent_bead_id is None
    assert profile.formula_id is None
    assert profile.epic_outcome is None


def test_task_profile_new_fields_set() -> None:
    """New optional fields accept string values."""
    profile = _profile(
        child_modes="code,explore,code",
        parent_forbidden_tool_violations="edit_file,bash",
        workflow_id="plant-orchestrate",
    )
    assert profile.child_modes == "code,explore,code"
    assert profile.parent_forbidden_tool_violations == "edit_file,bash"
    assert profile.workflow_id == "plant-orchestrate"


def test_build_dspy_example_contains_orchestration_fields() -> None:
    """build_dspy_example includes new orchestration fields in output."""
    labeled = td.LabeledTaskProfile(
        profile=_profile(
            task_id="t-orch",
            child_modes="code,explore",
            parent_forbidden_tool_violations="edit_file",
            workflow_id="plant-orchestrate",
        ),
        outcome=td.SessionOutcome.SUCCESS,
        diagnosis_category="scope_creep",
    )
    example = td.build_dspy_example(labeled, {})
    assert example.child_modes == "code,explore"
    assert example.parent_forbidden_tool_violations == "edit_file"
    assert example.workflow_id == "plant-orchestrate"


def test_build_dspy_example_orchestration_fields_in_inputs() -> None:
    """New orchestration fields appear in the example's input keys."""
    labeled = td.LabeledTaskProfile(
        profile=_profile(task_id="t-inp"),
        outcome=td.SessionOutcome.PARTIAL,
        diagnosis_category="model_confusion",
    )
    example = td.build_dspy_example(labeled, {})
    input_keys = example.inputs().keys()
    assert "child_modes" in input_keys
    assert "parent_forbidden_tool_violations" in input_keys
    assert "workflow_id" in input_keys


def test_label_profiles_with_new_fields() -> None:
    """Labeling still works correctly when new fields are populated."""
    profile = _profile(
        child_modes="code",
        parent_forbidden_tool_violations="bash",
        workflow_id="pr-review-orchestrate",
        card_status="pass",
    )
    labeled = td.label_profiles([profile])
    assert len(labeled) == 1
    assert labeled[0].outcome == td.SessionOutcome.SUCCESS
    assert labeled[0].profile.child_modes == "code"
    assert labeled[0].profile.parent_forbidden_tool_violations == "bash"
    assert labeled[0].profile.workflow_id == "pr-review-orchestrate"


# ── Bead enrichment field tests ──────────────────────────────────


def test_task_profile_bead_fields_set() -> None:
    """Bead enrichment fields accept values."""
    profile = _profile(
        bead_id="repomap-core-abc.1",
        bead_type="task",
        hierarchy_depth=2,
        parent_bead_id="repomap-core-abc",
        formula_id="formula-deploy-v1",
        epic_outcome="closed",
    )
    assert profile.bead_id == "repomap-core-abc.1"
    assert profile.bead_type == "task"
    assert profile.hierarchy_depth == 2
    assert profile.parent_bead_id == "repomap-core-abc"
    assert profile.formula_id == "formula-deploy-v1"
    assert profile.epic_outcome == "closed"


def test_beads_enrichment_dataclass() -> None:
    """BeadsEnrichment dataclass can be constructed with all fields."""
    enrichment = td.BeadsEnrichment(
        bead_id="repomap-core-xyz.1",
        bead_type="subtask",
        hierarchy_depth=3,
        parent_bead_id="repomap-core-xyz",
        formula_id="formula-review",
        epic_outcome="open",
    )
    assert enrichment.bead_id == "repomap-core-xyz.1"
    assert enrichment.bead_type == "subtask"
    assert enrichment.hierarchy_depth == 3
    assert enrichment.parent_bead_id == "repomap-core-xyz"
    assert enrichment.formula_id == "formula-review"
    assert enrichment.epic_outcome == "open"


def test_beads_enrichment_defaults() -> None:
    """BeadsEnrichment optional fields default to None."""
    enrichment = td.BeadsEnrichment(bead_id="repomap-core-min.1")
    assert enrichment.bead_id == "repomap-core-min.1"
    assert enrichment.bead_type is None
    assert enrichment.hierarchy_depth is None
    assert enrichment.parent_bead_id is None
    assert enrichment.formula_id is None
    assert enrichment.epic_outcome is None


def test_load_beads_enrichment_empty_input() -> None:
    """_load_beads_enrichment returns empty dict for empty input."""
    result = td._load_beads_enrichment([])
    assert result == {}


def test_label_profiles_with_bead_fields() -> None:
    """Labeling works correctly when bead enrichment fields are populated."""
    profile = _profile(
        bead_id="repomap-core-test.1",
        bead_type="task",
        hierarchy_depth=2,
        parent_bead_id="repomap-core-test",
        card_status="pass",
    )
    labeled = td.label_profiles([profile])
    assert len(labeled) == 1
    assert labeled[0].outcome == td.SessionOutcome.SUCCESS
    assert labeled[0].profile.bead_id == "repomap-core-test.1"
    assert labeled[0].profile.bead_type == "task"
    assert labeled[0].profile.hierarchy_depth == 2


# ── _sql_like_to_glob tests ─────────────────────────────────────


def test_sql_like_to_glob_basic() -> None:
    """SQL LIKE wildcards % and _ translate to fnmatch * and ?."""
    # _ is a SQL LIKE single-char wildcard, converted to ?
    assert td._sql_like_to_glob("tool_call:%") == "tool?call:*"
    assert td._sql_like_to_glob("%edit_file%") == "*edit?file*"
    assert td._sql_like_to_glob("exact_match") == "exact?match"
    # No wildcards at all
    assert td._sql_like_to_glob("bash") == "bash"


def test_sql_like_to_glob_escapes_fnmatch_metacharacters() -> None:
    """Literal fnmatch metacharacters in SQL LIKE are escaped."""
    # Literal * in SQL LIKE should be escaped for fnmatch
    assert td._sql_like_to_glob("foo*bar") == "foo[*]bar"
    # Literal ? in SQL LIKE should be escaped for fnmatch
    assert td._sql_like_to_glob("foo?bar") == "foo[?]bar"
    # Literal [ in SQL LIKE should be escaped for fnmatch
    assert td._sql_like_to_glob("foo[bar") == "foo[[]bar"
    # Combined: SQL wildcards + literal metacharacters
    # _ -> ?, % -> *, [ -> [[], * -> [*], ] stays literal
    assert td._sql_like_to_glob("tool_%[*]") == "tool?*[[][*]]"


def test_sql_like_to_glob_output_works_with_fnmatchcase() -> None:
    """Converted patterns produce correct matches via fnmatch.fnmatchcase."""
    # SQL LIKE '%edit_file%' should match 'my_edit_file_v2'
    pat = td._sql_like_to_glob("%edit_file%")
    assert fnmatch.fnmatchcase("my_edit_file_v2", pat)
    assert not fnmatch.fnmatchcase("read_only", pat)

    # SQL LIKE 'tool_call:%' should match 'tool_call:bash'
    pat2 = td._sql_like_to_glob("tool_call:%")
    assert fnmatch.fnmatchcase("tool_call:bash", pat2)
    assert not fnmatch.fnmatchcase("tool_call", pat2)

    # Literal * should not act as wildcard
    pat3 = td._sql_like_to_glob("foo*bar")
    assert fnmatch.fnmatchcase("foo*bar", pat3)
    assert not fnmatch.fnmatchcase("fooXbar", pat3)
