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

// --run-dir is a GLOBAL, leading-only flag (rejected after the subcommand). skill/run --help must NOT
// present it as an ordinary skill-local flag, or it tells the user to use a flag the command rejects.
describe.skipIf(!can)("cli --help: --run-dir is shown as a global/leading flag", () => {
  for (const cmd of ["skill", "run"]) {
    it(`\`${cmd} --help\` marks --run-dir as a global flag that precedes the subcommand`, () => {
      const { code, text } = help(cmd);
      expect(code).toBe(0);
      // the --run-dir entry itself must teach the leading position
      expect(text).toMatch(/--run-dir <path>\s+GLOBAL/);
      expect(text).toContain("PRECEDE the subcommand");
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
    ["doctor", "usage: doctor"],
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

// Docs guard: a command added to the COMMANDS allowlist but forgotten in README.md's "Commands at
// a glance" table is undiscoverable from the docs a user actually reads first. Source of truth =
// the same COMMANDS array parsed above (re-parsed here so this block stands alone).
describe("cli COMMANDS ↔ README 'Commands at a glance' table", () => {
  const src = readFileSync(resolve("src/cli.ts"), "utf8");
  const arr = src.indexOf("const COMMANDS = [");
  const arrBlock = src.slice(arr, src.indexOf("];", arr));
  const commands = [...arrBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

  const readme = readFileSync(resolve("README.md"), "utf8");
  const tableStart = readme.indexOf("## Commands at a glance");
  const tableEnd = readme.indexOf("\n## ", tableStart + 1);
  const tableBlock = readme.slice(tableStart, tableEnd === -1 ? undefined : tableEnd);

  // Pull the first (command) cell out of every table row, then every backtick-quoted name inside
  // it — some rows pack two commands into one cell (e.g. "`record` / `replay`", "`gates` / `answer`",
  // "`sync` / `list`"), so a row can contribute more than one command name. Cells routinely contain
  // an escaped pipe (e.g. "`verify-cassettes <file\|dir>`") to show an alternation without breaking
  // the table, so the cell boundary must skip `\|` rather than stopping at it.
  const readmeCommands = new Set<string>();
  for (const line of tableBlock.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cell = line.match(/^\|\s*((?:\\.|[^|\\])*?)\s*\|/);
    if (!cell) continue;
    for (const span of cell[1].matchAll(/`([^`]+)`/g)) {
      const name = span[1].match(/^[a-zA-Z][a-zA-Z0-9-]*/);
      if (name) readmeCommands.add(name[0]);
    }
  }

  it("parsed a sane README command set", () => {
    expect(readmeCommands.size).toBeGreaterThan(10);
  });

  it("every COMMANDS entry appears in the README 'Commands at a glance' table", () => {
    const missing = commands.filter((c) => !readmeCommands.has(c));
    expect(missing).toEqual([]);
  });
});
