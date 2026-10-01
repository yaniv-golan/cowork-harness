import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// Pins the `run`/`skill` --help text so the `on_unanswered` value can't silently regress to the
// wrong word again (audit 1.6/3.7: `run --help` once read `on_unanswered: agent`; the only valid
// value is `llm`). Token-free and spawn-free: --help short-circuits before any agent/model/Docker.
// Help is printed to STDERR (fd 2 — see `log` in src/cli.ts), so we assert against stderr. Needs
// `dist/cli.js` (the `ci` script builds before testing); skips cleanly otherwise.
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

function help(command: string) {
  const cwd = mkdtempSync(join(tmpdir(), "cc-help-")); // isolated cwd so no stray .env is loaded
  const r = spawnSync("node", [CLI, command, "--help"], { encoding: "utf8", cwd });
  // Help goes to stderr; tolerate either stream so the test stays robust if that ever changes.
  return { code: r.status, text: (r.stderr || "") + (r.stdout || "") };
}

describe.skipIf(!can)("cli --help: on_unanswered value can't regress", () => {
  it("`run --help` documents `on_unanswered: llm` and never `on_unanswered: agent`", () => {
    const { code, text } = help("run");
    expect(code).toBe(0);
    expect(text).toContain("on_unanswered: llm");
    expect(text).not.toContain("on_unanswered: agent");
  });

  it("`skill --help` never says `on_unanswered: agent`", () => {
    // skill --help routes live questions through --decider-llm rather than an on_unanswered: <word>
    // string, so we only pin the negative — the typo must not reappear here either.
    const { code, text } = help("skill");
    expect(code).toBe(0);
    expect(text).not.toContain("on_unanswered: agent");
  });
});

// --run-dir / --dotenv are accepted before OR after the subcommand. skill/run --help list both as their own
// flags and must no longer teach the old "must PRECEDE the subcommand" rule, which is now false.
describe.skipIf(!can)("cli --help: --run-dir / --dotenv are listed as per-command flags", () => {
  for (const cmd of ["skill", "run"]) {
    it(`\`${cmd} --help\` lists both, and says either position works`, () => {
      const { code, text } = help(cmd);
      expect(code).toBe(0);
      expect(text).toMatch(/^\s{2}--run-dir <path>/m);
      expect(text).toMatch(/^\s{2}--dotenv <path>/m);
      expect(text).toContain("Before or after the subcommand");
      expect(text).not.toMatch(/PRECEDE the subcommand|GLOBAL flag/);
    });
  }
});

// The parseArgs-direct subcommands used to answer `--help` with `unknown flag: --help` (exit 2).
// They now print a usage line and exit 0.
describe.skipIf(!can)("cli --help: parseArgs-direct subcommands print usage", () => {
  const cases: [string, string][] = [
    ["record", "usage: record"],
    ["replay", "usage: replay"],
    ["verify-cassettes", "usage: verify-cassettes"],
    ["trace", "usage: trace"],
    ["assertions", "usage: assertions"],
    ["scaffold", "usage: scaffold"],
    ["gates", "usage: gates"],
    ["answer", "usage: answer"],
    ["boundary-check", "usage: boundary-check"],
    ["vm", "usage: vm"],
    ["sync", "usage: sync"],
    ["list", "usage: list"],
    ["chat", "usage: chat"],
    ["decide", "usage: decide"],
    ["verify-run", "usage: verify-run"],
    ["regrade", "usage: regrade"],
    ["fixture", "usage: fixture"],
    ["ref", "usage: ref freeze"],
    ["doctor", "usage: doctor"],
    ["status", "usage: status"],
    ["inspect", "usage: inspect"],
    ["diff", "usage: diff"],
    ["stats", "usage: stats"],
    ["analyze-skill", "usage: analyze-skill"],
    ["prune", "usage: prune"],
    ["rehash", "usage: rehash"],
    ["init-redact", "usage: init-redact"],
    ["probe-dispatch", "usage: probe-dispatch"],
    ["eval", "usage: eval"],
    ["hillclimb", "usage: hillclimb"],
  ];
  for (const [cmd, expected] of cases) {
    it(`\`${cmd} --help\` exits 0 with a usage line (not "unknown flag")`, () => {
      const { code, text } = help(cmd);
      expect(code).toBe(0);
      expect(text).toContain(expected);
      expect(text).not.toContain("unknown flag");
    });
  }
});

