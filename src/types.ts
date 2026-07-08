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

export const PlatformBaseline = z.looseObject({
  baselineVersion: z.number(),
  appVersion: z.string(),
  agentVersion: z.string(),
  agentBinary: z.object({
    stagedPath: z.string().optional(),
    format: z.string().optional(),
    // npmPackage/preferReuseStaged removed: there is NO npm path — the Linux/arm64 ELF is
    // bind-mounted from the staged Desktop install (or COWORK_AGENT_BINARY). Tolerated-but-ignored
    // if present in an old baseline (z.object strips unknown keys).
    // Desktop ALSO stages a native macOS Mach-O binary (claude-code/<ver>/claude.app/Contents/MacOS/claude)
    // alongside the Linux/arm64 ELF above — hostloop's agent loop runs on the host directly from this
    // binary (no container), while only bash/web_fetch route into a VM. The ELF stays the source of
    // truth for container/microvm and for hostloop's bash/web_fetch VM sidecar image. Optional: a
    // baseline synced before this field existed has no native binary staged, so hostloop falls back to
    // resolveHostAgentBinary's loud failure (never a silent tier downgrade).
    nativeStagedPath: z.string().optional(),
    // Provenance of the Linux/arm64 ELF at stagedPath — shared, non-secret (just hashes), improves
    // repro/fidelity. `sha256`: hex SHA-256 of the ELF. `shaProvenance`: "measured-local" = hashed from
    // the staged binary at sync time (the trustworthy point-of-truth); "official-manifest" = copied from
    // Anthropic's per-version release manifest for a version NOT staged on the syncing machine, so
    // staging-identity is UNVERIFIED (byte-identity between the staged binary and the official release is
    // confirmed only for versions actually measured; Desktop could in principle repack what it stages).
    // `manifestChecksumMatch`: set ONLY on measured-local rows — whether the measured hash equalled the
    // official manifest checksum ("unknown" if the manifest was unreachable at sync); omitted on
    // official-manifest rows (there it would compare the manifest hash to itself → tautological).
    // NO nativeSha256: the signed+notarized inner Mach-O embeds an LC_CODE_SIGNATURE and never equals any
    // manifest hash, so a manifest-derived native hash would match nothing on the hostloop path.
    sha256: z.string().optional(),
    shaProvenance: z.enum(["measured-local", "official-manifest"]).optional(),
    manifestChecksumMatch: z.union([z.boolean(), z.literal("unknown")]).optional(),
  }),
  guest: z.looseObject({ os: z.string(), arch: z.string(), baseImage: z.string().optional() }),
  spawn: z
    .looseObject({
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
});
export type PlatformBaseline = z.infer<typeof PlatformBaseline>;

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
      ctx.addIssue({ code: "custom", message: "answer rule has no matcher — set `when_question` or `when_tool`" });
      return;
    }
    // reject rules that set both matcher families — their precedence is undefined and the rule
    // would silently act as either a question rule or a tool rule depending on which branch runs first.
    if (hasQuestion && hasTool)
      ctx.addIssue({
        code: "custom",
        message: "answer rule sets both `when_question` and `when_tool` — use exactly one matcher family per rule",
      });
    if (hasQuestion && r.choose === undefined && r.answer === undefined)
      ctx.addIssue({ code: "custom", message: "a `when_question` rule needs an action — set `choose` or `answer`" });
    // `choose` and `answer` are mutually exclusive (the field comment at the top of the schema
    // promises this). Runtime rejects the combination only on a MATCHING rule (decider.ts), so a malformed
    // rule that never matches sits unnoticed. Reject it at schema time so the author sees it regardless.
    if (r.choose !== undefined && r.answer !== undefined)
      ctx.addIssue({
        code: "custom",
        message:
          "answer rule sets both `choose` and `answer` — use exactly one: `choose` for an offered option, or `answer` for a free-text 'Other'",
      });
    if (hasTool && r.decide === undefined && r.allow_if === undefined)
      ctx.addIssue({ code: "custom", message: "a `when_tool` rule needs an action — set `decide` or `allow_if`" });
    // reject rules that set both `allow_if` and `decide` — `decide` silently takes precedence
    // over `allow_if` in the runtime's if/else-if chain, making `allow_if` unreachable and the author's
    // intent opaque. Require exactly one action field.
    if (r.allow_if !== undefined && r.decide !== undefined)
      ctx.addIssue({
        code: "custom",
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
          code: "custom",
          message: "`grant` is only valid on a `when_tool` web_fetch rule — it is inert on a question rule",
        });
      else if (!r.when_tool!.startsWith("webfetch:"))
        ctx.addIssue({
          code: "custom",
          message: "`grant` is only consumed for a `webfetch:<domain>` tool rule — it is inert on any other tool",
        });
      else if (r.decide === "deny")
        ctx.addIssue({
          code: "custom",
          message: "`grant` is only meaningful on an ALLOW outcome — it is inert on a `decide: deny` rule",
        });
    }
  });
export type AnswerRule = z.infer<typeof AnswerRule>;

