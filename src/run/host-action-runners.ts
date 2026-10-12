// The per-tier runners for a multi-leg HOST ACTION (see host-action.ts for what "the leg runtime" means and why).
// Each runs one argv in the runtime of the agent that ran before it, with that agent's env minus the credentials.

import { spawnSync, type spawn } from "node:child_process";
import { join } from "node:path";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import type { PlatformBaseline } from "../types.js";
import type { LaunchPlan } from "../session.js";
import { userVisibleRootsFromPlan } from "../session.js";
import { resolveMounts } from "../baseline.js";
import { sandboxAgentEnv, withoutSecrets, dockerRunArgv } from "../runtime/argv.js";
import { buildProtocolEnv } from "../runtime/protocol.js";
import { resolveAgentImage, resolveContainerRuntime } from "../runtime/agent-image.js";
import { startEgressSidecar, registerCleanup } from "../egress/sidecar.js";
import { startEgressProxy } from "../egress/proxy.js";
import { vmInit, applyGuestFirewall, vmGatewayIp, limaPath, VM_WORK_HOST } from "../runtime/lima.js";
import { microvmGuestSessionRoot, microvmGuestConfigDir, microvmGuestKillArgv } from "../runtime/microvm.js";
import { capturePreRunManifest, readPreRunManifestHashes, readPreRunManifest, readPreRunManifestOrigin } from "./pre-run-manifest.js";
import { runCapped, killGroup, removeContainer, type ActionExec } from "./host-action.js";
import type { evaluate } from "../assert.js";

export type ActionTier = "container" | "microvm" | "protocol";

/** Where an action's tree is, per tier: the HOST work root (what file assertions and manifests walk) and the
 *  AGENT-VISIBLE session root (what a substituted path must stay under). `sessionId` is the tree's session id. */
export function actionPaths(
  tier: ActionTier,
  baseline: PlatformBaseline,
  sessionId: string,
  workBase: string,
): { hostWorkRoot: string; sessionRoot: string; outputsHost: string } {
  if (tier === "protocol") {
    const work = join(workBase, "work");
    return { hostWorkRoot: work, sessionRoot: work, outputsHost: join(work, "outputs") };
  }
  if (tier === "microvm") {
    // The guest tree is the lima-mounted VM_WORK_HOST/<id> itself, live (the run dir holds a snapshot of it).
    const mnt = join(VM_WORK_HOST, sessionId, "mnt");
    return { hostWorkRoot: mnt, sessionRoot: microvmGuestSessionRoot(baseline, sessionId), outputsHost: join(mnt, "outputs") };
  }
  const mnt = join(workBase, "work", "session", "mnt");
  return { hostWorkRoot: mnt, sessionRoot: resolveMounts(baseline, sessionId, "proj1").sessionRoot, outputsHost: join(mnt, "outputs") };
}

/** The action's env on each tier: the agent's own builder, minus the credentials (SECRET_ENV_KEYS), and on protocol
 *  never the operator's CLAUDE_CONFIG_DIR. Exported so a test drives the real builders, not a fabricated map. */
