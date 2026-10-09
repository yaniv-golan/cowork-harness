import { spawn, spawnSync } from "node:child_process";
import { InterruptedError, childInterruptSignal } from "../termination.js";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { assertSpawnAllowed } from "../spawn-guard.js";
import { warn, envPositiveNumber } from "../io.js";
import { isUsageLimit } from "../usage-limit.js";
import type { Complete, CompleteResult } from "./decider.js";
import type { CompleteStructured } from "./pairwise-judge.js";
import { EFFORT_THINKING_ENV_KEYS } from "../effort-env.js";

/** Every `claude -p` the harness runs (the LLM judge, the LLM decider, the critique evaluator) runs ISOLATED from most
 *  of the operator's own setup. The model reads untrusted agent output, so it must be able to call no tool
 *  (`--tools ""`; without it, read-only tools always run and Write/Bash/Web run whenever the operator's settings allow
 *  them). It loads no CLAUDE.md, skills, plugins, hooks or MCP servers (`--safe-mode`, `--strict-mcp-config`), no
 *  project or local settings from the harness's working directory (`--setting-sources user`), and writes no transcript
 *  into the operator's session history (`--no-session-persistence`). Every flag exists in Claude Code 2.1.197 and
 *  later; `assertIsolationSupported` refuses an older CLI before any model call.
 *
 *  What is NOT isolated, by design: USER settings stay, so `apiKeyHelper` auth keeps working, and the call inherits
 *  the harness's own environment (auth, PATH, proxy). Four things narrow what that lets through for grading:
 *  - the effort is pinned per role with `--effort` (`GRADER_EFFORT`), which outranks a user-settings `effortLevel`;
 *  - the effort/thinking env keys (`EFFORT_THINKING_ENV_KEYS`) are dropped from the inherited environment, since the
 *    CLI reads `CLAUDE_CODE_EFFORT_LEVEL` ahead of `--effort`;
 *  - the bare-mode and process-wrapper keys (`GRADER_SHELL_DROP_KEYS`) are dropped too;
 *  - `--settings` blanks the same keys (`GRADER_SETTINGS`): the CLI applies a user-settings or global-config `env`
 *    block inside itself, after this spawn, and flag settings are applied after both, so a blank wins. Every reader
 *    takes `""` as unset or false. That is read from the 2.1.288 binary, not observed live, so `userSettingsEffort`
 *    also DETECTS such a block, warns and records it.
 *  Not closable from here: a user `maxEffortLevel` below the pin still lowers the effort (across settings files the
 *  lowest wins, so a flag value cannot raise it back), and a managed (policy) `env` block still applies. The first is
 *  detected and recorded too.
 *
 *  `--tools` takes a variadic value, so it goes LAST: an empty value followed by more flags parses correctly on the
 *  CLIs measured, but nothing after it can be swallowed if a future parser reads the variadic list greedily.
 *
 *  On a machine with an enterprise MCP config, `isolationArgs` leaves `--strict-mcp-config` out (see there). */
export const ISOLATION_ARGS: readonly string[] = [
  "--safe-mode",
  "--strict-mcp-config",
  "--no-session-persistence",
  "--setting-sources",
  "user",
  "--tools",
  "",
];
/** Which harness role a host-`claude` call serves: it sets the pinned effort. */
export type GraderRole = "judge" | "evaluator" | "decider";

/** The effort each role's calls are made at. Without a pin the CLI picks the model's default, which a server-side
 *  per-model setting can move between two calls. Each pin is the 2.1.288 binary's catalog default for that role's
 *  default model, so a default grader or decider runs as it did before the pin:
 *  - `judge` (`semantic_matches`, `semantic_pairwise`) and `evaluator` (`critique`): `claude-opus-4-8`, default `high`;
 *  - `decider` (`on_unanswered: llm`, `decide --decider-llm`): the alias `sonnet`, which resolves to
 *    `claude-sonnet-5-5`, default `medium`.
 *  A role pointed at a model whose default differs (`claude-opus-4-7` defaults to `xhigh`) now runs at the pin. A
 *  model that takes no effort parameter is sent none: the CLI drops the level for it. */
export const GRADER_EFFORT: Readonly<Record<GraderRole, string>> = { judge: "high", evaluator: "high", decider: "medium" };

/** The CLI's effort levels, lowest first (its `maxEffortLevel` enum). */
const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"];

/** Flag settings every call carries: the effort/thinking env keys and `CLAUDE_CODE_SIMPLE` blanked, so a user-settings
 *  or global-config `env` block cannot set them (see `ISOLATION_ARGS`). The host CLI reads `CLAUDE_CODE_SIMPLE` as a
 *  boolean that takes only 1/true/yes/on, so `""` is off. */
export const GRADER_SETTINGS = {
  env: Object.fromEntries([...EFFORT_THINKING_ENV_KEYS, "CLAUDE_CODE_SIMPLE"].map((k) => [k, ""])) as Record<string, string>,
};

