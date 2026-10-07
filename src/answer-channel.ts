import { posix } from "node:path";
import type { Assertion, PlatformBaseline, Scenario } from "./types.js";
import { GATE_ASSERT_KEYS } from "./types.js";
import { anyGlobMatches } from "./glob.js";

/**
 * `answer_channel: none` — a headless run with nobody to answer the agent.
 *
 * Real Cowork always has an answer channel: every question and permission ask reaches the user. Some hosts do not
 * (a headless SDK host), and a skill that parks at a gate and records `waiting` in its own status file is written
 * for that contract. This session key models it: the agent is spawned with `--permission-prompts none` instead of
 * `--permission-prompt-tool stdio`, so anything that would prompt is denied inside the agent and no question ever
 * reaches the harness.
 */

/** The label every surface prints for such a run (banner, summary, `--output-format json`'s `meta.label`). */
export const ANSWER_CHANNEL_NONE_LABEL = "headless, no answer channel — not Cowork";

/** The two argv tokens that decide who answers the agent's prompts. ONE function for every builder (the shared
 *  sandbox argv and protocol's own), so the two sites cannot drift. Absent key: today's stdio channel, byte-identical.
 *  Under `none` the stdio tool is OMITTED, not just overridden: the agent warns when both are passed. */
export function permissionPromptArgs(plan: { answerChannel?: "none" }): string[] {
  return plan.answerChannel === "none" ? ["--permission-prompts", "none"] : ["--permission-prompt-tool", "stdio"];
}

/** `agent_env.artifacts_root` → `COWORK_ARTIFACTS_ROOT`, resolved against the outputs directory AS THE AGENT SEES
 *  IT on this tier (a guest path in a sandbox, the host path on protocol). Each runtime passes the outputs path it
 *  already computed; nothing here re-derives one. Unset → no key. */
export function artifactsRootEnv(rel: string | undefined, agentOutputsDir: string): Record<string, string> {
  return rel === undefined ? {} : { COWORK_ARTIFACTS_ROOT: posix.join(agentOutputsDir, rel) };
}

/** `agent_env.artifacts_root` cannot reach a skill's scripts on the host loop: its shell runs in a separate container
 *  (`mcp__workspace__bash`, a `docker exec`) that never sees the agent's env, so the knob would be set and inert. */
export function artifactsRootRefusal(
  session: { agent_env: { artifacts_root?: string } },
  tier: string,
  authoredFidelity: string,
): string | undefined {
  if (session.agent_env.artifacts_root === undefined) return undefined;
  if (tier === "hostloop" || authoredFidelity === "cowork")
    return "`agent_env.artifacts_root` cannot run on the host loop (`fidelity: hostloop`, or `cowork`, which can resolve there): its shell runs in a separate container that never sees the agent's environment, so a script would not see COWORK_ARTIFACTS_ROOT. Use `container`, `microvm` or `protocol`.";
  return undefined;
}

/** The assertion keys that can carry POSITIVE completion evidence from files. A `none` scenario must assert at least
 *  one: the run ends `success` whether or not the skill finished, so completion is judged from what it wrote.
 *  `file_absent` is not one: a skill that did nothing passes it. */
const FILE_EVIDENCE_KEYS = ["artifact_json", "artifact_text", "file_exists", "user_visible_artifact"] as const;

/** The assertion half of the refusal: what an `assert:` block may not say under `answer_channel: none`, and what it
 *  must. Shared by the live load check and every path that grades a no-channel run against a NEW block (`verify-run`,
 *  `replay --assert-from` / `--reassert`, `hillclimb regrade`), so a re-grade cannot pass a block the run refuses. */
export function answerChannelAssertRefusal(assert: readonly Assertion[]): string | undefined {
  const why = (s: string) => `\`answer_channel: none\` ${s}`;
  for (const a of assert) {
    const gate = GATE_ASSERT_KEYS.find((k) => (a as Record<string, unknown>)[k] !== undefined);
    if (gate)
      return why(
        `refuses \`${gate}\`: it grades a gate the harness answered, and under this key the harness answers none. To check the skill parked at its gate, assert its status file (artifact_json).`,
      );
    if ((a as Record<string, unknown>).questions_count_max !== undefined)
      return why(
        "refuses `questions_count_max`: it counts the questions that reach the harness, and under this key none do, so it would always pass. Assert the status file the skill writes instead.",
      );
    if (namesAskUserQuestion(a))
      return why(
        "refuses `tool_called: AskUserQuestion`: the flag removes the tool from the agent's toolset (measured on agent 2.1.293), so the assertion could only fail. Assert the status file the skill writes instead.",
      );
  }
  if (!assert.some((a) => FILE_EVIDENCE_KEYS.some((k) => (a as Record<string, unknown>)[k] !== undefined)))
    return why(
      `needs at least one file assertion that the skill's own output satisfies (${FILE_EVIDENCE_KEYS.join(", ")}): the run ends \`success\` whether or not the skill finished, and a run that stops at a question is recorded as parked rather than failed, so completion must be judged from what the skill wrote.`,
    );
  return undefined;
}

