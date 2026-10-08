#!/usr/bin/env python3
"""Record the run as waiting at gate g1, BEFORE the question is asked (a waiting-first status file).

Writes <COWORK_ARTIFACTS_ROOT>/runs/r1/run_status.json. Without the variable it falls back to an
`artifacts` directory under the current directory, so the script also runs by hand.
"""
import json
import os
import pathlib

root = pathlib.Path(os.environ.get("COWORK_ARTIFACTS_ROOT") or "artifacts")
run_dir = root / "runs" / "r1"
run_dir.mkdir(parents=True, exist_ok=True)
status = {"status": "waiting", "gate": "g1", "options": ["a", "b"]}
(run_dir / "run_status.json").write_text(json.dumps(status, indent=2) + "\n")
print(f"run_status.json: waiting at g1 ({run_dir})")
