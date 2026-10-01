// `fixture`'s flag set and usage text: a leaf module (no imports) so the usage-guard registry in cassette.ts can
// reference it without an import cycle.

export const FIXTURE_BOOLEAN_FLAGS = ["--allow-host-paths"] as const;
export const FIXTURE_VALUE_FLAGS = ["--out", "--output-format"] as const;
export const FIXTURE_USAGE =
  "usage: fixture export <run-dir> --out <dir> [--allow-host-paths] [--output-format text|json]   (copy a kept run's outputs tree into a directory a scenario can start from)\n" +
  "       Reads the latest result.json the run wrote for its outputs dir (cumulative across turns; session-root scratchpad files are not exported); the files are always read from the given run dir's own work/ tree, so a moved or copied run dir exports its own files. Copies every regular file byte-for-byte, keeping permission bits. Symlinks, hard-linked and unreadable files, and anything that is not a regular file (a FIFO), are skipped and listed. The whole tree is read into memory before writing.\n" +
  "       --out: must not exist, or be an empty directory, and must not be inside the run dir; an export never merges.\n" +
  "       Refuses, naming the files and writing nothing, when a file's bytes or its name contain a secret — the credentials in CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN and ANTHROPIC_CUSTOM_HEADERS, the variables named in COWORK_HARNESS_SCRUB_KEYS and the values in COWORK_HARNESS_SCRUB_VALUES, each also in its base64, URL-encoded and JSON-escaped forms — checked verbatim as UTF-8, Latin-1, UTF-16LE and UTF-16BE bytes; or a text file or a file name contains a host path. --allow-host-paths accepts host paths, but a path into a harness run dir, the runs dir, the VM work dir or a guest session (/sessions/<id>/mnt/... or /sessions/<id>/.claude/...) is refused regardless. Compressed formats (xlsx, docx, pdf, images) are not inspected beyond that byte check, and binary files are not scanned for paths: review them yourself. Emails, domains and machine identifiers are reported as notes.\n" +
  "       A partial or failed run exports, and says so; a replay run dir is refused (its outputs came from a cassette).\n" +
  "       exit 0 written · 2 usage or refusal (nothing written). Text mode writes its report to STDERR; --output-format json prints one payload document on stdout.";