// Each field carries a `.describe()` so it is the SINGLE source for both the published JSON schema and
// `cowork-harness assertions --list` (which reads `Assertion.shape[k].description`) — the list can never drift
// from the schema. Keep descriptions one line.
export const Assertion = z.strictObject({
  transcript_contains: z.string().min(1).optional().describe("the transcript contains this literal substring"),
  transcript_not_contains: z.string().min(1).optional().describe("the transcript does NOT contain this literal substring"),
  transcript_matches: z.string().optional().describe("regex (case-insensitive) over the transcript — fuzzy content for stochastic prose"),
  transcript_not_matches: z.string().optional().describe("regex (case-insensitive) that must NOT match the transcript"),
  tool_result_contains: z
    .string()
    .min(1)
    .optional()
    .describe("at least one tool result contains this literal substring (per-result match, not concatenated; 10 KB cap per result)"),
  tool_result_not_contains: z
    .string()
    .min(1)
    .optional()
    .describe("no tool result contains this literal substring (per-result match, not concatenated; 10 KB cap per result)"),
  file_exists: z.string().min(1).optional().describe("a file exists at this path under the agent's work root"),
  user_visible_artifact: z
    .string()
    .optional()
    .describe(
      "a file exists AND is under a user-visible prefix: mnt/outputs, each connected-folder mount (mnt/<folder>), or the legacy mnt/.projects fallback (pre-1.14271.0)",
    ),
  tool_called: z.string().optional().describe("a tool with this name was called"),
  tool_not_called: z.string().optional().describe("a tool with this name was NOT called"),
  subagent_tool_used: z.string().optional().describe("a sub-agent used this tool"),
  subagent_tool_absent: z.string().optional().describe("no sub-agent used this tool"),
  subagent_dispatched: z.string().optional().describe("a sub-agent matching this regex (by agentType or description) was dispatched"),
  subagent_declared_but_unused: z.string().optional().describe("a sub-agent declared this tool but never used it (the fabrication proxy)"),
  subagent_output_contains: z
    .object({
      match: z.string().optional().describe("regex over agentType or description, narrowing to specific dispatch(es); omit to check all"),
      contains: z.string().describe("substring that must appear in the matched dispatch(es)' output"),
    })
    .optional()
    .describe("a dispatched sub-agent's own output contained this substring (optionally narrowed to dispatches matching `match`)"),
  dispatch_count_max: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "total sub-agent dispatches ≤ N — an author-chosen budget; Cowork imposes no in-conversation Task-dispatch cap (see SPEC §10)",
    ),
  skill_triggered: z
    .string()
    .optional()
    .describe('a skill matching this regex (by its invoked skill id, e.g. "plugin:skill") was invoked via the Skill tool'),
  no_skill_triggered: z
    .string()
    .optional()
    .describe("no invoked skill id matched this regex — the negative-control / description-collision catcher"),
  skill_available: z
    .string()
    .optional()
    .describe("a staged skill's id matched this regex (offered, not necessarily invoked — see skill_triggered for invocation)"),
  connector_available: z
    .string()
    .optional()
    .describe("an MCP server/connector's name matched this regex (available, not necessarily used)"),
  tool_available: z
    .string()
    .optional()
    .describe("a tool in the init manifest matched this regex (available, not necessarily called — see tool_called for invocation)"),
  max_cost_usd: z
    .number()
    .positive()
    .optional()
    .describe(
      "the run's SDK-reported total_cost_usd is ≤ N — live lane only; on replay this asserts the frozen recording's cost, not fresh spend",
    ),
  max_tokens: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "usage.input_tokens + usage.output_tokens ≤ N (cache-read/creation tokens excluded — priced separately) — live lane only; on replay this asserts the frozen recording's usage, not fresh spend",
    ),
  tool_calls_max: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("total top-level tool calls (sum of toolCounts, sub-agent tools excluded) ≤ N"),
  tool_no_error: z
    .string()
    .optional()
    .describe(
      "no tool whose name matches this regex recorded any error (RunResult.toolErrors[name].errors === 0 for every match) — REQUIRES at least one matching tool call (fails if the regex matched nothing, so a typo can't silently pass; use tool_no_error_if_called for the presence-free variant)",
    ),
  tool_no_error_if_called: z
    .string()
    .optional()
    .describe(
      "like tool_no_error, but PASSES VACUOUSLY when no tool matches the regex — the lenient, presence-free variant for a tool that may legitimately not run",
    ),
  max_tool_errors: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("total tool errors across all tools (sum of RunResult.toolErrors[*].errors) ≤ N"),
  max_redundant_tool_calls: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "total WASTED repeated tool calls (sum of (count-1) across every redundant {name,args} group in RunResult.redundantToolCalls) ≤ N — not the raw count of redundant groups",
    ),
  skill_tool_used: z
    .object({
      skill: z.string().describe("regex matched against a skill-activation window's skillId"),
      tool: z.string().describe("regex matched against a tool name in that window's toolCounts"),
    })
    .optional()
    .describe(
      "a tool matching `tool` ran inside a skill-activation window whose skillId matches `skill` — heuristic for inline skills (a sticky, sequential window faithfully matching the real agent's activeSkill scope, not an exact per-tool boundary; see RunResult.skillActivity's doc comment)",
    ),
  all_tasks_completed: z
    .literal(true)
    .optional()
    .describe(
      'every task in RunResult.tasks[] reached status "completed" — REQUIRES at least one task (a run with zero tasks fails: it cannot have "completed them all"); only `true` is valid',
    ),
  task_count_min: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("at least N tasks were created (RunResult.tasks.length >= N) — the presence companion for task assertions"),
  task_status: z
    .object({
      match: z.string().describe("regex matched against a task's subject OR id"),
      status: z.string().describe("the status the matching task must have reached"),
    })
    .optional()
    .describe("a task whose subject or id matches `match` reached `status`"),
  max_turns: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("the SDK-reported (or fallback-counted) turn count ≤ N — replay-checkable (the re-drive recounts turns deterministically)"),
  max_peak_rss_bytes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "peak sampled RSS of the agent sandbox <= N bytes — live-only (container/hostloop/microvm); evidence-unavailable on replay/protocol or when sampling captured no RSS",
    ),
  compaction_occurred: z
    .literal(true)
    .optional()
    .describe(
      "a context-compaction boundary occurred during the run (a `compact_boundary` system event was recorded); only `true` is valid — omit to not require it",
    ),
  no_mcp_error: z
    .literal(true)
    .optional()
    .describe("no MCP round-trip failed (RunResult.mcpErrors is empty) — live-only (excluded on replay); only `true` is valid"),
  hook_blocked: z
    .string()
    .optional()
    .describe("a PreToolUse hook blocked a tool whose name matches this regex (RunResult.hookEvents) — replay needs controlOut"),
  no_hook_blocked: z
    .literal(true)
    .optional()
    .describe(
      "no tool was hook-blocked during the run (distinguishes a real tool crash from an intentional block) — replay needs controlOut; only `true` is valid",
    ),
  no_scratchpad_leak: z
    .literal(true)
    .optional()
    .describe(
      "every file presented via present_files that was in the scratchpad was successfully promoted to outputs (none left behind); vacuous pass if nothing was presented — pair with a presence check to require a delivery; content-class (re-derived from the tool_use/tool_result stream, so checkable on replay too); CONTAINER TIER ONLY — present_files is not served on hostloop/microvm, where a scratchpad-delivered file is neither promoted nor detected (use fidelity: container for present_files-based delivery); only `true` is valid",
    ),
  present_files_called: z
    .literal(true)
    .optional()
    .describe(
      "at least one file was actually delivered via the present_files tool (presentedFiles is non-empty). The presence companion to no_scratchpad_leak (which passes vacuously when nothing was presented) — pair them to require a delivery AND require it not to leak; CONTAINER TIER ONLY — present_files is not served on hostloop/microvm; only `true` is valid",
    ),
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
  no_unexpected_files: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "fails if the run CREATED a file under a user-visible root whose workRoot-relative path (e.g. outputs/x.md) matches none of these globs (** = whole path segment for any depth, * within a segment, ? one char); [] = no new files allowed; new-files-only — overwriting a pre-existing file in place is invisible (use content-level producer stamping); needs a pre-run manifest (harness ≥0.24 recordings) — absence fails loud on live/verify-run; microvm cannot capture (use container/hostloop)",
    ),
  input_unmodified: z
    .array(z.string().min(1))
    .min(1)
    .optional()
    .describe(
      "every pre-existing file whose workRoot-relative path matches a glob has an unchanged content hash after the run (in-place mutation detector)",
    ),
  self_heal_ran: z.boolean().optional().describe("skill resolved scripts via /sessions (plugin-root self-heal)"),
  transcript_no_host_path: z
    .literal(true)
    .optional()
    .describe(
      "fails if a host path (/Users, /opt) leaked into model-visible text (post-run scan); only `true` is valid (writing `false` is a rejected footgun — omit to allow or use allow_stall)",
    ),
  computer_links_resolve: z
    .literal(true)
    .optional()
    .describe(
      "fails if any computer:// link in the model-visible transcript does not resolve to an artifact that exists in the run's collected outputs/mounts — REQUIRES at least one link (zero links FAILS: use computer_links_resolve_if_present for the presence-free variant); only `true` is valid (writing `false` is a rejected footgun — omit to skip)",
    ),
  computer_links_resolve_if_present: z
    .literal(true)
    .optional()
    .describe(
      "like computer_links_resolve, but PASSES VACUOUSLY when the transcript has zero computer:// links — the lenient, presence-free variant; only `true` is valid",
    ),
  question_asked: z.string().optional().describe("a question matching this regex was asked"),
  questions_count_max: z.number().int().nonnegative().optional().describe("at most N questions were asked"),
  gate_answers_delivered: z
    .boolean()
    .optional()
    .describe(
      "every answered AskUserQuestion gate's tool_result was non-error (the answer reached the model); zero gates fired passes vacuously — pair with gate_answer_count_min to also require a gate",
    ),
  gate_answer_count_min: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("at least N AskUserQuestion gates fired AND were delivered non-error (presence companion to gate_answers_delivered)"),
  result: z.enum(["success", "error"]).optional().describe("the run's final result was success | error"),
  allow_permissive_auto_allow: z
    .literal(true)
    .optional()
    .describe(
      "(verdict modifier) suppress the default-fail when the run recorded a cowork-parity permissive auto-allow — for tests that deliberately assert Cowork's permissive behavior",
    ),
  allow_l0_plugin_divergence: z
    .literal(true)
    .optional()
    .describe(
      "(verdict modifier) suppress the default-fail when L0 (protocol) runs with plugins that load via --settings/managed config instead of --plugin-dir — for tests that deliberately test at L0 with plugins",
    ),
  allow_missing_capability: z
    .literal(true)
    .optional()
    .describe(
      "(verdict modifier) suppress the default-fail when the (partial 'core') agent image omits a capability the skill used but real Cowork ships — assert this only when the skill's fallback is genuinely equivalent (otherwise rebuild full parity, --build-arg COWORK_FULL_PARITY=1)",
    ),
  allow_stall: z
    .literal(true)
    .optional()
    .describe(
      "(verdict modifier) suppress the default-fail when a run ends on a question having done no productive tool work after its last gate (the agent asked for input and stopped — incl. re-asking in plain text after answering an AskUserQuestion) — assert this only when ending on a question is the intended terminal state; otherwise script the answer (answer:/--answer/decider)",
    ),
  replay_protocol_fidelity: z
    .boolean()
    .optional()
    .describe(
      "(replay-only, NOT authorable) serializeDecision output matched the frozen recording — the token-free re-serialization guard; synthesized by the replay lane and rejected if written in a scenario — listed here only so schema-driven editors can display it in read-only contexts; authoring it in a scenario is a load-time error, see src/run/execute.ts",
    ),
  // assert over the CONTENTS of a JSON artifact via a dotted path. `absent` and `is_null` are DISTINCT
  // (key-missing vs present-null); an unresolved INTERMEDIATE segment fails loud (malformed artifact),
  // never a vacuous pass. Manifest-backed: evaluated on replay when the cassette carries an `artifacts`
  // manifest (`record` snapshots one); a manifest-less cassette skips it (with a loud warning).
  artifact_json: z
    .object({
      artifact: z.string().min(1).describe("relative path to a JSON artifact under the work root (e.g. outputs/cap_state.json)"),
      path: z
        .string()
        .min(1)
        .optional()
        .describe("dotted path into the JSON (e.g. me.run_id); omit to target the whole document (an explicit empty string is rejected)"),
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
  semantic_matches: z
    .object({
      rubric: z
        .array(z.string().min(1))
        .min(1)
        .describe("fixed, authored checkable claims — a pinned judge grades each; results align by INDEX (not re-extracted per rep)"),
      min_pass: z
        .union([z.literal("all"), z.number().int().positive()])
        .optional()
        .describe("how many rubric claims must pass for the assert to pass (default: all; do NOT rely on all for a gating scenario)"),
      judge_model: z.string().optional().describe("override the run-level pinned judge model for this assert"),
    })
    .optional()
    .describe("LIVE-ONLY: a pinned LLM judge grades the rubric against the run's answer; skipped-loud on replay (like egress_*)"),
});
export type Assertion = z.infer<typeof Assertion>;

