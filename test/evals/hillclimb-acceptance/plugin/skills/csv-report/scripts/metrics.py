#!/usr/bin/env python3
"""csv-metrics producer — compute per-column summary statistics for a CSV.

Bundled with the csv-metrics skill. Standard library ONLY (csv, json, math,
statistics) — no third-party deps, no network — so it runs unchanged under
Cowork's default-deny egress and sealed filesystem.

Usage:
    python3 metrics.py <input.csv> <output_dir>

Writes:
    <output_dir>/metrics.json   structured stats (machine-readable)
    <output_dir>/summary.md     a short human-readable report
and prints a one-line summary to stdout.
"""
import csv
import json
import math
import statistics
import sys
from pathlib import Path


def _num(x: float):
    """Render an integral float as int, else round to 4 dp — keeps JSON clean."""
    if x == int(x):
        return int(x)
    return round(x, 4)


def _percentile(sorted_vals, p):
    """Nearest-rank percentile — deterministic and robust for tiny samples."""
    if not sorted_vals:
        return None
    k = max(1, math.ceil(p / 100 * len(sorted_vals)))
    return sorted_vals[k - 1]


def _is_numeric(values):
    """A column is numeric iff every non-empty cell parses as a float."""
    seen = False
    for v in values:
        if v == "":
            continue
        seen = True
        try:
            float(v)
        except ValueError:
            return False
    return seen


def _numeric_stats(values):
    nums = [float(v) for v in values if v != ""]
    nums_sorted = sorted(nums)
    return {
        "type": "numeric",
        "count": len(nums),
        "sum": _num(sum(nums)),
        "mean": _num(statistics.mean(nums)) if nums else None,
        "median": _num(statistics.median(nums)) if nums else None,
        "min": _num(nums_sorted[0]) if nums else None,
        "max": _num(nums_sorted[-1]) if nums else None,
        "p90": _num(_percentile(nums_sorted, 90)) if nums else None,
    }


def _categorical_stats(values):
    present = [v for v in values if v != ""]
    counts = {}
    for v in present:
        counts[v] = counts.get(v, 0) + 1
    # Deterministic tie-break: most frequent first, then alphabetical. Top 5.
    top = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:5]
    return {
        "type": "categorical",
        "count": len(present),
        "distinct": len(counts),
        "top": [[k, n] for k, n in top],
    }


def compute(csv_path: Path) -> dict:
    with csv_path.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        headers = reader.fieldnames or []
        rows = list(reader)

    columns = {}
    for h in headers:
        col = [(r.get(h) or "").strip() for r in rows]
        columns[h] = _numeric_stats(col) if _is_numeric(col) else _categorical_stats(col)

    return {"source": str(csv_path), "rows": len(rows), "columns": columns}


def render_markdown(metrics: dict) -> str:
    lines = [
        f"# CSV metrics — {Path(metrics['source']).name}",
        "",
        f"Rows: **{metrics['rows']}**",
        "",
    ]
    numeric = {k: v for k, v in metrics["columns"].items() if v["type"] == "numeric"}
    categorical = {k: v for k, v in metrics["columns"].items() if v["type"] == "categorical"}

    if numeric:
        lines += ["## Numeric columns", "", "| column | count | sum | mean | median | min | max | p90 |", "|---|---|---|---|---|---|---|---|"]
        for k, v in numeric.items():
            lines.append(f"| {k} | {v['count']} | {v['sum']} | {v['mean']} | {v['median']} | {v['min']} | {v['max']} | {v['p90']} |")
        lines.append("")

    if categorical:
        lines += ["## Categorical columns", ""]
        for k, v in categorical.items():
            top = ", ".join(f"{val} ({n})" for val, n in v["top"])
            lines.append(f"- **{k}** — {v['distinct']} distinct; top: {top}")
        lines.append("")

    return "\n".join(lines)


def main(argv) -> int:
    if len(argv) != 3:
        print("usage: metrics.py <input.csv> <output_dir>", file=sys.stderr)
        return 2
    csv_path = Path(argv[1])
    out_dir = Path(argv[2])
    if not csv_path.exists():
        print(f"input CSV not found: {csv_path}", file=sys.stderr)
        return 2

    metrics = compute(csv_path)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "metrics.json").write_text(json.dumps(metrics, indent=2) + "\n", encoding="utf-8")
    (out_dir / "summary.md").write_text(render_markdown(metrics), encoding="utf-8")

    print(f"csv-metrics: {metrics['rows']} rows, {len(metrics['columns'])} columns -> {out_dir / 'metrics.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
