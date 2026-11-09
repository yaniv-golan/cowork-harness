import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, buildTaskTurnArgs, buildReflectionTurnArgs, resolveCoworkTier, childForcesHostLoop } from "../src/critique/command.js";

// `critique --fidelity cowork`: `cowork` is not a fourth environment, it means "whichever tier real Cowork
// would use here". critique resolves it ONCE — before either turn is spawned — and hands both turns the
// resolved literal.
//
// The refusal this replaced existed to protect a within-critique invariant: both turns must run at the
// SAME tier, because a cross-tier `--resume` is blocked fail-loud by the session-manifest fidelity stamp.
// One resolution shared by both spawns preserves that exactly; resolving per-turn would not. That is the
// load-bearing property here, and it is what the "same literal on both turns" case below pins.
//
// The resolver is INJECTED so these stay pure: the production default reads the pinned baseline and the
// loop gate off disk, which is I/O this test has no business doing (and which would make the expected
// tier depend on whichever baseline happens to be newest in the tree).

const P = (resolver: (d: string | undefined) => "container" | "hostloop", ...extra: string[]) =>
  parseArgs(["./my-skill", "--prompt", "probe", ...extra], resolver);

const HOST = () => "hostloop" as const;
const VM = () => "container" as const;

describe("--fidelity cowork resolves to a concrete tier at parse time", () => {
  it("resolves to hostloop when the gate says host, and records what was asked for", () => {
    const o = P(HOST, "--fidelity", "cowork");
    expect(o.fidelity).toBe("hostloop");
    expect(o.requestedFidelity).toBe("cowork");
  });

  it("resolves to container when the gate says vm", () => {
    const o = P(VM, "--fidelity", "cowork");
    expect(o.fidelity).toBe("container");
    expect(o.requestedFidelity).toBe("cowork");
  });

  it("never forwards the literal `cowork` to either spawned turn", () => {
    // The child `skill` lane would resolve `cowork` itself, per-turn, against its own baseline read — the
    // exact per-turn resolution this design exists to avoid. Forwarding the resolved tier is the fix, so
    // the string must not survive into either argv.
    const o = P(HOST, "--fidelity", "cowork");
    for (const args of [buildTaskTurnArgs(o, "s1"), buildReflectionTurnArgs(o, "s1")]) {
      expect(args).not.toContain("cowork");
      expect(args[args.indexOf("--fidelity") + 1]).toBe("hostloop");
    }
  });

  it("gives BOTH turns the SAME tier — the invariant the old refusal protected", () => {
    for (const resolver of [HOST, VM]) {
      const o = P(resolver, "--fidelity", "cowork");
      const task = buildTaskTurnArgs(o, "s1");
      const reflection = buildReflectionTurnArgs(o, "s1");
      const tierOf = (a: string[]) => a[a.indexOf("--fidelity") + 1];
      expect(tierOf(task)).toBe(tierOf(reflection));
    }
  });

  it("leaves an explicitly-named tier alone, and sets no requestedFidelity", () => {
    // requestedFidelity exists so a report never reads as though you named the tier that ran. On the
    // common path (a concrete --fidelity) there is nothing to disambiguate, so it must be ABSENT rather
    // than echoing the tier — a consumer branching on its presence would otherwise see it always set.
    for (const tier of ["container", "hostloop"] as const) {
      const o = P(HOST, "--fidelity", tier);
      expect(o.fidelity).toBe(tier);
      expect(o.requestedFidelity).toBeUndefined();
    }
    // The resolver must not even be consulted when a concrete tier was named.
    let called = 0;
    P(
      () => {
        called++;
        return "hostloop";
      },
      "--fidelity",
      "container",
    );
    expect(called).toBe(0);
  });

  it("still refuses microvm and protocol, each with its own reason", () => {
    // Guards against the allowlist being widened past what resume-continuity is proven for.
    expect(() => P(HOST, "--fidelity", "microvm")).toThrow(/microVM guest/i);
    expect(() => P(HOST, "--fidelity", "protocol")).toThrow(/runs the host `claude`, not the agent Cowork runs/i);
    expect(() => P(HOST, "--fidelity", "banana")).toThrow(/not a fidelity tier/i);
  });
});