export function hostActionEnv(
  tier: ActionTier,
  baseline: PlatformBaseline,
  plan: LaunchPlan,
  p: { sessionId: string; proxyHost: string; outputsHost: string },
): Record<string, string> {
  if (tier === "protocol") {
    const env = withoutSecrets(buildProtocolEnv(plan, baseline, p.outputsHost) as Record<string, string>);
    delete env.CLAUDE_CONFIG_DIR;
    return Object.fromEntries(Object.entries(env).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  }
  if (tier === "microvm") {
    const sessionVm = microvmGuestSessionRoot(baseline, p.sessionId);
    return withoutSecrets(
      sandboxAgentEnv(baseline, plan, {
        configGuest: microvmGuestConfigDir(baseline, sessionVm),
        proxyHost: p.proxyHost,
        outputsGuest: `${sessionVm}/mnt/outputs`,
      }),
    );
  }
  const m = resolveMounts(baseline, p.sessionId, "proj1");
  return withoutSecrets(
    sandboxAgentEnv(baseline, plan, {
      configGuest: `${m.sessionRoot}/${baseline.spawn?.configDirInGuest ?? "mnt/.claude"}`,
      proxyHost: p.proxyHost,
      outputsGuest: `${m.mntRoot}/outputs`,
    }),
  );
}

/** Run the argv in the leg runtime. Container and microvm get their own egress (the leg's allowlist) for the action's
 *  lifetime; the container is named, registered for interrupt cleanup and removed on timeout. */
export async function runActionInTier(p: {
  tier: ActionTier;
  baseline: PlatformBaseline;
  plan: LaunchPlan;
  sessionId: string;
  workBase: string;
  legDir: string;
  argv: string[];
  timeoutMs: number;
}): Promise<ActionExec> {
  const { tier, baseline, plan, sessionId, workBase, legDir, argv, timeoutMs } = p;
  const paths = actionPaths(tier, baseline, sessionId, workBase);
  const token = `a${process.hrtime.bigint().toString(36)}`;
  if (tier === "protocol") {
    const env = hostActionEnv(tier, baseline, plan, { sessionId, proxyHost: "", outputsHost: paths.outputsHost });
    // Detached into its own group (so a timeout kills the whole tree), which also keeps the terminal's Ctrl-C from
    // reaching it: register the kill for the interrupt path too.
    let deregister: (() => void) | undefined;
    try {
      return await runCapped(argv[0]!, argv.slice(1), {
        cwd: paths.outputsHost,
        env,
        timeoutMs,
        kill: killGroup,
        onSpawn: (child) => (deregister = registerCleanup({ phase: "container", run: () => killGroup(child) })),
      });
    } finally {
      deregister?.();
    }
  }
  if (tier === "container") {
    const runner = resolveContainerRuntime();
    const sidecar = startEgressSidecar(plan.egressAllow, legDir, token);
    const name = `cowork-act-${token}`;
    const deregister = registerCleanup({ phase: "container", run: () => removeContainer(runner, name) });
    try {
      const m = resolveMounts(baseline, sessionId, "proj1");
      const env = hostActionEnv(tier, baseline, plan, { sessionId, proxyHost: sidecar.proxyUrl, outputsHost: paths.outputsHost });
      const args = dockerRunArgv({
        network: sidecar.network,
        lockdown: (process.env.COWORK_LOCKDOWN ?? "on") !== "off",
        name,
        sessionRoot: m.sessionRoot,
        agentCwd: `${m.mntRoot}/outputs`,
        sessionHost: join(workBase, "work", "session"),
        image: resolveAgentImage(),
        env,
        agentArgv: argv,
        readOnlyMountPaths: plan.mounts.filter((x) => x.mode === "r").map((x) => x.mountPath),
      });
      return await runCapped(runner, args, { env: process.env, timeoutMs, kill: () => removeContainer(runner, name) });
    } finally {
      removeContainer(runner, name);
      deregister();
      sidecar.teardown();
    }
  }
  // microvm
  const { instance } = vmInit(baseline);
  const proxy = startEgressProxy({ allow: plan.egressAllow, host: "0.0.0.0", port: 0, logPath: join(legDir, "egress.log") });
  try {
    await proxy.ready;
    const gatewayIp = vmGatewayIp();
    if ((process.env.COWORK_LOCKDOWN ?? "on") !== "off") applyGuestFirewall(instance, proxy.actualPort!, gatewayIp);
    const env = hostActionEnv(tier, baseline, plan, {
      sessionId,
      proxyHost: `http://${gatewayIp}:${proxy.actualPort}`,
      outputsHost: paths.outputsHost,
    });
    const sessionVm = microvmGuestSessionRoot(baseline, sessionId);
    const configVm = microvmGuestConfigDir(baseline, sessionVm);
    const script = `cd "$1" && shift && exec "$@"`;
    const envPairs = Object.entries(env).map(([k, v]) => `${k}=${v}`);
    // Killing the host client does not reach the guest: stop the action's guest processes by their config dir — on a
    // timeout, and on the operator's interrupt.
    const stop = (child: ReturnType<typeof spawn>) => {
      spawnSync(limaPath(), microvmGuestKillArgv(instance, configVm, "KILL"), { stdio: "ignore" });
      child.kill("SIGKILL");
    };
    let deregister: (() => void) | undefined;
    try {
      return await runCapped(
        limaPath(),
        ["shell", instance, "sh", "-c", script, "_", `${sessionVm}/mnt/outputs`, "env", ...envPairs, ...argv],
        {
          env: process.env,
          timeoutMs,
          kill: stop,
          onSpawn: (child) => (deregister = registerCleanup({ phase: "container", run: () => stop(child) })),
        },
      );
    } finally {
      deregister?.();
    }
  } finally {
    proxy.close();
  }
}

/** Take the action's pre- or post-run manifest of the user-visible roots into `legDir` (pre-run-manifest.json /
 *  post-run-manifest.json), with the same walker every run uses. */
export function takeActionManifest(plan: LaunchPlan, hostWorkRoot: string, legDir: string, tier: ActionTier, which: "pre" | "post"): void {
  const armed = { ...plan, capturePreRun: true, resume: false } as LaunchPlan;
  if (which === "pre") {
    capturePreRunManifest(armed, hostWorkRoot, legDir, tier);
    return;
  }
  const tmp = join(legDir, ".post");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  capturePreRunManifest(armed, hostWorkRoot, tmp, tier);
  renameSync(join(tmp, "pre-run-manifest.json"), join(legDir, "post-run-manifest.json"));
  rmSync(tmp, { recursive: true, force: true });
}

/** The evaluation context for an action's file assertions: its tree, and its pre-run manifest so `authored: true`
 *  means "this action wrote it". */
export function actionFileCtx(plan: LaunchPlan, hostWorkRoot: string, legDir: string, tier: ActionTier): Parameters<typeof evaluate>[1] {
  return {
    transcript: "",
    workRoot: hostWorkRoot,
    effectiveFidelity: tier,
    lane: "local",
    userVisiblePrefixes: userVisibleRootsFromPlan(plan),
    preRunPaths: readPreRunManifest(legDir),
    preRunHashes: readPreRunManifestHashes(legDir),
    preRunOrigin: readPreRunManifestOrigin(legDir),
    resume: false,
  } as unknown as Parameters<typeof evaluate>[1];
}
