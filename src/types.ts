import { warn } from "./io.js";
import { z } from "zod";

/** Cowork's `DEFAULT_MAX_THINKING_TOKENS` (the ELF's `hre`), binary-verified = 31999. The single source
 *  for the schema default and every runtime arg/env fallback, so they can't drift. Never 0. */
export const DEFAULT_MAX_THINKING_TOKENS = 31999;

/** PlatformBaseline — VOLATILE per-release facts (one synced snapshot per Cowork release), from cowork-sync. */
export const MountSpec = z.object({
  name: z.string(),
  mountPath: z.string(),
  mode: z.enum(["r", "rw", "rwd"]),
  purpose: z.string().optional(),
});

export const PlatformBaseline = z
  .object({
    baselineVersion: z.number(),
    appVersion: z.string(),
    agentVersion: z.string(),
    agentBinary: z.object({
      stagedPath: z.string().optional(),
      format: z.string().optional(),
      // npmPackage/preferReuseStaged removed (Q1): there is NO npm path — the Linux/arm64 ELF is
      // bind-mounted from the staged Desktop install (or COWORK_AGENT_BINARY). Tolerated-but-ignored
      // if present in an old baseline (z.object strips unknown keys).
    }),
    guest: z.object({ os: z.string(), arch: z.string(), baseImage: z.string().optional() }).passthrough(),
    spawn: z
      .object({
        configDirInGuest: z.string().default("mnt/.claude"),
        settingSources: z.array(z.string()).default(["user"]),
        permissionMode: z.string().default("default"),
        maxThinkingTokens: z.number().default(DEFAULT_MAX_THINKING_TOKENS),
        effortDefault: z.string().default("medium"),
        tools: z.array(z.string()).default([]),
        allowedTools: z.array(z.string()).default([]),
        env: z.record(z.string(), z.string()).default({}),
        promptTemplate: z.string().optional(),
        subagentAppend: z.string().optional(),
      })
      .partial()
      .passthrough()
      .optional(),
    mountLayout: z.object({
      sessionRoot: z.string(),
      cwd: z.string(),
      mntRoot: z.string().optional(),
      mounts: z.array(MountSpec),
    }),
    network: z.object({
      mode: z.string(),
      allowKind: z.enum(["allowlist", "unrestricted"]),
      allowDomains: z.array(z.string()),
    }),
    bgEnvStrip: z
      .object({ knownVars: z.array(z.string()) })
      .partial()
      .optional(),
  })
  .passthrough();
export type PlatformBaseline = z.infer<typeof PlatformBaseline>;

/** @deprecated Renamed to `PlatformBaseline`. Kept as a re-export for one minor; remove next minor. */
export const Profile = PlatformBaseline;
/** @deprecated Renamed to `PlatformBaseline`. */
export type Profile = PlatformBaseline;

