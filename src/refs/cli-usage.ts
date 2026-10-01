// `ref`'s flag set and usage text: a leaf module (no imports), like regrade-usage.ts.
// One flag set for both subcommands (the parser is shared); `ref verify` refuses the freeze-only flags.

export const REF_FREEZE_BOOLEAN_FLAGS = ["--allow-unchecked"] as const;
export const REF_FREEZE_VALUE_FLAGS = ["--scenario", "--out", "--case-id", "--output-format"] as const;
export const REF_USAGE =
  "usage: ref freeze <run-dir> --scenario <scenario.yaml> --out <store-dir> [--case-id <id>] [--allow-unchecked] [--output-format text|json]\n" +
  "       ref verify <store-dir>… [--output-format text|json]\n" +
  "   freeze: compose the kept run's judged document for each semantic_pairwise assert in --scenario and freeze it into\n" +
  "       <store-dir>/<case-id>/ (case id = the scenario's name — its file stem unless `name:` overrides it — made path-safe).\n" +
  "       The run must be of --scenario (same name and prompt). Each document must match the fingerprint\n" +
  "       the live judge recorded for that run; a document that differs is refused, and one with no live fingerprint is refused\n" +
  "       unless --allow-unchecked (it is then stored marked unchecked). A frozen document is never rewritten: an existing entry\n" +
  "       from the same run gains only compose keys it lacks; from a different run it is refused.\n" +
  "   verify: re-hash every frozen document in each store, check each entry's ref.json against the hash its documents\n" +
  "       recorded and that it names the task it was frozen for, and check the layout.\n" +
  "   exit 0 done / clean · 1 verify found a damaged entry · 2 usage or refusal (nothing written).";
