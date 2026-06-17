import { warn } from "../io.js";
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, dirname, resolve, basename, isAbsolute } from "node:path";
import { parse as parseYaml } from "yaml";
import { Scenario } from "../types.js";
import type { RunResult } from "../types.js";
import { loadBaseline } from "../baseline.js";
import { loadSession, resolveSessionPaths, buildLaunchPlan } from "../session.js";
import { spawnProtocol } from "../runtime/protocol.js";
import { spawnContainer } from "../runtime/container.js";
import { spawnHostLoop } from "../runtime/hostloop.js";
import { spawnMicroVm } from "../runtime/microvm.js";
import { decideLoopFromBaseline, readGateFlag } from "../loop-decision.js";
import type { WebFetchProvenance } from "../hostloop/workspace-handler.js";
import { startEgressSidecar, type EgressSidecar } from "../egress/sidecar.js";
import { startEgressProxy, freePort } from "../egress/proxy.js";
import { evaluate, hostMatches } from "../assert.js";
import { compileUserRegex } from "../regex.js";
import { renderPrompts } from "../prompt.js";
import { LiveAgentSession, type SdkMcp } from "../agent/session.js";
import { buildDecider, ExternalDecider, LlmDecider, type Decider, type OnUnanswered, UnansweredError } from "../decide/decider.js";
import { type DecisionChannel } from "../decide/external-channel.js";
import { claudeCliComplete } from "../decide/llm-transport.js";
import { Run, type RunRecord, type RunHooks } from "./run.js";
import { runsWriteRoot } from "./trace-view.js";
import { collectSecrets, scrub } from "../secrets.js";

export interface ExecuteOptions {
  session?: ReturnType<typeof loadSession>;
  /** input policy for unscripted questions/dialogs. Default: scenario.on_unanswered ?? "fail". */
  onUnanswered?: OnUnanswered;
  /** override the whole decider (replaces scripted + parity + terminal). */
  decider?: Decider;
  /** wire an ExternalDecider TERMINAL over this channel (scripted `--answer` + parity still apply first). */
  externalChannel?: DecisionChannel;
  /** stable session handle: pins the run dir + the agent's native session id (so it can be resumed). */
  sessionId?: string;
  /** resume a prior session of this id — reuse its persisted work dir + pass the agent's `--resume`. */
  resume?: boolean;
  /** steering for the LLM decider (`on_unanswered: llm` / `--decider-llm`) — one-line test intent. */
  llmIntent?: string;
  /** mark the run non-deterministic even if no `by:"llm"` decision (e.g. a driving agent answers via `--decider-dir`). */
  nonDeterministicHint?: boolean;
  hooks?: RunHooks[];
}

/**
 * The library API (A2): run one scenario end-to-end and return a RunResult. `cli.ts` is a
 * thin wrapper over this; the pytest `cowork` lane drives it too. Owns the run boundary
 * (egress sidecar/proxy start+teardown, env mutation, post-run scan, artifact write).
 */
/** #17: turn a scenario name into a SAFE single directory segment — neutralize path separators and
 *  ".." so a YAML/filename-derived name can't escape `runs/`. Otherwise human-readable; the display
 *  name (scenario.name) is kept separate and unchanged. */
export function slugForPath(name: string): string {
  return (
    name
      .split(/[/\\]/)
      .join("-")
      .replace(/\.{2,}/g, ".")
      .replace(/^[.\-]+/, "") || "scenario"
  );
}

