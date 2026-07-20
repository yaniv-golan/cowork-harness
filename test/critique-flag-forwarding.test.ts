import { describe, it, expect } from "vitest";
import { parseArgs, buildTaskTurnArgs, buildReflectionTurnArgs } from "../src/critique/command.js";

// `critique` spawns two `skill` turns. Which turn each flag reaches is not cosmetic:
//  * session SOURCES (uploads/folders/plugins/marketplaces) are part of the session-origin key, so a
//    task-only forward makes the reflection `--resume` compute a different identity and throw fail-closed
//    — that breaks EVERY run of an upload-bearing critique, which is the motivating bug;
//  * `--decider-dir` must reach the task turn ONLY — its file channel requires a fresh empty dir per run.
// Both are cheap to test without spawning, and expensive to discover live.
const P = (...extra: string[]) => parseArgs(["./my-skill", "--prompt", "probe", ...extra]);

describe("source flags reach BOTH turns (the origin-key invariant)", () => {
  it("forwards --upload to the task AND reflection turns, EXACTLY ONCE each", () => {
    // The count matters and presence-assertions miss it: forwardBoth/forwardTask are both spread into the
    // task argv, so a "both" flag pushed into both buckets emitted `--upload` TWICE — which mounts the
    // file twice and broke the task turn. Caught by a live smoke, not by `toContain`.
    const o = P("--upload", "./cap-table.xlsx");
    for (const args of [buildTaskTurnArgs(o, "s1"), buildReflectionTurnArgs(o, "s1")]) {
      expect(args.filter((a) => a === "--upload")).toHaveLength(1);
      expect(args.filter((a) => a === "./cap-table.xlsx")).toHaveLength(1);
    }
  });

  it("emits no forwarded flag more than once on either turn", () => {
    const o = P("--upload", "a.pdf", "--folder", "./d", "--model", "m", "--label", "g1", "--decider-dir", "./gates");
    for (const args of [buildTaskTurnArgs(o, "s1"), buildReflectionTurnArgs(o, "s1")]) {
      const flags = args.filter((a) => a.startsWith("--"));
      expect(new Set(flags).size, `duplicate flag in ${args.join(" ")}`).toBe(flags.length);
    }
  });

  it("forwards repeated --upload values in order", () => {
    const o = P("--upload", "a.pdf", "--upload", "b.csv");
    for (const args of [buildTaskTurnArgs(o, "s1"), buildReflectionTurnArgs(o, "s1")]) {
      expect(args.join(" ")).toContain("--upload a.pdf --upload b.csv");
    }
  });

  it("forwards --folder, --plugin, --marketplace/--enable to both turns", () => {
    const o = P("--folder", "./data", "--plugin", "./p", "--marketplace", "./m", "--enable", "s@m");
    for (const args of [buildTaskTurnArgs(o, "s1"), buildReflectionTurnArgs(o, "s1")]) {
      for (const v of ["./data", "./p", "./m", "s@m"]) expect(args).toContain(v);
    }
  });

  it("forwards --model to both turns — the reflection must not silently use the default", () => {
    const o = P("--model", "claude-sonnet-5");
    expect(buildReflectionTurnArgs(o, "s1")).toEqual(expect.arrayContaining(["--model", "claude-sonnet-5"]));
  });
});

describe("graded-run flags reach the TASK turn only", () => {
  it("keeps --decider-dir out of the reflection turn (fresh-empty-dir invariant)", () => {
    const o = P("--decider-dir", "./gates");
    expect(buildTaskTurnArgs(o, "s1")).toContain("--decider-dir");
    expect(buildReflectionTurnArgs(o, "s1")).not.toContain("--decider-dir");
  });

  it("keeps --label out of the reflection turn (it would dilute the labelled generation group)", () => {
    const o = P("--label", "gen-1");
    expect(buildTaskTurnArgs(o, "s1")).toContain("--label");
    expect(buildReflectionTurnArgs(o, "s1")).not.toContain("--label");
  });

  it("keeps --answer out of the reflection turn (which stays pinned deterministic)", () => {
    const o = P("--answer", "Proceed?=Yes");
    expect(buildTaskTurnArgs(o, "s1")).toContain("--answer");
    expect(buildReflectionTurnArgs(o, "s1")).not.toContain("--answer");
  });
});

describe("critique's pinned flags", () => {
  it("pins the protocol flags on both turns regardless of what was forwarded", () => {
    const o = P("--upload", "x.pdf");
    const task = buildTaskTurnArgs(o, "sess-9");
    const refl = buildReflectionTurnArgs(o, "sess-9");
    expect(task.join(" ")).toContain("--fidelity container");
    expect(task.join(" ")).toContain("--session-id sess-9");
    expect(task.join(" ")).toContain("--output-format json");
    expect(refl.join(" ")).toContain("--resume");
    expect(refl.join(" ")).toContain("--on-unanswered first");
  });

  it("puts forwarded fragments BEFORE the pinned flags so a pinned value wins", () => {
    const o = P("--upload", "x.pdf");
    const args = buildTaskTurnArgs(o, "s1");
    expect(args.indexOf("--upload")).toBeLessThan(args.indexOf("--fidelity"));
  });
});

