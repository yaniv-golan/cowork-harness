import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { loadBaseline, resolveAgentBinary } from "../baseline.js";
import { loadSession, buildLaunchPlan } from "../session.js";
import { spawnContainer } from "../runtime/container.js";
import { spawnHostLoop } from "../runtime/hostloop.js";
import { spawnProtocol } from "../runtime/protocol.js";
import { renderPrompts } from "../prompt.js";
import { startEgressSidecar } from "../egress/sidecar.js";
import { Scenario } from "../types.js";
import { LiveAgentSession } from "../agent/session.js";
import { Run } from "./run.js";
import { makeRenderer, startHeartbeat, type RenderPlan } from "./renderer.js";
import { runsWriteRoot } from "./trace-view.js";
import { Chain, ScriptedDecider, PermissionDefaultDecider, PromptDecider } from "../decide/decider.js";
import { readGateFlag } from "../loop-decision.js";
import type { WebFetchProvenance } from "../hostloop/workspace-handler.js";

const log = (s: string) => process.stderr.write(s);

/**
 * `chat <folder> [prompt] [--raw] [--fidelity protocol|container|hostloop]` — interactive
 * multi-turn REPL against a skill, keeping the full harness (egress sandbox, control protocol).
 * `--raw` drops the protocol and `docker run -it`s the agent in its NATIVE interactive cowork
 * mode (unmediated escape hatch; egress sandbox NOT applied).
 */
