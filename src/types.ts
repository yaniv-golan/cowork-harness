import { z } from "zod";
import { KNOWN_HOOK_EVENTS } from "./agent/session.js";

/** Cowork's `DEFAULT_MAX_THINKING_TOKENS` (the ELF's `hre`), binary-verified = 31999 — the ONE budget
 *  extended thinking ever runs at when it's ON (there is no arbitrary N; off is 0/disabled, never a
 *  smaller positive number). The single source for the `--max-thinking-tokens <N>` value argv.ts emits
 *  when `extended_thinking` resolves ON, so it can't drift. Never used as an env value — real Cowork
 *  delivers the budget as a CLI flag only (`--max-thinking-tokens` / `--thinking disabled`), no
 *  `MAX_THINKING_TOKENS` env var. */
export const DEFAULT_MAX_THINKING_TOKENS = 31999;

/** PlatformBaseline — VOLATILE per-release facts (one synced snapshot per Cowork release), from cowork-sync. */
const MountSpec = z.object({
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
    // Desktop ALSO stages a native macOS Mach-O binary (claude-code/<ver>/claude.app/Contents/MacOS/claude, or
    // per build from Desktop 2.19675.0: claude-code/<ver>/<build>/claude.app/…; see parseNativeStagedPath)
    // alongside the Linux/arm64 ELF above — hostloop's agent loop runs on the host directly from this
    // binary (no container), while only bash/web_fetch route into a VM. The ELF stays the source of
    // truth for container/microvm and for hostloop's bash/web_fetch VM sidecar image. Optional: a
    // baseline synced before this field existed has no native binary staged, so hostloop falls back to
    // resolveHostAgentBinary's loud failure (never a silent tier downgrade).
    nativeStagedPath: z.string().optional(),
    // The native build PER CPU ARCHITECTURE (Desktop >= 2.19675.0 stages per build, and the darwin-arm64 and
    // darwin-x64 bundles have different checksums, so one version has a different <build> on each). The 12-hex
    // build dir name, from the asar's SDK descriptor at sync time, for the version nativeStagedPath pins. The
    // resolver checks the build ONLY against the host arch's entry; with no entry for the host arch it matches
    // by version alone (with a note). Absent on older baselines, which keep the pre-map rule (the build named in
    // nativeStagedPath, if any). nativeStagedPath itself is unchanged: the syncing machine's own path.
    nativeBuilds: z
      .object({
        arm64: z
          .string()
          .regex(/^[0-9a-f]{12}$/)
          .optional(),
        x64: z
          .string()
          .regex(/^[0-9a-f]{12}$/)
          .optional(),
      })
      .optional(),
    // Provenance of the Linux/arm64 ELF at stagedPath — shared, non-secret (just hashes), improves
    // repro/fidelity. `sha256`: hex SHA-256 of the ELF. `shaProvenance`: "measured-local" = hashed from
    // the staged binary at sync time (the trustworthy point-of-truth); "official-manifest" = copied from
    // Anthropic's per-version release manifest for a version NOT staged on the syncing machine, so
    // staging-identity is UNVERIFIED (byte-identity between the staged binary and the official release is
    // confirmed only for versions actually measured; Desktop could in principle repack what it stages).
    // `manifestChecksumMatch`: set ONLY on measured-local rows — whether the measured hash equalled the
    // official manifest checksum published at `releaseBaseUrl` ("unknown" if that manifest was
    // unreachable OR not served at sync time — `sync`'s own output distinguishes the two, the field does
    // not); omitted on official-manifest rows (there it would compare the manifest hash to itself →
    // tautological). Deliberately still two-valued on the wire: the field has no runtime consumer, and
    // adding a third literal to a union consumers switch on is a covered-surface change (SPEC.md §12)
    // bought for a distinction the WARNING/NOTE split already delivers to the human who reads it.
    // NO nativeSha256: the signed+notarized inner Mach-O embeds an LC_CODE_SIGNATURE and never equals any
    // manifest hash, so a manifest-derived native hash would match nothing on the hostloop path.
    sha256: z.string().optional(),
    // `releaseBaseUrl`: the release channel Desktop staged this agent FROM, read out of the asar's SDK
    // descriptor at sync time — `https://downloads.claude.ai/claude-code-releases`, or
    // `…/claude-code-releases/rc/<40-hex commit>` for a release CANDIDATE. Three jobs: it names the
    // source `manifestChecksumMatch` agreed with (without it the boolean is an unattributed claim); it
    // makes the ELF-recovery runbook mechanical instead of a guess; and a stable<->RC flip is a real fact
    // about how Desktop ships, surfaced as a `sync --diff` line. Recomputed every sync (it is derived
    // from the local asar, so it needs no network and has no carry-forward branch); absent on baselines
    // written before this field existed, all of which were stable-staged or later promoted.
    releaseBaseUrl: z.string().optional(),
    shaProvenance: z.enum(["measured-local", "official-manifest"]).optional(),
    manifestChecksumMatch: z.union([z.boolean(), z.literal("unknown")]).optional(),
    // String sentinels: literal-occurrence counts of feature markers in the staged ELF whose runtime
    // STATE the sync cannot see via a gate id or a spawn-env key (e.g. `tengu_saddle_lantern`, which at
    // agent >=2.1.217 gates the skill-discovery tool family's enablement).
    // Measured when the ELF is staged, carried on an offline same-version re-sync, else dropped. Pure
    // `sync --diff` tripwire: a changed count is the trigger to re-verify the feature wiring; nothing
    // consumes it at runtime.
    stringSentinels: z.record(z.string(), z.number()).optional(),
  }),
  guest: z.looseObject({ os: z.string(), arch: z.string(), baseImage: z.string().optional() }),
  spawn: z
    .looseObject({
      configDirInGuest: z.string().default("mnt/.claude"),
      settingSources: z.array(z.string()).default(["user"]),
      permissionMode: z.string().default("default"),
      // Synced fact (hand-pinned; sentinel S4 in cowork-sync.ts VALUE-pins the resolved const to 31999).
      // NOT read as a runtime env-value fallback anymore — extended thinking is a boolean toggle
      // (`extended_thinking`) resolved directly to `DEFAULT_MAX_THINKING_TOKENS` at argv emission; this
      // field stays only as the synced provenance record for that constant.
      maxThinkingTokens: z.number().default(DEFAULT_MAX_THINKING_TOKENS),
      effortDefault: z.string().default("medium"),
      // Per-model effort config (baseline seam for the reasoning-config fidelity work): the literal
      // per-model map (each id's {effortLevels?, recommended?, modes?} — a no-effort model like
      // claude-haiku-4-5/claude-sonnet-4-5 has no effortLevels, so no picker) plus the regex-default
      // entry + class regex applied to an id NOT in the literal map (e.g. the fable/mythos family).
      // Synced by cowork-sync.ts's extractModelEffortConfig; drift-guarded by checkSpawnContractFacts's
      // S20 sentinel. Optional: an older baseline synced before this field existed simply omits it.
      effortByModel: z
        .record(
          z.string(),
          z.object({
            effortLevels: z.array(z.string()).optional(),
            recommended: z.string().optional(),
            modes: z.array(z.string()).optional(),
            // Additive since Desktop 1.24012.9 (first seen on claude-opus-5). Optional, so baselines
            // synced before it existed — and the many entries that still omit it — stay valid.
            disallowThinkingDisabled: z.boolean().optional(),
          }),
        )
        .optional(),
      effortRegexDefault: z
        .object({
          pattern: z.string(),
          effortLevels: z.array(z.string()),
          recommended: z.string(),
          modes: z.array(z.string()),
          disallowThinkingDisabled: z.boolean(),
        })
        .optional(),
      tools: z.array(z.string()).default([]),
      allowedTools: z.array(z.string()).default([]),
      env: z.record(z.string(), z.string()).default({}),
      promptTemplate: z.string().optional(),
      subagentAppend: z.string().optional(),
      subagentAppendHostLoop: z.string().optional(),
      // The hook bundle real Cowork installs on the agent `initialize`, keyed by event name, each entry
      // identifying ONE hook by its matcher plus a short note on what it does. Recorded as HAND-PINNED
      // DOCUMENTATION, not as an emulation source: the harness serves only `PreToolUse:Task` (see
      // SERVED_HOOK_EVENTS in src/agent/session.ts for why).
      //
      // DEMOTED 2026-09-06 — this comment used to call the field a DRIFT TRIPWIRE whose job was to make
      // a Desktop release that "adds, drops, or re-matchers a hook show up as baseline drift". It cannot
      // do that, and never could. `sync` neither derives nor validates the field's CONTENT: cli.ts
      // spreads `spawn` forward from the base baseline, so `hooks` carries through every sync untouched,
      // and no `check*Facts` sentinel in cowork-sync.ts covers it (the 30-odd hook references there all
      // belong to checkPathHookFacts, a different subsystem). The zod shape below is validated on load;
      // nothing compares it to the asar.
      //
      // The claim was disproved by its own subject. The force-ask entry's note read "permissionDecision:
      // 'ask' regardless of permission mode" in FOURTEEN consecutive baselines, 1.24012.9 through
      // 1.46388.3, and was false in every one of them. The scheduled-task early return shipped in
      // Desktop 1.22209.0 — BEFORE 1.24012.9, the first baseline to carry this field, so that note was
      // already wrong for 5 of the 9 tools on the day it was first committed. The builtin early return
      // shipped three baselines later, at 1.26832.0, making it wrong for all 9 from there on. Every
      // sync was green throughout. Believing the tripwire existed is what let it rot; saying so plainly
      // is cheaper than building the sentinel that would make the old sentence true (a literal anchor
      // over a hand-written descriptor, which is the release-day wedge cowork-sync.ts already warns
      // about). Treat a note here as a dated observation, and re-verify it against the asar before
      // relying on it.
      //
      // `matcher: null` means the hook carries no matcher (production's UserPromptSubmit hook is not
      // tool-scoped). Optional, so every baseline synced before this field existed stays valid.
      hooks: z
        .record(
          z.string(),
          z.array(z.object({ matcher: z.string().nullable(), note: z.string().optional(), served: z.boolean().optional() })),
        )
        .optional(),
    })
    .partial()
    .optional(),
  mountLayout: z.object({
    sessionRoot: z.string(),
    cwd: z.string(),
    mntRoot: z.string().optional(),
    mounts: z.array(MountSpec),
  }),
  // looseObject (like the top level and `spawn`): `allowDomains` is a PINNED, hand-curated list that
  // documents its own provenance in a `$comment` sibling. A strict z.object silently strips that note
  // on every load, so the explanation for why the list is not derived would evaporate at the next sync.
  network: z.looseObject({
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

/** Desktop's OWN SDK-MCP servers — the only server names `sync` may record from a real Desktop init frame
 *  (`provenance.desktopInitSurface`). A closed literal set, matched with `===`: never a pattern and never a
 *  denylist, because every other name in a real init frame is the operator's connector/MCP inventory.
 *
 *  Deliberately NOT `KNOWN_COWORK_SERVERS` (src/scan.ts): that set is what the HARNESS serves, it includes
 *  `workspace`, and it guards cassettes. Coupling the two would let an edit made for the cassette guard
 *  widen what sync publishes. Adding a server here is a reviewed decision (`workspace` was declined). */
export const DESKTOP_OWN_SERVERS = ["cowork", "plugins", "skills"] as const;

/** A recorded tool name: a SHAPE allowlist (lowercase identifier, no `__`), so a UUID, a path or a
 *  second-level `mcp__` split can never be a valid entry. */
const DesktopToolList = z.array(
  z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,63}$/)
    .refine((s) => !s.includes("__")),
);
const DesktopInitServer = z.strictObject({
  presence: z.enum(["all", "some"]),
  toolsAll: DesktopToolList,
  toolsSome: DesktopToolList,
});
const isSortedUnique = (xs: readonly string[]) => xs.every((x, i) => i === 0 || xs[i - 1] < x);

/** `provenance.desktopInitSurface` — the tool surface Desktop's own servers declared in real Cowork
 *  sessions of the synced release. STRICT at every level, so any key beyond these (a `cwd`, a raw server
 *  list, a frame count) fails validation. Enforced before sync writes it and over every committed baseline
 *  (test/baseline.test.ts). Deliberately NOT attached to `PlatformBaseline`: `loadBaseline` parses at every
 *  call site, so a malformed block there would brick `sync` itself and could only be fixed by hand. */
export const DesktopInitSurface = z
  .strictObject({
    agentVersion: z.string().min(1),
    appVersion: z.string().min(1),
    observed: z.boolean(),
    servers: z.strictObject({
      cowork: DesktopInitServer.optional(),
      plugins: DesktopInitServer.optional(),
      skills: DesktopInitServer.optional(),
    }),
  })
  .superRefine((v, ctx) => {
    const names = Object.keys(v.servers);
    if (!v.observed && names.length > 0) ctx.addIssue({ code: "custom", message: "observed:false must carry no servers" });
    for (const [name, s] of Object.entries(v.servers)) {
      if (!s) continue;
      if (!isSortedUnique(s.toolsAll) || !isSortedUnique(s.toolsSome))
        ctx.addIssue({ code: "custom", message: `servers.${name}: tool lists must be sorted and duplicate-free` });
      if (s.toolsAll.some((t) => s.toolsSome.includes(t)))
        ctx.addIssue({ code: "custom", message: `servers.${name}: toolsAll and toolsSome must be disjoint` });
    }
  });
export type DesktopInitSurface = z.infer<typeof DesktopInitSurface>;

