import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import * as acorn from "acorn";
import { BASELINES_DIR, cmpVersionStrings } from "../baseline.js";
import { MODELED_PLACEHOLDER_NAMES, INTENTIONALLY_UNMODELED_PLACEHOLDERS } from "../prompt.js";

/**
 * cowork-sync — derive a VOLATILE parity baseline from the live Claude Desktop
 * install + app.asar. This is the maintenance contract: re-run per release,
 * review the diff, commit. Fields the extractor can't resolve are flagged so
 * parity rot becomes a visible diff, not silent drift.
 *
 * macOS-only today: `sync()` throws a clear error on other platforms. Windows/Linux
 * Desktop paths are TODO branches (needs those install layouts to verify).
 */
const SUPPORT = join(homedir(), "Library/Application Support/Claude");
const ASAR = "/Applications/Claude.app/Contents/Resources/app.asar";

export interface GateState {
  id: string;
  name: string;
  on: boolean;
  source: string; // "force" | "defaultValue" | "experiment" | ...
  value: unknown;
}

export interface SyncResult {
  appVersion: string;
  agentVersion: string;
  allowDomains: string[];
  networkMode: string | null;
  requireFullVmSandbox: unknown;
  asarFingerprint: string;
  gates: Record<string, GateState> | null; // decoded GrowthBook gate states (null = fcache absent/unreadable)
  // Snapshot identity for `gates`, captured from the SAME read. Returned rather than re-derived by the
  // caller: the payload refetches on Desktop's schedule (3.7-20.8 min observed) and asar extraction
  // between the two reads takes tens of seconds, so a second read can label snapshot N's gates with
  // snapshot N+1's identity -- exactly the misattribution this field exists to prevent.
  fcache: FcacheProvenance | null;
  asarGateIds: string[]; // gate ids referenced by THIS release's bundle (see extractAsarGateIds)
  spawnEnv: Record<string, string> | null; // derived spawn.env; null = a hard-fail flag blocked it (carry base env forward)
  spawnEnvKeys: string[]; // WI-6: the sorted SET of constructed spawn-env keys — committed as provenance.spawnEnvKeys (regex-rot oracle)
  spawnEnvSpreadCount: number; // WI-5: count of `...`-spread sites across the spawn windows — committed as provenance.spawnEnvSpreadCount
  // per-model effort/regex-default config (the literal map + the fable|mythos regex-default class); null =
  // a hard-fail flag blocked it (carry the base baseline's spawn.effortByModel/effortRegexDefault forward).
  modelEffortConfig: ModelEffortConfig | null;
  // Cowork system-prompt content fingerprint (H1-H3 prompt-drift guard) — null when the consumption
  // site / constant definition couldn't be found in the asar (itself an unknownDeltas entry).
  promptFingerprint: PromptFingerprint | null;
  /** The release channel Desktop staged the agent from, from the asar's SDK descriptor (see
   *  extractAgentReleaseChannel). null = the descriptor did not match, in which case the official
   *  checksum cross-check is SKIPPED rather than guessed against the stable path. Derived from the
   *  LOCAL asar, so it is available offline — only the checksum fetch needs the network. */
  agentReleaseBaseUrl: string | null;
  unknownDeltas: string[];
  notes: string[]; // non-blocking informational hints (e.g. stale SPAWN_ENV_ALLOWLIST prune NOTEs) — surfaced by the CLI, never a delta
}

/**
 * Behavior-affecting + provenance GrowthBook gates the harness pins (feature id → human name).
 * The ids are the numeric feature keys in the fcache; the names mirror provenance.gates in the baselines.
 */
export const PINNED_GATES: Record<string, string> = {
  "1143815894": "hostLoop", // loop decision (decideLoopFromBaseline)
  // Binary-verified 2026-07-04 (asar 1.18286.0, class L9t "[ScheduledTasks]"): the SCHEDULED-TASK
  // (cron) session limiter (<=1 concurrent session per scheduled task, <=3 concurrent scheduled-task
  // sessions globally), NOT an in-conversation Task-tool dispatch cap. In-conversation Task fan-out is
  // capped SEPARATELY, agent-side (taskRegistry: concurrent 20 / per-session 200, agent >=2.1.212/2.1.217
  // — see SPEC §10), which the harness inherits by spawning the real agent binary. Formerly mislabeled
  // `taskDispatchLimiter` — baselines captured before the rename keep the old label in their
  // provenance.gates as a historical release fact.
  "1648655587": "scheduledTaskSessionLimiter",
  "1978029737": "coworkRuntimeConfig", // web_fetch routing + workspace knobs
  "583857784": "bridgeSdkTransport", // SDK control-protocol transport
  "2340532315": "pluginSyncSparkplug", // startup syncPlugins()
  "2307090146": "cliPlugin", // CLI-plugin credential broker (dark)
  // Dormant drift-sentinels: the harness models these as OFF or inert-default for a
  // standard interactive cowork session; pinned so a production flip surfaces as a sync diff.
  "2614807392": "skeletonHome", // mnt/.host-home discovery index — absent from fcache (dark, default false)
  "123929380": "autoMemoryStandardSessions", // auto-memory dir for a plain (non-Spaces) cowork session (off)
  "1696890383": "memoryGuidelinesEnv", // CLAUDE_COWORK_MEMORY_GUIDELINES env for auto-memory (off)
  "2860753854": "memoryExtraGuidelines", // CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES PII block (on, but inert-default)
  // Sub-agent append server override: gates ONLY whether a server-delivered spSectionPrompts entry
  // replaces the hardcoded subagent_env_hl / subagent_env_vm fallback texts (resolveSection). OFF live
  // (source defaultValue) -> the hardcoded texts are the wire text the committed paraphrase assets
  // model. An ON flip is invisible to the text sentinel (the hardcoded template is unchanged), so
  // checkSubagentOverrideGate emits a non-blocking WARNING on ON (downgraded from a hard delta
  // 2026-08-27): gate-ON only enables the lookup, and the payload that would actually override is
  // delivered per-session by the server — invisible to every input sync reads. A guard that can never
  // clear itself from its own inputs blocks forever rather than tripping. Settled by a live sub-agent
  // probe instead; see the message body.
  "124685897": "subagentPromptServerOverride",
  // Spawn-env conditional gates: each controls a key in the Desktop→agent spawn env
  // (SPAWN_GATES). Pinned so a production flip surfaces BOTH as a provenance.gates diff AND as the
  // corresponding spawn.env value diff (deriveSpawnEnv resolves the pin from the same decoded state).
  "434204418": "mcpConnectionNonblockingOff", // gate on → MCP_CONNECTION_NONBLOCKING:"0" + MCP_CONNECT_TIMEOUT_MS:"10000"
  "66187241": "emitToolUseSummaries", // CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES "true" vs "" (off → "")
  "714014285": "fineGrainedToolStreaming", // CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING:"1" (force-ON live)
  "1936081873": "oauthScopesEnv", // CLAUDE_CODE_OAUTH_SCOPES (value host-derived; allowlisted)
  "4153934152": "skipPrecompactLoad", // CLAUDE_CODE_SKIP_PRECOMPACT_LOAD:"1"
  "1129419822": "enableToolSearchAuto", // ENABLE_TOOL_SEARCH:"auto" — dark (see DARK_GATES)
  // Dormant drift-sentinels (Desktop 1.22209.0): tool-approval auto-mode gates. Neither is behaviorally
  // modeled — this harness has no persistent per-tool "always allow" concept to model against (no
  // updatedPermissions analog anywhere in src/decide/ or src/session.ts). Pinned so a live flip from
  // off to on surfaces as a provenance.gates diff, which is the trigger to revisit modeling this.
  //
  // 4200321681 FIRED at Desktop 1.24012.0 (absent -> on, source=force) and was revisited: still NOT
  // modeled, and deliberately so. Binary-verified in 1.24012.0, both call sites only override an
  // ALREADY-EXISTING always-allow decision — `sessionRuleCacheAllows(tool, session.approvedToolNames)`
  // (source "rule_cache") and `coworkScheduledTasks.shouldAutoApprovePermission` (source
  // "scheduled_task"), each additionally gated on permissionMode + isDestructiveConnectorTool. The
  // harness persists neither, so it already prompts where the gate makes Cowork prompt: ON moves real
  // Cowork TOWARD harness behavior, and modeling it would be modeling the always-allow it overrides.
  // Re-open only if the harness grows a persistent per-tool approval cache.
  "4200321681": "autoModeOverridesAlwaysAllow", // auto mode: force re-prompt (not silent-allow) for destructiveHint MCP tools
  "1447478638": "scheduledTaskToolsApprovableByAutoMode", // auto mode: scheduled-task tools auto-approvable (unless MDM workspace.autoModeEnabled=false)
  // Skill/plugin discovery gates. These govern whether the Desktop SDK-MCP skill-discovery tools
  // (the `mcp__skills__*` / `mcp__plugins__*` servers — the CONFIRMED model surface per the on-disk
  // init.tools of 8 real sessions) render, and in what mode. None was pinned before, so 245679952
  // being live on/force was invisible to the drift guard. Present in the live fcache (NOT dark), so
  // they are read at their real state — no DARK_GATES entry. BEHAVIORALLY MODELED since A2: the harness
  // declares the skills/plugins SDK-MCP servers and reads BOTH gates at spawn
  // (`resolveSkillDiscoveryGates`), so a flip here CHANGES the declared tool set on container/hostloop
  // (see `src/hostloop/skills-handler.ts`) — it is NOT inert. A pinned drift alone WARNS + still writes.
  "245679952": "suggestSkillsEnabled", // live on/force — gates whether suggest_skills renders at all
  // proactive (unprompted) suggest mode. (A prior note speculated this widens at agent >=2.1.217 to gate
  // the whole discovery-tool family; REFUTED — 2.1.205-2.1.217 sessions carry the full skills family with
  // this gate OFF.) It has THREE effects, not two: it swaps suggest_skills's description, adds `trigger`,
  // AND is passed into generateSkillsSystemPrompt, where it swaps the suggest-guidance line inside the
  // dynamically-generated `<skills_instructions>` block (plus a once-per-conversation sentence). A prior
  // version of this comment claimed "only swaps the description and adds `trigger`" — that was wrong about
  // the product. The harness models the first two and renders no `<skills_instructions>` section at all,
  // so the prompt effect is a disclosed gap, not a modelled surface (same shape as canSaveSkill below).
  "1598976391": "proactiveSkillSuggestEnabled",
  // Flipped off/defaultValue -> ON/force server-side (fcache) as of 2026-07-25, i.e. for current users on
  // any Desktop version — NOT a Desktop change; the machinery already shipped in 1.24012.1 gated off. ON
  // adds a `save_skill` tool to the session's SDK-MCP inventory AND is passed into
  // generateSkillsSystemPrompt, so it changes both the tool set and the skills prompt. The harness models
  // NEITHER yet, so this is a known fidelity gap, not a modelled surface.
  "3246569822": "canSaveSkill",
  // off/defaultValue and PRESENT in the fcache (so NOT dark — no DARK_GATES entry) — the `propose_skills`
  // render-only sibling. Pinned so a production flip surfaces as a sync diff instead of silently widening
  // the tool set the way canSaveSkill's did.
  "1824824999": "canProposeSkills",
  // New in Desktop 1.24012.11 (0 occurrences in 1.24012.9's asar, 1 in .11) and DARK — absent from a
  // standard fcache, hence the DARK_GATES entry below; without it the pin would never round-trip through
  // sync and this sentinel would guard nothing. Arms a Desktop-side direct-MCP pool for MDM-managed 1P
  // servers, which short-circuits on an empty managed-server list before the gate is consulted, so it is
  // inert for a standard unmanaged account and outside the harness's modelled agent surface. Pinned on the
  // canProposeSkills principle: a production flip should surface as a sync diff, not silent widening.
  // NAME CAVEAT: unlike every other entry here, this is NOT the GrowthBook flag name — the call site
  // passes the bare id (`const c="4074604942"; isFeatureEnabled(c)`), and the name appears nowhere in the
  // asar, so it is unrecoverable (and the gate is absent from the fcache, which is the other place a name
  // would come from). The value below is the subsystem's own log tag, deliberately kebab-case so it does
  // not read as a verified camelCase flag name. Replace it if the real name ever surfaces in an fcache.
  "4074604942": "1p-direct-mcp",
  // Skill-invocation ARGUMENT-COLLECTION guidance (Desktop >=1.26832.0; on/force for a standard account).
  // When on, the skill-invocation text steers the model to collect missing arguments through the
  // visualize server's elicitation form instead of AskUserQuestion. It is GUIDANCE, not enforcement:
  // measured across real sessions that all received it, production splits roughly evenly between the two
  // channels. The harness never registers the visualize tools, so a run always takes the AskUserQuestion
  // branch — see the "Skill argument collection" section in docs/fidelity-gaps.md. Pinned so an
  // on->off flip (which would make the harness's single branch fully faithful again) is a visible diff.
  // NAME CAVEAT: the call site passes the bare id and the flag name appears nowhere in the asar, so the
  // value below is a kebab-case descriptor, deliberately NOT shaped like a verified camelCase flag name.
  "286376943": "skill-arg-elicitation",
  // AUTO-MODE permission rubric (Desktop >=1.28929.0). LIVE since 1.32352.0: {on:true, source:"force"}.
  // It was pinned as a dormant sentinel precisely so this flip would surface, and it did.
  //
  // Two corrections to what this comment used to say. (1) It called the gate "dark"; off/defaultValue is
  // SERVED-and-off, which a server rule can flip — which is what happened. (2) It said the rubric sits
  // "outside the chat sessions the harness models", implying the harness is spared by session type. It
  // is not: the harness never constructs `settings.autoMode` on ANY tier (grep autoMode in src/ — only
  // gate-name constants; argv passes --permission-mode and --setting-sources, never an autoMode payload),
  // so the rubric is STRUCTURALLY unreachable here rather than excluded. Live effect in production, for
  // non-chat sessions: the PreToolUse hook can answer `deferred_to_classifier` (an empty result)
  // INSTEAD of permissionDecision:"ask", so a tool this harness models as always-gated may raise no
  // prompt there. Documented in docs/fidelity-gaps.md, not modeled.
  // WIDENED at Desktop 1.40609.0: the rule-inclusion predicate dropped its `!hostLoopMode` conjunct
  // (`!isChatSession && !hostLoopMode && gate` -> `{includeRules: !isChatSession && gate, hostLoop}`), so
  // this is no longer VM-loop-only, and `hostLoop` now selects between two Filesystem sections — the VM
  // one, and a new host-loop one describing real host paths for file tools with shell confined to the VM.
  // Sync cannot see any of it: the `settings:` call site is byte-identical and the baseline has no
  // `spawn.settings` key at all. This comment said "VM-loop non-chat" until that release; do not restore it.
  // NAME CAVEAT: same as above — bare id at the call site, no name in the asar; kebab-case descriptor.
  "3424551112": "automode-permission-rubric",
  // Selects which of Cowork's two mutually exclusive artifact mechanisms a session gets. force/on for a
  // standard account, so production currently bind-mounts one host directory per artifact into the VM
  // (host-loop never mounts them — see docs/fidelity-gaps.md). The harness models neither mechanism, and
  // that "currently mounts" fact is the premise of the whole gap write-up — pinned so it stops resting on
  // a live fcache read that the baseline does not record and `check:versions` cannot see. Name VERIFIED
  // (not a descriptor): the asar maps it positionally in a `Promise.all` destructure whose result object
  // is `{…, coworkArtifacts: <the 2940196192 result>, …}`.
  "2940196192": "coworkArtifacts",
  // The Chrome/CIC permission handler's session flag — force/on, and NOT the auto-mode rubric gate
  // (that is 3424551112, above). Pinned alongside it so the pair cannot be confused again: an earlier
  // pass attributed the rubric to this id purely because the rubric arrays sit near its call site.
  // Name VERIFIED: the spawn code assigns this gate's result to `session.cicCanUseToolEnabled`.
  "2051942385": "cicCanUseToolEnabled",
};

/**
 * Gate ids that are DARK for a standard account — absent from the fcache entirely, not merely
 * off. `decodeFcacheGates` normally skips ids missing from `features` (they're not gates it can
 * report a state for); for this allowlist it instead emits an explicit `source:"absent"` marker
 * so the pin round-trips through sync/baseline and an absent→present flip becomes a visible diff.
 * The re-key guard below excludes `source:"absent"` entries from its "did anything match" count,
 * so this marker can't mask a wholesale GrowthBook id re-key (see test/baseline.test.ts).
 */
/* Membership here means "tolerate absence from the fcache", NOT "this gate is permanently absent".
 *
 * "Dark" is a TIMESTAMPED OBSERVATION, never a property. Three states, and the middle one is the trap:
 *   absent                  — not in the payload; genuinely unevaluated
 *   present + defaultValue  — evaluated, no server rule matched (looks like "off", is not "unevaluated")
 *   present + force         — a server rule actively matched
 * Gates move between these on the server's own schedule: three of the five entries below were recorded
 * as absent and are present today. That is why the comments name a DATE for every observation.
 *
 * Entries are never removed on becoming present. Force rules are server-evaluated and can be
 * segment-targeted, so another account may still see a gate absent; dropping its entry would turn that
 * account's sync into a spurious hard-fail. Tolerating absence is the entry's whole job — without it the
 * PINNED_GATES pin never round-trips and the sentinel guards nothing. */
const DARK_GATES = new Set([
  "2614807392",
  "1129419822", // enableToolSearchAuto — a spawn-env gate absent from a standard fcache (dark); pinned so an
  //                absent→present flip on the ENABLE_TOOL_SEARCH conditional surfaces as a visible diff.
  "4200321681", // autoModeOverridesAlwaysAllow — dark at pin time (absent from a standard 1.22209.0 fcache).
  //                Observed 2026-08-05 as PRESENT + `force` + ON. Kept per the rule below.
  "1447478638", // scheduledTaskToolsApprovableByAutoMode — same rationale; observed 2026-08-05 as PRESENT +
  //                `defaultValue` + off.
  "4074604942", // 1p-direct-mcp — new in Desktop 1.24012.11, and dark (absent from a standard fcache) when
  //                pinned. Observed 2026-08-05 as SERVED (`source:"force"`, `value:false`) — still off, so
  //                nothing it arms is reachable. The entry STAYS: force rules are server-evaluated and can
  //                be segment-targeted, so another account may still see it absent, and dropping it would
  //                turn that account's sync into a spurious hard-fail. Tolerating absence is the point —
  //                without it the PINNED_GATES pin never round-trips and the sentinel guards nothing.
]);

/**
 * Decode the Claude Desktop GrowthBook feature cache (`~/Library/Application Support/Claude/fcache`).
 * Binary-verified format (app.asar 1.12603.1): bytes 0..2 = "CLF" magic, byte 3 = version (0x01),
 * bytes 4..7 = a length/checksum field, bytes 8.. = a gzip stream that inflates to JSON
 * `{ timestamp, features: { <id>: { value, on, off, source, ruleId } } }`.
 * Returns the pinned gates' states, or null if the cache is absent/unreadable (caller flags it).
 */
/** Snapshot identity for a decoded fcache payload.
 *
 *  `content16` is the IDENTITY; `embeddedTimestamp` is metadata and must never be used as one. The
 *  payload refetches irregularly (measured intervals of 3.7–20.8 min across five fetches) and its
 *  membership churns COUNT-NEUTRALLY — we observed `4074604942` go absent → force while `2403605075`
 *  went present → absent, with the feature count pinned at 241 both times. A whole-file sha256 tracks
 *  the FETCH (gzip framing + the timestamp field), so it reports drift on every refetch even when
 *  nothing changed; hashing the canonicalised `features` object instead reports drift only when the
 *  content actually moves. Verified across four reads: the content hash held while the file hash moved
 *  every time. */
export type FcacheProvenance = { content16: string; embeddedTimestamp: number | null; featureCount: number };

/** Escape to `\uXXXX` to match Python's default `ensure_ascii=True`, which escapes everything outside
 *  PRINTABLE ascii — so the range starts at DEL (U+007F), not at U+0080. */
