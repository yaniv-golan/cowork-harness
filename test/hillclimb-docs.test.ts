// Where a consumer (or the loop agent) is told to run `hillclimb run | check | state-template`, the invocation names
// `--flow`. The three commands default to the same `.claude/hillclimb/flow`, but `state-template` writes the
// metrics legend only on an explicit `--flow`, and a loop whose flow dir is anywhere else must pass the same dir
// to every one of them. Prose that drops the flag teaches a loop to write its legend nowhere, or to check a flow
// dir it never ran into.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HILLCLIMB_CHECK_USAGE,
  HILLCLIMB_RUN_BOOLEAN_FLAGS,
  HILLCLIMB_RUN_REPEATED_FLAGS,
  HILLCLIMB_RUN_USAGE,
  HILLCLIMB_RUN_VALUE_FLAGS,
  HILLCLIMB_STATE_TEMPLATE_USAGE,
} from "../src/hillclimb/usage.js";

const ROOT = join(import.meta.dirname, "..");
const doc = (p: string) => readFileSync(join(ROOT, p), "utf8");
const REF = ".claude/skills/cowork-harness/references/hillclimb.md";
const LOOP = /hillclimb (run|check|state-template)\b/;

/** Every `hillclimb run|check|state-template …` code span in `text`. */
const spans = (text: string): string[] =>
  [...text.matchAll(/`([^`\n]*hillclimb (?:run|check|state-template)\b[^`\n]*)`/g)].map((m) => m[1]);

describe("every hillclimb loop invocation a consumer is shown names --flow", () => {
  it("the usage text of each subcommand", () => {
    for (const u of [HILLCLIMB_RUN_USAGE, HILLCLIMB_CHECK_USAGE, HILLCLIMB_STATE_TEMPLATE_USAGE])
      expect(u.split("\n")[0]).toContain("--flow");
  });

  it("the top-level --help lines", () => {
    const lines = doc("src/cli.ts")
      .split("\n")
      .filter((l) => /^\s+hillclimb (run|check|state-template)\b/.test(l));
    expect(lines.map((l) => l.trim().split(/\s+/)[1]).sort()).toEqual(["check", "run", "state-template"]);
    for (const l of lines) expect(l, l).toContain("--flow");
  });

  it("the docs/cli.md command table row", () => {
    const row = doc("docs/cli.md")
      .split("\n")
      .find((l) => l.startsWith("| `hillclimb run"));
    expect(row).toBeDefined();
    const invocations = spans(row!).filter((s) => s.startsWith("hillclimb "));
    expect(invocations.map((s) => s.split(/\s+/)[1]).sort()).toEqual(["check", "run", "state-template"]);
    for (const s of invocations) expect(s, s).toContain("--flow");
  });

  it("every command line of the skill's hillclimb reference", () => {
    const ref = doc(REF);
    const blocks = [...ref.matchAll(/```(?:bash|sh)?\n([\s\S]*?)```/g)].map((m) => m[1]);
    const commands = blocks.flatMap((b) => b.split("\n")).filter((l) => /cowork-harness hillclimb (run|check|state-template)\b/.test(l));
    expect(new Set(commands.map((l) => l.match(LOOP)![1]))).toEqual(new Set(["run", "check", "state-template"]));
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

  it("covers run, check and state-template only", () => {
    expect(doc(REF)).not.toMatch(/hillclimb regrade/);
  });
});
