import { describe, it, expect, afterEach, vi } from "vitest";
import { computeVerdict } from "../src/run/verdict.js";

// Resolved-tier staleness class: a `fidelity: cowork` cassette records the tier the loop-decision
// gate resolved to at record time (`effectiveFidelity`); if the current baseline resolves differently
// today, the recording exercises the WRONG tier and must red `verify-cassettes` (class-blind adapter)
// while staying warn-by-default on replay (`resolved-tier` is NOT a skill-drift class; `--strict`
// escalates). Baseline-load failures and pre-`effectiveFidelity` cowork cassettes are LOUD
// `unverifiable-tier` findings (can't verify ⇒ not green) — but a pre-field cassette with an EXPLICIT
// tier is statically knowable and passes with a non-failing informational note.
// Isolated in its own file because it mocks `loadBaseline` with name-keyed synthetic baselines.

vi.mock("../src/baseline.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/baseline.js")>();
  const gateBaseline = (appVersion: string, on: boolean): unknown => ({
    appVersion,
    provenance: { gates: { "hostLoop:1143815894": { on } } },
  });
  return {
    ...actual,
    loadBaseline: (name: string) => {
      if (name === "latest") return gateBaseline("9.9.9", true); // gate ON ⇒ resolves hostloop
      if (name === "pinned-gate-off") return gateBaseline("1.1.1", false); // gate OFF ⇒ resolves container
      throw new Error(`unknown baseline '${name}' (simulated)`);
    },
  };
});

const { computeStaleness, checkStaleness, replayCassette, CASSETTE_VERSION } = await import("../src/run/cassette.js");
type Cassette = import("../src/run/cassette.js").Cassette;

const okEvents = () => [
  JSON.stringify({ type: "system", subtype: "init", tools: [] }),
  JSON.stringify({ type: "result", subtype: "success", is_error: false }),
];

// Fingerprint-LESS by default: the tier check must run before/independent of the `if (!fp)` guard —
// the oldest cassettes (no fingerprint, no effectiveFidelity, fidelity: cowork) must not be silently skipped.
const cassette = (over: { fidelity?: string; baseline?: string; effectiveFidelity?: string; fingerprint?: object }): Cassette =>
  ({
    cassetteVersion: CASSETTE_VERSION,
    scenario: {
      name: "c",
      baseline: over.baseline ?? "latest",
      session: "(inline)",
      fidelity: over.fidelity ?? "cowork",
      prompt: "hi",
      answers: [],
      expect_denied: [],
      assert: [{ result: "success" }],
    },
    events: okEvents(),
    controlOut: [],
    ...(over.effectiveFidelity !== undefined ? { effectiveFidelity: over.effectiveFidelity } : {}),
    ...(over.fingerprint !== undefined ? { fingerprint: over.fingerprint } : {}),
  }) as unknown as Cassette;

const origWrite = process.stderr.write.bind(process.stderr);
afterEach(() => {
  process.stderr.write = origWrite;
});
function mute(): void {
  process.stderr.write = (() => true) as typeof process.stderr.write;
}

describe("resolved-tier — gate flip vs record-time tier", () => {
  it("cowork recorded at 'container' while the baseline now resolves hostloop → resolved-tier finding", () => {
    const { findings, notes } = computeStaleness(cassette({ effectiveFidelity: "container" }), undefined);
    expect(findings).toEqual([expect.objectContaining({ class: "resolved-tier" })]);
    expect(findings[0].message).toMatch(/hostloop/);
    expect(findings[0].message).toMatch(/1143815894/);
    expect(notes).toEqual([]);
  });

  it("cowork recorded at 'hostloop' matching today's resolution → clean", () => {
    const { findings, notes } = computeStaleness(cassette({ effectiveFidelity: "hostloop" }), undefined);
    expect(findings).toEqual([]);
    expect(notes).toEqual([]);
  });

  it("resolution is baseline-only: CLAUDE_FORCE_HOST_LOOP=1 must NOT change the verify result", () => {
    const prev = process.env.CLAUDE_FORCE_HOST_LOOP;
    process.env.CLAUDE_FORCE_HOST_LOOP = "1";
    try {
      // pinned-gate-off resolves container regardless of the env override (suppressed via `over`).
      const { findings } = computeStaleness(cassette({ baseline: "pinned-gate-off", effectiveFidelity: "container" }), undefined);
      expect(findings).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_FORCE_HOST_LOOP;
      else process.env.CLAUDE_FORCE_HOST_LOOP = prev;
    }
  });
});