/** Verdict modifiers: assertions that verify nothing themselves — each opts into (suppresses) one
 *  default-fail in `computeVerdict`. They are pure no-op `ok()` passes in `assert.ts` and are kept on
 *  replay as no-op passes (in `cassette.ts` `alwaysContentKeys`). SINGLE SOURCE OF TRUTH: the `assert.ts`
 *  noop loop, `cassette.ts` `alwaysContentKeys`, the emitted `assertion-keys.json` (`gen-schema.ts`), and
 *  the Python linter's parity test all derive from / are checked against this. The `allow_`-prefix
 *  convention is test-enforced (see the schema invariant test), so a new `allow_*` field can't be added
 *  without landing here. `verdict.ts` keeps its own three hand-written branches — they are genuinely
 *  asymmetric (different signal, list-vs-scalar, message) and must NOT be folded into this list. */
export const VERDICT_MODIFIER_KEYS = [
  "allow_permissive_auto_allow",
  "allow_missing_capability",
  "allow_l0_plugin_divergence",
  "allow_stall",
] as const satisfies readonly (keyof Assertion)[];

export const ScenarioObject = z.strictObject({
  // Optional: defaults to the scenario's filename (sans extension) via parseScenarioFile —
  // the file IS the identity. An explicit `name:` is an override (keys the run dir + cassette).
  name: z
    .string()
    .default("")
    .describe(
      "scenario identity; defaults to the filename (sans extension) if omitted — an explicit value overrides that and keys the run dir + cassette",
    ),
  baseline: z.string().default("latest").describe("platform baseline to run against (auto-synced via `cowork-harness sync`)"),
  session: z
    .string()
    .default("(inline)")
    .describe("hand-authored session setup file (pre-prompt: model, mounts, discovery); defaults to an all-defaults inline session"),
  // cowork = auto-pick host-loop vs container via Cowork's own decision logic (the gate);
  // hostloop = force host-loop; container/microvm = force VM-loop; protocol = L0.
  fidelity: z
    .enum(["protocol", "container", "microvm", "hostloop", "cowork"])
    .default("container")
    .describe(
      "isolation tier: protocol (L0, no sandbox) | container/microvm (force a VM-loop tier) | hostloop (force host-loop) | cowork (auto-pick host-loop vs. container via Cowork's own gate logic)",
    ),
  // execution LOCATION, orthogonal to `fidelity` (a local privilege tier) — do NOT collapse the two.
  // `cloud-describe` is RESERVED: no runner exists yet, so authoring it is a load-time error (see
  // execute.ts's validateScenarioRegexes, which mirrors the `replay_protocol_fidelity` rejection).
  execution: z
    .enum(["local", "cloud-describe"])
    .default("local")
    .describe(
      "execution location axis, ORTHOGONAL to fidelity (a local privilege tier): local (default — run the agent locally) | cloud-describe (RESERVED — describe/annotate a cloud-run scenario without executing it; no runner exists yet, authoring it is a load-time error, not a silent no-op)",
    ),
  prompt: z.string().describe("the user turn sent to the agent"),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "wall-clock budget for the agent run; on expiry the harness kills the agent and the run ends result:error / errorSource:timeout. Omitted = no timeout (the agent runs to its own completion). Distinct from the max_turns assertion and agent_max_turns (turn budget).",
    ),
  answers: z
    .array(AnswerRule)
    .default([])
    .describe(
      "scripted answers, matched in order: AskUserQuestion gates by question-text regex, tool-permission gates by tool name (`when_tool`)",
    ),
  // input policy when an AskUserQuestion/dialog/elicit arrives unscripted (input-and-interactivity plan).
  // `run` default is `fail` (deterministic); `prompt` is rejected for `run` (would break determinism).
  on_unanswered: z
    .enum(["fail", "prompt", "llm", "first"])
    .optional()
    .describe(
      "policy when a gate arrives with no matching `answers:` rule — `fail` (default for `run`, deterministic) | `first` (pick the first offered option) | `llm` (delegate to a decider LLM) | `prompt` (rejected under `run`; only valid for `chat`)",
    ),
  expect_denied: z
    .array(z.string())
    .default([])
    .describe("shorthand for asserting egress to these hosts was DENIED — expands to one egress_denied assertion per host"),
  assert: z.array(Assertion).default([]).describe("post-run assertions; see each key's own description for what it checks"),
  // Opt-in: scope the skill-staleness hash to the skill(s) this scenario actually exercises, named by
  // their `skills/<name>` dir under a mounted plugin-root. Empty/omitted = hash the WHOLE mounted tree (the
  // default — so an unrelated skill edit re-stales every cassette). When set, only the named skill dirs plus
  // the plugin's SHARED roots (everything not under `skills/<x>/`) feed the hash, so editing one skill
  // re-stales only its own cassettes. Fail-closed: if any named skill is absent, the whole tree is hashed
  // (a typo can't silently narrow the gate).
  skills: z
    .array(z.string())
    .default([])
    .describe(
      "named `skills/<name>` dirs this scenario exercises, scoping the cassette-staleness hash to just those (+ shared plugin roots); omitted/empty hashes the whole mounted tree",
    ),
  // capability families this skill's core path NEEDS (e.g. office_convert, ocr, pdf_tables). When
  // set, the run HARD-FAILS if the running tier omits one (clause a) or cannot verify them — protocol /
  // replay / COWORK_SKIP_CAPABILITY_PROBE (clause b) — closing the false-green for extraction-heavy skills.
  // `allow_missing_capability: true` opts out. Validated against the known family list at run time.
  requires_capabilities: z
    .array(z.string())
    .default([])
    .describe(
      "capability families (e.g. office_convert, ocr, pdf_tables) this scenario's core path needs; the run hard-fails if the tier omits or can't verify one, unless `allow_missing_capability: true` is set on the relevant assertion",
    ),
  // Explicit consent for `hostloop` fidelity with a writable connected folder (mode: rw/rwd): the native
  // agent process gets genuine, software-checked-only host filesystem access there — no container sandbox
  // (matches production's own host-loop risk model). A top-level field, NOT an assertion-list entry / a
  // VERDICT_MODIFIER_KEYS member — this gates whether the run is ATTEMPTED at all (pre-run), not a
  // post-run default-fail signal (see checkHostLoopWriteConsent, src/hostloop/safety.ts). Read-only
  // folders and folder-less/scratch hostloop runs need no opt-in.
  allow_host_writes: z
    .boolean()
    .optional()
    .describe(
      "required consent for `fidelity: hostloop` with a writable connected folder (mode rw/rwd) — the agent gets real, software-checked-only host filesystem access there, no container sandbox; read-only/folder-less hostloop runs need no opt-in",
    ),
});
export const Scenario = ScenarioObject;
export type Scenario = z.infer<typeof ScenarioObject>;

