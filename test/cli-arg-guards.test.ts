import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// Structural guard (built incrementally as commands migrate to parseArgs): every migrated command must
// reject an unknown flag and an extra positional with exit 2, and must not mistake a value-flag's value
// for the target. Needs dist/cli.js (the `ci` script builds first); skips cleanly otherwise.
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

function run(args: string[], cwd: string) {
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8", cwd });
  return { code: r.status, out: r.stdout + r.stderr };
}

const cassette = () =>
  JSON.stringify({
    scenario: {
      name: "c",
      baseline: "latest",
      session: "(inline)",
      fidelity: "container",
      prompt: "hi",
      answers: [],
      expect_denied: [],
      assert: [{ result: "success" }],
    },
    events: [JSON.stringify({ type: "result", subtype: "success" })],
  });

describe.skipIf(!can)("CLI arg guards — migrated commands fail loud", () => {
  it("record: unknown flag → exit 2", () => {
    const d = mkdtempSync(join(tmpdir(), "g-"));
    writeFileSync(join(d, "s.yaml"), "prompt: hi\n");
    expect(run(["record", "s.yaml", "--typo"], d).code).toBe(2);
  });

  it("record: --output-format value is not read as a 2nd positional", () => {
    const d = mkdtempSync(join(tmpdir(), "g-"));
    const r = run(["record", "missing.yaml", "--output-format", "json"], d);
    expect(r.out).not.toMatch(/got 2/); // it failed for a real reason, not the multi-positional mis-parse
  });

  it("record: --out with a flag-looking value → exit 2", () => {
    const d = mkdtempSync(join(tmpdir(), "g-"));
    writeFileSync(join(d, "s.yaml"), "prompt: hi\n");
    expect(run(["record", "s.yaml", "--out", "--no-redact"], d).code).toBe(2);
  });

  it("verify-cassettes: --output-format value is not read as the target", () => {
    const d = mkdtempSync(join(tmpdir(), "g-"));
    writeFileSync(join(d, "ok.cassette.json"), cassette());
    // `verify-cassettes <dir> --output-format json` must scan the dir, not treat `json` as the target.
    const r = run(["verify-cassettes", d, "--output-format", "json"], d);
    expect(r.code).toBe(0);
  });

  it("verify-cassettes: extra positional → exit 2", () => {
    const d = mkdtempSync(join(tmpdir(), "g-"));
    writeFileSync(join(d, "ok.cassette.json"), cassette());
    expect(run(["verify-cassettes", join(d, "ok.cassette.json"), "extra.cassette.json"], d).code).toBe(2);
  });

  it("verify-cassettes: unknown flag → exit 2", () => {
    const d = mkdtempSync(join(tmpdir(), "g-"));
    writeFileSync(join(d, "ok.cassette.json"), cassette());
    expect(run(["verify-cassettes", join(d, "ok.cassette.json"), "--typo"], d).code).toBe(2);
  });

  it("decide: --decider-cmd with a flag-looking value → exit 2 (not swallowing the next flag)", () => {
    const d = mkdtempSync(join(tmpdir(), "g-"));
    expect(run(["decide", "--decider-cmd", "--question", "confirm?"], d).code).toBe(2);
  });

  it("replay: a directory of cassettes is replayed", () => {
    const d = mkdtempSync(join(tmpdir(), "g-"));
    writeFileSync(join(d, "a.cassette.json"), cassette());
    writeFileSync(join(d, "b.cassette.json"), cassette());
    expect(run(["replay", d, "--output-format", "json"], d).code).toBe(0);
  });

  it("replay: an empty directory is a loud non-zero (no vacuous pass)", () => {
    const d = mkdtempSync(join(tmpdir(), "g-"));
    expect(run(["replay", d], d).code).toBe(2);
  });

  it("replay: a cassette missing the optional `assert` key does not crash (readCassette normalizes it)", () => {
    const d = mkdtempSync(join(tmpdir(), "g-"));
    const noAssert = JSON.stringify({
      scenario: { name: "c", baseline: "latest", session: "(inline)", fidelity: "container", prompt: "hi", answers: [], expect_denied: [] },
      events: [JSON.stringify({ type: "result", subtype: "success" })],
    });
    writeFileSync(join(d, "a.cassette.json"), noAssert);
    const r = run(["replay", join(d, "a.cassette.json"), "--output-format", "json"], d);
    expect(r.out).not.toMatch(/Cannot read properties of undefined/); // no NPE
    expect(r.code).toBe(0);
  });

  it("replay: an unreadable cassette in a dir does not yield ok:true (no false green)", () => {
    const d = mkdtempSync(join(tmpdir(), "g-"));
    writeFileSync(join(d, "ok.cassette.json"), cassette());
    writeFileSync(join(d, "bad.cassette.json"), "{ not valid json");
    const r = run(["replay", d, "--output-format", "json"], d);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/"ok":false/);
  });
});