function jsonStringAscii(s: string): string {
  return JSON.stringify(s).replace(/[\u007f-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

/** Serialise to `json.dumps(v, sort_keys=True, separators=(',',':'))` form.
 *
 *  Emits directly rather than building a key-sorted clone and calling `JSON.stringify`. That obvious
 *  approach is WRONG here and fails silently: gate ids are integer-like strings, and a JS object always
 *  enumerates integer-like keys in ascending NUMERIC order regardless of insertion order — so
 *  `Object.fromEntries(sortedPairs)` discards the sort and yields `"17519066"` before `"1004628546"`,
 *  where Python's lexicographic `sort_keys` yields the reverse. Self-consistent, and cross-project
 *  incomparable. Serialising the sorted key list directly is the only way to keep both true.
 *
 *  SCOPE OF THE CROSS-LANGUAGE GUARANTEE — read before relying on it. Strings (incl. non-ASCII and
 *  astral pairs), booleans, null, arrays, nested objects and key ordering all agree. **Numbers do not,
 *  in general, and cannot be made to**: JSON has one number type where Python has two, so a payload
 *  written `1.0` reaches Python as float `1.0` (repr `"1.0"`) and JS as `1` (repr `"1"`) — and after
 *  `JSON.parse` nothing remains in JS to tell them apart. Same for exponent formatting (`5e-7` vs
 *  `5e-07`, `1e17` vs `1e+17`) and integers past 2^53, which JS silently rounds. The live payload DOES
 *  carry floats (`364911507.value.*.split` = 0.1/0.5/0.3); those round-trip identically in both, which
 *  is why the implementations agree today — that is a property of the current values, not a guarantee.
 *
 *  So: authoritative for OUR OWN drift detection (self-consistent across syncs, which is what
 *  `provenance.fcache.content16` is for). Cross-implementation comparison is verified only for the value
 *  space the payload currently uses, and must be RE-VERIFIED, never assumed, if a served value lands in
 *  one of the classes above. The agreeing classes are pinned in test/baseline.test.ts. */
function canonicalJson(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") return jsonStringAscii(v);
  if (typeof v === "number") return Number.isFinite(v) ? JSON.stringify(v) : "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).sort(); // lexicographic, matching Python's sort_keys
    return "{" + keys.map((k) => jsonStringAscii(k) + ":" + canonicalJson(o[k])).join(",") + "}";
  }
  return "null";
}

/** sha256 over the canonical form above — 16 hex chars. */
export function fcacheContentHash(features: unknown): string {
  return createHash("sha256").update(canonicalJson(features), "utf8").digest("hex").slice(0, 16);
}

/** Decode the fcache payload's snapshot identity. Same read + shape checks as `decodeFcacheGates`. */
export function decodeFcacheProvenance(path = join(SUPPORT, "fcache")): FcacheProvenance | null {
  if (!existsSync(path)) return null;
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch {
    return null;
  }
  if (buf.length < 9 || buf.subarray(0, 3).toString("latin1") !== "CLF") return null;
  try {
    const parsed = JSON.parse(gunzipSync(buf.subarray(8)).toString("utf8")) as {
      timestamp?: unknown;
      features?: Record<string, unknown>;
    };
    const features = parsed?.features ?? {};
    return {
      content16: fcacheContentHash(features),
      embeddedTimestamp: typeof parsed?.timestamp === "number" ? parsed.timestamp : null,
      featureCount: Object.keys(features).length,
    };
  } catch {
    return null;
  }
}

/** Gate ids referenced as string literals by a release's own bundle, sorted numerically.
 *
 *  WHY THIS EXISTS. `provenance.fcache` records `{content16, embeddedTimestamp, featureCount}` — two
 *  aggregates and a timestamp, never MEMBERSHIP. So `featureCount: 271 → 278` says seven arrived and
 *  nothing says which, a count-NEUTRAL swap is invisible (observed: one gate absent→force while another
 *  went present→absent, count pinned at 241), and `content16`'s own diff line has to say "membership
 *  and/or values moved". Worse, the fcache is server-refreshed on its own schedule (3.7–20.8 min
 *  observed), so a count delta between two baselines is a net over DAYS of rollout, not a fact about the
 *  Desktop release — and the previous payload is overwritten in place, so the question is unanswerable
 *  the moment you think to ask it.
 *
 *  This field answers a different, ANSWERABLE question: which gate ids does *this build's binary*
 *  reference? That is a pure function of the shipped asar, so unlike an fcache-derived set it is
 *  reproducible by anyone, stable across refetches, and attributable to the release. Its diff between two
 *  baselines is directly readable (measured 1.32885.1 → 1.34493.1: **+14 / -1**).
 *
 *  DELIBERATELY NOT INTERSECTED WITH THE LIVE FCACHE. That would silently make the committed list
 *  account-shaped: gate membership varies by segment (see `4074604942`, recorded in the baselines as
 *  absent from a standard fcache, later served, and "another account may still see it absent"). Filtering
 *  through this machine would both leak which gates this operator is served and drop DARK gates —
 *  measured, 51 of the ids here are absent from the live fcache, including `1129419822`
 *  (`enableToolSearchAuto`), which is dark by design.
 *
 *  THE FILTER IS THE ID SPACE, NOT A GUESS: every one of the 278 live fcache ids is 8-10 digits with no
 *  leading zero and below 2^32 (min 17519066, max 4293378213). Quoting matters too — gate ids are passed
 *  as STRING literals: over the same require-graph input this reads, scanning BARE numbers instead yields
 *  1953 numeric tokens (1680 after the same id-space filter) of which only **8** are live gate ids. Some numeric noise still survives; that is fine and deliberate,
 *  because a constant is invisible in the DELTA, which is what this field is read for. */
export function extractAsarGateIds(files: Map<string, string>): string[] {
  const re = /["'`](\d{5,13})["'`]/g;
  // SECOND SHAPE (added 2026-08-29): the gate-DEFAULTS map keys its entries on BARE numerics —
  // `{…,748063099:bw,3586389629:tvt(6e4),3927880029:Sw({value:3}),…}` — so a quoted-literal-only scan
  // misses every gate that is only ever defaulted and never read through a quoted id. That is not
  // hypothetical: it under-reported 1.30096.1's new gates 3 -> 1, and — because it was recorded as a
  // maintainer note rather than as a test — recurred unchanged at 1.40609.0 (+27 extracted vs +30 real).
  //
  // This is NOT the bare-number scan the header rejects. That one matches ANY bare numeric and adds 1687
  // ids over this bundle. This one requires the defaults-map ENTRY shape — `<id>:<identifier>` immediately
  // after a `{` or `,` — and adds 39, of which 38 match `<id>:<ctor>` with only three distinct constructor
  // tokens (`xw` 30, `Sw` 7, `tvt` 1); the 39th (`748063099:bw`) is the same shape and is missed by a
  // verification regex only because an adjacent entry consumed its leading comma. A tight, structurally
  // coherent population, 43x less noisy than the rejected form.
  //
  // The lookbehind (rather than consuming `[{,]`) is load-bearing: entries are adjacent, so a
  // delimiter-consuming match eats the comma the NEXT entry needs and silently drops every other one.
  const bareKeyRe = /(?<=[{,])(\d{5,13}):(?=[A-Za-z_$])/g;
  const out = new Set<string>();
  for (const text of files.values())
    for (const m of [...text.matchAll(re), ...text.matchAll(bareKeyRe)]) {
      const id = m[1];
      // `length > 10` is REDUNDANT and deliberately kept: any 11+ digit run is >= 1e10 > 2^32, so the
      // range check already rejects it. Mutation-verified — relaxing it to `> 11` changes nothing, on
      // synthetic input or on the real bundle (208 -> 208). It stays because the pair states the id space
      // (8-10 digits, below 2^32) in the shape the fcache actually exhibits. Do not read its
      // untestability as a dead guard and do not "fix" it with a case that cannot discriminate.
      if (id.startsWith("0") || id.length < 8 || id.length > 10 || Number(id) >= 2 ** 32) continue;
      out.add(id);
    }
  // Numeric sort: these are ids, and a lexical sort would order "9..." before "10...". Sorting also keeps
  // the committed array diffable line-by-line rather than re-ordering on every extraction.
  return [...out].sort((a, b) => Number(a) - Number(b));
}

/** The agent release channel Desktop staged from, read out of the asar's SDK descriptor. */
export interface AgentReleaseChannel {
  /** `https://downloads.claude.ai/claude-code-releases`, or `…/claude-code-releases/rc/<40-hex commit>`. */
  baseUrl: string;
  /** The descriptor's own pinned SDK version. NOT necessarily the STAGED agent version — see
   *  checkAgentReleaseChannel: Desktop pins the next SDK before it stages it, measured twice. */
  sdkVersion: string;
}

/** Matches BOTH channel shapes and nothing else. The `/rc/<sha>` group is optional because a stable
 *  build's base is the same URL without it — RC is not a special case bolted on, it is one more segment. */
const RELEASE_BASE_URL_RE = /^https:\/\/downloads\.claude\.ai\/claude-code-releases(?:\/rc\/[0-9a-f]{40})?$/;

/**
 * Extract the agent release channel from the asar's SDK descriptor — the `JSON.parse(...)` blob shaped
 * `{"version":"2.1.255","manifest":{…},"baseUrl":"…","sdkWrapperVersion":"…"}`.
 *
 * WHY THIS EXISTS: `fetchOfficialElfChecksum` used to hard-code the STABLE versioned path. Desktop also
 * stages release CANDIDATES, served only from `…/claude-code-releases/rc/<commit>/`, and there is no way
 * to discover that commit from the network — probed: `rc`, `rc/latest`, `rc/<short-sha>` and
 * `rc/<sha>/manifest.json` all 404, and the `stable`/`latest` pointers name neither staged version. The
 * asar is the ONLY source. Measured across all 24 backed-up asars: 21 stable, 3 RC (1.24012.9,
 * 1.24012.11, 1.40609.1) — RC staging is routine, not a one-off.
 *
 * Two shape hazards this deliberately handles, both measured over that same population:
 *
 *  - THE DELIMITER IS NOT STABLE. `JSON.parse('…')` in 12 of 24 asars (through 1.24012.11) and
 *    `` JSON.parse(`…`) `` in the other 12 (1.25927.0 onward — the same codegen flip that voided 22
 *    literal anchors in this file at once). A backtick-only matcher is blind to half the population.
 *    Note the normalizing tokenizer leaves this blob alone either way: it contains embedded `"`.
 *  - THE TOP-LEVEL `baseUrl` IS NOT THE FIRST ONE. On RC builds the nested `manifest.baseUrl` PRECEDES
 *    it, so a `"baseUrl":"([^"]+)"` first-match reads the wrong key. They agree on both observed RC
 *    builds, which is exactly why this is latent rather than broken — parse the JSON and read the
 *    top-level field rather than regexing for the name.
 *
 * (`…/claude-ssh-releases` is a DIFFERENT descriptor in every asar, and a first-match never reaches it —
 * measured 0 of 24. It is wrong in principle, not in observation; the two hazards above are the real ones.)
 *
 * Returns null on any miss — no stable-path fallback. Falling back here is precisely what turned a
 * silent rot into a silent `"unknown"`, which is the defect this closes.
 */
export function extractAgentReleaseChannel(bundle: string): AgentReleaseChannel | null {
  // Anchor on the descriptor's opening shape, then scan to the matching delimiter honouring backslash
  // escapes, rather than a lazy `.*?` to the next quote — a JSON value containing the delimiter would
  // truncate the blob and fail the parse for a reason that looks like a shape change.
  const open = /JSON\.parse\((["'`])(?=\{"version":"\d+\.\d+\.\d+","manifest":\{)/g;
  const found = new Map<string, AgentReleaseChannel>();
  for (let m = open.exec(bundle); m !== null; m = open.exec(bundle)) {
    const delim = m[1];
    const start = m.index + m[0].length;
    let i = start;
    for (; i < bundle.length; i++) {
      if (bundle[i] === "\\") i++;
      else if (bundle[i] === delim) break;
    }
    if (i >= bundle.length) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(bundle.slice(start, i));
    } catch {
      continue;
    }
    const d = parsed as { version?: unknown; baseUrl?: unknown; manifest?: { version?: unknown } };
    // Self-consistency: the descriptor's own two version fields must agree (24/24 do). This is the
    // check that the blob is what we think it is — NOT a check against the staged agent version, which
    // legitimately differs and is handled in checkAgentReleaseChannel.
    if (typeof d.version !== "string" || typeof d.baseUrl !== "string") continue;
    if (typeof d.manifest?.version !== "string" || d.manifest.version !== d.version) continue;
    if (!RELEASE_BASE_URL_RE.test(d.baseUrl)) continue;
    found.set(`${d.version}|${d.baseUrl}`, { baseUrl: d.baseUrl, sdkVersion: d.version });
  }
  // Exactly one DISTINCT descriptor, asserted rather than assumed: `asarGateIds` twice under-reported by
  // silently taking a subset of a population it believed was whole. Picking one of several here would
  // pin provenance to whichever the bundle happened to order first.
  if (found.size !== 1) return null;
  return [...found.values()][0];
}

/**
 * Operator-facing checks on the extracted channel. Returns NOTE-class strings ONLY — never an unknown
 * delta, so this can never block a baseline write.
 *
 * WHY NOT A HARD DELTA: `manifestChecksumMatch` has no runtime consumer; it is read by a human during a
 * parity pass. Every existing unknownDeltas member makes the baseline wrong for RUNNING the agent. And
 * the anchor above sits on shifting ground (the delimiter has already flipped once), so a blocking
 * literal anchor is a release-day wedge — the same argument that demoted checkSubagentOverrideGate on
 * 2026-08-27: a guard that cannot clear itself from its own inputs is a permanent block, not a tripwire.
 *
 * A version disagreement is BENIGN on a stable base and load-bearing on an RC one. Measured: Desktop
 * pins the NEXT SDK in the asar while still staging the previous one (1.20186.0 staged 2.1.202 with the
 * descriptor reading 2.1.205; 1.20186.9 staged 2.1.205 reading 2.1.209) — 2 of the 21 asars that have a
 * committed baseline. Both were stable, so `<base>/<stagedVersion>/manifest.json` still resolved and the
 * recorded `manifestChecksumMatch:true` is correct. On an RC base the commit IS the version's identity,
 * so the same disagreement means the composed URL will 404 — worth saying out loud, still not a refusal.
 */
export function checkAgentReleaseChannel(channel: AgentReleaseChannel | null, agentVersion: string): string[] {
  if (!channel)
    return [
      "agentBinary.releaseBaseUrl: the asar's SDK release-channel descriptor did not match (shape moved, or more than one distinct descriptor). " +
        'The official-checksum cross-check is SKIPPED and manifestChecksumMatch records "unknown" — deliberately, rather than guessing the stable path, ' +
        'which is how an RC-staged agent silently recorded "unknown" before. Re-anchor extractAgentReleaseChannel (maintainer).',
    ];
  if (channel.sdkVersion === agentVersion) return [];
  const isRc = channel.baseUrl.includes("/rc/");
  if (!isRc)
    return [
      `agentBinary.releaseBaseUrl: the asar pins SDK ${channel.sdkVersion} while ${agentVersion} is staged. ` +
        `Benign on the stable channel — Desktop pins the next SDK before staging it (measured at 1.20186.0 and 1.20186.9) — ` +
        `and the checksum cross-check still resolves against the STAGED version.`,
    ];
  return [
    `agentBinary.releaseBaseUrl: WARNING — the asar pins SDK ${channel.sdkVersion} on a RELEASE-CANDIDATE channel while ${agentVersion} is staged. ` +
      `On an RC channel the commit is the version's identity, so ${channel.baseUrl}/${agentVersion}/manifest.json is likely to 404 ` +
      `and manifestChecksumMatch will record "unknown". Verify by hand before trusting this baseline's provenance.`,
  ];
}

export function decodeFcacheGates(path = join(SUPPORT, "fcache")): Record<string, GateState> | null {
  if (!existsSync(path)) return null;
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch {
    return null;
  }
  // Require the CLF magic + at least the 8-byte header before the gzip stream.
  if (buf.length < 9 || buf.subarray(0, 3).toString("latin1") !== "CLF") return null;
  let parsed: { features?: Record<string, { on?: boolean; source?: string; value?: unknown }> };
  try {
    parsed = JSON.parse(gunzipSync(buf.subarray(8)).toString("utf8"));
  } catch {
    return null;
  }
  const feats = parsed?.features ?? {};
  const out: Record<string, GateState> = {};
  for (const [id, name] of Object.entries(PINNED_GATES)) {
    const f = feats[id];
    if (!f) {
      // Dark gates are pinned even when absent (see DARK_GATES doc comment); everything else
      // absent from this fcache is skipped, same as always.
      if (DARK_GATES.has(id)) out[id] = { id, name, on: false, source: "absent", value: undefined };
      continue;
    }
    out[id] = { id, name, on: !!f.on, source: String(f.source ?? "defaultValue"), value: f.value };
  }
  return out;
}

/** Gate 124685897 ON = a server-delivered subagent-append override is active; the harness has no
 *  captured override text, so proceeding would emit the committed fallback assets as if verified.
 *  Hard-stop via unknownDeltas (a PINNED_GATES drift alone only WARNS and still writes the baseline). */
export function checkSubagentOverrideGate(gates: Record<string, GateState> | null): string[] {
  if (!gates?.["124685897"]?.on) return [];
  return [
    "gate subagentPromptServerOverride:124685897 reads ON — the sub-agent append MAY be server-overridden " +
      "and this sync CANNOT TELL from its own inputs. Gate-ON only enables the lookup: the asar reads the " +
      "section entry and, when it is missing or empty, logs `using hardcoded fallback` and returns the " +
      "built-in text anyway. The entry is delivered PER SESSION by the server — it is in neither the asar, " +
      "the fcache nor config.json — so gate state alone cannot separate 'override active' from 'gate on, " +
      "no payload, fallback still correct'. " +
      "This gate is SERVER-SIDE and Desktop-version-INDEPENDENT (it flipped off->on via " +
      '`source:"defaultValue"` with the asar byte-identical, 1.37937.1 -> .3) — do NOT go looking for a ' +
      "Desktop change. " +
      "WARNING, not a refusal: probed live 2026-08-27 on desktop-local Cowork (agent 2.1.246, hl branch, " +
      "no folder connected). A real sub-agent's environment section matched the committed asset on all " +
      "four load-bearing claims — host cwd, mcp__workspace__bash in an isolated Linux env, folders under " +
      "<vmCwd>/mnt/, and shell starting in <vmCwd> with non-mnt writes reaching neither the user nor the " +
      "file tools — so NO override was reaching that account and the committed paraphrase is faithful. " +
      "That is EVIDENCE, NOT PROOF: one account, one session, and a server rule can be segment-targeted. " +
      "If the sub-agent append matters to what you are about to ship, re-probe (dispatch a sub-agent, ask " +
      "for its environment section verbatim, diff the four claims) rather than trusting this note.",
  ];
}

/** Read `network.allowDomains` from the NEWEST committed baseline — the pinned, hand-curated egress
 *  allowlist that `sync` carries forward instead of re-deriving (see `checkEgressContractFacts`).
 *
 *  Every failure path returns `[]` and records an unknown delta, so a missing/corrupt/malformed prior
 *  baseline surfaces as a refusal to write rather than a silently emptied allowlist. */
export function readPinnedAllowDomains(unknown: string[], dir = BASELINES_DIR): string[] {
  let newest: { version: string; file: string } | null = null;
  try {
    for (const f of readdirSync(dir)) {
      if (!f.startsWith("desktop-") || !f.endsWith(".json")) continue;
      const version = f.slice("desktop-".length, -".json".length);
      if (!newest || cmpVersionStrings(version, newest.version) > 0) newest = { version, file: f };
    }
  } catch {
    flag(unknown, `egress.allowDomains: baselines directory ${dir} is unreadable — cannot carry the pinned allowlist forward`);
    return [];
  }
  if (!newest) {
    flag(unknown, `egress.allowDomains: no committed desktop-*.json in ${dir} to carry the pinned allowlist forward from`);
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(dir, newest.file), "utf8"));
  } catch (e) {
    flag(
      unknown,
      `egress.allowDomains: ${newest.file} is unreadable/unparseable (${(e as Error).message}) — cannot carry the pinned allowlist forward`,
    );
    return [];
  }
  const domains = (parsed as { network?: { allowDomains?: unknown } } | null)?.network?.allowDomains;
  if (!Array.isArray(domains) || !domains.every((d) => typeof d === "string")) {
    flag(unknown, `egress.allowDomains: ${newest.file} has no usable network.allowDomains[] to carry forward`);
    return [];
  }
  return domains as string[];
}

export function sync(): SyncResult {
  // defensive platform guard. The paths above (SUPPORT/ASAR/Info.plist) are macOS-only; on
  // Windows/Linux they don't exist, so the extractor would return EMPTY version/allowlist/gate fields
  // and (without the write guards) could persist a garbage baseline. Fail LOUD instead of
  // silently returning a hollow result. Full Windows/Linux support needs those Desktop install layouts
  // (a separate, non-binary task — see webfetch/maintenance docs).
  if (process.platform !== "darwin") {
    throw new Error(
      `cowork-sync is currently macOS-only (detected platform "${process.platform}"). ` +
        `It reads the Claude Desktop install at ${ASAR} and ${SUPPORT}, whose Windows/Linux layouts are not yet implemented. ` +
        `Run sync on macOS, or commit a baseline produced there.`,
    );
  }

  const unknown: string[] = [];

  // 1. Agent version (the single most important pin).
  const agentVersion = readIf(join(SUPPORT, "claude-code-vm/.sdk-version"))?.trim() ?? flag(unknown, "agentVersion");

  // 2. App version.
  const appVersion = readDesktopAppVersion() ?? flag(unknown, "appVersion");

  // 3. Cowork settings from config.json. — distinguish a MISSING config (allowed: a fresh install
  // simply has no user overrides) from a CORRUPT/unreadable one (records an unknown delta so the emptied
  // allowlist is a visible "sync incomplete" signal, not silent drift).
  const config = readConfigJson(join(SUPPORT, "config.json"), unknown);
  const networkMode = (config["coworkNetworkMode"] as string) ?? null;
  const requireFullVmSandbox = config["lastSeenRequireCoworkFullVmSandbox"] ?? null;
  const userAllow = parseEgressAllowedHosts(config["coworkEgressAllowedHosts"], unknown);

  // 4. GrowthBook gate states, decoded from the live fcache (no longer a manual step). Decoded BEFORE the
  // asar step so the spawn-env generator can resolve gate-conditional pins against the ACTUAL gate state
  // — a production flip then shows up coherently as both a provenance.gates diff and the
  // corresponding spawn.env value diff.
  const gates = decodeFcacheGates();
  const fcacheProv = decodeFcacheProvenance();

  // 5. Spawn contract + fingerprints from the asar. The egress allowlist is NOT among them: on the
  // first-party deployment the harness models, the VM allowlist is server-delivered per session and
  // absent from the asar (checkEgressContractFacts, run inside extractFromAsar, guards that fact and
  // hard-fails if it stops holding).
  const {
    fingerprint,
    asarGateIds,
    spawnEnv,
    spawnEnvKeys,
    spawnEnvSpreadCount,
    modelEffortConfig,
    promptFingerprint,
    agentReleaseChannel,
    notes,
  } = extractFromAsar(unknown, gates);

  // network.allowDomains is a PINNED, hand-curated list carried forward from the newest committed
  // baseline — never re-derived from the bundle. See checkEgressContractFacts for why deriving it is
  // unsound in both directions. The operator's own coworkEgressAllowedHosts are still merged, matching
  // the previous behaviour. A missing/unreadable prior baseline yields an empty list, which the CLI
  // then refuses to write (fail closed) rather than silently shipping a default-deny allowlist.
  const priorAllow = readPinnedAllowDomains(unknown);
  const allowDomains = dedupe([...priorAllow, ...userAllow]);

  if (!gates) {
    flag(unknown, "gates: fcache missing/unreadable — provenance.gates NOT re-synced");
  } else if (Object.values(gates).filter((g) => g.source !== "absent").length === 0) {
    // DARK_GATES markers (source:"absent") are always present and must not mask a real re-key —
    // only count gates that actually matched a live fcache feature.
    flag(
      unknown,
      "gates: fcache decoded but NONE of the pinned gate IDs matched — gate IDs may have been re-keyed; update PINNED_GATES in cowork-sync.ts",
    );
  }

  // WARNING, not a hard delta — downgraded 2026-08-27 on MEASURED evidence, see checkSubagentOverrideGate.
  // It blocked the write while being unable to distinguish the two states it names; a guard that can
  // never clear itself from its own inputs is a permanent block, not a tripwire.
  notes.push(...checkSubagentOverrideGate(gates));
  // NOTE-class only, never a delta — see checkAgentReleaseChannel for why this must not block a write.
  notes.push(...checkAgentReleaseChannel(agentReleaseChannel, agentVersion));

  return {
    appVersion,
    agentVersion,
    allowDomains,
    networkMode,
    requireFullVmSandbox,
    asarFingerprint: fingerprint,
    gates,
    fcache: fcacheProv,
    asarGateIds,
    spawnEnv,
    spawnEnvKeys,
    spawnEnvSpreadCount,
    modelEffortConfig,
    promptFingerprint,
    agentReleaseBaseUrl: agentReleaseChannel?.baseUrl ?? null,
    unknownDeltas: unknown,
    notes,
  };
}

// Some Vite/electron-builder releases emit `.vite/build/index.js` as a small entry stub that
// `require()`s the real code from a content-hashed sibling chunk (e.g. `index.chunk-XXXX.js`)
// instead of one monolithic file. Follow local relative requires transitively (BFS, deduped) so
// every fact-checker below sees the real bundle content regardless of which layout Desktop ships —
// a stub-only read would silently report every anchor as missing, not that the contract changed.
/** Rewrite substitution-free template literals to the double-quoted form.
 *
 *  Desktop 1.25927.0 changed minifier codegen: plain string literals are now emitted with BACKTICKS
 *  (``settingSources:[`user`]``) where every earlier build emitted double quotes. Measured on the
 *  1.24012.11 → 1.25927.0 pair, double-quoted identifier-ish strings fell 83.5k → 13.3k while backtick
 *  ones rose 847 → 71.1k. That is a codegen change, not a product change, but it silently voids EVERY
 *  literal anchor in this file at once (22 of them fired on the first 1.25927.0 sync).
 *
 *  Normalizing once here — rather than making ~40 anchor regexes quote-agnostic — keeps each anchor
 *  readable and keeps `resolveConst`/value extraction emitting the quoting the baselines already store.
 *
 *  This is a TOKENIZER, deliberately not a regex: a naive ``/`([^`]*)`/g`` mis-pairs the CLOSING
 *  backtick of an interpolated template with the OPENING backtick of the next string, which corrupts
 *  the text and produced a false "settingSources is gone" on the very first attempt. Strings, comments
 *  and regex literals are copied through verbatim; a template is rewritten ONLY when it has no `${}`
 *  substitution, no raw newline and no embedded `"` — anything else is passed through unchanged, so
 *  real templates (including every prompt body the fingerprints hash) keep their exact text. */
/** Chars after which a `/` starts a REGEX literal rather than a division operator. */
const REGEX_OK = new Set("(,=:[!&|?{};+-*%~^<>".split(""));

/** Keywords after which a `/` starts a REGEX, not division. The leading `[^\w$.]` alternative is what
 *  keeps `remain/512` (division) from matching the `in` keyword, and `a.in/2` from matching at all. */
const REGEX_KEYWORD = /(?:^|[^\w$.])(return|typeof|case|in|of|new|delete|void|throw|do|else|yield|await|instanceof)$/;

/** True when the `/` at `at` starts a regex literal. `prev` is the last significant char.
 *
 *  D2 (Desktop 1.32352.0): REGEX_OK is punctuation-only, so a regex in a KEYWORD context
 *  (`return/…/`, `typeof/…/`, `case/…/`) was read as division — and a quote inside it then opened a
 *  phantom string. Live trigger: `return/unable to access '[^']*':.*operation not permitted/i`. The
 *  keyword scan is bounded (a keyword is at most 10 chars) so this stays O(1) per candidate. */
function regexCanStart(src: string, at: number, prev: string): boolean {
  if (prev === "" || REGEX_OK.has(prev)) return true;
  let j = at - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  return REGEX_KEYWORD.test(src.slice(Math.max(0, j - 11), j + 1));
}

/** Offset just past the regex literal starting at `at` (its closing `/` plus flags). If the literal
 *  never closes on this line it is not a regex — return `at + 1` so the caller advances by one char. */
function skipRegex(src: string, at: number): number {
  const n = src.length;
  let j = at + 1;
  let inClass = false;
  while (j < n) {
    const c = src[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "\n") return at + 1;
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) {
      j++;
      while (j < n && /[a-z]/.test(src[j])) j++; // flags
      return j;
    }
    j++;
  }
  return at + 1;
}

/** True when the backtick at `at` opens a TAGGED template (`` tag`…` ``) rather than a plain one.
 *
 *  D3 (Desktop 1.32352.0): rewriting a substitution-free TAGGED quasi into a string is a SEMANTIC
 *  change — the tag function stops being called — and leaves text a parser rejects. Live in the asar
 *  as ``(0,t._)`{}`` and ``String.raw`https://…``. A template is tagged when the previous significant
 *  token ENDS an expression: `)`, `]`, or an identifier that is not one of the keywords a plain
 *  template may legally follow (``return`ok` `` is NOT tagged). Ambiguity resolves toward "tagged",
 *  which merely leaves the literal un-normalized; the other direction re-introduces the defect. */
function isTaggedTemplate(src: string, at: number): boolean {
  let j = at - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  if (j < 0) return false;
  const c = src[j];
  if (c === ")" || c === "]") return true;
  if (!/[\w$]/.test(c)) return false;
  return !REGEX_KEYWORD.test(src.slice(Math.max(0, j - 11), j + 1));
}

export function normalizeBundleQuotes(src: string): string {
  const n = src.length;
  const parts: string[] = [];
  let mark = 0; // start of the pending verbatim run
  let i = 0;
  let prev = ""; // last significant char — disambiguates a regex literal from division

  const skipQuoted = (start: number): number => {
    const q = src[start];
    let j = start + 1;
    while (j < n) {
      const c = src[j];
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (c === q || c === "\n") return c === q ? j + 1 : j;
      j++;
    }
    return n;
  };
  // Returns the template's end offset plus the [start,end) span of every `${…}` EXPRESSION body, so an
  // interpolated template can be re-emitted with its expressions normalized while its literal text stays
  // byte-identical. Without recursing into the expressions, a plain string nested inside an
  // interpolation (``lam_session_type:${i.sessionType??`chat`}``) keeps its backticks and the value
  // deriver reports it as an unrecognized expression.
  const readTemplate = (start: number): [number, Array<[number, number]>] => {
    let j = start + 1;
    const subs: Array<[number, number]> = [];
    while (j < n) {
      const c = src[j];
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (c === "`") return [j + 1, subs];
      if (c === "$" && src[j + 1] === "{") {
        let depth = 1;
        j += 2;
        const exprStart = j;
        // D1 (Desktop 1.32352.0): an interpolation is CODE, so it can contain a REGEX literal — and a
        // quote inside one (`t.replace(/'/g, …)`, the POSIX shell-quote escaper) opened a phantom
        // string here, flipping quote parity for every literal after it in the chunk. Track the
        // previous significant char so a regex can be told from division, exactly as the outer loop
        // does. Verified against a parser oracle: without this, 7 chunks of the live asar normalize
        // into text that no longer parses.
        let pe = "";
        while (j < n && depth > 0) {
          const d = src[j];
          if (d === "\\") ((j += 2), (pe = "\\"));
          else if (d === "{") (depth++, j++, (pe = "{"));
          else if (d === "}") (depth--, j++, (pe = "}"));
          else if (d === '"' || d === "'") ((j = skipQuoted(j)), (pe = src[j - 1]));
          else if (d === "`") ((j = readTemplate(j)[0]), (pe = "`"));
          else if (d === "/" && regexCanStart(src, j, pe)) ((j = skipRegex(src, j)), (pe = "/"));
          else {
            if (!/\s/.test(d)) pe = d;
            j++;
          }
        }
        subs.push([exprStart, depth === 0 ? j - 1 : j]);
        continue;
      }
      j++;
    }
    return [n, subs];
  };

  while (i < n) {
    const c = src[i];
    if (c === '"' || c === "'") {
      i = skipQuoted(i);
      prev = src[i - 1];
      continue;
    }
    if (c === "`") {
      const [end, subs] = readTemplate(i);
      const body = src.slice(i + 1, end - 1);
      if (subs.length === 0) {
        if (!body.includes("\n") && !body.includes('"') && !isTaggedTemplate(src, i)) {
          parts.push(src.slice(mark, i), '"', body, '"');
          mark = end;
        }
      } else {
        // Keep the template intact; normalize only inside each `${…}`.
        parts.push(src.slice(mark, i));
        let at = i;
        for (const [s, e] of subs) {
          parts.push(src.slice(at, s), normalizeBundleQuotes(src.slice(s, e)));
          at = e;
        }
        parts.push(src.slice(at, end));
        mark = end;
      }
      prev = "`";
      i = end;
      continue;
    }
    if (c === "/" && (src[i + 1] === "/" || src[i + 1] === "*")) {
      const isLine = src[i + 1] === "/";
      const at = isLine ? src.indexOf("\n", i) : src.indexOf("*/", i + 2);
      i = at === -1 ? n : isLine ? at : at + 2;
      continue;
    }
    if (c === "/" && regexCanStart(src, i, prev)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const d = src[j];
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (d === "\n") break;
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) {
          closed = true;
          j++;
          break;
        }
        j++;
      }
      if (closed) {
        while (j < n && /[a-z]/.test(src[j])) j++; // flags
        prev = "/";
        i = j;
        continue;
      }
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  parts.push(src.slice(mark));
  return parts.join("");
}

export function readMainBundleFilesRaw(dir: string): Map<string, string> {
  const entryPath = join(dir, ".vite/build/index.js");
  const visited = new Set<string>();
  const queue = [entryPath];
  const out = new Map<string, string>();
  // The require specifier itself may be backtick-quoted in newer codegen — match all three forms on the
  // RAW text, since the graph walk has to happen before normalization.
  const localRequireRe = /require\(["'`]\.\/([^"'`]+)["'`]\)/g;
  while (queue.length > 0) {
    const p = queue.shift() as string;
    if (visited.has(p) || !existsSync(p)) continue;
    visited.add(p);
    const content = readFileSync(p, "utf8");
    out.set(p.slice(p.lastIndexOf("/") + 1), content);
    for (const m of content.matchAll(localRequireRe)) {
      queue.push(join(dirname(p), m[1]));
    }
  }
  return out;
}
export function readMainBundleFiles(dir: string): Map<string, string> {
  return new Map([...readMainBundleFilesRaw(dir)].map(([name, raw]) => [name, normalizeBundleQuotes(raw)]));
}

/** Tripwire: `normalizeBundleQuotes` must never leave a chunk that a parser rejects.
 *
 *  Every anchor in this file is written against normalized text, so a tokenizer desync does not fail
 *  loudly — it makes anchors read as "gone" and can rewrite stretches of code into string literals.
 *  Desktop 1.32352.0 produced 32 unknown deltas that way, 21 of them phantom, while also MASKING four
 *  real ones. `sync --diff` is the first command the per-release runbook runs, so the signal belongs
 *  here and not only in the (install-dependent, CI-skipped) test oracle.
 *
 *  FAIL-SOFT BY CONSTRUCTION: a chunk is only reported when the RAW text parses and the normalized text
 *  does not. A future Desktop shipping syntax this acorn does not know then reads as "not our damage"
 *  and stays silent, instead of blocking every sync for an unrelated reason. */
export function checkNormalizationSanity(raw: Map<string, string>, normalized: Map<string, string>): string[] {
  const flags: string[] = [];
  const parses = (src: string): boolean => {
    try {
      acorn.parse(src, { ecmaVersion: "latest" });
      return true;
    } catch {
      return false;
    }
  };
  for (const [name, before] of raw) {
    const after = normalized.get(name);
    if (after === undefined || after === before) continue; // nothing was rewritten — nothing to verify
    if (parses(after) || !parses(before)) continue;
    flags.push(
      `tokenizer: normalizeBundleQuotes left ${name} unparseable (the RAW chunk parses) — the quote scanner ` +
        `desynchronised, so EVERY anchor over this chunk is unreliable: absent anchors may be phantom AND real ` +
        `deltas may be masked. Fix the tokenizer before classifying any delta below`,
    );
  }
  return flags;
}

export function readMainBundle(dir: string): string {
  return [...readMainBundleFiles(dir).values()].join("");
}

/** Resolve the LOCAL identifier a chunk binds to an exported name, across every export shape seen so far.
 *
 *  Shape order matters: the mangled CJS-interop form is checked first because Desktop 1.25927.0 emits it
 *  in 274 of 341 chunks, while the readable arrow form survives in 27. The bare `name:local` /
 *  `name=local` legacy form is checked LAST and constrained to an identifier, so a `:0`-style decoy in an
 *  unrelated object literal cannot be captured ahead of a real export. */
export function exportLocalOf(text: string, exportName: string): string | null {
  const esc = exportName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const shapes = [
    // Object.defineProperty(exports,"vt",{enumerable:!0,get:function(){return B}})
    new RegExp(`defineProperty\\(exports,"${esc}",\\{[^}]*?return ([A-Za-z_$][\\w$]*)\\}`),
    // HOST_LOOP_PATH_GATED_BUILTIN_TOOLS:()=>Se
    new RegExp(`(?<![\\w$])${esc}:\\(\\)=>([A-Za-z_$][\\w$]*)`),
    // <local> as HOST_LOOP_PATH_GATED_BUILTIN_TOOLS
    new RegExp(`([A-Za-z_$][\\w$]*)\\s+as\\s+${esc}(?![\\w$])`),
    // TASK_TOOL_NAMES:uae / TASK_TOOL_NAMES=uae
    new RegExp(`(?<![\\w$])${esc}[:=]([A-Za-z_$][\\w$]*)(?![\\w$])`),
  ];
  for (const re of shapes) {
    const m = text.match(re);
    if (m) return m[1];
  }
  return null;
}

/** Follow a `NS.exported` reference to the chunk + local that actually defines it.
 *
 *  Desktop 1.25927.0 both MANGLED export names (`...o.TASK_TOOL_NAMES` became `...E.vt`) and split the
 *  bundle 101 → 341 chunks, so the previous "regex-hop on the joined bundle" strategy became
 *  catastrophically ambiguous: hopping on a two-character name like `f` or `vt` matches somewhere random
 *  in 11 MB of text. That mis-resolution is not a safe failure — it reported `CLAUDE_DESIGN_TOOLS is no
 *  longer empty` and `maxThinkingTokens resolved to null`, both of which are FALSE (verified by hand
 *  against the asar: the array is still `[]` and the constant is still 31999).
 *
 *  So resolution is scoped: from the chunk holding the REFERENCE, follow that chunk's own
 *  `NS=require("./chunk-X.js")` binding, then read the export map of the chunk it names.
 *  `files` absent (or the ref undotted) ⇒ single-text mode, which is what the synthetic fixtures and the
 *  older monolithic builds need. Returns null rather than guessing — callers flag that loudly. */
export function resolveNamespaceRef(ref: string, siteChunk: string, files?: Map<string, string>): { chunk: string; local: string } | null {
  if (!ref.includes(".")) return { chunk: siteChunk, local: ref };
  const prop = ref.slice(ref.lastIndexOf(".") + 1);
  const ns = ref.slice(0, ref.indexOf("."));
  if (files) {
    const reqM = siteChunk.match(new RegExp(`(?<![\\w$])${ns}=require\\("\\./([^"]+)"\\)`));
    const target = reqM ? files.get(reqM[1].slice(reqM[1].lastIndexOf("/") + 1)) : undefined;
    if (target) {
      const local = exportLocalOf(target, prop);
      return local ? { chunk: target, local } : null;
    }
  }
  const local = exportLocalOf(siteChunk, prop);
  return local ? { chunk: siteChunk, local } : null;
}

/** Return the `{...}` body that follows `header` in `text`, brace-balanced, or null.
 *
 *  Exists because a WINDOWED match ("is the literal within N chars of the function header") is a guard
 *  that cannot fail: around the real HIPAA reader, `coworkHipaaRestricted` occurs 8x within +/-600 chars
 *  and several of those neighbours are themselves exported, so a window admits pointing the trailing
 *  conjunct at the raw gate reader (restriction removed) while still "matching". Scanning the actual
 *  body is what makes the assertion mean what it says.
 *
 *  Deliberately brace-only: the bodies this is used on are minified single-statement readers with no
 *  string/regex literal containing an unbalanced brace. It is NOT a general JS scanner. */
export function braceBodyOf(text: string, header: string): string | null {
  const at = text.indexOf(header);
  if (at < 0) return null;
  const open = text.indexOf("{", at + header.length - 1);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

/** The canUseTool install, decomposed: the saved-original identifier and the chain's TOP-LEVEL operands.
 *
 *  Why a scanner and not a regex. The previous anchor was
 *  `canUseTool=async\(…\)=>X\(…\)\?\?Y\(…\)\?\?Z\(` — a PREFIX match with no terminator, so it accepted
 *  any chain that merely STARTED with three calls. Executed against Desktop 1.30096.1's real four-link
 *  chain it passed when the `await` was removed and failed only because of the `await`; i.e. the block
 *  that surfaced this release was luck, and a synchronous inserted link would have been absorbed silently.
 *
 *  Splitting on top-level `??` is not regex-expressible here: the assignment ends at a paren that must be
 *  balanced, and `??` genuinely occurs inside a template interpolation in the real chain's own log line
 *  (`…reason: ${r??`none`}`) — normalizeBundleQuotes deliberately passes interpolated templates through
 *  unchanged, so that `??` reaches this code.
 *
 *  Handles nesting of ()[]{} , '' , "" and backtick templates including `${}` recursion. It does NOT
 *  track regex literals: the chain body is a sequence of calls, and a body that ever contains one would
 *  mis-split into operands that fail the assertions below — loudly, never silently. */
/** Index just past a string/template literal starting at `i`, or -1 if `i` does not open one. */
function skipLiteralAt(text: string, i: number): number {
  const c = text[i];
  if (c === "'" || c === '"') {
    let j = i + 1;
    while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
    return j + 1;
  }
  if (c !== "`") return -1;
  let j = i + 1;
  let tdepth = 0;
  while (j < text.length) {
    if (text[j] === "\\") {
      j += 2;
      continue;
    }
    if (tdepth === 0 && text[j] === "`") break;
    if (text[j] === "$" && text[j + 1] === "{") {
      tdepth++;
      j += 2;
      continue;
    }
    if (tdepth > 0 && text[j] === "}") tdepth--;
    j++;
  }
  return j + 1;
}

/** Index of the `}` closing the block that opens at `open`, or -1 if unbalanced. */
function matchBrace(text: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const lit = skipLiteralAt(text, i);
    if (lit >= 0) {
      i = lit;
      continue;
    }
    const c = text[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/** Split a `a??b??c` expression on its TOP-LEVEL `??` operators. */
function splitNullish(expr: string): string[] {
  const ops: string[] = [];
  let depth = 0;
  let mark = 0;
  let i = 0;
  while (i < expr.length) {
    const lit = skipLiteralAt(expr, i);
    if (lit >= 0) {
      i = lit;
      continue;
    }
    const c = expr[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0 && c === "?" && expr[i + 1] === "?") {
      ops.push(expr.slice(mark, i).trim());
      i += 2;
      mark = i;
      continue;
    }
    i++;
  }
  ops.push(expr.slice(mark).trim());
  return ops;
}

/** The `??`-chain expression bound to a local inside a block body, or null. */
function nullishChainInBlock(block: string): string | null {
  const decl = /(?:const|let|var) [\w$]+=/g;
  for (const m of block.matchAll(decl)) {
    const from = m.index! + m[0].length;
    let depth = 0;
    let i = from;
    while (i < block.length) {
      const lit = skipLiteralAt(block, i);
      if (lit >= 0) {
        i = lit;
        continue;
      }
      const c = block[i];
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth--;
      else if (depth === 0 && c === ";") break;
      i++;
    }
    const expr = block.slice(from, i);
    if (splitNullish(expr).length > 1) return expr;
  }
  return null;
}

/** Extract the installed `canUseTool` chain.
 *
 *  D6 (Desktop 1.32352.0): the arrow gained a BLOCK body — the `??` chain is now one statement inside it,
 *  wrapped by a pre-pass that can deny before any link and a post-pass that can overturn the chain's
 *  ALLOW. The previous scanner split on `??` at the paren depth of `\1&&(`, so a block body came back as
 *  ONE operand ("the chain has 1 links"). Both shapes are handled; `block` is non-null only for the block
 *  form, and the caller MUST assert the wrapper facts on it — teaching the extractor the shape without
 *  that would silence three flags and leave two new decision points invisible. */
export function extractCanUseToolChain(text: string): { orig: string; operands: string[]; block: string | null } | null {
  // `\1` binds the guard to the SAVED ORIGINAL: `let K=e.canUseTool;K&&(e.canUseTool=async(…)=>`.
  // Without the backreference, `let K=e.canUseTool;zz&&(…)` reads as guarded while being unconditional.
  const m = text.match(/(?:const|let|var) ([\w$]+)=([\w$]+)\.canUseTool;\1&&\(\2\.canUseTool=async\([^)]*\)=>/);
  if (!m || m.index === undefined) return null;
  const start = m.index + m[0].length;

  if (text[start] === "{") {
    const close = matchBrace(text, start);
    if (close < 0) return null; // unbalanced — fail loud rather than guess
    const block = text.slice(start + 1, close);
    const expr = nullishChainInBlock(block);
    if (!expr) return null;
    return { orig: m[1], operands: splitNullish(expr), block };
  }

  // Expression body: the chain runs to the `)` that closes `\1&&(`.
  let depth = 1;
  let i = start;
  while (i < text.length) {
    const lit = skipLiteralAt(text, i);
    if (lit >= 0) {
      i = lit;
      continue;
    }
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return { orig: m[1], operands: splitNullish(text.slice(start, i)), block: null };
    }
    i++;
  }
  return null; // unbalanced — fail loud rather than guess
}

/** Extract fingerprint + spawn.env + model-effort-config from the asar main bundle without
 *  keeping it unpacked.
 *
 *  NOTE: this deliberately does NOT derive the egress allowlist. The 1p allowlist is server-delivered
 *  and absent from the asar — see `checkEgressContractFacts`, which guards the pinned list instead. */
function extractFromAsar(
  unknown: string[],
  gates: Record<string, GateState> | null,
): {
  fingerprint: string;
  asarGateIds: string[];
  spawnEnv: Record<string, string> | null;
  spawnEnvKeys: string[];
  spawnEnvSpreadCount: number;
  modelEffortConfig: ModelEffortConfig | null;
  promptFingerprint: PromptFingerprint | null;
  agentReleaseChannel: AgentReleaseChannel | null;
  notes: string[];
} {
  if (!existsSync(ASAR)) {
    flag(unknown, `asar not found at ${ASAR} — install/open Claude Desktop once, or fix ASAR in cowork-sync.ts`);
    return {
      fingerprint: "",
      asarGateIds: [],
      spawnEnv: null,
      spawnEnvKeys: [],
      spawnEnvSpreadCount: 0,
      modelEffortConfig: null,
      promptFingerprint: null,
      agentReleaseChannel: null,
      notes: [],
    };
  }
  const tmp = mkdtempSync(join(tmpdir(), "cowork-sync-"));
  try {
    execFileSync("npx", ["--yes", "@electron/asar", "extract", ASAR, tmp], { stdio: "ignore" });
    const rawFiles = readMainBundleFilesRaw(tmp);
    const bundleFiles = new Map([...rawFiles].map(([name, raw]) => [name, normalizeBundleQuotes(raw)]));
    const bundle = [...bundleFiles.values()].join("");
    // FIRST: everything below reads normalized text, so a desync here invalidates all of it.
    for (const f of checkNormalizationSanity(rawFiles, bundleFiles)) flag(unknown, f);
    // Egress: the allowlist is NOT derived here. On 1p it is server-delivered and absent from the
    // asar, so `network.allowDomains` is a pinned, hand-curated list carried forward by sync(). These
    // checks fail CLOSED if the construction that justifies pinning moves.
    for (const f of checkEgressContractFacts(bundle)) flag(unknown, f);
    // drift guard: mountLayout modes are hand-authored (not synced) — verify the binary-verified
    // mode FACTS still hold so a policy change is a loud flag, not silent baseline rot.
    for (const f of checkMountModeFacts(bundle)) flag(unknown, f);
    for (const f of checkWebFetchFacts(bundle)) flag(unknown, f);
    for (const f of checkPathHookFacts(bundleFiles)) flag(unknown, f);
    for (const f of checkSyspromptMapFacts(bundleFiles)) flag(unknown, f);
    // Code-shape tripwires (getMcpSkillSources caller, MCP-skills cap) — deltas hard-fail, NOTEs inform.
    const { deltas: tripwireDeltas, notes: tripwireNotes } = partitionSpawnFlags(checkCodeTripwires(bundle));
    for (const f of tripwireDeltas) flag(unknown, f);
    // Spawn contract: S-tier structural sentinels + the generated spawn.env. Non-NOTE flags
    // become unknown deltas (hard-fail); NOTEs (stale-allowlist prune hints) are collected into
    // `notes` and printed by the sync CLI as informational lines — never a delta, never write-blocking.
    for (const f of checkSpawnContractFacts(bundle, bundleFiles)) flag(unknown, f);
    const subagentFps = readSubagentFingerprints();
    for (const f of checkSubagentPromptFacts(bundleFiles, subagentFps)) flag(unknown, f);
    const spawn = deriveSpawnEnv(bundle, gates, bundleFiles);
    const { deltas: spawnDeltas, notes } = partitionSpawnFlags(spawn.flags);
    for (const f of spawnDeltas) flag(unknown, f);
    // Per-model effort/regex-default config: same all-or-nothing contract as spawn.env — any anchor
    // miss hard-fails (config:null) rather than reaching the baseline as a silent partial map.
    const { config: modelEffortConfig, flags: modelEffortFlags } = extractModelEffortConfig(bundle);
    for (const f of modelEffortFlags) flag(unknown, f);
    // Fingerprint over the cowork-relevant slices for "unknown delta" detection.
    const slice = sliceCowork(bundle);
    const fingerprint = createHash("sha256").update(slice).digest("hex").slice(0, 16);
    // H1-H3 prompt-drift guard: extract the raw system-prompt content fingerprint and diff it against
    // the committed baselines/prompts/cowork-system-prompt-fingerprints.json (sha drift = hard-fail,
    // placeholder/section inventory diff = informational, unmodeled placeholder = hard-fail).
    // A zero-id extraction on an otherwise-successful read means the literal shape moved, not that the
    // release dropped every gate. Flag it: without this the write below silently CARRIES FORWARD the
    // previous release's list under the new appVersion — a fabricated fact attributed to the wrong
    // release, which is worse than a blank because nothing in the artifact reveals it. Matches the
    // empty-`allowDomains` precedent, which refuses rather than inherits.
    const gateIds = extractAsarGateIds(bundleFiles);
    if (gateIds.length === 0)
      flag(
        unknown,
        "provenance.asarGateIds: the gate-id literal scan matched nothing — the asar's literal shape moved, so a membership diff would be blind. Fix extractAsarGateIds (maintainer), or the written baseline will inherit the PREVIOUS release's ids under this appVersion",
      );
    const promptFingerprint = extractPromptFingerprint(bundle);
    const fingerprintsFile = readPromptFingerprintsFile();
    const promptDrift = checkPromptDrift(
      promptFingerprint,
      fingerprintsFile,
      MODELED_PLACEHOLDER_NAMES,
      INTENTIONALLY_UNMODELED_PLACEHOLDERS,
    );
    for (const d of promptDrift.unknownDeltas) flag(unknown, d);
    return {
      fingerprint,
      asarGateIds: gateIds,
      spawnEnv: spawn.env,
      spawnEnvKeys: spawn.keys,
      spawnEnvSpreadCount: spawn.spreadCount,
      modelEffortConfig,
      promptFingerprint,
      agentReleaseChannel: extractAgentReleaseChannel(bundle),
      notes: [...notes, ...promptDrift.notes, ...tripwireNotes],
    };
  } catch (e) {
    flag(unknown, `asar extract failed (npx @electron/asar): ${(e as Error).message} — check network/npx, or unpack ${ASAR} manually`);
    return {
      fingerprint: "",
      asarGateIds: [],
      spawnEnv: null,
      spawnEnvKeys: [],
      spawnEnvSpreadCount: 0,
      modelEffortConfig: null,
      promptFingerprint: null,
      agentReleaseChannel: null,
      notes: [],
    };
  } finally {
    // mkdtempSync extraction dir is otherwise leaked under $TMPDIR on every invocation.
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * drift guard. The baseline's `mountLayout.mounts[].mode` is HAND-AUTHORED — `sync` does not
 * extract mountLayout — so a Cowork mount-policy change would silently rot the baseline. This verifies
 * the binary-verified mode FACTS still hold in the asar; any miss is flagged loudly (re-derive by hand,
 * see the baselines' `$comment_modes`). Pure over the bundle string → token-free unit-testable.
 *
 * Facts (app.asar 1.12603.1): uploads is mounted read-only (`mode:"ro"`); outputs + projects default to
 * `"rw"` (delete DENIED) via the `IX` resolver, whose delete-approved branch is `…?"rwd":"rw"`.
 */
/**
 * Code-shape tripwires: string-occurrence counts over the asar bundle that watch a feature whose
 * runtime STATE the sync cannot otherwise see (no gate id, no spawn-env key). Returns flags in the
 * `partitionSpawnFlags` convention — a `NOTE:`-prefixed flag is informational (surfaced in
 * SyncResult.notes, never write-blocking); a bare flag is a hard-fail unknown delta.
 *
 * getMcpSkillSources: on 1.24012.x it appears exactly ONCE — its own
 * definition, with ZERO callers, so MCP-contributed skills are dead scaffolding. A caller appearing
 * (count > 1) means that channel went live: MCP servers could now contribute skills, which breaks the
 * harness's "skills come from local dirs/plugins" assumption. That is the sharp signal to watch —
 * strictly better than pinning the dark gate 278625510, which is meaningless while there are no
 * callers — so a count > 1 is a HARD delta. Count 0 = the scaffolding was removed; a prune NOTE.
 * io.modelcontextprotocol/skills (the capability-key declaration, currently 1x) is a secondary,
 * informational signal: any change from 1 is a NOTE to re-verify whether MCP servers now contribute
 * skills, since the authoritative "it went live" signal is the getMcpSkillSources caller above.
 */
export function checkCodeTripwires(bundle: string): string[] {
  const flags: string[] = [];
  const count = (needle: string): number => bundle.split(needle).length - 1;

  // Distinguish the DEFINITION from callers so `count` isn't read blindly: the baseline is "1 = the
  // definition, 0 callers". defPresent guards two edges (D3): (a) count 1 but NOT the definition = a
  // caller with the def moved out of the scanned require() graph — NOT "clean"; (b) count 0 might be a
  // dynamic-import() move, not a removal, so the prune NOTE must say so rather than coach a deletion.
  const gmss = count("getMcpSkillSources");
  const defPresent = /getMcpSkillSources\(\)\{/.test(bundle);
  if (gmss > 1)
    flags.push(
      `code tripwire: getMcpSkillSources now appears ${gmss}x (was 1 = definition-only) — a CALLER appeared, so MCP servers may now contribute skills (dead scaffolding is now wired). Re-verify whether MCP servers can now contribute skills and whether the harness must model MCP-contributed skill sources; ${SPAWN_NO_BYPASS}`,
    );
  else if (gmss === 1 && !defPresent)
    flags.push(
      "NOTE: code tripwire: getMcpSkillSources appears once but its definition (`getMcpSkillSources(){`) is not in the require() graph — likely a caller remaining while the definition moved to a dynamically-imported chunk; verify against ALL .vite/build chunks before trusting the count (checkCodeTripwires in cowork-sync.ts)",
    );
  else if (gmss === 0)
    flags.push(
      "NOTE: code tripwire: getMcpSkillSources not found in the require() graph — it was REMOVED, or moved out of the scanned graph (a dynamic import()); confirm against ALL .vite/build chunks before pruning this tripwire (checkCodeTripwires in cowork-sync.ts)",
    );

  const skillsExt = count("io.modelcontextprotocol/skills");
  if (skillsExt !== 1)
    flags.push(
      `NOTE: code tripwire: io.modelcontextprotocol/skills capability appears ${skillsExt}x (was 1) — the MCP-skills capability surface changed; re-verify whether MCP servers can now contribute skills`,
    );

  return flags;
}

/** Sites building the delete-deny resolver on the newest baseline (Desktop 1.37937.1): the VM-loop
 *  mount-set builder and host-loop `computeBashMounts`. A FLOOR, not an equality — see its use site. */
const MOUNT_DELETE_DENY_MIN_SITES = 2;

export function checkMountModeFacts(bundle: string): string[] {
  const flags: string[] = [];
  // The delete-deny resolver. A bare `.test()` was the same single-anchor hole the per-mount checks below
  // just closed: the resolver is now built on BOTH lanes (1 site in Desktop 1.34493.1, 2 from 1.37937.0),
  // so once one lane has it, `.test()` cannot see the other lane losing it. Guard a FLOOR rather than an
  // exact count — a lane gaining the resolver is benign and must not red a sync, a lane losing it is the
  // containment change. The floor is the count observed on the newest baseline; raise it deliberately
  // when a release adds a lane. Running `sync` against a Desktop OLDER than the floor's release will
  // flag, which is correct: that install does not build what the pinned baseline describes.
  const denySites = (bundle.match(/\?"rwd":"rw"/g) ?? []).length;
  if (denySites < MOUNT_DELETE_DENY_MIN_SITES)
    flags.push(
      `mountLayout: the delete-deny resolver (IX \`…?"rwd":"rw"\`) is built at ${denySites} site(s), below the pinned floor of ` +
        `${MOUNT_DELETE_DENY_MIN_SITES} — an execution lane lost delete-deny resolution, so outputs/projects default mode may have ` +
        "changed on that lane; re-derive mountLayout.mounts[].mode per lane (see baselines $comment_modes)",
    );
  // Every mount whose mode is HARDCODED at the mount-set builder, rather than resolved through
  // NOTE the lane difference, because "spawn-time" is wrong for half of it: the VM-loop builder runs
  // once at spawn, but the host-loop one is wired as `computeBashMounts` and RECOMPUTES PER BASH CALL
  // with a live approved-list read. The hardcoded modes below are identical either way, which is why
  // one set of anchors covers both — but a reader reasoning about WHEN a mode is decided needs this.
  // the delete-deny resolver above. Read first-party from the builder, which assembles the whole set:
  // outputs and each connected folder go through the resolver (`rw`, or `rwd` once approved) while these
  // are pinned `"ro"`. Worth pinning individually because a mount silently moving from `ro` to a
  // writable mode is a containment change we would otherwise model wrongly with nothing failing.
  //
  // EVERY SITE must carry the mode, not merely one of them. Each of these names is built at TWO sites —
  // the VM-loop mount-set builder and host-loop `computeBashMounts` — and an `re.test(bundle)` is
  // satisfied by either, so a one-lane `ro`→`rw` flip (a real containment change on exactly one
  // execution tier) passed green. Comparing the site count to the with-mode count closes that: the
  // `site` pattern locates the mount irrespective of its mode, `ro` requires the mode too.
  const hardcodedRo: [string, RegExp, RegExp][] = [
    ["uploads", /\("uploads"\)\]/g, /\("uploads"\)\][^}]{0,90}mode:\s*"ro"/g],
    [".claude/skills", /\("\.claude\/skills"\)\]/g, /\("\.claude\/skills"\)\][^}]{0,120}mode:\s*"ro"/g],
    [".claude/projects", /\("\.claude\/projects"\)\]/g, /\("\.claude\/projects"\)\][^}]{0,120}mode:\s*"ro"/g],
    // Project ATTACHMENTS (`userSelectedProjectUuids`) — one mount per uuid, read-only. This is the fact
    // that settles whether a project mount belongs in the delete-denied set: it does not, because it is
    // not writable at all.
    [".projects/<uuid>", /\(`\.projects\/\$\{[^}]+\}`\)\]/g, /\(`\.projects\/\$\{[^}]+\}`\)\][^}]{0,90}mode:\s*"ro"/g],
  ];
  for (const [name, siteRe, roRe] of hardcodedRo) {
    const sites = (bundle.match(siteRe) ?? []).length;
    const ro = (bundle.match(roRe) ?? []).length;
    if (sites === 0)
      flags.push(
        `mountLayout: the read-only ("ro") mount for ${name} is gone from the asar — its mode may have changed; re-derive mountLayout.mounts[].mode (see baselines $comment_modes)`,
      );
    else if (ro !== sites)
      flags.push(
        `mountLayout: ${name} is built at ${sites} site(s) but only ${ro} carry mode:"ro" — one execution lane's mount became writable; ` +
          `re-derive mountLayout.mounts[].mode per lane (see baselines $comment_modes)`,
      );
  }
  return flags;
}