/** `extraArgs` with the grader `--settings` added — merged into a `--settings` JSON the caller already passes (its
 *  `env` keeps every other key; the blanked ones win), never a second `--settings`. A `--settings` naming a FILE cannot
 *  be merged without reading it, and no caller passes one, so it is refused rather than silently overridden. */
export function withGraderSettings(extraArgs: readonly string[]): string[] {
  const at = extraArgs.indexOf("--settings");
  if (at < 0) return ["--settings", JSON.stringify(GRADER_SETTINGS), ...extraArgs];
  let given: unknown;
  try {
    given = JSON.parse(extraArgs[at + 1] ?? "");
  } catch {
    given = undefined;
  }
  if (!given || typeof given !== "object" || Array.isArray(given))
    throw new Error(
      `a host \`claude\` call passed --settings ${JSON.stringify(extraArgs[at + 1])}, which is not inline JSON: cannot merge the grader settings into it`,
    );
  const g = given as { env?: Record<string, string> };
  const merged = { ...g, env: { ...(g.env ?? {}), ...GRADER_SETTINGS.env } };
  return [...extraArgs.slice(0, at), "--settings", JSON.stringify(merged), ...extraArgs.slice(at + 2)];
}

/** What the user settings the CLI loads under `--setting-sources user` set that changes a grader's effort: the
 *  effort/thinking keys an `env` block sets (NAMES only, never values) and a top-level `maxEffortLevel`. The files and
 *  their paths are the CLI's own (2.1.288): `<CLAUDE_CONFIG_DIR or ~/.claude>/settings.json` and the global config
 *  `<CLAUDE_CONFIG_DIR or ~>/.claude.json`, whose `env` is applied too. A file that is missing or does not parse
 *  contributes nothing. `modelSettings.<model>.maxEffortLevel` also clamps, per model, and is not read here. */
export interface UserSettingsEffort {
  envKeys: string[];
  maxEffort?: string;
}
export function userSettingsEffort(env: NodeJS.ProcessEnv = process.env): UserSettingsEffort {
  const dir = env.CLAUDE_CONFIG_DIR;
  const files = [join(dir || join(homedir(), ".claude"), "settings.json"), join(dir || homedir(), ".claude.json")];
  const keys = new Set<string>();
  let maxEffort: string | undefined;
  for (const [i, f] of files.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(f, "utf8"));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const o = parsed as { env?: unknown; maxEffortLevel?: unknown };
    if (o.env && typeof o.env === "object")
      for (const k of EFFORT_THINKING_ENV_KEYS) if (Object.prototype.hasOwnProperty.call(o.env, k)) keys.add(k);
    // `max` is the CLI's "no cap", so it is not recorded.
    if (i === 0 && typeof o.maxEffortLevel === "string" && EFFORT_ORDER.includes(o.maxEffortLevel) && o.maxEffortLevel !== "max")
      maxEffort = o.maxEffortLevel;
  }
  return { envKeys: [...keys].sort(), ...(maxEffort !== undefined ? { maxEffort } : {}) };
}

let settingsEffortCache: UserSettingsEffort | undefined;
const settingsWarned = new Set<string>();
function cachedSettingsEffort(): UserSettingsEffort {
  return (settingsEffortCache ??= userSettingsEffort());
}

/** Warn once per process, before a role's first call, about user settings that change a grader's effort. */
function warnSettingsEffort(role: GraderRole): void {
  const u = cachedSettingsEffort();
  if (u.envKeys.length && !settingsWarned.has("env")) {
    settingsWarned.add("env");
    warn(
      `::warning:: your Claude Code user settings set ${u.envKeys.join(", ")} in an \`env\` block. The judge, LLM decider ` +
        `and critique evaluator calls blank ${u.envKeys.length > 1 ? "them" : "it"} with --settings; if your Claude Code ` +
        `does not honour that, ${u.envKeys.length > 1 ? "they change" : "it changes"} how answers are graded. Recorded as ` +
        `settingsEnvOverride in the transport identity.\n`,
    );
  }
  const pin = GRADER_EFFORT[role];
  if (u.maxEffort !== undefined && EFFORT_ORDER.indexOf(u.maxEffort) < EFFORT_ORDER.indexOf(pin) && !settingsWarned.has(`max:${role}`)) {
    settingsWarned.add(`max:${role}`);
    warn(
      `::warning:: your Claude Code user settings set maxEffortLevel to ${u.maxEffort}, below the ${pin} the ${role} runs at: ` +
        `the CLI clamps the call down to ${u.maxEffort}, and nothing the harness passes can raise it. Recorded as ` +
        `settingsMaxEffort in the transport identity.\n`,
    );
  }
}

