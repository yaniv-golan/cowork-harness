import { warn } from "../io.js";
import { artifactsRootEnv, permissionPromptArgs } from "../answer-channel.js";
import { spawn } from "node:child_process";
import { mkdirSync, cpSync, existsSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import type { PlatformBaseline, Scenario } from "../types.js";
import type { LaunchPlan } from "../session.js";
import { SCRUBBED_AGENT_ENV_KEYS, workBaseOf, assertProtocolConfigSealed } from "../session.js";
import { verifyStagedHostInputs } from "../host-inputs.js";
import { gitModeEnabled, gitCpFilter } from "../run/skill-files.js";
import { containedRealPath } from "../boundary-paths.js";
import { BoundaryError, UsageError } from "../errors.js";
import { tokenCheck, type DoctorCheck } from "../run/doctor.js";
import { capturePreRunManifest } from "../run/pre-run-manifest.js";
import { BACKGROUND_TASKS_ENV_KEY, backgroundTasksEnv, pluginDirArgs, sessionFlagArgs } from "./argv.js";
import { agentSpawnOptions } from "./agent-tree.js";
import { stageWorkspaceFixture } from "../fixture/workspace.js";
import { carryLegFolders } from "./stage.js";
import { autoMemoryEnv, AUTO_MEMORY_ENV_KEY } from "../loop-decision.js";
import { SESSIONS_OAUTH_TOKEN_KEY } from "./host-env.js";

/**
 * Pure builder for L0's spawn env. Protocol spawns the host `claude` over the OPERATOR's full shell env
 * (`{...plan.baseEnv}`) — there is no baseline `spawn.env` overlay here (unlike hostloop/container/microvm),
 * so precedence is the two-layer `knob > operator env (scrubbed)`: scrub `SCRUBBED_AGENT_ENV_KEYS` from
 * the operator layer FIRST, then overlay the authored `agentEnv` knob so it always wins. Two keys come from the
 * baseline, as on every tier: the auto-memory switch (`autoMemoryEnv`) and the background-tasks switch
 * (`backgroundTasksEnv`). The operator's export of either is deleted first, and the knob cannot carry them. Extracted from
 * `spawnProtocol` so this env-construction step is unit-testable at the actual runtime call site.
 */
export function buildProtocolEnv(plan: LaunchPlan, baseline: PlatformBaseline, outputsDir?: string): NodeJS.ProcessEnv {
  const env = protocolOperatorEnv(plan);
  // `agent_env.artifacts_root`, in the knob layer: the agent runs on the host here, so outputs is the HOST path the
  // caller staged. Its operator export was scrubbed above (SCRUBBED_AGENT_ENV_KEYS).
  if (outputsDir !== undefined) Object.assign(env, artifactsRootEnv(plan.artifactsRoot, outputsDir));
  // Desktop's auto-memory switch for the modeled session (see autoMemoryEnv). The operator's own export is
  // deleted first — see AUTO_MEMORY_ENV_KEY. The knob cannot carry this key (its schema is strict), so applying it
  // after the knob changes no precedence. With the key set, the run's config dir's auto-memory does not load.
  delete env[AUTO_MEMORY_ENV_KEY];
  Object.assign(env, autoMemoryEnv(baseline));
  // Cowork's background-tasks switch, from the baseline's spawn.env as the other tiers apply it. Without it the agent
  // offers Bash `run_in_background`, which Cowork strips: a background shell outlives the run's `result`, wakes the
  // agent with a task notification after stdin is closed (its permission requests then fail "Stream closed"), and
  // holds stdout open until the shell ends.
  delete env[BACKGROUND_TASKS_ENV_KEY];
  Object.assign(env, backgroundTasksEnv(baseline));
  return env;
}

/** The operator, knob and credential layers of L0's env. */
export function protocolOperatorEnv(plan: Pick<LaunchPlan, "baseEnv" | "agentEnv">): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...plan.baseEnv };
  for (const k of SCRUBBED_AGENT_ENV_KEYS) delete env[k];
  // A credential Desktop builds as "" and then deletes, so its agent never has it: an operator export must not reach
  // this agent either (the knob cannot carry it).
  delete env[SESSIONS_OAUTH_TOKEN_KEY];
  Object.assign(env, plan.agentEnv ?? {});
  // The OAuth token, applied HERE so the documented `knob > operator env` layering stays in one function — an
  // `env.X = …` at the call site would silently outrank `plan.agentEnv`.
  //
  // It must be read from `process.env`, NOT from `env`: `CLAUDE_CODE_OAUTH_TOKEN` is the first entry of every
  // baseline's `bgEnvStrip.knownVars`, so `strippedEnv` has already deleted it from `plan.baseEnv`.
  //
  // Only when no API key is set: the agent would otherwise hold both. `ANTHROPIC_AUTH_TOKEN` is not stripped from the
  // operator layer, so it reaches the agent under its own name and is never copied into the OAuth variable (the agent
  // sends it as a plain bearer, not as a subscription token). Merging `runtimeAuthEnv()` wholesale would be wrong: it
  // only ADDS, and it rewrites TZ, which would give L0 normalized timezones.
  if (!env.ANTHROPIC_API_KEY && process.env.CLAUDE_CODE_OAUTH_TOKEN) env.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  return env;
}

