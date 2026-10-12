// A command metric's declaration: the schema rules, the resolution step (containment, links, tracked, size) and its
// signature (the command tail; an artifact metric's sig byte-identical to before).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScenarioMetric } from "../src/types.js";
import { resolveCommandMetrics, resolvedCommand } from "../src/metric-command/resolve.js";
import { declTuple, metricSig } from "../src/metric-sig.js";

const base = { id: "leaks", better: "lower" as const, unbounded: true as const };

describe("ScenarioMetric: exactly one of artifact or command", () => {
  const ok = (m: object) => ScenarioMetric.safeParse({ ...base, ...m }).success;
  it.each([
    [{ artifact: "outputs/m.json", path: "n" }, true],
    [{ command: ["../metrics/count.py"] }, true],
    [{ command: ["../metrics/count.mjs", "--strict"], deps: ["../metrics/_ev.mjs"], timeout_ms: 60000 }, true],
    [{}, false],
    [{ artifact: "outputs/m.json", path: "n", command: ["x.py"] }, false],
    [{ artifact: "outputs/m.json" }, false],
    [{ command: ["x.py"], path: "n" }, false],
    [{ command: ["x.sh"] }, false],
    [{ command: ["/abs/x.py"] }, false],
    [{ command: ["c:/x.py"] }, false],
    [{ command: ["a\\x.py"] }, false],
    [{ command: [] }, false],
    [{ command: ["x.py"], timeout_ms: 999 }, false],
    [{ command: ["x.py"], timeout_ms: 300001 }, false],
    [{ command: ["x.py"], deps: ["/abs.py"] }, false],
    [{ artifact: "outputs/m.json", path: "n", deps: ["x.py"] }, false],
    [{ artifact: "outputs/m.json", path: "n", timeout_ms: 5000 }, false],
    [{ command: Array.from({ length: 33 }, () => "x.py") }, false],
  ])("%j → %s", (m, want) => {
    expect(ok(m)).toBe(want);
  });
});

describe("the signature", () => {
  it("an artifact metric's sig is exactly the pre-command tuple's (existing flows keep their sigs)", () => {
    const m = ScenarioMetric.parse({ id: "leaks", better: "lower", artifact: "outputs/m.json", path: "totals.n", scale: 10, min: 1 });
    const old = JSON.stringify(["leaks", "outputs/m.json", "totals.n", "lower", 10, null, 1]);
    expect(declTuple(m)).toBe(old);
    expect(metricSig(m)).toBe(createHash("sha256").update(old).digest("hex").slice(0, 16));
  });
  it("an unresolved command metric has no sig: metricSig throws rather than return nothing", () => {
    const m = ScenarioMetric.parse({ ...base, command: ["x.py"] });
    expect(() => metricSig(m)).toThrow(/resolved first/);
  });
});

