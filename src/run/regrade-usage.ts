// `regrade`'s flag set and usage text: a leaf module (no imports) so the usage-guard registry in cassette.ts
// can reference them without an import cycle through regrade.ts -> execute.ts -> cassette.ts.

export const REGRADE_BOOLEAN_FLAGS = [] as const;
export const REGRADE_VALUE_FLAGS = ["--scenario", "--judge-model", "--authored-total-bytes", "--output-format"] as const;
export const REGRADE_USAGE =
  "usage: regrade <run-dir>… --scenario <scenario.yaml> [--judge-model <model-id>] [--authored-total-bytes <N>] [--output-format text|json]   (re-grade a kept run's semantic_matches asserts with the judge; no live agent — the judge call is the only spend)\n" +
  "       --scenario: the scenario whose semantic_matches asserts are graded (usually the kept run's, with a revised rubric); every other assert is listed as not re-graded.\n" +
  "       --judge-model: grade every semantic_matches assert with this model. It must name exactly one model — an alias (opus, sonnet, best…) is refused. Without it each assert's judge_model, else COWORK_HARNESS_JUDGE_MODEL, else the default, each of which must be concrete too.\n" +
  "       --authored-total-bytes: the authored-file capture budget, for a run recorded before result.json persisted it (authoredCapture). Such a run is refused without it. On a newer run it overrides the persisted value, and the judged document is then reported as scope_changed.\n" +
  "       Writes turns/<N>/regrade/<prompt-hash>-<judge-model>-<time>.json in each run dir; result.json is never modified. Single-turn run dirs only. A pruned work dir, a partial, replay or chat run is refused.\n" +
  "       docMatchesLive: true — the judge read the same document the live judge did; false — it did not (the differing sections are listed); scope_changed — the rubric's evidence scope or the capture budget changed, so a different document was expected; unknown — the run did not record the live document's fingerprint.\n" +
  "       exit 0 every re-graded assert passes · 1 any fails · 2 usage or refusal (nothing is graded when any run dir is refused). Text mode writes its report to STDERR; --output-format json prints one payload document on stdout.";
