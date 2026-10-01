// `hillclimb run` argument parsing. The surface mirrors runner-scaffold.mjs (bundle 2.1.285, runner-scaffold.mjs l.180-214):
// same flags, same defaults, same refusals, all mapped to a UsageError (exit 2). Two deliberate differences,
// both stricter and both still exit 2: a flag-looking value is refused (the scaffold's val() takes it as the value),
// and a decider with --concurrency > 1 is refused (eval's rule).
import { describe, it, expect } from "vitest";
import { parseHillclimbRunArgs, HILLCLIMB_RUN_DEFAULTS } from "../src/hillclimb/args.js";
import { UsageError } from "../src/errors.js";

const run = (...argv: string[]) => parseHillclimbRunArgs(argv);
const refuses = (argv: string[], msg: RegExp) => {
  expect(() => parseHillclimbRunArgs(argv)).toThrow(UsageError);
  expect(() => parseHillclimbRunArgs(argv)).toThrow(msg);
};

describe("hillclimb run args — scaffold defaults (runner-scaffold.mjs l.181-183)", () => {
  it("defaults equal the scaffold's: flow, variant, reps 1, concurrency 4, timeout 1800", () => {
    const a = run("evals/");
    expect(a.help).toBe(false);
    if (a.help) return;
    expect(a.flow).toBe(".claude/hillclimb/flow");
    expect(a.variant).toBe("baseline");
    expect(a.reps).toBe(1);
    expect(a.concurrency).toBe(4);
    expect(a.timeoutS).toBe(1800);
    expect(a.approveHarness).toBe(false);
    expect(a.model).toBeUndefined();
    expect(HILLCLIMB_RUN_DEFAULTS).toEqual({
      flow: ".claude/hillclimb/flow",
      variant: "baseline",
      reps: 1,
      concurrency: 4,
      timeoutS: 1800,
    });
  });

  it("reads every scaffold flag", () => {
    const a = run(
      "s.yaml",
      "--flow",
      ".claude/hillclimb/x",
      "--variant",
      "v3",
      "--model",
      "claude-sonnet-4-6",
      "--reps",
      "2",
      "--concurrency",
      "1",
      "--timeout-s",
      "0",
      "--approve-harness",
    );
    if (a.help) throw new Error("unexpected help");
    expect(a).toMatchObject({
      target: "s.yaml",
      flow: ".claude/hillclimb/x",
      variant: "v3",
      model: "claude-sonnet-4-6",
      reps: 2,
      concurrency: 1,
      timeoutS: 0,
      approveHarness: true,
    });
  });

  it("--skill names the plugin skill skill_invoked tracks; absent by default; given once", () => {
    const a = run("s.yaml", "--skill", "deck-review");
    if (a.help) throw new Error("unexpected help");
    expect(a.skill).toBe("deck-review");
    const b = run("s.yaml");
    if (b.help) throw new Error("unexpected help");
    expect(b.skill).toBeUndefined();
    expect("skill" in b).toBe(false);
    refuses(["s.yaml", "--skill", "a", "--skill", "b"], /--skill given more than once/);
  });

  it("-h and --help ask for help (exit 0 at the CLI)", () => {
    expect(run("-h").help).toBe(true);
    expect(run("s.yaml", "--help").help).toBe(true);
  });
});