// skill + common flags accept BOTH `--flag value` and `--flag=value`. The old hand-rolled loops
// matched flags by exact `a === "--flag"`, so the documented equals form fell through to the unknown-flag
// guard for everything except the two `--output-format=` literals. We assert each documented value-flag's
// `=value` form parses the SAME as its spaced form (no "unknown flag", same dry-run plan).
describe.skipIf(!can)("skill/common flags accept --flag=value identically to --flag value", () => {
  // skill --dry-run validates everything then prints the parsed plan as JSON and exits 0 — a spawn-free,
  // token-free way to compare the two flag forms.
  function dryRun(extra: string[], d: string) {
    const r = run(["skill", "./plugin", "do the thing", "--dry-run", ...extra], d);
    let plan: any = null;
    // stdout carries the dry-run JSON; the helper folds stderr+stdout into `out`, so re-run to read stdout.
    const raw = spawnSync("node", [CLI, "skill", "./plugin", "do the thing", "--dry-run", ...extra], { encoding: "utf8", cwd: d });
    try {
      plan = JSON.parse(raw.stdout);
    } catch {
      /* not json */
    }
    return { code: r.code, out: r.out, plan, stderr: raw.stderr };
  }

  // [flag, spacedArgs, equalsArgs] — each pair must parse to the same plan and never be "unknown flag".
  const cases: Array<[string, string[], string[]]> = [
    ["--fidelity", ["--fidelity", "protocol"], ["--fidelity=protocol"]],
    ["--model", ["--model", "claude-x"], ["--model=claude-x"]],
    ["--plugin", ["--plugin", "./p2"], ["--plugin=./p2"]],
    ["--marketplace+--enable", ["--marketplace", "./mkt", "--enable", "a@mkt"], ["--marketplace=./mkt", "--enable=a@mkt"]],
    ["--upload", ["--upload", "./f.csv"], ["--upload=./f.csv"]],
    ["--folder", ["--folder", "./repo"], ["--folder=./repo"]],
    ["--answer", ["--answer", "stage=Series A"], ["--answer=stage=Series A"]],
    ["--on-unanswered (common)", ["--on-unanswered", "first"], ["--on-unanswered=first"]],
    ["--output-format (common)", ["--output-format", "json"], ["--output-format=json"]],
  ];

  for (const [label, spaced, equals] of cases) {
    it(`${label}: =value form is accepted and matches the spaced form`, () => {
      const d = mkdtempSync(join(tmpdir(), "g5-"));
      const a = dryRun(spaced, d);
      const b = dryRun(equals, d);
      // neither form is rejected as an unknown flag
      expect(a.stderr).not.toMatch(/unknown flag/);
      expect(b.stderr).not.toMatch(/unknown flag/);
      expect(b.code).toBe(a.code);
      // the dry-run plan (the parsed view of the flags) is identical between the two forms
      if (a.plan && b.plan) expect(b.plan).toEqual(a.plan);
    });
  }

  it("--fidelity=container (equals form) is honored, not rejected", () => {
    const d = mkdtempSync(join(tmpdir(), "g5-"));
    const raw = spawnSync("node", [CLI, "skill", "./plugin", "hi", "--dry-run", "--fidelity=container"], { encoding: "utf8", cwd: d });
    expect(raw.status).toBe(0);
    expect(JSON.parse(raw.stdout).fidelity).toBe("container");
  });

  it("a boolean flag given an equals value (e.g. --dry-run=1) is a usage error, exit 2", () => {
    const d = mkdtempSync(join(tmpdir(), "g5-"));
    const r = run(["skill", "./plugin", "hi", "--dry-run=1"], d);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/takes no value/);
  });

  it("an empty equals value (--model=) is rejected, exit 2", () => {
    const d = mkdtempSync(join(tmpdir(), "g5-"));
    const r = run(["skill", "./plugin", "hi", "--model=", "--dry-run"], d);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/requires a non-empty value/);
  });

  // --decider-model only feeds the LLM decider; reject it without --decider-llm (mirrors --intent).
  it("decide: --decider-model without --decider-llm → exit 2", () => {
    const d = mkdtempSync(join(tmpdir(), "g6-"));
    const r = run(["decide", "--decider-model", "m", "--question", "Q?", "--option", "A"], d);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/--decider-model requires --decider-llm/);
  });

  it("record: --decider-model without --decider-llm → exit 2", () => {
    const d = mkdtempSync(join(tmpdir(), "g6-"));
    writeFileSync(join(d, "s.yaml"), "prompt: hi\n");
    const r = run(["record", "s.yaml", "--decider-model", "m"], d);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/--decider-model requires --decider-llm/);
  });

  it("skill: --decider-model without --decider-llm → exit 2", () => {
    const d = mkdtempSync(join(tmpdir(), "g6-"));
    const r = run(["skill", "./plugin", "hi", "--decider-model", "m", "--dry-run"], d);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/--decider-model requires --decider-llm/);
  });

  // run: --decider-model is a recognized flag (overrides the model for on_unanswered: llm scenarios) — it
  // must NOT be rejected as an "unexpected argument", and a missing value fails loud.
  it("run: --decider-model with a missing value → exit 2 (requires a value)", () => {
    const d = mkdtempSync(join(tmpdir(), "g6-"));
    writeFileSync(join(d, "s.yaml"), "prompt: hi\n");
    const r = run(["run", "s.yaml", "--decider-model"], d);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/--decider-model requires a value/);
  });

  it("run: --decider-model <id> is accepted (not an 'unexpected argument')", () => {
    const d = mkdtempSync(join(tmpdir(), "g6-"));
    // a non-existent scenario path: parsing must reach the path check, proving the flag was consumed and did
    // NOT trip the leftover-positional guard ("unexpected argument(s)").
    const r = run(["run", "missing.yaml", "--decider-model", "claude-x"], d);
    expect(r.out).not.toMatch(/unexpected argument/);
    expect(r.out).toMatch(/scenario path not found/);
  });
});

