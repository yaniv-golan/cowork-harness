// Where a consumer (or the loop agent) is told to run a `hillclimb` subcommand, the invocation names `--flow`. Every
// subcommand defaults to the same `.claude/hillclimb/flow`, but `state-template` writes the metrics legend only on an
// explicit `--flow`, and a loop whose flow dir is anywhere else must pass the same dir to every one of them. Prose that drops the flag teaches a loop to write its legend nowhere, or to check a flow
// dir it never ran into.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HILLCLIMB_REGRADE_BOOLEAN_FLAGS,
  HILLCLIMB_REGRADE_VALUE_FLAGS,
  HILLCLIMB_RUN_BOOLEAN_FLAGS,
  HILLCLIMB_RUN_REPEATED_FLAGS,
  HILLCLIMB_RUN_USAGE,
  HILLCLIMB_RUN_VALUE_FLAGS,
  HILLCLIMB_USAGE,
} from "../src/hillclimb/usage.js";

const ROOT = join(import.meta.dirname, "..");
const doc = (p: string) => readFileSync(join(ROOT, p), "utf8");
const REF = ".claude/skills/cowork-harness/references/hillclimb.md";

/** The subcommands, read from the family's usage line (`usage: hillclimb <run | check | …> ...`), so a new one is
 *  covered here without editing this file. */
const SUBS = HILLCLIMB_USAGE.split("\n")[0]
  .match(/^usage: hillclimb <([^>]+)>/)![1]
  .split("|")
  .map((s) => s.trim());
const ALT = SUBS.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
const LOOP = new RegExp(`hillclimb (${ALT})(?![\\w-])`);
const sorted = (xs: Iterable<string>) => [...xs].sort();

/** Every `hillclimb <subcommand> …` code span in `text`. */
const spans = (text: string): string[] =>
  [...text.matchAll(new RegExp(`\`([^\`\\n]*hillclimb (?:${ALT})(?![\\w-])[^\`\\n]*)\``, "g"))].map((m) => m[1]);

describe("every hillclimb loop invocation a consumer is shown names --flow", () => {
  it("reads the subcommand set from the family usage", () => {
    expect(SUBS).toEqual(expect.arrayContaining(["run", "check", "state-template", "freeze-ref", "regrade"]));
  });

  it("the usage text of each subcommand", () => {
    const heads = HILLCLIMB_USAGE.split("\n").filter((l) => LOOP.test(l) && l.startsWith("usage: hillclimb "));
    expect(sorted(heads.map((l) => l.match(LOOP)![1]))).toEqual(sorted(SUBS));
    for (const l of heads) expect(l, l).toContain("--flow");
  });

  it("the top-level --help lines", () => {
    const lines = doc("src/cli.ts")
      .split("\n")
      .filter((l) => /^\s+hillclimb /.test(l) && LOOP.test(l));
    expect(sorted(lines.map((l) => l.trim().split(/\s+/)[1]))).toEqual(sorted(SUBS));
    for (const l of lines) expect(l, l).toContain("--flow");
  });

  it("the docs/cli.md command table row", () => {
    const row = doc("docs/cli.md")
      .split("\n")
      .find((l) => l.startsWith("| `hillclimb run"));
    expect(row).toBeDefined();
    const invocations = spans(row!).filter((s) => s.startsWith("hillclimb "));
    expect(sorted(invocations.map((s) => s.split(/\s+/)[1]))).toEqual(sorted(SUBS));
    for (const s of invocations) expect(s, s).toContain("--flow");
  });

  it("every command line of the skill's hillclimb reference", () => {
    const ref = doc(REF);
    const blocks = [...ref.matchAll(/```(?:bash|sh)?\n([\s\S]*?)```/g)].map((m) => m[1]);
    const commands = blocks.flatMap((b) => b.split("\n")).filter((l) => l.includes("cowork-harness hillclimb ") && LOOP.test(l));
    expect(sorted(new Set(commands.map((l) => l.match(LOOP)![1])))).toEqual(sorted(SUBS));
    for (const l of commands) expect(l, l).toContain("--flow");
    for (const s of spans(ref)) expect(s, s).toContain("--flow");
  });

  it("llms.txt points an agent at the reference, with --flow", () => {
    const line = doc("llms.txt")
      .split("\n")
      .find((l) => l.includes("references/hillclimb.md"));
    expect(line).toBeDefined();
    expect(line).toContain("--flow");
  });
});

describe("the skill's hillclimb reference", () => {
  it("is indexed in SKILL.md's references table", () => {
    expect(doc(".claude/skills/cowork-harness/SKILL.md")).toMatch(/^\| \[`references\/hillclimb\.md`\]\(references\/hillclimb\.md\) \|/m);
  });

  it("names every `hillclimb run` flag", () => {
    const ref = doc(REF);
    for (const f of [...HILLCLIMB_RUN_BOOLEAN_FLAGS, ...HILLCLIMB_RUN_VALUE_FLAGS, ...HILLCLIMB_RUN_REPEATED_FLAGS])
      expect(ref, f).toContain(`\`${f}`);
  });

  // A decider with the default --concurrency 4 is refused (args.ts): the default never drops to 1 on its own.
  it("says a decider needs an explicit --concurrency 1, in the usage text, docs/cli.md and the reference", () => {
    for (const [where, text] of [
      ["usage.ts", HILLCLIMB_RUN_USAGE],
      [
        "docs/cli.md",
        doc("docs/cli.md")
          .split("\n")
          .find((l) => l.startsWith("- `hillclimb run`"))!,
      ],
      [REF, doc(REF)],
    ] as const) {
      expect(text, where).not.toMatch(/1 with a decider/);
      expect(text, where).toContain("--concurrency 1");
    }
  });

  // The snapshot copies git-tracked files only: a file the loop adds and never `git add`s is not measured.
  it("tells the loop to git add a new plugin file, and names the no-tracked-files refusal", () => {
    const ref = doc(REF);
    expect(ref).toContain("`git add`");
    expect(ref).toMatch(/no git-tracked files/);
  });

  it("quickstart: approval spends nothing, and baseline and v1 run at the same --reps", () => {
    const block = doc(REF).match(/```bash\n([\s\S]*?)```/)![1];
    const lines = block.split("\n").filter((l) => /hillclimb run\b/.test(l));
    for (const l of lines.filter((x) => x.includes("--approve-harness"))) expect(l, l).toContain("--dry-run");
    const reps = (re: RegExp) => lines.find((l) => re.test(l) && !l.includes("--dry-run"))?.match(/--reps (\d+)/)?.[1];
    expect(reps(/--variant baseline\b/)).toBeDefined();
    expect(reps(/--variant baseline\b/)).toBe(reps(/--variant v1\b/));
  });

  it("names every `hillclimb regrade` flag, and shows `--fill-refs` on a command line", () => {
    const ref = doc(REF);
    for (const f of [...HILLCLIMB_REGRADE_BOOLEAN_FLAGS, ...HILLCLIMB_REGRADE_VALUE_FLAGS, "--case"]) expect(ref, f).toContain(`\`${f}`);
    expect(ref).toMatch(/^cowork-harness hillclimb regrade .*--fill-refs/m);
  });

  it("explains a scenario's numeric metric columns under Reading results", () => {
    const reading = doc(REF).split("## Reading results")[1] ?? "";
    for (const s of ["`<id>`", "`<id>_present`", "`meta.metrics_unavailable`", "predate", "refused", "never the headline"])
      expect(reading, s).toContain(s);
  });
});
