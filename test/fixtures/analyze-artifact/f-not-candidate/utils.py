"""Ordinary helper module — no browser markers, no write-back primitives. Scanning every .py file in a
skill must not fail strict just because it's Python; this file proves the candidacy negative."""

import json
from pathlib import Path


def load_config(path: str) -> dict:
    with open(path) as f:
        return json.load(f)


def write_summary(rows: list[dict], out_dir: Path) -> Path:
    out_path = out_dir / "summary.json"
    out_path.write_text(json.dumps(rows, indent=2))
    return out_path