/**
 * Copy the plan's mounts into the protocol work dir. A later leg of a `workdir: persistent` run copies nothing (the
 * earlier legs' tree stays), and instead re-hashes the host inputs it reuses (`plugins.from_host`).
 */
export function stageProtocolMounts(plan: LaunchPlan, work: string, workReal = realpathSync(work)): void {
  if (plan.legStage?.workdir === "persistent") verifyStagedHostInputs(plan, work, join(plan.configDir, "skills"));
  // A later leg of a `workdir: persistent` multi-leg run uses the same work dir: re-copying the sources would revert
  // what the earlier legs wrote into a folder.
  if (plan.legStage?.workdir === "persistent") return;
  for (const m of plan.mounts) {
    const dest = join(work, m.mountPath);
    mkdirSync(dirname(dest), { recursive: true });
    if (!containedRealPath(workReal, dirname(dest)))
      throw new BoundaryError(`cowork-harness: staged mount path "${m.mountPath}" resolves outside the work directory (symlink escape)`);
    // preserve symlinks as-is during staging; do not copy out-of-tree content
    // prefer the filter precomputed at plan-build (same tracked snapshot used for the staged-set
    // counts ⇒ delivered == counted). Fall back to a fresh gitCpFilter for non-plugin mounts.
    if (existsSync(m.hostPath)) {
      const f = m.stageFilter ?? (gitModeEnabled() ? gitCpFilter(m.hostPath) : null);
      // A host input keeps its symlinks as written (a relative in-tree link stays relative), exactly as the hashed
      // snapshot holds them; without this Node rewrites each link to an absolute pointer into the snapshot.
      cpSync(m.hostPath, dest, {
        recursive: true,
        dereference: false,
        ...(m.hostInputKey ? { verbatimSymlinks: true } : {}),
        ...(f ? { filter: f } : {}),
      });
    } else if ((process.env.COWORK_HARNESS_SOFT_MISSING ?? "") === "") {
      // The source vanished between plan-build (which already validated existence for a REQUIRED mount)
      // and staging — a TOCTOU race. Silently skipping would stage an empty tree, then a file_exists /
      // no_unexpected_files assertion would run against nothing (a masked failure). Fail loud unless the
      // caller opted into softMissing (where a missing source is an intended skip).
      throw new BoundaryError(
        `cowork-harness: mount source "${m.hostPath}" (→ ${m.mountPath}) is missing at staging time — set COWORK_HARNESS_SOFT_MISSING=1 to skip missing sources`,
      );
    } else {
      warn(`::warning:: [mount] source missing at staging, skipped (COWORK_HARNESS_SOFT_MISSING): ${m.hostPath} → ${m.mountPath}\n`);
    }
  }
}

/**
 * L0 — protocol-only runtime. Spawns the host `claude` with the stream-json
 * control protocol — WITHOUT `--cowork` (a guest-only flag the host CLI rejects;
 * see the note in spawnProtocol below). No VM, no container, no egress control.
 * Fast inner loop for skill logic + scripted-answer validation.
 *
 * Mounts are reproduced as plain directories under work/ so the agent sees the
 * same relative layout (uploads/, .projects/, .local-plugins/) — minus isolation.
 */
