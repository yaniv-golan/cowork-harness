import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "../src/critique/command.js";

// `cowork-harness critique --dotenv <path>` is documented in critique's own `--help` but was UNREACHABLE
// in two independent ways (docs/internal/2026-07-20-critique-skill-flag-parity-plan.md §G4, Diff 4):
//
//   1. The misplaced-global guard (cli.ts ~711) rejected ANY exact `--dotenv` token appearing after a
//      known subcommand — including `critique`, where `--dotenv` is a legitimate per-command flag, not a
//      misplaced global. `critique` is in COMMANDS (cli.ts:543), so it always hit this.
//   2. Even the `--dotenv=x` equals form, which slips past guard #1 (it only matches the EXACT token
//      `--dotenv`), then hit critique's own hand-rolled `parseArgs` (command.ts ~107/111), which compares
//      flags with exact-match only and throws "unknown flag".
//
// A third, related gap: even once reachable, an absent dotenv file surfaced late — wrapped in critique's
// generic instrument-failure diagnostic from the CHILD `skill` invocation — instead of failing fast with
// critique's own clear error the way the global `--dotenv` form does in cli.ts (~627).
//
// These tests exercise all three failure-fast: bad `--dotenv` paths so `parseArgs` throws BEFORE any
// Docker/model work is ever attempted (no live dependencies, no spawning a real skill run).

const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);
const MISSING_DOTENV = "/definitely/does/not/exist/critique-dotenv-reach.env";

function run(args: string[], cwd: string) {
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8", cwd });
  return { code: r.status, out: r.stdout + r.stderr };
}

describe.skipIf(!can)("cli: critique --dotenv is reachable (space form)", () => {
  it("is NOT rejected by the misplaced-global guard, and fails with critique's OWN not-found error", () => {
    const d = mkdtempSync(join(tmpdir(), "crit-dotenv-"));
    const r = run(["critique", "some-skill-dir", "--prompt", "hi", "--dotenv", MISSING_DOTENV], d);
    expect(r.code).toBe(2);
    expect(r.out).not.toMatch(/GLOBAL flag and must come BEFORE the subcommand/);
    expect(r.out).not.toMatch(/unknown flag/);
    expect(r.out).toMatch(/--dotenv file not found/);
    expect(r.out).toContain(MISSING_DOTENV);
  });
});

describe.skipIf(!can)("cli: critique --dotenv is reachable (equals form)", () => {
  it("`--dotenv=<path>` is NOT treated as an unknown flag, and fails with critique's OWN not-found error", () => {
    const d = mkdtempSync(join(tmpdir(), "crit-dotenv-"));
    const r = run(["critique", "some-skill-dir", "--prompt=hi", `--dotenv=${MISSING_DOTENV}`], d);
    expect(r.code).toBe(2);
    expect(r.out).not.toMatch(/GLOBAL flag and must come BEFORE the subcommand/);
    expect(r.out).not.toMatch(/unknown flag/);
    expect(r.out).toMatch(/--dotenv file not found/);
    expect(r.out).toContain(MISSING_DOTENV);
  });
});

describe.skipIf(!can)("cli: the misplaced-global guard stays intact for everything else", () => {
  it("critique --run-dir (trailing) is STILL rejected as a misplaced global", () => {
    const d = mkdtempSync(join(tmpdir(), "crit-dotenv-"));
    const r = run(["critique", "some-skill-dir", "--prompt", "hi", "--run-dir", "/tmp/x"], d);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/GLOBAL flag and must come BEFORE the subcommand/);
    expect(r.out).toMatch(/cowork-harness --run-dir <path> critique/);
  });

  it("a trailing --dotenv on a DIFFERENT command is STILL rejected as a misplaced global", () => {
    const d = mkdtempSync(join(tmpdir(), "crit-dotenv-"));
    const r = run(["doctor", "--tier", "protocol", "--dotenv", MISSING_DOTENV], d);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/GLOBAL flag and must come BEFORE the subcommand/);
  });
});

// Unit-level coverage of critique's own parseArgs (exported by command.ts) for flag spellings that don't
// short-circuit on a missing dotenv file — exercising these via a full CLI spawn would require a real
// skill run (Docker/model), which this fix must not need to prove.
describe("critique parseArgs: equals-form parity for its own flags", () => {
  it("accepts --prompt=, --evaluator-model=, --fidelity=, --output-format= all in equals form", () => {
    const opts = parseArgs(["some-skill-dir", "--prompt=hi", "--evaluator-model=claude-x", "--fidelity=container", "--output-format=json"]);
    expect(opts.prompt).toBe("hi");
    expect(opts.evaluatorModel).toBe("claude-x");
    expect(opts.fidelity).toBe("container");
    expect(opts.outputFormat).toBe("json");
  });

  it("still accepts the original space form for every one of those flags", () => {
    const opts = parseArgs([
      "some-skill-dir",
      "--prompt",
      "hi",
      "--evaluator-model",
      "claude-x",
      "--fidelity",
      "container",
      "--output-format",
      "json",
    ]);
    expect(opts.prompt).toBe("hi");
    expect(opts.evaluatorModel).toBe("claude-x");
    expect(opts.outputFormat).toBe("json");
  });

  it("a genuinely unknown flag (in either spelling) is still rejected", () => {
    expect(() => parseArgs(["some-skill-dir", "--prompt", "hi", "--bogus"])).toThrow(/unknown flag: --bogus/);
    expect(() => parseArgs(["some-skill-dir", "--prompt", "hi", "--bogus=x"])).toThrow(/unknown flag: --bogus=x/);
  });

  it("--dotenv pointing at a missing file throws critique's OWN clear error", () => {
    expect(() => parseArgs(["some-skill-dir", "--prompt", "hi", "--dotenv", MISSING_DOTENV])).toThrow(/--dotenv file not found/);
    expect(() => parseArgs(["some-skill-dir", "--prompt", "hi", `--dotenv=${MISSING_DOTENV}`])).toThrow(/--dotenv file not found/);
  });

  it("omitting --dotenv entirely is unaffected (still optional)", () => {
    const opts = parseArgs(["some-skill-dir", "--prompt", "hi"]);
    expect(opts.dotenv).toBeUndefined();
  });
});
