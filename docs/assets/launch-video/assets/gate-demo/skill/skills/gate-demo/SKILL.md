---
name: gate-demo
description: Video-demo skill under test. Summarizes an uploaded CSV, always asking which output format the user wants first.
---

# gate-demo

Video-only demo skill (see docs/internal/2026-07-01-gate-provenance-video-beat-proposal.md) whose
entire purpose is to fire exactly one gate, deterministically, on every run — not an improvised
skill whose question-asking is incidental.

## How to run

1. Before doing anything else — before reading the file, before writing any output — use
   AskUserQuestion to ask the user: "Which output format do you want?" with two options,
   `Markdown` and `Plain text`. Always ask this. Never skip it, never infer a default.
2. Once answered, read the uploaded CSV (`uploads/sales.csv`).
3. Write a one-paragraph summary of the CSV's contents to `outputs/summary.md` (or
   `outputs/summary.txt` if "Plain text" was chosen), in the format the user picked.
4. Reply with a one-line confirmation naming the output file you wrote.