/** Scenario — what the user authors. */
export const AnswerRule = z
  .object({
    // AskUserQuestion matcher
    when_question: z.string().optional(),
    // a label (single-select / one member) OR a list of labels (multiSelect — delivered comma-joined,
    // the binary-verified wire shape). Each member is validated against the gate's offered options.
    choose: z.union([z.string(), z.array(z.string())]).optional(),
    // free-text "Other" answer: an arbitrary string delivered verbatim, bypassing label validation by
    // author intent (Cowork auto-provides an "Other" free-text path on every AskUserQuestion gate). Mutually
    // exclusive with `choose`.
    answer: z.string().optional(),
    // tool-permission matcher
    when_tool: z.string().optional(),
    decide: z.enum(["allow", "deny"]).optional(),
    allow_if: z.string().optional(), // JS predicate over `input` (e.g. "!command.includes('rm')")
    else: z.enum(["allow", "deny"]).optional(),
    // web_fetch grant scope (only meaningful for a `webfetch:<domain>` allow): "once" = this fetch; "domain"
    // = approve the host for the rest of the run (models "Allow all for website", session-scoped).
    grant: z.enum(["once", "domain"]).optional(),
  })
  .superRefine((r, ctx) => {
    // Reject inert rules: a matcher-less object (e.g. `{}`) or a matcher with no action passes the bare
    // object schema but silently never matches, surfacing only later as an unanswered gate. Require a
    // valid question-rule shape (when_question + choose|answer) or tool-rule shape (when_tool + decide|allow_if).
    const hasQuestion = r.when_question !== undefined;
    const hasTool = r.when_tool !== undefined;
    if (!hasQuestion && !hasTool) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "answer rule has no matcher — set `when_question` or `when_tool`" });
      return;
    }
    // reject rules that set both matcher families — their precedence is undefined and the rule
    // would silently act as either a question rule or a tool rule depending on which branch runs first.
    if (hasQuestion && hasTool)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "answer rule sets both `when_question` and `when_tool` — use exactly one matcher family per rule",
      });
    if (hasQuestion && r.choose === undefined && r.answer === undefined)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a `when_question` rule needs an action — set `choose` or `answer`" });
    // `choose` and `answer` are mutually exclusive (the field comment at the top of the schema
    // promises this). Runtime rejects the combination only on a MATCHING rule (decider.ts), so a malformed
    // rule that never matches sits unnoticed. Reject it at schema time so the author sees it regardless.
    if (r.choose !== undefined && r.answer !== undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "answer rule sets both `choose` and `answer` — use exactly one: `choose` for an offered option, or `answer` for a free-text 'Other'",
      });
    if (hasTool && r.decide === undefined && r.allow_if === undefined)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a `when_tool` rule needs an action — set `decide` or `allow_if`" });
    // reject rules that set both `allow_if` and `decide` — `decide` silently takes precedence
    // over `allow_if` in the runtime's if/else-if chain, making `allow_if` unreachable and the author's
    // intent opaque. Require exactly one action field.
    if (r.allow_if !== undefined && r.decide !== undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "answer rule sets both `allow_if` and `decide` — use exactly one: `decide` for a static outcome, `allow_if` for a predicate",
      });
    // `grant` is consumed only on an ALLOW outcome of a web_fetch permission rule (decider.ts —
    // `behavior === "allow" && req.tool.startsWith("webfetch:")`). On a question rule, a non-webfetch tool
    // rule, or a `decide: deny` rule it is silently inert — an author who sets it believes a domain grant is
    // active when it is ignored. Reject those inert placements so the supported shape is explicit.
    if (r.grant !== undefined) {
      if (!hasTool)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "`grant` is only valid on a `when_tool` web_fetch rule — it is inert on a question rule",
        });
      else if (!r.when_tool!.startsWith("webfetch:"))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "`grant` is only consumed for a `webfetch:<domain>` tool rule — it is inert on any other tool",
        });
      else if (r.decide === "deny")
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "`grant` is only meaningful on an ALLOW outcome — it is inert on a `decide: deny` rule",
        });
    }
  });
export type AnswerRule = z.infer<typeof AnswerRule>;