describe("hillclimb run args — refusals (exit 2)", () => {
  it("a value flag at the end names the flag", () => {
    for (const f of ["--flow", "--variant", "--model", "--reps", "--concurrency", "--timeout-s", "--case", "--judge-model"])
      refuses(["s.yaml", f], new RegExp(`${f} requires a value`));
  });

  it("a flag-looking value is refused (stricter than S's val(), still exit 2)", () => {
    refuses(["s.yaml", "--flow", "--variant", "v1"], /--flow: missing value \(got flag-looking "--variant"\)/);
  });

  it("an unknown flag is refused", () => {
    refuses(["s.yaml", "--bogus"], /unknown flag: --bogus/);
  });

  it("variant must be baseline or v<N>, N >= 1 without a leading zero (runner-scaffold.mjs l.199)", () => {
    for (const ok of ["baseline", "v1", "v12"]) expect(() => run("s.yaml", "--variant", ok)).not.toThrow();
    for (const bad of ["v0", "v01", "variant_a", "V1", "v1-better", "base"])
      refuses(["s.yaml", "--variant", bad], /--variant must be 'baseline' or 'v<N>'/);
  });

  it("--timeout-s: 0 = no ceiling; negative, non-numeric and > 2^31-1 ms are refused (runner-scaffold.mjs l.206-207)", () => {
    expect(() => run("s.yaml", "--timeout-s", "2147483")).not.toThrow();
    refuses(["s.yaml", "--timeout-s", "2147484"], /--timeout-s/);
    refuses(["s.yaml", "--timeout-s", "-5"], /--timeout-s/);
    refuses(["s.yaml", "--timeout-s", "soon"], /--timeout-s/);
  });

  it("--reps and --concurrency must be integers >= 1 (runner-scaffold.mjs l.208-209)", () => {
    for (const f of ["--reps", "--concurrency"]) for (const bad of ["0", "1.5", "x"]) refuses(["s.yaml", f, bad], new RegExp(f));
  });

  it("exactly one scenario target", () => {
    refuses([], /exactly one scenario file or directory/);
    refuses(["a.yaml", "b.yaml"], /exactly one scenario file or directory/);
  });

  it("--model and --judge-model must be concrete ids, never aliases", () => {
    refuses(["s.yaml", "--model", "sonnet"], /--model.*concrete/);
    refuses(["s.yaml", "--judge-model", "opus"], /--judge-model.*concrete/);
  });

  it("--decider-cmd and --decider-dir are mutually exclusive", () => {
    refuses(["s.yaml", "--decider-cmd", "x", "--decider-dir", "d", "--concurrency", "1"], /--decider-cmd and --decider-dir/);
  });

  it("any decider with --concurrency > 1 is refused, including the default 4, and says how to fix it", () => {
    refuses(["s.yaml", "--decider-dir", "d"], /pass --concurrency 1/);
    refuses(["s.yaml", "--decider-cmd", "x", "--concurrency", "2"], /pass --concurrency 1/);
    // --decider-llm is not a hillclimb flag (as on eval): a scenario that wants it sets on_unanswered: llm
    refuses(["s.yaml", "--decider-llm"], /unknown flag: --decider-llm/);
    expect(() => run("s.yaml", "--decider-dir", "d", "--concurrency", "1")).not.toThrow();
  });

  it("--output-format is text or json", () => {
    refuses(["s.yaml", "--output-format", "yaml"], /--output-format/);
  });
});

describe("hillclimb run args — harness additions", () => {
  it("--case repeats and accumulates; booleans default false", () => {
    const a = run("d/", "--case", "a", "--case", "b");
    if (a.help) throw new Error("unexpected help");
    expect(a.cases).toEqual(["a", "b"]);
    expect(a).toMatchObject({ ablate: false, dryRun: false, noCopyInputs: false, outputFormat: "text" });
  });

  it("reads the harness booleans and globals", () => {
    const a = run("d/", "--ablate", "--dry-run", "--no-copy-inputs", "--output-format", "json", "--dotenv", "e", "--run-dir", "r");
    if (a.help) throw new Error("unexpected help");
    expect(a).toMatchObject({ ablate: true, dryRun: true, noCopyInputs: true, outputFormat: "json" });
    expect(a.globals).toEqual([
      { flag: "--dotenv", value: "e" },
      { flag: "--run-dir", value: "r" },
    ]);
  });

  it("accepts --flag=value", () => {
    const a = run("d/", "--variant=v2", "--reps=3");
    if (a.help) throw new Error("unexpected help");
    expect(a).toMatchObject({ variant: "v2", reps: 3 });
  });
});
