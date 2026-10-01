// `fixture`'s flag set and usage text: a leaf module (no imports) so the usage-guard registry in cassette.ts can
// reference it without an import cycle.

export const FIXTURE_BOOLEAN_FLAGS = ["--allow-host-paths"] as const;
export const FIXTURE_VALUE_FLAGS = ["--out", "--output-format"] as const;
export const FIXTURE_USAGE =
  "usage: fixture export <run-dir> --out <dir> [--allow-host-paths] [--output-format text|json]   (copy a kept run's outputs tree into a directory a scenario can start from)\n" +
  "       Reads the run's latest result.json for its outputs dir (cumulative across turns; session-root scratchpad files are not exported) and copies every regular file byte-for-byte, keeping permission bits. Symlinks and hard-linked files are skipped and listed.\n" +
  "       --out: must not exist, or be an empty directory; an export never merges.\n" +
  "       Refuses, naming the files and writing nothing, when a text file contains a value from the secret set (COWORK_HARNESS_SCRUB_* and the credentials in this process's environment) or a host path; --allow-host-paths accepts host paths, but a path into a harness run dir or VM work dir is refused regardless. Emails, domains and machine identifiers are reported as notes. Binary files are copied unscanned and noted.\n" +
  "       A partial run (stopped at a gate) exports normally; a replay run dir is refused (its outputs came from a cassette).\n" +
  "       exit 0 written · 2 usage or refusal (nothing written). Text mode writes its report to STDERR; --output-format json prints one payload document on stdout.";