/** Operator-shell keys that change what the host CLI is, not only how hard it thinks: `CLAUDE_CODE_SIMPLE=1` is its
 *  `--bare` mode, which also reads Anthropic auth only from `ANTHROPIC_API_KEY` or an `apiKeyHelper` (never OAuth or
 *  the keychain), so an export would silently change the grader's credential; `CLAUDE_CODE_PROCESS_WRAPPER` wraps the
 *  processes it launches. The agent's tiers scrub these two and `CLAUDE_AGENT_SDK_MCP_NO_PREFIX`
 *  (`SCRUBBED_AGENT_ENV_KEYS` in src/session.ts); that third key only renames SDK-type MCP servers' tools, and a grader
 *  call runs with `--strict-mcp-config` and no SDK server, so it changes nothing here. Not closed: the process wrapper
 *  also has its own settings key, which a user, managed or flag settings file can still set; only the environment
 *  variable is dropped. */
export const GRADER_SHELL_DROP_KEYS = ["CLAUDE_CODE_SIMPLE", "CLAUDE_CODE_PROCESS_WRAPPER"] as const;

/** The host-`claude` call's environment: the harness's own, minus the keys that would change its effort or thinking
 *  (see `ISOLATION_ARGS`) and `GRADER_SHELL_DROP_KEYS`. Everything else — auth, PATH, proxy — is kept. */
export function graderSpawnEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of [...EFFORT_THINKING_ENV_KEYS, ...GRADER_SHELL_DROP_KEYS]) delete env[k];
  return env;
}

/** The flags `ISOLATION_ARGS`, the `--effort` pin and the `--settings` override need the host CLI to accept, matched
 *  against its `--help`. */
const ISOLATION_FLAGS = [
  "--safe-mode",
  "--strict-mcp-config",
  "--no-session-persistence",
  "--setting-sources",
  "--tools",
  "--effort",
  "--settings",
];
/** The oldest Claude Code version verified to accept every isolation flag. */
export const ISOLATION_MIN_CLI = "2.1.197";

/** True when `help` (a `claude --help` text) declares `flag` as an option: an option line starts with exactly two
 *  spaces and the flag, then whitespace, `<`, `=` or the end. Anchored so the flag named inside another option's
 *  wrapped description (`--strict-mcp-config` and `--tools` both appear there) does not count. An unrecognised help
 *  format matches nothing, so the probe fails CLOSED. A plain line scan, so nothing in `flag` is read as a pattern. */
export function helpDeclaresFlag(help: string, flag: string): boolean {
  const lead = `  ${flag}`;
  return help.split("\n").some((line) => {
    if (!line.startsWith(lead)) return false;
    const next = line.charAt(lead.length);
    return next === "" || next === "<" || next === "=" || /\s/.test(next);
  });
}

/** Where Claude Code reads an enterprise MCP config (`managed-mcp.json` in its managed-settings directory). */
export function defaultManagedMcpPath(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-mcp.json";
  if (platform === "win32") return "C:\\Program Files\\ClaudeCode\\managed-mcp.json";
  return "/etc/claude-code/managed-mcp.json";
}

const isolationChecked = new Map<string, true | Error>();
let managedMcpPathOverride: string | undefined;
/** Binaries whose Claude Code refused `--strict-mcp-config` for an enterprise MCP config at a path this harness does
 *  not check: their calls leave the flag out from then on, as for one found at the managed-settings path. */
const strictMcpRefused = new Set<string>();

/** The isolation flags for this machine. Claude Code refuses `--strict-mcp-config` outright while an enterprise MCP
 *  config is present ("You cannot use --strict-mcp-config when an enterprise MCP config is present"), so there the
 *  flag is left out. `--safe-mode` already keeps every MCP server out, the organisation's managed ones included: in
 *  safe mode Claude Code's MCP loader returns no servers before it reads the enterprise or managed scope (verified in
 *  the 2.1.197 and 2.1.286 binaries), and its safe-mode notice says managed MCP servers do not apply. A managed config
 *  elsewhere (Claude Code can be pointed at another managed-settings path) is learnt from the CLI's own refusal; see
 *  `claudeCliComplete`. */
export function isolationArgs(bin: string, managedMcpPath: string = managedMcpPathOverride ?? defaultManagedMcpPath()): readonly string[] {
  return existsSync(managedMcpPath) || strictMcpRefused.has(bin)
    ? ISOLATION_ARGS.filter((a) => a !== "--strict-mcp-config")
    : ISOLATION_ARGS;
}

/** Refuse a host `claude` that does not accept every isolation flag with a clear, actionable error before any model
 *  call, instead of an unknown-option exit retried as if it were transient. One `--help` probe per binary per process
 *  (no model call, no stdin). A probe that could not run (missing binary, timeout) is not cached. */