describe("resolveCommandMetrics", () => {
  let root: string;
  const savedGitset = process.env.COWORK_HARNESS_GITSET;
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "ignore", env: { ...process.env, GIT_DIR: undefined } });
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "cmdres-")));
    mkdirSync(join(root, "repo", "scenarios"), { recursive: true });
    mkdirSync(join(root, "repo", "metrics"), { recursive: true });
    writeFileSync(join(root, "repo", "metrics", "count.py"), "print(1)\n");
    writeFileSync(join(root, "repo", "metrics", "_a.py"), "A = 1\n");
    writeFileSync(join(root, "repo", "metrics", "_b.py"), "B = 1\n");
    writeFileSync(join(root, "repo", "scenarios", "s.yaml"), "x: 1\n");
    execFileSync("git", ["init", "-q"], { cwd: join(root, "repo") });
    execFileSync("git", ["add", "."], { cwd: join(root, "repo") });
    delete process.env.COWORK_HARNESS_GITSET;
  });
  afterEach(() => {
    if (savedGitset === undefined) delete process.env.COWORK_HARNESS_GITSET;
    else process.env.COWORK_HARNESS_GITSET = savedGitset;
    rmSync(root, { recursive: true, force: true });
  });
  void git;
  const scen = () => join(root, "repo", "scenarios", "s.yaml");
  const decl = (m: object) => ScenarioMetric.parse({ ...base, ...m });
  const resolveOne = (m: object, path = scen()) => {
    const d = decl(m);
    resolveCommandMetrics({ metrics: [d] }, path);
    return d;
  };

  it("resolves a tracked script beside the scenarios dir: root-relative paths and a content hash", () => {
    const d = resolveOne({ command: ["../metrics/count.py", "--strict"], deps: ["../metrics/_a.py"] });
    const r = resolvedCommand(d)!;
    expect(r.scriptRel).toBe("metrics/count.py");
    expect(r.depsRel).toEqual(["metrics/_a.py"]);
    expect(r.scriptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(metricSig(d)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("the sig moves with the args, a dep's path, the dep order, the timeout and the bytes — and not with the scenario's own location", () => {
    const sig = (m: object, path?: string) => metricSig(resolveOne(m, path));
    const s0 = sig({ command: ["../metrics/count.py", "--strict"], deps: ["../metrics/_a.py", "../metrics/_b.py"] });
    expect(sig({ command: ["../metrics/count.py", "--lenient"], deps: ["../metrics/_a.py", "../metrics/_b.py"] })).not.toBe(s0);
    expect(sig({ command: ["../metrics/count.py", "--strict"], deps: ["../metrics/_b.py", "../metrics/_a.py"] })).not.toBe(s0);
    expect(sig({ command: ["../metrics/count.py", "--strict"], deps: ["../metrics/_a.py"] })).not.toBe(s0);
    expect(
      sig({ command: ["../metrics/count.py", "--strict"], deps: ["../metrics/_a.py", "../metrics/_b.py"], timeout_ms: 5000 }),
    ).not.toBe(s0);
    // The same script named from another directory has the same sig.
    mkdirSync(join(root, "repo", "scenarios", "deep"));
    writeFileSync(join(root, "repo", "scenarios", "deep", "t.yaml"), "x: 1\n");
    expect(
      sig(
        { command: ["../../metrics/count.py", "--strict"], deps: ["../../metrics/_a.py", "../../metrics/_b.py"] },
        join(root, "repo", "scenarios", "deep", "t.yaml"),
      ),
    ).toBe(s0);
    writeFileSync(join(root, "repo", "metrics", "count.py"), "print(2)\n");
    expect(sig({ command: ["../metrics/count.py", "--strict"], deps: ["../metrics/_a.py", "../metrics/_b.py"] })).not.toBe(s0);
  });

  it("refuses an untracked script in git mode, and accepts it with COWORK_HARNESS_GITSET=0", () => {
    writeFileSync(join(root, "repo", "metrics", "new.py"), "print(1)\n");
    expect(() => resolveOne({ command: ["../metrics/new.py"] })).toThrow(/not tracked by git/);
    process.env.COWORK_HARNESS_GITSET = "0";
    expect(() => resolveOne({ command: ["../metrics/new.py"] })).not.toThrow();
  });

  it("refuses a script outside the repo (a `..` escape)", () => {
    writeFileSync(join(root, "outside.py"), "print(1)\n");
    expect(() => resolveOne({ command: ["../../outside.py"] })).toThrow(/outside the scenario's repository/);
  });

  it("refuses a symlinked script and a symlinked directory below the repo root", () => {
    symlinkSync(join(root, "repo", "metrics", "count.py"), join(root, "repo", "metrics", "link.py"));
    expect(() => resolveOne({ command: ["../metrics/link.py"] })).toThrow(/symlink inside/);
    symlinkSync(join(root, "repo", "metrics"), join(root, "repo", "mlink"));
    expect(() => resolveOne({ command: ["../mlink/count.py"] })).toThrow(/symlink inside/);
  });

  it("accepts a symlinked ancestor ABOVE the repo root", () => {
    symlinkSync(join(root, "repo"), join(root, "repo-compat"));
    const d = resolveOne({ command: ["../metrics/count.py"] }, join(root, "repo-compat", "scenarios", "s.yaml"));
    expect(resolvedCommand(d)!.scriptRel).toBe("metrics/count.py");
  });

  it("refuses a hard-linked script", () => {
    linkSync(join(root, "repo", "metrics", "count.py"), join(root, "hard.py"));
    expect(() => resolveOne({ command: ["../metrics/count.py"] })).toThrow(/hard-linked/);
  });

  it("refuses a missing script and one over 1 MiB", () => {
    expect(() => resolveOne({ command: ["../metrics/none.py"] })).toThrow(/no such file/);
    writeFileSync(join(root, "repo", "metrics", "big.py"), "#".repeat(1024 * 1024 + 1));
    execFileSync("git", ["add", "."], { cwd: join(root, "repo") });
    expect(() => resolveOne({ command: ["../metrics/big.py"] })).toThrow(/larger than/);
  });

  it("outside a work tree the repo is the scenario's own directory, so `../metrics` is refused", () => {
    rmSync(join(root, "repo", ".git"), { recursive: true, force: true });
    expect(() => resolveOne({ command: ["../metrics/count.py"] })).toThrow(/outside the scenario's directory/);
  });
});

describe("commandMetricFiles (the answer-key guard's and the hillclimb gate's view of a command metric)", () => {
  it("lists a resolved command metric's script and deps by absolute path, and nothing for an unresolved one", async () => {
    const { commandMetricFiles } = await import("../src/metric-command/resolve.js");
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cmdfiles-")));
    try {
      mkdirSync(join(root, "scenarios"), { recursive: true });
      mkdirSync(join(root, "metrics"), { recursive: true });
      writeFileSync(join(root, "scenarios", "s.yaml"), "x: 1\n");
      writeFileSync(join(root, "metrics", "c.mjs"), "console.log(1)");
      writeFileSync(join(root, "metrics", "d.mjs"), "export const D = 1");
      execFileSync("git", ["init", "-q"], { cwd: root });
      execFileSync("git", ["add", "-A"], { cwd: root });
      const d = ScenarioMetric.parse({ ...base, command: ["../metrics/c.mjs"], deps: ["../metrics/d.mjs"] });
      expect(commandMetricFiles([d])).toEqual([]);
      resolveCommandMetrics({ metrics: [d] }, join(root, "scenarios", "s.yaml"));
      expect(commandMetricFiles([d])).toEqual([join(root, "metrics", "c.mjs"), join(root, "metrics", "d.mjs")]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
