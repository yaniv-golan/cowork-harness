// The spawn-env classification registry: ONE classification per env key name, with a reason, read through ONE function
// (`classifySpawnEnvKey`) by every consumer — deriveSpawnEnv's window scan, the post-construction write scanner, and the
// observed spawn-env oracle (`observed-spawn-env.ts`).
//
// Each row says at which SITES its classification is valid:
//   - "window": the env literals deriveSpawnEnv reads (W1/W2/W3). Only the two tables below carry it, so a host-loop or
//     observed-only row (PATH, HOME, …) can never widen what the window scan admits. test/spawn-env-registry.test.ts pins
//     the window view to the tables as they stood before this module existed.
//   - "post-write": a direct write to the spawn options' env after W1 is built (the minimal scanner).
//   - "observed": a key name in Desktop's own `[HostLoop] sdkOptions after patch` log dump.
// Patterns (template-built names) apply only at the post-write and observed sites, so the window scan stays exact-name.

export const SPAWN_ENV_CLASSES = [
  "pinned", // the baseline's spawn.env carries it (deriveSpawnEnv resolves and pins its value)
  "harness-set", // the harness sets it outside spawn.env (runtime-injected)
  "host-derived", // a value from the host, account or login state; not modeled
  "host-inherited", // copied from Desktop's own process env (the user's shell); the harness host loop inherits the operator's shell
  "anchored-elsewhere", // guarded by a dedicated sync check named in the reason
  "attribution-metadata", // analytics attribution only; not modeled
  "server-config", // a server-delivered account or session config value
  "session-conditional", // set only for a session shape or server flag the modeled session does not have by default
  "settings-conditional", // set from a user or managed setting; absent by default
  "gate-conditional-off", // behind a gate that reads off or dark
  "non-cowork-session", // a non-Cowork session type (agent, project)
  "telemetry", // OTEL / tracing configuration
  "3p-only", // only on a third-party deployment; the harness models first-party
  "host-loop-unmodeled", // a host-loop-only Desktop setting the harness does not model yet
  "deliberately-unset", // observed in real sessions; the harness leaves it unset on purpose (the reason says why)
] as const;
export type SpawnEnvClass = (typeof SPAWN_ENV_CLASSES)[number];
export type SpawnEnvSite = "window" | "post-write" | "observed";