/** Skill/plugin staleness fingerprint, recorded at run time. Stamped into a cassette (staleness tripwire)
 *  AND into a kept run's result.json (so `verify-run` can detect a kept run that predates a skill change and
 *  refuse to vouch for answer-coverage against stale gate labels). */
export interface Fingerprint {
  baseline: string; // appVersion at record time
  skillHash?: string; // hash of the session's local skill/plugin/marketplace dir contents (if any)
  skillSources?: string[]; // the local dirs that fed skillHash (for the replay recompute + diagnostics)
  skillScope?: string[]; // the skills the hash was scoped to (empty/absent = whole-tree); diagnostics
  sharedHash?: string; // shared-root hash for scoped cassettes; absent on whole-tree or non-plugin-root mounts
  contentSig?: string; // v3+: algorithm-independent content fingerprint; used by `rehash` to verify content is unchanged across format bumps
  // v5+: per-file manifest [relpath, contentSha] of the exact files feeding skillHash, so a staleness mismatch
  // names the EXACT changed/added/removed file instead of a bucket. Paths are ROOT-RELATIVE (no host path) and
  // scanned/redacted like skillSources (privacy). Omitted (with fileSigsOmitted:true) above MANIFEST_MAX_FILES.
  fileSigs?: Array<[string, string]>;
  fileSigsOmitted?: boolean;
  // the boundary used for skillHash — "git" (git-tracked set — the DEFAULT unless COWORK_HARNESS_GITSET=0,
  // and every dir is a git work tree) or "raw" (filesystem walk; used when GITSET=0 OR any dir is not a
  // repo). A record-vs-verify mode flip makes hash comparison meaningless → re-record.
  mode?: "git" | "raw";
  // Opt-in per-skill agent scoping was active (COWORK_HARNESS_AGENT_SCOPE=skill) when this scoped hash was
  // computed — a skill-named `agents/<n>` was treated as skill <n>'s private input rather than a shared root.
  // ABSENT = the default (agents/ is a fleet-wide shared root). A record-vs-verify mismatch → re-record.
  agentScope?: "skill";
}

/** The cause-class of a replay staleness finding. `unverifiable-baseline` (env/platform: the latest baseline
 *  couldn't be loaded — says nothing about the skill) is split from `unverifiable-skill` (the harness could
 *  not check skill staleness) so the `--fail-on-skill-drift` gate can fail-closed on the latter while leaving
 *  the former a non-failing surfaced notice. `baseline` = platform bump (format-compatible, low concern);
 *  `skill`/`shared-root` = the skill source the assertions validate drifted (high concern); `format` = an
 *  older hash-format recording. `resolved-tier` = a `fidelity: cowork`
 *  cassette's recorded `effectiveFidelity` no longer matches the tier the scenario's baseline resolves to
 *  today (gate 1143815894 flipped since record — the recording exercises the WRONG tier);
 *  `unverifiable-tier` = the tier check could not run for a baseline-dependent (`fidelity: cowork`)
 *  cassette (no recorded `effectiveFidelity`, or the scenario's pinned baseline failed to load) —
 *  can't verify ⇒ not green on the verify-cassettes gate. */
export type StalenessClass =
  "baseline" | "skill" | "shared-root" | "format" | "unverifiable-baseline" | "unverifiable-skill" | "resolved-tier" | "unverifiable-tier";
export interface StalenessFinding {
  class: StalenessClass;
  message: string;
}

