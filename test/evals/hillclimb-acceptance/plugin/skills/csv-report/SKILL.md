---
name: csv-report
description: Profile an uploaded CSV and write a metrics file, a summary and a short insights note. Use when the user asks to analyze, summarize or report on a CSV / tabular dataset.
---

# csv-report

A synthetic skill for the harness's own hillclimb acceptance run. It profiles a CSV with a bundled
producer script, then writes a short insights note for a reader who will not open the numbers.

## How to run

1. Locate the CSV (default `uploads/sales.csv`). If `outputs/metrics.json` already exists, it is the
   output of an earlier step: read it and skip to step 3 instead of re-running the producer.
2. Run the bundled producer:

   ```bash
   S="${CLAUDE_PLUGIN_ROOT}/skills/csv-report/scripts/metrics.py"
   [ -f "$S" ] || S="$(find /sessions/*/mnt/.local-plugins /sessions/*/mnt/.remote-plugins \
     -path '*/skills/csv-report/scripts/metrics.py' 2>/dev/null | head -1)"
   python3 "$S" uploads/sales.csv outputs
   ```

   It writes `outputs/metrics.json` and `outputs/summary.md`.
3. Write `outputs/insights.md`: three to five bullets a manager can act on, each grounded in a number
   from `outputs/metrics.json`.
4. Reply with one line naming the files you wrote.

## Audits and cross-checks

- When the user asks for an **audit** of the numbers, invoke the `csv-audit` skill and report its findings.
- When the user asks for an **independent cross-check**, dispatch the `csv-checker` agent with the path to
  `outputs/metrics.json` and report whether it agrees.

## Constraints

- Standard library only: no `pip install`, no network.
- Do not delete files in `outputs/`.