export interface SpawnEnvEntry {
  name: string;
  class: SpawnEnvClass;
  reason: string;
  sites: readonly SpawnEnvSite[];
}

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
const SPAWN_ENV_ALLOWLIST: Record<string, readonly [SpawnEnvClass, string]> = {
  CLAUDE_CONFIG_DIR: ["harness-set", "modeled as spawn.configDirInGuest; injected per-session by spawnEnv() (src/runtime/argv.ts)"],
  TZ: ["harness-set", "host-derived (Intl timezone)"],
  CLAUDE_CODE_HOST_PLATFORM: ["harness-set", "host-derived; runtime-injected (src/runtime/argv.ts)"],
  CLAUDE_CODE_OAUTH_TOKEN: ["harness-set", "host auth"],
  ANTHROPIC_BASE_URL: ["host-derived", "host-derived (apiHost)"],
  ANTHROPIC_CUSTOM_HEADERS: ["host-derived", "host-derived (jXe client headers; re-set non-empty so it survives FnA)"],
  ANTHROPIC_API_KEY: ["anchored-elsewhere", "constructed '' then deleted by FnA — absent from the final env"],
  ANTHROPIC_AUTH_TOKEN: ["anchored-elsewhere", "constructed '' then deleted by FnA — absent from the final env"],
  CLAUDE_CODE_OAUTH_SCOPES: ["host-derived", "gate 1936081873 force-ON but value = the account's live OAuth scope (host-derived)"],
  CLAUDE_CODE_SUBSCRIPTION_TYPE: ["host-derived", "host account state"],
  CLAUDE_CODE_RATE_LIMIT_TIER: ["host-derived", "host account state"],
  CLAUDE_CODE_ACCOUNT_UUID: ["host-derived", "account-identity block; conditional on live login state"],
  CLAUDE_CODE_USER_EMAIL: ["host-derived", "account-identity block; conditional on live login state"],
  CLAUDE_CODE_ORGANIZATION_UUID: ["host-derived", "account-identity block; conditional on live login state"],
  CLAUDE_CODE_ACCOUNT_TAGGED_ID: ["host-derived", "account-identity block; conditional on live login state"],
  CLAUDE_CODE_WORKSPACE_HOST_PATHS: ["harness-set", "connected-folder list; runtime-derived per session"],
  // Desktop 2.2553.1. 3p-only: constructed inside the `...<isThirdParty>&&{DISABLE_GROWTHBOOK:"1",…}`
  // spread in W3, never on first-party. Allowlisted, never pinned — the standing rule for a 3p-only key.
  CLAUDE_CODE_MODEL_CATALOG: ["3p-only", "3p-only deployment branch (DISABLE_GROWTHBOOK sibling); never constructed on first-party"],
  // Desktop 2.9939.2. Same spread, same rule: `CLAUDE_CODE_DISABLE_FAST_MODE:"1"` sits in the 3p-only
  // `...<isThirdParty>&&{DISABLE_GROWTHBOOK:"1",…}` member list and has no first-party site.
  CLAUDE_CODE_DISABLE_FAST_MODE: ["3p-only", "3p-only deployment branch (DISABLE_GROWTHBOOK sibling); never constructed on first-party"],
  // Desktop 2.2553.1. Doubly conditional in W1: the frame-artifacts predicate AND a server-delivered
  // `artifactHostGrant` session field. Both are off/absent on the modeled default first-party session, so
  // there is no value to pin. NOTE: its spread condition is asserted to be the SAME predicate as the
  // Artifact tool spread's by S6d — without that, a future build dropping the guard would be admitted here
  // in silence, which is the failure S6d exists to prevent.
  CLAUDE_ARTIFACT_HOST_GRANT: [
    "session-conditional",
    "frame-artifacts gated + server-delivered grant; absent on a default first-party session (guarded by S6f)",
  ],
  // Desktop 2.2553.1. W2 base env, UNCONDITIONAL on first-party: `<dep>.type==="3p"?"":app.getVersion()`.
  // Allowlisted because `app.getVersion()` is an Electron host call, not a structural fact the asar window
  // can resolve — NOT because the key is optional. It is runtime-injected from `baseline.appVersion` in
  // BOTH spawnEnv and hostNativeSpawnEnv (src/runtime/argv.ts), exactly as CLAUDE_CODE_HOST_PLATFORM is.
  // Allowlisting WITHOUT that injection would be a silent contract loss: resolveInto hits the allowlist
  // before SPAWN_PIN_KEYS and the key is not in REQUIRED_SPAWN_KEYS, so nothing would fail — while the
  // agent, which reads this key on the `local-agent` entrypoint the harness pins, would stop sending the
  // anthropic-client-platform / anthropic-client-version headers production always sends.
  CLAUDE_CODE_DESKTOP_APP_VERSION: [
    "harness-set",
    "host-derived (Electron app.getVersion(); '' on 3p); runtime-injected from baseline.appVersion (src/runtime/argv.ts)",
  ],
  CLAUDE_PROJECT_UUID: ["non-cowork-session", "project-session-conditional (absent for the modeled standard chat session)"],
  CLAUDE_PROJECT_TOOL: ["non-cowork-session", "project-session-conditional (absent for the modeled standard chat session)"],
  MCP_CONNECT_TIMEOUT_MS: ["gate-conditional-off", "gate 434204418-conditional (off; arrives with MCP_CONNECTION_NONBLOCKING:'0')"],
  ENABLE_TOOL_SEARCH: ["gate-conditional-off", "gate 1129419822-conditional (dark)"],
  CLAUDE_CODE_SKIP_PRECOMPACT_LOAD: ["gate-conditional-off", "gate 4153934152-conditional (off)"],
  CLAUDE_CODE_BRIEF_UPLOAD: ["non-cowork-session", "non-chat (agent) sessionType branch; harness models chat sessions"],
  CLAUDE_CODE_BRIEF: ["non-cowork-session", "non-chat (agent) sessionType branch; harness models chat sessions"],
  DISABLE_BRIEF_MODE_STOP_HOOK: ["non-cowork-session", "non-chat sessionType + gate 451382573; harness models chat sessions"],
  CLAUDE_CODE_SUBAGENT_MODEL: ["settings-conditional", "user-settings-conditional (default absent)"],
  CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: [
    "deliberately-unset",
    "server-delivered by the claude.ai account config (forced on for third-party and managed deployments) and set in every observed session; the harness leaves it unset because it does not pass connected folders as additional directories",
  ],
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: ["settings-conditional", "user-settings-conditional (default absent)"],
  CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: ["settings-conditional", "user-settings-conditional (default absent)"],
  CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: ["server-config", "server-pushed per-account map (default absent)"],
  // Conditional on the SERVER-delivered session flag `frameArtifactsEnabled` (a session-config field
  // alongside memoryEnabled/skillsEnabled — NOT a GrowthBook gate, so it has no fcache id and cannot be
  // pinned in provenance.gates). It is per ACCOUNT, not off by default: a claude.ai feature flag delivers it
  // through the renderer's session config, and the recording account has it on in every observed host-loop session.
  // It stays deliberately unset in the harness because the Artifact tool it pairs with is not served (see
  // docs/fidelity-gaps.md), so pinning it would announce a tool the modeled session cannot use.
  // S6d asserts the key stays gated on the SAME predicate as the Artifact tool spread, so this
  // allowlist entry cannot silently start admitting an unconditional or re-keyed construction.
  CLAUDE_CODE_COWORK_FRAME_ARTIFACTS: [
    "deliberately-unset",
    "per-account server flag (frameArtifactsEnabled), set in every observed session of the recording account; the harness leaves it unset because the Artifact tool is not served; shared-predicate conditionality asserted by S6d",
  ],
  // Desktop 2.26454.0 moved the construction into a one-key module object, `l={CLAUDE_CODE_HOST_SCHEDULED_RUN:"1"}`,
  // exported with its predicate; W1 spreads it as `...o.Y(a)&&o.J`, and the Code-tab spawn also uses it, under its own
  // condition (`…?.scheduledTaskId!==void 0&&Object.assign(env,s.J)`). applyWindow enumerates the imported object's
  // keys; S6g counts every reference to it. The 2.19675.0 shape below is still admitted.
  // Desktop 2.19675.0. One W1 construction site: `...Sd(a)&&{CLAUDE_CODE_HOST_SCHEDULED_RUN:"1"}`, with
  // `function Sd(e){return e.sessionType===t.WR}` and `t.WR` resolving to the literal "scheduled" — set
  // only for scheduled-task runs. The harness models an interactive session (no sessionType), so there is
  // no value to pin; pinning would bake a scheduled-only "1" into every modeled spawn. Allowlisting is
  // unconditional by construction (resolveInto returns on the hit), so S6g asserts that every construction
  // stays guarded by exactly that predicate — without it, Desktop widening the condition would be admitted
  // here in silence.
  CLAUDE_CODE_HOST_SCHEDULED_RUN: [
    "session-conditional",
    "scheduled-task sessionType-conditional (sessionType==='scheduled'); the modeled interactive session has no sessionType; guarded by S6g",
  ],
  CLAUDE_CODE_ATTRIBUTION_HEADER: ["3p-only", "3p-provider-only branch; harness models 1p"],
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
  CLAUDE_STREAM_IDLE_TIMEOUT_MS: [
    "3p-only",
    "3p branch AND gateway-provider streamIdleTimeoutSec-conditional (String(sec*1e3)); single site, inside the same `...accountType==='3p' && {...}` literal as DISABLE_GROWTHBOOK; harness models 1p",
  ],
  // Doubly conditional: the 3p branch AND `telemetry.disableNonessential`. Its two construction sites
  // sit inside the same `...accountType==='3p' && {...}` literal as DISABLE_GROWTHBOOK/DISABLE_TELEMETRY
  // below, so it is allowlisted for the identical reason rather than pinned — pinning would bake a
  // 3p-only key into a baseline that describes the 1p spawn.
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: ["3p-only", "3p-provider-only branch (+ telemetry.disableNonessential); harness models 1p"],
  CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: ["3p-only", "3p-provider-only branch; harness models 1p"],
  DISABLE_GROWTHBOOK: ["3p-only", "3p-provider-only branch; harness models 1p"],
  DISABLE_TELEMETRY: ["3p-only", "3p-provider-only branch; harness models 1p"],
  DISABLE_FEEDBACK_COMMAND: ["3p-only", "3p-provider-only branch; harness models 1p"],
  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: ["3p-only", "3p-provider-only branch; harness models 1p"],
  DISABLE_ERROR_REPORTING: ["3p-only", "3p-provider-only branch; harness models 1p"],
  CLAUDE_CODE_ENABLE_AUTO_MODE: ["3p-only", "3p-provider-only branch; harness models 1p"],
  CLAUDE_CODE_HOST_AUTH_ENV_VAR: ["3p-only", "3p-provider-only branch; harness models 1p"],
  // Desktop 2.31226.0. Built by the shared-env helper's callee as `...<opts>.skillSwitches&&{…:"1"}`, OUTSIDE the
  // `DISABLE_GROWTHBOOK:` branch, so the 3p classifier does not catch it by position. Its guard is the deployment's
  // `usesLocalSkillStorage()`, which returns false on the first-party deployment class and true on the 3p one, so a
  // 1p Cowork session never gets it. Allowlisted, not pinned: pinned, the generic pass would read it as an
  // unconditional "1".
  CLAUDE_CODE_DESKTOP_SKILL_SWITCHES: ["3p-only", "3p-provider-only (local skill storage); harness models 1p"],
  // Desktop 1.32352.0. Constructed in the SAME `...deploymentType==='3p' && {…}` literal as
  // DISABLE_GROWTHBOOK/DISABLE_TELEMETRY above (verified at its construction site: `let t=<deployment>(),
  // n=t.type==="3p"`), so it is never built on a first-party Cowork session. Allowlisted, not pinned —
  // pinning would bake a 3p-only key into a baseline that describes the 1p spawn, which is the same call
  // made for the 3p-only key in 1.26832.0.
  CLAUDE_CODE_DIAGNOSTICS_FILE: ["3p-only", "3p-provider-only branch; harness models 1p"],
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
  // Desktop still sends it, but agent 2.1.289 does not read it (the name is absent from its binary); pinned anyway, so
  // the baseline keeps matching what Desktop constructs.
  "CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL",
  // Gate 1595132361-conditional (Desktop >=1.46388.3). PINNED, not allowlisted: it has a 1p W1 site
  // and no host/settings/3p conditionality there. While the gate reads off, WI-4 classifies the key and
  // DROPS its value (apply=false), so it stays out of spawn.env; if a server rule flips the gate on,
  // resolveGateInner writes "1" and the flip shows up as a spawn.env diff. Do NOT copy the
  // ENABLE_TOOL_SEARCH treatment here — that key is ALLOWLISTED because its gate is genuinely dark and
  // no value can be resolved for it; this gate is served.
  "CLAUDE_CODE_QUESTION_EXTENDED",
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
  // Desktop 2.26454.0. Both UNCONDITIONAL "0" literals in W2 (the base-env helper), between
  // CLAUDE_CODE_DISABLE_TERMINAL_TITLE and MCP_CONNECTION_NONBLOCKING, before the 3p spread — so every first-party
  // Cowork session receives them. Same call as PYTHONDONTWRITEBYTECODE (also W2): pin, so a later gate or value
  // change is a --diff line. Read in agent 2.1.289 as booleans that accept only 1/true/yes/on, so "0" is the same as
  // unset: CLAUDE_CODE_SIMPLE=1 is the agent's --bare mode (no plugin sync, hooks, auto-memory or CLAUDE.md
  // discovery); CLAUDE_AGENT_SDK_MCP_NO_PREFIX applies to SDK-type MCP servers' tool-name prefixing only. Desktop
  // also strips both from the user env its Code-tab spawn forwards; the harness mirrors that on the tiers that
  // inherit the operator's shell (SCRUBBED_AGENT_ENV_KEYS in src/session.ts).
  "CLAUDE_CODE_SIMPLE",
  "CLAUDE_AGENT_SDK_MCP_NO_PREFIX",
  // Desktop 2.16120.0. UNCONDITIONAL in W2 (`…API_TIMEOUT_MS:String(<t>),PYTHONDONTWRITEBYTECODE:"1",
  // CLAUDE_CODE_DISABLE_CRON:…`), first-party and 3p alike — the only insert in that builder. Same call as
  // its W2 neighbours: every Cowork session receives it ⇒ pin. Effect: python under the agent's process
  // tree stops writing __pycache__/.pyc. (The key's OTHER occurrence in the asar is the env-FORWARD regex
  // list for MCP server processes, not a spawn setter.)
  "PYTHONDONTWRITEBYTECODE",
  "USE_LOCAL_OAUTH",
  "USE_STAGING_OAUTH",
];

