import readline from "node:readline";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { mkdirSync, existsSync, readdirSync } from "node:fs";
import { loadBaseline, resolveAgentBinary } from "../baseline.js";
import { loadSession, buildLaunchPlan } from "../session.js";
import { spawnContainer } from "../runtime/container.js";
import { spawnHostLoop } from "../runtime/hostloop.js";
import { spawnProtocol } from "../runtime/protocol.js";
import { renderPrompts } from "../prompt.js";
import { makeDisplayTranslator, vmPathContextFromPlan, linkifyForTerminal, shouldLinkify } from "./display-translate.js";
import { writeVmPathContextFile } from "./vm-path-ctx-file.js";
import { startEgressSidecar, registerCleanup } from "../egress/sidecar.js";
import { Scenario } from "../types.js";
import { LiveAgentSession, type AgentEvent } from "../agent/session.js";
import { Run, type RunHooks } from "./run.js";
import { makeRenderer, startHeartbeat, type RenderPlan } from "./renderer.js";
import { runsWriteRoot } from "./trace-view.js";
import { Chain, ScriptedDecider, PermissionDefaultDecider, PromptDecider } from "../decide/decider.js";
import { readGateFlag } from "../loop-decision.js";
import type { WebFetchProvenance } from "../hostloop/workspace-handler.js";
import { checkHostLoopWriteConsent, logHostWriteNotice } from "../hostloop/safety.js";
import { PATH_GATE_TOOL_NAMES } from "../hostloop/pretooluse-path-hook.js";

const log = (s: string) => process.stderr.write(s);

/** Fidelity tiers `chat` supports. A subset of the full Scenario tier set: `microvm`/`cowork` are NOT
 *  supported in the interactive REPL (no Lima/auto-pick plumbing here), so they are rejected loudly
 *  rather than silently degraded to container — symmetric with the `--fidelity` flag's own validation. */
const CHAT_FIDELITY_TIERS = ["protocol", "container", "hostloop"] as const;
type ChatFidelity = (typeof CHAT_FIDELITY_TIERS)[number];

/**
 * The chat option spec — the SINGLE source of truth for both parsing and the usage text (the
 * usage string used to be hand-written and omitted `--plugin`). Each entry documents one option; the
 * usage line is generated from `usage` fields so a parsed-but-undocumented flag is impossible.
 */
const CHAT_OPTIONS = [
  { flag: "--raw", kind: "boolean", usage: "[--raw]" },
  { flag: "--verbose", kind: "boolean", usage: "[--verbose]" },
  { flag: "--fidelity", kind: "value", usage: "[--fidelity protocol|container|hostloop]" },
  { flag: "--model", kind: "value", usage: "[--model <id>]" },
  { flag: "--upload", kind: "value", usage: "[--upload <file>]..." },
  { flag: "--folder", kind: "value", usage: "[--folder <dir>]..." },
  { flag: "--plugin", kind: "value", usage: "[--plugin <dir>]..." },
  { flag: "--allow-host-writes", kind: "boolean", usage: "[--allow-host-writes]" },
] as const;

/** Build the chat usage string from CHAT_OPTIONS so every parsed flag is documented. */
function chatUsage(): string {
  const opts = CHAT_OPTIONS.map((o) => o.usage);
  return "usage: chat <skill-folder> [prompt] " + opts.slice(0, 3).join(" ") + "\n              " + opts.slice(3).join(" ") + "\n";
}

/**
 * `chat <folder> [prompt] [--raw] [--fidelity protocol|container|hostloop] [--model <id>]
 *  [--upload <file>]... [--folder <dir>]... [--plugin <dir>]... [--verbose]` — interactive multi-turn
 * REPL against a skill, keeping the full harness (egress sandbox, control protocol). `--raw` drops the
 * protocol and `docker run -it`s the agent in its NATIVE interactive cowork mode (unmediated escape
 * hatch; egress sandbox NOT applied — and all file/fidelity options are rejected in `--raw`).
 */