// A GLOBAL flag (--dotenv / --run-dir) only works in LEADING position (before the subcommand). Used
// AFTER the subcommand it's rejected as an unknown flag — but the bare "unknown flag" message sent
// users hunting for a per-command flag that doesn't exist (the --dotenv-after-doctor footgun behind
// campaign-2 H-2/H-4). The rejection now carries a position hint pointing at the leading form.
describe.skipIf(!can)("global-flag position hint", () => {
  // The check is centralized pre-dispatch, so these commands all hit the SAME code path — the value is
  // that each previously surfaced a DIFFERENT confusing error for a trailing global flag (doctor →
  // "unknown flag", run → "unexpected argument(s)", assertions → a positional-count error); the hint now
  // pre-empts all of them uniformly. That divergence is exactly what makes the cross-command coverage worth
  // asserting.
  for (const [label, args] of [
    ["doctor", ["doctor", "--tier", "protocol", "--dotenv", "/tmp/x.env"]],
    ["run", ["run", "x.yaml", "--dotenv", "/tmp/x.env"]],
    ["assertions (--run-dir)", ["assertions", "--list", "--run-dir", "/tmp/r"]],
    ["decide", ["decide", "--decider-llm", "--dotenv", "/tmp/x.env"]],
  ] as const) {
    it(`${label}: a misplaced --dotenv/--run-dir → exit 2 with the leading-position hint`, () => {
      const d = mkdtempSync(join(tmpdir(), "gf-"));
      const r = run([...args], d);
      expect(r.code).toBe(2);
      expect(r.out).toMatch(/GLOBAL flag and must come BEFORE the subcommand/);
      // the hint names the actual subcommand, not the flag
      expect(r.out).toMatch(new RegExp(`cowork-harness --(dotenv|run-dir) <path> ${args[0]}`));
    });
  }

  it("a genuinely unknown flag still gets the bare message (no false hint)", () => {
    const d = mkdtempSync(join(tmpdir(), "gf-"));
    const r = run(["doctor", "--tier", "protocol", "--bogus"], d);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/unknown flag: --bogus/);
    expect(r.out).not.toMatch(/GLOBAL flag/);
  });

  it("the correct leading form is accepted (doctor honors a global --dotenv before the subcommand)", () => {
    const d = mkdtempSync(join(tmpdir(), "gf-"));
    writeFileSync(join(d, "tok.env"), "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-test\n");
    // Leading --dotenv must NOT be rejected; doctor runs and reports (exit 0/1, never the usage-2 path).
    const r = run(["--dotenv", join(d, "tok.env"), "doctor", "--tier", "protocol"], d);
    expect(r.code).not.toBe(2);
    expect(r.out).not.toMatch(/unknown flag/);
    expect(r.out).not.toMatch(/GLOBAL flag/);
  });

  // Regression: the check must run AFTER the --help/--version short-circuits, so an explicit help/version
  // request still wins even with a stray global flag present (it must never become a usage error, and the
  // hint must never reference `--help`/`--version` as if they were the subcommand).
  it("--version / --help are NOT pre-empted by a stray global flag", () => {
    const d = mkdtempSync(join(tmpdir(), "gf-"));
    // --version wins: exit 0 and the actual version string, not the hint.
    const v = run(["--version", "--run-dir", "x"], d);
    expect(v.code).toBe(0);
    expect(v.out).toMatch(/\d+\.\d+\.\d+/);
    expect(v.out).not.toMatch(/GLOBAL flag/);
    // per-subcommand --help wins even when --dotenv precedes it in the args: exit 0 + usage, not the hint.
    const h = run(["doctor", "--dotenv", "x", "--help"], d);
    expect(h.code).toBe(0);
    expect(h.out).toMatch(/usage: doctor/);
    expect(h.out).not.toMatch(/GLOBAL flag/);
  });

  it("a junk subcommand + trailing global → the accurate 'unknown command', not a nonsense hint", () => {
    const d = mkdtempSync(join(tmpdir(), "gf-"));
    const r = run(["frobnicate", "--dotenv", "x"], d);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/unknown command: frobnicate/);
    // must NOT suggest `cowork-harness --dotenv <path> frobnicate` as if frobnicate were valid
    expect(r.out).not.toMatch(/GLOBAL flag/);
  });

  // Regression: the hint routes through fail(), so under --output-format json it emits the structured
  // error envelope like every other usage error — not bare text a JSON consumer can't parse.
  it("emits the json error envelope under --output-format json", () => {
    const d = mkdtempSync(join(tmpdir(), "gf-"));
    const r = run(["doctor", "--output-format", "json", "--dotenv", "/tmp/x.env"], d);
    expect(r.code).toBe(2);
    const line = r.out.split("\n").find((l) => l.trim().startsWith("{"));
    expect(line, "expected a JSON envelope line").toBeTruthy();
    const env = JSON.parse(line!);
    expect(env.ok).toBe(false);
    expect(env.error.category).toBe("usage");
    expect(env.error.message).toMatch(/GLOBAL flag and must come BEFORE the subcommand/);
  });
});

