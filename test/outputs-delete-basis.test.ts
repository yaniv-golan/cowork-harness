import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outputsDeleteBasis, outputsFsDiff, scanEvents, isOutputsDelete } from "../src/run/execute.js";

/**
 * The two inputs the outputs-delete tiering reads, tested as pure functions.
 *
 * `outputsDeleteBasis` says WHY the text scan flagged a command: `named` when a flagged delete statement
 * itself names an outputs path (or moves something out of outputs), `inferred` when the flag rests on the
 * detector's inference — an unprovable target, or a relative `cd` into outputs. A "statement" is one
 * fragment of the command split on newline, `;`, `&&` and `||` — quote-blind, after comments are stripped
 * and simple same-command `VAR=value` assignments expanded one level. That definition is what makes every
 * multi-line `python3 -c` body, loop, `cd`-then-relative delete and chained variable land `inferred`.
 */

const named = [
  `rm -f "/sessions/s/mnt/outputs/artifacts/deck.pdf"`,
  // the relative-cd branch fires first here, but the rm statement itself names outputs
  `rm -rf mnt/outputs/pkg && cp -r pkg mnt/outputs/ && cd mnt/outputs/pkg && ls`,
  `find mnt/outputs -name '*.tmp' -delete`,
  `mv mnt/outputs/a.md /tmp/`,
  `REVIEW_DIR="/sessions/s/mnt/outputs/r"\nrm -f "$REVIEW_DIR/deck.pdf"`,
  // kept false positives — a Python identifier or quoted prose in a statement that names outputs
  `python3 -c 'rm = open("/sessions/s/mnt/outputs/r.md").read(); print(rm[:50])'`,
  `echo 'rm outputs/ghost' >> /sessions/s/mnt/outputs/log.md`,
  // kept false positives the docs name: a trailing comment (only whole-line comments are stripped) and a
  // sed/grep pattern containing a delete word, each in a statement that names outputs
  `rm -rf build # clean before writing to /sessions/s/mnt/outputs`,
  `sed -i '/rm/d' /sessions/s/mnt/outputs/x.md`,
];
const inferred = [
  // the reported false positive
  `python3 -c 'import json\ndata = json.load(open("/sessions/s/mnt/outputs/a/doc.json"))\nrm = data.get("body","")\nprint(rm.find("x"))'`,
  `cd /tmp && rm -rf scratch && unzip -o -q /sessions/s/mnt/outputs/x.skill -d scratch`,
  `cp -r d /sessions/s/mnt/outputs/ && rm -rf /sessions/s/d`,
  // real deletes the classifier cannot name — documented false-negative classes
  `for f in /sessions/s/mnt/outputs/*.tmp; do rm -f "$f"; done`,
  `cd mnt/outputs && rm -rf scratch`,
  `A=/sessions/s/mnt/outputs; B=$A/sub; rm -rf "$B"`,
];

describe("outputsDeleteBasis", () => {
  it.each(named)("named: %s", (cmd) => {
    expect(isOutputsDelete(cmd)).toBe(true);
    expect(outputsDeleteBasis(cmd)).toBe("named");
  });
  it.each(inferred)("inferred: %s", (cmd) => {
    expect(isOutputsDelete(cmd)).toBe(true);
    expect(outputsDeleteBasis(cmd)).toBe("inferred");
  });
});

describe("scanEvents carries a POSITIONAL basis alongside outputsDeletes", () => {
  it("one basis per entry, in order — duplicates included", () => {
    const dir = mkdtempSync(join(tmpdir(), "cwh-basis-"));
    const f = join(dir, "events.jsonl");
    const use = (command: string) =>
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] } });
    writeFileSync(f, [use(inferred[1]), use(named[0]), use(inferred[1])].join("\n"));
    const s = scanEvents(f);
    expect(s.outputsDeletes.length).toBe(3);
    expect(s.outputsDeleteBasis).toEqual(["inferred", "named", "inferred"]);
  });
});

describe("outputsFsDiff", () => {
  const baseline = (paths: string[], complete = true) => ({ complete, paths, hashes: Object.fromEntries(paths.map((p) => [p, `h:${p}`])) });
  const walk = (paths: string[], complete = true, containmentSkips: string[] = []) => ({
    entries: paths.map((path) => ({ path })),
    complete,
    errors: [],
    containmentSkips,
  });
  const noHash = () => null;

  it("clean when nothing pre-existing vanished", () => {
    expect(outputsFsDiff(baseline(["outputs", "outputs/a.md"]), walk(["outputs", "outputs/a.md", "outputs/new.md"]), noHash)).toEqual({
      status: "clean",
      findings: [],
    });
  });

  it("findings when a pre-existing output vanished and was not renamed", () => {
    const d = outputsFsDiff(baseline(["outputs", "outputs/a.md"]), walk(["outputs"]), noHash);
    expect(d.status).toBe("findings");
    expect(d.findings).toEqual(["[fs-diff] output file removed post-run: outputs/a.md"]);
  });

  it("an incomplete post walk is `unavailable` with NO findings — never 'everything vanished'", () => {
    const d = outputsFsDiff(baseline(["outputs", "outputs/a.md", "outputs/b.md"]), walk([], false), noHash);
    expect(d).toEqual({ status: "unavailable", reason: "post-walk-incomplete", findings: [] });
  });

  it("a subtree skipped for containment is unobserved, not proven empty", () => {
    expect(outputsFsDiff(baseline(["outputs", "outputs/a.md"]), walk(["outputs"], true, ["outputs"]), noHash).status).toBe("unavailable");
  });

  it("no baseline, or an incomplete one, is `unavailable` (baseline-incomplete)", () => {
    expect(outputsFsDiff(undefined, walk(["outputs"]), noHash)).toEqual({
      status: "unavailable",
      reason: "baseline-incomplete",
      findings: [],
    });
    expect(outputsFsDiff(baseline(["outputs"], false), walk(["outputs"]), noHash).reason).toBe("baseline-incomplete");
  });
});

describe("the live assembler actually WIRES the tiering inputs (position checks)", () => {
  // Driving executeScenario needs a real spawn, so these pin the call sites textually — anchored to
  // statements at the start of a line, so a commented-out line does not satisfy them. Testing the pure
  // functions above says nothing about whether anything calls them.
  const EXEC = readFileSync(join(process.cwd(), "src/run/execute.ts"), "utf8");
  const MANIFEST = readFileSync(join(process.cwd(), "src/run/pre-run-manifest.ts"), "utf8");

  it("computes the per-turn diff from the turn-start outputs baseline", () => {
    expect(/^\s*const fsDiff = outputsFsDiff\(readOutputsBaseline\(outDir\), /m.test(EXEC)).toBe(true);
  });

  it("persists fsDiff on the live and salvaged RunResult and feeds it, with the positional basis, to the assert ctx", () => {
    expect(
      [...EXEC.matchAll(/^\s*fsDiff,\s*(\/\/.*)?$/gm)].length,
      "fsDiff must reach the assert ctx, the live result and the salvaged partial result",
    ).toBe(3);
    expect(/^\s*outputsDeleteBasis: scan\.outputsDeleteBasis,\s*$/m.test(EXEC)).toBe(true);
  });

  it("takes the outputs baseline BEFORE the manifest's armed/resume early return", () => {
    const call = MANIFEST.search(/^\s*captureOutputsBaseline\(workRoot, outDir\);\s*$/m);
    const gate = MANIFEST.indexOf("if (!plan.capturePreRun || plan.resume) return;");
    expect(call, "captureOutputsBaseline call site is gone").toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(-1);
    expect(call).toBeLessThan(gate);
  });
});