export async function cmdChat(args: string[]) {
  const positional: string[] = [];
  let raw = false;
  // parse COWORK_HARNESS_FIDELITY through the same tier set the --fidelity flag validates. An
  // invalid value (a typo, or microvm/cowork which chat doesn't support) is rejected LOUDLY rather than
  // silently degraded to container — symmetric with the CLI flag and with skill's env handling.
  const envFid = process.env.COWORK_HARNESS_FIDELITY;
  if (envFid !== undefined && !(CHAT_FIDELITY_TIERS as readonly string[]).includes(envFid)) {
    log(
      `chat: COWORK_HARNESS_FIDELITY must be one of ${CHAT_FIDELITY_TIERS.join("|")} (got "${envFid}")` +
        (["microvm", "cowork"].includes(envFid) ? ` — ${envFid} is not supported in chat` : "") +
        "\n",
    );
    process.exit(2);
  }
  let fidelity: ChatFidelity = (envFid as ChatFidelity | undefined) ?? "container";
  // COWORK_HARNESS_MODEL env var default (CLI --model takes precedence).
  let model: string | undefined = process.env.COWORK_HARNESS_MODEL;
  let verbose = false;
  let allowHostWrites = false;
  const uploads: string[] = [];
  const folders: Array<{ from: string; mode: "rw" }> = [];
  const localPlugins: string[] = [];
  // track which flags were actually passed, for the --raw consolidated-ignore check.
  const seenFlags = new Set<string>();
  // a value reader that rejects a MISSING, EMPTY, or flag-looking value for value-flags (the old
  // code only bounds-checked, so `--upload --folder` took `--folder` as the upload path and `--upload ""`
  // was accepted). Used uniformly by --model/--upload/--folder/--plugin so a flag-looking next token
  // (e.g. `--model --upload x.pdf`) is rejected instead of being swallowed as the value.
  const nextValue = (i: number, flag: string, what: string): string => {
    if (i + 1 >= args.length) {
      log(`chat ${flag} requires ${what}\n`);
      process.exit(2);
    }
    const v = args[i + 1];
    if (!v.trim()) {
      log(`chat ${flag} requires a non-empty ${what}\n`);
      process.exit(2);
    }
    if (v.startsWith("-") && !/^-\d/.test(v)) {
      log(`chat ${flag} requires ${what} but got a flag-looking token "${v}" — did you forget the value?\n`);
      process.exit(2);
    }
    return v;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--raw") {
      raw = true;
      seenFlags.add("--raw");
    } else if (a === "--verbose") verbose = true;
    else if (a === "--allow-host-writes") {
      allowHostWrites = true;
      seenFlags.add("--allow-host-writes");
    } else if (a === "--fidelity") {
      const v = ++i < args.length ? args[i] : undefined; // bounds check
      if (v === undefined || !(CHAT_FIDELITY_TIERS as readonly string[]).includes(v)) {
        log(`chat --fidelity must be ${CHAT_FIDELITY_TIERS.map((t) => `"${t}"`).join(", ")} (got "${v ?? ""}")\n`);
        process.exit(2);
      }
      fidelity = v as ChatFidelity;
      seenFlags.add("--fidelity");
    } else if (a === "--model") {
      // Route through nextValue so a flag-looking next token is rejected (not swallowed as the model id),
      // matching --upload/--folder/--plugin. The `-\d` carve-out keeps valid model ids intact.
      model = nextValue(i++, "--model", "a model id");
      seenFlags.add("--model");
    } else if (a === "--upload") {
      uploads.push(nextValue(i++, "--upload", "a file path"));
      seenFlags.add("--upload");
    } else if (a === "--folder") {
      folders.push({ from: nextValue(i++, "--folder", "a directory path"), mode: "rw" });
      seenFlags.add("--folder");
    } else if (a === "--plugin") {
      localPlugins.push(nextValue(i++, "--plugin", "a directory path"));
      seenFlags.add("--plugin");
    } else if (a.startsWith("-")) {
      log(`chat: unknown flag: ${a}\n`);
      process.exit(2);
    } else positional.push(a);
  }
  const folder = positional[0];
  const seedPrompt = positional[1]; // optional: injected as the first turn before the REPL
  // reject extra positionals — `chat <folder> [prompt]` consumes at most two; a third (e.g. an
  // unquoted multi-word prompt) was silently ignored, so the run used unintended input.
  if (positional.length > 2) {
    log(
      `chat takes at most <skill-folder> [prompt] (got ${positional.length} positionals: ${positional.join(", ")}) — ` +
        `quote a prompt that contains spaces\n`,
    );
    process.exit(2);
  }
  if (!folder) {
    log(chatUsage());
    process.exit(2);
  }

  if (raw) {
    // --raw runs the agent in native docker mode — it has NO egress sandbox and NO control
    // protocol, so every file/sandbox-fidelity option is meaningless there. Previously only --plugin
    // warned; uploads/folders/fidelity were silently dropped. Reject the file/sandbox options loudly
    // (they imply mounts/fidelity --raw cannot honor), and warn on the rest.
    const rawRejected = ["--upload", "--folder", "--plugin", "--fidelity", "--allow-host-writes"].filter((f) => seenFlags.has(f));
    if (rawRejected.length > 0) {
      log(
        `chat --raw does not support ${rawRejected.join(", ")} — --raw mounts ONE skill folder in native cowork ` +
          `mode with no egress sandbox or fidelity selection. Drop these flags or omit --raw.\n`,
      );
      process.exit(2);
    }
    return chatRaw(folder, model);
  }

  // DECISION (mount-path fidelity work): chat's positional `folder` is the skill/plugin under test, so it
  // is mounted as a `local_plugins` entry (NOT a work folder) — i.e. it routes through the plugin path
  // (`mnt/.local-plugins/marketplaces/local-desktop-app-uploads/<name>` on a current baseline). Any folders
  // the user additionally connects via `folders` get the work-folder path. This is intentional: `chat
  // <skill-folder>` is a skill harness, not a Spaces folder.
  const session = loadSession({
    model,
    uploads,
    folders,
    permission_parity: "cowork",
    plugins: { local_plugins: [folder, ...localPlugins] },
  });
  // hostloop with a writable connected folder gives the native agent process genuine, software-checked-
  // only host filesystem access — no container sandbox. Refuse loud, before any spawn, unless the caller
  // opts in with --allow-host-writes (chat sessions are ad-hoc, not committed YAML, so there's no
  // scenario field to set — this is the CLI-flag equivalent).
  if (fidelity === "hostloop") checkHostLoopWriteConsent(session, allowHostWrites);
  const baseline = loadBaseline("latest");
  const sessionId = `local_${process.hrtime.bigint().toString(36)}`;
  const outDir = join(runsWriteRoot(), "chat", sessionId);
  mkdirSync(outDir, { recursive: true });
  const plan = buildLaunchPlan(session, baseline, outDir, fidelity, false); // chat has no resume concept
  // mounts.json (see vm-path-ctx-file.ts's header): mirror execute.ts's unconditional write.
  // Chat's `fidelity` is fixed at CLI-parse time (no "cowork" gate resolution here, unlike execute.ts's
  // effectiveFidelity), so it IS the effective tier this session actually runs at. Best-effort; never
  // fails the chat session.
  writeVmPathContextFile(outDir, vmPathContextFromPlan(sessionId, plan, outDir), fidelity);
  const scenario = Scenario.parse({
    name: "chat",
    baseline: "latest",
    session: "(inline)",
    fidelity,
    prompt: "(interactive)",
    assert: [],
  });

  // name ephemeral docker resources by a per-invocation runToken (not the persistent sessionId),
  // mirroring execute.ts's hardening so a re-run can't collide on the sidecar container name.
  const runToken = `r${process.hrtime.bigint().toString(36)}`;
  // no process.env mutation — pass proxy/network explicitly so concurrent calls don't stomp.
  // protocol tier runs the host claude binary with no Docker sandbox, so no sidecar is needed.
  const sidecar = fidelity !== "protocol" ? startEgressSidecar(plan.egressAllow, outDir, runToken) : null;
  // Host-loop prompt-token substitution (P2a) — mirrors execute.ts's call site exactly (same pure joins,
  // same staged-skills check via plan.configDir), so `run`/`skill`/`chat` never diverge on this recipe.
  const hostLoopOpts =
    fidelity === "hostloop"
      ? (() => {
          const hostMnt = join(resolve(outDir), "work", "session", "mnt");
          const skillsDir = join(plan.configDir, "skills");
          const skillsStaged = existsSync(skillsDir) && readdirSync(skillsDir).length > 0;
          return {
            effectiveFidelity: fidelity,
            hostCwd: join(hostMnt, "outputs"),
            hostUploadsDir: join(hostMnt, "uploads"),
            hostWorkspaceFolder: plan.mounts.find((m) => m.kind === "folder")?.hostPath,
            hostSkillsDir: skillsStaged ? skillsDir : undefined,
          };
        })()
      : undefined;
  const prompts = renderPrompts(baseline, session, sessionId, plan.mounts.find((m) => m.kind === "folder")?.mountPath, hostLoopOpts);

  log(`cowork chat [${fidelity}] — run: ${sessionId}\n`);
  // Startup summary: show uploads and project folders so the developer knows what the agent sees.
  for (const m of plan.mounts) {
    if (m.kind === "upload") log(`  upload: ${m.hostPath} → mnt/${m.mountPath}\n`);
    else if (m.kind === "folder") log(`  folder: ${m.hostPath} → mnt/${m.mountPath}\n`);
  }
  log(`type your message (/help for commands)\n`);

  const runner = process.env.COWORK_CONTAINER_RUNTIME ?? "docker";
  let containerName: string | undefined;
  let child: { kill?: (s?: NodeJS.Signals) => void } | undefined;
  // Ctrl-C — reap the agent container in the "container" phase (before the sidecar's network teardown).
  const deregisterContainerReap = sidecar
    ? registerCleanup({
        phase: "container",
        run: () => {
          try {
            child?.kill?.("SIGKILL");
          } catch {
            /* already gone */
          }
          if (containerName) spawnSync(runner, ["rm", "-f", containerName], { stdio: "ignore" });
        },
      })
    : undefined;
  // same web_fetch provenance wiring as execute.ts — ref created before spawn, filled after Run.
  const viaApiOn = readGateFlag(baseline, "1978029737", "coworkWebFetchViaApi");
  const promptGateOn = readGateFlag(baseline, "1978029737", "coworkWebFetchPrompt");
  const provenanceRef: { current?: WebFetchProvenance } = {};
  // ONE readline interface on process.stdin, shared by the turn reader (ttyTurns) and the gate
  // prompter (PromptDecider). Two interfaces would race for the same stdin → undefined input routing.
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const ask = (prompt: string) => new Promise<string>((resolve) => rl.question(prompt, (a) => resolve(a.trim())));
  // ONE display translator, shared by all three fidelity branches below (protocol/hostloop/container each
  // build their own `makeRenderer(renderPlan)` off this SAME plan object) — the hostloop gate lives in the
  // closure, not at each instantiation site, so wiring all three uniformly costs nothing (the closure
  // no-ops for protocol/container). `shareable: renderPlan.compact` mirrors the source resolveOutput uses
  // for `run`/`skill` (compact/--demo); chat has no such flag, hence the fixed `false` below.
  const renderPlan: RenderPlan = {
    live: true,
    progress: true,
    verbose,
    color: process.stderr.isTTY === true && !process.env.NO_COLOR,
    compact: false, // chat is an interactive REPL, not shareable-output (the path-collapse targets skill/run)
    translate: makeDisplayTranslator({
      ctx: vmPathContextFromPlan(sessionId, plan, outDir),
      effectiveFidelity: fidelity,
      shareable: false,
    }),
    // Same TTY/CI/env gate as run/skill's plan construction (cli.ts) — decided HERE at plan
    // construction, not inside makeRenderer. `shareable: false` mirrors the `makeDisplayTranslator`
    // call just above (chat has no --compact/--demo equivalent).
    linkify: shouldLinkify(process.env, process.stderr.isTTY === true, false) ? linkifyForTerminal : undefined,
  };
  const start = Date.now();
  let stopHeartbeat: (() => void) | undefined;
  try {
    if (fidelity === "protocol") {
      child = spawnProtocol(scenario, baseline, plan, outDir, { systemPromptAppend: prompts.systemPromptAppend }).child;
      const agent = new LiveAgentSession(child as any, outDir);
      const decider = Chain(new ScriptedDecider([]), new PermissionDefaultDecider("cowork"), new PromptDecider(ask));
      const renderer = makeRenderer(renderPlan);
      const run = new Run(agent, decider, [renderer], sessionId);
      stopHeartbeat = startHeartbeat(renderer, renderPlan, start);
      await run.drive(withSeedPrompt(seedPrompt, ttyTurns(rl)), {});
    } else if (fidelity === "hostloop") {
      // honor --fidelity hostloop in chat, mirroring execute.ts's branch selection.
      const hl = spawnHostLoop(scenario, baseline, plan, outDir, sessionId, {
        systemPromptAppend: prompts.systemPromptAppend,
        runToken,
        egressProxy: sidecar!.proxyUrl,
        dockerNetwork: sidecar!.network,
        provenanceRef,
      });
      child = hl.child;
      containerName = hl.containerName;
      logHostWriteNotice(
        plan.mounts.filter((mt) => mt.kind === "folder").map((mt) => ({ from: mt.hostPath, mode: mt.mode })),
        (msg) => log(msg),
      );
      const agent = new LiveAgentSession(hl.child as any, outDir);
      const decider = Chain(new ScriptedDecider([]), new PermissionDefaultDecider("cowork"), new PromptDecider(ask));
      const renderer = makeRenderer(renderPlan);
      // The path-containment gate's runtime tripwire: a gated tool call that completed successfully
      // with no evidence the gate ran on it means real filesystem access is unverified for this
      // session — abort rather than continue silently. Mirrors execute.ts's post-run check, but as a
      // live per-event observer (chat has no events.jsonl post-run scan pass).
      const seenGatedToolUse = new Map<string, string>(); // toolUseId -> tool name, awaiting its tool_result
      const CHAT_PATH_GATE_TOOLS = new Set<string>([...PATH_GATE_TOOL_NAMES, "MultiEdit"]);
      const tripwireHook: RunHooks = {
        onEvent(ev: AgentEvent) {
          if (ev.type === "tool_use" && !ev.synthetic && ev.toolUseId && CHAT_PATH_GATE_TOOLS.has(ev.name)) {
            seenGatedToolUse.set(ev.toolUseId, ev.name);
          }
          if (ev.type === "tool_result" && ev.toolUseId && seenGatedToolUse.has(ev.toolUseId)) {
            const name = seenGatedToolUse.get(ev.toolUseId)!;
            seenGatedToolUse.delete(ev.toolUseId);
            if (!ev.isError && !hl.pathGateFired.has(ev.toolUseId)) {
              log(
                `::warning:: [hostloop] path-containment gate did not fire for ${name} (${ev.toolUseId}) — ` +
                  `real filesystem access is UNVERIFIED for this session. Aborting.\n`,
              );
              throw new Error(`[hostloop] path gate did not fire for ${name} — aborting as unsafe/unverified.`);
            }
          }
        },
      };
      const run = new Run(agent, decider, [renderer, tripwireHook], sessionId);
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
        sdkMcp: hl.sdkMcp,
        hooks: hl.hooks,
      });
    } else {
      const ct = spawnContainer(scenario, baseline, plan, outDir, sessionId, {
        systemPromptAppend: prompts.systemPromptAppend,
        egressProxy: sidecar!.proxyUrl,
        dockerNetwork: sidecar!.network,
        runToken,
      });
      child = ct.child;
      containerName = ct.containerName; // so Ctrl-C / finally reap the agent container by name
      const agent = new LiveAgentSession(child as any, outDir);
      const decider = Chain(new ScriptedDecider([]), new PermissionDefaultDecider("cowork"), new PromptDecider(ask));
      const renderer = makeRenderer(renderPlan);
      const run = new Run(agent, decider, [renderer], sessionId);
      stopHeartbeat = startHeartbeat(renderer, renderPlan, start);
      await run.drive(withSeedPrompt(seedPrompt, ttyTurns(rl)), {});
    }
  } finally {
    stopHeartbeat?.();
    deregisterContainerReap?.(); // normal path owns the reap below
    // Reap the agent container first (mirrors execute.ts hardening).
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
    if (t === "/help") {
      log("Commands: /exit  /quit  /help\n");
      continue;
    }
    if (!t) continue;
    yield t;
  }
}

