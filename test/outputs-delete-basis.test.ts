import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outputsDeleteBasis, outputsFsDiff, scanEvents, isOutputsDelete } from "../src/run/execute.js";

/**
 * The two inputs the outputs-delete tiering reads, tested as pure functions.
 *
 * `outputsDeleteBasis` says WHY the text scan flagged a command: `named` when a delete is in COMMAND or CALL
 * position and its own operand names an outputs path (or something is moved out of outputs); `inferred`
 * otherwise — an unprovable target, a relative `cd` into outputs, or an outputs path that merely appears in
 * the same statement as a word like `rm` (a Python variable, quoted prose, a sed pattern, a trailing
 * comment). A "statement" is one fragment of the command split on newline, `;`, `&&` and `||` —
 * quote-blind, after whole-line comments are stripped and simple same-command `VAR=value` assignments
 * expanded one level. That definition is what makes a loop body, a `cd`-then-relative delete, a chained
 * variable and a `p = …` then `os.remove(p)` land `inferred`.
 */

const O = "/sessions/s/mnt/outputs";

// Every real single-command delete whose operand is a literal outputs path must stay `named` (fail).
const named = [
  `rm -f "${O}/artifacts/deck.pdf"`,
  `rm -f '${O}/deck.pdf'`,
  `rm -f ${O}/deck.pdf`,
  `rm -f -- "${O}/deck.pdf"`,
  `rm -f "${O}/my deck.pdf"`,
  `rm -f ${O}/*.tmp`,
  `rm -f ${O}/{a,b}.md`,
  `rm -f ${O}/a.md 2>/dev/null || true`,
  `rm -f ${O}/a.md \\\n  ${O}/b.md`,
  `ls && rm -f ${O}/a.md; echo done`,
  // the relative-cd branch fires first here, but the rm's own operand names outputs
  `rm -rf mnt/outputs/pkg && cp -r pkg mnt/outputs/ && cd mnt/outputs/pkg && ls`,
  `sudo rm -f ${O}/a.md`,
  `command rm -f ${O}/a.md`,
  `/bin/rm -f ${O}/a.md`,
  `env rm -f ${O}/a.md`,
  `nice -n 10 rm -f ${O}/a.md`,
  `timeout 5 rm -f ${O}/a.md`,
  `x=1 rm -f ${O}/a.md`,
  `if [ -f ${O}/a.md ]; then rm -f ${O}/a.md; fi`,
  `yes | rm -i ${O}/a.md`,
  `rm -v $(ls ${O}/*.tmp)`,
  `ls ${O}/*.tmp | xargs rm -f`,
  `find ${O} -name '*.tmp' -print0 | xargs -0 rm -f`,
  `find mnt/outputs -name '*.tmp' -delete`,
  `find ${O} -name '*.tmp' -exec rm -f {} \;`,
  `find ${O} -name '*.tmp' -exec rm -f {} +`,
  `rmdir ${O}/empty`,
  `unlink ${O}/a.md`,
  `shred -u ${O}/a.md`,
  `mv mnt/outputs/a.md /tmp/`,
  `rm -rf "${O}"/*`,
  `bash -c 'rm -f ${O}/a.md'`,
  `(cd /tmp && rm -f ${O}/a.md)`,
  `echo $(rm -f ${O}/a.md)`,
  `OUT="${O}/b"\nrm -rf "$OUT"`,
  `OUT=${O}/b; rm -rf "$OUT"`,
  `REVIEW_DIR="${O}/r"\nrm -f "$REVIEW_DIR/deck.pdf"`,
  `python3 -c 'import os; os.remove("${O}/a.md")'`,
  `python3 -c 'import os\nos.remove("${O}/a.md")'`,
  `python3 - <<'EOF'\nimport os\nos.remove("${O}/a.md")\nEOF`,
  `python3 -c 'import os; os.remove(os.path.join("${O}", "a.md"))'`,
  `python3 -c 'from pathlib import Path; Path("${O}/a.md").unlink()'`,
  `python3 -c 'import shutil; shutil.rmtree("${O}/pkg")'`,
  `python3 -c 'import os; os.unlink("${O}/a.md")'`,
  `python3 -c 'import os, glob; [os.remove(p) for p in glob.glob("${O}/*.tmp")]'`,
];
const inferred = [
  // A Python variable named rm next to an outputs path — nothing is deleted. The first is the exact shape
  // a live container run produced; the rest are its heredoc / multi-line variants.
  `python3 -c 'import json; rm = json.load(open("${O}/report.json"))["report_markdown"]; print(rm.find("COACHING"))'`,
  `python3 - <<'EOF'\nimport json\nrm = json.load(open("${O}/report.json"))["report_markdown"]\nprint(rm.find("COACHING"))\nEOF`,
  `python3 <<EOF\nimport json\nrm = json.load(open("${O}/report.json"))["report_markdown"]\nprint(rm.find("COACHING"))\nEOF`,
  `python3 -c 'import json\ndata = json.load(open("${O}/a/doc.json"))\nrm = data.get("body","")\nprint(rm.find("x"))'`,
  `python3 -c 'rm = open("${O}/r.md").read(); print(rm[:50])'`,
  `python3 -c 'rm: str = open("${O}/r.md").read()'`,
  `python3 -c 'print(len(open("${O}/r.md").read())); rm = 1'`,
  // quoted prose, a sed/grep pattern, a trailing comment — the outputs path is not the delete's operand
  `echo 'rm outputs/ghost' >> ${O}/log.md`,
  `sed -i '/rm/d' ${O}/x.md`,
  `grep -rn "rm " ${O}`,
  `rm -rf build # clean before writing to ${O}`,
  // unprovable targets
  `cd /tmp && rm -rf scratch && unzip -o -q ${O}/x.skill -d scratch`,
  `cp -r d ${O}/ && rm -rf /sessions/s/d`,
  // real deletes the classifier cannot name — documented false-negative classes (warn, not fail)
  `for f in ${O}/*.tmp; do rm -f "$f"; done`,
  `cd mnt/outputs && rm -rf scratch`,
  `cd ${O} && rm -rf scratch`,
  `A=${O}; B=$A/sub; rm -rf "$B"`,
  `python3 - <<'EOF'\nimport os\np = "${O}/a.md"\nos.remove(p)\nEOF`,
  // wrapper flag combinations the classifier does not model — documented false negatives
  `sudo -Hu user rm -f ${O}/x`,
  `git -C /repo rm -f ${O}/x`,
  // a method delete decides on its RECEIVER, not on an outputs path elsewhere in the statement
  `python3 -c 'from pathlib import Path; Path("/tmp/x.txt").unlink() if Path("${O}/r.md").exists() else None'`,
  `python3 -c 'import shutil; from pathlib import Path; shutil.copy("${O}/r.md", "/tmp/r.md") or Path("/tmp/old.md").unlink()'`,
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

const UNPROVABLE = `cd /tmp && rm -rf scratch && unzip -o -q ${O}/x.skill -d scratch`;

describe("scanEvents carries a POSITIONAL basis alongside outputsDeletes", () => {
  it("one basis per entry, in order — duplicates included", () => {
    const dir = mkdtempSync(join(tmpdir(), "cwh-basis-"));
    const f = join(dir, "events.jsonl");
    const use = (command: string) =>
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] } });
    writeFileSync(f, [use(UNPROVABLE), use(named[0]), use(UNPROVABLE)].join("\n"));
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

describe("variable expansion: an operand joined through an empty variable is never cleared", () => {
  // `$B${A}C` with A="": the harness's single-pass expansion could join `$B` and `C` into `$BC` and expand
  // THAT — but bash expands `$B` and `C` separately (`rm zzzC`, or `rm C` with B unset, a cwd-relative path).
  // Neither reading is provable, so the join is kept apart and the operand stays unprovable: flagged, and
  // `inferred` at most, whatever `BC` holds.
  it("a joined operand that would read as an outputs path is flagged, inferred (not named)", () => {
    const cmd = `A=""; BC=${O}/f; B=zzz; rm $B\${A}C`;
    expect(isOutputsDelete(cmd)).toBe(true);
    expect(outputsDeleteBasis(cmd)).toBe("inferred");
  });
  it("a joined operand that would read as a safe path is still flagged — never cleared as safe", () => {
    const cmd = `A=''; BC=/tmp/x; echo ${O}/log; rm $B\${A}C`;
    expect(isOutputsDelete(cmd)).toBe(true);
    expect(outputsDeleteBasis(cmd)).toBe("inferred");
  });
});

describe("variable expansion has a work budget; over it the scanner decides strictly", () => {
  // Exact expansion costs (distinct variables referenced) × (statement length). Past EXPANSION_BUDGET the
  // scanner does not expand: every mount the command names literally counts as deleted in, and the
  // classifier answers `named` when its own expansion (of the comment-stripped text) is over too; otherwise it
  // runs its normal analysis. Stricter only — for any mount named literally in the command.
  const many = Array.from({ length: 4000 }, (_, i) => `v${i}=$v${i + 1}`).join(" ");
  const refs = Array.from({ length: 4000 }, (_, i) => `$v${i}`).join("");
  it("a provably safe delete in a command over the budget is flagged, named", () => {
    const cmd = `${many}\necho ${refs} ${O}/log\nrm -f /tmp/scratch`;
    expect(isOutputsDelete(cmd)).toBe(true);
    expect(outputsDeleteBasis(cmd)).toBe("named");
  });
  it("…while the same delete in a small command is not a delete at all", () => {
    expect(isOutputsDelete(`v0=$v1 v1=x\necho $v0$v1 ${O}/log\nrm -f /tmp/scratch`)).toBe(false);
  });
});