const PINNED_REASON = "pinned in the baseline's spawn.env (deriveSpawnEnv resolves its value from the window)";

/** Rows that are NOT part of the window scan: post-construction writes and names seen only in Desktop's host-loop dump. */
const EXTRA_ROWS: Record<string, { class: SpawnEnvClass; reason: string; sites: readonly SpawnEnvSite[] }> = {
  // Copied from Desktop's own process env into the host-loop spawn (Jp). The harness host loop inherits the operator's
  // whole shell instead (src/runtime/hostloop.ts buildHostLoopNativeEnv), which covers these names.
  PATH: {
    class: "host-inherited",
    reason: "Jp copies it from Desktop's process env; the harness host loop inherits the operator's shell",
    sites: ["observed"],
  },
  HOME: {
    class: "host-inherited",
    reason: "Jp copies it from Desktop's process env; the harness host loop inherits the operator's shell",
    sites: ["observed"],
  },
  LOGNAME: {
    class: "host-inherited",
    reason: "Jp copies it from Desktop's process env; the harness host loop inherits the operator's shell",
    sites: ["observed"],
  },
  SHELL: {
    class: "host-inherited",
    reason: "Jp copies it from Desktop's process env; the harness host loop inherits the operator's shell",
    sites: ["observed"],
  },
  USER: {
    class: "host-inherited",
    reason: "Jp copies it from Desktop's process env; the harness host loop inherits the operator's shell",
    sites: ["observed"],
  },
  TERM: {
    class: "host-inherited",
    reason: "Jp copies it from Desktop's process env when set; the harness host loop inherits the operator's shell",
    sites: ["observed"],
  },
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: {
    class: "harness-set",
    reason:
      "autoMemoryEnv (src/loop-decision.ts) sets it on every tier when the session has no memory directory, as Desktop does (checkAutoMemoryFacts)",
    sites: ["observed"],
  },
  CLAUDE_COWORK_MEMORY_PATH_OVERRIDE: {
    class: "anchored-elsewhere",
    reason: "memory-directory mode (gate 123929380 on); checkAutoMemoryFacts; not modeled",
    sites: ["observed"],
  },
  CLAUDE_COWORK_MEMORY_GUIDELINES: {
    class: "anchored-elsewhere",
    reason: "memory-directory mode, gate 1696890383; checkAutoMemoryFacts; not modeled",
    sites: ["observed"],
  },
  CLAUDE_COWORK_MEMORY_INDEX_CONTENT: {
    class: "anchored-elsewhere",
    reason: "memory-directory mode; checkAutoMemoryFacts; not modeled",
    sites: ["observed"],
  },
  CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES: {
    class: "anchored-elsewhere",
    reason: "memory-directory mode; checkAutoMemoryFacts; not modeled",
    sites: ["observed"],
  },
  CLAUDE_CODE_MAX_CONTEXT_TOKENS: {
    class: "server-config",
    reason:
      "from the account config's contextWindowByModel; the agent reads it only for an unknown model or under DISABLE_COMPACT; unset in every observed session; not modeled",
    sites: ["post-write", "observed"],
  },
  CLAUDE_CODE_PLUGIN_ATTRIBUTION: {
    class: "attribution-metadata",
    reason:
      "path → server plugin id map for analytics (server_plugin_id); entries only for remote plugins, which the harness never stages; not modeled",
    sites: ["post-write", "observed"],
  },
  CLAUDE_CODE_SKILL_ATTRIBUTION: {
    class: "attribution-metadata",
    reason:
      "path → skill id map for analytics (skill_id); the agent deletes it from child-process env; set on every observed session; not modeled",
    sites: ["post-write", "observed"],
  },
  CLAUDE_CODE_MCP_APPS_HOST: {
    class: "gate-conditional-off",
    reason:
      'the host-loop launch writes "1" only when the session runs on the host loop, did not start through the host CLI launcher, and gate 3184956269 (default off, dark) is on; a separate MCP-apps helper also builds it, outside the spawn options; not modeled',
    sites: ["post-write", "observed"],
  },
  CLAUDE_CODE_HOST_PROMPT_SUPERSEDES_RECORD: {
    class: "session-conditional",
    reason:
      'written "1" only for an imported session whose system prompt is a recorded snapshot or custom prompt, when the organization base prompt was fetched or the deployment is 3p, on agent >= 2.1.288-dev; the harness never imports a session; not modeled',
    sites: ["post-write", "observed"],
  },
  API_FORCE_IDLE_TIMEOUT: {
    class: "host-loop-unmodeled",
    reason: 'Jp sets "1" (the agent\'s body-idle watchdog); untriaged, follow-up',
    sites: ["observed"],
  },
  DOCUMENTS_MCP_SCRATCH_ROOT: {
    class: "host-loop-unmodeled",
    reason: "Jp; the documents MCP scratch root; follow-up",
    sites: ["observed"],
  },
  CLAUDE_CODE_PROJECT_DIR_NAME: {
    class: "host-loop-unmodeled",
    reason: "Jp; the agent's project-dir name under CLAUDE_CONFIG_DIR; untriaged, follow-up",
    sites: ["observed"],
  },
  GIT_CONFIG_COUNT: {
    class: "host-loop-unmodeled",
    reason:
      "Desktop's git-sanitizing config pins for the native agent's git (hooksPath, fsmonitor, credential helper); untriaged, follow-up",
    sites: ["observed"],
  },
  GIT_CONFIG_PARAMETERS: {
    class: "host-loop-unmodeled",
    reason: "Desktop's git-sanitizing config pins; untriaged, follow-up",
    sites: ["observed"],
  },
  GIT_DIR: { class: "host-loop-unmodeled", reason: "Desktop's git-sanitizing config pins; untriaged, follow-up", sites: ["observed"] },
  NODE_USE_SYSTEM_CA: {
    class: "host-loop-unmodeled",
    reason: 'Jp sets "1" when no extra CA bundle is configured (the host trust store); follow-up',
    sites: ["observed"],
  },
  NODE_EXTRA_CA_CERTS: {
    class: "host-derived",
    reason: "Jp's alternative to NODE_USE_SYSTEM_CA when Desktop has a CA bundle",
    sites: ["observed"],
  },
  GRPC_DEFAULT_SSL_ROOTS_FILE_PATH: { class: "host-derived", reason: "the host gRPC CA bundle path", sites: ["observed"] },
  CLAUDE_CODE_TMPDIR: { class: "host-derived", reason: "passes Desktop's own CLAUDE_CODE_TMPDIR through when set", sites: ["observed"] },
  CLAUDE_CODE_PLUGIN_CACHE_DIR: {
    class: "host-loop-unmodeled",
    reason: "plugin cache directory (with a plugin cache only); untriaged, follow-up",
    sites: ["observed"],
  },
  CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE: {
    class: "host-loop-unmodeled",
    reason: "plugin cache mode only; untriaged, follow-up",
    sites: ["observed"],
  },
  FORCE_AUTOUPDATE_PLUGINS: { class: "host-loop-unmodeled", reason: "plugin cache mode only; untriaged, follow-up", sites: ["observed"] },
  CLAUDE_HOST_CLI_LAUNCHER_NOTE: { class: "host-loop-unmodeled", reason: "host CLI launcher mode only", sites: ["observed"] },
  // Desktop's proxy transform (host loop) adds these from the system or managed proxy. Standard public names; only
  // their values are private, and the oracle never reads a value. Any other name that transform adds stays withheld.
  HTTPS_PROXY: {
    class: "host-loop-unmodeled",
    reason: "Desktop's proxy transform, from the system or managed proxy; untriaged, follow-up",
    sites: ["observed"],
  },
  HTTP_PROXY: {
    class: "host-loop-unmodeled",
    reason: "Desktop's proxy transform, from the system or managed proxy; untriaged, follow-up",
    sites: ["observed"],
  },
  NO_PROXY: {
    class: "host-loop-unmodeled",
    reason: "Desktop's proxy transform, from the system or managed proxy; untriaged, follow-up",
    sites: ["observed"],
  },
  CLAUDE_CODE_USE_GATEWAY: {
    class: "3p-only",
    reason: "custom third-party gateway routing; harness models first-party",
    sites: ["observed"],
  },
  OTEL_RESOURCE_ATTRIBUTES: { class: "telemetry", reason: "Desktop's OTLP resource attributes", sites: ["observed"] },
  OTEL_SERVICE_NAME: { class: "telemetry", reason: "Desktop's OTLP service name", sites: ["observed"] },
  OTEL_EXPORTER_OTLP_PROTOCOL: { class: "telemetry", reason: "operator OTEL protocol rewrite", sites: ["observed"] },
  BETA_TRACING_ENDPOINT: { class: "telemetry", reason: "OTEL beta tracing", sites: ["observed"] },
  ENABLE_BETA_TRACING_DETAILED: { class: "telemetry", reason: "OTEL beta tracing", sites: ["observed"] },
};