/**
 * Drift guard for the web_fetch model the harness ports (two-path G1t/U1t, app.asar 1.12603.1). The
 * load-bearing facts are hand-derived (not extracted), so flag loudly if the asar's web_fetch primitives
 * vanish — a sign Cowork's web_fetch mechanism changed and the harness port needs re-verification.
 */
export function checkWebFetchFacts(bundle: string): string[] {
  const flags: string[] = [];
  const facts: [string, RegExp][] = [
    ["the per-domain approval (buildRequestWebFetchApproval)", /buildRequestWebFetchApproval/],
    ["the provenance URL set (getWebFetchAllowedUrls)", /getWebFetchAllowedUrls/],
    ["the coworkWebFetchViaApi / coworkWebFetchPrompt gates", /coworkWebFetchViaApi[\s\S]{0,200}coworkWebFetchPrompt/],
  ];
  for (const [what, re] of facts)
    if (!re.test(bundle))
      flags.push(
        `web_fetch: ${what} is gone from the asar — Cowork's web_fetch mechanism may have changed; re-verify the two-path port (see webfetch-high-fidelity-plan)`,
      );
  return flags;
}

/**
 * Egress-contract drift guard — the sentinel that replaced the old bundle-wide domain sweep.
 *
 * WHY `network.allowDomains` IS PINNED, NOT DERIVED. On the FIRST-PARTY deployment the harness
 * models, the VM egress allowlist is **not in the asar at all**. Binary-verified (1.34493.1):
 *
 *   1p class:  vmEgressPolicy(){return null}
 *   3p class:  vmEgressPolicy(){let e=<cfg>().workspace.allowedEgressHosts??[]; …
 *                                  domains:[...this.provider.vmAllowedDomains(),...e]}
 *   resolver:  async resolveVmAllowedDomains(e,n){let r=<dm>().vmEgressPolicy(),
 *                                                     i=r?<toDomains>(r):e; return <otlp>(i,n)}
 *
 * So on 1p the resolver falls through to `e` — the session's SERVER-DELIVERED
 * `options.egressAllowedDomains` — and the only asar contribution is the OTLP endpoint host appended
 * by the augmenter. There is nothing authoritative to extract.
 *
 * The predecessor derived the allowlist by regexing every `*.anthropic.com` / `*.claude.ai` literal
 * out of the whole bundle. That is unsound in BOTH directions: it cannot see a server-delivered host,
 * and it sweeps in hosts that are not egress at all. It shipped a false positive at 1.34493.1, when a
 * new Desktop webview first-party-origin classifier (`www.claude.ai`, `staging.claude.ai` — a
 * navigation-trust tier, not egress) would have WIDENED the enforced allowlist. `allowDomains` is
 * consumed as the real allowlist by `boundaryAllowList` and the session egress plan, so a spurious
 * entry is a false-green: the harness would permit egress Cowork denies.
 *
 * The list is therefore carried forward as a curated pin (it had been stable for 8+ releases anyway),
 * and THESE checks are what make that pin safe: they fail CLOSED if the construction that justifies
 * pinning moves. A flag here means "re-derive how Cowork computes egress before trusting the pin".
 */