export async function cmdChat(args: string[]) {
  const positional: string[] = [];
  let raw = false;
  // R4: COWORK_HARNESS_FIDELITY env var — protocol|container|hostloop accepted here (subset of skill tiers).
  const envFid = process.env.COWORK_HARNESS_FIDELITY;
  let fidelity: "protocol" | "container" | "hostloop" =
    envFid === "hostloop" ? "hostloop" : envFid === "protocol" ? "protocol" : "container";
  // R4: COWORK_HARNESS_MODEL env var default (CLI --model takes precedence).
  let model: string | undefined = process.env.COWORK_HARNESS_MODEL;
  let verbose = false;
  const uploads: string[] = [];
  const folders: Array<{ from: string; mode: "rw" }> = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--raw") raw = true;
    else if (a === "--verbose" || a === "-V") verbose = true;
    else if (a === "--fidelity") {
      const v = ++i < args.length ? args[i] : undefined; // §8.2: bounds check
      if (v !== "protocol" && v !== "container" && v !== "hostloop") {
        log(`chat --fidelity must be "protocol", "container", or "hostloop" (got "${v ?? ""}")\n`);
        process.exit(2);
      }
      fidelity = v;
    } else if (a === "--model") {
      if (++i >= args.length) {
        log(`chat --model requires a value\n`);
        process.exit(2);
      }
      model = args[i];
    } else if (a === "--upload") {
      if (++i >= args.length) {
        log(`chat --upload requires a file path\n`);
        process.exit(2);
      }
      uploads.push(args[i]);
    } else if (a === "--folder") {
      if (++i >= args.length) {
        log(`chat --folder requires a directory path\n`);
        process.exit(2);
      }
      folders.push({ from: args[i], mode: "rw" });
    } else positional.push(a);
  }
  const folder = positional[0];
  const seedPrompt = positional[1]; // optional: injected as the first turn before the REPL
  if (!folder) {
    log(
      "usage: chat <skill-folder> [prompt] [--raw] [--fidelity protocol|container|hostloop]\n" +
        "              [--model <id>] [--upload <file>]... [--folder <dir>]... [--verbose]\n",
    );
    process.exit(2);
  }

  if (raw) return chatRaw(folder, model);

  const session = loadSession({
    model,
    uploads,
    folders,
    permission_parity: "cowork",
    plugins: { local_plugins: [folder] },
  });
  const baseline = loadBaseline("latest");
  const sessionId = `local_${process.hrtime.bigint().toString(36)}`;
  const outDir = join(runsWriteRoot(), "chat", sessionId);
  mkdirSync(outDir, { recursive: true });
  const plan = buildLaunchPlan(session, baseline, outDir);
  const scenario = Scenario.parse({
    name: "chat",
    baseline: "latest",
    session: "(inline)",
    fidelity,
    prompt: "(interactive)",
    assert: [],
  });

  // #49: name ephemeral docker resources by a per-invocation runToken (not the persistent sessionId),
  // mirroring execute.ts's F1 hardening so a re-run can't collide on the sidecar container name.
  const runToken = `r${process.hrtime.bigint().toString(36)}`;
  // #43: no process.env mutation — pass proxy/network explicitly so concurrent calls don't stomp.
  // protocol tier runs the host claude binary with no Docker sandbox, so no sidecar is needed.
  const sidecar = fidelity !== "protocol" ? startEgressSidecar(plan.egressAllow, outDir, runToken) : null;
  const prompts = renderPrompts(baseline, session, sessionId);

  log(`cowork chat [${fidelity}] — run: ${sessionId}\n`);
  // Startup summary: show uploads and project folders so the developer knows what the agent sees.
  for (const m of plan.mounts) {
    if (m.mountPath.startsWith("uploads/")) log(`  upload: ${m.hostPath} → mnt/${m.mountPath}\n`);
    else if (m.mountPath.startsWith(".projects/")) log(`  folder: ${m.hostPath} → mnt/${m.mountPath}\n`);
  }
  log(`type your message, /exit to quit\n`);

  const runner = process.env.COWORK_CONTAINER_RUNTIME ?? "docker";
  let containerName: string | undefined;
  let child: { kill?: (s?: NodeJS.Signals) => void } | undefined;
  // #30: same web_fetch provenance wiring as execute.ts — ref created before spawn, filled after Run.
  const viaApiOn = readGateFlag(baseline, "1978029737", "coworkWebFetchViaApi");
  const promptGateOn = readGateFlag(baseline, "1978029737", "coworkWebFetchPrompt");
  const provenanceRef: { current?: WebFetchProvenance } = {};
  // #4: ONE readline interface on process.stdin, shared by the turn reader (ttyTurns) and the gate
  // prompter (PromptDecider). Two interfaces would race for the same stdin → undefined input routing.
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const ask = (prompt: string) => new Promise<string>((resolve) => rl.question(prompt, (a) => resolve(a.trim())));
  const renderPlan: RenderPlan = {
    live: true,
    progress: true,
    verbose,
    color: process.stderr.isTTY === true && !process.env.NO_COLOR,
  };
  const start = Date.now();
  let stopHeartbeat: (() => void) | undefined;
  try {
    if (fidelity === "protocol") {
      child = spawnProtocol(scenario, baseline, plan, outDir);
      const agent = new LiveAgentSession(child as any, outDir);
      const decider = Chain(new ScriptedDecider([]), new PermissionDefaultDecider("cowork"), new PromptDecider(ask));
      const renderer = makeRenderer(renderPlan);
      const run = new Run(agent, decider, [renderer], sessionId);
      stopHeartbeat = startHeartbeat(renderer, renderPlan, start);
      await run.drive(withSeedPrompt(seedPrompt, ttyTurns(rl)), { systemPromptAppend: prompts.systemPromptAppend });
    } else if (fidelity === "hostloop") {
      // #25: honor --fidelity hostloop in chat, mirroring execute.ts's branch selection.
      const hl = spawnHostLoop(scenario, baseline, plan, outDir, sessionId, {
        systemPromptAppend: prompts.systemPromptAppend,
        runToken,
        egressProxy: sidecar!.proxyUrl,
        dockerNetwork: sidecar!.network,
        provenanceRef,
      });
      child = hl.child;
      containerName = hl.containerName;
      const agent = new LiveAgentSession(hl.child as any, outDir);
      const decider = Chain(new ScriptedDecider([]), new PermissionDefaultDecider("cowork"), new PromptDecider(ask));
      const renderer = makeRenderer(renderPlan);
      const run = new Run(agent, decider, [renderer], sessionId);
      stopHeartbeat = startHeartbeat(renderer, renderPlan, start);
      if (viaApiOn) {
        provenanceRef.current = {
          isAllowed: (u) => run.provenanceHas(u),
          markAllowed: (u) => run.provenanceAdd(u),
          requestApproval: (d, u) => run.requestWebFetchApproval(d, u),
          promptGateOn,
          permissiveMode: plan.permissionMode === "bypassPermissions",
        };
      }
      await run.drive(withSeedPrompt(seedPrompt, ttyTurns(rl)), {
        systemPromptAppend: prompts.systemPromptAppend,
        sdkMcp: hl.sdkMcp,
      });
    } else {
      child = spawnContainer(scenario, baseline, plan, outDir, sessionId, {
        systemPromptAppend: prompts.systemPromptAppend,
        egressProxy: sidecar!.proxyUrl,
        dockerNetwork: sidecar!.network,
      });
      const agent = new LiveAgentSession(child as any, outDir);
      const decider = Chain(new ScriptedDecider([]), new PermissionDefaultDecider("cowork"), new PromptDecider(ask));
      const renderer = makeRenderer(renderPlan);
      const run = new Run(agent, decider, [renderer], sessionId);
      stopHeartbeat = startHeartbeat(renderer, renderPlan, start);
      await run.drive(withSeedPrompt(seedPrompt, ttyTurns(rl)), { systemPromptAppend: prompts.systemPromptAppend });
    }
  } finally {
    stopHeartbeat?.();
    // Reap the agent container first (mirrors execute.ts F1 hardening — #34).
    try {
      child?.kill?.("SIGKILL");
    } catch {
      /* already gone */
    }
    if (containerName) spawnSync(runner, ["rm", "-f", containerName], { stdio: "ignore" });
    sidecar?.teardown();
    rl.close(); // the one shared stdin interface — closed once, here
  }
  log(`\nchat ended (transcript under ${outDir})\n`);
}

