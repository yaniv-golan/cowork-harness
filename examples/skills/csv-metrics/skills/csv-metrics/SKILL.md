---
name: csv-metrics
description: Compute summary statistics for a CSV and write a JSON + markdown report. Use when the user asks to analyze, summarize, profile, or compute metrics for a CSV / tabular dataset.
---

# csv-metrics

Profiles a CSV and writes two deliverables: a structured `metrics.json` and a
human-readable `summary.md`. The work is done by a **bundled producer script**
(`scripts/metrics.py`) — you run it, you don't reimplement it.

## When to use

The user has a CSV (in `uploads/` or a connected project folder) and wants
per-column statistics or a metrics report.

## How to run

1. Locate the CSV. Default for this example: `uploads/sales.csv`.
2. Run the bundled producer, passing the CSV and the output directory. The
   script lives under this skill's `scripts/` folder, reachable via
   `${CLAUDE_PLUGIN_ROOT}`:

   ```bash
   S="${CLAUDE_PLUGIN_ROOT}/skills/csv-metrics/scripts/metrics.py"
   [ -f "$S" ] || S="$(find /sessions/*/mnt/.local-plugins /sessions/*/mnt/.remote-plugins \
     -path '*/skills/csv-metrics/scripts/metrics.py' 2>/dev/null | head -1)"
   python3 "$S" uploads/sales.csv outputs
   ```

   In Cowork's default host-loop mode the bash tool rewrites the host path the agent writes in
   for `${CLAUDE_PLUGIN_ROOT}` to the plugin's mount inside the VM, so the first line finds the
   script; the second line is the fallback for a Desktop older than 1.40609.0, or a plugin whose
   mount path the rewrite skips, and finds the script at that mount.

   It writes `outputs/metrics.json` and `outputs/summary.md` and prints a
   one-line summary.
3. Read `outputs/summary.md`, then reply with a single line that includes the
   row count and the path `outputs/metrics.json`.

## Constraints

- The producer uses **only the Python standard library** — no `pip install`, no
  network. That is deliberate: under Cowork the agent runs with default-deny
  egress and no pypi access, so a skill's producer must be self-contained.
- Treat `outputs/` as write-once for the deliverable: don't delete or rewrite
  the files after the producer emits them.