export function checkEgressContractFacts(bundle: string): string[] {
  const flags: string[] = [];
  const miss = (what: string, why: string) =>
    flags.push(
      `egress: ${what} — ${why}. network.allowDomains is a PINNED, hand-curated list that is only sound while this holds; re-verify how Cowork computes the VM allowlist (see checkEgressContractFacts).`,
    );

  // E1 — the first-party deployment contributes NO allowlist from the asar. If this branch stops
  // returning null, 1p egress may have become asar-derivable (or moved to the 3p shape), which would
  // change what the pin is standing in for.
  if (!/vmEgressPolicy\(\)\s*\{\s*return null\s*\}/.test(bundle))
    miss("the 1p `vmEgressPolicy(){return null}` branch is gone", "first-party egress may no longer be server-delivered");

  // E2 — the resolver's fall-through is the load-bearing fact: when the deployment policy is falsy
  // (i.e. 1p), the allowlist is the CALLER-SUPPLIED argument (the server-delivered session list).
  // Backreferences bind the ternary to the same identifiers, so a reordered/rewritten resolver cannot
  // satisfy this by accident. Callee slots admit `$` (minifiers emit `$`-initial names — 1.32885.1 S14b).
  const resolver =
    /resolveVmAllowedDomains\(\s*([\w$]+)\s*,\s*([\w$]+)\s*\)\s*\{\s*let\s+([\w$]+)\s*=\s*[\w$.]+\(\)\s*\.vmEgressPolicy\(\)\s*,\s*([\w$]+)\s*=\s*\3\s*\?\s*[\w$.]+\(\s*\3\s*\)\s*:\s*\1\s*;\s*return\s+[\w$.]+\(\s*\4\s*,\s*\2\s*\)\s*\}/;
  if (!resolver.test(bundle))
    miss(
      "`resolveVmAllowedDomains` no longer falls through to its first argument when the deployment policy is null",
      "the 1p allowlist may no longer be the server-delivered session list",
    );

  // E3 — the augmenter appends the OTLP endpoint host and NOTHING else, and short-circuits when the
  // list is already unrestricted. A second append here would be an asar-side allowlist contribution
  // the pin does not model.
  const otlpAppend =
    /\(\s*!\s*([\w$]+)\s*\?\.endpoint\s*\|\|\s*!\s*([\w$]+)\s*\|\|\s*\2\s*\.includes\(\s*"\*"\s*\)\s*\)\s*return\s+\2\s*;[\s\S]{0,320}?\[\s*\.\.\.\s*\2\s*,\s*([\w$]+)\s*\]/;
  if (!otlpAppend.test(bundle))
    miss(
      "the OTLP-endpoint augmenter no longer appends exactly one host onto an unmodified allowlist",
      "the asar may now contribute egress hosts the pinned list does not model",
    );

  return flags;
}

/** Path-gate sentinel (1.20186.1 shapes). Module-bounded: anchors run against the CORRECT chunk only
 *  — the DEFINING chunk (found by the HOST_LOOP_PATH_GATED_BUILTIN_TOOLS export) for set contents, the
 *  CONSUMING chunk (found by the matcher install site) for the hook body, deny texts, topology,
 *  ordering, and the canUseTool chain. Each tool-set array is bound to its EXPORT NAME (not "some
 *  matching array exists"), and the install site must reference the same export property. */
/** Drift sentinel for `coworkSyspromptMap` — a SERVER-DRIVEN system-prompt patch channel the harness
 *  models nowhere.
 *
 *  Why it is a sentinel and not a model: the map's entries come from the server, per session, so we
 *  cannot know what any given session is served. What we CAN pin is its shape, and the shape is what
 *  makes it dangerous — `replace` mode DISCARDS the computed default section and emits
 *  `[text, ...appends].join("\n\n")`. The harness models the system prompt as an append onto the
 *  `claude_code` preset, so an active `replace` variant is a STRUCTURAL divergence: we would retain a
 *  section production dropped entirely. If the mode vocabulary widens (a third mode), or the key grammar
 *  moves, or the boundary invariant disappears, that changes what the channel can do to the prompt and
 *  we need to know before a user hits it.
 *
 *  Present in 1.24012.1, 1.24012.11 and 1.25927.0 alike — long-standing, not new. */
export function checkSyspromptMapFacts(files: Map<string, string>): string[] {
  const flags: string[] = [];
  const bundle = [...files.values()].join("");
  const miss = (what: string, why: string) =>
    flags.push(`syspromptMap: ${what} anchor missing — ${why}; re-derive checkSyspromptMapFacts in cowork-sync.ts`);

  if (!/coworkSyspromptMap/.test(bundle)) {
    // Absence is itself a finding: either the channel was removed (good for us, but a modeled fact
    // changed) or the extractor stopped seeing it. Either way, do not silently pass.
    miss("channel", "coworkSyspromptMap is gone from the asar — the prompt-patch channel changed shape or was removed");
    return flags;
  }
  // The mode vocabulary as a CLOSED SET. A third mode would change what a served variant can do to the
  // prompt, so this is the highest-value anchor here.
  if (!/function [\w$]+\([\w$]+\)\{return [\w$]+==="replace"\|\|[\w$]+==="append"\}/.test(bundle))
    miss("mode predicate", 'the two-mode membership test (`m==="replace"||m==="append"`) moved — a THIRD MODE may exist');
  // Mode is encoded in the key suffix (`07_16_2026.replace`), which is how a served entry selects it.
  if (!/\^\[A-Za-z0-9_-\]\{1,128\}\(\\\.\(replace\|append\)\)\?\$/.test(bundle))
    miss("key grammar", "the `<name>(.replace|.append)?` key-name regex moved");
  // The startup throw requiring {{promptCacheBoundary}} in a replace-mode variant. NOTE ITS SCOPE: it
  // guards the BUILT-IN variants table only. Server-supplied entries are validated later, on the
  // resolution path, which DEGRADES rather than throwing — a boundary-less `replace` resolves to
  // `missing_boundary` and the session simply gets a different prompt, with no error anywhere. So this
  // anchor pins the loud half; the quiet half is why the harness needs the sentinel at all.
  if (!/replace-mode text must contain \{\{promptCacheBoundary\}\}/.test(bundle))
    miss("boundary invariant", "the startup throw requiring {{promptCacheBoundary}} in a built-in replace-mode variant is gone");
  // The resolution-path status machine — the SILENT half. If these statuses disappear, a malformed
  // served variant stops being classified at all, and the failure mode gets quieter still.
  if (!/missing_boundary/.test(bundle) || !/invalid_entry/.test(bundle))
    miss(
      "resolution status machine",
      "the per-key hit/invalid_entry/missing_boundary resolution statuses moved — a malformed served variant may no longer be classified",
    );
  return flags;
}