/** `chat --raw` — native interactive cowork mode (no -p / stream-json), stdio inherited.
 *  Egress sandbox NOT applied. `--fidelity` is ignored. */
function chatRaw(folder: string, model?: string) {
  const baseline = loadBaseline("latest");
  const agent = resolveAgentBinary(baseline);
  const image = process.env.COWORK_AGENT_IMAGE ?? "cowork-agent-base:2";
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
    // raw mode runs on `latest` (>=1.14271.0), so use the real Cowork local-plugin path (no `cache/`).
    `${folder}:/sessions/local/mnt/.local-plugins/marketplaces/local-desktop-app-uploads/skill:ro`,
    "-w",
    "/sessions/local",
    "-e",
    "HOME=/tmp",
    "-e",
    "CLAUDE_CODE_IS_COWORK=1",
    // pass the token by NAME only — docker inherits the value from its env (this process, via
    // stdio:"inherit"), so it never appears in the `docker run` argv (ps/proc).
    ...(process.env.CLAUDE_CODE_OAUTH_TOKEN ? ["-e", "CLAUDE_CODE_OAUTH_TOKEN"] : []),
    image,
    "claude",
    "--plugin-dir",
    "/sessions/local/mnt/.local-plugins/marketplaces/local-desktop-app-uploads/skill",
    ...(model ? ["--model", model] : []),
  ];
  const child = spawn(runner, dockerArgs, { stdio: "inherit" });
  // On signal termination (OOM, daemon restart, external kill) `code` is null; map the signal to the
  // standard 128+signo so a signal-killed container doesn't report success to a wrapping --raw caller.
  child.on("exit", (code, signal) => process.exit(code != null ? code : signal ? 128 + (os.constants.signals[signal] ?? 1) : 1));
  child.on("error", (e) => {
    log(`--raw failed (native interactive mode may be unavailable): ${e}\n`);
    process.exit(2);
  });
}