export function assertIsolationSupported(bin: string): void {
  const cached = isolationChecked.get(bin);
  if (cached !== undefined) {
    if (cached !== true) throw cached;
    return;
  }
  const help = spawnSync(bin, ["--help"], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 15_000, env: graderSpawnEnv() });
  if (help.error) {
    const code = (help.error as NodeJS.ErrnoException).code;
    // Not a version problem, and not a verdict to remember: the probe itself did not complete.
    if (code === "ETIMEDOUT")
      throw new Error(
        `the host \`claude\` (${bin}) did not answer \`--help\` within 15s, so the harness cannot confirm it runs judge, decider and ` +
          `critique-evaluator calls isolated — refusing rather than guessing. Retry, or check that ${bin} starts.`,
      );
    throw new Error(
      `LLM decider transport (${bin} -p) failed to spawn: ${help.error.message} — ensure 'claude' is installed and on PATH, or set COWORK_HARNESS_CLAUDE_BIN to its path`,
    );
  }
  // Killed by the operator's interrupt: that is the interrupt, never a verdict about the version (and not cached).
  const intr = childInterruptSignal(help);
  if (intr) throw new InterruptedError(intr, "claude --help");
  const text = `${help.stdout ?? ""}\n${help.stderr ?? ""}`;
  // A `--help` that crashed or was killed and printed nothing says nothing about the version: refuse, uncached.
  if ((help.status !== 0 || help.signal) && !text.trim())
    throw new Error(
      `the host \`claude\` (${bin}) printed nothing for \`--help\` (${help.signal ? `killed by ${help.signal}` : `exit ${help.status}`}), so the ` +
        `harness cannot confirm it runs judge, decider and critique-evaluator calls isolated — refusing rather than guessing. ` +
        `Check that ${bin} --help works.`,
    );
  const missing = ISOLATION_FLAGS.filter((f) => !helpDeclaresFlag(text, f));
  let verdict: true | Error = true;
  if (missing.length) {
    const version = spawnSync(bin, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: 15_000,
      env: graderSpawnEnv(),
    });
    const v = (version.stdout ?? "").trim() || "unknown version";
    verdict = new Error(
      `the host \`claude\` (${bin}, ${v}) does not accept ${missing.join(", ")} — ` +
        `the harness runs every judge, decider and critique-evaluator call isolated from your own Claude Code setup, which ` +
        `needs Claude Code ${ISOLATION_MIN_CLI} or later. To fix: upgrade the host \`claude\` (or point COWORK_HARNESS_CLAUDE_BIN at a newer one).`,
    );
  }
  isolationChecked.set(bin, verdict);
  if (verdict !== true) throw verdict;
}

/** The pre-spend form of `assertIsolationSupported`: the refusal message for the configured host `claude`, or
 *  undefined when it can run isolated. For commands that spend (an agent run, critique task turns) before their first
 *  judge, decider or evaluator call — they refuse up front (exit 2) instead of after the spend. */
export function isolationRefusal(): string | undefined {
  // Under the spawn guard nothing may be launched — not even a `--help` probe; the later model call is refused by
  // the guard itself, so there is nothing to pre-empt here.
  try {
    assertSpawnAllowed("the host `claude` isolation probe");
  } catch {
    return undefined;
  }
  try {
    assertIsolationSupported(process.env.COWORK_HARNESS_CLAUDE_BIN || "claude");
    return undefined;
  } catch (e) {
    if (e instanceof InterruptedError) throw e;
    return (e as Error).message;
  }
}

/** How a host-`claude` call was made, recorded beside a judge's grade or a critique: the isolation level
 *  (`ISOLATION_ARGS`; bumped when that set changes), the host CLI's version, the `--effort` it was called with, and
 *  `strictMcp: false` when the call left out `--strict-mcp-config` for an enterprise MCP config (`--safe-mode` still
 *  kept MCP servers out). A grade from another level, or a CLI whose safe mode differs, ran under different
 *  conditions — a comparison can tell. A grade recorded before `effort` existed has none: its effort is unknown (the
 *  model's default, or whatever the grading shell exported), and no comparison treats the absence as a change. */
export interface TransportIdentity {
  isolation: "1";
  cliVersion?: string;
  /** The `--effort` passed (the role's `GRADER_EFFORT`). A model that takes no effort parameter was sent none. */
  effort?: string;
  /** The effort/thinking keys a user-settings or global-config `env` block sets (names only), which the call blanks
   *  with `--settings`. Absent when none does. */
  settingsEnvOverride?: string[];
  /** A user-settings `maxEffortLevel`, which clamps the call's effort when it is below `effort`. */
  settingsMaxEffort?: string;
  strictMcp?: false;
}
const cliVersions = new Map<string, string | null>();
export function transportIdentity(
  role: GraderRole = "judge",
  bin: string = process.env.COWORK_HARNESS_CLAUDE_BIN || "claude",
): TransportIdentity {
  const u = cachedSettingsEffort();
  const effort = {
    effort: GRADER_EFFORT[role],
    ...(u.envKeys.length ? { settingsEnvOverride: u.envKeys } : {}),
    ...(u.maxEffort !== undefined ? { settingsMaxEffort: u.maxEffort } : {}),
  };
  const strict = { ...effort, ...(isolationArgs(bin).includes("--strict-mcp-config") ? {} : { strictMcp: false as const }) };
  // Under the spawn guard nothing is launched, not even a `--version` probe: the version is then unrecorded.
  try {
    assertSpawnAllowed("the host `claude` version probe");
  } catch {
    return { isolation: "1", ...strict };
  }
  let v = cliVersions.get(bin);
  if (v === undefined) {
    const r = spawnSync(bin, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: 15_000,
      env: graderSpawnEnv(),
    });
    v = (r.stdout ?? "").trim().split(/\s+/)[0] || null;
    cliVersions.set(bin, v);
  }
  return v ? { isolation: "1", cliVersion: v, ...strict } : { isolation: "1", ...strict };
}