describe("the resolver sees the --dotenv file the CHILD will load", () => {
  // The child CLI loads --dotenv into its own env BEFORE deciding the loop, and
  // `decideLoopFromBaseline` reads CLAUDE_FORCE_HOST_LOOP from there. critique never loads that file
  // (doing so would also hand its variables to the evaluator's spawned CLI), so it must still READ the
  // value — otherwise the tier it resolves is not the tier the child would have computed.
  it("passes the --dotenv path through to the resolver", () => {
    const dir = mkdtempSync(join(tmpdir(), "critique-cowork-"));
    const envFile = join(dir, "creds.env");
    writeFileSync(envFile, "CLAUDE_FORCE_HOST_LOOP=1\n");
    let seen: string | undefined | symbol = Symbol("uncalled");
    P(
      (d) => {
        seen = d;
        return "hostloop";
      },
      "--fidelity",
      "cowork",
      "--dotenv",
      envFile,
    );
    expect(seen).toBe(envFile);
  });

  it("resolution happens AFTER the --dotenv existence check, so a bad path fails as a usage error", () => {
    // Ordering matters: if resolution ran first, a typo'd --dotenv would surface as a baseline/tier
    // diagnostic instead of the clear "file not found" the user needs.
    let called = 0;
    expect(() =>
      P(
        () => {
          called++;
          return "hostloop";
        },
        "--fidelity",
        "cowork",
        "--dotenv",
        "/nope/definitely-missing.env",
      ),
    ).toThrow(/--dotenv file not found/);
    expect(called).toBe(0);
  });
});