export function spawnProtocol(
  scenario: Scenario,
  baseline: PlatformBaseline,
  plan: LaunchPlan,
  outDir: string,
  opts: { systemPromptAppend?: string; runTag?: string } = {},
) {
  const work = join(workBaseOf(plan, outDir), "work");
  mkdirSync(join(work, "uploads"), { recursive: true });
  mkdirSync(join(work, "outputs"), { recursive: true });
  const workReal = realpathSync(work);

  stageProtocolMounts(plan, work, workReal);

  // workspace_fixture: turn-1 state. Protocol re-copies its mounts on EVERY turn (no resume guard above), so the
  // fixture needs its own: re-staging on a resumed turn would overwrite what turn 1 wrote over the fixture (and
  // the non-empty-outputs refusal would fire). Before the manifest, so an untouched fixture file is pre-run.
  // No session layout here, so no roots: a fixture with session-path tokens is refused (resolveLaunchSources
  // refuses it before spend; this is the backstop).
  if (plan.workspaceFixture && !plan.resume) stageWorkspaceFixture(plan.workspaceFixture, join(work, "outputs"));
  // A later `workdir: cowork-task` leg: carry each connected folder's post-state from the previous leg's work dir.
  if (plan.legStage?.workdir === "cowork-task") carryLegFolders(plan, plan.legStage.carryFromMnt, work);

  // no_unexpected_files baseline: snapshot the user-visible roots' paths post-staging, pre-spawn.
  capturePreRunManifest(plan, work, outDir, "protocol");

  // NOTE: `--cowork` is a GUEST-ONLY flag — the host `claude` CLI rejects it
  // ("unknown option '--cowork'"); it exists only in the staged in-VM binary
  // (claude-code-vm/<ver>). So L0 (host) runs WITHOUT it: this tier validates the
  // control loop + skill logic, NOT cowork-mode behavior. Use L1/L2 (which run the
  // staged binary) for `--cowork`. See docs/boundary.md.
  //
  // Auth: the agent always gets the run's managed config dir, so its credential must travel in the environment (a
  // Keychain or `/login` session lives in the operator's config dir, which it never reads). The batch pre-flight
  // (`credentialPreflight`) refuses before any run dir exists; this is the backstop for every path that
  // reaches the spawn without it (chat). One predicate: doctor's `tokenCheck`.
  const cred = tokenCheck("protocol");
  if (cred.status === "fail") throw new UsageError(credentialRefusal(scenario.name, cred));
  assertProtocolConfigSealed(plan.configDir);
  // Scrub the inheritance-asymmetric operator keys, then overlay the agent_env knob — see buildProtocolEnv.
  const env: NodeJS.ProcessEnv = buildProtocolEnv(plan, baseline, join(work, "outputs"));
  env.CLAUDE_CONFIG_DIR = plan.configDir;

  const args = protocolAgentArgs(baseline, plan, { workRoot: workReal, systemPromptAppend: opts.systemPromptAppend });

  // Detached, as Desktop spawns its agent, and tagged with the run's token: both are how a teardown finds
  // every process the agent starts (see agent-tree.ts). The tag is decided here and returned, never re-derived.
  const runTag = opts.runTag ?? `r${process.hrtime.bigint().toString(36)}`;
  const child = spawn("claude", args, agentSpawnOptions({ cwd: work, env, stdio: ["pipe", "pipe", "pipe"] as const }, runTag));
  // Where this agent's sub-agent child transcripts land, for the reasoning capture: the managed config dir.
  return { child, runTag, workDir: work, subagentConfigRoot: plan.configDir };
}

/** The refusal for a protocol run with no credential in the environment: doctor's own detail and remedy, so the text
 *  and the predicate cannot drift. `who` names the scenario(s). */
export function credentialRefusal(who: string, check: DoctorCheck, tier = "protocol"): string {
  return (
    `${who}: fidelity ${tier} needs a credential in the environment (env / .env) — ${check.detail}. ` +
    `The agent runs with a managed config dir, so a Keychain or /login session is not used.` +
    (check.remedy ? ` Fix: ${check.remedy}` : "")
  );
}

/** The protocol (L0) agent's argv, without the binary token. Session-decided flags come from `sessionFlagArgs`, the
 *  segments every tier shares; which `LaunchPlan` field reaches which tier is `SESSION_ARGV_FIELDS`. Pure: the
 *  caller passes the work root it staged. Discovery settings reach the agent through its managed config dir
 *  (`CLAUDE_CONFIG_DIR`), never a `--settings` flag. */
export function protocolAgentArgs(
  baseline: PlatformBaseline,
  plan: LaunchPlan,
  o: { workRoot: string; systemPromptAppend?: string },
): string[] {
  const seg = sessionFlagArgs(baseline, plan);
  return [
    "-p",
    "--verbose", // required by --output-format=stream-json with --print
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    // routes can_use_tool / AskUserQuestion to our Controller (verified); `answer_channel: none` declares nobody instead.
    // Shared with the sandbox tiers' argv (permissionPromptArgs).
    ...permissionPromptArgs(plan),
    "--include-partial-messages",
    ...seg.model,
    ...(plan.permissionMode ? ["--permission-mode", plan.permissionMode] : []),
    // effort, thinking, --thinking-display, --max-turns: the segment every tier shares (sessionFlagArgs). The host
    // CLI accepts each flag (checked against the binary: an unknown flag is refused before auth, these reach it).
    ...seg.budget,
    ...(plan.mcpConfig ? ["--mcp-config", plan.mcpConfig] : []),
    // Plugin roots, rooted at the tree spawnProtocol staged (`o.workRoot`) — never re-derived here.
    // Shared derivation with container/hostloop/microvm; see pluginDirArgs.
    ...pluginDirArgs(plan, o.workRoot),
    // Thread the rendered system prompt append into L0, matching container/microvm/host-loop.
    // The host `claude` CLI accepts --append-system-prompt just like the staged binary does, so L0
    // records can carry Cowork framing instead of running with no system prompt extension at all.
    ...(o.systemPromptAppend ? ["--append-system-prompt", o.systemPromptAppend] : []),
    // Hook lifecycle frames, on the same rule as the other tiers (see baseAgentArgs): only when a staged plugin
    // declares runnable hooks. Without it the host CLI streams SessionStart/Setup frames only, and every other
    // event's hook_event_* / hook_output_* assertion read "never fired" here.
    ...(plan.includeHookEvents ? ["--include-hook-events"] : []),
    // `--session-id` pins the agent's native session id; `--resume` continues it. The agent persists that session in
    // the run's managed config dir (`<config dir>/projects/`), so a resumed protocol run reads it back from there.
    ...seg.session,
  ];
}