// Which STREAM carries what is load-bearing for anyone scripting a poll, and it is invisible from the
// output itself: `status <dir>` prints its summary to stderr and leaves stdout EMPTY, so the obvious
// `until ! status "$D" | grep -q running` loop matches nothing, exits 1, and returns instantly against a
// live run — a silent false "done" (measured in the field at 21s against a run with ~1260s left). The
// help is where someone writing that loop looks, so pin the statement there.
describe.skipIf(!can)("cli --help: status names its output streams", () => {
  it("`status --help` says the text form is stderr and json/--follow are stdout", () => {
    const { code, text } = help("status");
    expect(code).toBe(0);
    expect(text).toContain("text summary goes to stderr");
    expect(text).toContain("--output-format json and --follow write to stdout");
  });
});

// `runs-gc.ts` implements `--pinned-older-than` for real, but the flag was invisible in `prune --help`
// — pin it so a future flag lands in help too.
describe.skipIf(!can)("cli --help: prune documents --pinned-older-than", () => {
  it("`prune --help` mentions --pinned-older-than", () => {
    const { code, text } = help("prune");
    expect(code).toBe(0);
    expect(text).toContain("--pinned-older-than");
  });
});

// The TOP-LEVEL `--help` summary for `analyze-skill` once lagged the per-command help: it omitted
// `--runtime` and exit code `3`. Pin the top-level block specifically (NOT `analyze-skill --help`,
// which already documents both — a pin there would pass without guarding the top-level drift).
describe.skipIf(!can)("cli --help: top-level analyze-skill summary documents --runtime and exit 3", () => {
  function topLevelHelp() {
    const cwd = mkdtempSync(join(tmpdir(), "cc-help-"));
    const r = spawnSync("node", [CLI, "--help"], { encoding: "utf8", cwd });
    return { code: r.status, text: (r.stderr || "") + (r.stdout || "") };
  }
  it("`cowork-harness --help` mentions analyze-skill's --runtime flag and exit 3", () => {
    const { text } = topLevelHelp();
    // Slice to the analyze-skill entry only (start at its command line, stop at the next command
    // `assertions --list`). Whole-text `toContain` would false-pass: "exit 3" also appears in the
    // verify-cassettes summary, so an unanchored check couldn't detect a regression in THIS block.
    const start = text.indexOf("analyze-skill <");
    const end = text.indexOf("assertions --list", start);
    expect(start, "top-level help has no analyze-skill entry").toBeGreaterThan(-1);
    expect(end, "could not bound the analyze-skill block").toBeGreaterThan(start);
    const block = text.slice(start, end);
    expect(block).toContain("--runtime");
    expect(block).toContain("exit 3");
  });
});

// `lint`/`lint-skill` are parseArgs-direct commands too, but unlike every case above they're thin
// passthroughs to the bundled `scenario.py` (a Python argparse CLI invoked via subprocess), so their
// `--help` text comes from argparse, not the TS-side "usage: <cmd>" printer. It used to read
// `usage: scenario.py lint …` — a command a `cowork-harness` user cannot run; the wrapper now passes
// COWORK_HARNESS_PROG so argparse names the real command. Invoked DIRECTLY (`python3 scenario.py lint`,
// which SKILL.md and three docs document) the env var is absent and it correctly says `scenario.py` — and they need python3 on PATH (exit 127 without it). That
// makes them a poor fit for the uniform `cases` table above, so they get their own small block that
// skips (with a reason) when python3 isn't available, mirroring this suite's `describe.skipIf(!can)`.
const pythonCheck = spawnSync("python3", ["--version"]);
const hasPython3 = pythonCheck.status === 0;

describe.skipIf(!can || !hasPython3)("cli --help: lint/lint-skill scenario.py passthrough usage", () => {
  it("`lint --help` exits 0 with `usage: cowork-harness lint` (not the internal script name)", () => {
    const { code, text } = help("lint");
    expect(code).toBe(0);
    expect(text).toContain("usage: cowork-harness lint");
    expect(text, "the internal script name must not leak to a CLI user").not.toContain("scenario.py");
  });

  it("`lint-skill --help` exits 0 with `usage: cowork-harness lint-skill` (not the internal script name)", () => {
    const { code, text } = help("lint-skill");
    expect(code).toBe(0);
    expect(text).toContain("usage: cowork-harness lint-skill");
    expect(text, "the internal script name must not leak to a CLI user").not.toContain("scenario.py");
  });
});

