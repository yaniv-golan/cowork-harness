---
name: csv-audit
description: Audit outputs/metrics.json for data-quality problems and return a findings list. Use when asked to audit CSV metrics.
context: fork
---

# csv-audit

Read `outputs/metrics.json` (and the CSV it names, if present). Return a findings list, one line each:

- rows whose numeric values are zero or missing, and which columns they affect;
- any column whose mean and median differ by more than 20%;
- whether the row count matches the CSV.

End with one line: `audit: <n> findings`. Do not write any files.