describe("resolved-tier — pinned-baseline resolution", () => {
  it("resolves against the scenario's pinned baseline, not latest (pin gate OFF ⇒ container is current)", () => {
    const { findings } = computeStaleness(cassette({ baseline: "pinned-gate-off", effectiveFidelity: "container" }), undefined);
    expect(findings).toEqual([]); // latest (gate ON) would have flagged this — the pin wins
  });

  it("cowork + unloadable pinned baseline → loud unverifiable-tier finding, no throw", () => {
    const c = cassette({ baseline: "no-such-baseline", effectiveFidelity: "container" });
    expect(() => computeStaleness(c, undefined)).not.toThrow();
    const { findings } = computeStaleness(c, undefined);
    expect(findings).toEqual([expect.objectContaining({ class: "unverifiable-tier" })]);
    expect(findings[0].message).toMatch(/no-such-baseline/);
  });

  it("explicit tier + unloadable pinned baseline → NO tier finding (tier never consults the baseline)", () => {
    const { findings, notes } = computeStaleness(
      cassette({ fidelity: "container", baseline: "no-such-baseline", effectiveFidelity: "container" }),
      undefined,
    );
    expect(findings.filter((f) => f.class === "resolved-tier" || f.class === "unverifiable-tier")).toEqual([]);
    expect(notes).toEqual([]);
  });
});

describe("unverifiable-tier — missing effectiveFidelity (loud, never a silent legacy-skip)", () => {
  it("cowork + missing field → unverifiable-tier, EVEN on a fingerprint-less cassette (guard independence)", () => {
    const { findings } = computeStaleness(cassette({}), undefined); // no fingerprint, no effectiveFidelity
    expect(findings).toEqual([expect.objectContaining({ class: "unverifiable-tier" })]);
    expect(findings[0].message).toMatch(/predates effectiveFidelity/);
  });

  it("explicit tier + missing field → exit-0 semantics: no finding, one informational note", () => {
    const { findings, notes } = computeStaleness(cassette({ fidelity: "container" }), undefined);
    expect(findings).toEqual([]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/statically knowable/);
  });
});

describe("class-blind string adapter (verify-cassettes gate semantics)", () => {
  it("forwards resolved-tier and unverifiable-tier findings (hard fail on the class-blind gate)", () => {
    expect(checkStaleness(cassette({ effectiveFidelity: "container" }), "")).toHaveLength(1);
    expect(checkStaleness(cassette({}), "")).toHaveLength(1);
  });

  it("does NOT forward notes — a pre-field explicit-tier cassette stays green", () => {
    expect(checkStaleness(cassette({ fidelity: "container" }), "")).toEqual([]);
  });
});

describe("replay-vs-verify escalation split", () => {
  const ok = (r: Awaited<ReturnType<typeof replayCassette>>) => computeVerdict(r, "replay").pass;

  it("replay: resolved-tier is warn-by-default (surfaced in staleness[], ok stays true)", async () => {
    mute();
    const r = await replayCassette(cassette({ effectiveFidelity: "container" }));
    expect(r.staleness).toEqual([expect.objectContaining({ class: "resolved-tier" })]);
    expect(ok(r)).toBe(true);
  });

  it("replay --strict escalates resolved-tier to a failing assertion", async () => {
    mute();
    const r = await replayCassette(cassette({ effectiveFidelity: "container" }), [], { strict: true });
    expect(ok(r)).toBe(false);
  });

  it("replay --fail-on-skill-drift does NOT fail on resolved-tier (not a skill-source class)", async () => {
    mute();
    const r = await replayCassette(cassette({ effectiveFidelity: "container" }), [], { failOnSkillDrift: true });
    expect(ok(r)).toBe(true);
  });
});
