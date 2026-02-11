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
from typing import TextIO


def _format_invocation(argv: list[str]) -> str:
    return " ".join(shlex.quote(a) for a in argv)


def _emit_contract(contract: dict, *, stream: TextIO) -> None:
    json.dump(contract, stream, sort_keys=True)
    stream.write("\n")
    stream.flush()


def _kill_process_group(proc: subprocess.Popen[str]) -> None:
    """Best-effort kill of the process group."""
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        return
    except Exception:
        # Fall back to process-only kill.
        try:
            proc.kill()
        except Exception:
            return


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="bounded_gate")
    parser.add_argument("--gate-id", required=True)
    parser.add_argument("--cwd", default=".")
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

    if not args.json_only:
        sys.stderr.write(
            f"[bounded-gate] gate_id={args.gate_id} cwd={cwd} cmd={invocation}\n"
        )

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
            "invocation": invocation,
            "elapsed_seconds": round(elapsed, 3),
            "last_output_lines": [f"error: {exc}"],
            "stop_reason": "env_missing",
            "repro_hints": [
                f"Run from repo root: {os.getcwd()}",
                f"cwd used for this run: {cwd}",
                "Ensure the command exists and required venv deps are installed.",
            ],
        }
        _emit_contract(contract, stream=sys.stdout)
        return 2

    assert proc.stdout is not None  # for mypy

    def _read_output() -> None:
        nonlocal last_output
        for raw in proc.stdout:
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
        except Exception:
            pass
        # Best-effort join; don't block indefinitely.
        reader.join(timeout=1)

        elapsed = time.monotonic() - start
        contract = {
            "gate_id": args.gate_id,
            "invocation": invocation,
            "elapsed_seconds": round(elapsed, 3),
            "last_output_lines": list(tail),
            "stop_reason": stop_reason,
            "repro_hints": [
                f"Run from repo root: {os.getcwd()}",
                f"cwd used for this run: {cwd}",
                "If the gate produces sparse output, increase verbosity to reduce false stall classification.",
                "Re-run with: .venv/bin/python .kilocode/tools/bounded_gate.py --pass-through --tail-lines 50 --gate-id <gate> --timeout-seconds <N> --stall-seconds <M> -- <command>",
            ],
        }
        _emit_contract(contract, stream=sys.stdout)
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
            "invocation": invocation,
            "elapsed_seconds": round(elapsed, 3),
            "last_output_lines": list(tail),
            "stop_reason": "env_missing",
            "repro_hints": [
                f"Run from repo root: {os.getcwd()}",
                f"cwd used for this run: {cwd}",
                "Install dev tooling (ruff/mypy/pytest) into the venv (e.g. pip install -e '.[dev]').",
            ],
        }
        _emit_contract(contract, stream=sys.stdout)
        return 2

    if not args.json_only:
        sys.stderr.write(
            f"[bounded-gate] status={'PASS' if rc == 0 else 'FAIL'} rc={rc} elapsed_seconds={elapsed:.3f}\n"
        )
        if rc != 0 and tail:
            sys.stderr.write("[bounded-gate] last_output_lines (tail):\n")
            for line in tail:
                sys.stderr.write(line + "\n")

    return rc


if __name__ == "__main__":
    raise SystemExit(main())