describe.skipIf(!can)("CLI arg guards — run --repeat (E1)", () => {
  it("rejects --repeat below the minimum (1)", () => {
    const d = mkdtempSync(join(tmpdir(), "g-repeat-"));
    writeFileSync(join(d, "s.yaml"), "prompt: hi\n");
    const r = run(["run", "s.yaml", "--repeat", "1"], d);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/--repeat requires an integer between 2 and 100/);
  });

  it("rejects --repeat above the maximum (101)", () => {
    const d = mkdtempSync(join(tmpdir(), "g-repeat-"));
    writeFileSync(join(d, "s.yaml"), "prompt: hi\n");
    expect(run(["run", "s.yaml", "--repeat", "101"], d).code).toBe(2);
  });

  it("rejects a non-numeric --repeat value", () => {
    const d = mkdtempSync(join(tmpdir(), "g-repeat-"));
    writeFileSync(join(d, "s.yaml"), "prompt: hi\n");
    const r = run(["run", "s.yaml", "--repeat", "nope"], d);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/--repeat requires an integer/);
  });

  it("accepts the --repeat=N equals form (parses cleanly, fails fast on the nonexistent path instead — never on --repeat)", () => {
    // A nonexistent scenario path fails BEFORE any live execution (no auth/spawn needed), so this stays
    // token-free and fast while still proving --repeat=3 parsed: the error is about the path, not --repeat.
    const d = mkdtempSync(join(tmpdir(), "g-repeat-"));
    const r = run(["run", "does-not-exist.yaml", "--repeat=3"], d);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/scenario path not found/);
    expect(r.out).not.toMatch(/--repeat requires/);
  });

  it("rejects --repeat combined with --decider-dir (interactive driver × N is not a measurement)", () => {
    const d = mkdtempSync(join(tmpdir(), "g-repeat-"));
    writeFileSync(join(d, "s.yaml"), "prompt: hi\n");
    const r = run(["run", "s.yaml", "--repeat", "3", "--decider-dir", d], d);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/--repeat cannot be combined with --decider-dir/);
  });

  // Regression: this guard used to check ONLY --decider-dir, even though --decider-cmd is grouped with it
  // as a "LIVE" decider everywhere else in this CLI's own help text (RUN_HELP: "to answer LIVE questions,
  // use --decider-llm / --decider-cmd / --decider-dir") — an asymmetric gap, found and closed while
  // composing --matrix + --repeat.
  it("rejects --repeat combined with --decider-cmd too (same live-decider reasoning, previously ungated)", () => {
    const d = mkdtempSync(join(tmpdir(), "g-repeat-"));
    writeFileSync(join(d, "s.yaml"), "prompt: hi\n");
    const r = run(["run", "s.yaml", "--repeat", "3", "--decider-cmd", "cat"], d);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/--repeat cannot be combined with --decider-dir\/--decider-cmd/);
  });

  it("--max-budget-usd without --repeat is a usage error, not a silent no-op", () => {
    const d = mkdtempSync(join(tmpdir(), "g-repeat-"));
    writeFileSync(join(d, "s.yaml"), "prompt: hi\n");
    const r = run(["run", "s.yaml", "--max-budget-usd", "1.0"], d);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/--max-budget-usd requires --repeat/);
  });

  it("--stop-on-diverge without --repeat is a usage error", () => {
    const d = mkdtempSync(join(tmpdir(), "g-repeat-"));
    writeFileSync(join(d, "s.yaml"), "prompt: hi\n");
    expect(run(["run", "s.yaml", "--stop-on-diverge"], d).code).toBe(2);
  });

  it("--min-pass-rate without --repeat is a usage error", () => {
    const d = mkdtempSync(join(tmpdir(), "g-repeat-"));
    writeFileSync(join(d, "s.yaml"), "prompt: hi\n");
    expect(run(["run", "s.yaml", "--min-pass-rate", "0.8"], d).code).toBe(2);
  });

  it("rejects --min-pass-rate outside [0,1]", () => {
    const d = mkdtempSync(join(tmpdir(), "g-repeat-"));
    writeFileSync(join(d, "s.yaml"), "prompt: hi\n");
    expect(run(["run", "s.yaml", "--repeat", "2", "--min-pass-rate", "1.5"], d).code).toBe(2);
  });

  it("rejects a non-positive --max-budget-usd", () => {
    const d = mkdtempSync(join(tmpdir(), "g-repeat-"));
    writeFileSync(join(d, "s.yaml"), "prompt: hi\n");
    expect(run(["run", "s.yaml", "--repeat", "2", "--max-budget-usd", "0"], d).code).toBe(2);
  });
});

