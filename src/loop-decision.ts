import type { PlatformBaseline } from "./types.js";
import { cmpVersionStrings } from "./baseline.js";

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
 * Read a GrowthBook gate sub-flag (e.g. `coworkWebFetchPrompt`) from the baseline's `provenance.gates`.
 *
 * `productionDefault` is REQUIRED, and it is the whole point of this signature. Production reads these
 * keys through a per-call accessor that supplies its own default — `Ea(id, key, default, …)` — so an
 * unserved key is NOT "off", it is whatever that call site passes. Measured on gate `1978029737`: the
 * code requests 21 keys while the payload serves 8 (one of which, sessionsBridgePollBlockMs, is never
 * requested — so the intersection is 7 and 14 requested keys are unserved), and two of those default to TRUE
 * (`bashHostOnlyIntercept`, `scheduledTaskStaleReapEnabled`). Returning `false` for an absent key, as
 * this function used to unconditionally, is therefore wrong in the silent direction. The argument is
 * required rather than defaulted so a new call site cannot inherit that bug by omission.
 *
 * Three distinct absence cases, which the previous implementation collapsed into one:
 *   1. the gate entry is absent entirely            ⇒ productionDefault
 *   2. the entry is present but `value[flag]` is absent ⇒ productionDefault  (the real per-key case)
 *   3. the entry is a prose string                  ⇒ `flag=true` / `flag=false` if stated, else default
 *
 * Shape note: baselines store this either as a decoded entry (`{on, source, value:{…}}`) or, in early
 * baselines, as a prose string (`"on(force) coworkWebFetchPrompt=true …"`). The key is prefixed
 * (`"coworkRuntimeConfig:1978029737"`), so try the prefixed key then the bare id — mirroring
 * `decideLoopFromBaseline`'s `gates["hostLoop:…"] ?? gates["…"]`.
 */
export function readGateFlag(baseline: PlatformBaseline, id: string, flag: string, productionDefault: boolean): boolean {
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
  if (entry == null) return productionDefault; // case 1
  if (typeof entry === "string") {
    // case 3 — an explicit `flag=false` must beat the default, so it is matched rather than inferred
    // from the absence of `flag=true`.
    if (new RegExp(`\\b${flag}=true\\b`).test(entry)) return true;
    if (new RegExp(`\\b${flag}=false\\b`).test(entry)) return false;
    return productionDefault;
  }
  if (typeof entry === "object") {
    const v = (entry as { value?: unknown }).value;
    const bag = (v && typeof v === "object" ? (v as Record<string, unknown>) : (entry as Record<string, unknown>)) ?? {};
    if (!Object.prototype.hasOwnProperty.call(bag, flag)) return productionDefault; // case 2
    return bag[flag] === true;
  }
  return productionDefault;
}

/**
 * Numeric sibling of `readGateFlag` (e.g. `coworkWebFetchDedupTtlMs`). Same prefixed-then-bare key lookup;
 * reads the number from the structured `value[flag]` (or the bare-entry `[flag]`), else parses `flag=<n>`
 * from the committed prose-string shape. Returns `undefined` when absent — the caller supplies the default
 * (so an older baseline that carries the flag without the numbers still gets the binary default).
 */
export function readGateNumber(baseline: PlatformBaseline, id: string, flag: string): number | undefined {
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
  if (entry == null) return undefined;
  if (typeof entry === "string") {
    const m = new RegExp(`\\b${flag}=(\\d+)\\b`).exec(entry);
    return m ? Number(m[1]) : undefined;
  }
  if (typeof entry === "object") {
    const v = (entry as { value?: unknown }).value;
    const raw = v && typeof v === "object" ? (v as Record<string, unknown>)[flag] : (entry as Record<string, unknown>)[flag];
    return typeof raw === "number" ? raw : undefined;
  }
  return undefined;
}

/**
 * Read a BARE-BOOLEAN gate (e.g. `suggestSkillsEnabled:245679952`, `proactiveSkillSuggestEnabled:1598976391`)
 * — one whose truth lives in the top-level `.on` field, NOT a named sub-flag inside `value` (that's
 * `readGateFlag`'s shape, e.g. `coworkRuntimeConfig`). Same prefixed-then-bare key lookup as
 * `readGateFlag`/`readGateNumber`; mirrors `decideLoopFromBaseline`'s own `.on`-read for
 * `hostLoop:1143815894` (the other bare-boolean gate) rather than reusing `readGateFlag`, which would
 * look for a non-existent sub-flag named after the gate itself and silently return `false` even when the
 * gate is ON. Returns `undefined` when the gate is genuinely absent from the baseline (so the caller's
 * precedence chain — explicit knob ▸ this ▸ documented default — can tell "absent" from "off").
 */
export function readGateBool(baseline: PlatformBaseline, id: string): boolean | undefined {
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
  if (entry == null) return undefined;
  if (typeof entry === "object") {
    // Return `undefined` — NOT `false` — for an object entry that carries no boolean `.on`. A bare
    // `false` here would be indistinguishable from a genuinely-OFF gate and would DEFEAT the caller's
    // documented default (the precedence chain can no longer fall through). No committed baseline uses
    // such a shape today (all 19 are `{on,source,value}`); this guards the next sync-format change.
    const on = (entry as { on?: unknown }).on;
    return typeof on === "boolean" ? on : undefined;
  }
  if (typeof entry === "string") return /^(?:on|true|force)\b/i.test(entry);
  return undefined;
}

/** GrowthBook gate `autoMemoryStandardSessions`: whether Desktop gives an ordinary local task an auto-memory dir. */
export const AUTO_MEMORY_GATE = "123929380";