/** What the refusal check needs about the invocation, beyond the scenario and session. Only what the USER chose:
 *  a caller that fills a resolved default (`onUnanswered: "fail"`) is not refused for it. */
export interface AnswerChannelInvocation {
  onUnansweredFlag?: string;
  hasDecider?: boolean;
  hasExternalChannel?: boolean;
  llmModel?: string;
  llmIntent?: string;
}

/** Why this run cannot use `answer_channel: none`, or undefined when it can. Each refused item asserts or configures
 *  a channel the run declares absent, so it is a load error, not a cannot-verify. `tier` is the EFFECTIVE tier
 *  (`cowork` already resolved); `authoredFidelity` is what the scenario wrote. */
export function answerChannelRefusal(args: {
  scenario: Scenario;
  session: {
    answer_channel?: "none";
    permission_mode: string;
    permission_parity: string;
    web_fetch: { approved_domains: string[] };
  };
  tier: string;
  baseline: PlatformBaseline;
  invocation?: AnswerChannelInvocation;
  /** Protocol only: does the host `claude` accept `--permission-prompts none`? Injected so tests need no binary. */
  probeHostCli?: () => { supported: boolean; path: string | undefined };
}): string | undefined {
  const { scenario, session, tier, baseline } = args;
  if (session.answer_channel !== "none") return undefined;
  const inv = args.invocation ?? {};
  const why = (s: string) => `\`answer_channel: none\` ${s}`;

  if (session.permission_mode !== "bypassPermissions")
    return why(
      `requires \`permission_mode: bypassPermissions\` (got "${session.permission_mode}"). Under any other mode the agent's ordinary permission asks are denied too — including Cowork's own present_files and delivery — and plan mode can never exit, so the run would fail for reasons that have nothing to do with the skill.`,
    );
  if (scenario.fidelity === "cowork" || tier === "hostloop")
    return why(
      "cannot run on the host loop (`fidelity: hostloop`, or `cowork` where it resolves there): the host loop's folder-grant and web_fetch guards are answered over the channel this key removes, so they would silently stop applying. Use `container`, `microvm` or `protocol`.",
    );
  if (scenario.lane === "remote" || (scenario.execution !== undefined && scenario.execution !== "local"))
    return why("is not supported on the cloud lane yet: its permission surface is unmeasured.");
  if (scenario.answers.length > 0)
    return why("refuses `answers:`: no question reaches the harness, so a scripted answer can never be delivered.");
  if (scenario.on_unanswered !== undefined || inv.onUnansweredFlag !== undefined)
    return why("refuses `on_unanswered` / `--on-unanswered`: no question reaches the harness, so there is nothing to decide.");
  if (inv.hasDecider || inv.hasExternalChannel || inv.llmModel !== undefined || inv.llmIntent !== undefined)
    return why("refuses a decider (`--decider-cmd`, `--decider-dir`, `--decider-model`): no question reaches the harness.");
  if (session.permission_parity !== "cowork")
    return why(
      `refuses \`permission_parity: ${session.permission_parity}\`: it configures how permission asks are answered, and none are asked.`,
    );
  if (session.web_fetch.approved_domains.length > 0)
    return why("refuses `web_fetch.approved_domains`: approving a domain is an answer to a prompt this run cannot show.");
  const assertRefusal = answerChannelAssertRefusal(scenario.assert);
  if (assertRefusal) return assertRefusal;

  if (tier === "protocol") {
    const probe = args.probeHostCli?.() ?? { supported: false, path: undefined };
    if (!probe.supported)
      return why(
        probe.path
          ? `needs a \`claude\` CLI that accepts \`--permission-prompts none\`; the one this protocol run would spawn (${probe.path}) does not list it in --help. Upgrade it, or use \`container\`/\`microvm\`.`
          : "needs a `claude` CLI on PATH for a protocol run, and none was found.",
      );
  } else {
    const caps = baseline.agentBinary?.cliCapabilities;
    if (caps === undefined)
      return why(
        `needs to know whether agent ${baseline.agentVersion} accepts \`--permission-prompts none\`, and baseline ${baseline.appVersion} does not record it (it predates the field). Re-run \`cowork-harness sync\` with that agent staged.`,
      );
    if (!caps.permissionPrompts)
      return why(
        `needs an agent that accepts \`--permission-prompts none\`; agent ${baseline.agentVersion} (baseline ${baseline.appVersion}) does not.`,
      );
  }
  return undefined;
}

/** `tool_called` naming AskUserQuestion, in the string or the object form (`tool:`, a glob or a glob list). A glob
 *  counts when it matches the name and starts with a literal (`AskUser*`); a bare catch-all (`*`, `?*`) says "some tool
 *  ran", not "the agent asked". Only `tool_called` is refused: `tool_not_called: AskUserQuestion` grades the same under
 *  every outcome of the flag. */
function namesAskUserQuestion(a: Assertion): boolean {
  const v = (a as Record<string, unknown>).tool_called;
  const raw = typeof v === "string" ? [v] : v && typeof v === "object" ? [(v as Record<string, unknown>).tool].flat() : [];
  return raw.some((g) => typeof g === "string" && /^[^*?]/.test(g) && anyGlobMatches([g], "AskUserQuestion"));
}