// Each field carries a `.describe()` so it is the SINGLE source for both the published JSON schema and
// `cowork-harness assert --list` (which reads `Assertion.shape[k].description`) — the list can never drift
// from the schema. Keep descriptions one line.
export const Assertion = z.object({
  transcript_contains: z.string().optional().describe("the transcript contains this literal substring"),
  transcript_not_contains: z.string().optional().describe("the transcript does NOT contain this literal substring"),
  transcript_matches: z.string().optional().describe("regex (case-insensitive) over the transcript — fuzzy content for stochastic prose"),
  transcript_not_matches: z.string().optional().describe("regex (case-insensitive) that must NOT match the transcript"),
  tool_result_contains: z
    .string()
    .optional()
    .describe("at least one tool result contains this literal substring (per-result match, not concatenated; 10 KB cap per result)"),
  tool_result_not_contains: z
    .string()
    .optional()
    .describe("no tool result contains this literal substring (per-result match, not concatenated; 10 KB cap per result)"),
  file_exists: z.string().optional().describe("a file exists at this path under the agent's work root"),
  user_visible_artifact: z
    .string()
    .optional()
    .describe("a file exists AND is under a user-visible prefix (mnt/outputs or mnt/.projects — Cowork-promoted)"),
  tool_called: z.string().optional().describe("a tool with this name was called"),
  tool_not_called: z.string().optional().describe("a tool with this name was NOT called"),
  subagent_tool_used: z.string().optional().describe("a sub-agent used this tool"),
  subagent_tool_absent: z.string().optional().describe("no sub-agent used this tool"),
  subagent_dispatched: z.string().optional().describe("a sub-agent matching this regex (by agentType or description) was dispatched"),
  subagent_declared_but_unused: z.string().optional().describe("a sub-agent declared this tool but never used it (the fabrication proxy)"),
  dispatch_count_max: z.number().int().nonnegative().optional().describe("total sub-agent dispatches ≤ N (the {global:3} ceiling)"),
  egress_denied: z.string().optional().describe("egress to this host was denied"),
  egress_allowed: z.string().optional().describe("egress to this host was allowed"),
  // Only `true` is accepted: `false` is rejected as a footgun. The assertion is presence-semantic — authoring
  // `false` reads as "permit deletes" but would behave identically to `true` (a silent no-effect). To allow
  // deletes, OMIT the assertion entirely rather than writing `false`.
  no_delete_in_outputs: z
    .literal(true)
    .optional()
    .describe(
      "fails if a delete touching mnt/outputs is DETECTED (post-run bash-command scan, not FUSE-level enforcement — a green means none was detected); only `true` is valid (writing `false` is a rejected footgun — omit to allow deletes)",
    ),
  self_heal_ran: z.boolean().optional().describe("skill resolved scripts via /sessions (plugin-root self-heal)"),
  transcript_no_host_path: z.boolean().optional().describe("no /Users//opt host path leaked into model-visible text"),
  question_asked: z.string().optional().describe("a question matching this regex was asked"),
  questions_count_max: z.number().int().nonnegative().optional().describe("at most N questions were asked"),
  gate_answers_delivered: z
    .boolean()
    .optional()
    .describe("every answered AskUserQuestion gate's tool_result was non-error (the answer reached the model)"),
  result: z.enum(["success", "error"]).optional().describe("the run's final result was success | error"),
  allow_permissive_auto_allow: z
    .boolean()
    .optional()
    .describe(
      "(verdict modifier) suppress the default-fail when the run recorded a cowork-parity permissive auto-allow — for tests that deliberately assert Cowork's permissive behavior",
    ),
  allow_l0_plugin_divergence: z
    .boolean()
    .optional()
    .describe(
      "(verdict modifier) suppress the default-fail when L0 (protocol) runs with plugins that load via --settings/managed config instead of --plugin-dir — for tests that deliberately test at L0 with plugins",
    ),
  allow_missing_capability: z
    .boolean()
    .optional()
    .describe(
      "(verdict modifier) suppress the default-fail when the (partial 'core') agent image omits a capability the skill used but real Cowork ships — assert this only when the skill's fallback is genuinely equivalent (otherwise rebuild full parity / the rootfs `max` tier)",
    ),
  replay_protocol_fidelity: z
    .boolean()
    .optional()
    .describe(
      "(replay-only, NOT authorable) serializeDecision output matched the frozen recording — the token-free O7 guard; synthesized by the replay lane and rejected if written in a scenario",
    ),
  // #5: assert over the CONTENTS of a JSON artifact via a dotted path. `absent` and `is_null` are DISTINCT
  // (key-missing vs present-null); an unresolved INTERMEDIATE segment fails loud (malformed artifact),
  // never a vacuous pass. Manifest-backed: evaluated on replay when the cassette carries an `artifacts`
  // manifest (`record` snapshots one); a manifest-less cassette skips it (with a loud warning).
  artifact_json: z
    .object({
      artifact: z.string().describe("relative path to a JSON artifact under the work root (e.g. outputs/cap_state.json)"),
      path: z.string().optional().describe("dotted path into the JSON (e.g. me.run_id); omit to target the whole document"),
      equals: z.unknown().optional().describe("the resolved value deep-equals this"),
      in: z
        .array(z.unknown())
        .optional()
        .describe("the resolved value deep-equals one of these (stable for stochastic/LLM-extracted values where equals churns)"),
      gt: z.number().optional().describe("the resolved value is a number greater than this"),
      exists: z.boolean().optional().describe("the path resolves to a present (non-absent) value"),
      absent: z.boolean().optional().describe("the final key is absent from its (resolved) parent — the anti-hallucination negative"),
      is_null: z.boolean().optional().describe("the resolved value is JSON null (distinct from absent)"),
    })
    .optional()
    .describe("assert over a JSON artifact's contents (dotted path + equals|in|gt|exists|absent|is_null)"),
});
export type Assertion = z.infer<typeof Assertion>;