// Membership guard (structural): a command added to the dispatch switch but forgotten in the COMMANDS
// allowlist or the top-level HELP ships inconsistent/undiscoverable. cli-structural-guard only checks
// unknown-flag rejection, NOT this three-way consistency — so assert it here. Source of truth = the
// dispatch switch (parsed from src/cli.ts); SUBCOMMAND_USAGE/self-handled --help is covered by the
// per-subcommand cases above.
describe("cli dispatch ↔ COMMANDS ↔ HELP membership", () => {
  const src = readFileSync(resolve("src/cli.ts"), "utf8");
  const sw = src.indexOf("switch (cmd) {");
  const swBlock = src.slice(sw, src.indexOf("default:", sw));
  const dispatched = [...swBlock.matchAll(/case "([^"]+)":/g)].map((m) => m[1]);
  const arr = src.indexOf("const COMMANDS = [");
  const arrBlock = src.slice(arr, src.indexOf("];", arr));
  const allowlist = [...arrBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

  it("parsed a sane dispatch set (incl. doctor)", () => {
    expect(dispatched).toContain("doctor");
    expect(dispatched.length).toBeGreaterThan(10);
  });

  it("every dispatched command is in the COMMANDS allowlist (--dotenv guard)", () => {
    expect(dispatched.filter((c) => !allowlist.includes(c))).toEqual([]);
  });

  it.skipIf(!can)("every dispatched command appears in the top-level --help", () => {
    const r = spawnSync("node", [CLI, "--help"], { encoding: "utf8", cwd: mkdtempSync(join(tmpdir(), "cc-help-")) });
    const text = (r.stderr || "") + (r.stdout || "");
    expect(dispatched.filter((c) => !text.includes(c))).toEqual([]);
  });
});

// Docs guard: a command added to the COMMANDS allowlist but forgotten in docs/cli.md's "Commands at
// a glance" table is undiscoverable from the docs a user actually reads first. Source of truth =
// the same COMMANDS array parsed above (re-parsed here so this block stands alone).
describe("cli COMMANDS ↔ docs/cli.md 'Commands at a glance' table", () => {
  const src = readFileSync(resolve("src/cli.ts"), "utf8");
  const arr = src.indexOf("const COMMANDS = [");
  const arrBlock = src.slice(arr, src.indexOf("];", arr));
  const commands = [...arrBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

  const cliDoc = readFileSync(resolve("docs/cli.md"), "utf8");
  const tableStart = cliDoc.indexOf("## Commands at a glance");
  const tableEnd = cliDoc.indexOf("\n## ", tableStart + 1);
  const tableBlock = cliDoc.slice(tableStart, tableEnd === -1 ? undefined : tableEnd);

  // Pull the first (command) cell out of every table row, then every backtick-quoted name inside
  // it — some rows pack two commands into one cell (e.g. "`record` / `replay`", "`gates` / `answer`",
  // "`sync` / `list`"), so a row can contribute more than one command name. Cells routinely contain
  // an escaped pipe (e.g. "`verify-cassettes <file\|dir>`") to show an alternation without breaking
  // the table, so the cell boundary must skip `\|` rather than stopping at it.
  const docCommands = new Set<string>();
  for (const line of tableBlock.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cell = line.match(/^\|\s*((?:\\.|[^|\\])*?)\s*\|/);
    if (!cell) continue;
    for (const span of cell[1].matchAll(/`([^`]+)`/g)) {
      const name = span[1].match(/^[a-zA-Z][a-zA-Z0-9-]*/);
      if (name) docCommands.add(name[0]);
    }
  }

  it("parsed a sane docs/cli.md command set", () => {
    expect(docCommands.size).toBeGreaterThan(10);
  });

  it("every COMMANDS entry appears in the docs/cli.md 'Commands at a glance' table", () => {
    const missing = commands.filter((c) => !docCommands.has(c));
    expect(missing).toEqual([]);
  });

  // Reverse guard: a command-like token in the table that ISN'T a real COMMANDS entry means the docs
  // drifted (typo'd/removed command) — catch that the same way the forward direction catches an
  // undocumented one. Two rows document a bundled `python3 …/scenario.py <verb> …` invocation
  // (scaffold, resolve-agent-types), not a `cowork-harness` subcommand; their first-cell backtick
  // span's leading token parses as the literal "python3" (never a COMMANDS member). Those spans are
  // skipped explicitly below — by token or by the cell containing `scenario.py` — rather than widening
  // COMMANDS to paper over a bundled-script example, so the exemption stays auditable.
  const docCommandsStrict = new Set<string>();
  for (const line of tableBlock.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cell = line.match(/^\|\s*((?:\\.|[^|\\])*?)\s*\|/);
    if (!cell) continue;
    for (const span of cell[1].matchAll(/`([^`]+)`/g)) {
      if (span[1].includes("scenario.py")) continue; // bundled-script row, not a cowork-harness subcommand
      const name = span[1].match(/^[a-zA-Z][a-zA-Z0-9-]*/);
      if (name && name[0] !== "python3") docCommandsStrict.add(name[0]);
    }
  }

  it("every docs/cli.md table command token is a real COMMANDS entry (bundled-script python3 rows exempt)", () => {
    const stale = [...docCommandsStrict].filter((c) => !commands.includes(c));
    expect(stale, `docs/cli.md table has a command-like token not in COMMANDS: ${stale.join(", ")}`).toEqual([]);
  });
});

// Docs guard: a command added to the COMMANDS allowlist but forgotten in llms.txt's summary line is
// undiscoverable to an agent skimming the LLM-facing index first. Source of truth = the same COMMANDS
// array parsed above (re-parsed here so this block stands alone).
describe("cli COMMANDS ↔ llms.txt command list", () => {
  const src = readFileSync(resolve("src/cli.ts"), "utf8");
  const arr = src.indexOf("const COMMANDS = [");
  const arrBlock = src.slice(arr, src.indexOf("];", arr));
  const commands = [...arrBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

  const llms = readFileSync(resolve("llms.txt"), "utf8");
  const commandsLine = llms.split("\n").find((line) => line.includes("commands are"));

  it('found the llms.txt "commands are" line', () => {
    expect(commandsLine, 'llms.txt has no line containing "commands are" — did the summary line move or get reworded?').toBeTruthy();
  });

  // The line carries two backtick spans (`cowork-harness` and the `·`-separated command list) — pick
  // the one that actually contains the `·` separator rather than assuming positionally which span it is.
  const span = commandsLine?.match(/`([^`]*·[^`]*)`/);
  const llmsCommands = (span?.[1] ?? "")
    .split("·")
    .map((s) => s.trim())
    .filter(Boolean);

  it("parsed a sane llms.txt command set", () => {
    expect(llmsCommands.length).toBeGreaterThan(10);
  });

  it("every COMMANDS entry appears in llms.txt's command list", () => {
    const missing = commands.filter((c) => !llmsCommands.includes(c));
    expect(missing, `llms.txt's "commands are" list is missing: ${missing.join(", ")}`).toEqual([]);
  });

  it("every llms.txt command list entry is a real COMMANDS entry (no stale name)", () => {
    const stale = llmsCommands.filter((c) => !commands.includes(c));
    expect(stale, `llms.txt's "commands are" list has a stale/unknown entry: ${stale.join(", ")}`).toEqual([]);
  });
});

// Message accuracy guard: the CLI sync command's non-macOS error message should describe the harness's
// own limitation, not claim the Cowork Desktop app is macOS-only (it ships a Windows build too).
describe("cli sync command: platform guard message accuracy", () => {
  const src = readFileSync(resolve("src/cli.ts"), "utf8");

  it("cmdSync on a non-macOS platform blames the harness's own sync tooling, not Desktop", () => {
    // This test only asserts the STRING CONTENT, not actual non-macOS execution (CI runs on macOS).
    // Read the source literal directly rather than mocking process.platform.
    // Tolerate Prettier reformatting the fail(...) call across multiple lines (one arg per line)
    // as well as keeping it on a single line — only require "usage", then the message literal.
    const m = src.match(/if \(process\.platform !== "darwin"\) \{\s*return fail\(\s*"sync",\s*"usage",\s*"([^"]+)"/);
    expect(m).not.toBeNull();
    expect(m![1]).not.toMatch(/Cowork Desktop app is macOS-only/);
    expect(m![1]).toMatch(/this harness|sync tooling|not (yet )?support/i);
  });
});

// Docs guard: `trace --help` must list every view the runtime `--view` validator accepts. The two
// sides used to drift (`subagent-research` was added to the runtime VIEWS array but never reached the
// usage string) — this pins them to the same module-scope literal so that can't happen silently again.
describe("trace --help gives every view an explanation line", () => {
  const src = readFileSync(resolve("src/cli.ts"), "utf8");

  const views = (/const TRACE_VIEWS = \[([^\]]+)\] as const;/.exec(src)?.[1] ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);

  // The trace entry is a TEMPLATE literal since the view list is interpolated — parse between
  // backticks, not double quotes. `\s*` (not `\n\s+`) between the key and the opening backtick
  // because the literal is a real multi-line template (actual newlines, not `\n` escapes — see the
  // comment above the `trace:` entry in src/cli.ts for why), so Prettier collapses `trace: \`` onto
  // one line rather than breaking after the colon the way it does for the plain-string entries above.
  // (The bracket list itself is no longer worth asserting: it IS TRACE_VIEWS, so comparing them
  // compares the constant to itself. The per-view explanation rows below it are hand-written, which
  // is why they still need a guard.)
  const usage = /\n  trace:\s*`((?:[^`\\]|\\.)*)`/.exec(src)?.[1] ?? "";

  it("parsed the usage string", () => {
    expect(views.length).toBeGreaterThan(5);
    expect(usage).toContain("--view");
  });

  it("gives every view its own explanation line", () => {
    for (const v of views) expect(usage).toContain(`--view ${v} `);
  });
});

describe("every trace --view list derives from TRACE_VIEWS", () => {
  const src = readFileSync(resolve("src/cli.ts"), "utf8");

  // Any literal, hardcoded pipe-list of views left in the source is a drift site waiting to happen.
  // The three help strings must interpolate TRACE_VIEWS instead. `tools|questions` is the stable
  // prefix every trace list starts with (diff's list starts `tools|transcript`, so it never matches).
  it("leaves no hardcoded --view pipe-list in the source", () => {
    const hardcoded = src.match(/--view tools\|questions[a-z|-]*/g) ?? [];
    expect(hardcoded).toEqual([]);
  });

  // …and the interpolating form is actually present at each of the three sites.
  it("interpolates the catalog at every usage site", () => {
    const interpolated = src.match(/--view \$\{TRACE_VIEWS\.join\("\|"\)\}/g) ?? [];
    expect(interpolated.length).toBe(3);
  });
});

// The help text and the renderer are two descriptions of ONE capability, and nothing but this test
// couples them. `--view questions` gained option rendering while its help line still read "gate
// lifecycle (question → answer → delivered)" — a surface that under-claims is how a reader concludes
// the harness cannot show them something it has been recording all along.
//
// Asserted as an EQUALITY, not two independent truths, so it fails in both directions: rip the
// `offered:` block out of the renderer and the help now over-claims; drop `description` from the help
// and it under-claims. Either way this reds.
describe.skipIf(!can)("cli --help: `trace --view questions` help matches what the renderer prints", () => {
  it("help claims option descriptions exactly when the renderer emits them", async () => {
    const { formatGateTrace } = await import("../src/run/trace-view.js");
    const DESC = "Your deck shows $1.2M booked but $380K recognized.";
    const rendered = formatGateTrace([
      {
        question: "How should we treat the 2024 revenue line?",
        subQuestionCount: 1,
        subQuestions: [{ question: "How should we treat the 2024 revenue line?", options: [{ label: "As booked", description: DESC }] }],
        delivered: "ok",
      },
    ]);
    const rendererEmitsDescriptions = rendered.includes(DESC);

    const { code, text } = help("trace");
    expect(code).toBe(0);
    // the questions row of the usage block, not the whole help (another view could mention "description")
    const row = text.split("\n").find((l) => l.includes("--view questions")) ?? "";
    expect(row, "no `--view questions` row in `trace --help`").not.toBe("");
    const helpClaimsDescriptions = /description/i.test(row);

    expect(helpClaimsDescriptions).toBe(rendererEmitsDescriptions);
    // …and pin the direction, so "both false" is not a passing state
    expect(rendererEmitsDescriptions).toBe(true);
  });
});