describe("refusals carry the spec's reason, not 'unknown flag'", () => {
  for (const [flag, needle] of [
    ["--repeat", "two-turn protocol"],
    ["--session-id", "own session"],
    ["--ablate-skill", "incoherent"],
    ["--quiet", "own report"],
    ["--dry-run", "no meaningful two-turn preview"],
  ] as const) {
    it(`${flag} is refused with an explanation`, () => {
      expect(() => P(flag, "x")).toThrow(new RegExp(needle, "i"));
      expect(() => P(flag, "x")).not.toThrow(/unknown flag/);
    });
  }

  it("--on-unanswered prompt is refused (no TTY inside the spawn)", () => {
    expect(() => P("--on-unanswered", "prompt")).toThrow(/no TTY/i);
    expect(P("--on-unanswered", "first").forwardTask).toContain("--on-unanswered");
  });

  it("a genuinely unknown flag still says 'unknown flag'", () => {
    expect(() => P("--not-a-real-flag")).toThrow(/unknown flag/);
  });
});

describe("probe input", () => {
  it("--prompt and --prompt-file are mutually exclusive", () => {
    expect(() => parseArgs(["./s", "--prompt", "a", "--prompt-file", "./f.txt"])).toThrow(/mutually exclusive/);
  });

  it("--timeout is parsed so critique's own kill-switch can stretch past it", () => {
    expect(P("--timeout", "900000").taskTimeoutMs).toBe(900000);
    expect(() => P("--timeout", "0")).toThrow(/positive integer/);
  });

  it("--keep is accepted as a no-op (runs are always kept)", () => {
    expect(() => P("--keep")).not.toThrow();
  });
});

describe("forwarded-flag value validation (parity with the child's own parser)", () => {
  it("a missing value errors here, not as a spawn stack trace one layer later", () => {
    expect(() => parseArgs(["./s", "--prompt", "p", "--upload"])).toThrow(/--upload requires a value/);
  });

  it("an arity-0 flag rejects `=value` instead of silently inverting it", () => {
    // `--allow-missing-capability=false` forwarded as a bare flag would ENABLE the thing it names.
    expect(() => parseArgs(["./s", "--prompt", "p", "--allow-missing-capability=false"])).toThrow(/takes no value/);
    expect(() => parseArgs(["./s", "--prompt", "p", "--decider-llm=x"])).toThrow(/takes no value/);
  });

  it("PRESERVES the equals form when that is how the value arrived", () => {
    // Not cosmetic: the child's spaced-form parser rejects a value starting with `-`, so normalising
    // `--intent=-terse` into two argv entries would kill a valid input one layer later with a wrong
    // diagnosis. The equals form is the child's own escape hatch — forward it intact.
    expect(parseArgs(["./s", "--prompt", "p", "--upload=./a.pdf"]).forwardBoth).toEqual(["--upload=./a.pdf"]);
    expect(parseArgs(["./s", "--prompt", "p", "--intent=-terse"]).forwardTask).toEqual(["--intent=-terse"]);
  });

  it("still uses the spaced form when the value arrived spaced", () => {
    expect(parseArgs(["./s", "--prompt", "p", "--upload", "./a.pdf"]).forwardBoth).toEqual(["--upload", "./a.pdf"]);
  });

  it("owned flags reject a missing value too — not just forwarded ones", () => {
    // The check lives in flagVal, so every caller gets it. Previously only the spec-forwarding branch
    // checked, so `critique … --dotenv` with a forgotten path silently ran a full critique without env.
    for (const flag of ["--dotenv", "--evaluator-model", "--prompt-file"]) {
      expect(() => parseArgs(["./s", "--prompt", "p", flag]), flag).toThrow(/requires a value/);
    }
  });
});

describe("`repeatable` in the spec is enforced, not decoration", () => {
  it("rejects a non-repeatable FORWARDED flag given twice", () => {
    expect(() => parseArgs(["./s", "--prompt", "p", "--model", "a", "--model", "b"])).toThrow(/not repeatable/);
  });

  it("rejects a duplicated critique-OWNED flag too — the first version guarded only the forwarded branch", () => {
    // `--prompt a --prompt b` silently dropped a probe the user typed. The rationale for rejecting
    // duplicates applies verbatim to critique's own flags; guarding one branch was N-1 of N.
    expect(() => parseArgs(["./s", "--prompt", "a", "--prompt", "b"])).toThrow(/--prompt given more than once/);
    expect(() => parseArgs(["./s", "--prompt", "p", "--evaluator-model", "m1", "--evaluator-model", "m2"])).toThrow(/not repeatable/);
    expect(() => parseArgs(["./s", "--prompt-file", "a", "--prompt-file", "b"])).toThrow(/not repeatable/);
  });

  it("exempts arity-0 flags — there is no value to lose and the child takes them idempotently", () => {
    expect(() => parseArgs(["./s", "--prompt", "p", "--decider-llm", "--decider-llm"])).not.toThrow();
  });

  it("still allows genuinely repeatable flags", () => {
    expect(parseArgs(["./s", "--prompt", "p", "--upload", "a", "--upload", "b"]).forwardBoth).toEqual(["--upload", "a", "--upload", "b"]);
  });
});