export async function executeScenario(scenario: Scenario, opts: ExecuteOptions = {}): Promise<RunResult> {
  // #33: mirror the CLI guard (cli.ts:488) — a library caller skipping the CLI would otherwise get
  // a confusing `cannot resume "undefined"` error deep inside the resume branch.
  if (opts.resume && !opts.sessionId) throw new Error("resume requires sessionId (--session-id was not provided)");

  const baseline = loadBaseline(scenario.baseline);
  const session = opts.session ?? loadSessionFromFile(scenario.session);

  // Session identity. Without a stable handle: a fresh ephemeral id (current behavior). WITH one
  // (--session-id / resume): a STABLE cwd id + run dir, so the agent's native sessionFile persists and
  // can be resumed. The agent's own session uses a UUID, persisted in a per-session manifest.
  // #18: reject a --session-id outside the safe charset rather than collapsing it — distinct ids like
  // "a/b" and "a-b" used to map onto the SAME persisted directory (a silent collision).
  if (opts.sessionId !== undefined && !/^[A-Za-z0-9_-]+$/.test(opts.sessionId))
    throw new Error(
      `--session-id "${opts.sessionId}" may contain only letters, digits, "_" or "-" (no path separators or other characters)`,
    );
  const stable = opts.sessionId ? `sess-${opts.sessionId}` : undefined;
  const sessionId = stable ?? `local_${process.hrtime.bigint().toString(36)}`;
  // #17: the scenario name (YAML or filename-derived) is a PATH component — slugify so a name like
  // "../x" can't place run artifacts outside runs/. The display name (scenario.name) is unchanged.
  const outDir = join(runsWriteRoot(), slugForPath(scenario.name), sessionId);
  // #25/#26: a non-resume run reusing a stable --session-id must be FRESH — the prior run's staged tree
  // (uploads, plugins, mnt/.claude agent state, outputs) would otherwise leak in via cpSync's merge
  // semantics, and a new agentSessionId would be written over stale native session files. Clear it
  // first. (--resume deliberately reuses the tree.)
  if (opts.sessionId && !opts.resume && existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  let agentSessionId: string | undefined;
  if (opts.sessionId || opts.resume) {
    const manifestPath = join(outDir, "session.json");
    if (opts.resume) {
      if (!existsSync(manifestPath))
        throw new Error(`cannot resume "${opts.sessionId}": no prior session at ${outDir} (run it once with --session-id first)`);
      // #23: validate the manifest rather than silently degrading to a fresh session on a corrupt
      // or older-format file — a missing agentSessionId on the resume path is a hard error.
      agentSessionId = readSessionManifest(manifestPath, opts.sessionId ?? "");
    } else {
      agentSessionId = randomUUID(); // fresh pinned session
      writeFileSync(
        manifestPath,
        JSON.stringify({ sessionId: opts.sessionId, agentSessionId, createdAt: new Date().toISOString() }, null, 2),
      );
    }
  }

  const plan = buildLaunchPlan(session, baseline, outDir);
  if (agentSessionId) {
    plan.agentSessionId = agentSessionId;
    plan.resume = !!opts.resume;
  }

  const startedAt = Date.now();
  const boundaryDeps = scenario.assert.some((a) => a.egress_denied || a.egress_allowed) || scenario.expect_denied.length > 0;
  if (scenario.fidelity === "protocol" && boundaryDeps) {
    throw new BoundaryError(
      `scenario "${scenario.name}" asserts boundary behavior (egress/expect_denied) but fidelity is "protocol" (no sandbox). ` +
        `Use a sandboxed fidelity (container, microvm, or hostloop) so the limitation is actually enforced — otherwise the result is a false pass.`,
    );
  }

  const effectiveFidelity =
    scenario.fidelity === "cowork" ? (decideLoopFromBaseline(baseline) === "host" ? "hostloop" : "container") : scenario.fidelity;
  if (scenario.fidelity === "cowork") process.stderr.write(`[loop] cowork → ${effectiveFidelity} (per gate 1143815894)\n`);

  const onUnanswered: OnUnanswered = scenario.on_unanswered ?? opts.onUnanswered ?? "fail";
  process.stderr.write(
    opts.externalChannel
      ? `[input] unanswered questions → live decider channel\n`
      : `[input] unanswered questions → ${onUnanswered}${scenario.on_unanswered ? " (scenario)" : opts.onUnanswered ? " (flag)" : " (default)"}\n`,
  );

  // Secrets are needed BEFORE the decider is built — the external channel emits live, ahead of the
  // post-run file scrub (Opus C1). Same set is reused for the file scrub at the end.
  const secrets = collectSecrets();
  // Dialog auto-cancel: faithful 6s by default; relaxed (∞) under the external decider since the
  // caller is authoritative; `COWORK_HARNESS_DIALOG_TIMEOUT_MS` overrides either way (Opus M1).
  // #45: parse the dialog timeout env var. The special values "inf", "infinite", and "-1" mean Infinity
  // (no timeout), so fail/first policies can also opt out of the 6s auto-cancel. A positive number
  // overrides the policy-based default. 0 or absent → fall through to the policy default below.
  const envDialogMsRaw = process.env.COWORK_HARNESS_DIALOG_TIMEOUT_MS ?? "";
  const envDialogMs = parseDialogTimeout(envDialogMsRaw);
  // Relax the 6s dialog auto-cancel under any deliberate, authoritative terminal: an external channel, the
  // LLM decider (a `claude -p` call would lose the 6s race), or `prompt` (a human can't answer in 6s — the
  // faithful auto-cancel would make PromptDecider's dialog branch unreachable). fail/first keep 6s. (Opus M2)
  const dialogTimeoutMs =
    envDialogMs !== undefined
      ? envDialogMs
      : opts.externalChannel || onUnanswered === "llm" || onUnanswered === "prompt"
        ? Infinity
        : undefined;

  // Docker resources (sidecar networks/proxy + the host-loop container) are EPHEMERAL per run — name
  // them by a unique per-invocation token, NOT the (now-stable) sessionId, so a `--resume` after a
  // failed run can't collide with the prior run's leftovers (F1). The persistent state is the work dir.
  const runToken = `r${process.hrtime.bigint().toString(36)}`;
  const runner = process.env.COWORK_CONTAINER_RUNTIME ?? "docker";

  const containerLike = effectiveFidelity === "container" || effectiveFidelity === "hostloop";
  let egress: RunResult["egress"] = [];
  let sidecar: EgressSidecar | undefined;
  let hostProxy: ReturnType<typeof startEgressProxy> | undefined;
  let microvmProxyPort: number | undefined;
  if (containerLike) {
    // #43: thread proxy/network EXPLICITLY into spawn opts — no process.env mutation so
    // concurrent executeScenario calls don't stomp each other's values.
    sidecar = startEgressSidecar(plan.egressAllow, outDir, runToken);
  } else if (effectiveFidelity === "microvm") {
    // allocate a free host port per run unless explicitly pinned, so concurrent microVM runs don't
    // collide on the fixed 8899. The SAME port is threaded into spawnMicroVm below, so the guest firewall
    // rule and HTTP(S)_PROXY point at the exact host bind.
    microvmProxyPort = process.env.COWORK_VM_PROXY_PORT ? Number(process.env.COWORK_VM_PROXY_PORT) : await freePort();
    hostProxy = startEgressProxy({
      allow: plan.egressAllow,
      port: microvmProxyPort,
      logPath: join(outDir, "egress.log"),
      onDecision: (host, decision) => egress.push({ host, decision }),
    });
    await hostProxy.ready; // don't spawn the agent until the proxy is accepting (or fail loud on a bind error)
  }

  const prompts = renderPrompts(baseline, session, sessionId);
  let record: RunRecord;
  let child: { kill?: (s?: NodeJS.Signals) => void } | undefined; // hoisted so the finally can reap a crashed/orphaned container (F1)
  let containerName: string | undefined;
  let hostEgress: { host: string; decision: "allow" | "deny" }[] | undefined; // #31: host-routed web_fetch egress
  // #30: web_fetch provenance is gate-driven (coworkWebFetchViaApi) and host-loop only. The ref is
  // created HERE (before spawnHostLoop builds the handler) and filled with a Run-backed bundle after
  // the Run exists — the handler reads ref.current at call time (strictly after the stream starts).
  const viaApiOn = readGateFlag(baseline, "1978029737", "coworkWebFetchViaApi");
  const promptGateOn = readGateFlag(baseline, "1978029737", "coworkWebFetchPrompt");
  const provenanceRef: { current?: WebFetchProvenance } = {};
  try {
    let sdkMcp: SdkMcp | undefined;
    if (effectiveFidelity === "hostloop") {
      const hl = spawnHostLoop(scenario, baseline, plan, outDir, sessionId, {
        systemPromptAppend: prompts.systemPromptAppend,
        runToken,
        egressProxy: sidecar?.proxyUrl,
        dockerNetwork: sidecar?.network,
        provenanceRef,
      });
      child = hl.child;
      sdkMcp = hl.sdkMcp;
      containerName = hl.containerName;
      hostEgress = hl.hostEgress;
    } else if (effectiveFidelity === "container") {
      child = spawnContainer(scenario, baseline, plan, outDir, sessionId, {
        systemPromptAppend: prompts.systemPromptAppend,
        egressProxy: sidecar?.proxyUrl,
        dockerNetwork: sidecar?.network,
      });
    } else if (effectiveFidelity === "microvm") {
      child = spawnMicroVm(scenario, baseline, plan, outDir, sessionId, {
        systemPromptAppend: prompts.systemPromptAppend,
        proxyPort: microvmProxyPort,
      });
    } else {
      child = spawnProtocol(scenario, baseline, plan, outDir);
    }

    const sessionT = new LiveAgentSession(child as any, outDir);
    // Terminal decider: an explicit external channel, else the LLM decider when `agent` is selected.
    const llmTerminal = onUnanswered === "llm" ? new LlmDecider(claudeCliComplete, opts.llmIntent) : undefined;
    const externalTerminal = opts.externalChannel ? new ExternalDecider(opts.externalChannel, secrets) : llmTerminal;
    const decider =
      opts.decider ?? buildDecider({ rules: scenario.answers, parity: plan.permissionParity, onUnanswered, external: externalTerminal });
    const run = new Run(sessionT, decider, opts.hooks ?? [], sessionId, dialogTimeoutMs ?? undefined);
    run.seedApprovedDomains(session.web_fetch.approved_domains); // test convenience: pre-approved web_fetch hosts
    // #30: fill the provenance bundle (backed by Run's tracker + recorded approval) BEFORE drive().
    // Host-loop only, and only when the web_fetch-via-API gate is on; otherwise the handler stays
    // allowlist-only (ref.current undefined). Run seeds the set from turns + tool_results.
    if (effectiveFidelity === "hostloop" && viaApiOn) {
      provenanceRef.current = {
        isAllowed: (u) => run.provenanceHas(u),
        markAllowed: (u) => run.provenanceAdd(u),
        requestApproval: (d, u) => run.requestWebFetchApproval(d, u),
        promptGateOn,
        permissiveMode: plan.permissionMode === "bypassPermissions",
      };
    }
    record = await run.drive(scenario.prompt, {
      systemPromptAppend: prompts.systemPromptAppend,
      subagentAppend: prompts.subagentAppend,
      sdkMcp,
    });
  } finally {
    // Reap the agent container FIRST (before the sidecar networks), so a crashed/unanswered run can't
    // orphan a running container holding the network (F1). On the success path the child has already
    // exited (--rm), so these are no-ops.
    try {
      child?.kill?.("SIGKILL");
    } catch {
      /* already gone */
    }
    if (containerName) spawnSync(runner, ["rm", "-f", containerName], { stdio: "ignore" });
    if (sidecar) {
      egress = sidecar.collect();
      sidecar.teardown();
    }
    // #31: merge host-routed web_fetch decisions (host-loop) so they're visible to egress assertions.
    if (hostEgress?.length) egress = [...egress, ...hostEgress];
    hostProxy?.close();
  }

  // Part 4: snapshot the gate rendezvous wire shapes (req/resp/.done) into the run dir BEFORE the caller
  // closes (and wipes) the channel — the forensic evidence you want after a gate bug survives --keep.
  opts.externalChannel?.snapshot?.(join(outDir, "gates"));

  const scan = scanEvents(join(outDir, "events.jsonl"));
  const workRoot = effectiveFidelity === "protocol" ? join(outDir, "work") : join(outDir, "work", "session", "mnt");

  const assertions = evaluate(scenario.assert, {
    transcript: record.transcript,
    toolsCalled: record.toolsCalled,
    subagentTools: record.subagentTools,
    egress,
    result: record.result,
    workRoot,
    userVisiblePrefixes: ["outputs", ".projects"],
    outputsDeletes: scan.outputsDeletes,
    questions: record.questions,
    hostPathLeaked: scan.hostPathLeaked,
    selfHealRan: scan.selfHealRan,
    subagents: record.subagents,
    gateDeliveries: record.gateDeliveries,
  });

  if (scenario.fidelity === "protocol" && (record.toolsCalled.has("WebFetch") || record.toolsCalled.has("WebSearch"))) {
    warn(`::warning:: ${scenario.name}: a network tool ran at L0 (protocol) — egress is NOT enforced here.\n`);
  }

  for (const host of scenario.expect_denied) {
    assertions.push({
      assertion: { egress_denied: host },
      pass: egress.some((e) => hostMatches(e.host, host) && e.decision === "deny"),
      message: `expected ${host} to be denied`,
    });
  }

  const result: RunResult = {
    scenario: scenario.name,
    prompt: scenario.prompt, // persisted for `scaffold --from-run`
    fidelity: scenario.fidelity,
    baseline: baseline.appVersion,
    result: record.result,
    decisions: record.decisions.map((d) => ({
      kind: d.kind,
      name: d.name,
      decision: d.decision,
      by: d.by,
      detail: d.detail,
      rationale: d.rationale,
    })),
    toolCounts: record.toolCounts,
    gateDeliveries: record.gateDeliveries,
    egress,
    assertions,
    subagents: record.subagents,
    unanswered: record.unanswered,
    usage: record.usage,
    cost: record.cost,
    durationMs: Date.now() - startedAt,
    outDir,
    workDir: workRoot,
    outputsDir: join(workRoot, "outputs"),
    artifacts: collectArtifacts(workRoot, ["outputs", ".projects"]), // ENV-MANIFEST: observed user-visible files
    nonDeterministic:
      // LLM-, external-, human-, or first-option-decided → not reproducible. `first` picks options[0] and
      // option order can vary run-to-run; it's already pushed to unanswered[], so include it here to agree.
      record.decisions.some((d) => d.by === "llm" || d.by === "external" || d.by === "human" || d.by === "first") ||
      !!opts.nonDeterministicHint,
    nonDeterministicTerminal: onUnanswered === "llm" || onUnanswered === "prompt" || !!opts.externalChannel,
    permissiveAutoAllow: record.permissiveAutoAllow.length ? record.permissiveAutoAllow : undefined, // #6: cowork-parity off-registry auto-allows (real Cowork blocks) — non-empty ⇒ NOT a faithful pass
    scan, // post-run scan signals (delete-in-outputs / host-path-leak / self-heal) — computeVerdict default-fails when unasserted
    effectiveFidelity, // The tier actually used — differs from fidelity when fidelity:"cowork" (#24)
  };

  // Artifacts (C3): the harness-observability log `run.jsonl` REPLACES transcript.json/decisions.jsonl.
  writeFileSync(join(outDir, "result.json"), scrub(JSON.stringify(result, null, 2), secrets));
  writeRunJsonl(outDir, scenario, effectiveFidelity, record, egress, secrets);
  writeTrace(outDir, record, egress, secrets, result.durationMs);
  scrubFileInPlace(join(outDir, "events.jsonl"), secrets);
  scrubFileInPlace(join(outDir, "control-out.jsonl"), secrets);
  return result;
}

export function parseSessionFile(path: string): unknown {
  if (path === "(inline)") return {};
  return parseYaml(readFileSync(path, "utf8"));
}

const isFileRelative = (p: string) => p !== "(inline)" && !isAbsolute(p) && !p.startsWith("~");

/**
 * Parse a scenario file and resolve its `session:` reference relative to the SCENARIO
 * file's directory (not the cwd), so a scenario+session bundle is self-contained and
 * relocatable. Use this everywhere a scenario is read from disk (`run`, `record`).
 */
export function parseScenarioFile(path: string): Scenario {
  const scenario = Scenario.parse(parseYaml(readFileSync(path, "utf8")));
  // `name` defaults to the filename (sans extension) — the file is the identity.
  if (!scenario.name) scenario.name = basename(path).replace(/\.ya?ml$/i, "");
  if (isFileRelative(scenario.session)) scenario.session = resolve(dirname(path), scenario.session);
  // Load-time regex validation: fail fast with a clear message rather than letting a malformed pattern
  // crash the run at evaluate() time. NOTE (M2): CLI-supplied rules (--answer/--answer-policy) do NOT
  // pass through here — the runtime try/catch in assert.ts and decider.ts is their safety net.
  validateScenarioRegexes(scenario, path);
  return scenario;
}

/** Validate all user-supplied regex patterns in a scenario at load time. Throws on the first bad pattern. */
function validateScenarioRegexes(scenario: Scenario, scenarioPath: string): void {
  const context = `scenario "${scenario.name ?? scenarioPath}"`;
  // `replay_protocol_fidelity` is synthesized by the replay lane only — authored in a live scenario it
  // has no check() branch and always evaluates to "empty assertion". Reject it at load (loud footgun fix).
  for (const a of scenario.assert) {
    if (a.replay_protocol_fidelity !== undefined)
      throw new Error(
        `${context}: \`replay_protocol_fidelity\` is synthesized by the replay lane and cannot be authored in a scenario — remove it (it would evaluate as "empty assertion" on a live run).`,
      );
  }
  // assert[] patterns
  for (const a of scenario.assert) {
    for (const key of ["transcript_matches", "transcript_not_matches", "question_asked", "subagent_dispatched"] as const) {
      const pattern = a[key];
      if (pattern !== undefined) {
        const c = compileUserRegex(pattern);
        if ("error" in c) throw new Error(`bad regex in ${key} in ${context}: ${c.error}`);
      }
    }
  }
  // answers[].when_question patterns (ScriptedDecider uses these)
  for (const rule of scenario.answers) {
    if (rule.when_question !== undefined) {
      const c = compileUserRegex(rule.when_question);
      if ("error" in c) throw new Error(`bad regex in when_question in ${context}: ${c.error}`);
    }
  }
}

/** Load a session from a file and resolve its internal host paths relative to the session
 * file's own directory (see {@link resolveSessionPaths}). */
function loadSessionFromFile(sessionRef: string): ReturnType<typeof loadSession> {
  const baseDir = sessionRef === "(inline)" ? process.cwd() : dirname(resolve(sessionRef));
  return resolveSessionPaths(loadSession(parseSessionFile(sessionRef)), baseDir);
}

/** C2: the harness-observability JSONL — lifecycle + decisions(by) + subagents + egress + cost. */
function writeRunJsonl(
  outDir: string,
  scenario: Scenario,
  fidelity: string,
  rec: RunRecord,
  egress: RunResult["egress"],
  secrets: string[],
) {
  const lines = [
    { t: "run", scenario: scenario.name, fidelity, runId: rec.runId, result: rec.result, cwd: rec.cwd },
    { t: "init", tools: rec.initTools.length },
    ...rec.decisions.map((d) => ({ t: "decision", ...d })),
    ...rec.subagents.map((s) => ({ t: "subagent", ...s })),
    ...rec.unanswered.map((u) => ({ t: "unanswered", ...u })),
    ...rec.gateDeliveries.map((g) => ({ t: "gate_delivery", ...g })),
    ...egress.map((e) => ({ t: "egress", ...e })),
    { t: "transcript", text: rec.transcript },
    { t: "tool_counts", counts: rec.toolCounts },
    { t: "cost", usage: rec.usage, metrics: rec.cost },
  ];
  writeFileSync(join(outDir, "run.jsonl"), scrub(lines.map((l) => JSON.stringify(l)).join("\n"), secrets));
}

/** B3: the structured run trace. */
/** ENV-MANIFEST: recursively list files under each user-visible prefix (relative path + byte size).
 *  Paths only — NO content snapshot (that is the cassette manifest, #1). Symlinks are not followed. */
export function collectArtifacts(workRoot: string, prefixes: string[]): { path: string; bytes: number }[] {
  const out: { path: string; bytes: number }[] = [];
  const walk = (abs: string, rel: string) => {
    let entries: string[];
    try {
      entries = readdirSync(abs);
    } catch {
      return; // prefix dir absent (skill wrote nothing there) — not an error
    }
    for (const name of entries.sort()) {
      const childAbs = join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = statSync(childAbs); // statSync follows symlinks; lstat would be safer but outputs are real files
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(childAbs, childRel);
      else if (st.isFile()) out.push({ path: childRel, bytes: st.size });
    }
  };
  for (const prefix of prefixes) walk(join(workRoot, prefix), prefix);
  return out;
}

function writeTrace(outDir: string, rec: RunRecord, egress: RunResult["egress"], secrets: string[], durationMs?: number) {
  const trace = {
    steps: [...rec.toolsCalled],
    toolCounts: rec.toolCounts, // O6: truthful per-tool call counts (host-routed WebSearch shows here, not usage.server_tool_use)
    questions: rec.questions,
    subagents: rec.subagents,
    gateDeliveries: rec.gateDeliveries, // Part 3: per-gate answer delivery
    egress,
    decisions: rec.decisions,
    durationMs,
    cost: rec.cost ?? rec.usage ?? null, // cost comes from api_metrics/usage (F2), not just `result`
  };
  writeFileSync(join(outDir, "trace.json"), scrub(JSON.stringify(trace, null, 2), secrets));
}

function scrubFileInPlace(path: string, secrets: string[]) {
  if (!secrets.length) return;
  try {
    const content = readFileSync(path, "utf8");
    const scrubbed = scrub(content, secrets);
    if (scrubbed !== content) writeFileSync(path, scrubbed);
  } catch {
    /* file may not exist (e.g. no control-out at protocol fidelity) */
  }
}

/**
 * #24: detect a host filesystem path leaking into agent-visible text. The original regex was
 * macOS-centric (`/Users/`, `/opt/cowork/`) and false-passed `transcript_no_host_path` on Linux CI
 * where host paths are under `/home/` or `/root/`.
 *
 * Anchoring: each host root is preceded by a boundary char `(^|[\s"'(=:])` — start-of-string or a
 * whitespace/quote/paren/equals/colon — to limit false positives (e.g. a substring like
 * `whatever/home/x` won't match, only a path-like `/home/...`). The legitimate in-VM path
 * `/sessions/<id>/mnt/...` is NOT a host root, and the in-VM HOME is `/tmp`, so `/home/`//`/root/`
 * do not normally appear there.
 *
 * The boundary also allows a `file://[authority]` prefix so file-URI leaks are caught: in
 * `file:///Users/alice` the char before `/Users/` is the path's own `/`, which is NOT in the class,
 * so the bare anchor would miss it. `file:\/\/[^\s\/]*` consumes the optional authority (empty or a
 * host like `localhost`) and lets the path root match. URL-encoded (`%2FUsers`) and backslash
 * (`file:\\host\Users`) forms ARE now covered (see the decode+normalize pass in the body); the Windows
 * `file:///C:/Users/` form is caught incidentally via the drive-letter `:` boundary.
 */
export function hostPathLeaked(text: string): boolean {
  const re = /(^|[\s"'(=:]|file:\/\/[^\s\/]*)(\/Users\/|\/opt\/cowork\/|\/home\/|\/root\/)/;
  if (re.test(text)) return true;
  // also catch URL-encoded (%2FUsers%2F) and backslash (file:\\host\Users) forms by testing a
  // decoded + backslash-normalized copy. decodeURIComponent throws on a malformed %-escape — guard it.
  let decoded = text;
  try {
    decoded = decodeURIComponent(text);
  } catch {
    /* malformed %-escape — keep the raw text */
  }
  const normalized = decoded.replace(/\\/g, "/");
  return normalized !== text && re.test(normalized);
}

const DELETE_TOKEN =
  /\b(rm|unlink|rmdir|shred|truncate)\b|\bfind\b[^\n]*-delete\b|\bos\.(remove|unlink|rmdir)\b|\bshutil\.rmtree\b|\.unlink\(/;
// `outputs` MENTIONED as a path segment (followed by `/` or a boundary) — broad, used for the conservative
// rm co-occurrence + ambiguous-mv branch. The negative lookahead avoids `outputs.txt` / `myoutputs`.
const TOUCHES_OUTPUTS = /(^|[\s"'`(/])(mnt\/)?outputs(?![\w.])/;
// `outputs` as a real path COMPONENT (preceded by start/`/`, followed by `/` or end) — used for mv direction
// so a dst like `/tmp/outputs-backup` is NOT mistaken for being inside outputs/.
const UNDER_OUTPUTS = /(^|\/)(mnt\/)?outputs(\/|$)/;
const CD_INTO_OUTPUTS = /\b(cd|pushd)\s+["']?(mnt\/)?outputs(?![\w.])/;

/** Configured safe-staging prefixes (opt-in, no default — `/tmp` is NOT assumed scratch since a skill may
 *  stage deliverables there). Set COWORK_HARNESS_SAFE_STAGING_PREFIX to a comma-separated list to enable
 *  rm-suppression for deletes provably scoped under those prefixes. */
function safePrefixes(): string[] {
  return (process.env.COWORK_HARNESS_SAFE_STAGING_PREFIX ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => (p.endsWith("/") ? p : p + "/"));
}

/** Substitute simple `NAME=VALUE` assignments into later `$NAME`/`${NAME}` uses. Conservative: skips
 *  command-substituted values (`$(...)`/backticks) so an unresolved indirect target is never treated as
 *  resolved (and therefore never "provably safe"). */
function expandSimpleVars(cmd: string): string {
  const vars = new Map<string, string>();
  const assign = /(^|[\s;&|(])([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s;&|]+)/g;
  let m: RegExpExecArray | null;
  while ((m = assign.exec(cmd))) {
    const v = m[3].replace(/^['"]|['"]$/g, "");
    if (/\$\(|`/.test(v)) continue;
    vars.set(m[2], v);
  }
  let out = cmd;
  for (const [k, v] of vars) out = out.replace(new RegExp(`\\$\\{${k}\\}|\\$${k}\\b`, "g"), v);
  return out;
}

function splitStatements(cmd: string): string[] {
  return cmd
    .split(/\n|;|&&|\|\|/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Non-flag argument tokens of a statement (lightweight word split — NOT a full shell tokenizer; a quoted
 *  path with spaces mis-splits toward MORE matches, never fewer, so it cannot cause a false negative). */
function nonFlagArgs(stmt: string): string[] {
  return stmt
    .split(/\s+/)
    .slice(1)
    .filter((t) => t && !t.startsWith("-"))
    .map((t) => t.replace(/^['"]|['"]$/g, ""));
}

/** An `mv` statement is a delete-from-outputs when it moves a file OUT of outputs (src UNDER outputs, dst
 *  NOT under outputs). Moving INTO outputs is not a delete. Ambiguous mv (`-t`/`--target-directory`, ≠2
 *  operands) → flag only if it mentions outputs (conservative — never a false negative). */
function mvDeletesOutputs(stmt: string): boolean {
  if (!/\bmv\b/.test(stmt)) return false;
  if (/(^|\s)(-t|--target-directory)\b/.test(stmt)) return TOUCHES_OUTPUTS.test(stmt);
  const ops = nonFlagArgs(stmt);
  if (ops.length !== 2) return TOUCHES_OUTPUTS.test(stmt);
  const [src, dst] = ops;
  return UNDER_OUTPUTS.test(src) && !UNDER_OUTPUTS.test(dst);
}

/**
 * A bash command deletes in outputs when (a) an `mv` moves a file OUT of outputs, or (b) an rm-family
 * delete (`rm/unlink/rmdir/shred/truncate`, `find … -delete`, python os.remove/unlink/rmdir/shutil.rmtree,
 * pathlib `.unlink()`) co-occurs with an `outputs/` reference. mv-direction is always evaluated (fixes the
 * move-INTO false positive without losing the move-OUT true positive). For the rm family the DEFAULT is
 * conservative (flag any co-occurrence — current behavior); when the operator opts in via
 * COWORK_HARNESS_SAFE_STAGING_PREFIX, a delete is suppressed only when provably scoped to a configured
 * prefix and outputs is referenced only by non-delete statements. Unresolved/command-substituted targets
 * are never "provably safe". Pure + exported so the rule is directly unit-testable. RESIDUAL GAP: a delete
 * via a script file / renamed binary / non-bash tool still evades this post-hoc scan — real enforcement is
 * the deferred FUSE/MCP sub-project.
 */
export function isOutputsDelete(cmd: string): boolean {
  const expanded = expandSimpleVars(cmd);
  for (const stmt of splitStatements(expanded)) if (mvDeletesOutputs(stmt)) return true; // mv: always-on, direction-aware
  if (!DELETE_TOKEN.test(expanded) || !TOUCHES_OUTPUTS.test(expanded)) return false; // rm-family fast path
  const prefixes = safePrefixes();
  if (prefixes.length === 0) return true; // no opt-in → flag the co-occurrence (unchanged default behavior)
  if (CD_INTO_OUTPUTS.test(expanded)) return true; // a cwd-relative delete could hit outputs
  for (const stmt of splitStatements(expanded)) {
    if (!DELETE_TOKEN.test(stmt)) continue;
    if (TOUCHES_OUTPUTS.test(stmt)) return true; // a delete statement itself names outputs
    const targets = nonFlagArgs(stmt);
    const allSafe = targets.length > 0 && targets.every((t) => prefixes.some((pre) => t.startsWith(pre)));
    if (!allSafe) return true; // unprovable (incl. unexpanded/command-subst vars) → flag
  }
  return false; // every rm delete is provably under a safe prefix; outputs ref was non-delete only
}

/** Scan a run's events.jsonl for limitation-fidelity signals (moved from cli.ts). */
export function scanEvents(file: string): { outputsDeletes: string[]; hostPathLeaked: boolean; selfHealRan: boolean } {
  const out = { outputsDeletes: [] as string[], hostPathLeaked: false, selfHealRan: false };
  let lines: string[] = [];
  try {
    lines = readFileSync(file, "utf8").trim().split("\n");
  } catch {
    return out;
  }
  const selfHealRe = /\/sessions\/[^\s"]*\/mnt\/\.local-plugins/;
  for (const l of lines) {
    let msg: any;
    try {
      msg = JSON.parse(l);
    } catch {
      continue;
    }
    // #32: host-path leaks can appear in tool_result blocks (Bash stdout/stderr) and user messages,
    // not just assistant text. Scan both assistant and user messages; keep the Bash delete/self-heal
    // detection assistant-only (those are tool_use blocks the agent emits).
    if (msg.type !== "assistant" && msg.type !== "user" && msg.type !== "system") continue;
    // A standalone `system` message carries top-level string content (no message.content array).
    if (msg.type === "system" && typeof msg.content === "string" && hostPathLeaked(msg.content)) out.hostPathLeaked = true;
    for (const block of msg.message?.content ?? []) {
      // A `thinking` block can leak a host path in the reasoning text (e.g. quoting an absolute path).
      if (block.type === "thinking") {
        const t = block.thinking ?? block.text;
        if (typeof t === "string" && hostPathLeaked(t)) out.hostPathLeaked = true;
      }
      // #9: delete/self-heal detection must cover BOTH bash surfaces — native `Bash` (container/microvm
      // tiers) AND `mcp__workspace__bash` (host-loop, where native Bash is disabled). Same `command`
      // input shape. Missing the MCP name was a host-loop blind-spot in the post-hoc backstop.
      if (block.type === "tool_use" && (block.name === "Bash" || block.name === "mcp__workspace__bash") && msg.type === "assistant") {
        const cmd = String(block.input?.command ?? "");
        if (isOutputsDelete(cmd)) out.outputsDeletes.push(cmd.slice(0, 120));
        if (selfHealRe.test(cmd)) out.selfHealRan = true;
      }
      if (block.type === "text" && typeof block.text === "string" && hostPathLeaked(block.text)) out.hostPathLeaked = true;
      if (block.type === "tool_result") {
        // tool_result.content is a string or an array of {type:"text", text} blocks (Bash output, etc.)
        const c = block.content;
        if (typeof c === "string") {
          if (hostPathLeaked(c)) out.hostPathLeaked = true;
        } else if (Array.isArray(c)) {
          for (const sub of c) if (typeof sub?.text === "string" && hostPathLeaked(sub.text)) out.hostPathLeaked = true;
        }
      }
    }
  }
  return out;
}

/**
 * #45: parse `COWORK_HARNESS_DIALOG_TIMEOUT_MS`. Returns:
 *  - `Infinity` for "inf", "infinite", or "-1" (explicit no-timeout sentinel)
 *  - a positive number (milliseconds) for a numeric string > 0
 *  - `undefined` for absent / "0" / empty (→ policy-based default applies)
 */
export function parseDialogTimeout(raw: string): number | undefined {
  const s = raw.trim().toLowerCase();
  if (s === "inf" || s === "infinite" || s === "-1") return Infinity;
  const n = Number(s);
  if (n > 0) return n;
  return undefined;
}

/**
 * #23: read + validate the resume manifest. Converts a raw JSON `SyntaxError` into a friendly
 * "corrupt manifest" error, and on the resume path throws a clear error when `agentSessionId` is
 * missing or not a string (corrupt or older-format file) instead of silently degrading to a fresh
 * session. Extracted so it's unit-testable without spawning a run.
 */
export function readSessionManifest(path: string, sessionId: string): string {
  const raw = readFileSync(path, "utf8");
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`corrupt manifest at ${path}: not valid JSON`);
  }
  const id = parsed?.agentSessionId;
  if (typeof id !== "string" || !id) {
    throw new Error(
      `cannot resume "${sessionId}": manifest at ${path} is missing agentSessionId (corrupt or older format) — ` +
        `delete the run dir and re-run to recreate`,
    );
  }
  return id;
}

/** Thrown when a scenario asserts boundary behavior at a fidelity that can't enforce it (§5c category). */
export class BoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoundaryError";
  }
}

export { UnansweredError };
