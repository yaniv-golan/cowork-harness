// `fixture`'s flag set and usage text: a leaf module (no imports) so the usage-guard registry in cassette.ts can
// reference it without an import cycle.

export const FIXTURE_BOOLEAN_FLAGS = ["--allow-host-paths"] as const;
export const FIXTURE_VALUE_FLAGS = ["--out", "--output-format"] as const;
export const FIXTURE_USAGE =
  "usage: fixture export <run-dir> --out <dir> [--allow-host-paths] [--output-format text|json]   (copy a kept run's outputs tree into a directory a scenario can start from)\n" +
  "       Reads the latest result.json the run wrote for its outputs dir (cumulative across turns; session-root scratchpad files are not exported); a run dir moved since it ran is read from its own work/ tree. Copies every regular file byte-for-byte, keeping permission bits. Symlinks, hard-linked and unreadable files are skipped and listed.\n" +
  "       --out: must not exist, or be an empty directory, and must not be inside the run dir; an export never merges.\n" +
  "       Refuses, naming the files and writing nothing, when a file's bytes or its name contain a value from the secret set (this process's environment and COWORK_HARNESS_SCRUB_*), or a text file contains a host path; --allow-host-paths accepts host paths, but a path into a harness run dir, the runs dir, the VM work dir or the guest /sessions/ tree is refused regardless. Compressed or binary formats (xlsx, docx, pdf, images) are copied without inspection beyond that byte check: review them yourself. Emails, domains and machine identifiers are reported as notes.\n" +
  "       A partial or failed run exports, and says so; a replay run dir is refused (its outputs came from a cassette).\n" +
  "       exit 0 written · 2 usage or refusal (nothing written). Text mode writes its report to STDERR; --output-format json prints one payload document on stdout.";
