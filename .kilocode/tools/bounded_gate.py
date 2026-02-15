"""Bounded gate runner for deterministic line-health execution.

This is intentionally kept in the workflow/runner layer (under `.kilocode/`) so
we can enforce budgets without changing product code.

Behavior:
- Runs an arbitrary command with:
  - wall-clock timeout (`--timeout-seconds`)
  - no-output/stall timeout (`--stall-seconds`)
  - bounded tail capture (`--tail-lines`)
- On timeout/stall/env-missing, emits a Line Fault Contract JSON (MVP fields)
  and exits with code 2.
- Always appends a `gate_run.v1` JSONL audit record to `.kilocode/gate_runs.jsonl`.
  The audit record is keyed by a deterministic run signature: `bead_id + run_timestamp`.
- Otherwise, exits with the wrapped command's exit code.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import signal
import subprocess
import sys
import time
from collections import deque
from datetime import datetime, timezone
from typing import TextIO


def _format_invocation(argv: list[str]) -> str:
    return " ".join(shlex.quote(a) for a in argv)


def _emit_contract(contract: dict, *, stream: TextIO) -> None:
    json.dump(contract, stream, sort_keys=True)
    stream.write("\n")
    stream.flush()


def _append_audit_record(
    audit_log_path: str,
    *,
    bead_id: str,
    run_timestamp: str,
    gate_id: str,
    status: str,
    exit_code: int,
    elapsed_seconds: float,
    invocation: str,
    stop_reason: str | None,
) -> None:
    """Append a gate_run.v1 JSONL record to the audit log."""
    run_signature = f"bead_id={bead_id} run_timestamp={run_timestamp}"
    record = {
        "schema_version": "gate_run.v1",
        "bead_id": bead_id,
        "run_timestamp": run_timestamp,
        "run_signature": run_signature,
        "gate_id": gate_id,
        "status": status,
        "exit_code": exit_code,
        "elapsed_seconds": round(elapsed_seconds, 3),
        "invocation": invocation,
        "stop_reason": stop_reason,
    }
    try:
        os.makedirs(os.path.dirname(audit_log_path), exist_ok=True)
        with open(audit_log_path, "a") as f:
            json.dump(record, f, sort_keys=True)
            f.write("\n")
    except OSError as exc:
        # Audit is mandatory: failing to record proof-of-execution must fail the gate run.
        sys.stderr.write(f"[bounded-gate] ERROR: cannot write audit log: {exc}\n")
        raise SystemExit(3)


def _kill_process_group(proc: subprocess.Popen[str]) -> None:
    """Best-effort kill of the process group."""
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        return
    except PermissionError:
        return
    except OSError:
        # Fall back to process-only kill.
        try:
            proc.kill()
        except (ProcessLookupError, PermissionError, OSError):
            return


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="bounded_gate")
    parser.add_argument("--gate-id", required=True)
    parser.add_argument("--cwd", default=".")
    parser.add_argument(
        "--bead-id",
        help=(
            "Beads task ID. Together with --run-timestamp forms gate_run_signature. "
            "If omitted, defaults to 'adhoc'."
        ),
    )
    parser.add_argument(
        "--run-timestamp",
        help=(
            "ISO 8601 UTC timestamp for this run. Use one shared value across all gates in a batch "
            "so proof can be verified by (bead_id, run_timestamp). If omitted, uses current UTC time."
        ),
    )
    parser.add_argument("--timeout-seconds", type=float, default=600)
    parser.add_argument("--stall-seconds", type=float, default=60)
    parser.add_argument("--tail-lines", type=int, default=50)
    parser.add_argument(
        "--json-only",
        action="store_true",
        help="If set, do not emit human-readable status lines; only emit JSON on faults.",
    )
    parser.add_argument(
        "--pass-through",
        action="store_true",
        help="If set, stream subprocess output live (in addition to tail capture).",
    )
    parser.add_argument("cmd", nargs=argparse.REMAINDER)

    args = parser.parse_args(argv)

    bead_id_defaulted = args.bead_id is None
    run_timestamp_defaulted = args.run_timestamp is None
    if bead_id_defaulted:
        args.bead_id = "adhoc"
    if run_timestamp_defaulted:
        args.run_timestamp = datetime.now(timezone.utc).isoformat()

    if (bead_id_defaulted or run_timestamp_defaulted) and not args.json_only:
        sys.stderr.write(
            "⚠ --bead-id / --run-timestamp not provided; using defaults for audit record\n"
        )

    if not args.cmd or args.cmd[0] != "--":
        parser.error("command must be provided after '--' (e.g. -- <cmd> <args...>)")

    cmd = args.cmd[1:]
    if not cmd:
        parser.error("empty command after '--'")

    start = time.monotonic()
    last_output = start
    tail: deque[str] = deque(maxlen=max(1, args.tail_lines))

    invocation = _format_invocation(cmd)
    cwd = os.path.abspath(args.cwd)
    audit_log_path = os.path.join(cwd, ".kilocode", "gate_runs.jsonl")
    run_signature = f"bead_id={args.bead_id} run_timestamp={args.run_timestamp}"

    def _maybe_append_audit_record(
        *, exit_code: int, elapsed_seconds: float, stop_reason: str | None
    ) -> None:
        status = (
            "fault"
            if stop_reason is not None
            else ("pass" if exit_code == 0 else "fail")
        )
        _append_audit_record(
            audit_log_path,
            bead_id=str(args.bead_id),
            run_timestamp=args.run_timestamp,
            gate_id=str(args.gate_id),
            status=status,
            exit_code=int(exit_code),
            elapsed_seconds=float(elapsed_seconds),
            invocation=invocation,
            stop_reason=stop_reason,
        )

    if not args.json_only:
        sys.stderr.write(
            f"[bounded-gate] gate_id={args.gate_id} cwd={cwd} cmd={invocation}\n"
        )
        sys.stderr.write(f"[bounded-gate] gate_run_signature={run_signature}\n")

    try:
        proc = subprocess.Popen(
            cmd,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            start_new_session=True,  # enables killpg
        )
    except FileNotFoundError as exc:
        elapsed = time.monotonic() - start
        contract = {
            "gate_id": args.gate_id,
            "bead_id": str(args.bead_id),
            "run_timestamp": str(args.run_timestamp),
            "run_signature": run_signature,
            "invocation": invocation,
            "elapsed_seconds": round(elapsed, 3),
            "last_output_lines": [f"error: {exc}"],
            "stop_reason": "env_missing",
            "repro_hints": [
                f"Runner cwd (diagnostic only): {os.getcwd()}",
                f"Command cwd (--cwd): {cwd}",
                "If the repo root differs, re-run from repo root or pass the repo root via --cwd.",
                "Ensure the command exists and required venv deps are installed.",
            ],
        }
        _emit_contract(contract, stream=sys.stdout)
        _maybe_append_audit_record(
            exit_code=2, elapsed_seconds=elapsed, stop_reason="env_missing"
        )
        return 2

    assert proc.stdout is not None  # for mypy
    stdout = proc.stdout

    def _read_output() -> None:
        nonlocal last_output
        for raw in stdout:
            line = raw.rstrip("\n")
            tail.append(line)
            last_output = time.monotonic()
            if args.pass_through and not args.json_only:
                sys.stderr.write(line + "\n")

    # Read output in a background thread so we can implement stall detection.
    import threading

    reader = threading.Thread(
        target=_read_output, name="bounded-gate-reader", daemon=True
    )
    reader.start()

    stop_reason: str | None = None
    while proc.poll() is None:
        now = time.monotonic()
        if args.timeout_seconds and now - start > args.timeout_seconds:
            stop_reason = "timeout"
            break
        if args.stall_seconds and now - last_output > args.stall_seconds:
            stop_reason = "stall"
            break
        time.sleep(0.1)

    if stop_reason is not None:
        _kill_process_group(proc)
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            # The process group kill above is best-effort; do not block teardown.
            pass
        except (ProcessLookupError, OSError):
            # A race (already-exited) or OS-level error shouldn't prevent emitting a contract.
            pass
        # Best-effort join; don't block indefinitely.
        reader.join(timeout=1)

        elapsed = time.monotonic() - start
        contract = {
            "gate_id": args.gate_id,
            "bead_id": str(args.bead_id),
            "run_timestamp": str(args.run_timestamp),
            "run_signature": run_signature,
            "invocation": invocation,
            "elapsed_seconds": round(elapsed, 3),
            "last_output_lines": list(tail),
            "stop_reason": stop_reason,
            "repro_hints": [
                f"Runner cwd (diagnostic only): {os.getcwd()}",
                f"Command cwd (--cwd): {cwd}",
                "If the repo root differs, re-run from repo root or pass the repo root via --cwd.",
                "If the gate produces sparse output, increase verbosity to reduce false stall classification.",
                "Re-run with: .venv/bin/python .kilocode/tools/bounded_gate.py --bead-id <task-id> --run-timestamp <RUN_TS> --pass-through --tail-lines 50 --gate-id <gate> --timeout-seconds <N> --stall-seconds <M> -- <command>",
            ],
        }
        _emit_contract(contract, stream=sys.stdout)
        _maybe_append_audit_record(
            exit_code=2, elapsed_seconds=elapsed, stop_reason=stop_reason
        )
        return 2

    # Command completed normally.
    reader.join(timeout=1)
    elapsed = time.monotonic() - start
    rc = int(proc.returncode or 0)

    # Heuristic env-missing classification: common for missing tooling like ruff/mypy/pytest.
    # If triggered, emit a contract so Orchestrator can route to Fitter.
    env_missing_markers = (
        "No module named ",
        "ModuleNotFoundError:",
        "command not found",
    )
    if rc != 0 and any(any(m in line for m in env_missing_markers) for line in tail):
        contract = {
            "gate_id": args.gate_id,
            "bead_id": str(args.bead_id),
            "run_timestamp": str(args.run_timestamp),
            "run_signature": run_signature,
            "invocation": invocation,
            "elapsed_seconds": round(elapsed, 3),
            "last_output_lines": list(tail),
            "stop_reason": "env_missing",
            "repro_hints": [
                f"Runner cwd (diagnostic only): {os.getcwd()}",
                f"Command cwd (--cwd): {cwd}",
                "If the repo root differs, re-run from repo root or pass the repo root via --cwd.",
                "Install dev tooling (ruff/mypy/pytest) into the venv (e.g. pip install -e '.[dev]').",
            ],
        }
        _emit_contract(contract, stream=sys.stdout)
        _maybe_append_audit_record(
            exit_code=2, elapsed_seconds=elapsed, stop_reason="env_missing"
        )
        return 2

    if not args.json_only:
        sys.stderr.write(
            f"[bounded-gate] status={'PASS' if rc == 0 else 'FAIL'} rc={rc} elapsed_seconds={elapsed:.3f}\n"
        )
        if rc != 0 and tail:
            sys.stderr.write("[bounded-gate] last_output_lines (tail):\n")
            for line in tail:
                sys.stderr.write(line + "\n")

    _maybe_append_audit_record(exit_code=rc, elapsed_seconds=elapsed, stop_reason=None)
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