/** Test seam: forget every cached probe, and (optionally) point the enterprise-MCP check at another path so a
 *  test controls whether the machine "has" a managed config. */
export function resetIsolationPreflight(managedMcpPath?: string): void {
  managedMcpPathOverride = managedMcpPath;
  strictMcpRefused.clear();
  isolationChecked.clear();
  cliVersions.clear();
  settingsEffortCache = undefined;
  settingsWarned.clear();
}

/** A spawn rejection the retry wrapper may re-attempt: a TRANSIENT non-zero exit. Timeout / maxBytes /
 *  spawn-ENOENT failures leave this false so they fail loud on the first attempt (see claudeCliComplete).
 *  A usage-limit exit also sets it false — retrying into a spent quota just burns the batch. */
class TransportExit extends Error {
  retryable: boolean;
  /** Claude Code refused `--strict-mcp-config` for an enterprise MCP config: retry without that flag. */
  strictMcpRefused = false;
  constructor(message: string, retryable = true) {
    super(message);
    this.retryable = retryable;
  }
}

/** Best-effort `api_error_status` from a `claude -p --output-format json` envelope (429 on a rate/usage
 *  error). null if absent or the envelope doesn't parse. */
function tryExtractApiErrorStatus(raw: string): number | undefined {
  try {
    const parsed = JSON.parse(raw) as { api_error_status?: number };
    return typeof parsed.api_error_status === "number" ? parsed.api_error_status : undefined;
  } catch {
    return undefined;
  }
}

/** Tail of a captured stream for an error message — keep the END (where the diagnosis is), bounded. */
function tail(s: string, n = 500): string {
  const t = s.trim();
  return t.length > n ? "…" + t.slice(-n) : t;
}

/** True when `key` is the concrete model id that a `--model` request `requested` resolves to: the exact
 *  id, or — for a floating alias like `"sonnet"` — the id carrying that alias as a dash-separated segment
 *  (`claude-sonnet-5`). Segment membership, not substring: `"opus"` must not match a hypothetical
 *  `claude-opus-lite-…` by accident. */
function resolvesRequested(key: string, requested: string): boolean {
  return key === requested || key.split("-").includes(requested);
}

/** Strict parse of one `claude -p --output-format json` envelope: requires a string `result` AND exactly
 *  one PRIMARY `modelUsage` key. Throws on either violation — a malformed/ambiguous envelope on a CLEAN
 *  exit is a genuine transport-contract break worth failing loud on, never masked or guessed past.
 *  `result` is the model's raw reply text (identical content to what `-p` without `--output-format`
 *  prints); the primary `modelUsage` key is the CONCRETE model the (possibly aliased, e.g. "sonnet")
 *  `--model` request actually resolved to — this is what callers record for provenance, never the alias
 *  they requested.
 *
 *  "Exactly one key" was the contract through agent 2.1.260. Agent 2.1.275 (Desktop 2.2553.1) added an
 *  AUXILIARY call in `-p` mode — measured: `--model sonnet` now yields
 *  `{"claude-haiku-4-5-20251001": {897 in / 8 out}, "claude-sonnet-5": {the actual turn}}`, where 2.1.260
 *  yields the sonnet key alone; the same prompt, the same flags, bracketed against both native binaries.
 *  So the primary model is now IDENTIFIED rather than assumed: the key that resolves the requested model.
 *  Ambiguity (zero or several keys resolve it) still throws — that is the contract break this parser
 *  exists to catch, and the one case the old count check was actually guarding. The whole map is still
 *  passed through as `usage`, so the auxiliary call's cost is not lost — it is real spend. */
