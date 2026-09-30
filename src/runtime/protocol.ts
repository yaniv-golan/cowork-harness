import { warn } from "../io.js";
import { spawn } from "node:child_process";
import { mkdirSync, cpSync, existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { PlatformBaseline, Scenario } from "../types.js";
import type { LaunchPlan } from "../session.js";
import { SCRUBBED_AGENT_ENV_KEYS } from "../session.js";
import { gitModeEnabled, gitCpFilter } from "../run/skill-files.js";
import { containedRealPath } from "../boundary-paths.js";
import { BoundaryError } from "../errors.js";
import { capturePreRunManifest } from "../run/pre-run-manifest.js";
import { pluginDirArgs } from "./argv.js";
import { agentSpawnOptions } from "./agent-tree.js";

/**
 * Pure builder for L0's spawn env. Protocol spawns the host `claude` over the OPERATOR's full shell env
 * (`{...plan.baseEnv}`) — there is no baseline `spawn.env` overlay here (unlike hostloop/container/microvm),
 * so precedence is the two-layer `knob > operator env (scrubbed)`: scrub `SCRUBBED_AGENT_ENV_KEYS` from
 * the operator layer FIRST, then overlay the authored `agentEnv` knob so it always wins. Extracted from
 * `spawnProtocol` so this env-construction step is unit-testable at the actual runtime call site.
 */
export function buildProtocolEnv(plan: LaunchPlan): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...plan.baseEnv };
  for (const k of SCRUBBED_AGENT_ENV_KEYS) delete env[k];
  Object.assign(env, plan.agentEnv ?? {});
  // Auth for the managed branch, applied HERE so the documented `knob > operator env` layering stays in
  // one function — an `env.X = …` at the call site would silently outrank `plan.agentEnv`.
  //
  // The token must be read from `process.env`, NOT from `env`: `CLAUDE_CODE_OAUTH_TOKEN` is the first
  // entry of every baseline's `bgEnvStrip.knownVars`, so `strippedEnv` has already deleted it from
  // `plan.baseEnv`. Gating on `env.CLAUDE_CODE_OAUTH_TOKEN` would be a branch that can never be taken.
  //
  // Inject ONLY the token, and ONLY when it is what selected the managed branch. Merging `runtimeAuthEnv()`
  // wholesale would be wrong twice: it only ADDS (the sealed tiers get their API-key drop by OMISSION,
  // from an env that never inherited the operator's keys — protocol's env IS the operator's shell env, and
  // ANTHROPIC_API_KEY is not stripped), so it would put BOTH credentials in one child env on the existing
  // CI path; and it rewrites TZ unconditionally, which would give managed-branch L0 normalized timezones
  // and non-managed L0 the raw export — same tier, two date semantics, and dates reach the model.
  if (managedConfigMode(env) && !env.ANTHROPIC_API_KEY) {
    const token = process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN;
    if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
  }
  return env;
}

/**
 * Does this run use the hermetic managed config dir, or the operator's real one?
 *
 * A fresh `CLAUDE_CONFIG_DIR` severs plugin/skill/MCP discovery (live-verified) — which is the isolation
 * we want — but it also breaks local OAuth, whose login state lives in the real dir. `doctor.ts` carries
 * the measurement: default config dir ⇒ authenticated; fresh managed dir ⇒ "Not logged in". So the managed
 * branch is only safe when a credential travels in the environment.
 *
 * `ANTHROPIC_AUTH_TOKEN` is included because `doctor` already recognises it as a credential; it was
 * missing from the original disjunct, leaving those operators silently on the contaminated branch.
 *
 * `COWORK_MANAGED_CONFIG=0` suppresses ONLY the credential-derived disjuncts — never the explicit `=1`.
 * It deliberately does NOT revoke the `ANTHROPIC_API_KEY` branch, whose hermeticity is a documented CI
 * promise (README "the CI path"). An unrecognised value THROWS: with a bare `=== "1"` test,
 * `COWORK_MANAGED_CONFIG=false` would fall through and silently select MANAGED — the opposite of intent.
 */
export function managedConfigMode(env: NodeJS.ProcessEnv): boolean {
  const raw = process.env.COWORK_MANAGED_CONFIG;
  if (raw !== undefined && raw !== "" && raw !== "0" && raw !== "1")
    throw new Error(
      `COWORK_MANAGED_CONFIG must be "0" or "1" (got ${JSON.stringify(raw)}) — an unrecognized value would silently pick a branch`,
    );
  if (raw === "1") return true;
  if (!!env.ANTHROPIC_API_KEY) return true; // documented CI path; `=0` does not revoke it
  if (raw === "0") return false;
  return !!(process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN);
}

/** realpath when the path exists, else the path itself — a config dir that does not exist yet is still
 *  comparable by spelling, and a symlinked HOME (macOS /tmp, /var) must not read as a different dir. */
