#!/usr/bin/env python3
"""A host's action between the probe's legs: record two corrections beside a WAITING run. Exits 1 when the run is
not waiting, so a host action against the wrong state fails loudly."""
import argparse
import json
import os
import pathlib
import sys

ap = argparse.ArgumentParser()
ap.add_argument("--run", required=True)
args = ap.parse_args()
root = pathlib.Path(os.environ.get("COWORK_ARTIFACTS_ROOT") or "artifacts")
run_dir = root / "runs" / args.run
status = json.loads((run_dir / "run_status.json").read_text())
if status.get("status") != "waiting":
    print(f"run {args.run} is {status.get('status')}, not waiting", file=sys.stderr)
    sys.exit(1)
(run_dir / "corrections.json").write_text(json.dumps({"corrections": [{"field": "a"}, {"field": "b"}]}) + "\n")
print("applied 2 corrections")