function parseEnvelope(raw: string, requestedModel: string, structured = false): CompleteResult {
  const parsed = JSON.parse(raw) as {
    result?: string;
    modelUsage?: Record<string, unknown>;
    structured_output?: unknown;
    subtype?: unknown;
  };
  // A structured call's answer is `structured_output`; a structured-output failure (subtype
  // `error_max_structured_output_retries`) may carry no `result` at all, and must still reach the caller as data.
  if (typeof parsed.result !== "string" && !structured) throw new Error(`envelope missing "result": ${tail(raw)}`);
  const models = Object.keys(parsed.modelUsage ?? {});
  if (models.length === 0) throw new Error(`envelope's modelUsage is empty (expected the resolved model): ${tail(raw)}`);
  const primary = models.length === 1 ? models : models.filter((k) => resolvesRequested(k, requestedModel));
  if (primary.length !== 1)
    throw new Error(
      `envelope's modelUsage has ${models.length} keys (${models.join(", ")}) and ${primary.length} of them resolve the requested ` +
        `model "${requestedModel}" (expected exactly 1): ${tail(raw)}`,
    );
  // Pass the usage VALUE through too (additive — see CompleteResult.usage): the key alone gives model
  // provenance, but discarding the value made the evaluator passes' cost unrecoverable.
  const base: CompleteResult = { text: parsed.result ?? "", model: primary[0]!, usage: parsed.modelUsage as Record<string, unknown> };
  if (!structured) return base;
  return {
    ...base,
    ...(parsed.structured_output !== undefined ? { structured: parsed.structured_output } : {}),
    ...(typeof parsed.subtype === "string" ? { subtype: parsed.subtype } : {}),
  };
}

/** Lenient, best-effort extraction of JUST the `result` field for a FAILURE diagnosis message — unlike
 *  `parseEnvelope`, this does not require `modelUsage` to resolve (an operational failure legitimately
 *  reports zero resolved models), so it never throws; returns null if `result` isn't a string or the JSON
 *  itself doesn't parse. */
function tryExtractResultText(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { result?: string };
    return typeof parsed.result === "string" ? parsed.result : null;
  } catch {
    return null;
  }
}

/**
 * One `claude -p --output-format json` spawn. Resolves `{text, model}` on a clean exit; rejects loud
 * otherwise. stdout AND stderr are captured: a `claude -p` operational failure (bad model, auth,
 * rate-limit) prints its human-readable diagnosis to STDOUT and exits 1 (verified) — stderr is usually
 * empty — so a non-zero exit MUST surface the captured output or the failure is undiagnosable ("exited 1"
 * with no WHY). The CLI still emits a well-formed JSON envelope on an operational failure (`is_error:true`,
 * verified), so the diagnosis prefers its `result` field and only falls back to the raw tail if the
 * envelope itself doesn't parse (e.g. a failure that never reached the CLI's own JSON emitter).
 */