describe("the PRODUCTION resolver (not a test double)", () => {
  // Everything above injects a fake, which proves the wiring but would happily pass with a resolver that
  // never worked. These exercise the real one.

  it("resolves against the pinned baselines actually committed here", () => {
    // Every committed baseline carries hostLoop gate "on(force)", and none
    // sets requireFullVmSandbox — so the real gate read yields hostloop. Asserted as a MEMBERSHIP check
    // plus the gate-derived expectation: if a future sync flips the gate off, this should start failing
    // loudly rather than silently describing a stale world.
    const tier = resolveCoworkTier(undefined);
    expect(["container", "hostloop"]).toContain(tier);
    expect(tier).toBe("hostloop");
  });

  it("honours CLAUDE_FORCE_HOST_LOOP from the ambient env", () => {
    const prior = process.env.CLAUDE_FORCE_HOST_LOOP;
    try {
      process.env.CLAUDE_FORCE_HOST_LOOP = "1";
      expect(childForcesHostLoop(undefined)).toBe(true);
      process.env.CLAUDE_FORCE_HOST_LOOP = "0";
      expect(childForcesHostLoop(undefined)).toBe(false);
    } finally {
      if (prior === undefined) delete process.env.CLAUDE_FORCE_HOST_LOOP;
      else process.env.CLAUDE_FORCE_HOST_LOOP = prior;
    }
  });

  it("reads CLAUDE_FORCE_HOST_LOOP out of --dotenv when the ambient env does not set it", () => {
    const prior = process.env.CLAUDE_FORCE_HOST_LOOP;
    const dir = mkdtempSync(join(tmpdir(), "critique-cowork-env-"));
    const envFile = join(dir, "creds.env");
    writeFileSync(envFile, "# a comment\nexport CLAUDE_FORCE_HOST_LOOP=1\nOTHER=x\n");
    try {
      delete process.env.CLAUDE_FORCE_HOST_LOOP;
      expect(childForcesHostLoop(envFile)).toBe(true);
      // ...and the ambient env WINS when both are set, matching loadDotenv's own precedence (the child
      // would see the exported value, not the file's).
      process.env.CLAUDE_FORCE_HOST_LOOP = "0";
      expect(childForcesHostLoop(envFile)).toBe(false);
    } finally {
      if (prior === undefined) delete process.env.CLAUDE_FORCE_HOST_LOOP;
      else process.env.CLAUDE_FORCE_HOST_LOOP = prior;
    }
  });

  it("does NOT apply the --dotenv file to its own env", () => {
    // Loading it here would also hand every variable to the evaluator's spawned CLI — a side effect well
    // outside a tier decision, and the reason this reads the file instead of calling loadDotenv.
    const dir = mkdtempSync(join(tmpdir(), "critique-cowork-noleak-"));
    const envFile = join(dir, "creds.env");
    writeFileSync(envFile, "CRITIQUE_COWORK_LEAK_CANARY=leaked\n");
    childForcesHostLoop(envFile);
    expect(process.env.CRITIQUE_COWORK_LEAK_CANARY).toBeUndefined();
  });

  it("treats an unreadable --dotenv as 'no override' rather than throwing", () => {
    // parseArgs has already failed loud on a missing path by the time this runs, so a read failure here
    // is an odd-permissions edge, not a user error worth a second diagnostic.
    expect(childForcesHostLoop("/nope/definitely-missing.env")).toBe(false);
  });

  // A VM-gated baseline — the only shape under which the --dotenv override is OBSERVABLE in the result.
  // Every baseline committed here gates host, so against real ones a resolver that ignored --dotenv
  // entirely would return the same answer and look correct. (It did: an early version of this suite
  // tested childForcesHostLoop in isolation, and deleting its call site inside resolveCoworkTier left
  // every case green — the classic "asserting the helper works, never that anyone calls it".)
  const vmGated = { provenance: { gates: { "hostLoop:1143815894": { on: false } } } } as never;

  it("resolves a VM-gated baseline to container", () => {
    const prior = process.env.CLAUDE_FORCE_HOST_LOOP;
    try {
      delete process.env.CLAUDE_FORCE_HOST_LOOP;
      expect(resolveCoworkTier(undefined, () => vmGated)).toBe("container");
    } finally {
      if (prior !== undefined) process.env.CLAUDE_FORCE_HOST_LOOP = prior;
    }
  });

  it("lets --dotenv's CLAUDE_FORCE_HOST_LOOP flip a VM-gated baseline to hostloop", () => {
    // THE binding test: proves resolveCoworkTier actually consults the dotenv file, not merely that
    // childForcesHostLoop can read one.
    const prior = process.env.CLAUDE_FORCE_HOST_LOOP;
    const dir = mkdtempSync(join(tmpdir(), "critique-cowork-flip-"));
    const envFile = join(dir, "creds.env");
    writeFileSync(envFile, "CLAUDE_FORCE_HOST_LOOP=1\n");
    try {
      delete process.env.CLAUDE_FORCE_HOST_LOOP;
      expect(resolveCoworkTier(envFile, () => vmGated)).toBe("hostloop");
    } finally {
      if (prior !== undefined) process.env.CLAUDE_FORCE_HOST_LOOP = prior;
    }
  });

  it("rewraps an unreadable baseline instead of surfacing a bare ENOENT", () => {
    // The one way this change could be a NET REGRESSION for the person hitting it: the refusal it
    // replaced was a clear sentence, so the failure mode must not be worse than what it replaced.
    expect(() =>
      resolveCoworkTier(undefined, () => {
        throw new Error("ENOENT: no such file or directory, open 'desktop-x.json'");
      }),
    ).toThrow(/--fidelity cowork could not be resolved/);
    expect(() =>
      resolveCoworkTier(undefined, () => {
        throw new Error("ENOENT");
      }),
    ).toThrow(/cowork-harness sync|--fidelity container\|hostloop/);
  });
});
