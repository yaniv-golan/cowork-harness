import { warn } from "../io.js";
import { spawn } from "node:child_process";
import { mkdirSync, cpSync, existsSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import type { PlatformBaseline, Scenario } from "../types.js";
import type { LaunchPlan } from "../session.js";
import { gitModeEnabled, gitCpFilter } from "../run/skill-files.js";
import { containedRealPath } from "../boundary-paths.js";
import { BoundaryError } from "../errors.js";

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
  opts: { systemPromptAppend?: string } = {},
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
    }
  }

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
  const env: NodeJS.ProcessEnv = { ...plan.baseEnv };
  const settingsFile = join(plan.configDir, "settings.json");
  const useManagedConfig = !!env.ANTHROPIC_API_KEY || process.env.COWORK_MANAGED_CONFIG === "1";
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
    ...(plan.mcpConfig ? ["--mcp-config", plan.mcpConfig] : []),
    // Thread the rendered system prompt append into L0, matching container/microvm/host-loop.
    // The host `claude` CLI accepts --append-system-prompt just like the staged binary does, so L0
    // records can carry Cowork framing instead of running with no system prompt extension at all.
    ...(opts.systemPromptAppend ? ["--append-system-prompt", opts.systemPromptAppend] : []),
  ];

  // Make the L0 divergence LOUD when the session declares plugins — L0 neither
  // applies the Cowork auth-env drop nor passes --plugin-dir, so plugin fidelity is not what
  // a cowork tier would give. Mirrors the L0 "network tool ran at L0" warning in execute.ts.
  // this also sets l0PluginDivergence=true so execute.ts can surface a FAILING fidelity
  // signal in the RunResult — a warn-only was insufficient since the run could still appear green.
  let l0PluginDivergence = false;
  if (plan.pluginDirs.length > 0) {
    l0PluginDivergence = true;
    warn(
      `::warning:: ${scenario.name}: L0 (protocol) does not apply the Cowork auth-env drop or --plugin-dir; ` +
        `${plan.pluginDirs.length} plugin dir(s) load via --settings/managed config, not the --plugin-dir cache layout — ` +
        `use container/microvm for auth+plugin fidelity.\n`,
    );
  }

  return { child: spawn("claude", args, { cwd: work, env, stdio: ["pipe", "pipe", "pipe"] }), l0PluginDivergence };
}