function spawnOnce(
  bin: string,
  prompt: string,
  model: string,
  timeoutMs: number,
  maxBytes: number,
  extraArgs: readonly string[] = [],
  role: GraderRole = "judge",
): Promise<CompleteResult> {
  // The backstop for every host-`claude` call, whichever caller reaches it: never spawn the model call on a CLI
  // that would drop (or reject) an isolation flag. Cached per binary, so a retry or a batch probes once.
  try {
    assertIsolationSupported(bin);
  } catch (e) {
    return Promise.reject(e);
  }
  return new Promise<CompleteResult>((resolve, reject) => {
    // bound the `claude -p` spawn — a hung-but-alive child would otherwise block the harness forever.
    // On expiry SIGKILL the child and reject LOUD; clear the timer on close/error so a fast call never leaks it.
    // stderr is PIPED (not "ignore") so the close handler can fold it into the diagnosis.
    // The prompt is delivered on STDIN, not argv: an argv prompt is world-readable via `ps` for the life of
    // the child (verified: `echo '...' | claude -p --output-format json` with no positional prompt reads
    // from stdin and returns the identical success envelope) — stdin is process-private.
    // The caller's extra flags go BEFORE the isolation flags, so the variadic `--tools ""` stays last. The effort is
    // pinned, and the env keys that would outrank or bypass the pin are dropped (see `ISOLATION_ARGS`).
    const args = isolationArgs(bin);
    const argv = [
      "-p",
      "--model",
      model,
      "--effort",
      GRADER_EFFORT[role],
      "--output-format",
      "json",
      ...withGraderSettings(extraArgs),
      ...args,
    ];
    const child = spawn(bin, argv, {
      stdio: ["pipe", "pipe", "pipe"],
      env: graderSpawnEnv(),
    });
    // A child that exits/errors before consuming stdin (e.g. ENOENT, or a fake bin that exits immediately)
    // delivers EPIPE asynchronously as an `error` event on stdin — without a listener Node escalates it to
    // an uncaughtException. The child's own "error"/"close" handlers below already reject loud, so swallow
    // the redundant async EPIPE here rather than let it crash the process.
    child.stdin.on("error", () => {
      /* surfaced via the child's own error/close handlers */
    });
    child.stdin.write(prompt);
    child.stdin.end();
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      // NOT a TransportExit → not retried: a child that ate the whole timeout budget is not a quick transient.
      reject(
        new Error(
          `LLM decider transport (${bin} -p) timed out after ${timeoutMs}ms — raise COWORK_HARNESS_LLM_TIMEOUT_MS to allow a longer gate`,
        ),
      );
    }, timeoutMs);
    // Bound stdout too — the wall-clock timeout above caps a fully-hung child, but not one that is
    // actively spewing. Past the cap, SIGKILL and reject loud rather than growing the buffer unbounded.
    // collect raw Buffer chunks and decode ONCE at close. The old `out += d` coerced each chunk to
    // a string independently, so a UTF-8 sequence straddling a chunk boundary (em-dash, accent, emoji)
    // decoded as U+FFFD in both halves — corrupting the verification-critical decider answer. Byte-identical
    // for ASCII/single-chunk. The byte cap still sums `d.length` (raw bytes), unaffected by decoding.
    const chunks: Buffer[] = [];
    let bytes = 0;
    let err = "";
    child.stdout.on("data", (d: Buffer) => {
      bytes += d.length;
      if (bytes > maxBytes) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        clearTimeout(timer);
        // NOT a TransportExit → not retried: a spewing child would just spew again.
        reject(
          new Error(
            `LLM decider transport (${bin} -p) exceeded ${maxBytes} bytes — aborting; raise COWORK_HARNESS_LLM_MAX_BYTES if this output is legitimately large`,
          ),
        );
        return;
      }
      chunks.push(d);
    });
    // Capture stderr, bounded (claude's stderr is small; cap so a pathological spew can't grow unbounded).
    child.stderr.on("data", (d: Buffer) => {
      if (err.length < 64 * 1024) err += d;
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      // NOT a TransportExit → not retried: a spawn failure (e.g. ENOENT — `claude` not on PATH) is deterministic.
      reject(
        new Error(
          `LLM decider transport (${bin} -p) failed to spawn: ${e.message} — ensure 'claude' is installed and on PATH, or set COWORK_HARNESS_CLAUDE_BIN to its path`,
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // Decode once at close — see chunks comment above.
      const raw = Buffer.concat(chunks).toString("utf8");
      if (code === 0) {
        try {
          resolve(parseEnvelope(raw, model, extraArgs.includes("--json-schema")));
        } catch (e) {
          // NOT a TransportExit → not retried: a malformed/ambiguous envelope on a CLEAN exit is a
          // deterministic contract break (the CLI / its --output-format shape), not a transient hiccup.
          reject(
            new Error(`LLM decider transport (${bin} -p --output-format json) returned an unparseable envelope: ${(e as Error).message}`),
          );
        }
        return;
      }
      // Non-zero exit: fold the captured output into the message (the diagnosis lives in stdout, not stderr —
      // verified) and mark RETRYABLE so a transient hiccup gets a bounded re-attempt before failing loud.
      const resultText = tryExtractResultText(raw);
      const o = tail(resultText ?? raw);
      const e = tail(err);
      const diag = [o && `stdout: ${o}`, e && `stderr: ${e}`].filter(Boolean).join(" | ");
      // An enterprise MCP config somewhere other than the managed-settings path `isolationArgs` checks: Claude Code
      // refused --strict-mcp-config before any model call. `claudeCliComplete` retries once without the flag.
      if (/cannot use --strict-mcp-config when an enterprise MCP config is present/i.test(`${raw}\n${err}`)) {
        const refused = new TransportExit(
          `LLM decider transport (${bin} -p): Claude Code refused --strict-mcp-config because an enterprise MCP config is present`,
          false,
        );
        refused.strictMcpRefused = args.includes("--strict-mcp-config");
        reject(refused);
        return;
      }
      // Usage/quota limit: don't retry into a spent quota — fail loud & fast so a batch halts.
      if (resultText && isUsageLimit(resultText, tryExtractApiErrorStatus(raw))) {
        reject(
          new TransportExit(`LLM decider transport (${bin} -p): usage/quota limit hit — retry after the limit resets. ${diag}`, false),
        );
        return;
      }
      reject(new TransportExit(`LLM decider transport (${bin} -p) exited ${code}${diag ? ` — ${diag}` : " (no output captured)"}`));
    });
  });
}

/**
 * The default `LlmDecider` transport: shell out to the host `claude -p` (one-shot, headless). Chosen
 * over a direct `POST /v1/messages`: the harness PROCESS is not behind the egress proxy
 * (only the spawned agent child is), so a direct API call would bypass the very allowlist the harness
 * enforces. `claude -p` reuses the run's own auth path and is dogfood-consistent. Requests
 * `--output-format json` so the resolved model (`modelUsage`) can be recorded for provenance
 * even when `model` is a floating alias like `"sonnet"`. One short, isolated, tool-less call per gate (see
 * `ISOLATION_ARGS`) (one call, no recursion into the harness; model is the decider default or --decider-model).
 *
 * Non-zero-exit retry: a single `claude -p` spawn can exit non-zero on a TRANSIENT upstream hiccup
 * (rate-limit/overload/network) during a long back-to-back batch — observed live, not reproducible on demand.
 * Bounded-retry the non-zero-exit class (small linear backoff) so a transient exit doesn't kill a 10-minute
 * paid run at the final gate. NOTE: exit-code is NOT a clean transient/permanent discriminator — a
 * DETERMINISTIC failure (bad `--decider-model`, auth) also exits non-zero and so is retried the full count
 * before failing loud; the cost is bounded (each bad spawn exits fast, before any model call) and the
 * captured stdout names the cause, so we accept it rather than brittle stdout pattern-matching.
 *
 * Retry never double-answers: this transport has NO harness side effects (it returns a string; the gate is
 * answered exactly once, downstream of a SUCCESSFUL call — a non-zero exit delivers no string), and the call runs
 * with no tools at all (`--tools ""`, `ISOLATION_ARGS`), so a retried call cannot act twice. Only the
 * non-zero-exit class retries; timeout / maxBytes-overflow / spawn-ENOENT are not transient and fail loud on
 * the first attempt. Set `COWORK_HARNESS_LLM_RETRIES=0` to disable (e.g. deterministic CI).
 */