/** Prepend an optional seed prompt before yielding from the TTY turn generator. */
async function* withSeedPrompt(seed: string | undefined, turns: AsyncGenerator<string>): AsyncGenerator<string> {
  if (seed) yield seed;
  yield* turns;
}

/** Async generator of user turns read from the TTY until EOF / `/exit`. Uses the caller's shared
 *  readline interface (the same one PromptDecider prompts gates on) — cmdChat owns its lifetime. */
async function* ttyTurns(rl: readline.Interface): AsyncGenerator<string> {
  // Track EOF once: with a piped/non-interactive stdin the interface can `close` while a turn is
  // still being processed, so the NEXT ask() must not call rl.question() on a closed interface
  // (that throws ERR_USE_AFTER_CLOSE). The per-turn close listener is removed when a line arrives
  // so listeners don't accumulate across a long interactive session.
  let closed = false;
  rl.once("close", () => {
    closed = true;
  });
  const ask = () =>
    new Promise<string | null>((res) => {
      if (closed) return res(null);
      const onClose = () => res(null);
      rl.question("\nyou> ", (a) => {
        rl.removeListener("close", onClose);
        res(a);
      });
      rl.once("close", onClose);
    });
  while (true) {
    const line = await ask();
    if (line == null) break;
    const t = line.trim();
    if (t === "/exit" || t === "/quit") break;
    if (!t) continue;
    yield t;
  }
}

/** `chat --raw` — native interactive cowork mode (no -p / stream-json), stdio inherited.
 *  Egress sandbox NOT applied. `--fidelity` is ignored. */
function chatRaw(folder: string, model?: string) {
  const baseline = loadBaseline("latest");
  const agent = resolveAgentBinary(baseline);
  const image = process.env.COWORK_AGENT_IMAGE ?? "cowork-agent-base:1";
  const runner = process.env.COWORK_CONTAINER_RUNTIME ?? "docker";
  log(`cowork chat --raw — native interactive cowork mode (egress sandbox NOT applied in --raw)\n`);
  const dockerArgs = [
    "run",
    "--rm",
    "-it",
    "--platform",
    "linux/arm64",
    "-v",
    `${agent}:/usr/local/bin/claude:ro`,
    "-v",
    `${folder}:/sessions/local/mnt/.local-plugins/cache/skill:ro`,
    "-w",
    "/sessions/local",
    "-e",
    "HOME=/tmp",
    "-e",
    "CLAUDE_CODE_IS_COWORK=1",
    // #30: pass the token by NAME only — docker inherits the value from its env (this process, via
    // stdio:"inherit"), so it never appears in the `docker run` argv (ps/proc).
    ...(process.env.CLAUDE_CODE_OAUTH_TOKEN ? ["-e", "CLAUDE_CODE_OAUTH_TOKEN"] : []),
    image,
    "claude",
    "--plugin-dir",
    "/sessions/local/mnt/.local-plugins/cache/skill",
    ...(model ? ["--model", model] : []),
  ];
  const child = spawn(runner, dockerArgs, { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
  child.on("error", (e) => {
    log(`--raw failed (native interactive mode may be unavailable): ${e}\n`);
    process.exit(2);
  });
}