export const ScenarioObject = z
  .object({
    // Optional: defaults to the scenario's filename (sans extension) via parseScenarioFile —
    // the file IS the identity. An explicit `name:` is an override (keys the run dir + cassette).
    name: z.string().default(""),
    baseline: z.string().default("latest"), // platform baseline (auto-synced; `profile:` is a deprecated alias)
    session: z.string().default("(inline)"), // session setup (hand-authored); default = an all-defaults inline session
    // cowork = auto-pick host-loop vs container via Cowork's own decision logic (the gate);
    // hostloop = force host-loop; container/microvm = force VM-loop; protocol = L0.
    fidelity: z.enum(["protocol", "container", "microvm", "hostloop", "cowork"]).default("container"),
    prompt: z.string(),
    answers: z.array(AnswerRule).default([]),
    // input policy when an AskUserQuestion/dialog/elicit arrives unscripted (input-and-interactivity plan).
    // `run` default is `fail` (deterministic); `prompt` is rejected for `run` (would break determinism).
    on_unanswered: z.enum(["fail", "prompt", "llm", "first"]).optional(),
    expect_denied: z.array(z.string()).default([]), // shorthand: egress hosts asserted to be DENIED (one egress_denied assertion per host)
    assert: z.array(Assertion).default([]),
    // F-6 (opt-in): scope the skill-staleness hash to the skill(s) this scenario actually exercises, named by
    // their `skills/<name>` dir under a mounted plugin-root. Empty/omitted = hash the WHOLE mounted tree (the
    // default — so an unrelated skill edit re-stales every cassette). When set, only the named skill dirs plus
    // the plugin's SHARED roots (everything not under `skills/<x>/`) feed the hash, so editing one skill
    // re-stales only its own cassettes. Fail-closed: if any named skill is absent, the whole tree is hashed
    // (a typo can't silently narrow the gate).
    skills: z.array(z.string()).default([]),
  })
  .strict();
// Back-compat (one minor): accept the deprecated top-level `profile:` key as an alias for `baseline:`,
// remapping it BEFORE `.strict()` rejects the unknown key. Remove next minor.
export const Scenario = z.preprocess((raw) => {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    if ("profile" in o && !("baseline" in o)) {
      const { profile, ...rest } = o;
      warn("::warning:: scenario field `profile:` is deprecated — rename it to `baseline:` (accepted for now; removed next minor).\n");
      return { ...rest, baseline: profile };
    }
  }
  return raw;
}, ScenarioObject);
export type Scenario = z.infer<typeof ScenarioObject>;

