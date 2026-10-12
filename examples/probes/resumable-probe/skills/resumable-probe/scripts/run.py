#!/usr/bin/env python3
"""The resumable probe's one step script: start a run that parks at gate g1, or resume a waiting one.

State lives in <COWORK_ARTIFACTS_ROOT>/runs/r1/run_status.json (falls back to ./artifacts so it runs by hand):
- no status yet: write step1.json, record the run `waiting` at g1 (invocation 1), exit 12 (waiting, nothing asked);
- `waiting` + --answer: resume from g1 without rewriting step1.json, write report.json, record `complete`
  (invocation 2, resumed_from g1, and which files the resume left untouched), exit 0;
- `waiting` without --answer: still waiting, exit 12.
The status names the script dir (scripts_dir_shell) so a host can run apply_corrections.py from it.
"""
import argparse
import hashlib
import json
import os
import pathlib
import sys

ap = argparse.ArgumentParser()
ap.add_argument("--answer")
args = ap.parse_args()

root = pathlib.Path(os.environ.get("COWORK_ARTIFACTS_ROOT") or "artifacts")
run_dir = root / "runs" / "r1"
run_dir.mkdir(parents=True, exist_ok=True)
status_path = run_dir / "run_status.json"
scripts_dir = str(pathlib.Path(__file__).resolve().parent)


def digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else None


def write(status):
    status_path.write_text(json.dumps(status, indent=2) + "\n")


status = json.loads(status_path.read_text()) if status_path.is_file() else None
if status is None:
    (run_dir / "step1.json").write_text(json.dumps({"step": 1, "result": "extracted"}) + "\n")
    write(
        {
            "status": "waiting",
            "gate": "g1",
            "options": ["a", "b"],
            "invocation": 1,
            "resumed_from": None,
            "scripts_dir_shell": scripts_dir,
            "invocations": [{"n": 1, "kind": "start", "step1_sha256": digest(run_dir / "step1.json")}],
        }
    )
    print("run_status.json: waiting at g1")
    sys.exit(12)
if status.get("status") == "waiting" and args.answer:
    before = digest(run_dir / "step1.json")
    (run_dir / "report.json").write_text(json.dumps({"gate": "g1", "answer": args.answer}) + "\n")
    status.update(
        {
            "status": "complete",
            "invocation": status.get("invocation", 1) + 1,
            "resumed_from": {"gate": "g1", "step": "2", "reason": "resume"},
        }
    )
    status["invocations"].append(
        {
            "n": status["invocation"],
            "kind": "resume",
            "untouched_since_resume": {"step1_json": before is not None and digest(run_dir / "step1.json") == before},
        }
    )
    write(status)
    print("run_status.json: complete")
    sys.exit(0)
print(f"run_status.json: {status.get('status')} (no answer given)")
sys.exit(12 if status.get("status") == "waiting" else 0)