export const claudeCliComplete: Complete = async (prompt, model) => completeViaCli(prompt, model, [], "judge");
/** `claudeCliComplete` for the LLM decider: the same call at the decider's effort (`GRADER_EFFORT.decider`). */
export const claudeCliCompleteDecider: Complete = async (prompt, model) => completeViaCli(prompt, model, [], "decider");
/** `claudeCliComplete` for the `critique` evaluator, at its effort (`GRADER_EFFORT.evaluator`). */
export const claudeCliCompleteEvaluator: Complete = async (prompt, model) => completeViaCli(prompt, model, [], "evaluator");

/** The structured transport for the pairwise judge: the same `claude -p` spawn, retry and bounds as
 *  `claudeCliComplete`, plus `--json-schema` (the answer arrives validated in the envelope's `structured_output`),
 *  and `--system-prompt` (the untrusted-data instruction belongs in the system turn); it runs isolated and tool-less
 *  like every host-`claude` call (`ISOLATION_ARGS`). The judged documents travel on stdin, never argv; the system prompt and schema are fixed harness text. */
export const claudeCliCompleteStructured: CompleteStructured = async ({ system, user, schema, model }) => {
  const r = await completeViaCli(user, model, ["--json-schema", JSON.stringify(schema), "--system-prompt", system], "judge");
  return {
    structured: r.structured,
    model: r.model,
    ...(r.usage !== undefined ? { usage: r.usage } : {}),
    ...(r.subtype !== undefined ? { subtype: r.subtype } : {}),
  };
};

async function completeViaCli(prompt: string, model: string, extraArgs: readonly string[], role: GraderRole): Promise<CompleteResult> {
  assertSpawnAllowed("the --decider-llm transport (`claude -p`)");
  warnSettingsEffort(role);
  const bin = process.env.COWORK_HARNESS_CLAUDE_BIN || "claude";
  // envPositiveNumber warns LOUD (not a silent revert) when the var is SET but unparseable/non-positive
  // (e.g. "5m", "0", "-1") — the old `Number(...) || dflt` idiom swallowed a typo'd knob with no signal.
  // An UNSET var still falls back to the same defaults as before.
  const timeoutMs = envPositiveNumber("COWORK_HARNESS_LLM_TIMEOUT_MS", 600_000);
  const maxBytes = envPositiveNumber("COWORK_HARNESS_LLM_MAX_BYTES", 8 * 1024 * 1024);
  // Parse the retry count defensively: unset/blank/unparseable → the default 2 (NOT 0 — a typo must not
  // silently disable retries); a valid number is floored and clamped to [0, 10] (so "2.9"→2, "-1"→0, "0"
  // disables, and a fat-fingered "1e2"/"100" can't spin up a multi-minute backoff against a hard failure).
  const retriesRaw = process.env.COWORK_HARNESS_LLM_RETRIES;
  let retries = 2;
  if (retriesRaw !== undefined && retriesRaw.trim() !== "") {
    const n = Number(retriesRaw);
    retries = Number.isFinite(n) ? Math.min(10, Math.max(0, Math.floor(n))) : 2;
  }
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // The `--effort` the call was made with (the role's pin), reported beside the model so a caller can record it.
      return { ...(await spawnOnce(bin, prompt, model, timeoutMs, maxBytes, extraArgs, role)), effort: GRADER_EFFORT[role] };
    } catch (e) {
      const err = e as Error & { retryable?: boolean; strictMcpRefused?: boolean };
      lastErr = err;
      // Once per binary, and not counted against the retries: the refusal comes before any model call, and the flag
      // only adds to what --safe-mode already keeps out (see `isolationArgs`).
      if (err.strictMcpRefused && !strictMcpRefused.has(bin)) {
        strictMcpRefused.add(bin);
        warn(`${err.message} — running without --strict-mcp-config; --safe-mode keeps every MCP server out`);
        attempt--;
        continue;
      }
      if (!err.retryable || attempt === retries) throw err;
      warn(`${err.message} — retrying (attempt ${attempt + 2}/${retries + 1})`);
      // Small linear backoff (250ms, 500ms, …) — enough to ride a brief rate-limit/overload window.
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }
  throw lastErr; // unreachable (the loop returns or throws on the last attempt), but satisfies the type checker.
}