export interface RunResult {
  $schema?: string;
  generator?: string;
  scenario: string;
  prompt?: string; // the prompt that was run — persisted so `scaffold --from-run` can reconstruct the scenario
  fidelity: string;
  baseline: string;
  result: "success" | "error";
  decisions: Array<{ kind: string; name: string; decision: string; by?: string; detail?: unknown; rationale?: string }>;
  toolCounts?: Record<string, number>; // O6: truthful per-tool call count (use this, NOT usage.server_tool_use which is host-routed-blind in cowork)
  // Part 3: did each gate's answer reach the model? `reason` distinguishes a `delivered:null` that means
  // "no pairing metadata" (no toolUseId) from one that means "tool result not observed".
  gateDeliveries?: Array<{
    question: string;
    delivered: boolean | null;
    error?: string;
    reason?: "ok" | "errored" | "unobserved" | "no-pairing-metadata";
  }>;
  egress: Array<{ host: string; decision: "allow" | "deny" }>;
  assertions: Array<{ assertion: Assertion; pass: boolean; message?: string }>;
  subagents?: Array<{
    toolUseId: string;
    parentToolUseId?: string;
    agentType: string;
    declaredTools: string[];
    toolsUsed: string[];
    description?: string;
  }>;
  /**
   * Decisions answered by a non-deterministic / non-authoritative source (LLM, external helper,
   * human, or the `first`-option fallback). The name is historical — these entries are NOT literally
   * unanswered; they were answered, but by a source that is not reproducible. Scripted answers
   * (by:"scripted") are excluded because they are authoritative and deterministic. (#20)
   */
  unanswered?: Array<{ question: string; chosen: string; by: string; rationale?: string; model?: string }>;
  usage?: Record<string, unknown>;
  cost?: Record<string, unknown>;
  durationMs?: number;
  outDir: string;
  workDir?: string; // the agent's working root (mnt/) inside the run dir — where the agent's FS lives
  outputsDir?: string; // the user-visible deliverable mount (mnt/outputs) — where a skill's artifacts land
  /**
   * The user-visible mount roots (relative to mnt/) for this run — `outputs` plus each connected work
   * folder's resolved mount name. Persisted so the plan-less lanes (verify reads result.json; replay reads
   * the cassette) derive `user_visible_artifact` from the ACTUAL mount set instead of a hardcoded
   * `["outputs",".projects"]` prefix list. Plugins are NOT here (read-only inputs, never artifact roots).
   */
  userVisibleRoots?: string[];
  // ENV-MANIFEST: files written under the user-visible roots (outputs/ + connected folders), relative paths
  // + sizes. Paths only (no content snapshot — that is the cassette manifest, #1). Kills path-guessing and
  // makes an all-or-nothing truncated run (empty manifest) detectable. NOT sufficient for mid-write truncation.
  artifacts?: { path: string; bytes: number }[];
  nonDeterministic?: boolean; // true if any decision was made by a non-deterministic source (by:"llm"|"external"|"human"|"first") — a green run is NOT reproducible (#47)
  /** True when the CONFIGURED terminal (on_unanswered: llm/prompt, or an external channel) could answer
   *  non-deterministically — even if THIS run was fully scripted and didn't hit it. `nonDeterministic`
   *  stays execution-truth (what replay relies on); this is config-truth for audit consumers. */
  nonDeterministicTerminal?: boolean;
  /** #6: tools auto-allowed by cowork parity for unscripted, off-registry permission requests — real Cowork BLOCKS these for the user. A non-empty list means a green is NOT a faithful pass (pin with --answer or permission_parity: strict). */
  permissiveAutoAllow?: string[];
  /** Post-run scan signals (live lane only). computeVerdict default-fails on `outputsDeletes`/`hostPathLeaked`
   *  when the scenario did NOT author the matching assertion. Absent on the replay lane (a cassette can't reproduce them). */
  scan?: { outputsDeletes: string[]; hostPathLeaked: boolean; selfHealRan: boolean };
  /** The fidelity tier actually used. Equals `fidelity` unless `fidelity:"cowork"` resolved to a specific tier. (#24) */
  effectiveFidelity?: string;
  /** #49: structured fidelity warnings (prompt asset gaps, version mismatches) — visible to JSON callers,
   *  not just stderr. Populated when a non-fatal prompt warning is emitted during a run. */
  fidelityWarnings?: string[];
  /** Tool-result text at assertion-fidelity cap (10 KB per result). Used by `tool_result_contains` /
   *  `tool_result_not_contains`. `assertText` is preferred when present; falls back to `text` (500-char
   *  display cap) for cassettes recorded before this field was added. */
  toolResults?: { toolUseId?: string; isError: boolean; text: string; assertText?: string }[];
  /** #20: true when L0 (protocol) ran with plugins that loaded via --settings/managed config instead of
   *  --plugin-dir (the Cowork cache layout). computeVerdict fails on this unless allow_l0_plugin_divergence
   *  is asserted — a warn-only was insufficient since the run could still appear green. */
  l0PluginDivergence?: boolean;
  /** Capability families the agent image OMITS but the skill was observed USING (live lane only; the
   *  intersection of the image's probed `omitted` set and capability-usage detected in events.jsonl).
   *  computeVerdict default-fails on a non-empty list unless `allow_missing_capability` is asserted — a
   *  green run that used an omitted capability is a likely FALSE NEGATIVE (real Cowork ships it). Absent on
   *  replay (no live image to probe). See docs/internal/2026-06-20-founder-skills-bug-validation.md §8.8. */
  missingCapabilityUse?: string[];
}
