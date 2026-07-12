import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// CLI wiring for `probe-dispatch` — a real hostloop dispatch needs a live model + staged native agent
// binary (not available in CI), so this suite only checks the command is WIRED: --help/COMMANDS
// membership (the generic dispatch↔COMMANDS↔HELP guard in cli-help.test.ts already covers the structural
// half) and that missing/malformed args fail loud at usage time (exit 2) BEFORE any run is attempted —
// none of these cases need Docker, a token, or a staged binary.
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

function run(args: string[]) {
  const cwd = mkdtempSync(join(tmpdir(), "cc-probe-dispatch-"));
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8", cwd });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

describe.skipIf(!can)("probe-dispatch: CLI wiring", () => {
  it("`probe-dispatch --help` exits 0 and documents the {resolvedAgentType, pathDenials, delivered} output", () => {
    const { code, out } = run(["probe-dispatch", "--help"]);
    expect(code).toBe(0);
    expect(out).toContain("resolvedAgentType");
    expect(out).toContain("pathDenials");
    expect(out).toContain("delivered");
    expect(out).toContain("hostloop"); // documents the forced-hostloop default
  });

  it("`--help` (top-level) lists probe-dispatch", () => {
    const { code, out } = run(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("probe-dispatch");
  });

  it("missing args → usage error, exit 2", () => {
    const { code, out } = run(["probe-dispatch"]);
    expect(code).toBe(2);
    expect(out).toContain("usage: cowork-harness probe-dispatch");
  });

  it("missing the prompt positional → usage error, exit 2", () => {
    const { code, out } = run(["probe-dispatch", "./some-skill-dir"]);
    expect(code).toBe(2);
    expect(out).toContain("usage:");
  });

  it("an unknown flag → usage error, exit 2 (no silent-accept parsing)", () => {
    const { code, out } = run(["probe-dispatch", "./x", "hi", "--not-a-real-flag"]);
    expect(code).toBe(2);
    expect(out).toContain("unknown flag: --not-a-real-flag");
  });

  it("--fidelity outside {container,microvm,hostloop} is rejected (protocol/cowork not offered here)", () => {
    const { code, out } = run(["probe-dispatch", "./x", "hi", "--fidelity", "protocol"]);
    expect(code).toBe(2);
    expect(out).toContain("--fidelity must be one of container|microvm|hostloop");
  });
});
