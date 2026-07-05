import { describe, it, expect } from "vitest";
import { assembleRunResult } from "../src/run/assemble-run-result.js";
import type { RunResult } from "../src/types.js";

import type { CompleteRunResult } from "../src/run/assemble-run-result.js";

// A minimal but fully-explicit CompleteRunResult literal — every optional field is present
// with an explicit `undefined`, exactly the shape every real call site (Tasks 2-5) will produce.
// (CompleteRunResult, NOT Required<RunResult> — the latter strips `undefined` and won't compile;
// see the Architecture type-mechanism correction.)
function fullyExplicitFixture(): CompleteRunResult {
  return {
    $schema: undefined,
    generator: undefined,
    scenario: "test-scenario",
    prompt: undefined,
    fidelity: "container",
    baseline: "latest",
    result: "success",
    resultErrorKind: undefined,
    stalledOnQuestion: undefined,
    capabilityProbe: undefined,
    requiresCapabilityUnmet: undefined,
    decisions: [],
    toolCounts: undefined,
    gateDeliveries: undefined,
    egress: [],
    assertions: [],
    subagents: undefined,
    nonReproducibleAnswers: undefined,
    usage: undefined,
    cost: undefined,
    durationMs: undefined,
    fingerprint: undefined,
    outDir: "/tmp/fake-out-dir",
    workDir: undefined,
    outputsDir: undefined,
    userVisibleRoots: undefined,
    readonlyFolderRoots: undefined,
    artifacts: undefined,
    preRunPaths: undefined,
    partial: undefined,
    unansweredGate: undefined,
    nonDeterministic: undefined,
    nonDeterministicTerminal: undefined,
    permissiveAutoAllow: undefined,
    scan: undefined,
    effectiveFidelity: undefined,
    fidelityWarnings: undefined,
    staleness: undefined,
    skippedAssertions: undefined,
    toolResults: undefined,
    l0PluginDivergence: undefined,
    missingCapabilityUse: undefined,
    gateProvenance: undefined,
    skillsInvoked: undefined,
    skillToolAvailable: undefined,
  };
}

describe("assembleRunResult", () => {
  it("returns its input unchanged (identity)", () => {
    const fields = fullyExplicitFixture();
    const result = assembleRunResult(fields);
    expect(result).toBe(fields); // same reference — a pure pass-through, no transformation
  });

  it("round-trips through JSON.stringify identically to the raw literal (undefined keys drop the same way)", () => {
    const fields = fullyExplicitFixture();
    const result = assembleRunResult(fields);
    expect(JSON.stringify(result)).toBe(JSON.stringify(fields));
  });
});

// (CompleteRunResult is already imported at the top of this file for the Step 1 fixture.)
// Type-level proof that omitting a field is a compile error, not a silent gap. If this stops being a
// type error (e.g. someone changes assembleRunResult's parameter back to a plain `RunResult`, or an
// all-optional type), the `@ts-expect-error` directive itself becomes an error ("Unused
// '@ts-expect-error' directive"), which fails `npm run typecheck` and CI — the regression can't hide.
//
// NOTE: a `delete`-based proof does NOT work here and was removed. `delete x.field` only errors when
// the property is non-optional AND its type excludes `undefined` (TS2790). CompleteRunResult keeps
// each value's `| undefined`, so `delete` is permitted and the directive would be flagged UNUSED.
// Casting through `as any` (an earlier draft) is worse — it defeats the check entirely. The
// missing-key literal below is the sound exhaustiveness proof.
function typeLevelExhaustivenessProof() {
  // @ts-expect-error — a CompleteRunResult literal missing a key is a compile error (TS2740).
  const _shouldNotCompile: CompleteRunResult = { scenario: "x" };
  void _shouldNotCompile;
}
void typeLevelExhaustivenessProof; // referenced so it's not flagged as an unused function