/** Scenario — what the user authors. */
export const AnswerRule = z
  .strictObject({
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
// A tool GLOB value (only `*`/`?` are special). Reject an empty string AND regex/brace-expansion
// metacharacters — both match no real tool name and would pass a `_not_`/`_absent` assert VACUOUSLY. Enforced
// in the schema (so a recorded cassette's frozen assert is caught on read too, not only authored scenarios).
const toolGlob = z
  .string()
  .min(1, "tool glob is empty — an empty glob matches no tool and passes vacuously")
  .refine((g) => !/\.\*|\.\+|[|()[\]+^${}]|\\[dwsb]/.test(g), {
    message: "tool glob looks like a regex or brace-expansion — only * and ? are special (no .* | [] {})",
  });

/** The fields the STRUCTURED (object) form of `tool_called` / `tool_not_called` shares. The string form
 *  is a name glob over the main agent's calls and nothing else; this form also reads each call's INPUT,
 *  WHERE it ran, and its PAIRED result — the only way to assert what a command actually ran, since every
 *  `transcript_*` key reads top-level prose and never a tool_use. Every regex here is case-insensitive
 *  and unanchored, like `transcript_matches`. */
const toolCallObjectFields = {
  tool: z
    .union([toolGlob, z.array(toolGlob).min(1, "tool list is empty — it names no tool and matches nothing")])
    .describe(
      "tool-name glob, or a LIST of globs (any-of) — same glob and legacy-spelling rules as the string form. List both shells (`[Bash, mcp__workspace__bash]`) for a claim that must hold at every tier: hostloop routes shell through mcp__workspace__bash",
    ),
  input: z
    .record(z.string(), z.string().min(1, "an empty input regex matches every value and passes vacuously"))
    .optional()
    .describe(
      "top-level input field → regex (case-insensitive, unanchored); ALL must match. A missing field is no match; a non-string value is matched against its JSON. Each field is captured up to 10 KB",
    ),
  input_any: z
    .string()
    .min(1, "an empty input_any regex matches every call and passes vacuously")
    .optional()
    .describe("regex (case-insensitive, unanchored) that must match SOME top-level input field (non-strings as JSON)"),
  result: z
    .strictObject({
      matches: z.string().min(1).optional().describe("regex (case-insensitive) the paired result text must match"),
      not_matches: z.string().min(1).optional().describe("regex (case-insensitive) the paired result text must NOT match"),
      is_error: z.boolean().optional().describe("the paired result's error flag must equal this"),
    })
    .optional()
    .describe(
      "predicates on the call's PAIRED tool_result (joined by toolUseId; 10,240 chars of text, 32,768 for a top-level Skill result). An unpaired call never satisfies them, and a truncated result that cannot settle a predicate is evidence-unavailable, never a pass",
    ),
  scope: z
    .enum(["main", "subagent", "any"])
    .optional()
    .describe(
      "which calls count. `main` (default): the main agent, including a Skill's or Agent(fork)'s children — the set the string form reads. `subagent`: calls whose parent is a sub-agent dispatch this run recorded, at any nesting depth. `any`: every call, including one whose parent is NOT a recorded dispatch (e.g. a Skill invoked inside a sub-agent)",
    ),
  subagent_type: z
    .string()
    .min(1)
    .optional()
    .describe(
      "with `scope: subagent`: regex over the call's IMMEDIATE parent dispatch — its dispatch type, resolved type, or description (same matching as subagent_dispatch_healthy.type)",
    ),
};

/** A control character in a regex is almost always a YAML double-quoted escape (`"\b"` is a backspace, not a word
 *  boundary), which would silently match nothing — refused at load. Tab, newline and carriage return are allowed. */
const CONTROL_CHAR = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;
const CONTROL_CHAR_MESSAGE =
  "contains a control character — in a double-quoted YAML string `\\b` is a backspace, not a word boundary; single-quote the regex";

/** Why a `question_option_count` bound is unusable, or undefined when it is fine. Shared by the load-time refine
 *  and the evaluator, so a hand-built context gets the same answer as a parsed scenario. */
export function questionOptionCountBoundError(v: { exactly?: number; min?: number; max?: number }): string | undefined {
  if (v.exactly !== undefined && (v.min !== undefined || v.max !== undefined))
    return "question_option_count: set `exactly`, or `min`/`max`, not both";
  if (v.exactly === undefined && v.min === undefined && v.max === undefined)
    return "question_option_count: set `exactly`, `min` or `max` — with no bound it checks nothing";
  if (v.min !== undefined && v.max !== undefined && v.min > v.max)
    return `question_option_count: \`min\` (${v.min}) is greater than \`max\` (${v.max}), so no count satisfies it`;
  return undefined;
}

/** The shared object form of `hook_output_contains` / `hook_output_not_contains`. */
const hookOutputObject = z
  .strictObject({
    event: z
      .enum(KNOWN_HOOK_EVENTS)
      .describe("the hook event whose `hook_response` frames are read (the same names hook_event_fired takes)"),
    stream: z
      .enum(["stdout", "stderr", "any"])
      .optional()
      .describe("which output field of the frame to read: `stdout`, `stderr`, or `any` (either; the default)"),
    // A control character in either needle is almost always a YAML double-quoted escape (`"\bfailed\b"` loads
    // a backspace), and a needle no hook prints makes the negative key pass silently — refused at load.
    text: z
      .string()
      .min(1)
      .optional()
      .describe("a literal substring, case-sensitive; NON-EMPTY (an empty text is in every output)")
      .refine((v) => v === undefined || !CONTROL_CHAR.test(v), CONTROL_CHAR_MESSAGE),
    matches: z
      .string()
      .min(1)
      .optional()
      .describe(
        "a regex, case-insensitive like every other regex key, with no multiline flag (`^` / `$` anchor the whole stream); NON-EMPTY (an empty pattern matches every output)",
      )
      .refine((v) => v === undefined || !CONTROL_CHAR.test(v), CONTROL_CHAR_MESSAGE),
  })
  // Load-time, so an assert that names no needle, or two, is refused before the spawn.
  .refine((v) => (v.text === undefined) !== (v.matches === undefined), { message: "set exactly one of `text` or `matches`" });

const subagentTypeNeedsSubagentScope = (o: { scope?: string; subagent_type?: string }) =>
  o.subagent_type === undefined || o.scope === "subagent";
const subagentTypeScopeMessage = { message: "`subagent_type` applies only with `scope: subagent`", path: ["subagent_type"] };

export const ToolCalledObject = z
  .strictObject({
    ...toolCallObjectFields,
    count: z
      .strictObject({
        min: z.number().int().nonnegative().optional().describe("minimum satisfying calls (default 1)"),
        max: z.number().int().nonnegative().optional().describe("maximum satisfying calls"),
      })
      .refine((c) => c.min === undefined || c.max === undefined || c.min <= c.max, {
        message: "count.min is greater than count.max — no number of calls can satisfy it",
      })
      .optional()
      .describe("how many calls must satisfy every predicate; default `{min: 1}`"),
  })
  .refine(subagentTypeNeedsSubagentScope, subagentTypeScopeMessage);
export type ToolCalledObject = z.infer<typeof ToolCalledObject>;

export const ToolNotCalledObject = z.strictObject(toolCallObjectFields).refine(subagentTypeNeedsSubagentScope, subagentTypeScopeMessage);
export type ToolNotCalledObject = z.infer<typeof ToolNotCalledObject>;

// `cowork-harness assertions --list` (which reads `Assertion.shape[k].description`) — the list can never drift
// from the schema. Keep descriptions one line.
/** The object form of `file_exists` / `user_visible_artifact`: the path, plus whether THIS run must have written
 *  it. Shared by both keys so the two cannot drift. */
const AuthoredFlag = z
  .boolean()
  .optional()
  .describe(
    "true: also require that THIS run created or rewrote the file — an untouched pre-run file (e.g. one a workspace_fixture staged) fails, and so does a run with no pre-run manifest to tell (evidence-unavailable). false: an inherited file is fine (the explicit opt-out a workspace_fixture scenario must state when it asserts on a file the fixture provides). Omitted: no authorship check",
  );
export const PresenceObject = z.strictObject({
  path: z.string().min(1).describe("the file's path under the work root (as in the string form)"),
  authored: AuthoredFlag,
});
export type PresenceObject = z.infer<typeof PresenceObject>;

export const Assertion = z.strictObject({
  transcript_contains: z
    .string()
    .min(1)
    .optional()
    .describe(
      "the transcript contains this literal substring. Sees top-level assistant_text ONLY — it excludes every tool_use/tool_result, so text the agent emitted inside a tool call (an AskUserQuestion gate question, an option label or description) can never match at any phrasing",
    ),
  transcript_not_contains: z
    .string()
    .min(1)
    .optional()
    .describe(
      "the transcript does NOT contain this literal substring. Sees top-level assistant_text ONLY — it excludes every tool_use/tool_result, so text the agent emitted inside a tool call (an AskUserQuestion gate question, an option label or description) can never match at any phrasing",
    ),
  transcript_matches: z
    .string()
    .optional()
    .describe(
      "regex (case-insensitive) over the transcript — fuzzy content for stochastic prose. Sees top-level assistant_text ONLY — it excludes every tool_use/tool_result, so text the agent emitted inside a tool call (an AskUserQuestion gate question, an option label or description) can never match at any phrasing",
    ),
  transcript_not_matches: z
    .string()
    .optional()
    .describe(
      "regex (case-insensitive) that must NOT match the transcript. Sees top-level assistant_text ONLY — it excludes every tool_use/tool_result, so text the agent emitted inside a tool call (an AskUserQuestion gate question, an option label or description) can never match at any phrasing",
    ),
  tool_result_contains: z
    .string()
    .min(1)
    .optional()
    .describe(
      "at least one tool result contains this literal substring (per-result match, not concatenated; 10,240-char cap per result, 32,768 for a top-level Skill result)",
    ),
  tool_result_not_contains: z
    .string()
    .min(1)
    .optional()
    .describe(
      "no tool result contains this literal substring (per-result match, not concatenated; 10,240-char cap per result, 32,768 for a top-level Skill result)",
    ),
  tool_result_matches: z
    .string()
    .min(1)
    .optional()
    .describe(
      "regex (case-insensitive) — at least one tool result matches (per-result, 10,240-char cap, 32,768 for a top-level Skill result). The regex sibling of tool_result_contains; use for an error-signature FAMILY a script may print even when its exit code was swallowed by its wrapper",
    ),
  tool_result_not_matches: z
    .string()
    .min(1)
    .optional()
    .describe(
      "regex (case-insensitive) that must NOT match any tool result (per-result, 10,240-char cap, 32,768 for a top-level Skill result). The regex sibling of tool_result_not_contains",
    ),
  file_exists: z
    .union([z.string().min(1), PresenceObject])
    .optional()
    .describe(
      "a file exists at this path under the agent's work root. OBJECT form `{path, authored}`: `authored: true` also requires that THIS run created or rewrote the file (an untouched pre-run file — a workspace_fixture file the step never touched — fails); `authored: false` states that an inherited file is fine",
    ),
  user_visible_artifact: z
    .union([z.string(), PresenceObject])
    .optional()
    .describe(
      "a file exists AND is under a user-visible prefix. Write the path workRoot-relative (e.g. `outputs/x.md`), NOT with an `mnt/` prefix: the accepted prefixes are `outputs/`, each connected-folder mount (`<folder>/`), or the legacy `.projects` fallback (pre-1.14271.0). (At fidelity tiers the workRoot is the `mnt/` mount, so the file lands at `mnt/outputs/…` on disk, but the assertion value is the relative form.) OBJECT form `{path, authored}` as for file_exists",
    ),
  tool_called: z
    .union([toolGlob, ToolCalledObject])
    .optional()
    .describe(
      "a called tool matched this glob (* = any run, ? = one char; exact when literal; anchored, case-sensitive) — e.g. mcp__workspace__*. Legacy tool spellings the agent binary canonicalizes (Task/Agent, KillShell/TaskStop, ...) match either way. OBJECT form `{tool, input, input_any, result, scope, subagent_type, count}` asserts what the call carried, where it ran and what its paired result said — use it, not transcript_*, to check a command that RAN",
    ),
  tool_not_called: z
    .union([toolGlob, ToolNotCalledObject])
    .optional()
    .describe(
      "NO called tool matched this glob (* / ?; exact when literal; anchored, case-sensitive; legacy spellings match as in tool_called). A LITERAL naming a tool the tier does not serve (Bash/WebFetch/NotebookEdit at hostloop; mcp__workspace__bash at container/microvm) is refused at load — it could never be violated. OBJECT form (as tool_called, no count): no call satisfies every predicate; an unpaired or truncated candidate is evidence-unavailable. Redaction hazard: a committed cassette's inputs are redacted, so an input regex naming a redactable literal (a home path, an email) cannot be checked on replay — lint warns",
    ),
  reference_read: z
    .string()
    .min(1, "reference_read is empty — an empty regex matches every path and passes vacuously")
    .optional()
    .describe(
      "a skill references/ or scripts/ file matching this regex was ACCESSED (main agent or sub-agents) via Read, Grep, or a Bash command naming it — regex is unanchored + case-insensitive; fails when the run recorded no observable tool stream",
    ),
  no_observed_reference_access: z
    .string()
    .min(1, "no_observed_reference_access is empty — an empty regex matches every path and never passes")
    .optional()
    .describe(
      "NO observed access to a skill references/ or scripts/ file matching this regex. Named 'observed' because detection under-approximates (a cd then a bare relative cat, a heredoc, or a $VAR-built path is invisible) — it is not proof of absence; fails when no observable tool stream was recorded",
    ),
  subagent_tool_used: toolGlob
    .optional()
    .describe("a sub-agent used a tool matching this glob (* / ?; exact when literal; anchored, case-sensitive)"),
  subagent_tool_absent: toolGlob
    .optional()
    .describe("NO sub-agent used a tool matching this glob (* / ?; exact when literal; anchored, case-sensitive)"),
  no_vm_path_file_op: z
    .literal(true)
    .optional()
    .describe(
      "hostloop-only: NO gated file tool (Read/Write/Edit/Glob/Grep/MultiEdit) attempted a path that is exactly /sessions or /sessions/-prefixed — the production VM-path boundary. Only `true` is valid — omit to not require it. Any other tier FAILS (cannot verify: /sessions/... is valid there).",
    ),
  vm_path_denied: z
    .literal(true)
    .optional()
    .describe(
      "hostloop-only: at least one recorded path denial targeted a /sessions VM path (any source). Only `true` is valid. Needs controlOut on replay (else skipped-and-surfaced).",
    ),
  path_denied: z
    .strictObject({
      tool: toolGlob.optional().describe("glob over the denied tool name"),
      path_matches: z.string().optional().describe("regex over the denied path"),
      source: z.enum(["pretooluse", "can_use_tool", "permission_denied"]).optional(),
      agent_scope: z
        .enum(["main", "subagent", "any"])
        .optional()
        .describe("subagent = the binary's agent_id attribution present; main = absent; default any"),
    })
    .optional()
    .describe("hostloop-only: a path denial matching ALL given matchers was recorded"),
  no_path_denied: z
    .literal(true)
    .optional()
    .describe(
      "hostloop-only: NO path denial was recorded (the channel is path-scoped already, unlike no_hook_blocked). Only `true` is valid.",
    ),
  subagent_file_write: z
    .strictObject({
      path: z
        .string()
        .min(1)
        .optional()
        .describe("EXACT raw path the sub-agent's write must have sent (strongest — proves the exact path, not just a suffix)"),
      path_suffix: z.string().min(1).optional().describe("the target path's suffix (weaker than `path`; e.g. artifacts/probe.json)"),
      tool: toolGlob.optional().describe("glob over the writing tool; default matches Write/Edit/MultiEdit"),
    })
    .refine((v) => v.path !== undefined || v.path_suffix !== undefined, {
      message: "subagent_file_write needs `path` (exact) or `path_suffix`",
    })
    .optional()
    .describe(
      "a SUB-AGENT-origin write attempt whose raw path EQUALS `path` (or ends with `path_suffix`) has a PAIRED non-error tool_result — the causal half of a delivery probe (pair with artifact_json for content). Prefer `path` (exact) so a foo/artifacts/probe.json can't satisfy an artifacts/probe.json suffix. Tier-agnostic.",
    ),
  subagent_dispatch_healthy: z
    .strictObject({
      type: z
        .string()
        .optional()
        .describe(
          "regex over dispatchAgentType OR resolvedAgentType OR description, selecting the dispatch(es) to check — same matching as subagent_dispatched; omit to require EVERY dispatch to be healthy",
        ),
      delivered: z
        .boolean()
        .optional()
        .describe(
          "default true: the selected dispatch's OWN sub-agent-origin write (matched by parentToolUseId, not any sub-agent's write) has a paired non-error tool_result",
        ),
      path: z.string().min(1).optional().describe("EXACT raw path the delivered write must have sent (strongest); narrows `delivered`"),
      path_suffix: z.string().min(1).optional().describe("the delivered write's path suffix (weaker than `path`)"),
      no_vm_paths: z
        .boolean()
        .optional()
        .describe("default true: the selected dispatch attempted NO `/sessions` VM path (its own parentToolUseId only)"),
    })
    .optional()
    .describe(
      "hostloop-only composite: ties ONE dispatch's resolved type to ITS OWN delivered write and path-cleanliness via parentToolUseId — the per-dispatch correlation `subagent_file_write` (which matches ANY sub-agent write) lacks. `type` matches the dispatch's resolvedAgentType OR dispatchAgentType OR description (a regex can narrow to one dispatch in a same-agent-type fleet). Content-class (fileToolAttempts + toolResults), replay-checkable without controlOut.",
    ),
  subagent_dispatched: z
    .string()
    .optional()
    .describe("a sub-agent matching this regex (by dispatch or resolved agent type, or description) was dispatched"),
  subagent_declared_but_unused: z
    .string()
    .optional()
    .describe(
      "a sub-agent declared this tool but never used it (the fabrication proxy). Fires only on a dispatch that declares a tools/allowedTools list; the Agent tool carries neither, so declaredTools is [] and the key passes — a green means not-applicable, not absence of fabrication",
    ),
  subagent_output_contains: z
    .strictObject({
      match: z
        .string()
        .optional()
        .describe("regex over dispatchAgentType or description, narrowing to specific dispatch(es); omit to check all"),
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
      "total sub-agent dispatches ≤ N — an author-chosen budget under Cowork's agent-side fan-out cap, not a reproduction of it (see SPEC §10)",
    ),
  skill_triggered: z
    .string()
    .optional()
    .describe(
      'a skill matching this regex (by its invoked skill id, e.g. "plugin:skill") was invoked — via the Skill tool, or by the prompt\'s leading slash command (`/<skill> …`), which the agent expands without a Skill call',
    ),
  no_skill_triggered: z
    .string()
    .optional()
    .describe(
      "no invoked skill id matched this regex, counting both the Skill tool and a slash-command prompt — the negative-control / description-collision catcher",
    ),
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
    .strictObject({
      skill: z.string().describe("regex matched against a skill-activation window's skillId"),
      tool: z.string().describe("regex matched against a tool name in that window's toolCounts"),
    })
    .optional()
    .describe(
      "a tool matching `tool` ran inside a skill-activation window whose skillId matches `skill` — heuristic for inline skills (a sticky, sequential window faithfully matching the real agent's activeSkill scope, not an exact per-tool boundary; see RunResult.skillActivity's doc comment). SCOPE: the window's tool counts INCLUDE calls made by any sub-agent dispatched during it, so this key cannot distinguish a main-agent call from a sub-agent one (use subagent_tool_used for a sub-agent-only claim), and it matches tool NAMES only — never the path/arguments a tool was called with",
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
    .strictObject({
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
  hook_event_fired: z
    .enum(KNOWN_HOOK_EVENTS)
    .optional()
    .describe(
      "a COMMAND hook for this event (a plugin's hooks/hooks.json or manifest hook — `Stop`, `SessionStart`, `PostToolUse`, …) ran: the agent emitted a `hook_response` system frame with this `hook_event` (RunResult.contextEvents). Any outcome counts as fired. The harness passes `--include-hook-events` whenever a staged plugin declares hooks, which is what makes events other than SessionStart/Setup appear on the stream at all — a recording made without it (older cassettes, or a plugin that declared no hooks) reports 'never fired'. Content-class, so it grades on replay. Recorded end-to-end for `Stop`; other names match the same frame but have not each been recorded. Distinct from `hook_blocked`, which reads the harness's OWN PreToolUse decisions from controlOut",
    ),
  hook_event_blocked: z
    .enum(KNOWN_HOOK_EVENTS)
    .optional()
    .describe(
      "that command hook BLOCKED at least once: a `hook_response` frame for the event carried `exit_code: 2` (the agent's blocking exit; the frame also carries outcome 'error'). Fails naming the exit codes/outcomes seen when the hook fired without blocking (`exit_code` is optional on the wire — a frame without it is reported as such, never counted as blocked); fails 'no hook_response' when it never fired; cannot-verify when the run has no context events. Content-class. Recorded end-to-end for `Stop`",
    ),
  hook_output_contains: hookOutputObject
    .optional()
    .describe(
      "a COMMAND hook's output for this event contains a text: some `hook_response` frame for `event` carries `text` (a literal substring, case-sensitive) or `matches` (a regex, case-insensitive) in its `stdout`, its `stderr`, or either (`stream`, default `any`). Every frame for the event counts, blocking ones included; an event usually fires several times (each tool call for PreToolUse, each turn for Stop). `matches` is case-insensitive and has no multiline flag, so `^` / `$` anchor the whole stream, not a line. Fails when the hook never fired, with the same diagnosis as hook_event_fired; cannot-verify when the run has no context events. On a stream a redaction policy rewrote (a replayed cassette, a scrubbed run dir), a literal miss and any `matches` result are evidence-unavailable for either key, while a literal hit outside a token counts; a needle the policy rewrote is evidence-unavailable. A miss is also evidence-unavailable when a hook for the event started and never sent a response (an async or backgrounded hook, or one still running at the end), or when the agent truncated a frame's output. Content-class, so it grades on replay. Frames carry no plugin id, so a second staged plugin hooking the same event also counts, as does a plugin installed on the host when a `protocol` run reads the real config dir; the run warns when either applies. Recorded end-to-end for `Stop`",
    ),
  hook_output_not_contains: hookOutputObject
    .optional()
    .describe(
      "no `hook_response` frame for `event` carries the text in the selected stream — for a hook that FAILS OPEN and says why on stderr while exiting 0, which hook_event_fired cannot see. Fails when the hook never fired (a disabled or misplaced hook is the failure this guards against, so it is never a vacuous pass); fails evidence-unavailable when a frame lacks the selected stream field, when a hook for the event started without a response, when the agent truncated a frame's output, or when a stream it would pass on was rewritten by a redaction policy. Same frames, matching and caveats as hook_output_contains. Recorded end-to-end for `Stop`",
    ),
  no_scratchpad_leak: z
    .literal(true)
    .optional()
    .describe(
      "every file presented via present_files that was in the scratchpad was successfully promoted to outputs (none left behind); vacuous pass if nothing was presented — pair with a presence check to require a delivery; content-class (re-derived from the tool_use/tool_result stream, so checkable on replay too); CONTAINER TIER ONLY — present_files itself is now served at BOTH container and hostloop, but this key's promotion/leak semantics apply only at container: production's own host-loop branch validates a path and passes it through WITHOUT promoting (a delivered file under the outputs dir is already user-visible there), so there is no scratch→outputs copy to leak, and at hostloop this key is cannot-verify rather than a claim the tool is absent (use fidelity: container for present_files-based delivery; microvm still doesn't serve the tool at all). present_files is the DESKTOP-LOCAL lane's tool; remote Cowork delivers via the agent-native SendUserFile instead, so a skill should describe the delivery outcome rather than naming either tool (docs/fidelity-gaps.md, 'File delivery'); only `true` is valid",
    ),
  present_files_called: z
    .literal(true)
    .optional()
    .describe(
      "at least one file was actually delivered via the present_files tool (at least one call carried a well-formed file_path). Presence is read from the INVOCATION count, not from the classified presentedFiles list, so it is unaffected by a redaction policy that rewrites host paths; a run that called the tool but whose every call carried an unusable path reports cannot-verify, never 'the tool was never called'. The presence companion to no_scratchpad_leak (which passes vacuously when nothing was presented, and stays container-only) — pair them to require a delivery AND require it not to leak; CONTAINER + HOSTLOOP TIERS — the harness serves present_files at both, mirroring real Cowork advertising the tool in both its VM and host-loop modes; every other tier is still a harness coverage gap (see docs/fidelity-gaps.md, 'File delivery'). present_files is the DESKTOP-LOCAL lane's tool name; remote Cowork uses the agent-native SendUserFile (docs/fidelity-gaps.md, 'File delivery') — this key asserts the harness-side delivery record either way; only `true` is valid",
    ),
  egress_denied: z.string().optional().describe("egress to this host was denied"),
  egress_allowed: z.string().optional().describe("egress to this host was allowed"),
  // Only `true` is accepted: `false` is rejected as a footgun. The assertion is presence-semantic — authoring
  // `false` reads as "permit deletes" but would behave identically to `true` (a silent no-effect), so it is
  // rejected. OMITTING the key does NOT permit deletes either: a detected delete still fails the run via the
  // `outputs_delete` verdict signal, which fires precisely BECAUSE the key was not authored. Authoring it
  // makes the failure an explicit assertion instead of a signal. To accept a delete, use
  // `allow_outputs_delete: true`.
  no_delete_in_outputs: z
    .literal(true)
    .optional()
    .describe(
      "fails if a delete touching mnt/outputs is DETECTED and confirmed (post-run bash-command scan plus a per-turn filesystem diff, not mount-level enforcement — a green means none was detected). Confirmed = the diff proves it, a delete in command/call position has an outputs path as its own operand, or the diff could not verify; a hit resting only on inference with a clean diff passes (the outputs_delete_unconfirmed warn is still raised). Only `true` is valid (writing `false` is a rejected footgun). Omitting the key does NOT allow deletes — a detected delete fails via the outputs_delete signal; use allow_outputs_delete to accept one",
    ),
  no_unexpected_files: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "fails if the run CREATED a file under a user-visible root whose workRoot-relative path (e.g. outputs/x.md) matches none of these globs (** = whole path segment for any depth, * within a segment, ? one char); [] = no new files allowed; new-files-only — overwriting a pre-existing file in place is invisible (use content-level producer stamping); needs a pre-run manifest (harness ≥0.24 recordings) — absence fails loud on live/verify-run; captured on every live sandbox tier including microvm (its outputs are snapshotted from the VM into the run dir), and a --resume turn reads the first turn's manifest if that turn captured one; otherwise the key fails evidence-unavailable",
    ),
  file_absent: z
    .string()
    .min(1)
    .optional()
    .describe(
      "the named path does NOT exist under the work root after the run — the negative-existence check no other key expresses (no_unexpected_files is new-files-only and needs a pre-run manifest, so it cannot say 'X must not exist'). LIVE/verify-run only: absence is provable only where the walk was authoritative, and a cassette records no walk health. Fails evidence-unavailable on `lane: remote` and on a pre-run origin of `remote-unavailable` — a filesystem that is not locally observable makes a missing snapshot indistinguishable from absence",
    ),
  artifact_text: z
    .strictObject({
      artifact: z
        .string()
        .min(1)
        .describe("relative path to an artifact under the work root (e.g. outputs/report.json) — a literal path, not a glob"),
      contains: z.array(z.string().min(1)).min(1).optional().describe("every listed substring appears in the body"),
      not_contains: z.array(z.string().min(1)).min(1).optional().describe("no listed substring appears in the body"),
      matches: z.string().min(1).optional().describe("the body matches this regex"),
      not_matches: z.string().min(1).optional().describe("the body does not match this regex"),
      authored: AuthoredFlag,
    })
    .optional()
    .describe(
      "assert over a delivered artifact's TEXT body — the companion to artifact_json for non-JSON deliverables, and the only way to check that an internal path/name did not leak into a file a user receives. At least one matcher is required. A body captured body-less (uploaded input, read-only folder input, over the size cap) or recorded as a symlink fails evidence-unavailable, and for the NEGATIVE matchers a body that is not lossless UTF-8 does too — a binary body read as text would 'pass' against bytes it never saw",
    ),
  input_unmodified: z
    .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
    .optional()
    .describe(
      "a single glob OR an array of globs; every pre-existing file whose workRoot-relative path matches has an unchanged content hash after the run (in-place mutation detector)",
    ),
  self_heal_ran: z.boolean().optional().describe("skill resolved scripts via /sessions (plugin-root self-heal)"),
  no_lost_write_back: z
    .literal(true)
    .optional()
    .describe(
      "fails if the run authored an interactive HTML artifact (or a .py/.js generator of one) whose relative Submit/POST write-back is lost under Cowork — runs the static Tier A analyzer over the files the run authored; a lost write-back on an ADDED agent-authored source fails, a pre-existing file the skill merely modified on a read-write mount is advisory; could-not-verify (fail-closed) on a --resume scratchpad or an unanalyzable candidate; runs on every live sandbox tier including microvm (outputs snapshotted from the VM); only `true` is valid (omit to skip). LIVE/verify-run only — skipped on replay",
    ),
  transcript_no_host_path: z
    .literal(true)
    .optional()
    .describe(
      "fails if a host path (/Users, /opt) leaked into model-visible text (post-run scan); a path that came verbatim from the scenario's own input files or prompt is not a leak. Only `true` is valid (writing `false` is a rejected footgun — omit to allow or use allow_stall)",
    ),
  computer_links_resolve: z
    .literal(true)
    .optional()
    .describe(
      "fails if any computer:// link in the model-visible transcript does not resolve to an artifact that exists in the run's collected outputs/mounts — REQUIRES at least one link (zero links FAILS: use computer_links_resolve_if_present for the presence-free variant); only `true` is valid (writing `false` is a rejected footgun — omit to skip). Sees top-level assistant_text ONLY — it excludes every tool_use/tool_result, so a computer:// link that appeared only inside a tool call or its result is invisible here",
    ),
  computer_links_resolve_if_present: z
    .literal(true)
    .optional()
    .describe(
      "like computer_links_resolve, but PASSES VACUOUSLY when the transcript has zero computer:// links — the lenient, presence-free variant; only `true` is valid. Sees top-level assistant_text ONLY — it excludes every tool_use/tool_result, so a computer:// link that appeared only inside a tool call or its result is invisible here",
    ),
  question_asked: z
    .string()
    .optional()
    .describe(
      "a question matching this regex was asked. This text is model-composed and is reworded run to run — pin a producer-authored constant, not model prose",
    ),
  question_options: z
    .strictObject({
      when_question: z
        .string()
        .optional()
        .describe(
          "regex selecting the sub-question by its label (`question`, falling back to `header` — the same string question_asked matches); omit only when the run fired exactly one sub-question",
        ),
      equals: z
        .array(z.string())
        .optional()
        .describe("the offered option labels, as a complete set — in this exact ORDER unless `order: any`"),
      contains: z
        .array(z.string())
        .optional()
        .describe("these option labels are present (others may be too); in this relative order unless `order: any`"),
      order: z
        .enum(["exact", "any"])
        .optional()
        .describe(
          "`exact` (default) compares order as well as membership — an option list re-ordered by the model is the defect this key exists for; `any` compares membership only",
        ),
    })
    // Load-time, so a contradictory assert is refused BEFORE the spawn rather than after it. `equals`
    // and `contains` express different claims (complete set vs subset) and their intersection is
    // undefined; neither one means the assertion checks nothing at all. `evaluate()` repeats both
    // checks because hand-built contexts (tests, library callers) never pass through parse.
    .refine((v) => (v.equals === undefined) !== (v.contains === undefined), {
      message: "question_options: set exactly one of `equals` or `contains`",
    })
    .optional()
    .describe(
      "assert the option SET and ORDER a gate offered the user, by LABEL (question_asked matches question text only; option DESCRIPTIONS are not compared here — use question_context for those). Exactly one of equals|contains is required. Evidence is captured at ask time, so it covers a gate that was shown and then denied/stalled/unanswered; a run whose gate evidence is absent fails evidence-unavailable, never vacuously. This text is model-composed and is reworded run to run — pin a producer-authored constant, not model prose",
    ),
  question_context: z
    .strictObject({
      when_question: z
        .string()
        .optional()
        .describe(
          "regex narrowing to sub-questions whose label matches (the same string question_asked matches); omit to search EVERY gate — unlike question_options, omitting it is not ambiguous here, because this key asks whether the text was shown at all, not which gate offered which set",
        ),
      matches: z
        .string()
        .min(1)
        .describe(
          "regex that must match somewhere in the selected gate(s)' founder-visible payload (case-insensitive). NON-EMPTY: an empty pattern compiles to //i and matches every field of every gate, so it would green any run that fired one — a required field whose empty value asserts nothing is worse than an absent one",
        ),
    })
    .optional()
    .describe(
      "a regex matched against everything a gate put in front of the user: the question label, every option LABEL, and every option DESCRIPTION. Use this when the skill's own wording may land in any of those fields — question_asked sees only the question text and question_options compares only labels, so a sentence delivered in an option's `description` is invisible to both. Evidence is the ask-time AskUserQuestion payload (never a producer's tool_result, which would grade true whether or not the model surfaced anything). Zero gates recorded FAILS; a lane that cannot read the gate payload fails evidence-unavailable, never vacuously. This text is model-composed and is reworded run to run — pin a producer-authored constant, not model prose",
    ),
  question_option_count: z
    .strictObject({
      when_question: z
        .string()
        .optional()
        .describe(
          "regex narrowing to sub-questions whose label matches (the same string question_asked matches); omit to check EVERY sub-question that was asked",
        )
        .refine((v) => v === undefined || !CONTROL_CHAR.test(v), CONTROL_CHAR_MESSAGE),
      matches: z
        .string()
        .min(1)
        .describe(
          "regex counted against each option LABEL of a sub-question (descriptions are not searched). Case-insensitive unless `case_sensitive: true`. NON-EMPTY: an empty pattern matches every label. Single-quote it in YAML: in a double-quoted string `\\b` becomes a backspace character, which is refused",
        )
        .refine((v) => !CONTROL_CHAR.test(v), CONTROL_CHAR_MESSAGE),
      case_sensitive: z
        .literal(true, { error: "case_sensitive takes only `true` — omit it for the case-insensitive default" })
        .optional()
        .describe(
          "match `matches` case-sensitively (default: case-insensitive, like every other regex key). It applies to the WHOLE pattern: on an `exactly: 0` rule it makes `add` miss `Add`, a false pass — keep such a rule case-insensitive, or spell both cases (`[Aa]dd`)",
        ),
      exactly: z.number().int().nonnegative().optional().describe("every selected sub-question has exactly N matching options"),
      min: z.number().int().nonnegative().optional().describe("every selected sub-question has at least N matching options"),
      max: z.number().int().nonnegative().optional().describe("every selected sub-question has at most N matching options"),
    })
    // Load-time, so a bound that checks nothing or contradicts itself is refused BEFORE the spawn. `evaluate()`
    // repeats it because hand-built contexts (tests, library callers) never pass through parse.
    .superRefine((v, c) => {
      const message = questionOptionCountBoundError(v);
      if (message !== undefined) c.addIssue({ code: "custom", message });
    })
    .optional()
    .describe(
      'count the options whose LABEL matches a regex, per sub-question, and require the count to satisfy `exactly` (or `min`/`max`) on EVERY selected sub-question — a bundled AskUserQuestion with K sub-questions is K, as in questions_count_max. For a rule over gates the run composes, such as "exactly one option per gate carries the reserved no-change prefix". A sub-question with no options counts 0; a duplicated label counts twice. Zero sub-questions asked (or none matching `when_question`) FAILS, so `exactly: 0` alone is satisfied by any unrelated gate: pair it with a positive rule or a `when_question`. Evidence is the ask-time AskUserQuestion payload; a lane that cannot read it fails evidence-unavailable, never vacuously, and so does a count that a label or question rewritten by a redaction policy could change (text reading `[REDACTED…]` counts as rewritten). This text is model-composed and is reworded run to run — pin a producer-authored constant, not model prose',
    ),
  questions_count_max: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("at most N sub-questions asked — a bundled AskUserQuestion with K sub-questions counts as K, not 1"),
  gate_answers_delivered: z
    .boolean()
    .optional()
    .describe(
      "accepts a boolean. `true`: every answered AskUserQuestion gate's tool_result was non-error (the answer reached the model); zero gates fired passes vacuously — pair with gate_answer_count_min to also require a gate. `false` is the inverse — it asserts a CONFIRMED delivery failure (at least one gate whose delivered === false), for negative-path scenarios; an unobserved (delivered === null) delivery satisfies neither true nor false",
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
  // Mutually exclusive with `no_delete_in_outputs` — asserting "no delete happened" AND "a delete is
  // fine here" is a contradiction, rejected at parse time on the whole `assert:` array (see
  // ScenarioObject's superRefine; an Assertion-level check cannot see sibling array entries).
  allow_outputs_delete: z
    .literal(true)
    .optional()
    .describe(
      "(verdict modifier) accept a detected outputs delete for this scenario instead of failing the run — for a skill whose deletion is intended. WAIVES the harness's post-hoc detection; it does NOT model production's allow_cowork_file_delete approval handshake, so a skill relying on the live EPERM still behaves differently here. Mutually exclusive with no_delete_in_outputs",
    ),
  // Production denies unlink/rmdir on EVERY delete-denied (`rw`) mount, not just outputs, and approval is
  // strictly per-mount. `no_delete_in_outputs` covers only outputs and keeps its exact meaning; this is
  // the mount-wide form. Deletes in a mount named by `allow_delete_in` are waived (see below).
  no_delete_in_mounts: z
    .literal(true)
    .optional()
    .describe(
      "fails if a delete is DETECTED in any delete-denied mount (outputs + every `rw` connected folder) that is not waived by allow_delete_in — post-run bash-command scan, not mount-level enforcement, so a green means none was detected; only `true` is valid. Production denies unlink/rmdir on every such mount until per-mount approval",
    ),
  // A WAIVER of the harness's post-hoc detection for the named mounts, mirroring allow_outputs_delete
  // exactly: detection still RUNS and the hits stay in result.json for forensics — only the verdict is
  // waived. It does not model production's allow_cowork_file_delete approval handshake.
  allow_delete_in: z
    .array(z.string().min(1))
    .min(1)
    .optional()
    .describe(
      '(verdict modifier) accept detected deletes in these mounts by NAME (e.g. ["reports"]) instead of failing/warning — the per-mount analogue of allow_outputs_delete, mirroring production\'s per-mount fileDeleteApprovedMounts. WAIVES the harness\'s post-hoc detection (which still runs and is still recorded); it does NOT model the live approval handshake. Listing "outputs" conflicts with no_delete_in_outputs',
    ),
  allow_l0_host_config_contamination: z
    .literal(true)
    .optional()
    .describe(
      "(verdict modifier) suppress the default-fail when L0 (protocol) runs against the operator's REAL config dir, where their installed plugins/skills/auto-memory/MCP servers are visible and may answer instead of the thing under test — for tests that deliberately accept a contaminated L0 environment",
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
      "(verdict modifier) suppress the default-fail when a run ends on a question or a closing request for input (e.g. 'Please share X so I can…') having done no productive tool work after its last gate (the agent asked for input and stopped — incl. re-asking in plain text after answering an AskUserQuestion) — assert this only when ending on a question is the intended terminal state; otherwise script the answer (answer:/--answer/decider)",
    ),
  allow_undelivered_deliverables: z
    .literal(true)
    .optional()
    .describe(
      "(verdict modifier) suppress the `undelivered_deliverables` WARN for this scenario — assert it when the skill legitimately leaves working files behind that were never meant to reach the user (intermediates, caches, downloaded inputs). The signal is warn-only and never fails a run on its own; this exists so a scenario whose scratch activity is intentional can say so instead of carrying permanent noise. ALSO suppresses the sibling `delivery_unobservable` WARN on `lane: remote` (where delivery cannot be measured at all because no remote delivery tool is modeled) — on that lane this key means 'I know delivery is unverifiable here and accept it', NOT 'the files were delivered'",
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
    .strictObject({
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
      authored: AuthoredFlag,
    })
    .optional()
    .describe("assert over a JSON artifact's contents (dotted path + equals|in|gt|exists|absent|is_null)"),
  semantic_matches: z
    .strictObject({
      rubric: z
        .array(z.string().min(1))
        .min(1)
        .describe("fixed, authored checkable claims — a pinned judge grades each; results align by INDEX (not re-extracted per rep)"),
      min_pass: z
        .union([z.literal("all"), z.number().int().positive()])
        .optional()
        .describe("how many rubric claims must pass for the assert to pass (default: all; do NOT rely on all for a gating scenario)"),
      judge_model: z.string().optional().describe("override the run-level pinned judge model for this assert"),
      evidence_files: z
        .array(z.string().min(1))
        .min(1)
        // A REFINE, not a schema-visible constraint: `.min(1)` is satisfied by a single space, so `[" "]`
        // loaded fine and only surfaced after a paid live run as "matched nothing". Refinements are
        // invisible to `z.toJSONSchema`, so this rejects at load without changing the published schema.
        .refine((globs) => globs.every((g) => g.trim().length > 0), {
          message: "evidence_files entries must not be blank — a whitespace-only glob matches no authored path",
        })
        .optional()
        .describe(
          "scope the AUTHORED-FILE evidence this judge grades to these globs, so an unrelated file dropped at the capture " +
            "budget can no longer refuse the verdict. NOT an existence assertion (that is `file_exists`) — it selects which " +
            "authored files reach the judge and which omissions are treated as fatal. Paths are `<user-visible root>/<rel>` " +
            "(e.g. `outputs/report.md`, NOT a bare `report.md`), the same key `no_unexpected_files`/`no_lost_write_back` use; " +
            "session-root deliverables carry the synthetic `scratchpad/` prefix. Glob syntax is `*`/`?`/`**` (NOT regex), " +
            "matched over the FULL path. Globs matching NOTHING fail evidence-unavailable rather than grading a rubric " +
            "against zero authored evidence — the failure message lists the paths the run actually authored. When set, the " +
            "capture also spends its size budget on these files FIRST and exempts them from the per-file cap, and an " +
            "in-scope file that is still omitted or truncated fails evidence-unavailable (raise `$COWORK_HARNESS_AUTHORED_TOTAL_BYTES` when a large deliverable legitimately needs more). Omitted = every authored file is " +
            "judged and any omission refuses the verdict (the default, unchanged)",
        ),
      include_subagent_text: z
        .boolean()
        .optional()
        .describe(
          "default false: also send each sub-agent's TEXT turns (RunResult.subagents[].reasoning, kind:'text' only) to the judge. Opt-in because it enlarges the judged document, which can re-grade an existing rubric. Use for a fan-out skill whose real work happens in sub-agents — their text is otherwise invisible to the judge. Sub-agent THINKING is excluded: it arrives empty with redacted:true, so including it would pad the document with blanks",
        ),
      include_fork_results: z
        .boolean()
        .optional()
        .describe(
          "default false: also send the result of every top-level `Skill` call to the judge, joined to its call by toolUseId — the only channel that carries a FOREGROUND `context: fork` skill's own answer (a fork is not a dispatch, so it has no subagents[] entry and include_subagent_text cannot see it). Each result is headed `Fork skill result: <skill>` when it carries the agent's `completed (forked execution)` marker, else `Skill result: <skill>` (an inline skill's result is only its launch line). A top-level Skill result is captured up to 32,768 characters (every other tool result keeps 10,240); one cut at that cap fails the assert evidence-unavailable (`fork_result_truncated`), as does a Skill call with no paired result (`fork_result_unpaired`), a fork launched in the BACKGROUND, whose result is only its launch line (`fork_result_background`), or a lane with no tool-call record (`fork_calls_unrecorded`) — never a grade over a partial answer or a launch line. Opt-in because it enlarges the judged document, which can re-grade an existing rubric",
        ),
    })
    .optional()
    .describe(
      "LIVE-ONLY: a pinned LLM judge grades the rubric against the run's answer; skipped-loud on replay (like egress_*). The judged document is finalMessage + transcript + authored files. NOTE the transcript is TOP-LEVEL assistant_text ONLY — it excludes every tool_use/tool_result, no sub-agent text (even fork-scoped) unless include_subagent_text is set, and no `Skill` tool result (where a `context: fork` skill's answer arrives) unless include_fork_results is set. A rubric claim about whether a TOOL was called therefore cannot grade true — except that with include_fork_results a `Skill result: <skill>` / `Fork skill result: <skill>` section lets the judge confirm skill <skill> ran; use tool_called/present_files_called/subagent_dispatched for tool claims",
    ),
  semantic_pairwise: z
    .strictObject({
      rubric: z
        .array(z.string().min(1))
        .min(1)
        .optional()
        .describe(
          "optional short comparative criteria the judge weighs (concrete, checkable claims); omitted = overall quality for the task",
        ),
      refs: z
        .array(z.string().min(1))
        .min(1)
        .refine((r) => r.every((x) => x.trim().length > 0), { message: "refs entries must not be blank" })
        .refine((r) => new Set(r.map((x) => x.replace(/\/+$/, "").split("/").pop())).size === r.length, {
          message: "refs entries must have distinct directory names — the name identifies the reference in results",
        })
        .optional()
        .describe(
          "frozen reference STORES (directories written by `ref freeze`), relative to the scenario file. Each holds one entry per case; " +
            "the run is judged against every store. In a hillclimb flow the flow's own references replace these",
        ),
      pass_if: z
        .enum(["win", "not_worse", "any"])
        .optional()
        .describe(
          "default not_worse: the assert passes when, against EVERY reference, the run wins (win), wins or ties (not_worse), or was graded at all (any — metric only). both_bad fails win and not_worse",
        ),
      order: z
        .enum(["random", "both"])
        .optional()
        .describe(
          "default random: which output the judge sees first is a seeded coin per run, assert and reference. both: judge both orders (twice the judge calls); a win/loss split scores as a tie, any other disagreement keeps the worse outcome",
        ),
      judge_model: z.string().optional().describe("override the run-level pinned judge model for this assert"),
      evidence_files: z
        .array(z.string().min(1))
        .min(1)
        .refine((globs) => globs.every((g) => g.trim().length > 0), {
          message: "evidence_files entries must not be blank — a whitespace-only glob matches no authored path",
        })
        .optional()
        .describe(
          "scope the run's AUTHORED-FILE evidence exactly as semantic_matches.evidence_files does; the frozen reference must have been composed with the same scope",
        ),
      include_subagent_text: z
        .boolean()
        .optional()
        .describe("as semantic_matches.include_subagent_text; part of what the reference must match"),
      include_fork_results: z
        .boolean()
        .optional()
        .describe("as semantic_matches.include_fork_results; part of what the reference must match"),
    })
    .optional()
    .describe(
      "LIVE-ONLY: a pinned LLM judge compares this run's judged document with a FROZEN reference (a baseline run's document, written once by `ref freeze` and never regenerated) and answers win, tie, loss or both_bad; skipped-loud on replay. The judged document is the one semantic_matches builds: finalMessage + transcript + authored files. NOTE the transcript is TOP-LEVEL assistant_text ONLY — it excludes every tool_use/tool_result, and no sub-agent text unless include_subagent_text is set; a criterion about whether a TOOL was called cannot be judged from it. A missing or damaged reference is refused before the run spends",
    ),
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
/** Capture cap, in characters, for the result of a TOP-LEVEL `Skill` call (one the main agent makes itself, not one inside a fork) — every other tool result keeps the
 *  10,240-char assert cap. A foreground `context: fork` skill's whole answer comes back as that result, and
 *  `semantic_matches.include_fork_results` refuses rather than grade a cut one, so a 10,240 cap would refuse
 *  every fork answer longer than ~2.5 pages (the largest kept fork answer measured 9,657 chars). 32,768 is the
 *  judged document's own per-answer budget (`JUDGE_FINAL_CAP` in assert.ts, the cap on the agent's final
 *  answer): final 32K + transcript 128K + one skill answer 32K + the default 64 KiB authored-file capture
 *  = the 256K aggregate cap, so the defaults still fit whole. The composer caps a skill section at this
 *  same value, so the capture and the judge can never disagree about what "cut" means. */
export const SKILL_RESULT_ASSERT_CAP = 32_768;

export const VERDICT_MODIFIER_KEYS = [
  "allow_permissive_auto_allow",
  "allow_missing_capability",
  "allow_l0_host_config_contamination",
  "allow_stall",
  "allow_undelivered_deliverables",
  "allow_outputs_delete",
  "allow_delete_in",
] as const satisfies readonly (keyof Assertion)[];

/** THE fidelity tiers the harness understands — the single source for the Scenario `fidelity:` enum, the
 *  CLI's `--fidelity`/`--tier` validation, and `doctor`. It was previously written out as a literal in
 *  five places in `src` alone (plus help text and docs); a canonical `FIDELITY_TIERS` const already
 *  existed in cli.ts and three other sites simply did not use it. A downstream consumer reading a stale
 *  copy is one of the misreads this consolidation exists to prevent.
 *
 *  `test/fidelity-tiers-single-source.test.ts` fails if a new literal copy appears in `src`. */
export const FIDELITY_TIERS = ["protocol", "container", "microvm", "hostloop", "cowork"] as const;

export type FidelityTier = (typeof FIDELITY_TIERS)[number];

/** Why a declared metric has no value (`RunResult.metrics[].unavailable`). ONE list: the type derives from it, and the two
 *  hand-maintained JSON Schemas (run-result.json, regrade.json) are pinned to it by tests. See docs/scenario.md "Numeric metrics" for what each one means. */
export const METRIC_UNAVAILABLE = [
  "missing_artifact",
  "missing_path",
  "not_json",
  "not_a_number",
  "readonly",
  "size",
  "remote",
  "pruned",
  "pre_run",
  "no_manifest",
] as const;
export type MetricUnavailable = (typeof METRIC_UNAVAILABLE)[number];

/** Ids a scenario metric may not take: each would collide with a key the hillclimb runner generates (its grade
 *  keys, per-index keys, `_present` companions and pairwise keys). */
export const RESERVED_METRIC_ID_PATTERNS = [
  "^(pass|claims|win|both_bad)$",
  "^a\\d+(_|$)",
  "_present$",
  "(^|_)(win|both_bad)(_|$)",
] as const;
/** Compared case-insensitively: `Pass` or `A1` would collide with `pass` / `a1` wherever keys are folded. The
 *  published JSON Schema carries the same patterns with each letter spelled as a two-case class. */
export function reservedMetricId(id: string): boolean {
  const lower = id.toLowerCase();
  return RESERVED_METRIC_ID_PATTERNS.some((p) => new RegExp(p).test(lower));
}

/** A metric id is path-safe: word characters, dots and hyphens, at most 129 characters, not all dots — the rule
 *  the hillclimb scaffold applies to an id it uses as a path. */
export const METRIC_ID_PATTERN = "^[\\w.-]+$";
export const METRIC_ID_MAX = 129;
export function isMetricIdSafe(id: string): boolean {
  return new RegExp(METRIC_ID_PATTERN).test(id) && id.length <= METRIC_ID_MAX && !/^\.+$/.test(id);
}

/** What a metric's `artifact` path may not be — ONE list: the loader tests it and the published JSON Schema emits it
 *  (`artifact.not.anyOf`), pinned by a parity test. Each is an unanchored-flag-free ECMAScript pattern. A backslash
 *  is refused anywhere: on POSIX it is part of a file name, so `outputs\m.json` would never name the file the author
 *  meant. A colon alone is legal (`a:b.json` is a POSIX name); a drive root (`c:/…`, bare `c:`) is not. */
export const METRIC_ARTIFACT_REFUSED_PATTERNS = [
  "^\\s*$", // blank
  "\\\\", // a backslash anywhere
  "^/", // absolute
  "^[A-Za-z]:(/|$)", // a drive root
  "(^|/)\\.\\.(/|$)", // a `..` segment
  "\\u0000", // NUL
] as const;
function isContainedRelPath(p: string): boolean {
  return !METRIC_ARTIFACT_REFUSED_PATTERNS.some((r) => new RegExp(r, "u").test(p));
}

export const ScenarioMetric = z
  .strictObject({
    id: z
      .string()
      .regex(new RegExp(METRIC_ID_PATTERN), { message: "a metric id is word characters, dots and hyphens only" })
      .max(METRIC_ID_MAX)
      .describe(
        "the metric's name — the key it is reported under (RunResult.metrics[].id, and a hillclimb grade key). Word characters, dots and hyphens, at most 129 characters, not all dots, and not a key the hillclimb runner generates (pass, claims, a<N>…, *_present, *win*, *both_bad*). A duplicate id (compared case-insensitively) is refused at load",
      ),
    artifact: z
      .string()
      .refine(isContainedRelPath, {
        message:
          "a metric artifact is a path relative to the work root, with forward slashes: not blank, not starting with `/` or a drive root (`c:/`), no `..` segment, no backslash, no NUL",
      })
      .describe(
        "the JSON file to read, relative to the work root (e.g. outputs/scores.json) — a file the run writes under outputs/ or a connected folder",
      ),
    path: z.string().min(1).describe("dotted path to the number inside the JSON (e.g. totals.words; array items by index, items.0.score)"),
    better: z.enum(["higher", "lower"]).describe("which direction is an improvement"),
    scale: z
      .number()
      .positive()
      .optional()
      .describe(
        "the UPPER BOUND of a bounded metric's range (the range is [min, scale], min defaulting to 0 — a range of [-1, 1] is `min: -1, scale: 1`); set exactly one of scale or unbounded",
      ),
    unbounded: z.literal(true).optional().describe("true for a metric with no natural ceiling; set exactly one of scale or unbounded"),
    min: z
      .number()
      .optional()
      .describe("the floor of the metric's range (default 0); with `scale`, it must be below `scale` (refused at load otherwise)"),
  })
  .superRefine((m, ctx) => {
    if (m.scale !== undefined && m.min !== undefined && !(m.min < m.scale))
      ctx.addIssue({ code: "custom", path: ["min"], message: `metric "${m.id}": \`min\` (${m.min}) must be below \`scale\` (${m.scale})` });
    if ((m.scale === undefined) === (m.unbounded === undefined))
      ctx.addIssue({ code: "custom", path: ["scale"], message: `metric "${m.id}": set exactly one of \`scale\` or \`unbounded\`` });
    if (/^\.+$/.test(m.id)) ctx.addIssue({ code: "custom", path: ["id"], message: `metric id "${m.id}" is all dots` });
    if (reservedMetricId(m.id))
      ctx.addIssue({ code: "custom", path: ["id"], message: `metric id "${m.id}" collides with a key the hillclimb runner generates` });
  });
export type ScenarioMetric = z.infer<typeof ScenarioMetric>;

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
  // REQUIRED (since 4.0.0; it defaulted to `container` before). The loader turns a missing key into an
  // actionable refusal (execute.ts, loadScenarioPure) — Zod's own text for an absent enum never says
  // "missing".
  fidelity: z
    .enum(FIDELITY_TIERS)
    .describe(
      "isolation tier (REQUIRED): protocol (L0, no sandbox) | container/microvm (force a VM-loop tier) | hostloop (force host-loop) | cowork (auto-pick host-loop vs. container via Cowork's own gate logic). `container` models the VM loop, while production runs the host loop by default (gate 1143815894) — a bare relative path lands elsewhere, the shell starts elsewhere, and the offered tool set differs. Name hostloop to match production, cowork to auto-pick the way Cowork does, or container to model the VM loop deliberately.",
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
  // THE PRODUCT-LANE axis. Three orthogonal things, do NOT collapse them:
  //   fidelity  — the isolation tier the harness runs in (protocol/container/microvm/hostloop)
  //   execution — WHERE the run happens (local; cloud-describe reserved)
  //   lane      — WHICH Cowork product lane's contract the run is held to
  // Cowork offers the choice per session ("Run this task: In the cloud / On your computer"), with cloud
  // the default for new sessions, and the two lanes disagree about what "delivered" means. `local` keeps
  // every existing scenario's meaning unchanged.
  lane: z
    .enum(["local", "remote"])
    .default("local")
    .describe(
      "which Cowork lane's DELIVERY CONTRACT to hold the run to, orthogonal to fidelity (isolation tier) and execution (where the run happens): " +
        "local (default) — a file under a user-visible root is delivered by LOCATION, and present_files is served | " +
        "remote — location delivers NOTHING (verified: a remote container has no auto-delivering outputs dir), so only an explicit delivery counts, and present_files is NOT served because a local MCP server cannot reach a remote session. " +
        "Scoped to delivery semantics: the remote device bridge (device_bash/device_commit_files) is deliberately unmodeled — see docs/fidelity-gaps.md",
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
      "policy when a gate arrives with no matching `answers:` rule — `fail` (default for `run`, deterministic) | `first` (pick the first offered option) | `llm` (delegate to a decider LLM) | `prompt` (interactive; valid only via `skill --on-unanswered prompt` or the adaptive-TTY default — rejected in scenario YAML under `run`)",
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
  // `protocol` passes --plugin-dir, so the CLI executes a staged plugin's hooks as NATIVE HOST processes.
  // Gated only when a staged plugin actually declares runnable hooks (see checkHostHookConsent) — an
  // ordinary skill-under-test declares none and needs no opt-in. Top-level like allow_host_writes, NOT a
  // verdict modifier: it gates the SPAWN, it does not suppress a signal.
  allow_host_hooks: z
    .boolean()
    .optional()
    .describe(
      "required consent for `fidelity: protocol` when a staged plugin declares runnable hooks (`<plugin>/hooks/hooks.json`) — the CLI runs them as native host processes under your account with no container sandbox; plugins without hooks need no opt-in",
    ),
  // A saved outputs tree copied into a FRESH session's outputs/ before turn 1, so a scenario can test one late
  // step of a long pipeline. Resolved relative to the scenario file (like `session:`); validated and staged by
  // src/fixture/workspace.ts. The refine also refuses a whitespace-only value, which would resolve to a directory.
  workspace_fixture: z
    .string()
    .min(1)
    .refine((v) => v.trim().length > 0, { message: "workspace_fixture must name a directory (it is blank)" })
    .optional()
    .describe(
      "a directory (relative to the scenario file) whose contents are copied into the session's outputs/ before turn 1 — `<dir>/report.md` lands at `outputs/report.md`. Equals re-invoking the skill in the same Cowork session after it stopped mid-work or finished, except that the run starts with a fresh conversation context. Regular files only; symlinks, hard links, agent-config paths (.claude/, .git/, .mcp.json, CLAUDE.md) and, in git mode, untracked files are refused; 64 MiB cap (COWORK_HARNESS_WORKSPACE_FIXTURE_MAX_BYTES). Never re-staged on --resume. Its content signature joins the cassette staleness check",
    ),
  // Numbers read from JSON artifacts the run wrote, reported as RunResult.metrics (they never change the verdict).
  metrics: z
    .array(ScenarioMetric)
    .superRefine((ms, ctx) => {
      const seen = new Map<string, string>();
      for (const m of ms) {
        const k = m.id.toLowerCase();
        const prev = seen.get(k);
        if (prev !== undefined)
          ctx.addIssue({ code: "custom", message: `duplicate metric id "${m.id}" (also "${prev}"; ids are compared case-insensitively)` });
        else seen.set(k, m.id);
      }
    })
    .optional()
    .describe(
      "numbers this scenario measures: each reads one number from a JSON file the run wrote and reports it in RunResult.metrics as {id, value} or {id, unavailable: <reason>} — never in the verdict. A file the run did not write (an untouched pre-run file, including one the run rewrote with identical bytes) reports unavailable: pre_run. Declaring a metric arms the pre-run manifest. Loader-only rules (not expressible in JSON Schema): a duplicate id (compared case-insensitively) and `min` below `scale`. See docs/scenario.md",
    ),
});
/** `ScenarioObject` stays a raw object on purpose — `.shape` is enumerated (cassette.ts's per-key
 *  minimum-format map) and it is the schema `gen:schema` emits. Cross-key rules live here instead, on the
 *  parsed form. Note a refinement is INVISIBLE to `z.toJSONSchema`, so any rule added here must be mirrored
 *  into the generated JSON Schema by hand (see scripts/gen-schema.ts) or editors/CI validating against the
 *  published schema will accept what the loader rejects. */
export const Scenario = ScenarioObject.superRefine((s, ctx) => {
  // Asserting "no delete happened" AND "a delete is acceptable" is a contradiction, and silently
  // letting one win would make the scenario's intent unreadable. Must be checked across the WHOLE
  // `assert:` array — the two keys can sit in separate entries, which an Assertion-level refinement
  // could never see.
  const denies = s.assert.some((a) => a.no_delete_in_outputs !== undefined);
  const allows = s.assert.some((a) => a.allow_outputs_delete === true);
  if (denies && allows)
    ctx.addIssue({
      code: "custom",
      path: ["assert"],
      message:
        "no_delete_in_outputs and allow_outputs_delete are mutually exclusive — the first asserts no delete " +
        "touched mnt/outputs, the second accepts one. Keep whichever matches the scenario's intent.",
    });
  // Same contradiction, reached through the per-mount key: waiving `outputs` while also asserting no
  // delete touched it. `no_delete_in_mounts` + `allow_delete_in` do NOT conflict in general — "no deletes
  // anywhere except these mounts" is a coherent and useful thing to say, and mirrors how production
  // combines a blanket denial with per-mount approval.
  if (denies && s.assert.some((a) => a.allow_delete_in?.includes("outputs")))
    ctx.addIssue({
      code: "custom",
      path: ["assert"],
      message:
        'no_delete_in_outputs conflicts with allow_delete_in containing "outputs" — the first asserts no ' +
        "delete touched mnt/outputs, the second waives exactly that. Keep whichever matches the intent.",
    });
});
export type Scenario = z.infer<typeof ScenarioObject>;

/** Skill/plugin staleness fingerprint, recorded at run time. Stamped into a cassette (staleness tripwire)
 *  AND into a kept run's result.json (so `verify-run` can detect a kept run that predates a skill change and
 *  refuse to vouch for answer-coverage against stale gate labels). */
export interface Fingerprint {
  baseline: string; // appVersion at record time
  frozen?: boolean; // #46: set when surfaced from a cassette's record-time fingerprint on replay (not a fresh run-time recompute)
  skillHash?: string; // hash of the session's local skill/plugin/marketplace dir contents (if any)
  skillSources?: string[]; // the local dirs that fed skillHash (for the replay recompute + diagnostics)
  skillScope?: string[]; // the skills the hash was scoped to (empty/absent = whole-tree); diagnostics
  sharedHash?: string; // shared-root hash for scoped cassettes; absent on whole-tree or non-plugin-root mounts
  // Content fingerprint over the same file set as skillHash, used by `rehash` to prove content unchanged
  // across a format bump. NOT algorithm-independent: it follows the same manifest transform skillHash does,
  // so it cannot be compared across a hash-format epoch — the proof recomputes the LEGACY skillHash instead.
  contentSig?: string;
  // v5+: per-file manifest [relpath, contentSha] of the exact files feeding skillHash, so a staleness mismatch
  // names the EXACT changed/added/removed file instead of a bucket. Paths are ROOT-RELATIVE (no host path) and
  // scanned/redacted like skillSources (privacy). Omitted (with fileSigsOmitted:true) above MANIFEST_MAX_FILES.
  // NOT sha256(file) in every case: each sha is over the bytes that FOLD INTO skillHash, and a
  // `.claude-plugin/plugin.json` (or root `plugin.json`) folds with `version` deleted. Hand-checking one of
  // those with `shasum` mismatches and looks exactly like corruption — it isn't.
  //
  // The hand-check depends on `hashFormat`, so read that FIRST:
  //   absent / legacy → JSON.parse, delete `version`, JSON.stringify, sha256
  //   "jcs1"          → JSON.parse, delete `version`, jcsSerialize (run/jcs.ts), sha256
  // Using the legacy recipe on a jcs1 cassette reproduces the original confusion exactly: for any manifest
  // whose keys are not already sorted it will not match, and it will read as corruption.
  //
  // `COWORK_HARNESS_DEBUG_SKILLHASH=1` dumps the folded set with these shas, but only fires on a hash
  // MISMATCH — there is no on-demand dump for a cassette that verifies clean.
  /** v12+: which manifest-transform algorithm produced the digests in this fingerprint. ABSENT means the
   *  LEGACY (pre-epoch) transform — NOT "raw bytes": every cassette recorded before v12 already carries
   *  version-stripped manifest digests, so defaulting absence to raw would mislabel all of them. */
  hashFormat?: "jcs1";
  fileSigs?: Array<[string, string]>;
  fileSigsOmitted?: boolean;
  // v11+: gate option labels this run emitted that were found VERBATIM in the skill's own prose, recorded
  // per source file IN THE ORDER THEY APPEAR IN THAT FILE. Two things it catches that `skillHash` cannot:
  //   1. a catalog REORDER (all labels still exist, so an existence check passes by construction — the
  //      order stored here is what makes it detectable);
  //   2. a change to prose that is DELIVERED to the agent but excluded from the hash (`.cowork-hashignore`
  //      / session `staleness.hash_ignore`) — outside skillHash forever, so nothing else sees it.
  // Only verbatim-sourced labels are stamped: a model-PARAPHRASED label was never in the prose, so it
  // cannot regress from absent to absent, and checking it would fire on every run. Absent on cassettes
  // recorded before this existed, and on runs where no gate fired — both simply skip the check.
  labelProvenance?: Array<{ file: string; labels: string[] }>;
  // the boundary used for skillHash — "git" (git-tracked set — the DEFAULT unless COWORK_HARNESS_GITSET=0,
  // and every dir is a git work tree) or "raw" (filesystem walk; used when GITSET=0 OR any dir is not a
  // repo). A record-vs-verify mode flip makes hash comparison meaningless → re-record.
  mode?: "git" | "raw";
  // Opt-in per-skill agent scoping was active (COWORK_HARNESS_AGENT_SCOPE=skill) when this scoped hash was
  // computed — a skill-named `agents/<n>` was treated as skill <n>'s private input rather than a shared root.
  // ABSENT = the default (agents/ is a fleet-wide shared root). A record-vs-verify mismatch → re-record.
  agentScope?: "skill";
  /** sha16 over the baseline's committed prompt-asset FILE bytes (spawn.promptTemplate /
   *  subagentAppend / subagentAppendHostLoop, key-ordered). Prompt identity was previously keyed on
   *  appVersion alone, so an asset edit under the SAME appVersion silently replayed old-prompt
   *  behavior. Asset-file bytes (not the rendered string) keep it deterministic and host-path-free.
   *  Absent on cassettes recorded before this field existed → informational note, never a finding. */
  promptAssetsHash?: string;
  /** v14: the `workspace_fixture` content signature — sha256 over the fixture's sorted (path, sha256, exec bit)
   *  triples (src/fixture/workspace.ts `workspaceFixtureSig`), taken from the files actually STAGED. Replay
   *  recomputes it from the scenario's fixture dir (resolved against the cassette): a mismatch is a `fixture`
   *  staleness finding, a missing dir `unverifiable-fixture`. Absent when the scenario declares no fixture. */
  workspaceFixtureSig?: string;
  /** v14: per-file `[path, sig]` behind `workspaceFixtureSig` (fixture-relative paths, redacted like
   *  `fileSigs`; the sig is the content sha256, suffixed `+x` for an executable file), so a drift finding names
   *  the file. */
  workspaceFixtureFileSigs?: Array<[string, string]>;
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
 *  can't verify ⇒ not green on the verify-cassettes gate. `prompt-assets` = the baseline's committed
 *  prompt-asset files changed since record under the SAME appVersion (warn-by-default, `--strict`
 *  fails, re-record); `unverifiable-prompt-assets` = a recorded prompt-asset hash exists but the live
 *  baseline's prompt assets can't be hashed (a moved/dangling pointer) — can't verify ⇒ not green.
 *  `fixture` = the scenario's `workspace_fixture` content changed since record (warns by default; `--strict`,
 *  `--fail-on-skill-drift` and an explicit `--session` fail it — the fixture is test input the skill reads);
 *  `unverifiable-fixture` = a fixture signature was recorded but the fixture dir cannot be resolved or scanned
 *  today — can't verify ⇒ not green, on the default replay gate too. */
type StalenessClass =
  | "baseline"
  | "skill"
  | "shared-root"
  | "format"
  | "unverifiable-baseline"
  | "unverifiable-skill"
  | "resolved-tier"
  | "unverifiable-tier"
  | "prompt-assets"
  | "unverifiable-prompt-assets"
  | "fixture"
  | "unverifiable-fixture";
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
  runLabel?: string; // --label generation tag (iterate-across-fixes loop); absent when not passed
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
  errorSource?: "spawn" | "protocol" | "exit" | "agent" | "result" | "no_result" | "timeout" | "decider_timeout";
  // classifies the error KIND — surfaced here so a batch/status watcher can halt-fast on `usage_limit`
  // (quota exhausted; retrying into a spent quota just burns the batch) rather than treating it as generic.
  resultErrorKind?: "transport" | "agent" | "usage_limit";
  resultSubtype?: string;
  stderrLogPath?: string;
}

/** SDK usage payload (input_tokens, output_tokens, etc.) — pass-through, shape owned by the SDK, not the
 *  harness — plus `turns`, harness-computed from the SDK result message's `num_turns`. */
export type UsageInfo = Record<string, unknown> & { turns?: number };

/** NOT the same number as the critique report's `costUsd.totalUsd`. This is ONE invocation's spend;
 *  `CritiqueCost.totalUsd` (src/critique/command.ts) is an aggregate over the task turn, the reflection
 *  turn and both evaluator passes. Reading the wrong key returns `undefined`/`None` rather than erroring,
 *  which reads as "no cost recorded" — so they are cross-referenced rather than unified: collapsing them
 *  would destroy the per-phase split the critique report exists to show.
 *
 *  `usd` = the SDK result message's `total_cost_usd` for this invocation, when present. THE authoritative
 *  single-run spend — distinct from summing `modelUsage[].costUSD`, a different SDK-side source that
 *  `trace --view usage` reports and which can legitimately disagree.
 *
 *  `raw` = the `api_metrics` event payload (pre-existing; unrelated source, kept alongside `usd` rather
 *  than merged into it since the two are independent SDK signals). **Despite living on `CostInfo`, this
 *  carries no cost**: the SDK's `api_metrics` is a per-API-call OTPS/TTFT lifecycle event
 *  (`{type:"start",ttftMs}` / `{type:"end",outputTokens}`, subagent-scoped) — verified against the
 *  staged agent binary. So there is NO live cost signal mid-run; `usd` only lands with the result
 *  message, which is why a mid-run budget abort is not implementable today. */
export interface CostInfo {
  usd?: number;
  raw?: Record<string, unknown>;
}

/** One model's cost/token entry inside the SDK result message's `modelUsage` field. Field
 *  names match the REAL observed SDK payload (empirically confirmed against a captured stream and
 *  against committed example cassettes), not a guessed shape. Every field optional since this is a
 *  passthrough of SDK-owned data, not harness-computed. */
interface ModelUsageEntry {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
  contextWindow?: number;
  maxOutputTokens?: number;
  webSearchRequests?: number;
}

/** Token counters for a harness-side model call (the LLM decider, the semantic judge), in the snake_case
 *  the Messages API uses, summed across every model key the transport reported. */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

/** See `RunResult.assertions[].judgedDoc`. `sha256` is over the whole document as sent (UTF-8), including
 *  any truncation marker the aggregate cap appended. `sections` lists, in order, the parts the document is
 *  composed of, each hashed over the exact text of that part the judge received; parts are separated by one
 *  blank line, so walking the document by `chars + 2` recovers each one. A part cut by the aggregate cap is
 *  hashed over its surviving prefix, and a part wholly past the cut is not listed. `chars` counts UTF-16
 *  code units (JavaScript string length), the unit the judge caps are measured in. */
export interface JudgedDocFingerprint {
  sha256: string;
  sections: Array<{
    /** `final` = the agent's final answer; `transcript`; `subagent` = one opted-in sub-agent's text;
     *  `skill_result` = one top-level `Skill` call's result (opt-in `include_fork_results`);
     *  `authored` = one authored file (`path` set); `scratch_note` = the note qualifying scratch files;
     *  `health` = the evidence-health note. */
    kind: "final" | "transcript" | "subagent" | "skill_result" | "authored" | "scratch_note" | "health";
    /** The authored file's path (workRoot-relative, or `scratchpad/…`) — `authored` sections only. */
    path?: string;
    sha256: string;
    chars: number;
    /** How many secret-scrub markers (`[REDACTED…`) the section carries as sent. Absent on a fingerprint recorded
     *  before it was counted (unknown, never 0). `hillclimb regrade` compares it to never re-judge on a document
     *  less redacted than the graded one. */
    redactions?: number;
  }>;
}

/** Where an infrastructure error came from. A supervising process dying contaminates the whole run's
 *  evidence; a single failed `docker exec` does not. Keeping the origin lets the verdict treat them
 *  differently instead of collapsing both into one fatal class. */
export type InfraErrorSource = "hostloop-sidecar" | "hostloop-exec" | "egress-sidecar";

/** See `RunResult.fsDiff`. `findings` are `[fs-diff] output file removed post-run: <path>` strings. */
export interface OutputsFsDiff {
  status: "clean" | "findings" | "unavailable";
  reason?: "baseline-incomplete" | "post-walk-incomplete";
  findings: string[];
}

/** One observed tool call — see `RunResult.toolCalls`. */
export interface ToolCallRecord {
  toolUseId?: string;
  name: string;
  input: Record<string, { text: string; truncated?: boolean }>;
  origin: "main" | "subagent" | "unknown";
  parentToolUseId?: string;
}

export interface RunResult {
  $schema?: string;
  generator?: string;
  /** Which lane produced this result. "run" = an asserted run/skill/record/replay (carries a verdict);
   *  "chat" = an interactive exploratory session (no assertions, no verdict — consumers must NOT read a
   *  chat result as pass/fail). Absent on results written before this field existed — treat absent as "run". */
  mode?: "run" | "chat";
  /** The CLI COMMAND that produced this result — finer than `mode` (which only distinguishes run/chat).
   *  `skill`/`record` both have `mode:"run"`, so this is the only place that provenance survives; the run
   *  index prefers it during a reindex so a `skill`/`record` row isn't relabeled `run` (#48). Absent on
   *  results written before this field existed — reindex falls back to a prior index row, then to `mode`. */
  command?: "run" | "skill" | "record" | "chat" | "replay";
  /** Execution *location* taxonomy — orthogonal to `fidelity` (a privilege/sandbox tier, all local).
   *  Stamped `location:"local"` on every locally-executed run so that a future cloud-run artifact's
   *  differing/absent stamp is a detectable signal, never a silent mislabel. `environmentId` is the
   *  cloud `environment_id` (analysis: `teleportToCloud` / bridge sessions) — absent on every local run.
   *  `taskKind` distinguishes an interactive run from a scheduled-trigger run (CoworkScheduledTasks).
   *  ABSENCE IS NOT A POSITIVE "local" SIGNAL: an absent block means EITHER a result written before this
   *  field existed (pre-taxonomy) OR the error-replay lane (an unreadable cassette, where no environment
   *  could be recovered). Do not read absence as "local"; read a present `location:"local"` as local. */
  execution?: { location: "local" | "cloud"; environmentId?: string; taskKind?: "interactive" | "scheduled" };
  /** Did a COMPLETE scratchpad walk observe this run? Persisted because the verdict is computed from
   *  `RunResult` alone, and "no scratchpad files" must be distinguishable from "no scratchpad walk". False
   *  ⇒ the undelivered-deliverables signal stays silent because it CANNOT TELL, not because the run was
   *  clean. Absent on results written before this field existed — also treated as cannot-tell. */
  scratchpadEvidenceComplete?: boolean;
  /** The scenario's declared Cowork product lane — which delivery contract this run was held to. Distinct
   *  from `execution.location` (where the run PHYSICALLY happened, always local in this harness): the lane
   *  is DECLARED intent, because Cowork's lane is a per-session human choice that leaves no trace in a
   *  run's evidence. Absent ⇒ `local`, so every pre-existing result keeps its meaning. */
  lane?: "local" | "remote";
  scenario: string;
  prompt?: string; // the prompt that was run — persisted so `scaffold <run-dir>` can reconstruct the scenario
  fidelity: string;
  baseline: string;
  result: "success" | "error";
  // when result==="error", classify the KIND: a tail-end transport drop, a genuine agent/skill failure, or
  // usage_limit (quota exhausted — an is_error result with HTTP 429 + a terminal usage-limit message; NOT
  // the skill's fault, retry after the reset). Verdict- and renderer-relevant.
  resultErrorKind?: "transport" | "agent" | "usage_limit";
  /** How the run terminated in error — the `error` event's finer source (`spawn`/`protocol`/`exit`/`agent`,
   *  or `result` for the SDK-wrapped is_error-result path), OR `no_result` when the stream ended with no
   *  terminal event at all (the turn/time-exhaustion case: neither a result nor an error event fired), OR
   *  `timeout` when the harness's own wall-clock limit killed the run, OR `decider_timeout` when a
   *  `--decider-cmd`/`--decider-dir` channel did not answer a gate within its backstop (an unanswered-gate
   *  partial). Additive diagnostic detail alongside
   *  the coarse verdict-relevant `resultErrorKind`; consumed by nobody in the verdict. Absent on a clean run;
   *  a run that recovered from a non-fatal `agent` error and then succeeded keeps the first observed source. */
  errorSource?: "spawn" | "protocol" | "exit" | "agent" | "result" | "no_result" | "timeout" | "decider_timeout";
  /** The SDK result message's `subtype` verbatim (e.g. `error_max_turns`, `error_during_execution`,
   *  `success`) — a pass-through diagnostic so a debugger can tell turn-exhaustion from a generic execution
   *  error without the harness inventing a taxonomy. Present when a result event carried a subtype. */
  resultSubtype?: string;
  /** Absolute path to the agent's full stderr log (`<outDir>/agent.stderr.log`), surfaced so an
   *  OOM/crash debugger knows where to look. Live path only — absent on replay (no live process). */
  stderrLogPath?: string;
  // the run ended on a question or a closing request for input (src/run/input-request.ts) having done no
  // productive tool work after its last gate (the agent asked for input and stopped) while result==="success". A false-green: the SDK turn didn't error, but the
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
  // truthful per-tool CALL-COUNT map — always {tool: number} (NOT usage.server_tool_use, host-routed-blind in
  // cowork). For per-tool ERRORS use `toolErrors` ({tool:{calls,errors}}); for timing `toolDurations`
  // ({tool:{calls,totalMs,maxMs}}). The value here is never an object — don't conflate the three rollups.
  toolCounts?: Record<string, number>;
  /** Structured WebSearch calls — query + per-result {title,url}, parsed from the paired tool_result's
   *  "Web search results for query: ...\n\nLinks: [...]" convention (an AGENT-BINARY convention,
   *  verified against a real captured hostloop-fidelity cassette — re-verify the format on agent-version
   *  bumps). A parse failure (truncated past the assertText cap, or a future format change) drops that
   *  ONE entry silently — it is never a partial/malformed entry in this array. Collapsed to `undefined`
   *  (matching `models`/`thinking`/`tasks`) both when the run made zero WebSearch calls AND when every
   *  call's Links array failed to parse — the two are indistinguishable here by design; cross-reference
   *  `toolCounts.WebSearch` (the truthful call count) if that distinction ever matters to a consumer. */
  webSearches?: Array<{ toolUseId?: string; query: string; results: Array<{ title: string; url: string }> }>;
  /** Infrastructure errors, tagged by ORIGIN — origin drives severity. `hostloop-sidecar`/`egress-sidecar`
   *  mean a SUPERVISING PROCESS died, so the run's evidence is contaminated: a hard verdict fail on BOTH
   *  lanes, not author-suppressible. `hostloop-exec` is a single failed `docker exec` — the tool call
   *  failed, the run did not — so it warns, because one bad command must not red an otherwise sound run. */
  infraErrors?: Array<{ source: InfraErrorSource; message: string }>;
  /** Companion counters for malformed/dropped telemetry streams. A >0 count makes the dependent assertion
   *  fail "malformed" rather than silently dropping the bad entries (`taskTracking` → task assertions,
   *  `presentFilesMalformed` → no_scratchpad_leak); `webSearchParse` and `egressParse` are observability-only
   *  (no assertion — egress asserts are positive-only, so a dropped line already fails loud). */
  // `protocolMalformed` counts malformed control-stream USER blocks skipped at ingress (a non-object
  // content entry, or a tool_result with no correlatable tool_use_id) — observability-only, so a run whose
  // evidence is partially corrupt is visible rather than silently dropping the bad entries.
  evidenceErrors?: {
    taskTracking?: number;
    webSearchParse?: number;
    presentFilesMalformed?: number;
    egressParse?: number;
    protocolMalformed?: number;
  };
  // per-tool call-count/timing aggregate, folded from the timeline. Absent when no clean timeline
  // exists for this run (replayErrorResult — no run ever happened; a corrupt timeline; a cassette with
  // none). Populated for buildPartialResult too. Wall gap between tool_use and tool_result, NOT isolated
  // execution time — see foldToolDurations's doc comment (src/run/timeline-fold.ts). `calls`/`totalMs`/
  // `maxMs` are over PAIRED calls (0 when calls is 0); `unpaired` counts calls never paired with a `tool_result` the harness observed.
  // Covers main agent AND sub-agent calls. Result files written before `unpaired` existed lack it.
  // `unpaired` is optional in this READER type: the writer always emits it, but an older result.json (which
  // verify-run passes through verbatim) lacks it — absent means unknown, not 0.
  toolDurations?: Record<string, { calls: number; totalMs: number; maxMs: number; unpaired?: number }>;
  /** What `toolDurations` measures — present exactly when `toolDurations` is (result files written by this
   *  version or later). `"wall_gap"`: harness-
   *  observed wall time from tool_use to tool_result, including model/transport and permission latency;
   *  an Agent/Task entry spans its whole sub-agent run. On replay, the record-time gaps. Absent on a
   *  result file written before this field existed (the measure was the same wall gap then). */
  toolDurationsBasis?: "wall_gap";
  // distinct model ids seen across assistant_text/tool_use/thinking events, in first-seen order.
  // Absent only when replayErrorResult (no run ever happened). Populated for buildPartialResult too,
  // when the salvaged run had at least one assistant message.
  //
  // VERBATIM from the agent, NOT validated as a live model id. The agent stamps the literal
  // `<synthetic>` — its own constant, present in both the native and the VM binary — on assistant
  // messages it fabricates LOCALLY: no API call, zero-filled `usage`. So `["claude-sonnet-5",
  // "<synthetic>"]` is a normal array, and two runs of the SAME pinned model can differ here purely by
  // whether a synthesized turn occurred. Any consumer reading this as run provenance must drop
  // `<…>`-wrapped entries — match the angle-bracket prefix, not the one spelling (scripts/eval-gate.ts
  // learned this the hard way: an unfiltered `<synthetic>` flipped its observed answerer and refused a
  // valid gate).
  models?: string[];
  /** Turns where the agent fell back off the requested model, from the SDK's own `system`/`model_fallback`
   *  event. Each entry carries the binary's own `trigger` — `model_not_found` (the pinned id is retired or
   *  unknown), `model_blocked`/`permission_denied` (the account may not use it), or a transient
   *  `overloaded`/`server_error`/`last_resort`.
   *
   *  Read this INSTEAD of diffing `models`: a diff cannot distinguish a retired pin from a transient
   *  overload, and `models` legitimately holds several ids for reasons unrelated to fallback (sub-agent
   *  turns, the `<synthetic>` marker). An EMPTY array means no fallback event was observed — which is not
   *  the same as "the pin was honored"; see `modelPinHonored`. Absent on runs recorded before this field. */
  modelFallbacks?: Array<{ trigger: string; originalModel?: string; fallbackModel?: string }>;
  /** Did the model the scenario pinned survive the run? A THREE-state answer, and the third state is the
   *  point: `true` = pinned and no fallback observed; `false` = pinned and the agent fell back off it;
   *  `undefined` = **unverifiable** — nothing was pinned, or the run produced no model evidence at all
   *  (the unreadable-cassette lane sets `models: undefined`). The evidence is the main loop's live
   *  `models`; when it has none (a `/plugin:skill` prompt's synthetic turn), the session's `modelUsage`
   *  answers only when it is unambiguous — the pin is the only or the dominant billed model (`true`), or
   *  the single billed model is another (`false`) — and a concrete id was pinned. A boolean would have to render the third
   *  case as one of the first two, and rendering "we could not tell" as `true` is a false green of exactly
   *  the kind this repo's own guards exist to prevent. */
  modelPinHonored?: boolean;
  /** Where the run's model came from. `user_setting` is production's own term (Desktop stamps
   *  `source: "user_setting" | "global_default"` on its resolved model) and means something pinned the
   *  model here — a session `model:`, `--model`, a matrix axis or `COWORK_HARNESS_MODEL`; the harness
   *  does not distinguish those, because the distinction production draws is user-chose vs system-chose,
   *  not which surface carried it. `unresolved` is the state only the harness can occupy: nothing pinned
   *  the model. A run that would reach it is refused before it starts, so it appears only where no agent
   *  ran (a replay, an error result) or on a result recorded by a harness older than 4.0.0, where the agent
   *  binary chose its own default.
   *
   *  Production's `global_default` is deliberately NOT mirrored: it names an account-resolved default the
   *  harness never observes — when nothing is pinned here the agent resolves privately and reports only
   *  the id it ran. Carrying an unreachable member would invite consumers to branch on a value that never
   *  arrives. */
  modelSource?: "user_setting" | "unresolved";
  // reasoning blocks surfaced for debugging — capped at the last 50 blocks (older ones
  // silently dropped; see `thinkingElided` below for the dropped count). An author reads the
  // tail of reasoning, not a full history.
  // Scrubbed by the same secret-redaction pass as the rest of result.json.
  //
  // `redacted: true` on a block means the model reasoned here but returned EMPTY thinking text
  // (empty `thinking` + a present `signature`) because the API's thinking display mode was "omitted".
  // "omitted" is the API DEFAULT on newer models (Opus 4.8, Sonnet 5; Sonnet 4.6 defaulted to
  // "summarized"), and the harness passes no `--thinking-display` — faithfully to real Cowork, whose
  // spawn passes none either. So on current-gen models this field fills with `{text:"", redacted:true}`
  // entries: read that as "reasoned, text omitted by request," NOT "the model didn't reason." The API
  // never returns raw chain-of-thought — the fenced `debug.thinking_display: "summarized"` opt-in can
  // surface SUMMARIZED text (at a fidelity + token cost), but "omitted" is the faithful default.
  // `redacted` is omitted (not `false`) on blocks that carry text.
  thinking?: Array<{ text: string; redacted?: boolean }>;
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
    /** Provenance for an entry the harness INJECTED rather than one the author wrote. Absent = a real
     *  `assert:` item. Set it whenever you push a pseudo-assertion, or `verdict.failures[]` cannot tell
     *  the reader "your assertion failed" from "the cassette is stale" — the distinction a consumer was
     *  text-scraping stderr for. `staleness`: skill/baseline drift escalated by `--strict` or
     *  `--fail-on-skill-drift`. `cassette-format`: the cassette itself cannot be interpreted — too new a version, OR corrupt
     *  (duplicate/malformed control frames, a truncated recording). `coverage`: a
     *  verify-run answer-coverage miss (those inject a non-Assertion `answer_coverage` key, which
     *  otherwise renders as if the author had written it). */
    source?: "staleness" | "cassette-format" | "coverage";
    evidence?: string;
    /** Per-claim results for a `semantic_matches` assert (aligned to its rubric by index) — present only
     *  on the live lane where the judge ran; a consumer can diff these across runs to gate a change.
     *  `rationale` is the judge's one-sentence reason (absent when it gave none or gave a non-string): model
     *  output that can quote the judged document, so treat it as untrusted text. Its content never affects
     *  `pass`. Compare rationales only between runs that share `judgePromptHash`. */
    semanticClaims?: Array<{ index: number; claim: string; pass: boolean; rationale?: string }>;
    /** The judge model that graded a `semantic_matches` assert (provenance) — the resolved run-level
     *  pinned model, or a per-assert `judge_model` override. Lets a before/after eval verify the judge
     *  was held constant. Present only on the live lane where the judge ran. */
    judgeModel?: string;
    /** USD the judge spent grading this `semantic_matches` assert, summed over every attempt (a malformed
     *  grade is retried once, and both calls are paid). Reported BESIDE `cost.usd` (the agent's spend),
     *  never folded into it. Absent when no attempt was priced — unpriced is not $0. Live lane only. */
    judgeCostUsd?: number;
    /** Tokens the judge used grading this `semantic_matches` assert, summed over every attempt whose call
     *  completed and every model key the transport reported (the same basis as `judgeCostUsd`). Absent when no attempt reported
     *  token counters. Live lane only. */
    judgeUsage?: TokenUsage;
    /** A fingerprint of the exact document this assert's judge received (after secret scrubbing and every
     *  cap). Lets a later re-grade prove it showed the judge the same bytes, section by section, instead of
     *  assuming it. Absent when the judge never ran — including an assert refused for unavailable evidence
     *  (`semanticEvidence.reason` other than `graded`), for which the judge is deliberately not called. Live
     *  lane only. */
    judgedDoc?: JudgedDocFingerprint;
    /** How the judge's call was made: `isolation` (the level of isolation from the operator's own Claude Code setup —
     *  no tools, safe mode, user settings only) and the host CLI's version. Absent for an injected judge. Live lane only. */
    judgeTransport?: { isolation: string; cliVersion?: string; strictMcp?: false };
    /** How many calls the judge took for this assert: 1 plus every retry it ran. For
     *  `semantic_matches`, 1 or 2 (a malformed first grade is retried once). For `semantic_pairwise`, 1 plus the
     *  retries summed over every comparison and order, so `judgeAttempts - 1` is the number of retries. Absent
     *  where the judge never ran. Live lane only. */
    judgeAttempts?: number;
    /** A `semantic_pairwise` assert's composed candidate document, fingerprinted the same way as `judgedDoc` —
     *  recorded on every assert whose evidence was not refused, including one where every comparison was neutral
     *  (a run of the reference's own variant) and so no judge read it. A later freeze of this run as a reference
     *  checks its recomposition against it. Live lane only. */
    composedDoc?: JudgedDocFingerprint;
    /** Identity (16 hex) of the grading-prompt TEMPLATE the judge used. A before/after comparison must
     *  refuse to mix hashes: a prompt change can shift every pass rate. Live lane only. */
    judgePromptHash?: string;
    /** True when a `semantic_matches` grade was INVALID (malformed/ambiguous after a retry). Distinct
     *  from a normal fail: an eval aggregator counts this rep as invalid (not a fail, not absent), so a
     *  flaky judge can neither inflate a pass rate (by the rep vanishing) nor manufacture a regression. */
    judgeInvalid?: boolean;
    /** Per-reference outcomes of a `semantic_pairwise` assert, in the order its references were resolved. `status`
     *  `graded`: the judge compared the run with the frozen reference — `outcome` from the run's side, `value` 1 win
     *  / 0.5 tie / 0 loss / 0.5 both_bad, `order` which output the judge saw first, `positionFlip` when the two calls
     *  of `order: both` disagreed (a win/loss split scores as a tie; any other disagreement keeps the worse outcome,
     *  and `rationale` is the kept call's, or both joined by " | " for a win/loss tie). `neutral`: the reference was frozen from this very run's variant,
     *  so no judge was called and the value is 0.5. `missing` / `integrity`: the reference could not be read (absent,
     *  or failing its recorded sha256), and the assert is evidence-unavailable. `rationale` is the judge's reason
     *  restated from the run's side (untrusted model text). `refDocSha256` is the frozen document's sha256 — constant
     *  across every run judged against that reference. `gate: false` marks a reference that is a metric only: it
     *  never decides `pass_if` or refuses the verdict, and a comparison against it that could not be made is recorded
     *  (`missing` / `integrity`, or `invalid` when its judge reply stayed malformed) without making the assert
     *  evidence-unavailable. Only a caller that names gate references sets it (a hillclimb flow gates on its
     *  baseline). Live lane only. */
    pairwise?: Array<{
      ref: string;
      status: "graded" | "neutral" | "missing" | "integrity" | "invalid";
      gate?: false;
      /** A re-grade that only added comparisons kept this outcome from the live run rather than judging it again. */
      copied?: true;
      outcome?: "win" | "tie" | "loss" | "both_bad";
      value?: number;
      order?: "candidate_first" | "ref_first" | "both";
      positionFlip?: boolean;
      rationale?: string;
      refDocSha256?: string;
      /** The reference was frozen without a live fingerprint to check it against (`ref freeze --allow-unchecked`). */
      unchecked?: boolean;
      why?: string;
    }>;
    /** WHY a `semantic_matches` assert refused its verdict, or WHAT it graded — as a typed reason rather
     *  than prose. There are TEN distinct evidence-unavailable causes (four of them `fork_*`) with different fixes, and one
     *  success shape; a consumer (usually an agent iterating on a skill) must be able to tell "your
     *  `evidence_files` glob matched nothing" from "the deliverable was truncated" without regex-scraping
     *  an English message. Same rationale as `judgeInvalid` above. `paths` carries the concrete file list
     *  the reason is about: the run's authored paths for `scope_matched_nothing` (so the fix is IN the
     *  failure), the offending in-scope paths for the omitted/truncated reasons, and the graded set for
     *  `graded` — recorded on a substantive FAIL too, since the bug this guards against is a false
     *  ABSENCE and a red is only actionable next to what the judge was actually shown.
     *  `evidence_incomplete` is the UNSCOPED counterpart of `in_scope_omitted`: they want different fixes
     *  (add a scope vs. fix the glob or raise the budget), so they must not share one value.
     *  `no_pre_run_manifest` means the authored set could not be COMPUTED (no baseline to diff against),
     *  which is distinct from every other reason: those describe evidence that exists and could not be
     *  fully shown, this one describes evidence that was never derivable. Grading an empty authored set as
     *  though it were complete is the vacuous green this value exists to make impossible.
     *  Present only on the live lane, whenever the judge pre-pass ran. On every reason but `graded` the judge
     *  was NOT called — the refusal is decided from the composed evidence first — so such an assert carries
     *  no `semanticClaims`, `judgeModel`, `judgeCostUsd`, `judgeUsage`, `judgePromptHash` or `judgedDoc`. */
    semanticEvidence?: {
      reason:
        | "graded"
        | "scope_matched_nothing"
        | "in_scope_omitted"
        | "in_scope_truncated"
        | "evidence_incomplete"
        | "no_pre_run_manifest"
        | "authored_evidence_truncated"
        | "fork_result_truncated"
        | "fork_result_unpaired"
        | "fork_result_background"
        | "fork_calls_unrecorded";
      /** The offending authored paths — or, for the `fork_result_*` reasons, the offending `Skill` calls' skill names. */
      paths?: string[];
    };
  }>;
  /** The overall run/asserted-lane verdict — `computeVerdict`'s (src/run/verdict.ts) `Verdict` return
   *  value, persisted VERBATIM (never a second, narrower shape) so a kept run's `result.json` answers "did
   *  it pass, and why" (`jq '.verdict'`) without a consumer re-deriving from `assertions[]` and the
   *  guard-signal fields scattered across this type, or re-running `verify-run`. This is the SAME shape
   *  the `--output-format json` stdout envelope attaches to every result (envelope.ts calls
   *  `computeVerdict` too) — one canonical `Verdict` shape everywhere, computed by the one function, so the
   *  persisted and streamed channels can never diverge. `pass`/`exitCode` are the SAME values every verdict
   *  site (the run/skill exit, the footer, the JSON envelope `ok`) routes through `computeVerdict` for —
   *  never recomputed independently here. `signals`/`guards` are the raw verdict inputs (see
   *  `VerdictSignal`/`GuardReport` in verdict.ts — inlined here rather than imported, to avoid a
   *  types.ts → run/verdict.ts → types.ts import cycle). `failures` collapses `signals` into a flat,
   *  jq-friendly list: it names the failing assertion key (`Object.keys(a.assertion)`, the same convention
   *  `verify-run`'s text output uses) when a failure traces to one; a hard-verdict GUARD reason that
   *  failed the run independent of an explicit assert (an infra error, an unanswered gate, a scan-based
   *  host-path leak, a transport drop, …) carries just its message. Empty on a pass. SCOPE: the
   *  run/asserted lane ONLY (`run`/`skill`/`record`/`replay`, incl. a salvaged partial run — a whiffed
   *  gate is itself a verdict). `chat` carries NO assertions and NO verdict — this field is ABSENT
   *  (undefined), never a vacuous `{pass:true,...}`; a consumer must not read a chat result as pass/fail.
   *  Also absent on a result.json written before this field existed (pre-existing kept runs) — treat
   *  absence as "unknown", never as a pass. */
  /** One-field rollup of the `result` × `verdict.pass` × exit-code matrix, for consumers driving an
   *  iterative loop who must answer "did this iteration deliver something usable?" every turn. A PURE
   *  FUNCTION of the fields below (see `deriveOutcome`, run/outcome.ts) — it adds no judgement and can
   *  never disagree with them; the granular fields stay authoritative. `errored` dominates; then the
   *  existing no-deliverable signals (`stalled`/`ended_with_question`); then the verdict.
   *  ABSENT whenever `verdict` is absent (chat, or a pre-existing kept run) — treat absence as
   *  "unknown", never as a pass.
   *  **"delivered_*" means "no stall/question signal fired", NOT positive evidence a deliverable exists**
   *  — check `artifacts`/`workspaceFiles` for that. `no_deliverable` is reachable only on open-ended
   *  scenarios on the live lane (`ended_with_question`'s own scope), and being warn-severity it can
   *  coexist with `verdict.pass: true` and exit 0 — so do NOT infer the exit code from this field. */
  outcome?: "errored" | "no_deliverable" | "delivered_with_verdict_fail" | "delivered_clean";
  verdict?: {
    pass: boolean;
    exitCode: 0 | 1;
    signals: Array<{
      code:
        | "assertion"
        | "result_error"
        | "transport_error"
        | "usage_limit"
        | "permissive_auto_allow"
        | "outputs_delete"
        | "outputs_delete_unconfirmed"
        | "outputs_diff_unavailable"
        | "mount_delete"
        | "host_path_leak"
        | "non_deterministic"
        | "model_fallback"
        | "l0_host_config_contamination"
        | "missing_capability"
        | "infra_error"
        | "exec_infra_error"
        | "stalled"
        | "prompt_asset_missing"
        | "scan_unavailable"
        | "ended_with_question"
        | "undelivered_deliverables"
        | "delivery_unobservable"
        | "partly_scripted_gate";
      severity: "fail" | "warn";
      message: string;
    }>;
    guards: Array<{ name: string; status: "ok" | "fired" | "na" | "unverified" }>;
    /** `kind` is the discriminator — see `FailureKind` in src/run/verdict.ts, which is the SOURCE of
     *  this shape. This copy is structural (verdict.ts imports from here, so referencing it back would
     *  close a cycle), which means a change there must be mirrored HERE: a divergence is silent, and
     *  `test/run-result-schema.test.ts` catches it only because its fixture is typed `RunResult`. */
    failures: Array<{ assertion?: string; message: string; kind: "assertion" | "guard" | "staleness" | "cassette-format" | "coverage" }>;
  };
  /** The agent's final answer — the SDK result message (`{type:"result"}`.result), i.e. the model's
   *  designated final response. This is what llm-transport treats as "the answer"; it is distinct from
   *  the full joined transcript (every assistant turn concatenated). Surfaced so a consumer reads the
   *  answer from the envelope instead of parsing run.jsonl. Absent when no result event carried text
   *  (e.g. a spawn/exit error before the result). */
  finalMessage?: string;
  /** True when the run was ABLATED (`--ablate-skill`): the skill(s)-under-test were deliberately removed
   *  so the same prompt runs with no skill — a negative control for skill-lift measurement. A consumer
   *  must never read an ablated run as a real (with-skill) pass. Absent/false on a normal run. */
  ablated?: boolean;
  /** Skill reference/script files the agent actually **Read** during the run (skill-relative:
   *  `references/foo.md`, `scripts/bar.py`), deduped in first-seen order. A progressive-disclosure
   *  signal — "did the agent reach this content?" — for skill-quality measurement. Scope: **main-agent
   *  Reads only**; a sub-agent's reads are attributed separately, per-dispatch, on
   *  `subagents[].referencesRead` below — this top-level field's data is unaffected by that addition,
   *  matching `references/`/`scripts/` under a mounted plugin root — NOT `assets/`, and never `SKILL.md`
   *  (delivered whole, never Read as a file). Derived from the run's Read events, so it's present on
   *  **both live and replay**; absent when no such file was Read.
   *
   *  READ `referencesAccessed` INSTEAD for the question "did the agent open this reference?". This field
   *  counts the Read TOOL, and its absence is not evidence the content went unread — a `Bash cat`, a
   *  `Grep` or a `Glob` of the same file leaves nothing here. It is retained with exactly this meaning
   *  for consumers that want the strict channel; it is the `"read"` projection of `referencesAccessed`,
   *  produced by the same capture. */
  referencesRead?: string[];
  /** Every skill reference/script file the agent REACHED, and the tool channel(s) it reached them
   *  through — the WIDE progressive-disclosure signal, and the one a consumer asking "did the agent open
   *  this reference?" should read. `referencesRead` above is this field's `"read"`-channel projection,
   *  derived from the same capture so the two cannot disagree; it is kept, unchanged in meaning, because
   *  a `Read` and a `grep -c` are genuinely different evidence.
   *
   *  Channels: `read` (`Read.file_path`), `grep` (`Grep.path`), `bash` (a `Bash`/`mcp__workspace__bash`
   *  command naming the path). There is deliberately NO `Glob` channel: its `path` input is a DIRECTORY
   *  by tool contract, so it either fails the predicate outright or records a directory into a field
   *  documented as FILES. All three apply the SAME
   *  `skillReferenceReadPath()` predicate, which requires a mounted-plugin root — so a token only counts
   *  when it is rooted in the staged plugin, never the agent's own `scripts/` directory.
   *
   *  DELIBERATELY UNDER-APPROXIMATES. A `cd` into the plugin dir followed by a bare `cat references/x.md`,
   *  a heredoc body, a `$VAR`-built path and `find -exec` are all invisible. A miss is the correct side to
   *  err on for a positive signal; it is also why the negative assertion key is named
   *  `no_observed_reference_access` rather than promising proof of absence.
   *
   *  PRESENCE IS THE CANNOT-VERIFY CHANNEL, and this is the one way it differs from `referencesRead`
   *  (which collapses empty to `undefined` and therefore cannot express the difference):
   *    - `[]`        — the drive ran and observed no access. A real, usable negative.
   *    - `undefined` — no observable drive (a replay error result, a torn partial result, or a result
   *                    written before this field existed). Cannot verify; never read it as "none".
   *  Present on BOTH live and replay: cassettes freeze whole tool inputs, so the replay re-drive
   *  re-derives all four channels identically. */
  referencesAccessed?: Array<{ path: string; via: Array<"read" | "grep" | "bash"> }>;
  /** 1-based turn number within a resumed (`--session-id` + `--resume`) session — 1 for a normal
   *  single-shot run, incrementing per resume. Each turn owns its artifacts under `turns/<N>/`
   *  (`result.json`, `run.jsonl`, `trace.json`, `resources.jsonl`), so a multi-turn consumer attributes a
   *  result to its turn instead of blending cumulative telemetry. Absent on replay/chat lanes that don't
   *  track it. */
  turn?: number;
  subagents?: Array<{
    toolUseId: string;
    parentToolUseId?: string;
    dispatchAgentType: string; // the DISPATCH-INPUT type ("unknown" when the input omitted it)
    resolvedAgentType?: string; // the BINARY-resolved child type from task_started (incl. the general-purpose fallback); dispatchAgentType above keeps its dispatch-input semantics
    dispatchTypeOmitted?: boolean; // the dispatch input carried no subagent_type (proven by full input parse) — the wildcard-fallback trap fired
    declaredTools: string[];
    toolsUsed: Array<{ name: string; count: number }>;
    /** Skill reference/script files THIS sub-agent Read (same skill-relative shape and dedupe rule as
     *  the top-level `referencesRead` above), attributed via the dispatch's `toolUseId` — the sub-agent
     *  counterpart of the main-agent-only top-level field. Absent/empty when the dispatch Read no
     *  reference/script file. */
    referencesRead?: string[];
    /** THIS sub-agent's wide reference-access list — same shape, channels and caveats as the top-level
     *  `referencesAccessed`, attributed via the dispatch's `toolUseId`. */
    referencesAccessed?: Array<{ path: string; via: Array<"read" | "grep" | "bash"> }>;
    description?: string;
    prompt?: string; // dispatch input.prompt, assertText-capped
    dispatchModel?: string; // the DISPATCHING message's model (ex-"model" — renamed when resolvedModel landed beside it)
    resolvedModel?: string; // the RESOLVED child model from the dispatch's tool_use_result envelope
    output?: string; // the dispatch's own paired tool_result, assertText-capped
    outputTruncated?: boolean; // `output` was cut at the assert cap — a negative content check is unverifiable, not a proven absence
    attributedSkillId?: string; // the skill-activation window this dispatch was attributed to — NOT Fingerprint.skillScope (a different, unrelated field)
    /** The sub-agent's own THINKING and TEXT turns, in transcript order (tool_use/tool_result are
     *  excluded — already covered by `toolsUsed`/`referencesRead` above). Read from the on-disk child
     *  session transcript the agent binary writes per dispatch (`<configDirRoot>/projects/**\/subagents/
     *  agent-<id>.jsonl`, joined to this entry via the sibling `agent-<id>.meta.json`'s `toolUseId`) —
     *  the ONLY channel for a sub-agent's reasoning, since the SDK suppresses sub-agent thinking on the
     *  parent event stream. LIVE/record lane only: the child transcript exists only while the real agent
     *  binary ran, so this is `undefined` on replay (evidence-unavailable, like `resources`/`mcpErrors`)
     *  — never embedded in a cassette. Capped the same way the top-level `thinking[]` field is (~50
     *  entries, ~10KB/entry); `[]` is a valid "a child transcript was found but it captured no
     *  thinking/text turns" (a trivial dispatch may not reason at all) — distinct from `undefined`
     *  ("no child transcript joined to this dispatch").
     *
     *  IMPORTANT — sub-agent thinking TEXT is empty by default. A sub-agent thinking block arrives with
     *  an EMPTY `thinking` string but a non-empty cryptographic `signature` (the continuation token). This
     *  is a REQUEST-side display mode, not a persist-time strip: the harness's non-interactive (`-p`)
     *  spawn forces `thinking.display:"omitted"` for sub-agent turns, so the model returns empty thinking
     *  blocks that the transcript faithfully records. (Binary-verified against the staged 2.1.205 agent;
     *  corpus-corroborated — 230/230 sub-agent thinking blocks text-empty+signature-present, vs the same
     *  binary's main-loop keeping full text.) Such a turn is surfaced as
     *  `{ kind: "thinking", text: "", redacted: true }` — `redacted` means "the sub-agent DID reason here,
     *  but the text was omitted by request." Read it as "reasoned, text unavailable," NOT as "emitted an
     *  empty/absent thought." TEXT turns are never redacted (they persist verbatim), so what a sub-agent
     *  SAID is fully captured — only what it THOUGHT is omitted. An opt-in `--thinking-display summarized`
     *  lever could surface SUMMARIZED sub-agent thinking (the API exposes no raw chain-of-thought), but
     *  the default `"omitted"` is the real-Cowork-faithful behavior. `redacted` is omitted (not `false`)
     *  on non-redacted turns. */
    reasoning?: Array<{ kind: "thinking" | "text"; text: string; redacted?: boolean }>;
    /** Count of `reasoning` turns dropped by the cap above (oldest-first) — mirrors `thinkingElided`. */
    reasoningElided?: number;
    /** This sub-agent's OWN WebSearch calls (query + the paired tool_result's text, bounded), captured
     *  from the child session transcript alongside `reasoning` — sub-agent searches never enter the
     *  top-level `webSearches[]` (that field is main-agent/fork-scoped) or `toolCounts`, so without this
     *  a "researched" claim from a sub-agent was ungroundable from the result. RAW bounded text (not the
     *  parsed {title,url} shape of the top-level field): grounding needs the content the sub-agent
     *  actually saw, and the Links-convention parse would silently drop a format drift. LIVE/record lane
     *  only — the child transcript does not exist on replay, so this is `undefined` there (same contract
     *  as `reasoning`). `resultTruncated` marks a result cut at the per-entry byte cap.
     *
     *  NESTED research is folded in here too, tagged with `viaAgentId`/`viaSpawnDepth`. A sub-agent can
     *  dispatch its own sub-agent, and only dispatches the PARENT stream saw become `subagents[]` entries
     *  — so a search made two levels down had no entry to attach to and was silently dropped, rendering
     *  as "this dispatch did no research" when research is exactly what happened (measured: a 3-deep
     *  chain where the only WebSearch lived at depth 3). Rather than append synthetic entries — which
     *  would silently change `subagents.length` and with it `dispatch_count_max`, a published assertion —
     *  a descendant's searches are attributed to its nearest ANCESTOR that does have an entry, carrying
     *  the provenance so "my own search" stays distinguishable from "a search under me". An untagged
     *  entry is this dispatch's own. */
    webSearches?: Array<{
      query: string;
      resultText: string;
      resultTruncated?: boolean;
      /** Set when this search was made by a DESCENDANT dispatch, not by this one: the child agent id
       *  (`agent-<id>.jsonl`) that actually ran it. Absent = this dispatch's own search. */
      viaAgentId?: string;
      /** The descendant's own `spawnDepth` from its `agent-<id>.meta.json` (this dispatch is shallower).
       *  Absent when the meta carried no depth. Only meaningful alongside `viaAgentId`. */
      viaSpawnDepth?: number;
    }>;
    /** Count of WebSearch calls dropped past the per-dispatch cap (oldest-first) — mirrors `reasoningElided`. */
    webSearchesElided?: number;
  }>;
  /**
   * Decisions answered by a non-deterministic / non-authoritative source (LLM, external helper,
   * human, or the `first`-option fallback). Scripted answers (by:"scripted") are excluded because
   * they are authoritative and deterministic.
   */
  nonReproducibleAnswers?: Array<{ question: string; chosen: string; by: string; rationale?: string; model?: string }>;
  usage?: UsageInfo;
  cost?: CostInfo;
  /** USD the LLM decider (`on_unanswered: llm` / `--decider-llm`) spent answering this run's gates: the sum,
   *  over every model key, of the usage each COMPLETED transport call reported. Not counted: a call that
   *  threw (timeout, spawn failure, an envelope that did not parse) and the transport's own internal retries
   *  after a non-zero exit, which report no usage — so this is a floor, never an overcount. Reported BESIDE `cost.usd` (the agent's
   *  spend), never folded into it. Absent when no LLM decider answered, or none of its calls was priced —
   *  unpriced is not $0. Live lane only. */
  deciderCostUsd?: number;
  /** Tokens behind `deciderCostUsd`, same basis. Absent when no call reported token counters. */
  deciderUsage?: TokenUsage;
  /** The authored-file capture budget this run actually used: `perFileBytes` (the cap on an incidental
   *  file) and `totalBytes` (`COWORK_HARNESS_AUTHORED_TOTAL_BYTES`, else the
   *  default). The authored-file sections of a `semantic_matches` judge's document were drawn under this
   *  budget, so recomposing that document later needs it. `scratchpadWalked` says whether session-root
   *  (`scratchpad/…`) files were candidates at all — false on a `--resume` turn or a tier with no such
   *  layout. Absent when no capture ran (chat, replay, a salvaged partial run). */
  authoredCapture?: { perFileBytes: number; totalBytes: number; scratchpadWalked: boolean };
  /** The agent's own retried model calls, which it reports nowhere else — a run can be slow or costly
   *  because of them. Main loop and sub-agents are kept apart:
   *  - `count`/`delayMs`: `system` events with `subtype: "api_retry"`, and the sum of their
   *    `retry_delay_ms`. The main loop is sequential, so `delayMs` is time the run spent waiting.
   *  - `subagentCount`/`subagentDelayMs`: `tool_progress` frames carrying `subagent_retry` (the frame the
   *    agent emits when such a retry resolves carries none and is not counted). Sub-agents run
   *    concurrently, so `subagentDelayMs` is backoff summed across agents, NOT wall-clock time; never add
   *    it to `delayMs`.
   *  All zeros = a stream was observed with no retry of either kind; absent = no stream was observed (no
   *  `system/init` frame arrived: an agent that died before its stream began, a cassette that could not
   *  be driven, the error-replay lane). */
  apiRetries?: { count: number; delayMs: number; subagentCount: number; subagentDelayMs: number };
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
  artifacts?: {
    path: string;
    bytes: number;
    /** True when the file existed before the run and its content is unchanged (its pre-run hash equals its
     *  post-run hash) — inherited, e.g. from a `workspace_fixture`, not produced by this run. Absent when the
     *  run produced or rewrote it, or when there is no pre-run manifest to tell. */
    preRun?: true;
  }[];
  /** The scenario's `workspace_fixture` ref exactly as the scenario FILE wrote it (relative to that file), on
   *  live runs and on replay (derived there from the cassette's ref and its `scenarioSource`) — not the resolved
   *  absolute path, so `scaffold` can re-emit it verbatim. Absent when the scenario declares none, or was not
   *  loaded from a file. */
  workspaceFixture?: string;
  /** The scenario's declared `metrics`, measured: one entry per declared id, in declaration order, each carrying
   *  exactly one of `value` (a finite number read from the artifact) or `unavailable` (why not — see
   *  METRIC_UNAVAILABLE). Never part of the verdict. Absent when the scenario declares none (an empty list included),
   *  on a partial run, on chat, and on a replay that could not drive the cassette. */
  metrics?: Array<{ id: string; value?: number; unavailable?: MetricUnavailable }>;
  /** workRoot-relative paths that existed under the user-visible roots BEFORE the agent ran (captured
   *  post-staging, pre-spawn; `pre-run-manifest.json`) — the baseline `no_unexpected_files` diffs
   *  against. undefined = the run didn't capture it (it never armed one, or predates the seam; a --resume turn reads the first turn's manifest if that turn captured one; otherwise the key fails evidence-unavailable); the
   *  assertion then fails evidence-unavailable, never vacuous-passes. (microvm captures it now — its
   *  session tree is snapshotted from the VM into the run dir before this walk.) */
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
  /** Provenance of the pre-run baseline (`pre-run-manifest.json`'s `origin`). "local-walk" = the tree was
   *  walked locally and the path/hash maps are complete; "local-unreadable" = a connected-folder source
   *  could not be walked so the baseline is PARTIAL; "remote-unavailable" is reserved for a future cloud
   *  producer. Persisted so the plan-less lanes (verify-run reads result.json; replay reads the cassette)
   *  can make `no_unexpected_files` / `input_unmodified` fail evidence-unavailable on a non-`local-walk`
   *  baseline instead of diffing an incomplete tree. undefined = an older run/manifest predating the field
   *  (the assertion falls back to the preRunPaths/preRunHashes presence check, never assumes local-walk). */
  preRunOrigin?: "local-walk" | "remote-unavailable" | "local-unreadable";
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
  /** Question batches the scenario's scripted `answers:` matched only PART of. Answers are delivered
   *  atomically, so each such batch went WHOLE to the `on_unanswered` fallback and the matched answers were
   *  never delivered. `matched`/`unmatched` name the sub-questions. Report-only (the warn-severity
   *  `partly_scripted_gate` verdict signal); never moves the verdict. Re-derived from the cassette's frozen
   *  `answers:` on replay and from the current scenario on `verify-run`. Absent when none. */
  partlyScriptedGates?: Array<{ requestId?: string; matched: string[]; unmatched: string[] }>;
  /** Post-run scan signals (live lane only). computeVerdict default-fails on `hostPathLeaked`, and on
   *  `outputsDeletes` as tiered by `outputsDeleteTier` (src/run/outputs-delete-tier.ts), when the scenario did
   *  NOT author the matching assertion. Absent on the replay lane (a cassette can't reproduce them). */
  scan?: {
    /** Delete ops that touched `mnt/outputs`: text-scan hits, plus `[fs-diff] `-prefixed entries the
     *  filesystem diff proved (those are also in the top-level `fsDiff.findings`). */
    outputsDeletes: string[];
    /** POSITIONAL companion of `outputsDeletes` (same length, same order): why each entry is there.
     *  `fs-diff` = proven by the filesystem diff; `named` = a delete in command/call position has an
     *  outputs path as its own operand; `inferred` = flagged by the detector's inference (unprovable target, relative `cd`).
     *  Absent on results written before it existed — read as "unknown", which fails closed. */
    outputsDeleteBasis?: ("fs-diff" | "named" | "inferred")[];
    /** Per-mount delete detections across every delete-denied (`rw`) user-visible mount, including
     *  `outputs`. A SUPERSET of `outputsDeletes`, which is unchanged: production denies unlink/rmdir on
     *  every such mount, so a delete in a connected folder is a real detection that used to produce no
     *  signal at all. Reported, not verdict-moving — the harness detects where production ENFORCES. */
    mountDeletes?: { mount: string; command: string }[];
    /** A host path that did NOT come from the scenario's inputs appeared in model-visible text. */
    hostPathLeaked: boolean;
    /** How many distinct host-path tokens the scenario's inputs carried — the staged uploads and connected
     *  folders (captured before the agent ran, on the first turn) plus the turn's prompt. The tokens
     *  themselves are private paths and are never written here. Omitted when zero. */
    inputHostPathTokens?: number;
    /** How many distinct host-path tokens in model-visible text were exempted from `hostPathLeaked` because
     *  they came verbatim from those inputs. Omitted when zero; non-zero means a clean scan relied on it. */
    hostPathsFromInputs?: number;
    selfHealRan: boolean;
  };
  /** The outputs-delete FILESYSTEM diff for this turn (live lane only): `outputs/` snapshotted at turn start
   *  vs. after the turn. A top-level sibling of `scan`, not a member, so a filesystem-proven delete survives
   *  a missing/corrupt events.jsonl (which leaves `scan` undefined). `clean` means no path present at turn
   *  start was deleted — a file created AND deleted within the turn is invisible to it. `unavailable` means
   *  it could not verify (no/incomplete baseline, incomplete post-run walk): text hits then keep full
   *  fail-authority and the `outputs_diff_unavailable` warn is raised. Kept on a partial run salvaged from
   *  an unanswered gate (the diff runs before salvage). Absent on replay, chat, and results written before it
   *  existed. */
  fsDiff?: OutputsFsDiff;
  /** The fidelity tier actually used. Equals `fidelity` unless `fidelity:"cowork"` resolved to a specific tier. */
  effectiveFidelity?: string;
  /** Run-identity metadata for the iterate-across-fixes loop. `runLabel`: the user's `--label` generation
   *  tag (human-readable, orderable — surfaced in the run-index row + `inspect`; absent if not passed).
   *  Ergonomics only; the AUTHORITATIVE skill-version key is `fingerprint.skillHash` (content-exact).
   *  `skillCommit`: best-effort git HEAD shared by the session's skill source dirs — human/commit
   *  provenance ("which commit"), NOT a grouping key; `null` when the dirs span >1 repo, any is non-git,
   *  or none resolve. Both are properties of a LIVE run; a replay carries `undefined`. */
  runLabel?: string;
  skillCommit?: string | null;
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
  /** Replay-lane only, and only under `--mutate`: which recorded values were perturbed and which
   *  perturbations no assertion caught. `sampled` is post-cap and `eligible` is the pre-cap total, so a
   *  consumer can tell "N unguarded fields" from "N unguarded fields OUT OF eligible" — conflating the
   *  two is what nearly produced a false "our assertions verify nothing" report. `truncatedBy` names the
   *  cap that bound, since raising the other one would not change the sample. */
  mutation?: {
    sampled: number;
    eligible: number;
    truncatedBy: "per-file" | "total" | null;
    caps: { perFile: number; total: number };
    uncaught: string[];
  };
  /** Replay-lane only: count of assertions NOT evaluated on replay because they are live-only (filesystem /
   *  egress / expect_denied). `full` = the whole assertion was skipped; `partial` = its content half ran but a
   *  filesystem/egress half was dropped. Surfaced so a CI script doesn't read a green replay as having checked
   *  everything. The skipped assertions are absent from `assertions[]` (filtered before evaluation). */
  skippedAssertions?: { full: number; partial: number };
  /** Tool-result text at assertion-fidelity cap (10 KB per result; SKILL_RESULT_ASSERT_CAP for a top-level `Skill` result). Used by `tool_result_contains` /
   *  `tool_result_not_contains`. `assertText` is preferred when present; falls back to `text` (500-char
   *  display cap) for cassettes recorded before this field was added. */
  toolResults?: {
    toolUseId?: string;
    isError: boolean;
    text: string;
    assertText?: string;
    /** `assertText` was cut at its cap (10 KB, or SKILL_RESULT_ASSERT_CAP for a top-level `Skill` result) — a search that misses may have missed past the cut, so the
     *  object form of tool_called/tool_not_called fails a result predicate it cannot settle closed.
     *  Absent when not truncated, and on a result recorded before the field was typed. */
    assertTextTruncated?: boolean;
  }[];
  /** Every non-synthetic tool call the run observed, in stream order, with its top-level input fields
   *  (each capped at 10 KB, `truncated` when cut; a non-string value as its JSON) and WHERE it ran:
   *  `main` = top-level or a fork-scoped parent (Skill / Agent(fork)) — the set `toolCounts` counts;
   *  `subagent` = the parent is a dispatch this run recorded (any nesting depth); `unknown` = the parent
   *  is not a recorded dispatch. Backs the object form of `tool_called` / `tool_not_called`. Undefined on
   *  a result.json written before the field existed — that form then fails evidence-unavailable. Holds
   *  the same inputs `events.jsonl` already carries, secret-scrubbed the same way. */
  toolCalls?: ToolCallRecord[];
  /** true when L0 (protocol) ran with plugins that loaded via --settings/managed config instead of
   *  the operator's REAL config dir, so their installed plugins/skills/auto-memory/MCP servers were visible
   *  to the agent and may have answered instead of the thing under test. computeVerdict fails on this unless
   *  allow_l0_host_config_contamination is asserted — a warn-only was insufficient since the run could still appear
   *  green. (Pre-`--plugin-dir` this field meant "plugins were not delivered at L0"; delivery is fixed, the
   *  contamination is what remains.) */
  l0HostConfigContamination?: boolean;
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
  /** Staged skill ids this turn's prompt invoked by a leading slash command (`/<skill> …` or
   *  `/<plugin>:<skill> …`), resolved against the init frame's skill inventory. The agent binary expands such
   *  a command itself — no `Skill` tool_use is emitted, and a `context: fork` skill forks directly — so these
   *  never appear in `skillsInvoked`, whose meaning is unchanged. `skill_triggered`/`no_skill_triggered` read
   *  both. `[]` = the prompt invoked no staged skill by slash; absent = cannot tell (no prompt, a slash prompt
   *  with no inventory, a bare name more than one staged skill answers to, or a result written before this
   *  field existed — a kept-run re-check then re-derives it from `prompt` + `context.availableSkills`). */
  slashInvokedSkills?: string[];
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
  // Working folder panel's canonical file model. `artifacts` (unchanged type, {path,bytes}[])
  // becomes a DERIVED accessor of this — the class∈{output,mount} subset, computed in the
  // assembler at read time (no drift risk: nothing stores `artifacts` independently anymore, on the
  // live lane; replay is unaffected).
  //
  // `scratchpad` = written OUTSIDE every user-visible root, i.e. produced but not (by location)
  // delivered. Enumerated by a second walk shared with authored-file capture; the visible-root walk is
  // deliberately NOT widened, because `no_unexpected_files` walks the same prefixes and would change
  // verdict as a side effect. Absent on tiers where scratchpad capture cannot run (see
  // `authoredFilesHealth`) — absence there is evidence-unavailable, NOT "nothing was left behind".
  workspaceFiles?: Array<{
    path: string;
    bytes: number;
    sha256?: string;
    hashError?: string;
    class: "output" | "mount" | "input" | "scratchpad";
  }>;
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
  /** Attempt-level gated-file-tool telemetry (raw paths as sent). Undefined = evidence unavailable
   *  (a result recorded before this field existed); [] = captured, no gated attempts. Replay
   *  re-derives it (tool_use blocks are frozen stream content). */
  fileToolAttempts?: Array<{
    tool: string;
    paths: { file_path?: string; path?: string };
    gatePath?: string;
    origin: "main" | "subagent" | "unknown";
    parentToolUseId?: string;
    toolUseId?: string;
  }>;
  /** DECISION-level path-denial telemetry from all THREE producers that can deny a gated file-tool call
   *  on a path grounds — the PreToolUse path gate itself, a denied `can_use_tool` ask on a gated file
   *  tool with a path, and a pre-ask `permission_denied` correlated to a recorded gated attempt. Each
   *  producer independently filters to path-relevant denials (see RunRecord.pathDenials for the exact
   *  filter each applies). Undefined = evidence unavailable (an older result, or a replay whose cassette
   *  lacks `controlOut` — the can_use_tool source is reconstructible ONLY from controlOut); [] = captured,
   *  no path denials. */
  pathDenials?: Array<{
    source: "pretooluse" | "can_use_tool" | "permission_denied";
    tool: string;
    path?: string;
    callbackId?: string;
    decisionReasonType?: string;
    agentId?: string;
    decision: "deny";
    reason?: string;
    toolUseId?: string;
  }>;
  /** Files delivered via the cowork `present_files` tool, in call order — one entry per file the agent
   *  presented, derived from pairing each `mcp__cowork__present_files` tool_use with its own
   *  tool_result. `promoted` = the file was in the scratchpad and landed under `mnt/outputs`; `leaked` =
   *  it was in the scratchpad but did NOT land there (present_files' own copy-failure branch — the file
   *  "remains in the scratchpad", not deliverable to the user). A path already under a mount
   *  (passthrough) is neither. CONTENT-CLASS: both the tool_use and tool_result live in the ordinary
   *  events stream, so the replay re-drive reproduces this AT CONTAINER, where the agent's cwd is the session
   *  root the live lane measures containment from. At hostloop the live lane measures from the session root
   *  while the re-drive has only the recorded cwd (`mnt/outputs`, inside it), so promoted/leaked are not
   *  equivalent there — immaterial to `no_scratchpad_leak`, which evaluates at container only, and to
   *  `present_files_called`, which reads `presentFilesCalls` rather than this list. Undefined means no
   *  `present_files` telemetry was recorded for this run (an older run predating the feature), the
   *  evidence-unavailable signal for `no_scratchpad_leak`; an empty `[]` is a valid "nothing presented"
   *  state and is NOT the same as undefined. */
  presentedFiles?: Array<{ from: string; to: string; promoted: boolean; leaked: boolean }>;
  /** How many `present_files` calls carried at least one well-formed `file_path` — the PRESENCE
   *  evidence `present_files_called` reads, kept separate from `presentedFiles`' classification.
   *  Counted from the tool_use input's shape alone, never from a path's content, so it survives
   *  redaction: a host-path policy rewrites a hostloop presented path to `[REDACTED:…]/mnt/outputs/f`,
   *  which `presentedFiles` must drop as unclassifiable while this count stays correct. CONTENT-CLASS
   *  (re-derived on the replay re-drive). Undefined only for a run predating the field — the assertion
   *  then falls back to `presentedFiles` being non-empty, exactly as it behaved before. */
  presentFilesCalls?: number;
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
    /** Count of sampler probes that FAILED during the run — tells "sampling broke" apart from
     *  "sampling wasn't attempted". Observability-only: persisted in result.json but not yet consumed
     *  by resource assertions (that consumption tier is deliberately deferred). */
    probeFailures?: number;
  };
}

/** The filter EVERY consumer of `RunResult.models` (and of any other verbatim-from-the-agent model id)
 *  must apply before reading a value as run provenance. The agent stamps the literal `<synthetic>` on
 *  assistant messages it fabricates LOCALLY — no API call, zero-filled `usage` — so `["claude-sonnet-5",
 *  "<synthetic>"]` is an ordinary array and two runs of the SAME pinned model can differ purely by
 *  whether a synthesized turn occurred.
 *
 *  Matches the angle-bracket SHAPE (`<…>`), not the one known spelling, so a future marker is still
 *  excluded rather than rendered as if it were a model. The SHAPE and not merely the `<` PREFIX: the two
 *  disagree on a truncated or malformed value like `"<synthetic"`, and a consumer that treats such a
 *  value as live prints a marker where a model id belongs — the exact class of bug the filter exists for.
 *
 *  Lives here, beside the field it governs, because it had been reimplemented per consumer with
 *  DIFFERENT rules — `scripts/eval-gate.ts` had an unfiltered `<synthetic>` flip its observed answerer
 *  and refuse a valid gate, and `src/run/provenance.ts` (which renders `provenance.model` on every JSON
 *  envelope) carried a third copy. All three now share this one. */
export function isLiveModelId(m: unknown): m is string {
  return typeof m === "string" && !(m.startsWith("<") && m.endsWith(">"));
}
