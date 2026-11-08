// Every `LaunchPlan` field, and whether it reaches the agent as a CLI flag — on the sandbox tiers' argv
// (`baseAgentArgs`: container, microvm, hostloop) and on protocol's (`protocolAgentArgs`). The record is typed
// against `keyof LaunchPlan`, so a new plan field does not compile until it is dispositioned here. The argv guard
// (test/session-argv-fields.test.ts) and the per-tier table in docs/session.md both read it.
import type { LaunchPlan } from "../session.js";

/** `source` is what sets the field, as a user writes it: a session key, a CLI flag, or a condition. */
export type SessionArgvDisposition =
  /** A flag on every tier's argv. `note` states a per-tier difference in WHEN it is emitted, if any. */
  | { argv: true; source: string; flag: string; protocol: "emitted"; note?: string }
  /** A flag on the sandbox tiers' argv that protocol deliberately does not pass. */
  | { argv: true; source: string; flag: string; protocol: "excluded"; why: string }
  /** Not an agent flag: staging, env, or a harness-side decision. */
  | { argv: false; why: string };

export const SESSION_ARGV_FIELDS = {
  model: { argv: true, source: "`model`", flag: "--model", protocol: "emitted" },
  effort: {
    argv: true,
    source: "`effort`",
    flag: "--effort",
    protocol: "emitted",
    note: "always emitted; unset falls back to the baseline's default",
  },
  extendedThinking: { argv: true, source: "`extended_thinking`", flag: "--max-thinking-tokens / --thinking disabled", protocol: "emitted" },
  debugMaxThinkingTokens: { argv: true, source: "`debug.max_thinking_tokens`", flag: "--max-thinking-tokens", protocol: "emitted" },
  debugThinkingDisplay: { argv: true, source: "`debug.thinking_display`", flag: "--thinking-display", protocol: "emitted" },
  agentMaxTurns: { argv: true, source: "`agent_max_turns`", flag: "--max-turns", protocol: "emitted" },
  agentSessionId: { argv: true, source: "`skill --session-id`, each leg of a `legs:` run", flag: "--session-id", protocol: "emitted" },
  resume: { argv: true, source: "`skill --resume`", flag: "--resume", protocol: "emitted" },
  includeHookEvents: { argv: true, source: "a staged plugin that declares hooks", flag: "--include-hook-events", protocol: "emitted" },
  answerChannel: { argv: true, source: "`answer_channel`", flag: "--permission-prompt-tool / --permission-prompts", protocol: "emitted" },
  pluginDirs: { argv: true, source: "`plugins`, the skill folder", flag: "--plugin-dir", protocol: "emitted" },
  mcpConfig: {
    argv: true,
    source: "`mcp.config`",
    flag: "--mcp-config",
    protocol: "emitted",
    note: "the sandbox tiers pass the staged guest copy; protocol passes the host path",
  },
  permissionMode: {
    argv: true,
    source: "`permission_mode`",
    flag: "--permission-mode",
    protocol: "emitted",
    note: "protocol passes it only when set; the sandbox tiers always pass it, falling back to the baseline's value",
  },
  workBase: { argv: false, why: "run-dir layout: where the session tree is staged" },
  legStage: { argv: false, why: "multi-leg staging: what a later leg carries from the previous one" },
  lane: { argv: false, why: "the declared Cowork lane: decides which tools the harness serves (remote withholds present_files)" },
  configDir: {
    argv: false,
    why: "staged config; reaches the agent as CLAUDE_CONFIG_DIR at every tier",
  },
  stagedSkills: { argv: false, why: "staged into the config dir" },
  agentEnv: { argv: false, why: "spawn env" },
  agentEnvPassthrough: { argv: false, why: "spawn env (hostloop copies these names from the operator env)" },
  artifactsRoot: { argv: false, why: "spawn env (COWORK_ARTIFACTS_ROOT)" },
  permissionModeSource: { argv: false, why: "provenance of permissionMode, for reports" },
  permissionParity: { argv: false, why: "decided by the harness's permission handler" },
  baseEnv: { argv: false, why: "spawn env" },
  mounts: { argv: false, why: "staging (bind mounts or copies)" },
  hostOnlyFolders: { argv: false, why: "staging" },
  egressAllow: { argv: false, why: "enforced by the egress proxy" },
  webFetchVendorDeny: { argv: false, why: "enforced by the harness's web_fetch handling" },
  capturePreRun: { argv: false, why: "a harness snapshot before the run" },
  workspaceFixture: { argv: false, why: "staged into outputs/ before the run" },
  hostInputs: { argv: false, why: "a record of what plugins.from_host took from the host (RunResult.hostInputs)" },
} satisfies Record<keyof LaunchPlan, SessionArgvDisposition>;

/** The per-tier table in docs/session.md, between its `session-argv-fields` markers. Generated from the record above;
 *  test/session-argv-fields.test.ts keeps the doc in sync. Only the fields that reach the agent as a flag. */
export function renderSessionArgvTable(): string {
  const rows = Object.entries(SESSION_ARGV_FIELDS as Record<string, SessionArgvDisposition>).flatMap(([field, d]) => {
    if (!d.argv) return [];
    const protocol = d.protocol === "emitted" ? "yes" : `no: ${d.why}`;
    return [
      `| ${d.source} | ${d.flag
        .split(" / ")
        .map((f) => `\`${f}\``)
        .join(" / ")} | yes | ${protocol} | ${"note" in d && d.note ? d.note : ""} |`,
    ];
  });
  return ["| Set by | Agent flag | container / microvm / hostloop | protocol | Note |", "|---|---|---|---|---|", ...rows].join("\n");
}