function realpathIfPossible(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
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
  const work = join(outDir, "work");
  mkdirSync(join(work, "uploads"), { recursive: true });
  mkdirSync(join(work, "outputs"), { recursive: true });
  const workReal = realpathSync(work);

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
      cpSync(m.hostPath, dest, { recursive: true, dereference: false, ...(f ? { filter: f } : {}) });
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

  // no_unexpected_files baseline: snapshot the user-visible roots' paths post-staging, pre-spawn.
  capturePreRunManifest(plan, work, outDir, "protocol");

  // NOTE: `--cowork` is a GUEST-ONLY flag — the host `claude` CLI rejects it
  // ("unknown option '--cowork'"); it exists only in the staged in-VM binary
  // (claude-code-vm/<ver>). So L0 (host) runs WITHOUT it: this tier validates the
  // control loop + skill logic, NOT cowork-mode behavior. Use L1/L2 (which run the
  // staged binary) for `--cowork`. See docs/boundary.md.
  //
  // L0 deliberately DIVERGES from the cowork-fidelity tiers in TWO ways, BY DESIGN — L0
  // keeps the real local config for OAuth and is not a cowork-fidelity tier:
  //   - It does NOT apply runtimeAuthEnv()'s OAuth/API-key drop. container/microvm/
  //         host-loop drop the API key when an OAuth token is present (the L1/L2 fidelity
  //         behavior); L0 does not, because a fresh CLAUDE_CONFIG_DIR breaks local login.
  //   - It does NOT pass --plugin-dir. Declared plugins load via --settings/managed
  //         config, NOT the cowork --plugin-dir cache layout. So L0 cannot validate
  //         plugin/skill loading the way Cowork stages it.
  // Both are intentional; use container/microvm for auth+plugin fidelity. The defect this
  // addresses is SILENCE about the divergence, not the divergence itself (see the
  // ::warning:: below when plugins are declared — mirrors execute.ts's L0 network-tool warning).
  //
  // Auth strategy: a fresh CLAUDE_CONFIG_DIR breaks OAuth ("Not logged in"), since
  // local login state lives in the real config dir. So:
  //   - with ANTHROPIC_API_KEY (CI): use the hermetic managed config dir + the key.
  //   - else (local OAuth): keep the real config dir for auth, and layer our
  //     discovery settings via --settings so plugins/skills/mcp still apply.
  // Scrub the inheritance-asymmetric operator keys, then overlay the agent_env knob — see buildProtocolEnv.
  const env: NodeJS.ProcessEnv = buildProtocolEnv(plan);
  const settingsFile = join(plan.configDir, "settings.json");
  const useManagedConfig = managedConfigMode(env);
  const discoveryArgs: string[] = [];
  if (useManagedConfig) {
    env.CLAUDE_CONFIG_DIR = plan.configDir;
  } else {
    discoveryArgs.push("--settings", settingsFile);
  }

  const args = [
    "-p",
    "--verbose", // required by --output-format=stream-json with --print
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--permission-prompt-tool",
    "stdio", // routes can_use_tool / AskUserQuestion to our Controller (verified)
    "--include-partial-messages",
    ...discoveryArgs,
    ...(plan.model ? ["--model", plan.model] : []),
    ...(plan.permissionMode ? ["--permission-mode", plan.permissionMode] : []),
    // Real Cowork ALWAYS emits `--effort`, falling back to the baseline's medium default when nothing
    // is set — never omitted, for every model class (see buildLaunchPlan's validateEffort). The host
    // CLI accepts the flag (live-verified), so L0 is a non-vacuous check of this too.
    "--effort",
    plan.effort ?? baseline.spawn?.effortDefault ?? "medium",
    ...(plan.mcpConfig ? ["--mcp-config", plan.mcpConfig] : []),
    // Plugin roots, rooted at the tree THIS function staged (`workReal`) — never re-derived by a caller.
    // Shared derivation with container/hostloop/microvm; see pluginDirArgs.
    ...pluginDirArgs(plan, workReal),
    // Thread the rendered system prompt append into L0, matching container/microvm/host-loop.
    // The host `claude` CLI accepts --append-system-prompt just like the staged binary does, so L0
    // records can carry Cowork framing instead of running with no system prompt extension at all.
    ...(opts.systemPromptAppend ? ["--append-system-prompt", opts.systemPromptAppend] : []),
  ];

  // The L0 divergence is no longer about DELIVERY — --plugin-dir is passed above, so a declared plugin
  // or skill dir now reaches the agent. What remains is CONTAMINATION: off the managed branch the agent
  // reads the operator's real config dir, so their installed plugins, skills, auto-memory and MCP servers
  // are all live alongside the thing under test.
  //
  // This stays a FAIL signal (via computeVerdict), not a warn. Nothing else catches it: scanHostInventory
  // is reachable only from the cassette RECORD path and never reaches the verdict, host_path_leak's
  // default-fail is deliberately skipped at this tier, and a host plugin's own `plugins[]` entry exempts
  // its namespaced skills from the record-time inventory scan.
  //
  // `useManagedConfig` is NOT the same as "sealed": a pinned `plugins.config_dir` pointing at the real
  // config dir reaches host discovery with that boolean TRUE. So test the dir the agent will actually
  // read, not the branch that chose it.
  const operatorConfigDir = realpathIfPossible(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"));
  const agentConfigDir = realpathIfPossible(
    useManagedConfig ? plan.configDir : (process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")),
  );
  const l0HostConfigContamination = agentConfigDir === operatorConfigDir;
  if (l0HostConfigContamination) {
    warn(
      `::warning:: ${scenario.name}: L0 (protocol) is reading your REAL config dir (${agentConfigDir}), so your ` +
        `installed plugins, skills, auto-memory and MCP servers are visible to the agent and may answer INSTEAD of ` +
        `the plugin/skill under test. Set COWORK_MANAGED_CONFIG=1 AND provide a token ` +
        `(echo CLAUDE_CODE_OAUTH_TOKEN=$(claude setup-token) >> .env) — the flag alone yields "Not logged in" — ` +
        `or run 'cowork-harness doctor'. Use container/microvm for full isolation.\n`,
    );
  }

  // Detached, as Desktop spawns its agent, and tagged with the run's token: both are how a teardown finds
  // every process the agent starts (see agent-tree.ts). The tag is decided here and returned, never re-derived.
  const runTag = opts.runTag ?? `r${process.hrtime.bigint().toString(36)}`;
  const child = spawn("claude", args, agentSpawnOptions({ cwd: work, env, stdio: ["pipe", "pipe", "pipe"] as const }, runTag));
  return { child, l0HostConfigContamination, runTag, workDir: work };
}
