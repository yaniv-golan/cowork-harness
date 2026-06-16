import { z } from "zod";

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
        maxThinkingTokens: z.number().default(31999),
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
export const AnswerRule = z.object({
  // AskUserQuestion matcher
  when_question: z.string().optional(),
  choose: z.string().optional(),
  // tool-permission matcher
  when_tool: z.string().optional(),
  decide: z.enum(["allow", "deny"]).optional(),
  allow_if: z.string().optional(), // JS predicate over `input` (e.g. "!command.includes('rm')")
  else: z.enum(["allow", "deny"]).optional(),
  // web_fetch grant scope (only meaningful for a `webfetch:<domain>` allow): "once" = this fetch; "domain"
  // = approve the host for the rest of the run (models "Allow all for website", session-scoped).
  grant: z.enum(["once", "domain"]).optional(),
});
export type AnswerRule = z.infer<typeof AnswerRule>;

export const Assertion = z.object({
  transcript_contains: z.string().optional(),
  transcript_not_contains: z.string().optional(),
  transcript_matches: z.string().optional(), // regex (case-insensitive) over the transcript — fuzzy content for stochastic prose
  transcript_not_matches: z.string().optional(),
  file_exists: z.string().optional(),
  user_visible_artifact: z.string().optional(), // passes only for files under mnt/outputs or mnt/.projects (Cowork-promoted)
  tool_called: z.string().optional(),
  tool_not_called: z.string().optional(),
  subagent_tool_used: z.string().optional(),
  subagent_tool_absent: z.string().optional(),
  subagent_dispatched: z.string().optional(), // B2: an agentType was dispatched
  subagent_declared_but_unused: z.string().optional(), // B2: a sub-agent declared a tool but never used it (the v0.3.0 fabrication proxy)
  dispatch_count_max: z.number().optional(), // SPEC §10: assert total sub-agent dispatches ≤ N (the {global:3} ceiling)
  egress_denied: z.string().optional(),
  egress_allowed: z.string().optional(),
  no_delete_in_outputs: z.boolean().optional(), // fails if any delete op touched mnt/outputs
  self_heal_ran: z.boolean().optional(), // skill resolved scripts via /sessions (plugin-root self-heal)
  transcript_no_host_path: z.boolean().optional(), // no /Users//opt host path leaked to the model
  question_asked: z.string().optional(), // a question matching this regex was asked
  questions_count_max: z.number().optional(), // at most N questions asked
  gate_answers_delivered: z.boolean().optional(), // every answered AskUserQuestion gate's tool_result was non-error (the answer reached the model — catches O7-class delivery failures)
  result: z.enum(["success", "error"]).optional(),
  replay_protocol_fidelity: z.boolean().optional(), // synthesized by replayCassette — serializeDecision output matched the frozen controlOut recording (O7 guard on the token-free lane)
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
  })
  .strict();
// Back-compat (one minor): accept the deprecated top-level `profile:` key as an alias for `baseline:`,
// remapping it BEFORE `.strict()` rejects the unknown key. Remove next minor.
export const Scenario = z.preprocess((raw) => {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    if ("profile" in o && !("baseline" in o)) {
      const { profile, ...rest } = o;
      process.stderr.write(
        "::warning:: scenario field `profile:` is deprecated — rename it to `baseline:` (accepted for now; removed next minor).\n",
      );
      return { ...rest, baseline: profile };
    }
  }
  return raw;
}, ScenarioObject);
export type Scenario = z.infer<typeof ScenarioObject>;

export interface RunResult {
  scenario: string;
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
  nonDeterministic?: boolean; // true if any decision was made by a non-deterministic source (by:"llm"|"external"|"human"|"first") — a green run is NOT reproducible (#47)
  /** True when the CONFIGURED terminal (on_unanswered: llm/prompt, or an external channel) could answer
   *  non-deterministically — even if THIS run was fully scripted and didn't hit it. `nonDeterministic`
   *  stays execution-truth (what replay relies on); this is config-truth for audit consumers. */
  nonDeterministicTerminal?: boolean;
  /** #6: tools auto-allowed by cowork parity for unscripted, off-registry permission requests — real Cowork BLOCKS these for the user. A non-empty list means a green is NOT a faithful pass (pin with --answer or permission_parity: strict). */
  permissiveAutoAllow?: string[];
  /** The fidelity tier actually used. Equals `fidelity` unless `fidelity:"cowork"` resolved to a specific tier. (#24) */
  effectiveFidelity?: string;
}