export interface SpawnEnvPattern {
  re: RegExp;
  class: SpawnEnvClass;
  reason: string;
  examples: readonly string[];
  counterexamples: readonly string[];
}

/** Template-built names. Anchored; each lists names it must and must not match (test/spawn-env-registry.test.ts). */
export const SPAWN_ENV_PATTERNS: readonly SpawnEnvPattern[] = [
  {
    re: /^GIT_CONFIG_(?:KEY|VALUE)_\d{1,2}$/,
    class: "host-loop-unmodeled",
    reason: "Desktop's git-sanitizing config pins (GIT_CONFIG_KEY_<n>/GIT_CONFIG_VALUE_<n>); untriaged, follow-up",
    examples: ["GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_2", "GIT_CONFIG_VALUE_7"],
    counterexamples: ["GIT_CONFIG_KEY_", "GIT_CONFIG_KEY_0X", "XGIT_CONFIG_KEY_0", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_123"],
  },
  {
    re: /^OTEL_EXPORTER_OTLP_(?:LOGS|METRICS|TRACES)_ENDPOINT$/,
    class: "telemetry",
    reason: "per-signal OTLP endpoints derived from the operator's OTEL endpoint",
    examples: ["OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"],
    counterexamples: ["OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_FOO_ENDPOINT", "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT_X"],
  },
];

const WINDOW_SITES: readonly SpawnEnvSite[] = ["window", "post-write", "observed"];

const ENTRIES: ReadonlyMap<string, SpawnEnvEntry> = (() => {
  const m = new Map<string, SpawnEnvEntry>();
  const add = (e: SpawnEnvEntry) => {
    if (m.has(e.name)) throw new Error(`spawn-env registry: ${e.name} is classified twice`);
    m.set(e.name, e);
  };
  for (const [name, [cls, reason]] of Object.entries(SPAWN_ENV_ALLOWLIST)) add({ name, class: cls, reason, sites: WINDOW_SITES });
  for (const name of SPAWN_PIN_KEYS) add({ name, class: "pinned", reason: PINNED_REASON, sites: WINDOW_SITES });
  for (const [name, r] of Object.entries(EXTRA_ROWS)) add({ name, ...r });
  return m;
})();

/** Every exact-name row (tests, prune NOTEs). */
export function registryEntries(): SpawnEnvEntry[] {
  return [...ENTRIES.values()];
}

/** THE classifier. Exact rows first; patterns only at the post-write and observed sites. null = unclassified. */
export function classifySpawnEnvKey(name: string, site: SpawnEnvSite): { class: SpawnEnvClass; reason: string } | null {
  const e = ENTRIES.get(name);
  if (e) return e.sites.includes(site) ? { class: e.class, reason: e.reason } : null;
  if (site === "window") return null;
  const p = SPAWN_ENV_PATTERNS.find((x) => x.re.test(name));
  return p ? { class: p.class, reason: p.reason } : null;
}

/** Post-write rows outside the window tables: the minimal scanner's prune NOTE walks these. */
export function postWriteOnlyNames(): string[] {
  return registryEntries()
    .filter((e) => e.sites.includes("post-write") && !e.sites.includes("window"))
    .map((e) => e.name);
}

/** Window-site rows that are allowlisted (classified, not pinned): deriveSpawnEnv's prune NOTE walks these. */
export function windowAllowlistedNames(): string[] {
  return registryEntries()
    .filter((e) => e.sites.includes("window") && e.class !== "pinned")
    .map((e) => e.name);
}