/** How a single AskUserQuestion gate was answered. `answeredBy` is the raw `Decision["by"]` value
 *  (scripted | first | llm | external | human | …); `answer` is the chosen option(s) flattened as
 *  "question=choice; question2=choice2"; `model` is the decider model when `answeredBy === "llm"`. */
export interface GateProvenance {
  question: string;
  answeredBy: string;
  answer: string;
  model?: string;
}

/** Run-level rollup of gate provenance: how many gates, a `by`-source histogram, and per-gate detail
 *  in ask order. Informational — surfaced in result.json / the footer / `trace --view questions` so the
 *  residual non-determinism is legible; it never changes the verdict. */
export interface GateProvenanceSummary {
  total: number;
  bySource: Record<string, number>;
  gates: GateProvenance[];
}

/** The shape persisted to `<outDir>/status.json` — a lightweight, mid-run-readable snapshot of a live
 *  or finished run, so a checker (script or agent) can answer "is this run still going, and how far
 *  along" without process-table access (`ps aux` is unreliable across sandbox/PID-namespace boundaries).
 *  Deliberately NOT a subset/superset of `RunResult` — it must be readable before any `RunResult`
 *  assembler has run, so it's populated straight from the live `RunRecord`, not from `RunResult`. See
 *  `docs/run-status.md`. */
export interface RunStatus {
  schemaVersion: 1;
  state: "running" | "done" | "error";
  pid: number;
  scenario: string;
  fidelity: string;
  sessionId: string;
  startedAt: string; // ISO-8601
  updatedAt: string; // ISO-8601 — bumped on every write, incl. terminal
  elapsedMs: number;
  toolCounts: Record<string, number>;
  subagentCount: number;
  // present only once state !== "running"
  result?: "success" | "error";
  durationMs?: number;
  // terminal-error diagnostics, surfaced so a failure-output debugger gets more than a bare "error"
  // (these live in result.json but not status.json before this). Present only on a terminal error write.
  errorSource?: "spawn" | "protocol" | "exit" | "agent" | "result" | "no_result" | "timeout";
  resultSubtype?: string;
  stderrLogPath?: string;
}

/** SDK usage payload (input_tokens, output_tokens, etc.) — pass-through, shape owned by the SDK, not the
 *  harness — plus `turns`, harness-computed from the SDK result message's `num_turns`. */
export type UsageInfo = Record<string, unknown> & { turns?: number };

/** `usd` = the SDK result message's `total_cost_usd` for this invocation, when present.
 *  `raw` = the `api_metrics` event payload (pre-existing; unrelated source, kept alongside `usd` rather
 *  than merged into it since the two are independent SDK signals). */
export interface CostInfo {
  usd?: number;
  raw?: Record<string, unknown>;
}

/** One model's cost/token entry inside the SDK result message's `modelUsage` field. Field
 *  names match the REAL observed SDK payload (empirically confirmed against a captured stream and
 *  against committed example cassettes), not a guessed shape. Every field optional since this is a
 *  passthrough of SDK-owned data, not harness-computed. */
export interface ModelUsageEntry {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
  contextWindow?: number;
  maxOutputTokens?: number;
  webSearchRequests?: number;
}

