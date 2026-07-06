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
    toolDurations: undefined,
    models: undefined,
    thinking: undefined,
    toolErrors: undefined,
    modelUsage: undefined,
    redundantToolCalls: undefined,
    skillActivity: undefined,
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
    tasks: undefined,
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
// Type-level proof that the `CompleteRunResult` alias itself rejects an incomplete literal — i.e. the
// mapped type in isolation, independent of anything `assembleRunResult` does with it. This catches a
// regression to the alias definition (e.g. someone widens `CompleteRunResult` back to an all-optional
// shape). It does NOT catch a regression to `assembleRunResult`'s parameter type — a variable annotated
// `: CompleteRunResult` compiles or fails based only on the alias, never on the function's signature.
// See `assemblerSignaturePinsExhaustiveness` below for the proof that covers the function itself.
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

// Distinct from the proof above: this one calls `assembleRunResult` itself, so it also guards the
// function's PARAMETER TYPE, not just the `CompleteRunResult` alias in isolation. If a future edit ever
// loosens `assembleRunResult`'s signature to accept plain `RunResult` (re-opening the silent-field-
// omission hole this function exists to close), this literal — which has every REQUIRED field but omits
// every OPTIONAL one — would silently compile, flipping this `@ts-expect-error` to "unused" and failing
// `npm run typecheck`/CI. That's the regression this test exists to catch.
function assemblerSignaturePinsExhaustiveness() {
  // @ts-expect-error — compiles only if assembleRunResult's parameter is CompleteRunResult, not RunResult.
  assembleRunResult({
    scenario: "x",
    fidelity: "container",
    baseline: "b",
    result: "success",
    decisions: [],
    egress: [],
    assertions: [],
    outDir: "/tmp",
  });
}
void assemblerSignaturePinsExhaustiveness; // referenced so it's not flagged as an unused function