describe.skipIf(!can)("CLI arg guards — run --matrix (E3)", () => {
  it("--matrix composes with --repeat (each cell is its own repeat batch) — no usage rejection", () => {
    const d = mkdtempSync(join(tmpdir(), "g-matrix-"));
    writeFileSync(join(d, "s.yaml"), "prompt: hi\n");
    writeFileSync(join(d, "m.yaml"), "baselines: [a, b]\n");
    const r = run(["run", "s.yaml", "--matrix", "m.yaml", "--repeat", "2"], d);
    // The combination passes ARG validation (the former v1 rejection is gone). The fake baselines then
    // fail cell RESOLUTION — a run failure (1), observably distinct from a usage error (2).
    expect(r.code).toBe(1);
    expect(r.out).not.toMatch(/--matrix cannot be combined with --repeat/);
  });

  it("--max-cells without --matrix is a usage error", () => {
    const d = mkdtempSync(join(tmpdir(), "g-matrix-"));
    writeFileSync(join(d, "s.yaml"), "prompt: hi\n");
    expect(run(["run", "s.yaml", "--max-cells", "4"], d).code).toBe(2);
  });

  it("--concurrency without --matrix is a usage error", () => {
    const d = mkdtempSync(join(tmpdir(), "g-matrix-"));
    writeFileSync(join(d, "s.yaml"), "prompt: hi\n");
    expect(run(["run", "s.yaml", "--concurrency", "2"], d).code).toBe(2);
  });

  it("rejects --concurrency outside 1..8", () => {
    const d = mkdtempSync(join(tmpdir(), "g-matrix-"));
    writeFileSync(join(d, "s.yaml"), "prompt: hi\n");
    writeFileSync(join(d, "m.yaml"), "baselines: [a]\n");
    expect(run(["run", "s.yaml", "--matrix", "m.yaml", "--concurrency", "9"], d).code).toBe(2);
  });

  it("rejects a non-positive --max-cells", () => {
    const d = mkdtempSync(join(tmpdir(), "g-matrix-"));
    writeFileSync(join(d, "s.yaml"), "prompt: hi\n");
    writeFileSync(join(d, "m.yaml"), "baselines: [a]\n");
    expect(run(["run", "s.yaml", "--matrix", "m.yaml", "--max-cells", "0"], d).code).toBe(2);
  });

  it("rejects a nonexistent --matrix file", () => {
    const d = mkdtempSync(join(tmpdir(), "g-matrix-"));
    writeFileSync(join(d, "s.yaml"), "prompt: hi\n");
    const r = run(["run", "s.yaml", "--matrix", "does-not-exist.yaml"], d);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/matrix file not found/);
  });

  it("rejects a matrix file with an unknown top-level key (schema validation, not silently ignored)", () => {
    const d = mkdtempSync(join(tmpdir(), "g-matrix-"));
    writeFileSync(join(d, "s.yaml"), "prompt: hi\n");
    writeFileSync(join(d, "m.yaml"), "baseline: [a]\n"); // typo: singular
    const r = run(["run", "s.yaml", "--matrix", "m.yaml"], d);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/invalid matrix file/);
  });

  it("rejects --matrix against a directory target (requires exactly one scenario file)", () => {
    const d = mkdtempSync(join(tmpdir(), "g-matrix-"));
    writeFileSync(join(d, "a.yaml"), "prompt: hi\n");
    writeFileSync(join(d, "b.yaml"), "prompt: hi\n");
    writeFileSync(join(d, "m.yaml"), "baselines: [a]\n");
    const r = run(["run", ".", "--matrix", "m.yaml"], d);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/--matrix requires exactly one scenario file/);
  });

  it("accepts the --matrix=<file> equals form (parses cleanly, fails fast on session loading instead — never on --matrix parsing)", () => {
    const d = mkdtempSync(join(tmpdir(), "g-matrix-"));
    writeFileSync(join(d, "s.yaml"), "prompt: hi\nsession: does-not-exist.yaml\n");
    writeFileSync(join(d, "m.yaml"), "baselines: [a]\n");
    const r = run(["run", "s.yaml", "--matrix=m.yaml"], d);
    expect(r.out).not.toMatch(/--matrix requires/);
  });

  it("a bad session ref reads as a clean usage error, not a raw ENOENT stack trace", () => {
    const d = mkdtempSync(join(tmpdir(), "g-matrix-"));
    writeFileSync(join(d, "s.yaml"), "prompt: hi\nsession: does-not-exist.yaml\n");
    writeFileSync(join(d, "m.yaml"), "baselines: [a]\n");
    const r = run(["run", "s.yaml", "--matrix", "m.yaml"], d);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/failed to load session/);
    expect(r.out).not.toMatch(/at readFileSync|at parseSessionFile|at cmdRun/); // no raw stack trace
  });

  // The ONE external decider channel is shared across every
  // matrix cell (created once, reused by the whole pMapBounded loop) — every channel implementation
  // (src/decide/external-channel.ts) is documented as "strictly serial" over shared mutable state (a
  // `seq` counter / a single read queue), never designed for concurrent callers. Concurrent cells sharing
  // it would race and silently cross-deliver gate answers between cells. --concurrency 1 (default) is
  // genuinely serial and safe; only the combination with an external channel at concurrency > 1 is unsafe.
  it("rejects --matrix --concurrency > 1 combined with --decider-dir (shared channel, not concurrency-safe)", () => {
    const d = mkdtempSync(join(tmpdir(), "g-matrix-"));
    writeFileSync(join(d, "s.yaml"), "prompt: hi\n");
    writeFileSync(join(d, "m.yaml"), "baselines: [a, b]\n");
    const r = run(["run", "s.yaml", "--matrix", "m.yaml", "--concurrency", "2", "--decider-dir", d], d);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/--matrix --concurrency > 1 cannot be combined with --decider-dir/);
  });

  it("rejects --matrix --concurrency > 1 combined with --decider-cmd too (same shared-channel risk)", () => {
    const d = mkdtempSync(join(tmpdir(), "g-matrix-"));
    writeFileSync(join(d, "s.yaml"), "prompt: hi\n");
    writeFileSync(join(d, "m.yaml"), "baselines: [a, b]\n");
    const r = run(["run", "s.yaml", "--matrix", "m.yaml", "--concurrency", "2", "--decider-cmd", "cat"], d);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/--matrix --concurrency > 1 cannot be combined with/);
  });

  it("allows --matrix --concurrency 1 (the default) combined with --decider-dir — genuinely serial, no race", () => {
    const d = mkdtempSync(join(tmpdir(), "g-matrix-"));
    writeFileSync(join(d, "s.yaml"), "prompt: hi\nsession: does-not-exist.yaml\n"); // fails fast, past the guard
    writeFileSync(join(d, "m.yaml"), "baselines: [a]\n");
    const r = run(["run", "s.yaml", "--matrix", "m.yaml", "--decider-dir", d], d);
    expect(r.out).not.toMatch(/cannot be combined with --decider-dir/);
  });
});