export interface RunResult {
  $schema?: string;
  generator?: string;
  /** Which lane produced this result. "run" = an asserted run/skill/record/replay (carries a verdict);
   *  "chat" = an interactive exploratory session (no assertions, no verdict — consumers must NOT read a
   *  chat result as pass/fail). Absent on results written before this field existed — treat absent as "run". */
  mode?: "run" | "chat";
  /** Execution *location* taxonomy — orthogonal to `fidelity` (a privilege/sandbox tier, all local).
   *  Stamped `location:"local"` on every locally-executed run so that a future cloud-run artifact's
   *  differing/absent stamp is a detectable signal, never a silent mislabel. `environmentId` is the
   *  cloud `environment_id` (analysis: `teleportToCloud` / bridge sessions) — absent on every local run.
   *  `taskKind` distinguishes an interactive run from a scheduled-trigger run (CoworkScheduledTasks).
   *  ABSENCE IS NOT A POSITIVE "local" SIGNAL: an absent block means EITHER a result written before this
   *  field existed (pre-taxonomy) OR the error-replay lane (an unreadable cassette, where no environment
   *  could be recovered). Do not read absence as "local"; read a present `location:"local"` as local. */
  execution?: { location: "local" | "cloud"; environmentId?: string; taskKind?: "interactive" | "scheduled" };
  scenario: string;
  prompt?: string; // the prompt that was run — persisted so `scaffold <run-dir>` can reconstruct the scenario
  fidelity: string;
  baseline: string;
  result: "success" | "error";
  resultErrorKind?: "transport" | "agent"; // when result==="error", classify a tail-end transport drop vs a genuine failure
  /** How the run terminated in error — the `error` event's finer source (`spawn`/`protocol`/`exit`/`agent`,
   *  or `result` for the SDK-wrapped is_error-result path), OR `no_result` when the stream ended with no
   *  terminal event at all (the turn/time-exhaustion case: neither a result nor an error event fired), OR
   *  `timeout` when the harness's own wall-clock limit killed the run. Additive diagnostic detail alongside
   *  the coarse verdict-relevant `resultErrorKind`; consumed by nobody in the verdict. Absent on a clean run;
   *  a run that recovered from a non-fatal `agent` error and then succeeded keeps the first observed source. */
  errorSource?: "spawn" | "protocol" | "exit" | "agent" | "result" | "no_result" | "timeout";
  /** The SDK result message's `subtype` verbatim (e.g. `error_max_turns`, `error_during_execution`,
   *  `success`) — a pass-through diagnostic so a debugger can tell turn-exhaustion from a generic execution
   *  error without the harness inventing a taxonomy. Present when a result event carried a subtype. */
  resultSubtype?: string;
  /** Absolute path to the agent's full stderr log (`<outDir>/agent.stderr.log`), surfaced so an
   *  OOM/crash debugger knows where to look. Live path only — absent on replay (no live process). */
  stderrLogPath?: string;
  // the run ended on a question having done no productive tool work after its last gate (the agent
  // asked for input and stopped) while result==="success". A false-green: the SDK turn didn't error, but the
  // task did not complete. computeVerdict fails on this (a `stalled` signal) unless the scenario asserts
  // allow_stall. Scenario-lane only; re-derived by the detector in run.ts on both the live and replay
  // re-drive (NOT a persisted-then-read flag).
  stalledOnQuestion?: boolean;
  // capability-probe outcome, so the guard roster can show "ran clean" (definitive) distinctly from
  // "couldn't verify" (unverified) and "didn't run" (skipped) — never a false ✓ for a guard that didn't run.
  capabilityProbe?: "definitive" | "unverified" | "skipped";
  // declared `requires_capabilities` the running tier could not satisfy — computed at run time
  // (so verify-run/replay honor it without re-deriving). `omitted` = the image lacks them; `unverifiable` =
  // the tier couldn't probe (protocol/replay/skip). computeVerdict fails on this unless allow_missing_capability.
  requiresCapabilityUnmet?: { caps: string[]; reason: "omitted" | "unverifiable" | "unknown" };
  decisions: Array<{
    kind: string;
    name: string;
    decision: string;
    by?: string;
    // request_id (UUID) of a question gate — lets `trace --view questions` pair a decision to its event row by id
    // instead of positionally (retried/duplicated gate events would shift a positional pairing). Optional.
    requestId?: string;
    model?: string;
    detail?: unknown;
    rationale?: string;
    // The full AskUserQuestion option set (label + description) as originally offered by the model —
    // present only on kind:"question" decisions. Additive to `detail` (which already carries the flat
    // {question: chosen-answer} map) so no existing detail-reading consumer needs to change.
    questions?: Array<{ question: string; header?: string; options: { label: string; description?: string }[]; multiSelect?: boolean }>;
  }>;
  toolCounts?: Record<string, number>; // truthful per-tool call count (use this, NOT usage.server_tool_use which is host-routed-blind in cowork)
  /** Structured WebSearch calls — query + per-result {title,url}, parsed from the paired tool_result's
   *  "Web search results for query: ...\n\nLinks: [...]" convention (an AGENT-BINARY convention,
   *  verified against a real captured hostloop-fidelity cassette — re-verify the format on agent-version
   *  bumps). A parse failure (truncated past the assertText cap, or a future format change) drops that
   *  ONE entry silently — it is never a partial/malformed entry in this array. Collapsed to `undefined`
   *  (matching `models`/`thinking`/`tasks`) both when the run made zero WebSearch calls AND when every
   *  call's Links array failed to parse — the two are indistinguishable here by design; cross-reference
   *  `toolCounts.WebSearch` (the truthful call count) if that distinction ever matters to a consumer. */
  webSearches?: Array<{ toolUseId?: string; query: string; results: Array<{ title: string; url: string }> }>;
  /** Infrastructure errors (VM/egress sidecar crashes). A non-empty list is a hard verdict fail on BOTH
   *  lanes and is NOT author-suppressible — the run's evidence is contaminated. */
  infraErrors?: Array<{ source: string; message: string }>;
  /** Companion counters for malformed/dropped telemetry streams. A >0 count makes the dependent assertion
   *  fail "malformed" rather than silently dropping the bad entries (`taskTracking` → task assertions,
   *  `presentFilesMalformed` → no_scratchpad_leak); `webSearchParse` is observability-only (no assertion). */
  evidenceErrors?: { taskTracking?: number; webSearchParse?: number; presentFilesMalformed?: number };
  // per-tool call-count/timing aggregate, folded from the timeline. Absent only when no
  // timeline data exists for this run (replayErrorResult — no run ever happened). Populated for
  // buildPartialResult too, when the salvaged run made at least one tool call. Wall-gap between
  // tool_use and tool_result, NOT isolated script CPU time — see foldToolDurations's doc comment
  // (src/run/timeline-fold.ts) for the honesty caveat.
  toolDurations?: Record<string, { calls: number; totalMs: number; maxMs: number }>;
  // distinct model ids seen across assistant_text/tool_use/thinking events, in first-seen order.
  // Absent only when replayErrorResult (no run ever happened). Populated for buildPartialResult too,
  // when the salvaged run had at least one assistant message.
  models?: string[];
  // reasoning blocks surfaced for debugging — capped at the last 50 blocks (older ones
  // silently dropped; see `thinkingElided` below for the dropped count). An author reads the
  // tail of reasoning, not a full history.
  // Scrubbed by the same secret-redaction pass as the rest of result.json.
  thinking?: Array<{ text: string }>;
  /** Count of reasoning blocks dropped past the 50-block cap on `thinking[]` (see `thinking`'s own doc
   *  comment) — lets a consumer tell "this is everything" from "this is the tail of a much longer chain
   *  of reasoning." 0 whenever the run produced a `thinking[]` array at all (capped or not) — a
   *  meaningful "never hit the cap" signal, not an absence marker. `undefined` only on lanes where no
   *  run/record ever existed (e.g. an unreadable-cassette replay bail). */
  thinkingElided?: number;
  // per-tool call/error rollup — same top-level-only scoping as toolCounts (sub-agent-internal
  // tool calls are tracked separately via subagents[].toolsUsed, not folded in here).
  toolErrors?: Record<string, { calls: number; errors: number }>;
  /** Per-model cost/token breakdown, denormalized from the SDK result message's own `modelUsage` field —
   *  cumulative for the whole run, NOT per-turn (see the per-message `usage` object noted
   *  as a future opportunity, not built here). Field names match the REAL observed
   *  SDK payload (empirically confirmed), not a guessed shape. Every field optional since this is a
   *  passthrough of SDK-owned data, not harness-computed. */
  modelUsage?: Record<string, ModelUsageEntry>;
  // repeated identical tool calls — count>=2 groups only, an optimization signal. argHash is a
  // truncated sha256 of the canonicalized {name,input} pair — no raw args in the rollup (they stay in
  // toolResults/events, which already carry them); this field is redaction-safe by construction.
  redundantToolCalls?: Array<{ name: string; argHash: string; count: number }>;
  // per-skill-invocation window rollup — a heuristic, sticky, ordinal window (see the field's
  // full honesty caveat in docs/cassette.md): for INLINE skills, an unrelated
  // top-level tool call after the skill's real work but before the next Skill invocation is still
  // attributed to this window (faithfully reproducing the real agent's own activeSkill no-pop
  // behavior, not a looser approximation of it). A window's toolCounts/toolCallCount also include tool
  // calls made by any sub-agent dispatched during that window, not just literal top-level calls (mirrors
  // foldToolDurations's same subagent-inclusive scope). Absent only when no timeline data exists for this run.
  skillActivity?: Array<{
    skillId: string;
    invocationSeq: number;
    toolCounts: Record<string, number>;
    toolCallCount: number;
    dispatchCount: number;
    durationMs?: number;
  }>;
  // did each gate's answer reach the model? `reason` distinguishes a `delivered:null` that means
  // "no pairing metadata" (no toolUseId) from one that means "tool result not observed".
  gateDeliveries?: Array<{
    question: string;
    delivered: boolean | null;
    error?: string;
    reason?: "ok" | "errored" | "unobserved" | "no-pairing-metadata";
  }>;
  egress: Array<{
    host: string;
    decision: "allow" | "deny";
    ts?: number; // ms epoch of the decision
    method?: string;
    path?: string; // omitted for CONNECT/HTTPS (encrypted)
    port?: number;
    bytes?: number; // response/tunnel bytes on an allow
    reason?: string; // denial reason (e.g. "not on allowlist")
  }>;
  // `evidence` (passing checks only) is the concrete file/value/tool/link that satisfied the assert —
  // surfaced by `replay --explain` so a green can be trusted rather than assumed vacuous. Optional: a check
  // with nothing concrete to cite omits it.
  assertions: Array<{
    assertion: Assertion;
    pass: boolean;
    message?: string;
    evidence?: string;
    /** Per-claim results for a `semantic_matches` assert (aligned to its rubric by index) — present only
     *  on the live lane where the judge ran; a consumer can diff these across runs to gate a change. */
    semanticClaims?: Array<{ index: number; claim: string; pass: boolean }>;
  }>;
  /** The agent's final answer — the SDK result message (`{type:"result"}`.result), i.e. the model's
   *  designated final response. This is what llm-transport treats as "the answer"; it is distinct from
   *  the full joined transcript (every assistant turn concatenated). Surfaced so a consumer reads the
   *  answer from the envelope instead of parsing run.jsonl. Absent when no result event carried text
   *  (e.g. a spawn/exit error before the result). */
  finalMessage?: string;
  /** 1-based turn number within a resumed (`--session-id` + `--resume`) session — 1 for a normal
   *  single-shot run, incrementing per resume. `result.json`/`run.jsonl` hold the LATEST turn; prior
   *  turns are archived as `result.turn-<N>.json` / `run.turn-<N>.jsonl`. Lets a multi-turn consumer
   *  attribute a result to its turn instead of blending cumulative telemetry. Absent on replay/chat
   *  lanes that don't track it. */
  turn?: number;
  subagents?: Array<{
    toolUseId: string;
    parentToolUseId?: string;
    agentType: string;
    declaredTools: string[];
    toolsUsed: Array<{ name: string; count: number }>;
    description?: string;
    prompt?: string; // dispatch input.prompt, assertText-capped
    model?: string; // the dispatching message's model
    output?: string; // the dispatch's own paired tool_result, assertText-capped
    attributedSkillId?: string; // the skill-activation window this dispatch was attributed to — NOT Fingerprint.skillScope (a different, unrelated field)
  }>;
  /**
   * Decisions answered by a non-deterministic / non-authoritative source (LLM, external helper,
   * human, or the `first`-option fallback). Scripted answers (by:"scripted") are excluded because
   * they are authoritative and deterministic.
   */
  nonReproducibleAnswers?: Array<{ question: string; chosen: string; by: string; rationale?: string; model?: string }>;
  usage?: UsageInfo;
  cost?: CostInfo;
  durationMs?: number;
  // Skill/plugin staleness fingerprint at run time. Persisted so `verify-run` can detect a kept run that
  // predates a skill change (its gate snapshot is stale → don't vouch for answer-coverage against it).
  fingerprint?: Fingerprint;
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
  /** Subset of `userVisibleRoots` that are read-only (`mode: "r"`) connected-folder mounts — inputs, not
   *  deliverables. The cassette recorder strips captured BODIES under these prefixes (path + sha256
   *  survives, so `computer_links_resolve` still resolves on replay); `RunResult.artifacts` excludes
   *  them outright so `scaffold` doesn't emit `file_exists` for an input. `userVisibleRoots` itself is
   *  UNCHANGED — `no_unexpected_files` / `computer_links_resolve` still enumerate every folder. */
  readonlyFolderRoots?: string[];
  // ENV-MANIFEST: files written under the user-visible roots (outputs/ + connected folders), relative paths
  // + sizes. Paths only (no content snapshot — that is the cassette manifest). Kills path-guessing and
  // makes an all-or-nothing truncated run (empty manifest) detectable. NOT sufficient for mid-write truncation.
  artifacts?: { path: string; bytes: number }[];
  /** workRoot-relative paths that existed under the user-visible roots BEFORE the agent ran (captured
   *  post-staging, pre-spawn; `pre-run-manifest.json`) — the baseline `no_unexpected_files` diffs
   *  against. undefined = the tier didn't capture (microvm) or the run predates the seam; the
   *  assertion then fails evidence-unavailable, never vacuous-passes. */
  preRunPaths?: string[];
  /** True iff `preRunPaths` was captured with the LINK-AWARE walk (manifest v2+, post-#38) — i.e. it lists
   *  symlink/hardlink entries. Absent/false ⇒ a pre-#38 baseline; `no_unexpected_files` then excludes link
   *  entries from the post walk so a pre-existing symlink on a re-verified pre-upgrade run dir is not a
   *  false stray. Only meaningful on the live/verify-run lanes (replay's materialized tree has no symlinks). */
  preRunLinkAware?: boolean;
  /** Per-path sha256 of the user-visible tree BEFORE the agent ran (from pre-run-manifest.json's
   *  `hashes`). null for a file over the pre-run hash cap. Powers `input_unmodified`. undefined =
   *  no manifest / an older run without hashes — the assertion then fails evidence-unavailable. */
  preRunHashes?: Record<string, string | null>;
  /** True when the run did NOT complete because it exited on an unanswered gate, but its work (artifacts,
   *  events, partial transcript) was salvaged to disk anyway so it's still inspectable. A partial run still
   *  exits non-zero; consumers (verify-run, scaffold) must NOT treat its artifacts/result as a passing
   *  outcome. Absent on a normal run. */
  partial?: boolean;
  /** On a `partial` run, the unanswered gate that ended it — `message` is the decider's failure text (the
   *  question is embedded in it) and `hint` is the actionable remedy. */
  unansweredGate?: { message: string; hint?: string };
  nonDeterministic?: boolean; // true if any decision was made by a non-deterministic source (by:"llm"|"external"|"human"|"first") — a green run is NOT reproducible
  /** True when the CONFIGURED terminal (on_unanswered: llm/prompt, or an external channel) could answer
   *  non-deterministically — even if THIS run was fully scripted and didn't hit it. `nonDeterministic`
   *  stays execution-truth (what replay relies on); this is config-truth for audit consumers. */
  nonDeterministicTerminal?: boolean;
  /** tools auto-allowed by cowork parity for unscripted, off-registry permission requests — real Cowork BLOCKS these for the user. A non-empty list means a green is NOT a faithful pass (pin with --answer or permission_parity: strict). */
  permissiveAutoAllow?: string[];
  /** Post-run scan signals (live lane only). computeVerdict default-fails on `outputsDeletes`/`hostPathLeaked`
   *  when the scenario did NOT author the matching assertion. Absent on the replay lane (a cassette can't reproduce them). */
  scan?: { outputsDeletes: string[]; hostPathLeaked: boolean; selfHealRan: boolean };
  /** The fidelity tier actually used. Equals `fidelity` unless `fidelity:"cowork"` resolved to a specific tier. */
  effectiveFidelity?: string;
  /** structured fidelity warnings (prompt asset gaps, version mismatches) — visible to JSON callers,
   *  not just stderr. Populated when a non-fatal prompt warning is emitted during a run. */
  fidelityWarnings?: string[];
  /** Replay-lane only: class-tagged cassette-staleness findings, surfaced to JSON callers so a token-free CI
   *  gate can see staleness WITHOUT it changing the verdict (a stale, otherwise-passing replay stays `ok:true`
   *  by default). Populated on every replay that runs the staleness check — incl. `unverifiable-*` when the
   *  check couldn't complete, so a consumer can distinguish "verified clean" from "couldn't verify". The
   *  `--strict` / `--fail-on-skill-drift` gates turn selected classes into failing assertions; this field
   *  itself is pure data. Absent on the live lane (no cassette to compare). */
  staleness?: StalenessFinding[];
  /** Replay-lane only: count of assertions NOT evaluated on replay because they are live-only (filesystem /
   *  egress / expect_denied). `full` = the whole assertion was skipped; `partial` = its content half ran but a
   *  filesystem/egress half was dropped. Surfaced so a CI script doesn't read a green replay as having checked
   *  everything. The skipped assertions are absent from `assertions[]` (filtered before evaluation). */
  skippedAssertions?: { full: number; partial: number };
  /** Tool-result text at assertion-fidelity cap (10 KB per result). Used by `tool_result_contains` /
   *  `tool_result_not_contains`. `assertText` is preferred when present; falls back to `text` (500-char
   *  display cap) for cassettes recorded before this field was added. */
  toolResults?: { toolUseId?: string; isError: boolean; text: string; assertText?: string }[];
  /** true when L0 (protocol) ran with plugins that loaded via --settings/managed config instead of
   *  --plugin-dir (the Cowork cache layout). computeVerdict fails on this unless allow_l0_plugin_divergence
   *  is asserted — a warn-only was insufficient since the run could still appear green. */
  l0PluginDivergence?: boolean;
  /** Capability families the agent image OMITS but the skill was observed USING (live lane only; the
   *  intersection of the image's probed `omitted` set and capability-usage detected in events.jsonl).
   *  computeVerdict default-fails on a non-empty list unless `allow_missing_capability` is asserted — a
   *  green run that used an omitted capability is a likely FALSE NEGATIVE (real Cowork ships it). Absent on
   *  replay (no live image to probe). */
  missingCapabilityUse?: string[];
  /** Per-gate answer provenance: how each AskUserQuestion gate was answered (scripted / decided(llm|external)
   *  / first-option / prompt), with a `bySource` histogram. Informational — it makes the residual
   *  non-determinism legible so a reviewer sees which assertions sit downstream of a decided (non-reproducible)
   *  gate. Absent when the run had no gates, and absent on the replay lane (which reports reproducibility via
   *  nonDeterministic:false, not per-gate provenance). Derived from `decisions[]` at write time. */
  gateProvenance?: GateProvenanceSummary;
  /** Skill/plugin ids invoked via the Skill tool_use event (`{plugin}:{skill}`), in call order, duplicates
   *  kept (re-triggering is signal). Backs `skill_triggered`/`no_skill_triggered`. Absent on a run from an
   *  older result.json format — `no_skill_triggered` treats absence as evidence-unavailable, never a
   *  vacuous pass. */
  skillsInvoked?: string[];
  /** Whether the agent's init tool list included "Skill" — false means this runtime/agent version can't be
   *  observed invoking a skill through the recognized channel, so `skill_triggered`/`no_skill_triggered`
   *  fail as evidence-unavailable rather than risk a false negative on an agent-version tool rename. */
  skillToolAvailable?: boolean;
  // Progress panel — deleted tasks are omitted (never appear here). `status` is a plain
  // string (NOT a narrow "pending"|"in_progress"|"completed" literal union) deliberately: live
  // verification only observed those 3 + no delete/cancel path; a real but unobserved status value
  // (e.g. "failed"/"cancelled") should be stored faithfully, not silently coerced or dropped.
  tasks?: Array<{ id: string; subject: string; status: string; description?: string; activeForm?: string }>;
  // Context/Connectors panel. mcpServers is loosely typed (SDK-owned per-server shape,
  // pass-through). availableSkills is read straight off each staged skill's SKILL.md frontmatter at
  // RunResult-assembly time (src/run/skill-metadata.ts) — it is NOT accumulated on RunRecord like
  // tools/mcpServers, since it needs no live event data, only the on-disk staged skill set.
  context?: {
    // tools/mcpServers are present only once the SDK system/init event arrives; undefined on a pre-init
    // crash (evidence-unavailable, NOT an empty inventory). availableSkills is re-derived from disk.
    tools?: string[];
    mcpServers?: Array<{ name: string; status?: string; [k: string]: unknown }>;
    availableSkills?: Array<{ id: string; whenToUse?: string }>;
  };
  // Working folder panel's canonical file model (Scratch pad's "scratchpad" class
  // deliberately not implemented). `artifacts` (unchanged type, {path,bytes}[])
  // becomes a DERIVED accessor of this — the class∈{output,mount} subset, computed in the
  // assembler at read time (no drift risk: nothing stores `artifacts` independently anymore, on the
  // live lane; replay is unaffected).
  workspaceFiles?: Array<{ path: string; bytes: number; sha256?: string; hashError?: string; class: "output" | "mount" | "input" }>;
  /** `system` stream messages the harness doesn't special-case — e.g. `compact_boundary`. In the
   *  stdout stream, so reproduced on replay. Powers `compaction_occurred`. */
  contextEvents?: Array<{ subtype: string; ts?: number; data?: Record<string, unknown> }>;
  /** MCP round-trips the harness answered with a JSON-RPC error (no handler, or the handler threw).
   *  Live-only — MCP round-trips are harness-computed, not in the SDK stdout stream, so absent on
   *  replay (the assertion then fails evidence-unavailable, never vacuously passes). */
  mcpErrors?: Array<{ server: string; code?: number; message: string }>;
  /** PreToolUse hook fire/block events. Reconstructed on replay only when the cassette carries
   *  `controlOut` (a custom hook's decision lives there, not in the stream) — else the hook assertions
   *  are excluded-loud, never vacuously passed. */
  hookEvents?: Array<{ callbackId: string; decision: "block" | "allow"; reason?: string; tool?: string }>;
  /** Files delivered via the cowork `present_files` tool, in call order — one entry per file the agent
   *  presented, derived from pairing each `mcp__cowork__present_files` tool_use with its own
   *  tool_result. `promoted` = the file was in the scratchpad and landed under `mnt/outputs`; `leaked` =
   *  it was in the scratchpad but did NOT land there (present_files' own copy-failure branch — the file
   *  "remains in the scratchpad", not deliverable to the user). A path already under a mount
   *  (passthrough) is neither. CONTENT-CLASS: both the tool_use and tool_result live in the ordinary
   *  events stream, so this is re-derived identically on the replay re-drive — undefined only means no
   *  `present_files` telemetry was recorded for this run (an older run predating the feature), the
   *  evidence-unavailable signal for `no_scratchpad_leak`; an empty `[]` is a valid "nothing presented"
   *  state and is NOT the same as undefined. */
  presentedFiles?: Array<{ from: string; to: string; promoted: boolean; leaked: boolean }>;
  /** Resource-usage telemetry sampled while the run executed (peak RSS, avg/peak CPU%). Live + tier-
   *  dependent (container/hostloop/microvm); undefined on protocol/replay, on a run shorter than one
   *  sample interval, and when the tier's probe tool was unavailable — the `max_peak_rss_bytes`
   *  assertion then reads evidence-unavailable, never a vacuous pass. microvm RSS is whole-VM (coarser
   *  than container/hostloop's per-container/per-process figure). */
  resources?: {
    tier: string;
    sampleCount: number;
    intervalMs: number;
    peakRssBytes?: number;
    avgCpuPct?: number;
    peakCpuPct?: number;
    /** Count of malformed `resources.jsonl` lines encountered while folding. >0 means the resource
     *  telemetry is partially corrupt — resource assertions fail malformed rather than silently
     *  dropping the bad lines. Absent on cassettes recorded before this field existed. */
    malformedLines?: number;
  };
}