/** The agent env key Desktop sets to "1" when the session has no auto-memory directory.
 *
 *  On the two tiers that inherit the operator's shell (hostloop, protocol) the builders DELETE the operator's own
 *  export of this key before overlaying `autoMemoryEnv`. That only matters when the recorded gate is ON — when it
 *  is off our "1" overwrites the export anyway — and in that state production sends no such key, and its host-loop
 *  env never inherits the operator's shell either; letting the export through would make hostloop/protocol differ
 *  from container/microvm, the asymmetry SCRUBBED_AGENT_ENV_KEYS closes. It is kept out of that list because the
 *  memory layer owns this key in both states (delete, then set or not), not because of the list's membership rule. */
export const AUTO_MEMORY_ENV_KEY = "CLAUDE_CODE_DISABLE_AUTO_MEMORY";

/**
 * The agent's auto-memory switch, as Desktop sets it for the session this harness models — an ordinary local
 * task, with no `spaceId` and no `sessionType`. Spread by every env builder (`spawnEnv`, `hostNativeSpawnEnv`,
 * `buildProtocolEnv`); the single derivation.
 *
 * Binary-verified (app.asar 2.19675.0, and the same behaviour in every saved asar from 1.18286.2): the spawn
 * resolves `memoryEnabled===!1?null:getAutoMemoryDirForSession(id)`, whose resolver gives a no-`sessionType`
 * session a directory only when `ZW("123929380")` is on, and both loops turn a null directory into
 * `CLAUDE_CODE_DISABLE_AUTO_MEMORY:"1"` (host-loop: the memory-keys ternary's else arm; VM-loop: the
 * `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE||` fallback). The agent reads a truthy value as memory off. `sync` pins
 * that shape (`checkAutoMemoryFacts`) and warns when the gate reads ON (`checkAutoMemoryGate`).
 *
 * - Gate recorded ON → no key: the agent keeps its own default memory. Production would also ship a
 *   Desktop-managed directory, the `CLAUDE_COWORK_MEMORY_*` prompt keys and a memory-tidy skill gated on the
 *   same id; none of that is modeled (docs/fidelity-gaps.md).
 * - No gate row (the baselines before 1.18286.0, which predate the pin) → disabled. Every baseline that records
 *   the gate records it off, and no saved asar older than 1.18286.2 exists, so this is an assumption for those
 *   releases, chosen because it matches the nearest observed one.
 * - ONLY the no-`sessionType` arm. Production returns null for chat / scheduled / dispatch_child sessions
 *   whatever the gate says, so a future model of one of those must not reuse this as is.
 *
 * `readGateBool`, never `readGateFlag`: this is a bare-boolean gate (see readGateBool's doc).
 */
export function autoMemoryEnv(baseline: PlatformBaseline): Record<string, string> {
  return readGateBool(baseline, AUTO_MEMORY_GATE) === true ? {} : { [AUTO_MEMORY_ENV_KEY]: "1" };
}

/**
 * Resolve the two A2 skills/plugins discovery gates to their effective booleans — the SINGLE source of
 * truth for the precedence chain `explicit session knob ▸ readGateBool ▸ documented default`.
 *
 * Extracted because the expression was duplicated verbatim in `run/execute.ts` and `run/chat.ts`, which
 * is this repo's documented multi-assembler drift class. Pure (baseline + plain booleans in, booleans
 * out) so the precedence — and, critically, the `readGateBool`-not-`readGateFlag` choice — is unit-testable
 * without spawning anything. Substituting `readGateFlag` here returns `false` for the ON gate
 * `245679952` and silently strips `suggest_skills` from every cowork-lane run; `test/loop-decision.test.ts`
 * pins that against the live baseline.
 *
 * Defaults when the gate is absent from the baseline: `suggestSkills` → true, `proactiveSuggest` → false
 * (the documented production state).
 *
 * Proactive mode is version-dependent. Up to Desktop 1.44121.1 it is gate `1598976391`. From
 * {@link PROACTIVE_SUGGEST_UNCONDITIONAL_FROM} the gate id is gone from the asar and `suggest_skills` always
 * carries the proactive description and `trigger` param whenever it is declared — so for those baselines
 * the gate row is IGNORED even though the fcache still serves it. Reading it there would let a server-side
 * flip of a gate Desktop no longer reads turn the harness's proactive mode off while production keeps it on.
 * The session knob still wins either way.
 */
export function resolveSkillDiscoveryGates(
  baseline: PlatformBaseline,
  knobs: { suggest_enabled?: boolean; proactive_suggest_enabled?: boolean } = {},
): { suggestSkillsEnabled: boolean; proactiveSkillSuggestEnabled: boolean } {
  return {
    suggestSkillsEnabled: knobs.suggest_enabled ?? readGateBool(baseline, "245679952") ?? true,
    proactiveSkillSuggestEnabled: knobs.proactive_suggest_enabled ?? proactiveFromBaseline(baseline),
  };
}

/** First backed-up Desktop build whose asar has no reference to gate `1598976391` (0 occurrences from
 *  here through 2.7032.0; 2 in 1.44121.1, the previous backup — builds in between are unobserved, and a
 *  baseline for one would take the gate path, the conservative side). From this build proactive suggest
 *  mode is unconditional. */
export const PROACTIVE_SUGGEST_UNCONDITIONAL_FROM = "1.46388.3";

function proactiveFromBaseline(baseline: PlatformBaseline): boolean {
  // `appVersion` is required by the schema, but synthetic test baselines omit it; a missing version
  // compares as 0.0.0 and takes the gate path, which is the pre-1.46388.3 behaviour.
  const v = (baseline as { appVersion?: unknown }).appVersion;
  if (typeof v === "string" && cmpVersionStrings(v, PROACTIVE_SUGGEST_UNCONDITIONAL_FROM) >= 0) return true;
  return readGateBool(baseline, "1598976391") ?? false;
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
