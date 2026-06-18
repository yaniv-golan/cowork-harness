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

// F-7: the parseArgs-direct subcommands used to answer `--help` with `unknown flag: --help` (exit 2).
// They now print a usage line and exit 0.
describe.skipIf(!can)("cli --help: parseArgs-direct subcommands print usage (F-7)", () => {
  const cases: [string, string][] = [
    ["record", "usage: record"],
    ["replay", "usage: replay"],
    ["verify-cassettes", "usage: verify-cassettes"],
    ["trace", "usage: trace"],
    ["assert", "usage: assert"],
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