export function checkPathHookFacts(files: Map<string, string>): string[] {
  const flags: string[] = [];
  const miss = (what: string, why: string) => flags.push(`path-hook: ${what} anchor missing — ${why}`);
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // --- defining chunk: the one that EXPORTS the name (alias or property form), not merely mentions
  //     it as a namespace-property consumer (the hostloop chunk references `.HOST_LOOP_…` too) ---
  // B8 (Desktop 1.25927.0): the arrow export form `HOST_LOOP_PATH_GATED_BUILTIN_TOOLS:()=>Se` puts `(`
  // after the colon, which the old `[:=][\w$]` tail rejected — the chunk DOES still export the name.
  const definesExport = /[\w$]+\s+as\s+HOST_LOOP_PATH_GATED_BUILTIN_TOOLS\b|\bHOST_LOOP_PATH_GATED_BUILTIN_TOOLS(?::\(\)=>|[:=])[\w$]/;
  const GATED_ARRAY = /\["Read","Write","Edit","Glob","Grep"\]/;
  // The install site's shape is name-independent and is the ONE anchor that survived 1.32352.0; it is
  // declared here (not below) because the defining-chunk fallback resolves through it.
  const installRe = /\[\.\.\.([\w$]+(?:\.[\w$]+)?),"MultiEdit"\]\.join\("\|"\)/;
  // D5 (Desktop 1.32352.0): exported CONSTANT names mangle too — `HOST_LOOP_PATH_GATED_BUILTIN_TOOLS`
  // became `Cg` while the array it names stayed byte-identical, so the name lookup reported the whole
  // machinery "gone". Try the readable name first (older asars + the fixtures bind it), then fall back to
  // the chunk the install site's spread actually RESOLVES to — and only accept that chunk if the spread
  // is still the gated 5-set, so a mis-resolution fails rather than silently re-pointing the sentinel.
  let defining = [...files.values()].find((c) => definesExport.test(c));
  if (!defining) {
    const site = [...files.values()].find((c) => installRe.test(c));
    const spreadId = site?.match(installRe)?.[1];
    const ref = site && spreadId ? resolveNamespaceRef(spreadId, site, files) : null;
    if (ref && new RegExp(`(?<![\\w$])${esc(ref.local)}=${GATED_ARRAY.source}`).test(ref.chunk)) defining = ref.chunk;
  }
  if (!defining) miss("defining chunk", "no chunk exports HOST_LOOP_PATH_GATED_BUILTIN_TOOLS");
  else {
    /** True when `local` is bound to SOME export of this chunk, under any of the emitted shapes. */
    const isExportedLocal = (chunk: string, local: string) =>
      new RegExp(`defineProperty\\(exports,"[\\w$]+",\\{[^}]*?return ${esc(local)}\\}`).test(chunk) ||
      new RegExp(`(?<![\\w$])[\\w$]+:\\(\\)=>${esc(local)}(?![\\w$])`).test(chunk) ||
      new RegExp(`(?<![\\w$])${esc(local)}\\s+as\\s+[\\w$]+`).test(chunk);

    const hop = (exportName: string, arrayRe: RegExp, label: string) => {
      // Resolve the LOCAL bound to this export across every export shape, then require
      // `<local>=<exact array>`. Binding to the export (not a free array search) is what makes a decoy
      // array fail.
      const local = exportLocalOf(defining, exportName);
      if (local) {
        if (!new RegExp(`(?<![\\w$])${esc(local)}=${arrayRe.source}`).test(defining))
          miss(label, `the ${exportName} export's local (${local}) is not bound to its exact array literal`);
        return;
      }
      // D5: the export NAME is mangled. Bind by CONTENT instead — the exact array must still be present
      // AND still be exported. Requiring the export is what keeps a same-shaped decoy array from passing.
      const byContent = defining.match(new RegExp(`(?<![\\w$])([\\w$]+)=${arrayRe.source}`));
      if (!byContent) {
        miss(label, `neither the ${exportName} export nor its exact array literal is present in the defining chunk`);
        return;
      }
      if (!isExportedLocal(defining, byContent[1]))
        miss(label, `the ${exportName} array is present (${byContent[1]}) but is no longer exported — it may be dead`);
    };
    hop("HOST_LOOP_PATH_GATED_BUILTIN_TOOLS", /\["Read","Write","Edit","Glob","Grep"\]/, "gated 5-set");
    // "PowerShell" joined the set at Desktop 1.24012.9 (was the 5-element list through 1.24012.1). It is a
    // REAL tool in the agent registry (its own "Executes a given PowerShell command…" description), but
    // win32-gated, so it never registers on the macOS/Linux runtimes this harness targets — hence no change
    // to hostloop's `disallowed` set (see the note in src/runtime/hostloop.ts). Pinned exactly so a future
    // set change still fires here rather than silently widening what production excludes.
    hop("HOST_LOOP_EXCLUDED_BUILTIN_TOOLS", /\["Bash","PowerShell","NotebookEdit","REPL","JavaScript","WebFetch"\]/, "excluded set");
    // D5: both export NAMES are 0 in Desktop 1.32352.0 while the constants they name are unchanged, so
    // anchor on the VALUES. `"chat"` alone is far too common to assert on — require it bound to a
    // constant, which is what the session-type comparison actually reads.
    if (!/"request_cowork_directory"/.test(defining))
      miss("REQUEST_COWORK_DIRECTORY", "the request_cowork_directory tool-name literal is gone from the defining chunk");
    if (!/(?<![\w$])[\w$]+="chat"/.test(defining))
      miss("SESSION_TYPE_CHAT", "no constant in the defining chunk is bound to the chat session-type literal");
  }

  // --- consuming chunk: located by the install site (namespace-property connectivity) ---
  // B9 (Desktop 1.25927.0): the spread is a MANGLED namespace property (`[...m.E,"MultiEdit"]`), so the
  // install site can no longer be found by the readable export name. Locate it by the invariant part of
  // the shape — a namespace spread joined with "MultiEdit" — then RESOLVE the spread and require it to be
  // the gated 5-set. That is strictly stronger than the old name match: a rename now passes only if the
  // thing actually installed is still the same array.
  const consuming = [...files.values()].find((c) => installRe.test(c));
  if (!consuming) {
    miss("install site", 'no chunk contains [...NS.HOST_LOOP_PATH_GATED_BUILTIN_TOOLS,"MultiEdit"].join("|")');
    return flags; // everything below is scoped to this chunk
  }
  {
    const spreadId = consuming.match(installRe)![1];
    const prop = spreadId.slice(spreadId.lastIndexOf(".") + 1);
    // Resolve through the consumer's own require() binding; if the consumer does not bind the namespace
    // locally (older single-graph layouts, and the synthetic fixtures), fall back to the chunk already
    // identified as DEFINING the tool-set exports — looking up the REFERENCED name, so an install site
    // that spreads some other export still fails to resolve rather than silently reusing the right one.
    let ref = resolveNamespaceRef(spreadId, consuming, files);
    if (!ref && defining) {
      const local = exportLocalOf(defining, prop);
      if (local) ref = { chunk: defining, local };
    }
    if (!ref) miss("install site spread", `the PreToolUse matcher spread (${spreadId}) could not be resolved to a defining export`);
    else if (!new RegExp(`(?<![\\w$])${esc(ref.local)}=\\["Read","Write","Edit","Glob","Grep"\\]`).test(ref.chunk))
      miss("install site spread", "the PreToolUse matcher no longer spreads the gated Read/Write/Edit/Glob/Grep set");
  }
  const inHook = (re: RegExp, label: string, why: string) => {
    if (!re.test(consuming)) miss(label, why);
  };
  inHook(/=\["Write","Edit","MultiEdit"\]/, "mutating set", "the Write/Edit/MultiEdit literal moved");
  inHook(
    /is a VM path\. In this session the \$\{[^}]+\} tool runs on the host filesystem/,
    "VM-path deny",
    "the /sessions guard text changed",
  );
  // resolveFilePath's two hard-block strings live in a shared resolver module. B13 (Desktop 1.25927.0):
  // the 101 → 341 chunk split moved that resolver OUT of the chunk that exports the tool sets, so scoping
  // these to `defining` now reports "gone" for text that is still present. They are unique enough to be
  // graph-wide facts — assert existence anywhere in the require graph.
  const anywhere = (re: RegExp) => [...files.values()].some((c) => re.test(c));
  if (!anywhere(/Refusing to resolve non-regular file/))
    miss("resolver hard-block", "the non-regular-file branch is gone from the shared resolver");
  if (!anywhere(/Failed to resolve path/)) miss("resolver failure text", "the resolve-failure branch is gone from the shared resolver");
  inHook(/could not be safely resolved/, "resolver caller block", "the active non-ENOENT block branch is gone from the hook"); // caller-side text — stays in the consumer
  inHook(/is outside this session's scratch directory, so \$\{/, "scratch deny", "the scratch directory deny-variant text changed");
  inHook(/is outside this session's connected folders, so \$\{/, "connected deny", "the connected folders deny-variant text changed");
  inHook(/hardlink to the user's original file/, "uploads-task deny", "the hardlink category text changed");
  inHook(/\(spooled tool results\)/, "spool deny", "the spooled-projects category text changed");
  inHook(/\(plugin, skill, or knowledge content\)/, "plugin deny", "the plugin category text changed");
  inHook(/"Path is outside allowed working directories"/, "SDK deny const", "the workingDir constant changed");
  inHook(/\["file_path","path"\]/, "path key pair", "the file_path/path key array is gone");
  // First-string extraction over the path keys: `<keys>.map(k=>o[k]).find(v=>typeof v=="string")`.
  // The keys are bound to a local (real: `pe=["file_path","path"]`, used as `pe.map(…)`) rather than
  // inlined, so anchor the map/find/typeof-string SHAPE (both proven by the separate path-key anchor).
  inHook(
    // D4 (Desktop 1.32352.0): the codegen now PARENTHESISES arrow bodies —
    // `.map((e=>n[e])).find((e=>typeof e=="string"))`. Same expression, newer output target; admit both
    // forms exactly as B14 does for the optional-call shape.
    /\.map\(\(?[\w$]+=>[\w$]+\[[\w$]+\]\)?\)\.find\(\(?[\w$]+=>typeof [\w$]+=="string"\)?\)/,
    "first-match extraction",
    "the .map().find() extraction shape is gone",
  );
  inHook(/spooledProjectsReadOnlyRoots/, "spool roots identifier", "spooledProjectsReadOnlyRoots is gone");
  inHook(/getMidSessionReadOnlyPaths/, "mid-session roots", "getMidSessionReadOnlyPaths is no longer wired");
  // B14: the optional call is emitted NATIVELY now (`?[]:ye?.()??[]`) instead of downleveled
  // (`?[]:(ne==null?void 0:ne())??[]`). Same expression, newer output target — admit both.
  inHook(
    /\?\[\]:(?:\([\w$]+==null\?void 0:[\w$]+\(\)\)|[\w$]+\?\.\(\))\?\?\[\]/,
    "readOnly-tail rule",
    "the ...ie||ct?[]:(ne?.())??[] per-call assembly shape is gone",
  );
  // B15: the SESSION_TYPE_CHAT constant is INLINED to its literal at this comparison
  // (`e.sessionType==="chat"`). The constant itself is still exported and separately asserted above, so
  // accept either form here — what this anchor pins is that the hook still branches on chat sessions.
  inHook(
    /===[\w$]+\.SESSION_TYPE_CHAT|sessionType==="chat"/,
    "chat-type connectivity",
    "the sessionType===SESSION_TYPE_CHAT comparison is gone",
  );
  inHook(/=[\w$]+\?\[\.\.\.[\w$]+,\.\.\.[\w$]+\]:\[/, "root topology ternary", "the chat/task st root-assembly ternary is gone");
  // B17 (Desktop 1.30096.1): the chain gained a FOURTH, awaited link — an auto-memory ALLOW carve-out
  // that rewrites updatedInput and sits BEFORE the outside-roots deny. The old two anchors here were a
  // bare shape test and a PREFIX match; see extractCanUseToolChain for why that combination could absorb
  // an inserted synchronous link in silence. Everything below asserts the chain END-TO-END.
  const chain = extractCanUseToolChain(consuming);
  if (!chain) {
    miss(
      "conditional canUseTool install",
      "the `let O=e.canUseTool;O&&(e.canUseTool=async…)` install (guarded by the SAVED original) is gone",
    );
  } else {
    const { orig, operands, block } = chain;
    const calleeOf = (op: string) => op.match(/^(?:await\s+)?([\w$]+)\(/)?.[1];
    const bodyOf = (fn: string) => braceBodyOf(consuming, `async function ${fn}(`) ?? braceBodyOf(consuming, `function ${fn}(`);

    // (1) TERMINAL: must be exactly a call to the saved original, nothing wrapping it. Anchored `$` so
    //     `(K(e,t,n)??{behavior:"allow"})` — a blanket allow on fall-through — cannot pass as "calls it".
    const last = operands[operands.length - 1];
    if (!new RegExp(`^(?:await\\s+)?${orig.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\([^)]*\\)$`).test(last))
      miss(
        "canUseTool chain terminal",
        `the chain no longer ends in a bare call to the saved original (${orig}) — fall-through may be rewritten`,
      );

    // (0) WRAPPER (Desktop 1.32352.0, block form only). The chain is no longer the whole decision: a
    //     pre-pass runs FIRST and can deny outright, and a post-pass can turn the chain's ALLOW into a
    //     DENY. Accepting the block shape without pinning both would silence three flags and leave two
    //     new decision points unmodelled — the exact way B16/B18 failed open.
    if (block !== null) {
      const pre = block.match(/^(?:const|let|var) ([\w$]+)=(await )?([\w$]+)\(/);
      if (!pre) {
        miss("canUseTool wrapper", "the block body does not open with a pre-pass binding — classify the new shape before admitting it");
      } else {
        const [, resultId, awaited, preFn] = pre;
        // The await rule again, for the pre-pass: an un-awaited async call yields a Promise, so the early
        // deny never fires and `finish` is not a function. Both new decision points go inert in silence.
        if (!awaited && new RegExp(`async function ${preFn}\\(`).test(consuming))
          miss(
            "canUseTool wrapper await",
            `the pre-pass \`${preFn}\` is async but is not awaited — the early deny and the post-pass are both inert`,
          );
        const preBody = bodyOf(preFn);
        if (!preBody) miss("canUseTool wrapper", `the pre-pass \`${preFn}\` has no resolvable definition in the hook chunk`);
        else {
          if (!/is a VM path/.test(preBody))
            miss("canUseTool wrapper vm-deny", "the pre-pass no longer carries a /sessions VM-path deny — a VM path could reach the tool");
          if (!/finish/.test(preBody))
            miss("canUseTool wrapper finish", "the pre-pass no longer builds a finish() continuation — the post-pass veto cannot fire");
        }
        // The early deny must be consulted BEFORE the chain runs.
        if (!new RegExp(`${resultId}\\?\\.[\\w$]+\\)return`).test(block))
          miss("canUseTool wrapper early-deny", "the pre-pass result is no longer checked for an early deny ahead of the chain");
        // The chain's result must flow through finish(), or the ALLOW-veto is gone.
        if (!new RegExp(`${resultId}===null\\?([\\w$]+):${resultId}\\.finish\\(\\1\\)`).test(block))
          miss(
            "canUseTool wrapper post-pass",
            "the chain result no longer flows through the pre-pass's finish() — an approved call can no longer be vetoed after the fact",
          );
      }
    }

    // (2) LINK COUNT: tolerate the 3-link (<=1.28929.0) and 4-link (1.30096.1) shapes so an older install
    //     still syncs; a FIFTH link is a new decision point that must be classified, never absorbed.
    if (operands.length < 3 || operands.length > 4)
      miss(
        "canUseTool chain shape",
        `the chain has ${operands.length} links (expected 3 or 4) — a new link changes permission semantics and must be classified`,
      );

    // (3) AWAIT ON ASYNC. The single highest-value rule here. An async callee returns a Promise, which is
    //     never nullish, so an un-awaited link short-circuits `??` and silently disables EVERY later link
    //     INCLUDING the original callback. Executed: `Ke()??Xe()??qe()??K()` with Xe async resolves to
    //     undefined instead of qe's deny. Dropping one `await` is therefore a full permission bypass.
    for (const op of operands) {
      const fn = calleeOf(op);
      if (!fn) continue;
      if (new RegExp(`async function ${fn}\\(`).test(consuming) && !/^await\s/.test(op))
        miss(
          "canUseTool chain await",
          `link \`${fn}\` is an async function but is not awaited — its Promise is never nullish, so every later link (and the original callback) is bypassed`,
        );
    }

    // (4) ORDERING: the /sessions VM-path deny must precede any link that can return an allow. Production
    //     put the auto-memory ALLOW ahead of the outside-roots deny deliberately; moving it ahead of the
    //     VM-path deny instead would let a VM path through. Nothing else here would notice a reorder.
    const idxOf = (pred: (b: string) => boolean) =>
      operands.findIndex((op) => {
        const fn = calleeOf(op);
        const b = fn ? bodyOf(fn) : null;
        return !!b && pred(b);
      });
    const vmDenyAt = idxOf((b) => /is a VM path/.test(b));
    const allowAt = idxOf((b) => /behavior:"allow"/.test(b));
    if (vmDenyAt < 0)
      miss(
        "canUseTool chain vm-deny",
        "no link in the chain resolves to the /sessions VM-path deny — it may have been dropped from the chain",
      );
    else if (allowAt >= 0 && allowAt < vmDenyAt)
      miss(
        "canUseTool chain order",
        "a link that can return {behavior:'allow'} precedes the /sessions VM-path deny — a VM path could be allowed",
      );

    // (5) Every non-terminal callee must RESOLVE to a definition in this chunk. A link swapped for an
    //     unresolvable one keeps the count and the terminal intact, so without this D5 passes.
    for (const op of operands.slice(0, -1)) {
      const fn = calleeOf(op);
      if (!fn)
        miss("canUseTool chain operand", `a chain link is not a plain call (\`${op.slice(0, 40)}\`) — classify it before admitting it`);
      else if (!bodyOf(fn)) miss("canUseTool chain operand", `chain link \`${fn}\` has no resolvable definition in the hook chunk`);
    }
  }

  // qt-before-containment ORDER + removed-exemption ABSENCE: inside the hook body slice, the category
  // guard's function must be referenced BEFORE any containment-helper call, and NO containment call may
  // precede it (a blanket early-allow shape).
  const qtDef = consuming.match(/function ([\w$]+)\([\w$]+\)\{[\s\S]{0,2000}?hardlink to the user's original file/);
  // B16: this used the readable-name install regex, which stopped matching when the spread was mangled —
  // and because the ordering check is guarded by `installAt >= 0`, it SILENTLY SKIPPED rather than
  // flagging. Reuse the shape-based `installRe` (already proven to match above) so the
  // qt-before-containment order stays enforced instead of failing open.
  const installAt = consuming.search(installRe);
  if (!qtDef) miss("qt definition", "no function contains the hardlink category text");
  else if (installAt < 0)
    miss("install offset", "the install site matched for discovery but not for ordering — the order check would skip");
  else {
    const hookSlice = consuming.slice(installAt, installAt + 6000);
    const qtCallAt = hookSlice.indexOf(`${qtDef[1]}(`);
    if (qtCallAt < 0) miss("qt call in hook", "the category guard is not invoked from the hook body");
    else {
      // B18: this searched for `.isPathContainedInFolders(` / `isContained(`. Counted across BOTH the
      // 1.28929.0 and 1.30096.1 asars, those tokens occur ZERO times — production's containment helper is
      // a MANGLED namespace member (`t.Po(`). So `containAt` was permanently -1, the `>= 0` guard never
      // entered, and this early-allow detector had never fired and could not fire. It stayed green only
      // because the fixture hard-coded a readable name that exists in no real asar.
      //
      // Identify the helper by SHAPE instead of by name: resolve each `<ns>.<member>(` called in the hook
      // slice and keep the ones whose definition is a realpath+relative containment test. Name-independent,
      // so it survives the per-build minifier rotation that made the old anchor unfalsifiable.
      const isContainmentBody = (b: string) => /realpath/i.test(b) && /relative\(/.test(b) && /"\.\."|`\.\.`|\.\./.test(b);
      const resolveRef = (ref: string) => {
        const r = resolveNamespaceRef(ref, consuming, files);
        if (r) return r;
        const prop = ref.slice(ref.lastIndexOf(".") + 1);
        const local = defining ? exportLocalOf(defining, prop) : null;
        return local && defining ? { chunk: defining, local } : null;
      };
      let containAt = -1;
      for (const m of hookSlice.matchAll(/(?<![\w$])([\w$]+\.[\w$]+)\(/g)) {
        const r = resolveRef(m[1]);
        if (!r) continue;
        const b = braceBodyOf(r.chunk, `async function ${r.local}(`) ?? braceBodyOf(r.chunk, `function ${r.local}(`);
        if (b && isContainmentBody(b)) {
          containAt = m.index!;
          break;
        }
      }
      if (containAt < 0)
        miss(
          "containment helper",
          "no call in the hook body resolves to a realpath/relative containment helper — the early-allow ordering check would silently skip (this is how it failed open before)",
        );
      else if (containAt < qtCallAt)
        miss("qt-before-containment order", "a containment call precedes the category guard — an early-allow/blanket-exemption shape");
    }
  }
  return flags;
}

// ==========================================================================================
// Prompt-drift guard (H1-H3): the Cowork system-prompt raw content is a hand-maintained
// side-artifact (baselines/prompts/cowork-system-prompt-fingerprints.json) that `sync` previously
// never touched — this section folds a fingerprint-vs-committed-baseline check into `sync` itself
// so a prompt-content change (or a newly-added, unmodeled {{placeholder}}) surfaces as a loud
// unknown delta rather than requiring a human to notice by hand. The committed fingerprints live in
// baselines/prompts/cowork-system-prompt-fingerprints.json; the drift signal complements the coarse
// asarFingerprint (which flips on any minifier rename) with the minifier-independent content hash.
// ==========================================================================================

export interface PromptFingerprint {
  constantId: string;
  codePoints: number;
  sectionTags: number;
  sha256: string;
  /** sha256 / code points of the template body with `\uXXXX`-style escapes DECODED — see
   *  decodeTemplateEscapes for why the raw hash alone is not a content fingerprint. */
  decodedSha256: string;
  decodedCodePoints: number;
  placeholders: string[]; // sorted unique {{name}} names
  sectionTagNames: string[]; // sorted unique <name> open-tag names
}

/**
 * Extract the raw Cowork system-prompt constant's content fingerprint from the asar main bundle.
 * Mirrors the method documented in baselines/prompts/cowork-system-prompt-fingerprints.json
 * (`extractionMethod`): find the single `cowork_system_prompt:{value:{prompt:<id>}` consumption
 * site, capture `<id>` (minifier-assigned, varies per build), then find `<id>=` followed by a
 * backtick and read the backtick-template body char-by-char — preserving `\`-escapes intact (a
 * `\` consumes the next char too, so an escaped backtick inside the template never ends the scan
 * early) — stopping at the first UNescaped backtick. Returns null if either anchor is missing (the
 * prompt-asset layout moved — the caller turns that into a hard-fail unknown delta, never a silent
 * skip).
 */
/** Decode a raw template body to the string the engine would produce.
 *
 *  D8 (Desktop 1.32352.0): the committed fingerprints hash the RAW template SOURCE, which the
 *  fingerprints file justifies as minifier-NAME-independent. It is NOT escape-form-independent — the
 *  1.32352.0 codegen started emitting non-ASCII as `\uXXXX`, which moved the prompt sha and BOTH
 *  sub-agent-append fingerprints by +630 code points while the RENDERED text stayed byte-identical.
 *  Hashing the decoded body is what makes a fingerprint a content fingerprint. The raw hashes are kept
 *  alongside: they are the committed history and must not be reinterpreted retroactively.
 *
 *  Unknown escapes pass through as their escaped character (`\q` -> `q`), matching JS semantics. */
export function decodeTemplateEscapes(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== "\\") {
      out += c;
      continue;
    }
    const n = raw[++i];
    if (n === undefined) break;
    if (n === "n") out += "\n";
    else if (n === "t") out += "\t";
    else if (n === "r") out += "\r";
    else if (n === "b") out += "\b";
    else if (n === "f") out += "\f";
    else if (n === "v") out += "\v";
    else if (n === "0" && !/[0-9]/.test(raw[i + 1] ?? "")) out += "\0";
    else if (n === "x") {
      out += String.fromCharCode(parseInt(raw.substr(i + 1, 2), 16));
      i += 2;
    } else if (n === "u") {
      if (raw[i + 1] === "{") {
        const end = raw.indexOf("}", i);
        out += String.fromCodePoint(parseInt(raw.slice(i + 2, end), 16));
        i = end;
      } else {
        out += String.fromCharCode(parseInt(raw.substr(i + 1, 4), 16));
        i += 4;
      }
    } else out += n; // \` \$ \\ and anything else: the escaped char itself
  }
  return out;
}

export function extractPromptFingerprint(bundle: string): PromptFingerprint | null {
  const consumptionM = bundle.match(/cowork_system_prompt:\{value:\{prompt:([A-Za-z_$][\w$]*)/);
  if (!consumptionM) return null;
  const id = consumptionM[1];
  const idEsc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const defM = bundle.match(new RegExp(`(?:[,;{(]|\\b(?:const|let|var)\\s+)${idEsc}=\``));
  if (!defM || defM.index == null) return null;
  const bodyStart = defM.index + defM[0].length; // index of the char right after the opening backtick
  let body = "";
  let i = bodyStart;
  let closed = false;
  for (; i < bundle.length; i++) {
    const c = bundle[i];
    if (c === "\\") {
      // Preserve the escape AND the escaped char intact (raw template source, not a decoded string).
      body += c + (bundle[i + 1] ?? "");
      i++; // skip the escaped char too (loop's i++ advances past the backslash)
      continue;
    }
    if (c === "`") {
      closed = true;
      break;
    }
    body += c;
  }
  if (!closed) return null;

  const sha256 = createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex");
  const codePoints = [...body].length;
  const decoded = decodeTemplateEscapes(body);
  const decodedSha256 = createHash("sha256").update(Buffer.from(decoded, "utf8")).digest("hex");
  const decodedCodePoints = [...decoded].length;
  const sectionTags = [...body.matchAll(/<[a-z_]+>/g)].length;
  const placeholders = dedupe([...body.matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/g)].map((m) => m[1])).sort();
  const sectionTagNames = dedupe([...body.matchAll(/<([a-z_]+)>/g)].map((m) => m[1])).sort();
  return { constantId: id, codePoints, sectionTags, sha256, decodedSha256, decodedCodePoints, placeholders, sectionTagNames };
}

interface PromptFingerprintsFile {
  versions: Record<string, { sha256?: string | null; placeholders?: string[]; sectionTagNames?: string[] }>;
}

/** Load baselines/prompts/cowork-system-prompt-fingerprints.json; null on any read/parse failure
 *  (missing file, corrupt JSON, or no `versions` map) — treated as "cannot check", not a hard-fail
 *  (see checkPromptDrift). */
function readPromptFingerprintsFile(): PromptFingerprintsFile | null {
  try {
    const raw = readFileSync(join(BASELINES_DIR, "prompts", "cowork-system-prompt-fingerprints.json"), "utf8");
    const parsed = JSON.parse(raw) as PromptFingerprintsFile;
    if (!parsed || typeof parsed !== "object" || !parsed.versions) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** subagentAppendVersions map from cowork-system-prompt-fingerprints.json; null = unreadable/absent
 *  (checkSubagentPromptFacts turns that into a hard-fail flag — never a silent skip). */
function readSubagentFingerprints(): { versions: Record<string, { hl: string; vm: string }> } | null {
  try {
    const raw = readFileSync(join(BASELINES_DIR, "prompts", "cowork-system-prompt-fingerprints.json"), "utf8");
    const parsed = JSON.parse(raw) as { subagentAppendVersions?: Record<string, { hl: string; vm: string }> };
    if (!parsed?.subagentAppendVersions) return null;
    return { versions: parsed.subagentAppendVersions };
  } catch {
    return null;
  }
}

/**
 * H1 (sha drift -> BLOCK) + H2 (placeholder/section inventory diff -> informational) + H3 (unmodeled
 * placeholder -> BLOCK). Pure over its inputs so it's token-free unit-testable without a real asar.
 * Drift key is content-hash-vs-newest-committed-entry, NOT appVersion — a byte-identical prompt on a
 * new Desktop version must pass silently (matches the plan's "1.19367.0 needs no new baseline").
 */
export function checkPromptDrift(
  fp: PromptFingerprint | null,
  fingerprintsFile: {
    versions: Record<
      string,
      { sha256?: string | null; decodedSha256?: string | null; placeholders?: string[]; sectionTagNames?: string[] }
    >;
  } | null,
  modeled: ReadonlySet<string>,
  allowlisted: ReadonlySet<string>,
): { unknownDeltas: string[]; notes: string[] } {
  const unknownDeltas: string[] = [];
  const notes: string[] = [];
  if (!fp) {
    unknownDeltas.push(
      "prompt fingerprint: the cowork_system_prompt consumption site or its constant definition was not found — the prompt-asset layout moved; re-verify extractPromptFingerprint",
    );
    return { unknownDeltas, notes };
  }
  const versions = fingerprintsFile ? Object.keys(fingerprintsFile.versions) : [];
  if (!fingerprintsFile || versions.length === 0) {
    notes.push("prompt fingerprint: cowork-system-prompt-fingerprints.json missing/unreadable — cannot check prompt drift");
  } else {
    let newestVer = versions[0];
    for (const v of versions) if (cmpVersionStrings(v, newestVer) > 0) newestVer = v;
    const entry = fingerprintsFile.versions[newestVer];

    // H1 — content drift vs the newest committed entry (BLOCK), compared on the DECODED body.
    //
    // D8: comparing the RAW hash makes a pure codegen change (Desktop 1.32352.0 began escaping non-ASCII
    // as `\uXXXX`) indistinguishable from real prompt drift — it moved the sha by +630 code points while
    // the rendered text was byte-identical. Decoded is the content comparison; a raw-only move is a NOTE,
    // because it still wants a re-stamp, just not a paraphrase-baseline re-derivation.
    if (entry.decodedSha256) {
      if (fp.decodedSha256 !== entry.decodedSha256) {
        unknownDeltas.push(
          `prompt content drifted vs the newest committed fingerprint (${newestVer}): decoded sha ${entry.decodedSha256.slice(0, 12)}… -> ${fp.decodedSha256.slice(0, 12)}… (decodedCodePoints -> ${fp.decodedCodePoints}, sectionTags -> ${fp.sectionTags}). This is a REAL content change, not a codegen escape change. Confirm the RENDERED-prompt impact (a placeholder may be deployment-gated/stripped like {{modelIdentity}}), then add a new version entry to baselines/prompts/cowork-system-prompt-fingerprints.json.`,
        );
      } else if (entry.sha256 && fp.sha256 !== entry.sha256) {
        notes.push(
          `NOTE: prompt RAW source changed (${entry.sha256.slice(0, 12)}… -> ${fp.sha256.slice(0, 12)}…, codePoints -> ${fp.codePoints}) while the DECODED content is IDENTICAL — a codegen escape-form change, not prompt drift. Re-stamp sha256/codePoints/constantId on the newest entry; no paraphrase-baseline work is owed.`,
        );
      }
    } else if (entry.sha256 && fp.sha256 !== entry.sha256) {
      // Legacy entry captured before decodedSha256 existed: fall back to the raw comparison, and say so.
      unknownDeltas.push(
        `prompt content drifted vs the newest committed fingerprint (${newestVer}): sha ${entry.sha256.slice(0, 12)}… -> ${fp.sha256.slice(0, 12)}… (codePoints -> ${fp.codePoints}, sectionTags -> ${fp.sectionTags}). That entry predates decodedSha256, so this compares RAW source and CANNOT tell a codegen escape change from real drift — decode both before concluding. Then add a new version entry to baselines/prompts/cowork-system-prompt-fingerprints.json.`,
      );
    }

    // H2 — placeholder/section inventory diff (informational; appended to notes).
    if (entry.placeholders) {
      const before = new Set(entry.placeholders);
      const after = new Set(fp.placeholders);
      for (const p of after) if (!before.has(p)) notes.push(`prompt inventory: NEW placeholder {{${p}}}`);
      for (const p of before) if (!after.has(p)) notes.push(`prompt inventory: REMOVED placeholder {{${p}}}`);
    }
    if (entry.sectionTagNames) {
      const before = new Set(entry.sectionTagNames);
      const after = new Set(fp.sectionTagNames);
      for (const t of after) if (!before.has(t)) notes.push(`prompt inventory: NEW section <${t}>`);
      for (const t of before) if (!after.has(t)) notes.push(`prompt inventory: REMOVED section <${t}>`);
    }
  }

  // H3 — unmodeled placeholder guard (BLOCK): every {{placeholder}} in the extracted prompt must be
  // either substituted by the renderer or explicitly allowlisted as intentionally out-of-band.
  for (const p of fp.placeholders) {
    if (!modeled.has(p) && !allowlisted.has(p)) {
      unknownDeltas.push(
        `unmodeled placeholder {{${p}}}: not in the renderer substitution set (src/prompt.ts MODELED_PLACEHOLDER_NAMES) nor the intentional-inline allowlist (INTENTIONALLY_UNMODELED_PLACEHOLDERS) — model it or allowlist it, else the harness would render it literally.`,
      );
    }
  }

  return { unknownDeltas, notes };
}

// ==========================================================================================
// Sub-agent append sentinel (hl/vm branches). Complements S16 (which pins only that a
// generator CALL exists) with: the SP_SECTION_KEYS pair, the hostLoopMode branch ternary, the two
// branch templates sliced from the ONE module that defines the generator, a normalized two-branch
// content fingerprint (BOTH mandatory), the substitution-map keys AND VALUES (a host/VM cwd swap AND
// a same-side root/mount binding mismatch fail), the resolveSection gate shape, and the delivery-call
// argument list. All anchors MANDATORY. Scope note: this proves the PRODUCT still has the modeled
// shape; harness-side delivery (per-tier selection, chat lane, {{vmCwd}} rendering) is guarded by
// vitest regression tests, not by sync.
// ==========================================================================================

/** Return the decoded body of the backtick template that ENCLOSES `at`, scanning a single module
 *  string. Backward: the opening delimiter is the nearest UNESCAPED backtick before `at` (escaped
 *  backticks `\`` are literal code-span backticks inside the body, not delimiters). Forward: escaped
 *  backticks are DECODED to a bare backtick (so the returned slice reads like the rendered template
 *  and the value-proof regexes can match), every other escape is preserved verbatim (keeps the
 *  fingerprint stable), and the first UNESCAPED backtick terminates the body. Operates per-module
 *  (never the concatenated bundle) so an unrelated template can't be captured. */
function templateBodyAt(module: string, at: number): string | null {
  if (at < 0) return null;
  let open = -1;
  for (let i = at; i >= 0; i--) {
    if (module[i] === "`" && module[i - 1] !== "\\") {
      open = i;
      break;
    }
  }
  if (open < 0) return null;
  let out = "";
  for (let i = open + 1; i < module.length; i++) {
    const c = module[i];
    if (c === "\\") {
      const next = module[i + 1] ?? "";
      if (next === "`") {
        // Escaped backtick = a literal code-span backtick in the body, not the terminator. Decode it.
        out += "`";
        i++;
        continue;
      }
      // Any other escape (\n, \\, …) is preserved as-is so the normalized fingerprint stays stable.
      out += c + next;
      i++;
      continue;
    }
    if (c === "`") return out; // a truly UNescaped backtick is the template's real closing delimiter.
    out += c;
  }
  return null;
}

/** Extract the two raw branch template bodies from the SINGLE module that defines the generator.
 *  Module-scoped, not whole-bundle: the defining module is the one that references
 *  buildSubagentEnvironmentPrompt AND contains BOTH short discriminator fragments (hl: "on the user's
 *  machine"; vm: "exist only in the sandbox" — both verbatim production substrings). The vm
 *  discriminator is unique; the hl fragment also occurs in unrelated prose, so the hl branch is
 *  anchored to the occurrence immediately preceding the vm branch (the hostLoopMode ternary's true
 *  arm). Each body is sliced by backtick scanning from its discriminator — no function-body brace
 *  matching, which the old draft got wrong (it grabbed the destructured-param `{` of `zo({…})`). */
export function extractSubagentBranchSlices(files: Map<string, string>): { module: string; hl: string; vm: string } | null {
  // B10 (Desktop 1.25927.0): `buildSubagentEnvironmentPrompt` is mangled away — the generator is no
  // longer identifiable by name. The two BRANCH TEXTS are the real discriminator anyway (they are the
  // thing being fingerprinted), and they are content, not identifiers, so they survive minification.
  // Requiring BOTH still pins a single module: only the generator carries the hl and vm bodies together.
  const module = [...files.values()].find((c) => c.includes("on the user's machine") && c.includes("exist only in the sandbox"));
  if (!module) return null;
  const vmAt = module.indexOf("exist only in the sandbox");
  const hlAt = module.lastIndexOf("on the user's machine", vmAt);
  if (vmAt < 0 || hlAt < 0) return null;
  const hl = templateBodyAt(module, hlAt);
  const vm = templateBodyAt(module, vmAt);
  if (!hl || !vm) return null;
  return { module, hl, vm };
}

/** sha16 of a branch text after minifier-identifier normalization: every ${...} interpolation is
 *  replaced by the canonical token `${}` so a minifier rename never moves the hash, while any
 *  body-text edit does. */
export function subagentBranchFingerprint(branchText: string): string {
  // D8: DECODE before normalising. Desktop 1.32352.0's codegen escape change moved BOTH branch
  // fingerprints while the rendered branch text was byte-identical; decoding makes the fingerprint track
  // content rather than codegen. The committed 1.20186.1 values are unchanged by this — they were
  // captured from a build that emitted the same characters literally.
  const normalized = decodeTemplateEscapes(branchText).replace(/\$\{[^{}]*\}/g, "${}");
  return createHash("sha256").update(Buffer.from(normalized, "utf8")).digest("hex").slice(0, 16);
}

export function checkSubagentPromptFacts(
  files: Map<string, string>,
  committed: { versions: Record<string, { hl: string; vm: string }> } | null,
): string[] {
  const flags: string[] = [];
  const bundle = [...files.values()].join(""); // literal anchors below span 3 modules (SP_SECTION_KEYS, generator, delivery) — check them against the join; branch-TEXT slicing is module-scoped
  const miss = (what: string, why: string) => flags.push(`subagent-append: ${what} anchor missing — ${why}`);

  // (1) key-pair literal (verbatim in all backed-up asars).
  if (!/subagentEnvHostLoop:"subagent_env_hl",subagentEnvVm:"subagent_env_vm"/.test(bundle))
    miss("SP_SECTION_KEYS pair", "the subagent_env_hl/subagent_env_vm key pair moved or was renamed");
  // (2) branch ternary — hl-first on the hostLoopMode boolean (receiver admits bare-local and NS. forms).
  if (!/\?[\w$.]*\.?subagentEnvHostLoop:[\w$.]*\.?subagentEnvVm/.test(bundle))
    miss("branch ternary", "the hostLoopMode ? subagentEnvHostLoop : subagentEnvVm selection is gone (or inverted)");
  // (3) module-scoped branch texts + MANDATORY two-branch fingerprints + VALUE proofs.
  const slices = extractSubagentBranchSlices(files);
  if (!slices) {
    miss("generator branch texts", "the module defining buildSubagentEnvironmentPrompt with both branch discriminators could not be found");
  } else {
    // Substitution-VALUE proofs — a host/VM cwd swap must fail. Prove the SAME binding is used for
    // root AND mount on EACH side:
    //   hl: working directory `${host??vmRoot}`; mounts `${vmRoot}/mnt/` — mount binding MUST equal the
    //       ?? FALLBACK binding (the vm root), never the host binding.
    //   vm: rooted at `${vmRoot}`; mounts `${vmRoot}/mnt/` — root binding MUST equal the mount binding.
    const hlWd = slices.hl.match(/working directory `\$\{([\w$]+)\?\?([\w$]+)\}`/);
    const hlMnt = slices.hl.match(/mounted under `?\$\{([\w$]+)\}\/mnt\//);
    if (!hlWd) miss("hl working-directory interpolation", "expected the `${hostCwd??vmRoot}` shape");
    if (!hlMnt) miss("hl mounts interpolation", "expected `${vmRoot}/mnt/`");
    if (hlWd && hlMnt && hlWd[2] !== hlMnt[1])
      miss(
        "hl substitution values",
        `hl mounts bind ${hlMnt[1]} but the working-directory ?? fallback (vm root) is ${hlWd[2]} — host/VM swap?`,
      );
    const vmRoot = slices.vm.match(/rooted at `?\$\{([\w$]+)\}`?/);
    const vmMnt = slices.vm.match(/mounted under `?\$\{([\w$]+)\}\/mnt\//);
    if (!vmRoot) miss("vm root interpolation", "expected `rooted at ${vmRoot}`");
    if (!vmMnt) miss("vm mounts interpolation", "expected `${vmRoot}/mnt/`");
    if (vmRoot && vmMnt && vmRoot[1] !== vmMnt[1])
      miss(
        "vm substitution values",
        `vm root binds ${vmRoot[1]} but mounts bind ${vmMnt[1]} — the two must be the same session-root binding`,
      );
    if (!/mcp__\$\{[^}]+\}__\$\{[^}]+\}/.test(slices.hl))
      miss("hl workspace-bash interpolation", "expected mcp__${…WORKSPACE_MCP_SERVER}__${…WORKSPACE_BASH}");
    // BOTH fingerprints MANDATORY — no per-branch `if (want.x)` skip (a missing committed value must
    // not silently disable a branch). A partial committed entry is itself a hard-fail.
    const hlFp = subagentBranchFingerprint(slices.hl);
    const vmFp = subagentBranchFingerprint(slices.vm);
    const versions = committed ? Object.keys(committed.versions) : [];
    if (!committed || versions.length === 0) {
      flags.push(
        "subagent-append: no committed subagentAppendVersions fingerprints — cannot verify branch-text drift (add them to baselines/prompts/cowork-system-prompt-fingerprints.json)",
      );
    } else {
      let newest = versions[0];
      for (const v of versions) if (cmpVersionStrings(v, newest) > 0) newest = v;
      const want = committed.versions[newest];
      if (typeof want.hl !== "string" || typeof want.vm !== "string")
        flags.push(
          `subagent-append: committed entry ${newest} is missing an hl or vm fingerprint — both are mandatory (a partial entry silently disables a branch)`,
        );
      if (typeof want.hl === "string" && want.hl !== hlFp)
        flags.push(
          `subagent-append: hl branch text fingerprint drifted vs ${newest} (${want.hl} -> ${hlFp}) — re-derive, update the paraphrase asset if semantics moved, then add a new version entry`,
        );
      if (typeof want.vm === "string" && want.vm !== vmFp)
        flags.push(
          `subagent-append: vm branch text fingerprint drifted vs ${newest} (${want.vm} -> ${vmFp}) — re-derive, update the paraphrase asset if semantics moved, then add a new version entry`,
        );
    }
  }
  // (4) resolveSection gate shape: if(!<eval>("124685897"))return <fallback>.
  if (!/if\(!\s*[\w$.]+\("124685897"\)\)return [\w$]+/.test(bundle))
    miss("resolveSection gate", 'the if(!gate("124685897"))return fallback shape is gone');
  // (5) substitution-map keys at the generator call. workspaceBash binds either a bare identifier or the
  //     inline mcp__${…}__${…} template literal that the release actually ships.
  if (!/\{vmCwd:[\w$]+,hostCwd:[\w$]+\?\?[\w$]+,workspaceBash:(?:[\w$]+|`mcp__\$\{[^}]+\}__\$\{[^}]+\}`)\}/.test(bundle))
    miss("substitution map", "the {vmCwd, hostCwd: hostCwd??vmRoot, workspaceBash} map keys/values moved");
  // (6) delivery-call argument-list connectivity at the appendSubagentSystemPrompt: site (S16 proves
  //     only that SOME call exists).
  if (
    !/appendSubagentSystemPrompt:(?:[\w$]+\.)?[\w$]+\(\{vmProcessName[\s\S]{0,80}hostLoopMode[\s\S]{0,80}hostCwd[\s\S]{0,80}spSectionPrompts/.test(
      bundle,
    )
  )
    miss(
      "delivery argument list",
      "the {vmProcessName, hostLoopMode, hostCwd, spSectionPrompts} argument list at the delivery site changed",
    );
  return flags;
}

// ==========================================================================================
// Spawn-contract verification + spawn.env generation.
//
// The Desktop→agent spawn env is constructed in the asar across THREE windows (W1 the inline spawn
// literal, W2 the OnA base-env helper, W3 the Zrn shared-env helper OnA spreads). Every ALL-CAPS key
// those windows construct must be classifiable as a PINNED value we generate, or an ALLOWLISTED key we
// deliberately don't pin (host-derived / session-conditional / settings- or 3p-conditional / deleted).
// An unclassifiable key, an unknown gate id, a missing REQUIRED key, a degenerate window, or an
// unresolvable const chain HARD-FAILS the sync (→ unknownDeltas) and forces deriveSpawnEnv to return
// env:null so the previous complete baseline env is carried forward (never a truncated partial).
//
// Values that hide behind minified symbols are RESOLVED (never asserted by name): gate conditionals
// against the decoded fcache state, `String(<id>)` timeouts against the const table. Everything asserted
// is a minifier-invariant literal (env key names, SDK property names, string constants).
// ==========================================================================================

/**
 * GrowthBook gate ids allowed to appear in W1's `<helper>("…")` conditionals — the CLOSED set. (The
 * gate-check helper's minified name varies per Desktop build: `At` in 1.18286.0, `et` in 1.18286.2; the
 * extractor matches it by shape, not by name.) A gate id in
 * the env windows but NOT here means a NEW gate-conditional env var was introduced: hard-fail so it gets
 * classified before the gate ever flips. Value = the env key it controls + disposition.
 */
const SPAWN_GATES: Record<string, string> = {
  "434204418": "on → MCP_CONNECTION_NONBLOCKING:'0' + MCP_CONNECT_TIMEOUT_MS:'10000' (pinned gate)",
  "66187241": "CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES 'true' vs '' (pinned gate)",
  "1936081873": "CLAUDE_CODE_OAUTH_SCOPES (value host-derived → allowlisted; pinned gate)",
  "1129419822": "ENABLE_TOOL_SEARCH:'auto' (dark; pinned via DARK_GATES)",
  "714014285": "CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING:'1' (pinned gate; force-ON live)",
  "4153934152": "CLAUDE_CODE_SKIP_PRECOMPACT_LOAD:'1' (pinned gate)",
  "451382573": "DISABLE_BRIEF_MODE_STOP_HOOK:'1' — brief (non-chat) sessions only; NOT pinned (harness models chat)",
};

/**
 * Env keys the generator deliberately does NOT pin, each with WHY. Checked before value resolution, so a
 * key here is skipped regardless of its construct shape (this is what keeps the messy host-derived / 3p /
 * session ternaries out of the generated env). A stale entry (allowlisted but no longer constructed
 * anywhere) emits a non-blocking NOTE for pruning, surfaced as SyncResult.notes in the sync output.
 *
 * "harness models chat sessions" below means one specific thing: the modeled session carries NO
 * `sessionType`, so it takes neither the `sessionType==="agent"` branch (hence no BRIEF keys) nor any
 * other explicit-type branch, and `CLAUDE_CODE_TAGS` resolves through the `??"chat"` default. It does NOT
 * mean production would consider the session chat-typed — production's own `isChatSession` requires an
 * EXPLICIT `sessionType==="chat"`, which the modeled session does not set. The distinction is inert for
 * these env keys but is not inert generally: reasoning "the harness models chat, so chat-excluded
 * Desktop behaviour cannot reach it" is how the auto-mode rubric gap came to be understated
 * (docs/fidelity-gaps.md).
 */
const SPAWN_ENV_ALLOWLIST: Record<string, string> = {
  CLAUDE_CONFIG_DIR: "modeled as spawn.configDirInGuest; injected per-session by spawnEnv() (src/runtime/argv.ts)",
  TZ: "host-derived (Intl timezone)",
  CLAUDE_CODE_HOST_PLATFORM: "host-derived; runtime-injected (src/runtime/argv.ts)",
  CLAUDE_CODE_OAUTH_TOKEN: "host auth",
  ANTHROPIC_BASE_URL: "host-derived (apiHost)",
  ANTHROPIC_CUSTOM_HEADERS: "host-derived (jXe client headers; re-set non-empty so it survives FnA)",
  ANTHROPIC_API_KEY: "constructed '' then deleted by FnA — absent from the final env",
  ANTHROPIC_AUTH_TOKEN: "constructed '' then deleted by FnA — absent from the final env",
  CLAUDE_CODE_OAUTH_SCOPES: "gate 1936081873 force-ON but value = the account's live OAuth scope (host-derived)",
  CLAUDE_CODE_SUBSCRIPTION_TYPE: "host account state",
  CLAUDE_CODE_RATE_LIMIT_TIER: "host account state",
  CLAUDE_CODE_ACCOUNT_UUID: "account-identity block; conditional on live login state",
  CLAUDE_CODE_USER_EMAIL: "account-identity block; conditional on live login state",
  CLAUDE_CODE_ORGANIZATION_UUID: "account-identity block; conditional on live login state",
  CLAUDE_CODE_ACCOUNT_TAGGED_ID: "account-identity block; conditional on live login state",
  CLAUDE_CODE_WORKSPACE_HOST_PATHS: "connected-folder list; runtime-derived per session",
  CLAUDE_PROJECT_UUID: "project-session-conditional (absent for the modeled standard chat session)",
  CLAUDE_PROJECT_TOOL: "project-session-conditional (absent for the modeled standard chat session)",
  MCP_CONNECT_TIMEOUT_MS: "gate 434204418-conditional (off; arrives with MCP_CONNECTION_NONBLOCKING:'0')",
  ENABLE_TOOL_SEARCH: "gate 1129419822-conditional (dark)",
  CLAUDE_CODE_SKIP_PRECOMPACT_LOAD: "gate 4153934152-conditional (off)",
  CLAUDE_CODE_BRIEF_UPLOAD: "non-chat (agent) sessionType branch; harness models chat sessions",
  CLAUDE_CODE_BRIEF: "non-chat (agent) sessionType branch; harness models chat sessions",
  DISABLE_BRIEF_MODE_STOP_HOOK: "non-chat sessionType + gate 451382573; harness models chat sessions",
  CLAUDE_CODE_SUBAGENT_MODEL: "user-settings-conditional (default absent)",
  CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "user-settings-conditional (default absent)",
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: "user-settings-conditional (default absent)",
  CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "user-settings-conditional (default absent)",
  CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: "server-pushed per-account map (default absent)",
  // Conditional on the SERVER-delivered session flag `frameArtifactsEnabled` (a session-config field
  // alongside memoryEnabled/skillsEnabled — NOT a GrowthBook gate, so it has no fcache id and cannot be
  // pinned in provenance.gates). Off for a default first-party session, so the key is absent from the
  // spawn env the baseline describes; pinning it would bake in a value real sessions never receive.
  // S6d asserts the key stays gated on the SAME predicate as the Artifact tool spread, so this
  // allowlist entry cannot silently start admitting an unconditional or re-keyed construction.
  CLAUDE_CODE_COWORK_FRAME_ARTIFACTS:
    "frameArtifactsEnabled server-flag-conditional (default absent); shared-predicate conditionality asserted by S6d",
  CLAUDE_CODE_ATTRIBUTION_HEADER: "3p-provider-only branch; harness models 1p",
  // Doubly conditional, and TWO traps a future reader will hit in this order:
  // (1) The managed-settings UI copy for this key names Cowork explicitly ("Raises how long Cowork, Chat
  //     and Code sessions wait for the next model event…"). That describes which SESSION KINDS an
  //     admin's setting reaches on a managed deployment — it does NOT put the key on the 1p path. The
  //     construction is inside the `...accountType==='3p' && {…}` spread; a first-party session cannot
  //     receive it however the gateway is configured.
  // (2) This is NOT the MCP_TOOL_TIMEOUT case. That key must never be allowlisted because it ALSO has a
  //     1p construction site, and resolveInto checks this allowlist BEFORE the pin list, so allowlisting
  //     it would silently drop a key the 1p spawn really sets. CLAUDE_STREAM_IDLE_TIMEOUT_MS has no 1p
  //     site — one construction site in the whole asar, in the 3p block — so the allowlist is correct
  //     here and a pin would bake a 3p-only key into a baseline that describes the 1p spawn.
  CLAUDE_STREAM_IDLE_TIMEOUT_MS:
    "3p branch AND gateway-provider streamIdleTimeoutSec-conditional (String(sec*1e3)); single site, inside the same `...accountType==='3p' && {...}` literal as DISABLE_GROWTHBOOK; harness models 1p",
  // Doubly conditional: the 3p branch AND `telemetry.disableNonessential`. Its two construction sites
  // sit inside the same `...accountType==='3p' && {...}` literal as DISABLE_GROWTHBOOK/DISABLE_TELEMETRY
  // below, so it is allowlisted for the identical reason rather than pinned — pinning would bake a
  // 3p-only key into a baseline that describes the 1p spawn.
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "3p-provider-only branch (+ telemetry.disableNonessential); harness models 1p",
  CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "3p-provider-only branch; harness models 1p",
  DISABLE_GROWTHBOOK: "3p-provider-only branch; harness models 1p",
  DISABLE_TELEMETRY: "3p-provider-only branch; harness models 1p",
  DISABLE_FEEDBACK_COMMAND: "3p-provider-only branch; harness models 1p",
  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "3p-provider-only branch; harness models 1p",
  DISABLE_ERROR_REPORTING: "3p-provider-only branch; harness models 1p",
  CLAUDE_CODE_ENABLE_AUTO_MODE: "3p-provider-only branch; harness models 1p",
  CLAUDE_CODE_HOST_AUTH_ENV_VAR: "3p-provider-only branch; harness models 1p",
  // Desktop 1.32352.0. Constructed in the SAME `...deploymentType==='3p' && {…}` literal as
  // DISABLE_GROWTHBOOK/DISABLE_TELEMETRY above (verified at its construction site: `let t=<deployment>(),
  // n=t.type==="3p"`), so it is never built on a first-party Cowork session. Allowlisted, not pinned —
  // pinning would bake a 3p-only key into a baseline that describes the 1p spawn, which is the same call
  // made for the 3p-only key in 1.26832.0.
  CLAUDE_CODE_DIAGNOSTICS_FILE: "3p-provider-only branch; harness models 1p",
};

/**
 * The keys deriveSpawnEnv generates. A constructed key that is neither here nor in SPAWN_ENV_ALLOWLIST is
 * an ADDITION to the spawn contract → hard-fail (classify it: add here to pin, or allowlist with a
 * reason). This explicit set is what makes an injected literal a LOUD signal rather than a silent auto-pin
 * (the drift class this whole check exists to kill). Value resolution is structural (from the asar
 * window), so a value CHANGE on any pinned key still shows as a --diff line.
 */
const SPAWN_PIN_KEYS: readonly string[] = [
  "CLAUDE_CODE_IS_COWORK",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_TAGS",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL",
  "CLAUDE_CODE_DISABLE_CRON",
  "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS",
  "CLAUDE_CODE_DISABLE_AGENTS_FLEET",
  "CLAUDE_CODE_ENABLE_APPEND_SUBAGENT_PROMPT",
  "CLAUDE_CODE_ENABLE_TASKS",
  "CLAUDE_CODE_DISABLE_TERMINAL_TITLE",
  "ENABLE_PROMPT_CACHING_1H",
  "DISABLE_MICROCOMPACT",
  "MCP_CONNECTION_NONBLOCKING",
  "API_TIMEOUT_MS",
  "CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES",
  "CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING",
  // Desktop 1.32352.0. UNCONDITIONAL in W1 (no gate, no session/deployment branch), so a first-party
  // Cowork session always receives it — pin it, so a later move to a gate or a value change is a --diff
  // line rather than a silent contract shift. Note the key is not itself new: the bundled CLI has
  // declared it for several releases and the desktop CODE-session runner already set it behind a gate;
  // what is new is the Cowork spawn setting it outright.
  "CLAUDE_PREVIEW_CLASSIFIER_FLOOR",
  "DISABLE_AUTOUPDATER",
  // Desktop 1.37937.0. MCP_TOOL_TIMEOUT is the first key that is BOTH 1p-pinned and 3p-constructed:
  // W1 builds it unconditionally (`String(<getter>())` → the `??18e4` default), and the 3p-only branch
  // in W3 gained a second, settings-conditional site (`...i!==void 0&&{MCP_TOOL_TIMEOUT:String(i)}`,
  // `i` a chunk-local `let`). It stays PINNED here, on its W1 site. Allowlisting it instead would be a
  // silent contract loss: resolveInto checks SPAWN_ENV_ALLOWLIST BEFORE this list, so the key would
  // vanish from the generated env entirely — and it is not in REQUIRED_SPAWN_KEYS, so nothing would
  // hard-fail. The 3p site is handled per-SITE by the branch rule in applyWindow, not per-key here.
  "MCP_TOOL_TIMEOUT",
  // Desktop 1.37937.0. Both UNCONDITIONAL in W1 (no gate, no session/deployment branch), constructed as
  // plain string literals between ENABLE_APPEND_SUBAGENT_PROMPT and ENABLE_PROMPT_CACHING_1H — which is
  // still set, so these are ADDITIVE rather than its replacement. Same call as
  // CLAUDE_PREVIEW_CLASSIFIER_FLOOR above: unconditional in W1 ⇒ every first-party Cowork session
  // receives them ⇒ pin, so a later gate or value change is a --diff line, not a silent shift. They read
  // 0 times in agent 2.1.241 and 6 times each in 2.1.246, so this is a live contract, not a dormant one.
  "CLAUDE_CODE_PROMPT_CACHE_TTL",
  "CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL",
  "USE_LOCAL_OAUTH",
  "USE_STAGING_OAUTH",
];

/**
 * Env keys whose DISAPPEARANCE from the constructed union (W1∪W2∪W3) is an identity-level break, not a
 * peripheral drop — hard-fail rather than a silent --diff removal. These are the keys the emulator's own
 * runtime semantics depend on.
 */
export const REQUIRED_SPAWN_KEYS: readonly string[] = [
  "CLAUDE_CODE_IS_COWORK",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL",
  "CLAUDE_CODE_ENABLE_APPEND_SUBAGENT_PROMPT",
  "CLAUDE_CODE_DISABLE_CRON",
];

const SPAWN_ADVICE =
  "classify the key (pin via SPAWN_PIN_KEYS or allowlist with a reason via SPAWN_ENV_ALLOWLIST) — do NOT bypass with --allow-empty, which would commit a baseline that no longer matches the live spawn contract";
// The --allow-empty footgun: --allow-empty force-writes past ALL tripwires, so every spawn flag
// ends with this explicit anti-instruction, not just the classify-the-key ones.
const SPAWN_NO_BYPASS = "do NOT bypass with --allow-empty (it would commit a baseline that no longer matches the live spawn contract)";

/** Key-position enumeration: an ALL-CAPS key (or the sole sub-3-char key `TZ`) preceded by `{` or `,`. */
const SPAWN_KEY_RE = /[{,](TZ|[A-Z][A-Z0-9_]{2,}):/g;

/**
 * Two-step identifier resolver. Finds `<id>`'s definition and returns its literal value, following
 * identifier→identifier aliases up to 3 hops. The declaration-preamble class admits `,;{(` AND
 * `const|let|var ` (`kGt`/`Sde` are `const `-preceded live, which the narrower `[,;{(]` form
 * would miss and hard-fail on). Returns null on: not found, >3 hops, or a non-literal terminal.
 */
export function resolveConst(bundle: string, id: string, hops = 0): string | null {
  if (hops > 3) return null;
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = bundle.match(new RegExp(`(?:[,;{(]|\\b(?:const|let|var)\\s+)${esc}=([^,;)]{1,40})`));
  if (!m) return null;
  const v = m[1].trim();
  if (/^[A-Za-z_$][\w$]*$/.test(v)) return resolveConst(bundle, v, hops + 1); // alias → follow
  return v;
}

/**
 * Resolve `String(<arg>)` env values to their concrete default string. `<arg>` is either a bare const
 * (`Sde` → `resolveConst`) or a settings-getter call (`Zv()` → the function's `??<id>` fallback default,
 * then `resolveConst`). Exponential literals (`6e4`,`9e5`) are Number-normalized to `"60000"`/`"900000"`.
 */
function resolveStringArg(bundle: string, arg: string, isCall: boolean, scope?: string, files?: Map<string, string>): string | null {
  // B11 (Desktop 1.25927.0): both the const (`String(j)`) and the helper (`String(A.f())`) are now
  // resolved through the REFERENCE CHUNK — export names are mangled to 1-2 chars, so a hop on the joined
  // 11 MB bundle lands on an unrelated `j=`/`f:` and returns a wrong number or null. `site` is the chunk
  // holding the expression when the caller knows it, else the joined bundle (single-text mode).
  const site = scope ?? bundle;
  let constId = arg;
  let where = site;
  if (isCall) {
    const ref = resolveNamespaceRef(arg, site, files);
    if (!ref) return null;
    const esc = ref.local.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const fm = ref.chunk.match(new RegExp(`function ${esc}\\([^)]*\\)\\{[^{}]*\\?\\?(\\w+)`));
    if (!fm) return null;
    constId = fm[1];
    where = ref.chunk;
  }
  // B12 (Desktop 1.25927.0): the `??` fallback may be an INLINE numeric literal (`??18e4`) where it used
  // to be a named const (`??zwe` → `ypt` → `6e4`). A literal needs no const lookup — and must not be
  // treated as an unresolvable name, which would mask a real value change behind a shape complaint.
  const v = Number.isFinite(Number(constId)) ? constId : (resolveConst(where, constId) ?? resolveConst(bundle, constId));
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return String(n);
}

/**
 * Resolve one `KEY:<expr>` value expression to a concrete string, or report it unresolvable. Recognized
 * shapes: string literal; template-with-default (`` `pfx${field??"def"}` `` → `pfx`+`def`); gate-ternary
 * (`<helper>("id")?"a":"b"`, helper name minifier-assigned); `String(<const|call>)`; and the modeled-session ternaries the standard 1p prod
 * chat localAgent session pins deterministically (disableCron→"1", oauth-env prod→"", 3p-entrypoint→1p).
 * Anything else → `{ unknown: true }` (never a silent partial substitution).
 */
export function resolveSpawnValue(
  bundle: string,
  expr: string,
  gates: Record<string, GateState>,
  scope?: string,
  files?: Map<string, string>,
): { value: string } | { unknown: true } {
  const e = expr.trim();
  let m: RegExpMatchArray | null;
  if ((m = e.match(/^"([^"]*)"$/)) || (m = e.match(/^'([^']*)'$/))) return { value: m[1] };
  if ((m = e.match(/^`([^`$]*)\$\{[^}]*\?\?"([^"]*)"\}`$/))) return { value: m[1] + m[2] };
  // B1: the gate helper may now be reached via a namespace-method receiver (`o.isFeatureEnabled(...)`)
  // instead of a bare hoisted call; the optional `(?:[A-Za-z_$][\w$]*\.)?` prefix admits both, and the
  // gate-id capture (still `m[1]`) is unaffected either way.
  if ((m = e.match(/^(?:[A-Za-z_$][\w$]*\.)?[A-Za-z_$][\w$]*\("(\d+)"\)\?"([^"]*)":"([^"]*)"$/))) {
    const id = m[1];
    if (!(id in SPAWN_GATES)) return { unknown: true };
    return { value: gates[id]?.on ? m[2] : m[3] };
  }
  // B2: the `String()` argument may now be a dotted member call (`o.getMcpToolTimeout()`); widen the
  // capture to admit `.` and let resolveStringArg follow the export-alias hop.
  if ((m = e.match(/^String\(([\w$.]+)(\(\))?\)$/))) {
    const v = resolveStringArg(bundle, m[1], !!m[2], scope, files);
    return v == null ? { unknown: true } : { value: v };
  }
  // Modeled-session ternaries (matched on stable property/literal tokens; every binding here is
  // minifier-assigned, so each one is `[\w$]+` — NOT `\w+`, which cannot match a `$`-initial name.
  // Desktop 1.32885.1 shipped `t.$s` and `\w` excludes `$`; test/sync-sentinel-identifier-classes.test.ts
  // holds this file to zero identifier atoms that reject `$`.
  if (/^[\w$]+\.disableCron\?"1":""$/.test(e)) return { value: "1" };
  if (/^[\w$]+\.type!=="3p"&&[\w$]+==="staging"\?"1":""$/.test(e)) return { value: "" };
  if (/^[\w$]+\.type!=="3p"&&[\w$]+==="local"\?"1":""$/.test(e)) return { value: "" };
  if ((m = e.match(/^[\w$]+\.type==="3p"\?"[^"]*":"([^"]*)"$/))) return { value: m[1] };
  // B13 (Desktop 1.40609.0): the 3p-entrypoint ternary directly above was extracted out of W2 into a
  // hoisted one-line helper — `CLAUDE_CODE_ENTRYPOINT:uH(n.type)`, with
  // `function uH(e){return e==="3p"?"claude-desktop-3p":"claude-desktop"}`. Same semantics as the inline
  // form, so it resolves the same way: the non-3p arm, because the harness models a FIRST-PARTY session.
  // Deliberately narrow — the argument must be a `.type` member (so an unrelated 1-arg call cannot reach
  // here) and the callee body must be exactly that literal ternary over its own parameter, found in the
  // window's OWN chunk (`scope`) when the caller knows it, since a bare 2-char minified name hopped
  // against the joined bundle can land on an unrelated helper. Anything else stays `unknown` rather than
  // being guessed at.
  if ((m = e.match(/^([A-Za-z_$][\w$]*)\([\w$]+\.type\)$/))) {
    const site = scope ?? bundle;
    const esc = m[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const fm = site.match(new RegExp(`function ${esc}\\(([\\w$]+)\\)\\{return \\1==="3p"\\?"[^"]*":"([^"]*)"\\}`));
    return fm ? { value: fm[2] } : { unknown: true };
  }
  return { unknown: true };
}

/** Slice the balanced value expression starting at `i` (char after `KEY:`), stopping at a top-level `,`/`}`. */
function sliceSpawnValue(text: string, i: number): string {
  const start = i;
  let depth = 0;
  let q: string | null = null;
  for (; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === "\\") i++;
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      q = c;
      continue;
    }
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") {
      if (depth === 0) break;
      depth--;
    } else if (c === "," && depth === 0) break;
  }
  return text.slice(start, i);
}

/** Two-anchor window: `[startAnchor … before first endAnchor after it]` (endAnchor NOT included). */
function twoAnchorWindow(bundle: string, startAnchor: string, endAnchor: string): string | null {
  const s = bundle.indexOf(startAnchor);
  if (s < 0) return null;
  const e = bundle.indexOf(endAnchor, s);
  if (e < 0) return null;
  return bundle.slice(s, e);
}

/**
 * W3 (the Zrn helper body): open at the `return{` before the DISABLE_AUTOUPDATER anchor, close on the
 * balanced `}` via a string-aware brace scanner (skips "…"/'…'/`…` spans). A nested template `${…}` inside
 * the object → return null (flagged, never guessed — none today).
 */
function braceScanWindow(bundle: string, anchor: string): string | null {
  const a = bundle.indexOf(anchor);
  if (a < 0) return null;
  const rs = bundle.lastIndexOf("return{", a);
  if (rs < 0) return null;
  let i = rs + "return".length; // at "{"
  let depth = 0;
  let q: string | null = null;
  for (; i < bundle.length; i++) {
    const c = bundle[i];
    if (q) {
      if (c === "\\") i++;
      else if (c === q) q = null;
      else if (q === "`" && c === "$" && bundle[i + 1] === "{") return null; // nested template — flag, don't guess
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      q = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return bundle.slice(rs, i + 1);
    }
  }
  return null;
}

/**
 * The literal that marks the 3p-only deployment branch. Anchoring on CONTENT rather than on the
 * predicate identifier is deliberate: the branch reads `...n&&{…}` where `n=<deployment>().type==="3p"`
 * is bound in the enclosing FUNCTION HEADER, which sits before every window's start anchor — so `n`
 * cannot be resolved from inside the window, and hard-coding `n` would be exactly the minified-name
 * anchoring that has broken sentinels three releases running (S6c, Cg, S14b). DISABLE_GROWTHBOOK has
 * been the first key of that literal in every build on record, and SPAWN_ENV_ALLOWLIST already treats
 * it as the branch's canonical marker in prose.
 */
const THIRD_PARTY_BRANCH_MARKER = "DISABLE_GROWTHBOOK:";

/**
 * The `mcp__` membership of the spawn's `allowedTools[]`, pinned as a SET (S10b). Read from Desktop
 * 1.37937.1; `mcp__plugins__search_connectors` is the entry that was new in 1.37937.0 and that S9/S10
 * could not see. Note this array is the pre-approval list only — a name here does not mean the tool is
 * OFFERED: `search_connectors` is declared solely on the 3p deployment
 * (`getDynamicTools:()=>…type==="3p"?[…]:[]`, and its handler branch re-checks the same predicate), so
 * the first-party inventory the harness serves is unaffected. Re-classify, then re-pin, on any delta.
 */
const SPAWN_ALLOWED_MCP_TOOLS: readonly string[] = [
  "mcp__mcp-registry__search_mcp_registry",
  "mcp__mcp-registry__suggest_connectors",
  "mcp__mcp-registry__list_connectors",
  "mcp__plugins__search_plugins",
  "mcp__plugins__search_connectors",
  "mcp__plugins__suggest_plugin_install",
  "mcp__plugins__list_plugins",
  "mcp__skills__list_skills",
  "mcp__skills__suggest_skills",
  "mcp__scheduled-tasks__list_scheduled_tasks",
  "mcp__computer-use",
];

/**
 * Slice the SPAWN's balanced `allowedTools:[…]` array text (bracket-aware, so a nested `[]` cannot end
 * it early). Anchored on the built-in head S9 pins, NOT on the bare `allowedTools:[` — the joined bundle
 * holds several unrelated `allowedTools` arrays (settings schemas, the bundled CLI) and the first one is
 * not the spawn's. A first-match slice reported all 11 pinned tools as removed at once, which is what a
 * mis-anchored window looks like: a total, implausible delta rather than a plausible one.
 */
function sliceAllowedToolsArray(bundle: string): string | null {
  const a = bundle.search(/allowedTools:\["Task","Bash","Glob","Grep","Read","Edit","Write","NotebookEdit","WebFetch"/);
  if (a < 0) return null;
  const open = bundle.indexOf("[", a);
  let depth = 0;
  for (let i = open; i < bundle.length; i++) {
    const c = bundle[i];
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) return bundle.slice(open, i + 1);
    }
  }
  return null;
}

/**
 * Slice the `...<pred>&&{…}` spread whose balanced body contains the 3p marker, or null when the window
 * carries no such branch (W1/W2 today). Returns the WHOLE spread text (`...<pred>&&{…}`) so the caller
 * can blank it wholesale. Brace matching is string-aware, since the body holds nested spreads and
 * quoted values.
 */
function sliceThirdPartyBranch(text: string): string | null {
  for (const m of text.matchAll(/\.\.\.[^{}]{0,80}?&&\{/g)) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let q: string | null = null;
    for (let i = open; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === "\\") i++;
        else if (c === q) q = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        q = c;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          const body = text.slice(open, i + 1);
          if (body.includes(THIRD_PARTY_BRANCH_MARKER)) return text.slice(m.index, i + 1);
          break;
        }
      }
    }
  }
  return null;
}

/** Parse `K:"v"`-style inner pairs of a `{…}` object body (used for gate-conditional spread inners). */
function enumSpawnKeys(text: string): { key: string; valueStart: number }[] {
  const out: { key: string; valueStart: number }[] = [];
  SPAWN_KEY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SPAWN_KEY_RE.exec(text))) out.push({ key: m[1], valueStart: m.index + m[0].length });
  return out;
}

/**
 * Derive the Desktop→agent spawn env (the generated tier). Pure over the bundle string +
 * decoded gate states. Returns the merged env map, or `env:null` whenever ANY hard-fail flag is pushed
 * (unknown key, unknown spawn gate, missing REQUIRED key, degenerate/unfound window, unresolvable value)
 * — the all-or-nothing contract that keeps a truncated partial from ever reaching the baseline.
 */
export function deriveSpawnEnv(
  bundle: string,
  gates: Record<string, GateState> | null,
  files?: Map<string, string>,
): { env: Record<string, string> | null; flags: string[]; keys: string[]; spreadCount: number } {
  const flags: string[] = [];
  // If the fcache is unreadable the caller already flags it; emit no spurious spawn flags, no partial env.
  if (!gates) return { env: null, flags: [], keys: [], spreadCount: 0 };

  const w1 = twoAnchorWindow(bundle, "env:{CLAUDE_CONFIG_DIR", ",systemPrompt:");
  const w2 = twoAnchorWindow(bundle, "return{CLAUDE_CODE_ENTRYPOINT", ".sessionEnvVars()}");
  const w3 = braceScanWindow(bundle, 'DISABLE_AUTOUPDATER:"1"');
  const named: [string, string | null][] = [
    ["W1 (spawn env literal)", w1],
    ["W2 (OnA base-env helper)", w2],
    ["W3 (Zrn shared-env helper)", w3],
  ];
  let degenerate = false;
  for (const [name, w] of named) {
    if (w == null) {
      flags.push(
        `spawn.env: ${name} window not found (start/end anchor missing or W3 brace/nested-template scan failed) — the env construction moved; re-derive its anchors; ${SPAWN_NO_BYPASS}`,
      );
      degenerate = true;
    } else if (w.length < 200 || w.length > 20000) {
      flags.push(
        `spawn.env: ${name} window length ${w.length} is outside the 200–20000 sanity band — likely a mis-anchored slice; re-derive; ${SPAWN_NO_BYPASS}`,
      );
      degenerate = true;
    }
  }
  if (degenerate) return { env: null, flags, keys: [], spreadCount: 0 };

  const env: Record<string, string> = {};
  const enumerated = new Set<string>();
  let hardFail = false;

  // Gate enumeration (W1 only — the sole window using gate-check conditionals): every referenced gate id
  // must be known. The helper name is minifier-assigned (At/et/…); match by shape. The `(?<![\w$])`
  // lookbehind keeps the match anchored to a full identifier so it can't start mid-token.
  for (const gm of (w1 as string).matchAll(/(?<![\w$])[A-Za-z_$][\w$]*\("(\d+)"\)/g)) {
    if (!(gm[1] in SPAWN_GATES)) {
      flags.push(
        `spawn.env: unknown gate id ${gm[1]} in a W1 env conditional — a NEW gate-conditional env var was introduced; ${SPAWN_ADVICE}`,
      );
      hardFail = true;
    }
  }

  const flagUnresolvable = (rawKey: string, expr: string) => {
    flags.push(
      `spawn.env: pinned key ${rawKey} has an unrecognized value expression \`${expr.slice(0, 60)}\` — its construction changed; re-derive its resolution; ${SPAWN_NO_BYPASS}`,
    );
    hardFail = true;
  };
  // Top-level / non-gate-spread key: allowlist-first, then it MUST be a registered pin (an unregistered
  // key here is an ADDITION → hard-fail so it is classified, never silently auto-pinned).
  // `apply=false` classifies the key (allowlisted / pinned / unknown) WITHOUT writing its value — used
  // for an OFF-gate conditional spread's inner keys (WI-4): the key must still be caught if it's brand
  // new, but its value must NOT be applied (an off-gate value must not override a W2 pin, e.g. off-gate
  // MCP_CONNECTION_NONBLOCKING:"0" must not clobber W2's "true"). A pinned key is still resolved so an
  // unresolvable value flags, but the resolved value is dropped when apply=false.
  // The chunk a window's text came from — value expressions inside it must be resolved against that
  // chunk's own bindings, not the joined bundle (see B11). Matched on a long prefix so the lookup is
  // unambiguous; falls back to the joined bundle when the graph isn't available.
  const chunkFor = (text: string): string | undefined =>
    files ? [...files.values()].find((c) => c.includes(text.slice(0, 200))) : undefined;

  const resolveInto = (rawKey: string, expr: string, target: Record<string, string>, apply = true, scope?: string) => {
    if (SPAWN_ENV_ALLOWLIST[rawKey] !== undefined) return; // deliberately not pinned
    if ((SPAWN_PIN_KEYS as readonly string[]).includes(rawKey)) {
      const r = resolveSpawnValue(bundle, expr, gates, scope, files);
      if ("unknown" in r) flagUnresolvable(rawKey, expr);
      else if (apply) target[rawKey] = r.value;
      return;
    }
    flags.push(`spawn.env: unknown key ${rawKey} constructed in the asar — ${SPAWN_ADVICE}`);
    hardFail = true;
  };
  // Inner key of an ON gate-conditional spread: the gate IS the classifier, so resolve first — a literal
  // value auto-pins (e.g. gate 434204418 on → MCP_CONNECT_TIMEOUT_MS:"10000"), a non-literal host value
  // (e.g. OAUTH_SCOPES:o.scope) stays allowlisted, anything else is unknown.
  const resolveGateInner = (rawKey: string, expr: string, target: Record<string, string>, scope?: string) => {
    const r = resolveSpawnValue(bundle, expr, gates, scope, files);
    if (!("unknown" in r)) target[rawKey] = r.value;
    else if (SPAWN_ENV_ALLOWLIST[rawKey] !== undefined) return;
    else {
      flags.push(`spawn.env: unknown key ${rawKey} constructed in a gate-ON conditional — ${SPAWN_ADVICE}`);
      hardFail = true;
    }
  };

  // Inner key of the 3p-only branch (`...<deploymentType==="3p">&&{…}` — located by CONTENT, see
  // THIRD_PARTY_BRANCH_MARKER). Classify by NAME ONLY: the branch is the classifier, and the harness
  // models a FIRST-PARTY session, so no value inside it can ever reach the modeled env.
  //
  //  - allowlisted → fine (this is what every "3p-provider-only branch" entry already means);
  //  - PINNED → fine, and deliberately NOT resolved. A pinned key earns its value from its 1p site in
  //    W1/W2; a 3p-only expression says nothing about it. Resolving here would (a) flag on shapes that
  //    are irrelevant to the modeled session — Desktop 1.37937.0's `String(i)`, where `i` is a
  //    chunk-local `let` — and (b) be actively dangerous if it DID resolve: `resolveConst` hops a
  //    1-char name against a whole 2 MB chunk, so a build whose first `i=` happened to be numeric would
  //    silently write a 3p value. W1 is applied last and would win either way, so nothing is lost.
  //  - unknown → still a hard-fail. A brand-new key must be classified even here, which is the whole
  //    point of keeping the branch enumerated rather than discarding it.
  const classifyThirdPartyInner = (rawKey: string) => {
    if (SPAWN_ENV_ALLOWLIST[rawKey] !== undefined) return;
    if ((SPAWN_PIN_KEYS as readonly string[]).includes(rawKey)) return;
    flags.push(`spawn.env: unknown key ${rawKey} constructed in the 3p-only deployment branch — ${SPAWN_ADVICE}`);
    hardFail = true;
  };

  // A window's non-gate-spread keys. Gate-conditional spreads (…<helper>("id")&&{…}) are handled first
  // (they must be resolved against gate STATE, not read as plain literals — an off-gate NONBLOCKING:"0"
  // must not override W2's "true"), then blanked so the generic pass never sees them. Helper name is
  // minifier-assigned (At/et/…); the leading `...` bounds the identifier start.
  const applyWindow = (text: string, target: Record<string, string>, isW1: boolean) => {
    let work = text;
    const scope = chunkFor(text);
    // The 3p-only branch (W3 today; W2 would be handled the same way). Blanked BEFORE the generic pass so
    // it never reads the branch's inner keys as unconditional 1p literals.
    //
    // NOT applied to W1, deliberately. W1 is the window every modeled 1p key comes from, so a marker
    // appearing there is either a Desktop restructure or a false positive — and blanking on either would
    // silently delete real pinned keys from the derived env, an all-or-nothing contract violated
    // quietly. Flag and let the generic pass run instead: worst case the branch's keys read as
    // unconditional (loud, diff-visible), never a silent deletion.
    if (isW1) {
      if (sliceThirdPartyBranch(work) !== null) {
        flags.push(
          `spawn.env: the 3p-only deployment branch (marker \`${THIRD_PARTY_BRANCH_MARKER}\`) now appears in W1, the window the ` +
            `modeled first-party env is derived from — re-derive which window owns the deployment split before trusting this env; ${SPAWN_NO_BYPASS}`,
        );
        hardFail = true;
      }
    } else {
      const tp = sliceThirdPartyBranch(work);
      if (tp) {
        for (const k of enumSpawnKeys(tp)) {
          enumerated.add(k.key);
          classifyThirdPartyInner(k.key);
        }
        work = work.replace(tp, "");
      }
    }
    if (isW1) {
      // B6: the gate helper acquired an `o.`-style receiver here too (`...o.isFeatureEnabled("id")&&{…}`);
      // without this widening the block is never blanked and the generic pass below reads its inner keys
      // (e.g. MCP_CONNECTION_NONBLOCKING:"0") as unconditional literals, silently corrupting a pinned value.
      for (const sm of text.matchAll(/\.\.\.(?:[\w$]+\.)?[A-Za-z_$][\w$]*\("(\d+)"\)&&\{([^{}]*)\}/g)) {
        const id = sm[1];
        const inner = sm[2];
        const gateOn = id in SPAWN_GATES && gates[id]?.on;
        for (const k of enumSpawnKeys("{" + inner)) {
          enumerated.add(k.key);
          const expr = sliceSpawnValue("{" + inner, k.valueStart);
          // ON gate: the gate IS the classifier — resolve + auto-pin (resolveGateInner). OFF gate (or an
          // unknown/non-SPAWN gate id): classify by name WITHOUT applying (WI-4) so a brand-new key in an
          // off-gate spread hard-fails instead of being silently enumerated, while a known off-gate key's
          // value stays unapplied (W2 wins).
          if (gateOn) resolveGateInner(k.key, expr, target, scope);
          else resolveInto(k.key, expr, target, false, scope);
        }
        work = work.replace(sm[0], "");
      }
    }
    for (const k of enumSpawnKeys(work)) {
      enumerated.add(k.key);
      resolveInto(k.key, sliceSpawnValue(work, k.valueStart), target, true, scope);
    }
  };

  // Construction order (later wins): W3 (Zrn, spread early by OnA) → W2 (OnA literals) → W1 (the inline
  // literals) so W1 overrides every key it sets — e.g. ENTRYPOINT W2 "claude-desktop" → W1 "local-agent".
  applyWindow(w3 as string, env, false);
  applyWindow(w2 as string, env, false);
  applyWindow(w1 as string, env, true);

  for (const req of REQUIRED_SPAWN_KEYS) {
    if (!enumerated.has(req)) {
      flags.push(
        `spawn.env: REQUIRED key ${req} is no longer constructed in W1∪W2∪W3 — the extraction seam broke or Cowork changed fundamentally; re-derive; ${SPAWN_NO_BYPASS}`,
      );
      hardFail = true;
    }
  }

  // Non-blocking: allowlist entries that no longer appear anywhere (prune candidates).
  for (const k of Object.keys(SPAWN_ENV_ALLOWLIST)) {
    if (!enumerated.has(k))
      flags.push(`NOTE: spawn.env allowlist entry ${k} is no longer constructed in the asar — prune it from SPAWN_ENV_ALLOWLIST`);
  }

  // WI-6: the constructed key SET, committed as provenance.spawnEnvKeys — a reviewable record and an
  // enumeration-regex-rot oracle (if enumSpawnKeys silently starts matching fewer keys, the committed
  // set shrinks and shows in `sync --diff`). It does NOT catch opaque-spread keys (those carry zero
  // statically-enumerable keys — WI-5 guards that surface); nor is it the under-match guard (that is
  // REQUIRED_SPAWN_KEYS + the prune NOTE). Emitted even on hardFail so a partial derivation's set is
  // still visible in the diff.
  const keys = [...enumerated].sort();
  // WI-5: count the `...`-spread SITES across the three spawn windows. A spread is either a recognized
  // gate-conditional / expandable helper OR an OPAQUE source (`...d.env`, `...h`, `...getOtelEnvVars(…)`)
  // that carries env keys enumeration can't see. spawnEnvKeys (WI-6) surfaces a new ENUMERABLE key; this
  // count surfaces a new SPREAD SITE — including an opaque one carrying non-enumerable keys, the one
  // channel spawnEnvKeys is blind to. Committed as provenance.spawnEnvSpreadCount; a change shows in
  // `sync --diff` (diff-surfacing, not a hard-fail — a benign minifier reshape must not fail CI).
  // Match every spread site `...<expr>` — an identifier (`...d`), a member (`...d.env`), OR a
  // PARENTHESIZED expression (`...(p?.accountId)&&{…}`, the real minifier shape for a conditional opaque
  // spread). An identifier-only regex missed the parenthesized form — the exact opaque shape this guards.
  // `(?!\.)` excludes only a pathological `....` run (no valid spread is `...` followed by a 4th dot).
  const spreadCount = [w1, w2, w3].reduce((n, w) => n + ((w as string).match(/\.\.\.(?!\.)/g)?.length ?? 0), 0);
  if (hardFail) return { env: null, flags, keys, spreadCount };
  return { env, flags, keys, spreadCount };
}

/**
 * Split deriveSpawnEnv flags into the two severities: "NOTE:"-prefixed prune hints become non-blocking
 * `notes` (prefix stripped; surfaced as SyncResult.notes in the sync output), everything else is a
 * hard-fail `delta` (→ unknownDeltas, blocking the baseline write).
 */
export function partitionSpawnFlags(flags: string[]): { deltas: string[]; notes: string[] } {
  const deltas: string[] = [];
  const notes: string[] = [];
  for (const f of flags) {
    if (f.startsWith("NOTE:")) notes.push(f.replace(/^NOTE:\s*/, ""));
    else deltas.push(f);
  }
  return { deltas, notes };
}

/**
 * S-tier sentinel: the structural/curated spawn facts the generator does NOT produce (scalar options,
 * tools/allowedTools heads + tail-guards, the FnA delete def+application, the negative invariant, the
 * two prompt-asset delivery shapes). Any anchor miss → a flag naming the field (re-derive the anchor).
 * Pure over the bundle string, mirroring checkMountModeFacts.
 */
export function checkSpawnContractFacts(bundle: string, files?: Map<string, string>): string[] {
  const flags: string[] = [];
  const w1 = twoAnchorWindow(bundle, "env:{CLAUDE_CONFIG_DIR", ",systemPrompt:");
  const w2 = twoAnchorWindow(bundle, "return{CLAUDE_CODE_ENTRYPOINT", ".sessionEnvVars()}");
  const has = (re: RegExp, s = bundle) => re.test(s);
  const miss = (field: string, why: string) => flags.push(`spawn: ${field} anchor missing — ${why}; ${SPAWN_NO_BYPASS}`);
  // The chunk holding a reference site — needed to read that chunk's own require() bindings when a
  // spread/arm is a mangled namespace property. Falls back to the joined bundle in single-text mode.
  const siteOf = (needle: string): string => (files ? ([...files.values()].find((c) => c.includes(needle)) ?? bundle) : bundle);

  if (!has(/settingSources:\["user"\]/)) miss("S2 settingSources", 'settingSources:["user"] is gone');
  if (!has(/permissionMode:.{0,24}\?"default"/)) miss("S3 permissionMode", "the default-permissionMode ternary is gone");
  {
    // The `?<const>:0}` max-thinking pin appears in two build shapes: inline at the `maxThinkingTokens:`
    // key (older monolithic builds) OR hoisted into a small helper `return e??t??!r?<const>:0}` (the
    // ternary was extracted into a named function, so the value expression at the key is now a call with
    // commas and no longer matches an inline capture). Either branch captures the value-holding const,
    // which must still resolve to 31999 — a mis-capture fails that check loudly rather than false-greening.
    // B3: the ternary arm may now be a member expression (`o.DEFAULT_MAX_THINKING_TOKENS`) instead of a
    // bare const — the body-shape anchor (branch 2) stays the disambiguator (globally unique, shape- not
    // name-keyed); only the arm capture widens to admit a dot, then a dotted arm is resolved through the
    // export-alias hop before the 31999 assertion.
    const m = bundle.match(/(?:maxThinkingTokens:[^,}]{0,60}|return [\w$]+\?\?[\w$]+\?\?![\w$]+)\?([\w$.]+):0\}/);
    if (!m) miss("S4 maxThinkingTokens", "the maxThinkingTokens capture is gone");
    else {
      // B6 (Desktop 1.25927.0): the arm is a MANGLED namespace property (`E.f`) reached through the
      // reference chunk's own require() binding — the old bare-name hop on the joined bundle captured a
      // stray `f=…` and wrongly reported "resolved to null", while the real value is unchanged.
      const site = siteOf(m[0]);
      const ref = resolveNamespaceRef(m[1], site, files);
      const resolved = ref ? resolveConst(ref.chunk, ref.local) : null;
      if (resolved !== "31999") miss("S4 maxThinkingTokens", `resolved to ${resolved} not 31999`);
    }
  }
  if (!has(/\.effort\b.{0,60}:"medium"/)) miss("S5 effortDefault", 'the .effort … :"medium" default is gone');
  if (!has(/\/sessions\/\$\{[^}]+\}\/mnt\/\.claude/)) miss("S1 configDirInGuest", "the mnt/.claude session-path template is gone");

  // A1: the spread target may now be a member expression (`...o.TASK_TOOL_NAMES`) instead of a bare
  // hoisted local const; widen the capture to admit `.`/`$` while the literal head+tail stay the anchor.
  // A4 (Desktop 1.21459.0): an INERT design-tools spread `...o.CLAUDE_DESIGN_TOOLS` may now sit between
  // "Task" and "Bash". It resolves to an EMPTY array on first-party (deployment-gated off, like the
  // {{modelIdentity}} placeholder / the S17 negative invariant), so the rendered tools[] is unchanged and
  // the hand-pinned spawn.tools stays 20 entries. Admit the spread OPTIONALLY (older asars lack it);
  // S6b below resolves it and REQUIRES it empty — if a future build populates it, S6b fails loud (a real
  // spawn tool set to model), never silently absorbed. Capture groups: s6[1]=optional design-tools spread
  // id (undefined on older asars), s6[2]=TASK_TOOL_NAMES spread id.
  // A5 (Desktop 1.28929.0): a conditional `...<cond>?["Artifact"]:[]` spread may now sit between
  // "AskUserQuestion" and "ToolSearch" — the "frame artifacts" feature. It renders EMPTY on a default
  // first-party session (the condition requires the server-delivered session flag frameArtifactsEnabled,
  // which is off by default), so the hand-pinned spawn.tools stays 20 entries. Admit it OPTIONALLY (older
  // asars lack it); S6c below walks the condition's definition and REQUIRES it to still be the
  // frame-artifacts predicate — a widened or unconditional Artifact fails loud, never silently absorbed.
  // The condition capture is deliberately narrow (bare local identifier, no dots): the live construct is
  // a scope-local boolean, and S6c's resolution assumes that. A dotted/complex condition simply fails the
  // optional group, breaks head↔tail adjacency, and trips S6 for reclassification — the safe direction.
  // Capture groups: s6[1]=optional design-tools spread id, s6[2]=TASK_TOOL_NAMES spread id,
  // s6[3]=optional Artifact spread condition id (undefined on older asars).
  const s6 = bundle.match(
    /tools:\["Task",(?:\.\.\.([\w.$]+),)?"Bash","Glob","Grep","Read","Edit","Write","NotebookEdit","WebFetch",\.\.\.([\w.$]+),"WebSearch","Skill","REPL","JavaScript","AskUserQuestion",(?:\.\.\.([\w$]+)\?\["Artifact"\]:\[\],)?"ToolSearch"/,
  );
  if (!s6) miss("S6 tools head", "the tools[] head list moved");
  else {
    // S6b: the optional `...CLAUDE_DESIGN_TOOLS` head spread must resolve to an EMPTY array. A dotted id
    // (`o.CLAUDE_DESIGN_TOOLS`) is an export-alias hop (`CLAUDE_DESIGN_TOOLS:Cde` / `=Cde`) to the real
    // array site (`,Cde=[]`) — follow it exactly as S7 does below. Fail loud if the spread is present but
    // unresolvable, or resolves to a non-empty array (a new design tool set that must be modeled).
    const toolsSite = siteOf(s6[0]);
    const designId = s6[1];
    if (designId !== undefined) {
      const ref = resolveNamespaceRef(designId, toolsSite, files);
      if (!ref) miss("S6b design-tools", "the CLAUDE_DESIGN_TOOLS export alias could not be resolved");
      else if (!new RegExp(`(?<![\\w$])${ref.local.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=\\[\\]`).test(ref.chunk))
        miss("S6b design-tools", "CLAUDE_DESIGN_TOOLS is no longer empty — a new spawn tool set to model");
    }
    // A2: a dotted id (`o.TASK_TOOL_NAMES`) is not a local-const definition — it is an export-alias hop
    // (`TASK_TOOL_NAMES:uae` / `TASK_TOOL_NAMES=uae`) to the real array site (`,uae=[...]`). Follow the
    // hop (identifier-shaped capture only, so a `:0`-style decoy can't be captured) and require the exact
    // five-name array at the resolved alias — never resolveConst, whose 40-char/no-comma value budget
    // can't hold the array literal. A bare id keeps the original local-const lookup.
    const taskArray = `\\["TaskCreate","TaskUpdate","TaskGet","TaskList","TaskStop"\\]`;
    const ref = resolveNamespaceRef(s6[2], toolsSite, files);
    if (!ref) miss("S7 Task-tools spread", "the TASK_TOOL_NAMES export alias could not be resolved");
    else if (!new RegExp(`(?<![\\w$])${ref.local.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=${taskArray}`).test(ref.chunk))
      miss("S7 Task-tools spread", "the TaskCreate…TaskStop spread that tools[] injects moved");

    // S6c (Desktop 1.28929.0): the Artifact spread's condition must STILL be the frame-artifacts
    // predicate. Walk the real chain `cond -> attended-wrapper -> predicate`, capturing each callee
    // rather than hard-coding minified names; only the PROPERTY names are stable and only they are
    // anchored on.
    //
    // Neither existing helper applies here. `resolveNamespaceRef` no-ops on an undotted ref (it returns
    // the site chunk + the ref verbatim), and `resolveConst`'s `[^,;)]{1,40}` value budget resolves a
    // DIFFERENT `de=` binding in this chunk (the chunk-namespace require near its top), not the local.
    // Hence the windowed, scope-local definition lookup below.
    //
    // The condition is matched as a WHOLE expression, anchored at both ends. Fragment matching is not
    // enough and was the defect in an earlier draft of this check: appending `||!0`, flipping the cached
    // arm from `??!1:!1` to `??!0:!0`, or replacing the trailing HIPAA conjunct with a literal all make
    // Artifact unconditional while still containing the right function call. Each of those is a
    // mutation-tested failure now.
    //
    // IF THIS EVER FIRES AND THE TOOL HAS TO BE MODELED: `Artifact` is in tools[] but deliberately NOT in
    // allowedTools (S9 pins that head at 19 entries) — it is tools-only, exactly like AskUserQuestion, so
    // it is NOT pre-approved and every call transits can_use_tool. Model it as a GATED tool; treating it
    // as allowed would false-green a permission prompt production raises. It is also VM-loop-only
    // D7 (Desktop 1.32352.0): the predicate DROPPED its `!isHostLoop` conjunct, at the call site and in
    // the body, so `Artifact` now reaches the HOST-LOOP tier too when the server flag is on. Earlier
    // guidance here said the host-loop tier was "correct by construction and must not gain it" — that is
    // no longer true, and the same release added a host-loop-only Artifact approval guard (see
    // checkPathHookFacts' wrapper rules), which is the corroborating evidence. Both term lists are
    // admitted so an older Desktop still syncs; what is pinned is that the REMAINING terms are intact.
    const artifactCond = s6[3];
    if (artifactCond !== undefined) {
      const escC = artifactCond.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const at = toolsSite.indexOf(s6[0]);
      // Definition sits ~900 chars before the tools literal in the same function; 8000 is ~9x headroom
      // and fails CLOSED (miss) if a future build hoists it out, while still excluding same-named locals
      // in other function scopes.
      const win = toolsSite.slice(Math.max(0, at - 8000), at);
      const def = win.match(new RegExp(`(?:\\b(?:const|let|var)\\s+|[,;({])${escC}=([^;]*);`));
      if (!def)
        miss(
          "S6c Artifact gate",
          "the Artifact spread condition's definition is not in the spawn window — classify it, never absorb an unconditional Artifact",
        );
      else {
        // Whole-expression shape: (<sess> ? <built>?.builtTools===void 0 ? <F>(<args>) :
        //   <sess>.frameArtifactsTurnEnabled ?? !1 : !1) && !<hipaa>.r()
        // B17 (Desktop 1.30096.1): the trailing conjunct's MEMBER NAME was hard-coded as `\.r\(\)`. Only
        // the namespace was wildcarded, so the pure minifier rename `A.r()` -> `t.hu()` hard-blocked a
        // predicate that is byte-for-byte equivalent (verified conjunct-by-conjunct). Minified member
        // names rotate every build exactly like literals do — capture the callee and RESOLVE it instead.
        // The expression stays anchored `^...$`: that is what makes R1 (`||!0` appended) and R3 (conjunct
        // replaced by a literal) fire, and both must keep firing after this change.
        const whole = def[1].match(
          /^\(([\w$]+)\?[\w$]+\?\.builtTools===void 0\?([\w$]+)\(([^)]*)\):\1\.frameArtifactsTurnEnabled\?\?!1:!1\)&&!([\w$]+(?:\.[\w$]+)?)\(\)$/,
        );
        if (!whole)
          miss(
            "S6c Artifact gate",
            "the Artifact condition is no longer exactly the frame-artifacts expression (cached-arm/HIPAA/trailing-term change) — reclassify before admitting the spread",
          );
        else if (!/isBridgeSession:/.test(whole[3]) || !/isDispatchChild:/.test(whole[3]))
          miss(
            "S6c Artifact gate",
            "the frame-artifacts predicate is no longer passed isBridgeSession/isDispatchChild — the tier restriction may have been emptied",
          );
        else {
          // Attended-turn wrapper: function F(e,t){return P(e,t)&&e._isUnattended!==!0}
          const wrap = toolsSite.match(
            new RegExp(`function ${whole[2]}\\(([\\w$]+),([\\w$]+)\\)\\{return ([\\w$]+)\\(\\1,\\2\\)&&\\1\\._isUnattended!==!0\\}`),
          );
          if (!wrap) miss("S6c Artifact gate", "the attended-turn wrapper body changed — _isUnattended may no longer restrict Artifact");
          else if (
            !new RegExp(
              `function ${wrap[3]}\\(([\\w$]+),([\\w$]+)\\)\\{return \\1\\.frameArtifactsEnabled===!0&&\\1\\.sessionType===void 0&&\\1\\.scheduledTaskId===void 0&&!\\2\\.isBridgeSession&&!\\2\\.isDispatchChild&&(?:!\\2\\.isHostLoop&&)?`,
            ).test(toolsSite)
          )
            miss(
              "S6c Artifact gate",
              "the frame-artifacts predicate changed (a term was dropped or reordered) — re-verify sessionType/scheduledTaskId/isBridgeSession/isDispatchChild before admitting the spread",
            );
          // S6e (B17): the trailing conjunct must still be the HIPAA-restriction reader. Resolving it is
          // what the old hard-coded `.r()` only pretended to do — that regex accepted ANY single-letter
          // member, so re-pointing the conjunct at a different export would have passed silently.
          //
          // TWO hops, because the reader does not itself name the gate:
          //     function GL(){return WL()==="restricted"}                 <- hop 1 (the resolved local)
          //     function WL(){...RL("coworkHipaaRestricted")?...}         <- hop 2 (names the gate)
          // Hop 1 pins the ==="restricted" COMPARISON, which no proximity check can do; hop 2 reads a
          // brace-scanned body, never a window (see braceBodyOf for why a window cannot fail).
          // Resolution failure is a MISS, never a skip: failing open here is exactly how a guard that
          // cannot fail gets shipped.
          const hipaa = resolveNamespaceRef(whole[4], toolsSite, files);
          if (!hipaa)
            miss(
              "S6c Artifact gate",
              `the trailing HIPAA conjunct (${whole[4]}) could not be resolved to its definition — classify it before admitting the spread`,
            );
          else {
            const h1 = hipaa.chunk.match(
              new RegExp(`function ${hipaa.local.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\(\\)\\{return ([\\w$]+)\\(\\)==="restricted"\\}`),
            );
            if (!h1)
              miss(
                "S6c Artifact gate",
                'the trailing conjunct no longer resolves to a `<f>()==="restricted"` reader — Artifact may no longer be HIPAA-restricted',
              );
            else {
              const body = braceBodyOf(hipaa.chunk, `function ${h1[1]}(`);
              if (!body || !body.includes("coworkHipaaRestricted"))
                miss(
                  "S6c Artifact gate",
                  "the restriction reader no longer consults coworkHipaaRestricted — the HIPAA conjunct may be inert",
                );
            }
          }
        }
      }
    }

    // S6d: the frame-artifacts spawn-env key is ALLOWLISTED (deliberately absent from the pinned baseline
    // because a default session never receives it), and allowlisting is unconditional by construction —
    // resolveInto returns on the allowlist hit regardless of the surrounding construct. So without this
    // check, Desktop making the key unconditional would surface only as a non-blocking spawnEnvSpreadCount
    // row, and re-keying it onto a different variable would surface nothing at all.
    //
    // The assertion is an EQUIVALENCE: the Artifact tool spread and the env-key spread must both be
    // present or both absent, and when present must share ONE condition identifier. Searched in the spawn
    // chunk (the identifier is scope-local), never the joined bundle.
    const envKeySpread = new RegExp(`\\.\\.\\.([\\w$]+)&&\\{CLAUDE_CODE_COWORK_FRAME_ARTIFACTS:"1"\\}`).exec(toolsSite);
    if (artifactCond !== undefined && !envKeySpread)
      miss(
        "S6d frame-artifacts env key",
        "the Artifact tool spread is present but CLAUDE_CODE_COWORK_FRAME_ARTIFACTS is no longer constructed from it",
      );
    else if (artifactCond === undefined && envKeySpread)
      miss(
        "S6d frame-artifacts env key",
        "CLAUDE_CODE_COWORK_FRAME_ARTIFACTS is constructed without the Artifact tool spread — the allowlist entry would admit it unchecked",
      );
    else if (artifactCond !== undefined && envKeySpread && envKeySpread[1] !== artifactCond)
      miss(
        "S6d frame-artifacts env key",
        "CLAUDE_CODE_COWORK_FRAME_ARTIFACTS is gated on a different predicate than the Artifact tool — reclassify before the allowlist keeps admitting it",
      );
  }
  // S8 (widened, Desktop 1.28929.0): pin the WHOLE tools[] tail through its closing bracket, not just the
  // first spread after "ToolSearch". The old anchor stopped at `...X.sessionType===`, so anything appended
  // after the SendUserMessage spread was invisible to both S6 and S8 — defeating S8's own stated purpose.
  // The tail already carries a second conditional spread (`...<cond>?[<alias>]:[]`, a project-session-only
  // tool) which was pre-existing and therefore not a sync blocker, but was covered by no anchor at all.
  // Both ends are RESOLVED, not shape-matched: swapping the alias to a different tool, or widening the
  // condition to another identifier, must fail — a bare shape match admits both silently.
  {
    const s8 = bundle.match(
      /"ToolSearch",\.\.\.([\w$]+)\.sessionType==="agent"\?\["SendUserMessage"\]:\[\],\.\.\.([\w$]+)\?\[([\w$.]+)\]:\[\]\],allowedTools:\["Task"/,
    );
    if (!s8) miss("S8 tools tail-guard", "the tools[] tail moved — a tool appended after ToolSearch would evade S6");
    else {
      const tailSite = siteOf(s8[0]);
      // The trailing spread's alias must still resolve to the project-session tool name.
      const aliasRef = resolveNamespaceRef(s8[3], tailSite, files);
      if (!aliasRef) miss("S8 tools tail-guard", "the trailing tool-spread alias could not be resolved");
      else if (!new RegExp(`(?<![\\w$])${aliasRef.local.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}="Projects"`).test(aliasRef.chunk))
        miss("S8 tools tail-guard", "the trailing conditional tool is no longer Projects — a new spawn tool to classify");
      // …and its condition must still be the project-session discriminator, not a widened/always-true one.
      else if (!new RegExp(`toolModeProjectUuid:${s8[2].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`).test(tailSite))
        miss(
          "S8 tools tail-guard",
          "the trailing tool spread is no longer gated on toolModeProjectUuid — it may now render unconditionally",
        );
    }
  }
  // A3: same member-expression spread widening as S6.
  if (
    !has(
      /allowedTools:\["Task","Bash","Glob","Grep","Read","Edit","Write","NotebookEdit","WebFetch",\.\.\.[\w.$]+,"WebSearch","Skill","REPL","JavaScript","ToolSearch"/,
    )
  )
    miss("S9 allowedTools head", "the allowedTools[] head list moved (AskUserQuestion is tools-only)");
  if (!has(/allowedTools:\[[^\]]{0,400}"ToolSearch","mcp__/)) miss("S10 allowedTools tail-guard", "the built-in→mcp__ boundary moved");
  // S10b (Desktop 1.37937.0): S9 pins the built-in HEAD and S10 only the built-in→mcp__ BOUNDARY, so the
  // `mcp__` region between the boundary and the closing bracket was unguarded — and a real addition
  // (`mcp__plugins__search_connectors`) shipped through both of them green. Pin the membership itself.
  // A set comparison, not a literal regex, so the flag NAMES the delta instead of just saying "moved".
  {
    const arr = sliceAllowedToolsArray(bundle);
    if (arr == null) miss("S10b allowedTools mcp__ membership", "the allowedTools[] array could not be sliced");
    else {
      const seen = new Set((arr.match(/"mcp__[^"]*"/g) ?? []).map((s) => s.slice(1, -1)));
      const pinned = new Set(SPAWN_ALLOWED_MCP_TOOLS);
      const added = [...seen].filter((t) => !pinned.has(t)).sort();
      const gone = [...pinned].filter((t) => !seen.has(t)).sort();
      if (added.length > 0 || gone.length > 0)
        miss(
          "S10b allowedTools mcp__ membership",
          `the allowedTools[] mcp__ set changed${added.length ? ` (+${added.join(", ")})` : ""}${gone.length ? ` (-${gone.join(", ")})` : ""}` +
            " — classify each entry (which server serves it, and whether it is offered on the 1p deployment) before re-pinning SPAWN_ALLOWED_MCP_TOOLS",
        );
    }
  }

  // S11/S12 scoped to W1; S13 scoped to W2 — the earn-the-pin assertions for local-agent / cron / provider.
  if (!w1 || !has(/CLAUDE_CODE_ENTRYPOINT:"local-agent"/, w1))
    miss("S11 ENTRYPOINT local-agent", "the W1 local-agent entrypoint literal is gone");
  if (!w1 || !has(/disableCron:!0/, w1) || !has(/localAgent:!0/, w1))
    miss("S12 OnA call args", "disableCron:!0 / localAgent:!0 no longer earn the DISABLE_CRON / PROVIDER_MANAGED_BY_HOST pins");
  if (!w2 || !has(/CLAUDE_CODE_DISABLE_CRON:[\w$]+\.disableCron\?"1":""/, w2))
    miss("S13 DISABLE_CRON ternary", "the disableCron?'1':'' shape changed");
  // B7 (Desktop 1.25927.0): the loop binding is emitted as `let` in the new codegen (`for(let t of[…])`).
  // The binding keyword is a minifier choice, never a contract fact — admit all three. Its NAME is a
  // minifier choice too, hence `[\w$]+` (a `$`-initial name is legal and `\w` cannot match it).
  if (!has(/for\((?:const|let|var) [\w$]+ of\s*\[?"ANTHROPIC_API_KEY","ANTHROPIC_AUTH_TOKEN","ANTHROPIC_CUSTOM_HEADERS"\]/))
    miss("S14a FnA definition", "the empty-ANTHROPIC_* delete helper is gone");
  // The blank-empties helper must be CALLED on the same env object that just received ANTHROPIC_CUSTOM_HEADERS
  // (…},helper(X.env)). The sdkOptions var name is minifier-assigned (V→F across builds); capture it and
  // backreference so the guarantee "blank runs on THIS env" survives the rename without hardcoding the name.
  // B5: both env helper calls may now carry a namespace-method receiver (`o.appendCoworkTelemetryHeaders`
  // / `o.dropEmptyAuthEnvSentinels`); the `([\w$]+)\.env … \1\.env` backreference — the guarantee that the
  // blank-sentinel helper runs on the SAME env object — is untouched by the added optional receivers.
  // B8 (Desktop 1.32885.1): the CALLEE names are minifier-assigned and drew `$s` this build, so both
  // callee slots are `[\w$]+`. The captured env binding is `([\w$]+)` — the older `(\w+\$?)` admitted a
  // TRAILING `$` only, so a `$`-initial name would still have missed even with the callees widened.
  if (!has(/ANTHROPIC_CUSTOM_HEADERS:(?:[\w$]+\.)?[\w$]+\(([\w$]+)\.env[\s\S]{0,40}\},(?:[\w$]+\.)?[\w$]+\(\1\.env\)/))
    miss(
      "S14b FnA application",
      "the empty-ANTHROPIC_* blank helper no longer runs on the spawn env — the '' blanks would leak into production",
    );
  if (!has(/preset:"claude_code"/)) miss("S15 promptTemplate delivery", "the claude_code preset-append delivery site is gone");
  // B4: the generator call may now carry a namespace-method receiver (`I.buildSubagentEnvironmentPrompt`);
  // the object-literal first-arg `{` survived live, so it stays part of the anchor (stronger than a bare call).
  if (!has(/appendSubagentSystemPrompt:(?:[\w$]+\.)?[\w$]+\(\{/))
    miss("S16 subagentAppend generator", "the per-session subagent-append generator call shape is gone");
  // Negative invariant: the spawn env must never CONSTRUCT this key (it would flip the agent to
  // cowork_settings.json/cowork_plugins). The bundled SDK's typed env-var registry legitimately DECLARES
  // the key as a lazy module-export getter (`CLAUDE_CODE_USE_COWORK_PLUGINS:()=>…`); that declaration is
  // not a spawn-env construction, so exclude the `:()=>` getter shape. A real construction
  // (`KEY:"1"`, `KEY:gate?"1":""`, `…cond&&{KEY:…}`) still matches and fires.
  if (has(/CLAUDE_CODE_USE_COWORK_PLUGINS\s*:(?!\(\)=>)/))
    flags.push(
      `spawn: NEGATIVE INVARIANT S17 broken — CLAUDE_CODE_USE_COWORK_PLUGINS is now SET; it would flip the agent to cowork_settings.json/cowork_plugins; ${SPAWN_NO_BYPASS}`,
    );
  // B1: same optional namespace-method receiver on the gate helper as the resolveSpawnValue recognizer.
  if (!w1 || !has(/CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES:(?:[A-Za-z_$][\w$]*\.)?[A-Za-z_$][\w$]*\("66187241"\)\?"true":""/, w1))
    miss("S18 EMIT_TOOL_USE_SUMMARIES gate-ternary", "the gate-id↔key association changed");
  if (!w1 || !has(/CLAUDE_CODE_TAGS:`lam_session_type:\$\{/, w1))
    miss("S19 CLAUDE_CODE_TAGS template", "the lam_session_type template shape changed");
  // S20: the per-model effort/regex-default config (extractModelEffortConfig) is a structural drift
  // anchor, not a hand-pinned fact — re-run the extractor and confirm its own anchors still resolve AND
  // that the four model classes documented alongside it (two literal-with-picker, two no-picker, the
  // fable|mythos regex-default) are still shaped as expected. A miss here means the model-config moved
  // and the synced spawn.effortByModel/effortRegexDefault would silently go stale.
  {
    const { config } = extractModelEffortConfig(bundle);
    if (!config) miss("S20 modelEffortConfig", "extractModelEffortConfig could not resolve the per-model config (see its own flags)");
    else {
      // Deliberately NOT every picker model — this is a CLASS-shape floor, and four entries already
      // over-cover a one-class check. Adding each new model (e.g. claude-opus-5) would buy no extra class
      // coverage while making the sentinel fire spuriously the day that model is retired. A new model's
      // exact config is pinned far more precisely by the golden oracle, which deep-equals the whole map
      // against the live asar (test/fixtures/model-effort-config.golden.json).
      const withPicker = ["claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6"];
      const noPicker = ["claude-haiku-4-5", "claude-sonnet-4-5"];
      for (const m of withPicker)
        if (!config.effortByModel[m]?.effortLevels?.length)
          miss("S20 modelEffortConfig", `expected class-1 (picker) model ${m} is missing or has no effortLevels`);
      for (const m of noPicker)
        if (config.effortByModel[m] === undefined || config.effortByModel[m].effortLevels !== undefined)
          miss("S20 modelEffortConfig", `expected class-2 (no-picker) model ${m} is missing or unexpectedly has effortLevels`);
      if (!config.effortRegexDefault.pattern.includes("fable") || !config.effortRegexDefault.pattern.includes("mythos"))
        miss("S20 modelEffortConfig", "the fable|mythos class regex pattern is gone from the regex-default entry");
    }
  }
  return flags;
}

// ==========================================================================================
// Per-model effort config extraction (Phase 0 of the reasoning-config fidelity work): the literal
// per-model map (each entry's {effortLevels?, recommended?, modes?}) and the regex-default entry +
// class regex that applies to ids not in the literal map (e.g. fable/mythos-family ids). Located by
// CONTENT — the regex-default entry's exact literal shape and the class regex's own source — never by
// the minified identifier, which is minifier-assigned and not asserted to stay stable across builds.
// ==========================================================================================

interface ModelEffortEntry {
  effortLevels?: string[];
  recommended?: string;
  modes?: string[];
  /** Present on a per-model entry since Desktop 1.24012.9, where `claude-opus-5` became the first literal-map
   *  entry to carry it (previously it appeared only on the regex-default entry). Optional: most entries omit it. */
  disallowThinkingDisabled?: boolean;
}

interface EffortRegexDefault {
  /** The class regex's SOURCE (RegExp.prototype.source form, no delimiters) — the pattern selecting this
   *  entry for a model id not present in the literal per-model map. */
  pattern: string;
  effortLevels: string[];
  recommended: string;
  modes: string[];
  disallowThinkingDisabled: boolean;
}

export interface ModelEffortConfig {
  effortByModel: Record<string, ModelEffortEntry>;
  effortRegexDefault: EffortRegexDefault;
}

/** Balanced-brace scan starting AT an opening `{` (index `open`). String-aware (skips "…"/'…' spans —
 *  the model-config object literals contain no template strings). Returns the index just past the
 *  matching closing `}`, or -1 if the braces never balance before the bundle ends. */
function scanBalancedObject(text: string, open: number): number {
  let depth = 0;
  let q: string | null = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === "\\") i++;
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Parse a `["a","b",...]` array-literal body (the text between the brackets) into a string array. */
function parseQuotedArray(inner: string): string[] {
  return [...inner.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
}

/** Parse one model/regex-default entry's `{...}` body text for the fields the config carries. The
 *  regex-default caller does NOT take `disallowThinkingDisabled` from here — it sets that from its own
 *  anchor capture — so parsing it is additive for the per-model entries only. */
function parseModelEntryBody(body: string): ModelEffortEntry {
  const entry: ModelEffortEntry = {};
  const el = body.match(/effortLevels:\[([^\]]*)\]/);
  if (el) entry.effortLevels = parseQuotedArray(el[1]);
  const rec = body.match(/recommended:"([^"]*)"/);
  if (rec) entry.recommended = rec[1];
  const modes = body.match(/modes:\[([^\]]*)\]/);
  if (modes) entry.modes = parseQuotedArray(modes[1]);
  // Minified booleans (`!0`/`!1`) and plain ones both occur; absent stays absent rather than defaulting
  // to false, so the baseline distinguishes "production omits it" from "production sets it false".
  const dtd = body.match(/disallowThinkingDisabled:(!0|!1|true|false)/);
  if (dtd) entry.disallowThinkingDisabled = dtd[1] === "!0" || dtd[1] === "true";
  return entry;
}

/**
 * Extract Cowork's per-model effort config: the literal per-model map (each id's {effortLevels?,
 * recommended?, modes?}), the regex-default entry (the config used for an id not in the literal map but
 * matching the class regex), and the class regex's own source. All three are declared back-to-back in the
 * asar as one `const <a>={...regex-default...},<b>={...literal map...},<c>=/<class regex>/` statement;
 * located here by the regex-default entry's exact literal shape (content-anchored, minifier-name-proof),
 * then the literal map by balanced-brace scan, then the class regex by its own known source. Any anchor
 * miss returns `config:null` + a flag naming what moved — mirrors deriveSpawnEnv's all-or-nothing contract
 * (never a partial/guessed map reaching the baseline).
 */
export function extractModelEffortConfig(bundle: string): { config: ModelEffortConfig | null; flags: string[] } {
  const flags: string[] = [];
  const fail = (msg: string): { config: null; flags: string[] } => {
    flags.push(`modelEffortConfig: ${msg}`);
    return { config: null, flags };
  };

  // Anchor 1: the regex-default entry's exact literal content (fixed key order: effortLevels, recommended,
  // modes, disallowThinkingDisabled) — this IS the content anchor, not a name.
  const marker =
    /\{effortLevels:\["low","medium","high","xhigh","max"\],recommended:"high",modes:\["auto"\],disallowThinkingDisabled:(!0|!1|true|false)\}/;
  const mm = marker.exec(bundle);
  if (!mm || mm.index == null)
    return fail(
      "regex-default entry (effortLevels/recommended/modes/disallowThinkingDisabled literal) not found — the model-config shape moved",
    );
  const markerEnd = mm.index + mm[0].length;

  // Anchor 2: immediately after the regex-default entry, `,<ident>={` opens the literal per-model map.
  const afterMarker = bundle.slice(markerEnd);
  const mapOpen = afterMarker.match(/^,[A-Za-z_$][\w$]*=\{/);
  if (!mapOpen) return fail("literal per-model map does not immediately follow the regex-default entry — declaration order changed");
  const mapBraceIdx = markerEnd + mapOpen[0].length - 1; // index of the map's opening "{"
  const mapCloseIdx = scanBalancedObject(bundle, mapBraceIdx);
  if (mapCloseIdx < 0) return fail("literal per-model map brace scan did not balance");
  const mapBody = bundle.slice(mapBraceIdx + 1, mapCloseIdx - 1); // strip the outer { }

  // Anchor 3: immediately after the literal map, `,<ident>=<regex-literal>` — the class regex (asserted by
  // its known fable|mythos source, not by identifier name).
  const afterMap = bundle.slice(mapCloseIdx);
  const regexClass = afterMap.match(/^,[A-Za-z_$][\w$]*=\/(\^\(\?:claude-\)\?\(\?:fable\|mythos\)\(\?:-\|\$\))\//);
  if (!regexClass)
    return fail("class regex (fable|mythos) does not immediately follow the literal per-model map — declaration order changed");

  // Parse the literal map's top-level `"id":{...}` entries. No entry body nests a `{`, so a non-brace
  // char-class body match is safe (a future nested-object entry would fail this scan, not silently truncate).
  const effortByModel: Record<string, ModelEffortEntry> = {};
  // The key class carries `$` purely to keep the file-wide invariant at zero exceptions (see
  // sync-sentinel-identifier-classes.test.ts): these keys are model ids like `claude-haiku-4-5`, which
  // never contain `$`, so admitting it cannot widen what this actually matches.
  for (const em of mapBody.matchAll(/"([\w$.-]+)":\{([^{}]*)\}/g)) effortByModel[em[1]] = parseModelEntryBody(em[2]);
  if (Object.keys(effortByModel).length === 0) return fail("literal per-model map parsed to zero entries — parser or shape drifted");

  const regexDefaultEntry = parseModelEntryBody(mm[0]);
  if (!regexDefaultEntry.effortLevels || !regexDefaultEntry.recommended || !regexDefaultEntry.modes)
    return fail("regex-default entry parsed with a missing field (effortLevels/recommended/modes) — parser or shape drifted");

  return {
    config: {
      effortByModel,
      effortRegexDefault: {
        pattern: regexClass[1],
        effortLevels: regexDefaultEntry.effortLevels,
        recommended: regexDefaultEntry.recommended,
        modes: regexDefaultEntry.modes,
        disallowThinkingDisabled: mm[1] === "!0" || mm[1] === "true",
      },
    },
    flags,
  };
}

/**
 * Canonical env key order: keys present in the previous baseline keep their base order; genuinely new
 * keys are appended alphabetically after them. A pure Cowork source-reorder then yields a zero-line git
 * diff, an added key is one clean +line at a deterministic spot, and a value change is a single -/+ pair.
 */
export function canonicalizeEnv(
  next: Record<string, string> | undefined,
  base: Record<string, string> | undefined,
): Record<string, string> {
  const src = next ?? base ?? {};
  const baseOrder = Object.keys(base ?? {});
  const out: Record<string, string> = {};
  for (const k of baseOrder) if (k in src) out[k] = src[k];
  const added = Object.keys(src)
    .filter((k) => !(k in out))
    .sort();
  for (const k of added) out[k] = src[k];
  return out;
}

function sliceCowork(bundle: string): string {
  // Concatenate windows around cowork-defining tokens; if these vanish, fingerprint
  // shifts and the runbook tells you to re-derive the extractor.
  const tokens = [
    "vmAllowedDomains",
    "vm_network_mode",
    "buildArgs",
    "/sessions/",
    "mnt/uploads",
    "coworkEgressAllowedHosts",
    '?"rwd":"rw"',
  ];
  let acc = "";
  for (const t of tokens) {
    const i = bundle.indexOf(t);
    if (i >= 0) acc += bundle.slice(i, i + 200);
  }
  return acc;
}

function readDesktopAppVersion(): string | null {
  // Info.plist CFBundleShortVersionString.
  try {
    const plist = readFileSync("/Applications/Claude.app/Contents/Info.plist", "utf8");
    const m = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

const readIf = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : null);

/**
 * read a user config JSON, distinguishing the three states a try/catch-to-null would collapse:
 *  - MISSING  → return {} silently (a fresh install legitimately has no overrides);
 *  - VALID    → return the parsed object;
 *  - CORRUPT / unreadable → return {} BUT push an unknown delta so the (now-emptied) allowlist surfaces
 *               as an incomplete sync instead of silently dropping `coworkEgressAllowedHosts`.
 */
export function readConfigJson(p: string, unknown: string[]): Record<string, unknown> {
  if (!existsSync(p)) return {};
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch (e) {
    flag(unknown, `config.json: unreadable at ${p} (${(e as Error).message}) — coworkEgressAllowedHosts NOT synced`);
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch (e) {
    flag(unknown, `config.json: corrupt JSON at ${p} (${(e as Error).message}) — coworkEgressAllowedHosts NOT synced`);
    return {};
  }
}

/** Parse the `coworkEgressAllowedHosts` value from the user config.
 *  - array   → pass through as-is (normal user overrides)
 *  - absent (undefined) → empty; normal for a fresh install, NOT an unknown delta
 *  - any other type → empty + unknown delta (misconfiguration the user should see) */
export function parseEgressAllowedHosts(raw: unknown, unknownDeltas: string[]): string[] {
  if (Array.isArray(raw)) return raw as string[];
  if (raw === undefined) return [];
  flag(unknownDeltas, `coworkEgressAllowedHosts: expected an array but got ${typeof raw} — user allow-list ignored`);
  return [];
}

const dedupe = <T>(a: T[]) => [...new Set(a)];
const flag = (acc: string[], what: string) => {
  acc.push(what);
  return "";
};
