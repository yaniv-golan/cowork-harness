import type { PlatformBaseline } from "./types.js";

/**
 * Replicates Cowork's loop-mode decision verbatim (asar 1.12603.1):
 *
 *   function f_(){ return HeA()||iX() ? false                                  // VM-loop
 *                : (isDeveloperApprovedDevUrlOverrideEnabled && CLAUDE_FORCE_HOST_LOOP==="1") ? true  // host-loop
 *                : cPt() }                                                      // gate 1143815894
 *   HeA() = requireCoworkFullVmSandbox === true      // org policy
 *   iX()  = a local Desktop setting with no synced source in this tool's baseline
 *           pipeline — never populated, so not modeled as a `decideLoop` input
 *   cPt() = growthbook gate "1143815894"
 *
 * `true` (host-loop) means the agent loop runs on the host with shell shipped into the
 * VM via mcp__workspace__bash; `false` (VM-loop) means the whole agent runs in the sandbox.
 */
export type Loop = "host" | "vm";

export interface LoopInputs {
  requireFullVmSandbox?: boolean; // HeA — org policy
  devForceHostLoop?: boolean; // dev override (CLAUDE_FORCE_HOST_LOOP=1 + approved)
  gateHostLoopOn?: boolean; // cPt — gate 1143815894 state (synced from fcache)
}

/**
 * Read a GrowthBook gate sub-flag (e.g. `coworkWebFetchPrompt`) from the baseline's
 * provenance.gates. Handles BOTH shapes: the committed prose string ("on(force) coworkWebFetchPrompt=true …")
 * and a decoded structured entry ({on, source, value:{coworkWebFetchPrompt:true}}). CRITICAL: the
 * baseline key is prefixed ("coworkRuntimeConfig:1978029737") — try the prefixed key, then bare id
 * (mirrors decideLoopFromBaseline's `gates["hostLoop:…"] ?? gates["…"]`). A missing gate ⇒ false.
 */
export function readGateFlag(baseline: PlatformBaseline, id: string, flag: string): boolean {
  const gates = (baseline as unknown as { provenance?: { gates?: Record<string, unknown> } }).provenance?.gates ?? {};
  let entry: unknown = gates[id];
  if (entry === undefined) {
    for (const k of Object.keys(gates)) {
      if (k.endsWith(":" + id)) {
        entry = gates[k];
        break;
      }
    }
  }
  if (entry == null) return false;
  if (typeof entry === "string") return new RegExp(`\\b${flag}=true\\b`).test(entry);
  if (typeof entry === "object") {
    const v = (entry as { value?: unknown }).value;
    if (v && typeof v === "object") return (v as Record<string, unknown>)[flag] === true;
    return (entry as Record<string, unknown>)[flag] === true;
  }
  return false;
}

export function decideLoop(inputs: LoopInputs): Loop {
  if (inputs.requireFullVmSandbox === true) return "vm"; // HeA()
  if (inputs.devForceHostLoop === true) return "host"; // dev override
  return inputs.gateHostLoopOn ? "host" : "vm"; // cPt()
}

/** Derive loop inputs from the baseline's synced gate state + env, then decide. */
export function decideLoopFromBaseline(baseline: PlatformBaseline, over: Partial<LoopInputs> = {}): Loop {
  const p = baseline as unknown as {
    provenance?: { gates?: Record<string, unknown> };
    requireFullVmSandbox?: unknown;
  };
  const gates = p.provenance?.gates ?? {};
  const gateRaw = gates["hostLoop:1143815894"] ?? gates["1143815894"];
  // Gate value may be a synced structured entry ({on,source,value}), an authored prose
  // string ("on(force) …"), or absent. Read `.on` for objects (a bare `!!obj` would be true even for
  // an OFF gate); the on/true/force test for strings.
  const gateHostLoopOn =
    gateRaw && typeof gateRaw === "object"
      ? !!(gateRaw as { on?: boolean }).on
      : typeof gateRaw === "string"
        ? /^(?:on|true|force)\b/i.test(gateRaw)
        : !!gateRaw;
  return decideLoop({
    // BUG FIX: a locked-down-org baseline (requireFullVmSandbox:true) must force VM-loop — this was
    // previously ignored, so such a baseline would wrongly run host-loop.
    requireFullVmSandbox: p.requireFullVmSandbox === true,
    gateHostLoopOn,
    devForceHostLoop: process.env.CLAUDE_FORCE_HOST_LOOP === "1",
    ...over,
  });
}
