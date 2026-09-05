import readline from "node:readline";
import { unpinnedModelWarning } from "./model-provenance.js";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { mkdirSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { writeTextAtomic, warn } from "../io.js";
import type { InfraErrorSource } from "../types.js";
import { loadBaseline, resolveAgentBinary } from "../baseline.js";
import { loadSession, buildLaunchPlan, userVisibleRootsFromPlan, readonlyFolderRootsFromPlan } from "../session.js";
import { spawnContainer } from "../runtime/container.js";
import { spawnHostLoop, WORKSPACE_TOOL_ALIASES } from "../runtime/hostloop.js";
import { spawnProtocol } from "../runtime/protocol.js";
import { renderPrompts } from "../prompt.js";
import { makeDisplayTranslator, vmPathContextFromPlan, linkifyForTerminal, shouldLinkify } from "./display-translate.js";
import { writeVmPathContextFile } from "./vm-path-ctx-file.js";
import { startEgressSidecar, registerCleanup } from "../egress/sidecar.js";
import { Scenario } from "../types.js";
import { LiveAgentSession, type AgentEvent, type SdkMcp, type HookBundle } from "../agent/session.js";
import { Run, type RunHooks } from "./run.js";
import { ResourceSampler, makeSampleOnce, resolveIntervalMs } from "../runtime/resource-sampler.js";
import { makeRenderer, startHeartbeat, type RenderPlan } from "./renderer.js";
import { runsWriteRoot } from "./trace-view.js";
import { buildChatResult } from "./chat-result.js";
import { writeTrace, scrubRawRunLogs, beginTurn } from "./execute.js";
import { turnWriteDir } from "./turn-layout.js";
import { appendIndexRow, indexRowFromResult } from "./run-index.js";
import { scrub, collectSecrets } from "../secrets.js";
import { Chain, ScriptedDecider, PermissionDefaultDecider, PromptDecider } from "../decide/decider.js";
import { readGateFlag, readGateNumber, resolveSkillDiscoveryGates } from "../loop-decision.js";
import { makeWebFetchDedupCache } from "../hostloop/webfetch-dedup.js";
import type { WebFetchProvenance } from "../hostloop/workspace-handler.js";
import { checkHostHookConsent, logHostHookNotice } from "./hook-events.js";
import { checkHostLoopWriteConsent, logHostWriteNotice } from "../hostloop/safety.js";
import { PATH_GATE_TOOL_NAMES } from "../hostloop/pretooluse-path-hook.js";
import { makeHostLoopCanUseToolGate } from "../hostloop/canusetool-gate.js";
import { resolveAgentImage, resolveContainerRuntime } from "../runtime/agent-image.js";

const log = (s: string) => process.stderr.write(s);

/** The chat lane's drive() options. Chat previously passed NO subagentAppend on any branch — a
 *  delivery bug (production sends the per-loop sub-agent append on every Cowork session). Pure and
 *  exported so the delivery contract is unit-testable without spawning a session.
 *
 *  `wiring` is tier-discriminated because the two sandboxed tiers need DIFFERENT subsets:
 *  - `hostloop` carries the workspace sdkMcp bundle + hooks, and `toolAliases` rides along with it
 *    (host-loop-only — see src/runtime/hostloop.ts's WORKSPACE_TOOL_ALIASES doc comment).
 *  - `container` carries sdkMcp ONLY (no hooks, no aliases). Forwarding it is load-bearing, not
 *    cosmetic: spawnContainer puts `mcp__cowork__present_files` + the 5 mcp__skills__/mcp__plugins__
 *    discovery tools on `--tools`/`--allowedTools`, so dropping the bundle would advertise tools whose
 *    servers were never announced — they would fail on call, `context.mcpServers` would omit
 *    skills/plugins, and the `skills.suggest_enabled` knob would silently no-op on this lane.
 *  - `protocol` (L0) carries none of it, but must say so EXPLICITLY.
 *
 *  `wiring` is REQUIRED, and protocol has its own variant, precisely so that forgetting to pass a
 *  tier's bundle is a COMPILE error rather than a silent no-op. That is not hypothetical: the container
 *  branch previously called `chatDriveOpts(prompts)` and silently dropped its sdkMcp, and reverting that
 *  one call site leaves the entire unit suite green (a call-site bug cannot be caught by testing this
 *  pure function, which was never wrong). The type is the guard. */
export function chatDriveOpts(
  prompts: { subagentAppend?: string },
  wiring: { tier: "hostloop"; sdkMcp: SdkMcp; hooks: HookBundle } | { tier: "container"; sdkMcp: SdkMcp } | { tier: "protocol" },
): { subagentAppend?: string; sdkMcp?: SdkMcp; hooks?: HookBundle; toolAliases?: Record<string, string> } {
  return {
    subagentAppend: prompts.subagentAppend,
    ...(wiring.tier === "hostloop"
      ? { sdkMcp: wiring.sdkMcp, hooks: wiring.hooks, toolAliases: WORKSPACE_TOOL_ALIASES }
      : wiring.tier === "container"
        ? { sdkMcp: wiring.sdkMcp }
        : {}),
  };
}

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
  { flag: "--allow-host-hooks", kind: "bool", usage: "[--allow-host-hooks]" },
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
  let allowHostHooks = false;
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
    } else if (a === "--allow-host-hooks") {
      allowHostHooks = true;
      seenFlags.add("--allow-host-hooks");
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
  // protocol passes --plugin-dir, so a staged plugin's hooks run as native host processes. `chat` has no
  // YAML to carry consent, so --allow-host-hooks is the only spelling here (mirrors --allow-host-writes).
  if (fidelity === "protocol") {
    const hookRoots = [folder, ...localPlugins];
    checkHostHookConsent(hookRoots, allowHostHooks);
    logHostHookNotice(hookRoots, warn);
  }
  const baseline = loadBaseline("latest");
  const sessionId = `local_${process.hrtime.bigint().toString(36)}`;
  const outDir = join(runsWriteRoot(), "chat", sessionId);
  mkdirSync(outDir, { recursive: true });
  // Turn-start bookkeeping, mirroring execute.ts's ordering: BEFORE the resource sampler opens
  // resources.jsonl and before the agent session starts (`ResourceSampler.tick()` writeFileSync's into
  // `turns/<N>/` but never mkdirs, so without this every sample throws ENOENT into a swallowed warning —
  // the exact dead-telemetry bug turn-layout-e2e.test.ts exists to catch). Chat never resumes (fresh
  // sessionId + a freshly mkdir'd outDir on every invocation — see buildLaunchPlan's `false` above), so
  // this is always turn 1; going through `beginTurn` rather than a hardcoded `turnWriteDir(outDir, 1)`
  // keeps ONE turn-start ritual instead of two.
  const turnNumber = beginTurn(outDir);
  const plan = buildLaunchPlan(session, baseline, outDir, fidelity, false); // chat has no resume concept
  // Chat warns on the same condition but in its own words: an interactive session makes no
  // reproducibility claim, so the consequence differs even though the missing input is identical.
  if (plan.model === undefined) warn(unpinnedModelWarning("chat") + "\n");
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
            hostOutputsDir: join(hostMnt, "outputs"),
            // The generated sub-agent folder manifest (Desktop >=1.46388.3). Canonical paths, and the
            // soft-missing drops carried through as unreachable — production lists a mount-failed
            // folder rather than omitting it.
            subagentFolders: [
              ...plan.mounts
                .filter((m) => m.kind === "folder")
                .map((m) => ({ hostPath: m.canonicalHostPath ?? m.hostPath, mountPath: m.mountPath, reachable: true })),
              ...(plan.hostOnlyFolders ?? []).map((m) => ({
                hostPath: m.canonicalHostPath ?? m.hostPath,
                mountPath: m.mountPath,
                reachable: false,
              })),
            ],
            hostSkillsDir: skillsStaged ? skillsDir : undefined,
          };
        })()
      : { effectiveFidelity: fidelity };
  const prompts = renderPrompts(baseline, session, sessionId, plan.mounts.find((m) => m.kind === "folder")?.mountPath, hostLoopOpts);

  log(`cowork chat [${fidelity}] — run: ${sessionId}\n`);
  // Startup summary: show uploads and project folders so the developer knows what the agent sees.
  for (const m of plan.mounts) {
    if (m.kind === "upload") log(`  upload: ${m.hostPath} → mnt/${m.mountPath}\n`);
    else if (m.kind === "folder") log(`  folder: ${m.hostPath} → mnt/${m.mountPath}\n`);
  }
  log(`type your message (/help for commands)\n`);

  const runner = resolveContainerRuntime();
  let containerName: string | undefined;
  let child: { kill?: (s?: NodeJS.Signals) => void } | undefined;
  let record: import("./run.js").RunRecord | undefined;
  // hostloop's live sidecar-crash sink (see spawnHostLoop/watchHostLoopSidecar) — folded into
  // record.infraErrors once the session ends, and marked BEFORE this session's own teardown removes
  // the sidecar container so that forced exit isn't misreported as a mid-run infra failure.
  let hostloopInfraErrors: { source: InfraErrorSource; message: string }[] | undefined;
  let hostloopMarkTearingDown: (() => void) | undefined;
  // Sampled for the container/hostloop branches only (mirrors execute.ts) — protocol runs the host
  // binary directly with no container/process id to probe, so it legitimately never gets one.
  let resourceSampler: ResourceSampler | undefined;
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
          hostloopMarkTearingDown?.();
          if (containerName) spawnSync(runner, ["rm", "-f", containerName], { stdio: "ignore" });
        },
      })
    : undefined;
  // same web_fetch provenance wiring as execute.ts — ref created before spawn, filled after Run.
  const viaApiOn = readGateFlag(baseline, "1978029737", "coworkWebFetchViaApi", false);
  const promptGateOn = readGateFlag(baseline, "1978029737", "coworkWebFetchPrompt", false);
  const provenanceRef: { current?: WebFetchProvenance } = {};
  // coworkWebFetchDedup — per-session cache; kept for the chat REPL's lifetime (= one Cowork session).
  const dedup =
    viaApiOn && readGateFlag(baseline, "1978029737", "coworkWebFetchDedup", false)
      ? makeWebFetchDedupCache({
          ttlMs: readGateNumber(baseline, "1978029737", "coworkWebFetchDedupTtlMs") ?? 900000,
          maxEntries: readGateNumber(baseline, "1978029737", "coworkWebFetchDedupMaxEntries") ?? 100,
        })
      : undefined;
  // Skills/plugins discovery gates (A2) — resolved through the SAME shared helper execute.ts uses, so the
  // two lanes cannot drift. Both spawnHostLoop and spawnContainer take them via `opts` (neither receives
  // `session`).
  const { suggestSkillsEnabled, proactiveSkillSuggestEnabled } = resolveSkillDiscoveryGates(baseline, session.skills);
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
      record = await run.drive(withSeedPrompt(seedPrompt, ttyTurns(rl)), chatDriveOpts(prompts, { tier: "protocol" }));
    } else if (fidelity === "hostloop") {
      // honor --fidelity hostloop in chat, mirroring execute.ts's branch selection.
      const hl = spawnHostLoop(scenario, baseline, plan, outDir, sessionId, {
        systemPromptAppend: prompts.systemPromptAppend,
        runToken,
        egressProxy: sidecar!.proxyUrl,
        dockerNetwork: sidecar!.network,
        provenanceRef,
        webFetchViaApi: viaApiOn,
        dedup,
        suggestSkillsEnabled,
        proactiveSkillSuggestEnabled,
      });
      child = hl.child;
      containerName = hl.containerName;
      hostloopInfraErrors = hl.infraErrors;
      hostloopMarkTearingDown = hl.markTearingDown;
      // Same ResourceSampler lifecycle execute.ts uses for hostloop: sample the native agent process by
      // pid on an interval so buildChatResult's foldResources() call (chat-result.ts) has something to
      // fold — previously no sampler was ever started here, so a hostloop chat's resources.jsonl never
      // existed despite chat-result.ts's doc-comment claiming resource parity with the run lane.
      resourceSampler = new ResourceSampler(
        outDir,
        "hostloop",
        makeSampleOnce({ tier: "hostloop", runner, pid: (hl.child as { pid?: number } | undefined)?.pid }),
        resolveIntervalMs(),
        turnNumber,
      );
      resourceSampler.start();
      logHostWriteNotice(
        plan.mounts.filter((mt) => mt.kind === "folder").map((mt) => ({ from: mt.hostPath, mode: mt.mode })),
        (msg) => log(msg),
      );
      const agent = new LiveAgentSession(hl.child as any, outDir);
      // Production interposes the canUseTool path gate BEFORE the user-facing callback (xe ?? Qt ?? Se);
      // the harness analog is FIRST in the Chain — Chain stops at the first non-abstain, so any later
      // placement would let the scripted/default/prompt deciders preempt a production-shaped deny.
      const decider = Chain(
        makeHostLoopCanUseToolGate(),
        new ScriptedDecider([]),
        new PermissionDefaultDecider("cowork"),
        new PromptDecider(ask),
      );
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
      run.setSessionRoot(hl.sessionRoot); // HOST tree — without it cwd (mnt/outputs) stands in for the root
      stopHeartbeat = startHeartbeat(renderer, renderPlan, start);
      if (viaApiOn) {
        run.enableWebFetchGate();
        provenanceRef.current = {
          isAllowed: (u) => run.provenanceHas(u),
          markAllowed: (u) => run.provenanceAdd(u),
          requestApproval: undefined, // gated at can_use_tool — the handler must not self-approve (was the 2nd record)
          promptGateOn,
          permissiveMode: plan.permissionMode === "bypassPermissions",
        };
      }
      record = await run.drive(
        withSeedPrompt(seedPrompt, ttyTurns(rl)),
        chatDriveOpts(prompts, { tier: "hostloop", sdkMcp: hl.sdkMcp, hooks: hl.hooks }),
      );
    } else {
      const ct = spawnContainer(scenario, baseline, plan, outDir, sessionId, {
        systemPromptAppend: prompts.systemPromptAppend,
        egressProxy: sidecar!.proxyUrl,
        dockerNetwork: sidecar!.network,
        runToken,
        suggestSkillsEnabled,
        proactiveSkillSuggestEnabled,
      });
      child = ct.child;
      containerName = ct.containerName; // so Ctrl-C / finally reap the agent container by name
      // Same ResourceSampler lifecycle execute.ts uses for container: sample by container name on an
      // interval so buildChatResult's foldResources() call (chat-result.ts) has something to fold —
      // previously no sampler was ever started here (see the hostloop branch above for the same fix).
      resourceSampler = new ResourceSampler(
        outDir,
        "container",
        makeSampleOnce({ tier: "container", runner, containerName }),
        resolveIntervalMs(),
        turnNumber,
      );
      resourceSampler.start();
      const agent = new LiveAgentSession(child as any, outDir);
      const decider = Chain(new ScriptedDecider([]), new PermissionDefaultDecider("cowork"), new PromptDecider(ask));
      const renderer = makeRenderer(renderPlan);
      const run = new Run(agent, decider, [renderer], sessionId);
      run.setSessionRoot(ct.sessionRoot); // VM path — same space the agent reports (see execute.ts)
      stopHeartbeat = startHeartbeat(renderer, renderPlan, start);
      record = await run.drive(withSeedPrompt(seedPrompt, ttyTurns(rl)), chatDriveOpts(prompts, { tier: "container", sdkMcp: ct.sdkMcp }));
    }
  } finally {
    stopHeartbeat?.();
    // Stop sampling FIRST — before the container/process teardown below — so a final in-flight probe
    // can't race (and fail against) a container that's already being removed (mirrors execute.ts). The
    // `await` (stop() is async) also ensures a run shorter than one interval still has its immediate
    // first sample land in resources.jsonl before buildChatResult's foldResources() reads it, below.
    await resourceSampler?.stop();
    deregisterContainerReap?.(); // normal path owns the reap below
    // Reap the agent container first (mirrors execute.ts hardening).
    try {
      child?.kill?.("SIGKILL");
    } catch {
      /* already gone */
    }
    // mark BEFORE the forced removal below — this session's own `docker rm -f` makes the hostloop
    // sidecar exit too, and that intentional-shutdown exit must not be misreported as a mid-run infra
    // failure (see watchHostLoopSidecar's doc comment).
    hostloopMarkTearingDown?.();
    if (containerName) spawnSync(runner, ["rm", "-f", containerName], { stdio: "ignore" });
    sidecar?.teardown();
    rl.close(); // the one shared stdin interface — closed once, here
    // LAST in the teardown, unconditional on `record`: a chat that crashes before its first turn
    // still streamed raw events/control-out/stderr to disk, and the result-writing block below is
    // `if (record)`-gated so it can't be the scrub's home. (Mirrors executeScenario's outermost
    // finally; being after the kill/reap minimizes the stderr flush window.)
    scrubRawRunLogs(outDir, collectSecrets());
  }
  log(`\nchat ended (transcript under ${outDir})\n`);
  // A session that crashed before the agent produced its first turn has no RunRecord — nothing to
  // write. Otherwise write the same result.json/trace/index-row shape `run` and `skill` write, so a
  // chat session shows up in `stats`/`trace`/`scaffold` — previously chat discarded `record` entirely.
  if (record) {
    // Fold the hostloop VM sidecar's own crash into infraErrors the SAME way execute.ts does — a live
    // drive never re-reads the out-of-band `infra_error` row spawnHostLoop appends to events.jsonl (only
    // cassette replay does), so this fold is the only path a sidecar crash reaches result.json through.
    if (hostloopInfraErrors?.length) record.infraErrors.push(...hostloopInfraErrors);
    // workRoot is tier-conditional (mirrors execute.ts): protocol runs the host binary directly with
    // no container sandbox, so it has no `work/session/mnt` — only container/hostloop do.
    const workRoot = fidelity === "protocol" ? join(resolve(outDir), "work") : join(resolve(outDir), "work", "session", "mnt");
    const chatResult = buildChatResult(record, {
      scenario: scenario.name || "(chat)",
      prompt: seedPrompt ?? "",
      fidelity,
      baseline: baseline.appVersion,
      pinnedModel: session.model,
      outDir,
      workRoot,
      userVisibleRoots: userVisibleRootsFromPlan(plan),
      readonlyFolderRoots: readonlyFolderRootsFromPlan(plan),
      egress: sidecar ? sidecar.collect().entries : [],
      durationMs: Date.now() - start,
      turn: turnNumber,
    });
    const secrets = collectSecrets();
    // THROUGH THE SEAM, not a chat-only root file: chat now writes its one turn the same way run/skill
    // write theirs (see turnWriteDir/beginTurn above), so `stats`/`trace`/`scaffold`/verify-run address it
    // via turnArtifactPath like any other run dir, instead of a root shape only chat produced.
    const tDir = turnWriteDir(outDir, turnNumber);
    // Atomic: a crash mid-write must never leave a torn result.json — see writeTextAtomic's doc comment.
    writeTextAtomic(join(tDir, "result.json"), scrub(JSON.stringify(chatResult, null, 2), secrets));
    appendIndexRow(runsWriteRoot(), indexRowFromResult(chatResult, { command: "chat", partial: false }));
    writeTrace(tDir, record, chatResult.egress, secrets, chatResult.durationMs);
  }
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
      // Read the interface's REAL closed state, not just the local `closed` flag: with a non-interactive
      // stdin (a pipe or /dev/null) the interface can emit `close` DURING the seed turn — before this
      // generator's `once("close")` listener above is even registered — so the flag can miss it. Calling
      // rl.question() on an already-closed interface throws ERR_USE_AFTER_CLOSE; treat closed as EOF → null.
      if (closed || (rl as unknown as { closed?: boolean }).closed) return res(null);
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
  const image = resolveAgentImage();
  const runner = resolveContainerRuntime();
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
