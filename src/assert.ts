import { existsSync, readFileSync, statSync, realpathSync } from "node:fs";
import { join, resolve, relative, isAbsolute, sep } from "node:path";
import type { Assertion, RunResult, UsageInfo, CostInfo } from "./types.js";
import { VERDICT_MODIFIER_KEYS } from "./types.js";
import { compileUserRegex } from "./regex.js";
import { normalizeHost } from "./boundary-paths.js";
import { extractComputerLinks, resolveComputerLink, type LinkResolutionContext } from "./run/computer-links.js";
import { collectArtifacts } from "./run/artifacts.js";
import { anyGlobMatches } from "./glob.js";

/** Derives the four AssertContext budget fields (costUsd/tokensTotal/toolCallsTotal/turns) uniformly from
 *  any RunResult/RunRecord-shaped source — live, replay, and verify-run all read the same shapes (Wave 0's
 *  shared UsageInfo/CostInfo types), so this is one function, not four copies. Each field's own
 *  undefined-ness IS the evidence-unavailable signal (see AssertContext's doc comments); no separate
 *  `*Missing` booleans needed for scalars. `turns` (Wave 2 / E6b) is a pure passthrough of
 *  `usage.turns` — Wave 0 already did the real extraction/fallback-counting work at the source, so there
 *  is no re-derivation here, unlike the other three fields which are actually computed from raw parts. */
export function budgetFields(src: { usage?: UsageInfo; cost?: CostInfo; toolCounts?: Record<string, number> }): {
  costUsd?: number;
  tokensTotal?: number;
  toolCallsTotal?: number;
  turns?: number;
} {
  const inTok = src.usage?.input_tokens;
  const outTok = src.usage?.output_tokens;
  return {
    costUsd: src.cost?.usd,
    tokensTotal: typeof inTok === "number" && typeof outTok === "number" ? inTok + outTok : undefined,
    toolCallsTotal: src.toolCounts === undefined ? undefined : Object.values(src.toolCounts).reduce((a, b) => a + b, 0),
    turns: src.usage?.turns,
  };
}

/** Resolve a user-authored assertion path under `workRoot`, rejecting absolute paths and any `..` that
 *  escapes the root. Returns the absolute path, or null if it would leave `workRoot`. Assertion paths are
 *  author-controlled, not attacker input, but a `file_exists: "../../etc/passwd"` silently probing the host
 *  FS (or an `outputs/../../x` slipping past the user-visible prefix check) is a containment bug regardless. */
function containedPath(workRoot: string, p: string): string | null {
  if (isAbsolute(p)) return null;
  const root = resolve(workRoot);
  const abs = resolve(root, p);
  const rel = relative(root, abs);
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) return null;
  return abs;
}

/**
 * containedPath checks lexical traversal but not symlink targets. A symlink inside the workspace
 * root that points outside satisfies containedPath yet lets existsSync observe host files.
 * This helper resolves symlinks with realpathSync and verifies the real path is still under `root`.
 * Returns the absolute path when safe; returns null when:
 *  - the path escapes root after symlink resolution (containment violation), or
 *  - realpathSync throws ENOENT (file does not exist — treat as "not found", not a violation).
 * Other realpathSync errors (permission denied, etc.) are treated as containment failures (not found = safe
 * but conservative; the caller's existsSync will return false anyway).
 *
 * Note: workRoot itself is also resolved via realpathSync to handle platforms (macOS) where tmpdir()
 * returns a symlinked path (e.g. /var/folders/... → /private/var/folders/...). Without resolving
 * both sides, a legitimate file under a symlinked workRoot would be incorrectly flagged as escaping.
 */
function containedRealPath(workRoot: string, abs: string): string | null {
  // Resolve workRoot itself to its real path so comparisons are apples-to-apples.
  let realRoot: string;
  try {
    realRoot = realpathSync(resolve(workRoot));
  } catch {
    // workRoot doesn't exist (e.g. /nonexistent in tests) — fall back to lexical root.
    realRoot = resolve(workRoot);
  }
  let real: string;
  try {
    real = realpathSync(abs);
  } catch (e: any) {
    // ENOENT: path doesn't exist — not a containment violation, just absent.
    if (e?.code === "ENOENT") return abs; // return the original abs; existsSync will return false
    // Other errors (EPERM, dangling symlink pointing outside): treat conservatively as "not accessible".
    return null;
  }
  const rel = relative(realRoot, real);
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) return null;
  return real;
}

/**
 * Resolve a dotted path into a parsed JSON document with THREE distinct outcomes (conflating them
 * reintroduces a false-green at the field level):
 *  - `value`      — the path resolves to a present value (which may itself be JSON null);
 *  - `absent`     — the FINAL key is missing from a parent that DID resolve (the anti-hallucination case);
 *  - `unresolved` — an INTERMEDIATE segment is missing / not an object — the artifact is malformed for this
 *                   path, which must FAIL LOUD, never pass vacuously.
 * Array indices are addressed as numeric string segments (e.g. `items.0.id`).
 */
export type DotResolve = { state: "value"; value: unknown } | { state: "absent" } | { state: "unresolved"; at: string };
export function resolveDotPath(doc: unknown, path: string | undefined): DotResolve {
  if (!path) return { state: "value", value: doc };
  const segs = path.split(".");
  let cur: unknown = doc;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const last = i === segs.length - 1;
    if (cur === null || typeof cur !== "object") return { state: "unresolved", at: segs.slice(0, i).join(".") || "(root)" };
    const obj = cur as Record<string, unknown>;
    const has = Object.prototype.hasOwnProperty.call(obj, seg);
    if (last) return has ? { state: "value", value: obj[seg] } : { state: "absent" };
    if (!has) return { state: "unresolved", at: segs.slice(0, i + 1).join(".") };
    cur = obj[seg];
  }
  return { state: "value", value: cur };
}

/**
 * Recursive deep equality for parsed-JSON values, used by `artifact_json.equals` / `.in`.
 * Object key ORDER is irrelevant ({a:1,b:2} === {b:2,a:1}), but array ORDER is significant
 * ([1,2] !== [2,1]) — arrays carry meaning in their order, so we never sort them. The old
 * `JSON.stringify(a) === JSON.stringify(b)` was wrongly order-sensitive on object keys.
 */
const deepJsonEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true; // primitives + identity (JSON has no NaN, so no special-casing needed)
  if (a === null || b === null) return false; // one is null and they weren't ===
  if (typeof a !== "object" || typeof b !== "object") return false;
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr && bArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepJsonEqual(a[i], b[i])) return false; // order-sensitive
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  const bKeys = Object.keys(bo);
  if (aKeys.length !== bKeys.length) return false; // same set of keys (order-insensitive)
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!deepJsonEqual(ao[k], bo[k])) return false;
  }
  return true;
};

const jsonEq = (a: unknown, b: unknown): boolean => deepJsonEqual(a, b);

/**
 * Boundary-aware host matching: `host` must equal `needle` exactly or be a proper subdomain of it.
 * `evilanthropic.com` does NOT match `anthropic.com`; `x.anthropic.com` does.
 *
 * Both sides are normalized (lowercase + trailing-dot strip) so an author needle that differs from the
 * recorded host only in case or a trailing dot still matches the way runtime egress matching does.
 * Normalization is COMPOSED onto the existing subdomain semantics, not a replacement — the
 * `endsWith("." + needle)` proper-subdomain rule is preserved.
 */
export function hostMatches(host: string, needle: string): boolean {
  const h = normalizeHost(host);
  const n = normalizeHost(needle);
  return h === n || h.endsWith("." + n);
}

export interface AssertContext {
  transcript: string;
  toolsCalled: Set<string>;
  subagentTools: Set<string>;
  egress: RunResult["egress"];
  result: "success" | "error";
  workRoot: string; // dir under which file_exists paths resolve (L0: work/, L1/L2: work/session/mnt)
  userVisiblePrefixes: string[]; // path prefixes promoted to the user (e.g. outputs, .projects)
  /** workRoot-relative paths under userVisiblePrefixes BEFORE the agent ran (RunResult.preRunPaths /
   *  cassette.preRunPaths). undefined = no pre-run manifest (older run/cassette, or microvm) —
   *  no_unexpected_files then fails evidence-unavailable, never vacuous-passes. */
  preRunPaths?: string[];
  outputsDeletes: string[]; // delete ops that touched mnt/outputs (post-run scan)
  questions: string[]; // AskUserQuestion question texts asked
  hostPathLeaked: boolean; // a host path (/Users//opt) appeared in model-visible text
  selfHealRan: boolean; // a /sessions/<id>/mnt plugin script was invoked (plugin-root self-heal)
  subagents: { agentType: string; declaredTools: string[]; toolsUsed: string[]; description?: string }[]; // dispatch tree (sub-agent assertions)
  gateDeliveries: {
    question: string;
    delivered: boolean | null;
    error?: string;
    reason?: "ok" | "errored" | "unobserved" | "no-pairing-metadata";
  }[]; // per-gate answer-delivery outcome
  toolResultTexts: string[]; // assertion-fidelity text for each tool result (assertText ?? text, 10 KB cap)
  /** Parallel to toolResultTexts; true for each entry that fell back to display text (assertText absent).
   *  Only relevant for old/partial cassettes — live/replay always capture assertText. */
  toolResultsTruncated?: boolean[];
  /** Set by verify-run only when run.jsonl is absent/unreadable. Prevents negative transcript assertions
   *  from passing vacuously on missing evidence (absent ≠ empty). Undefined/false on live and replay lanes. */
  transcriptMissing?: boolean;
  /** Set by verify-run only when trace.json is absent/unreadable. Prevents questions_count_max from
   *  passing vacuously on missing evidence (absent ≠ zero questions). Undefined/false on live/replay lanes. */
  questionsMissing?: boolean;
  /** Set by verify-run only when `result.toolResults` is undefined in result.json (partial/old run).
   *  Prevents tool_result_not_contains from passing vacuously (absent ≠ empty). Undefined/false on
   *  live/replay lanes, where the structure is always present (empty = proof-of-absence). */
  toolResultsMissing?: boolean;
  /** Set by verify-run only when `result.toolCounts` is undefined in result.json (partial/old run).
   *  Prevents tool_not_called from passing vacuously (absent ≠ empty). Undefined/false on live/replay. */
  toolsCalledMissing?: boolean;
  /** Set by verify-run only when `result.subagents` is undefined in result.json (partial/old run).
   *  Prevents subagent_tool_absent / subagent_declared_but_unused / dispatch_count_max from passing
   *  vacuously (absent ≠ no sub-agents). Undefined/false on live/replay. */
  subagentsMissing?: boolean;
  /** Set by verify-run only when `result.scan` is undefined in result.json (partial/old run).
   *  Prevents no_delete_in_outputs / transcript_no_host_path / self_heal_ran from passing vacuously
   *  on default-false/empty scan fields (absent ≠ clean scan). Undefined/false on live/replay, where
   *  the scan structure is always populated (empty = proof-of-absence). */
  scanMissing?: boolean;
  /** Set by verify-run only when `result.gateDeliveries` is undefined in result.json (partial/old run).
   *  Prevents gate_answers_delivered / gate_answer_count_min from passing vacuously on a collapsed-to-[]
   *  gateDeliveries; absent ≠ zero gates. Undefined/false on live/replay, where gateDeliveries is always
   *  populated (empty = genuine zero gates fired). */
  gateDeliveriesMissing?: boolean;
  /** Relative paths of artifacts written as 0-byte placeholders in the cassette (truncated: true entries).
   *  Set by replay lane from materializeManifest(); empty set on live and verify-run lanes. */
  truncatedPaths?: Set<string>;
  /** workRoot-relative mount prefixes of read-only (`mode:r`) connected folders — captured body-less
   *  (see buildManifest's `bodyLessPrefixes`). On the LIVE/verify-run lanes the real file is on disk, so
   *  content assertions would evaluate it and PASS, while replay (0-byte placeholder) cannot — a
   *  green-record/red-replay asymmetry. Content keys (artifact_json) therefore treat a target under one
   *  of these prefixes as evidence-unavailable on EVERY lane, matching what `truncatedPaths` forces on
   *  replay. Existence keys (file_exists/user_visible_artifact) are unaffected (existence is provable
   *  from the recorded hash). Undefined/empty when there is no read-only folder. */
  readonlyFolderRoots?: string[];
  /** Skill/plugin ids invoked via the Skill tool_use event, in call order (duplicates kept). */
  skillsInvoked: string[];
  /** Whether the agent's init tool list included "Skill". False/never-observed means
   *  skill_triggered/no_skill_triggered cannot be evaluated (agent-version tool-name drift) and must fail
   *  as evidence-unavailable rather than risk a false negative. */
  skillToolAvailable: boolean;
  /** Set by verify-run only when `result.skillsInvoked` is undefined in result.json (a run predating E8).
   *  Prevents no_skill_triggered from passing vacuously (absent ≠ no skills invoked). Undefined/false on
   *  live/replay. */
  skillsInvokedMissing?: boolean;
  /** RunResult.cost.usd — undefined when cost telemetry wasn't recorded for this run (a run predating
   *  Wave 0, or the SDK didn't report total_cost_usd for this invocation). Its own undefined-ness IS the
   *  evidence-unavailable signal for max_cost_usd — a real cost is always a defined number, including 0. */
  costUsd?: number;
  /** usage.input_tokens + usage.output_tokens — undefined when either isn't a number (a run predating
   *  Wave 0, or a partial/old result.json). Own undefined-ness is the evidence-unavailable signal. */
  tokensTotal?: number;
  /** Sum of toolCounts values (top-level calls only) — undefined when result.toolCounts itself is
   *  undefined (partial/old result.json), never 0 in that case (0 = genuinely zero tool calls, a real
   *  value). Own undefined-ness is the evidence-unavailable signal. */
  toolCallsTotal?: number;
  /** usage.turns (Wave 0's extraction/fallback-count) — undefined when a run predates that seam or the
   *  SDK reported neither num_turns nor a countable fallback. Own undefined-ness is the
   *  evidence-unavailable signal for max_turns (Wave 2 / E6b) — 0 turns is a real, satisfying value. */
  turns?: number;
  /** The fidelity tier actually used this run (`RunResult.effectiveFidelity`) — used only to make
   *  `computer_links_resolve`'s failure message name the tier it checked against; no branching in
   *  `check()` reads this directly (the mode split lives in `linkResolution.mode`). Undefined on an
   *  old result/cassette that predates the field; the message just omits the tier then. */
  effectiveFidelity?: string;
  /** `computer_links_resolve` (P3) resolution context — see `src/run/computer-links.ts`. Undefined
   *  means the calling lane hasn't wired this: any `computer://` link found then fails as
   *  evidence-unavailable rather than silently passing (the evidence-missing convention this file
   *  follows everywhere else — e.g. `transcriptMissing`, `scanMissing`). */
  linkResolution?: LinkResolutionContext;
}

export function evaluate(assertions: Assertion[], ctx: AssertContext): RunResult["assertions"] {
  return assertions.map((a) => check(a, ctx));
}

type KeyResult = { pass: true } | { pass: false; message: string };

/**
 * Evaluate EVERY present key (AND semantics) — a multi-key assertion passes iff all of its
 * keys pass. (The previous first-key-wins `if (a.X) return …` chain silently ignored every key
 * after the first.) The per-key logic is unchanged; each branch now PUSHES its result instead of
 * returning. The first failing key supplies the surfaced message. On the replay lane, keys that
 * cannot be evaluated (filesystem/egress, or question/gate when controlOut is absent) are stripped
 * from the object BEFORE this runs (see replayCassette), so AND never straddles replay classes.
 */
function check(a: Assertion, ctx: AssertContext): { assertion: Assertion; pass: boolean; message?: string } {
  const results: KeyResult[] = [];
  const ok = (): KeyResult => ({ pass: true });
  const fail = (message: string): KeyResult => ({ pass: false, message });
  const truncated = ctx.truncatedPaths ?? new Set<string>();

  if (a.transcript_contains !== undefined)
    results.push(
      ctx.transcriptMissing
        ? fail(`evidence unavailable: transcript sidecar (run.jsonl) absent — cannot evaluate transcript_contains`)
        : ctx.transcript.includes(a.transcript_contains)
          ? ok()
          : fail(`transcript missing "${a.transcript_contains}"`),
    );
  if (a.transcript_not_contains !== undefined)
    results.push(
      ctx.transcriptMissing
        ? fail(`evidence unavailable: transcript sidecar (run.jsonl) absent — cannot evaluate transcript_not_contains`)
        : !ctx.transcript.includes(a.transcript_not_contains)
          ? ok()
          : fail(`transcript unexpectedly contains "${a.transcript_not_contains}"`),
    );
  if (a.tool_result_contains !== undefined)
    results.push(
      ctx.toolResultTexts.some((t) => t.includes(a.tool_result_contains!))
        ? ok()
        : fail(`no tool result contained "${a.tool_result_contains}"`),
    );
  if (a.tool_result_not_contains !== undefined) {
    if (ctx.toolResultsMissing) {
      results.push(fail(`evidence unavailable: tool results absent from result.json — cannot evaluate tool_result_not_contains`));
    } else {
      const forbidden = a.tool_result_not_contains;
      const positiveHit = ctx.toolResultTexts.some((t) => t.includes(forbidden));
      if (positiveHit) {
        results.push(fail(`a tool result unexpectedly contained "${forbidden}"`));
      } else {
        const hasTruncatedAbsence =
          ctx.toolResultsTruncated !== undefined &&
          ctx.toolResultTexts.some((t, i) => !t.includes(forbidden) && ctx.toolResultsTruncated![i] === true);
        results.push(
          hasTruncatedAbsence
            ? fail(
                `evidence unavailable: one or more tool results are display-truncated (no assertText) — cannot rule out forbidden substring`,
              )
            : ok(),
        );
      }
    }
  }
  // Fuzzy content for stochastic prose. All regex-building assertions are try/catch-wrapped —
  // `evaluate()` is a bare `.map(check)` with no error boundary, so a malformed pattern must be a
  // clean assertion failure, not an uncaught throw. Case-insensitive ("i").
  if (a.transcript_matches !== undefined) {
    if (ctx.transcriptMissing) {
      results.push(fail(`evidence unavailable: transcript sidecar (run.jsonl) absent — cannot evaluate transcript_matches`));
    } else {
      const c = compileUserRegex(a.transcript_matches);
      if ("error" in c) results.push(fail(`transcript_matches: bad regex "${a.transcript_matches}": ${c.error}`));
      else results.push(c.re.test(ctx.transcript) ? ok() : fail(`transcript did not match /${a.transcript_matches}/i`));
    }
  }
  if (a.transcript_not_matches !== undefined) {
    if (ctx.transcriptMissing) {
      results.push(fail(`evidence unavailable: transcript sidecar (run.jsonl) absent — cannot evaluate transcript_not_matches`));
    } else {
      const c = compileUserRegex(a.transcript_not_matches);
      if ("error" in c) results.push(fail(`transcript_not_matches: bad regex "${a.transcript_not_matches}": ${c.error}`));
      else results.push(!c.re.test(ctx.transcript) ? ok() : fail(`transcript unexpectedly matched /${a.transcript_not_matches}/i`));
    }
  }
  if (a.file_exists !== undefined) {
    const abs = containedPath(ctx.workRoot, a.file_exists);
    if (!abs) results.push(fail(`unsafe file_exists path "${a.file_exists}" — must stay under the work root (no absolute paths or "..")`));
    else {
      const relPath = relative(resolve(ctx.workRoot), abs);
      if (truncated.has(relPath)) {
        // A truncated manifest entry carries path+bytes+sha256 — positive proof the file existed at
        // record time. Existence is provable without the inlined body; only content assertions need it.
        results.push(ok());
      } else {
        // verify the real path (after symlink resolution) is still under workRoot.
        const real = containedRealPath(ctx.workRoot, abs);
        if (!real) results.push(fail(`unsafe file_exists path "${a.file_exists}" — symlink target escapes the work root`));
        else results.push(existsSync(real) ? ok() : fail(`file not found: ${a.file_exists} (under ${ctx.workRoot})`));
      }
    }
  }
  if (a.user_visible_artifact !== undefined) {
    const p = a.user_visible_artifact;
    const abs = containedPath(ctx.workRoot, p);
    if (!abs) {
      // normalize/contain BEFORE the prefix test so `outputs/../../x` can't pass startsWith("outputs/")
      results.push(fail(`unsafe user_visible_artifact path "${p}" — must stay under the work root (no absolute paths or "..")`));
    } else {
      const rel = relative(resolve(ctx.workRoot), abs); // normalized, guaranteed under workRoot
      if (truncated.has(rel)) {
        // Truncated entry proves existence (path+bytes+sha256 recorded). Promotion is a path-prefix
        // property — also knowable without the body. Pass if under a user-visible prefix.
        const visible = ctx.userVisiblePrefixes.some((pre) => rel === pre || rel.startsWith(pre + "/"));
        results.push(
          visible
            ? ok()
            : fail(`"${p}" is not under a user-visible prefix (${ctx.userVisiblePrefixes.join(", ")}) — invisible to the user in Cowork`),
        );
      } else {
        const visible = ctx.userVisiblePrefixes.some((pre) => rel === pre || rel.startsWith(pre + "/"));
        if (!visible)
          results.push(
            fail(`"${p}" is not under a user-visible prefix (${ctx.userVisiblePrefixes.join(", ")}) — invisible to the user in Cowork`),
          );
        else {
          // verify the real path (after symlink resolution) is still under workRoot.
          const real = containedRealPath(ctx.workRoot, abs);
          if (!real) results.push(fail(`unsafe user_visible_artifact path "${p}" — symlink target escapes the work root`));
          else results.push(existsSync(real) ? ok() : fail(`user-visible artifact not found: ${p}`));
        }
      }
    }
  }
  if (a.tool_called !== undefined) results.push(ctx.toolsCalled.has(a.tool_called) ? ok() : fail(`tool not called: ${a.tool_called}`));
  if (a.tool_not_called !== undefined)
    results.push(
      ctx.toolsCalledMissing
        ? fail(`evidence unavailable: tool counts absent from result.json — cannot evaluate tool_not_called`)
        : !ctx.toolsCalled.has(a.tool_not_called)
          ? ok()
          : fail(`tool unexpectedly called: ${a.tool_not_called}`),
    );
  if (a.subagent_tool_used !== undefined)
    results.push(ctx.subagentTools.has(a.subagent_tool_used) ? ok() : fail(`sub-agent did not use: ${a.subagent_tool_used}`));
  if (a.subagent_tool_absent !== undefined)
    results.push(
      ctx.subagentsMissing
        ? fail(`evidence unavailable: sub-agent dispatch tree absent from result.json — cannot evaluate subagent_tool_absent`)
        : !ctx.subagentTools.has(a.subagent_tool_absent)
          ? ok()
          : fail(`sub-agent unexpectedly used: ${a.subagent_tool_absent}`),
    );
  if (a.subagent_dispatched !== undefined) {
    // Match the agentType OR the description — skills often dispatch with only a `description`
    // (no subagent_type → agentType "unknown"), so name-matching alone would miss those.
    const c = compileUserRegex(a.subagent_dispatched);
    if ("error" in c) results.push(fail(`subagent_dispatched: bad regex "${a.subagent_dispatched}": ${c.error}`));
    else
      results.push(
        ctx.subagents.some((s) => c.re.test(s.agentType) || c.re.test(s.description ?? ""))
          ? ok()
          : fail(`no sub-agent matching "${a.subagent_dispatched}" was dispatched (by type or description)`),
      );
  }
  if (a.subagent_declared_but_unused !== undefined) {
    const t = a.subagent_declared_but_unused;
    // Declared a tool but never USED it — the observable proxy for the v0.3.0 fabrication
    // class. Previously also required `toolsUsed.length === 0`, which let "declared Bash, used Read"
    // pass; dropping that clause catches the broader declared-but-unused case.
    if (ctx.subagentsMissing) {
      // Fabrication-detection assertion: find(...) returns undefined on an absent dispatch tree, which
      // would pass vacuously. Absent evidence ≠ proof no sub-agent left a tool declared-but-unused.
      results.push(
        fail(`evidence unavailable: sub-agent dispatch tree absent from result.json — cannot evaluate subagent_declared_but_unused`),
      );
    } else {
      const culprit = ctx.subagents.find((s) => s.declaredTools.includes(t) && !s.toolsUsed.includes(t));
      results.push(
        culprit
          ? fail(`sub-agent "${culprit.agentType}" declared "${t}" but never used it (used: ${culprit.toolsUsed.join(", ") || "none"})`)
          : ok(),
      );
    }
  }
  if (a.dispatch_count_max !== undefined)
    results.push(
      ctx.subagentsMissing
        ? fail(`evidence unavailable: sub-agent dispatch tree absent from result.json — cannot evaluate dispatch_count_max`)
        : ctx.subagents.length <= a.dispatch_count_max
          ? ok()
          : fail(
              `dispatched ${ctx.subagents.length} sub-agents, max ${a.dispatch_count_max} (author-chosen budget; Cowork imposes no in-conversation Task-dispatch cap — see SPEC §10)`,
            ),
    );
  if (a.skill_triggered !== undefined) {
    const c = compileUserRegex(a.skill_triggered);
    if ("error" in c) results.push(fail(`skill_triggered: bad regex "${a.skill_triggered}": ${c.error}`));
    else if (!ctx.skillToolAvailable)
      results.push(
        fail(
          `evidence unavailable: this agent's init tool list has no "Skill" tool — cannot evaluate skill_triggered (agent-version drift?)`,
        ),
      );
    else
      results.push(
        ctx.skillsInvoked.some((s) => c.re.test(s))
          ? ok()
          : fail(`no invoked skill matched "${a.skill_triggered}" (invoked: ${ctx.skillsInvoked.join(", ") || "none"})`),
      );
  }
  if (a.max_cost_usd !== undefined)
    results.push(
      ctx.costUsd === undefined
        ? fail(`evidence unavailable: cost telemetry absent — cannot evaluate max_cost_usd`)
        : ctx.costUsd <= a.max_cost_usd
          ? ok()
          : fail(`cost $${ctx.costUsd} exceeds max $${a.max_cost_usd}`),
    );
  if (a.max_tokens !== undefined)
    results.push(
      ctx.tokensTotal === undefined
        ? fail(`evidence unavailable: token telemetry absent — cannot evaluate max_tokens`)
        : ctx.tokensTotal <= a.max_tokens
          ? ok()
          : fail(`${ctx.tokensTotal} tokens exceeds max ${a.max_tokens}`),
    );
  if (a.tool_calls_max !== undefined)
    results.push(
      ctx.toolCallsTotal === undefined
        ? fail(`evidence unavailable: tool-count telemetry absent — cannot evaluate tool_calls_max`)
        : ctx.toolCallsTotal <= a.tool_calls_max
          ? ok()
          : fail(`${ctx.toolCallsTotal} tool calls exceeds max ${a.tool_calls_max}`),
    );
  if (a.max_turns !== undefined)
    results.push(
      ctx.turns === undefined
        ? fail(`evidence unavailable: turn telemetry absent — cannot evaluate max_turns`)
        : ctx.turns <= a.max_turns
          ? ok()
          : fail(`${ctx.turns} turns exceeds max ${a.max_turns}`),
    );
  if (a.no_skill_triggered !== undefined) {
    const c = compileUserRegex(a.no_skill_triggered);
    if ("error" in c) results.push(fail(`no_skill_triggered: bad regex "${a.no_skill_triggered}": ${c.error}`));
    else if (!ctx.skillToolAvailable)
      results.push(
        fail(
          `evidence unavailable: this agent's init tool list has no "Skill" tool — cannot evaluate no_skill_triggered (agent-version drift?)`,
        ),
      );
    else if (ctx.skillsInvokedMissing)
      results.push(fail(`evidence unavailable: skill invocation list absent from result.json — cannot evaluate no_skill_triggered`));
    else
      results.push(
        !ctx.skillsInvoked.some((s) => c.re.test(s)) ? ok() : fail(`skill unexpectedly triggered matching "${a.no_skill_triggered}"`),
      );
  }
  if (a.egress_denied !== undefined)
    results.push(
      ctx.egress.some((e) => hostMatches(e.host, a.egress_denied!) && e.decision === "deny")
        ? ok()
        : fail(`expected egress denied: ${a.egress_denied}`),
    );
  if (a.egress_allowed !== undefined)
    results.push(
      ctx.egress.some((e) => hostMatches(e.host, a.egress_allowed!) && e.decision === "allow")
        ? ok()
        : fail(`expected egress allowed: ${a.egress_allowed}`),
    );
  if (a.no_delete_in_outputs !== undefined)
    results.push(
      ctx.scanMissing
        ? fail(`evidence unavailable: post-run scan absent from result.json — cannot evaluate no_delete_in_outputs`)
        : ctx.outputsDeletes.length === 0
          ? ok()
          : fail(`delete op(s) touched outputs (forbidden in Cowork): ${ctx.outputsDeletes.slice(0, 3).join("; ")}`),
    );
  if (a.no_unexpected_files !== undefined) {
    if (ctx.preRunPaths === undefined) {
      results.push(
        fail(
          "evidence unavailable: no pre-run manifest for this run/cassette (predates 0.24 or tier cannot capture — microvm) — cannot compute created files; re-run/re-record on container/hostloop",
        ),
      );
    } else {
      const pre = new Set(ctx.preRunPaths.map((p) => p.replace(/\\/g, "/")));
      const post = collectArtifacts(ctx.workRoot, ctx.userVisiblePrefixes).map((f) => f.path);
      const created = post.filter((p) => !pre.has(p.replace(/\\/g, "/")));
      const stray = created.filter((p) => !anyGlobMatches(a.no_unexpected_files!, p));
      results.push(
        stray.length === 0
          ? ok()
          : fail(
              `unexpected file(s) created outside the allowlist: ${stray.join(", ")} (allow: ${a.no_unexpected_files!.join(", ") || "(none)"})`,
            ),
      );
    }
  }
  if (a.self_heal_ran !== undefined)
    results.push(
      ctx.scanMissing
        ? fail(`evidence unavailable: post-run scan absent from result.json — cannot evaluate self_heal_ran`)
        : ctx.selfHealRan === a.self_heal_ran
          ? ok()
          : fail(`self_heal_ran was ${ctx.selfHealRan}, expected ${a.self_heal_ran}`),
    );
  // Verdict modifiers (consumed by computeVerdict, not here) each always "pass" as an assertion, so a
  // standalone `{allow_*: true}` is a valid non-empty assertion, not "empty assertion". Derived from the
  // single VERDICT_MODIFIER_KEYS list so a newly-added modifier can never miss this branch again.
  for (const k of VERDICT_MODIFIER_KEYS) if (a[k] !== undefined) results.push(ok());
  if (a.transcript_no_host_path !== undefined)
    results.push(
      ctx.scanMissing
        ? fail(`evidence unavailable: post-run scan absent from result.json — cannot evaluate transcript_no_host_path`)
        : !ctx.hostPathLeaked === a.transcript_no_host_path
          ? ok()
          : fail(`host path leaked into model-visible text: ${ctx.hostPathLeaked}`),
    );
  if (a.computer_links_resolve !== undefined) {
    if (ctx.transcriptMissing) {
      results.push(fail(`evidence unavailable: transcript sidecar (run.jsonl) absent — cannot evaluate computer_links_resolve`));
    } else {
      const links = extractComputerLinks(ctx.transcript);
      if (links.length === 0) {
        // Presence-gated by design (see the schema description): zero links in the transcript passes —
        // an author combines this with transcript_contains to also require a link be present.
        results.push(ok());
      } else if (!ctx.linkResolution) {
        results.push(
          fail(
            `evidence unavailable: no link-resolution context wired for this lane — cannot evaluate computer_links_resolve (${links.length} link(s) found)`,
          ),
        );
      } else {
        const tierNote = ctx.effectiveFidelity ? ` (tier: ${ctx.effectiveFidelity})` : "";
        const dangling = links
          .map((link) => ({ link, outcome: resolveComputerLink(link, ctx.workRoot, ctx.linkResolution!) }))
          .filter(({ outcome }) => !outcome.resolved)
          .map(({ link, outcome }) => `computer://${link.raw} — checked ${outcome.checkedDescription}`);
        results.push(dangling.length === 0 ? ok() : fail(`dangling computer:// link(s)${tierNote}: ${dangling.join("; ")}`));
      }
    }
  }
  if (a.question_asked !== undefined) {
    if (ctx.questionsMissing) {
      results.push(fail(`evidence unavailable: questions sidecar (trace.json) absent — cannot evaluate question_asked`));
    } else {
      const c = compileUserRegex(a.question_asked);
      if ("error" in c) results.push(fail(`question_asked: bad regex "${a.question_asked}": ${c.error}`));
      else results.push(ctx.questions.some((q) => c.re.test(q)) ? ok() : fail(`no question matched: ${a.question_asked}`));
    }
  }
  if (a.questions_count_max !== undefined)
    results.push(
      ctx.questionsMissing
        ? fail(`evidence unavailable: questions sidecar (trace.json) absent — cannot evaluate questions_count_max`)
        : ctx.questions.length <= a.questions_count_max
          ? ok()
          : fail(`asked ${ctx.questions.length} questions, max ${a.questions_count_max}`),
    );
  if (a.gate_answers_delivered !== undefined) {
    // Passes iff every answered gate's tool_result was OBSERVED and non-error. On a finished
    // run/cassette, an unobserved delivery (delivered=null) is NOT neutral — it is absence of the
    // evidence the assertion requires, so it fails loud ("no silent false-greens"). `delivered:
    // false` is a real errored tool_result; `null` is "no tool_result observed for this gate".
    // Zero gates fired passes vacuously (whether a gate fires is model-dependent) — pair with
    // gate_answer_count_min to also require presence. Missing telemetry (gateDeliveriesMissing)
    // is NOT the same as zero gates and must fail evidence-unavailable, not vacuous-pass.
    if (ctx.gateDeliveriesMissing) {
      results.push(fail(`evidence unavailable: gate-delivery telemetry absent from result.json — cannot evaluate gate_answers_delivered`));
    } else if (a.gate_answers_delivered) {
      const bad = ctx.gateDeliveries.filter((g) => g.delivered !== true);
      results.push(
        bad.length === 0
          ? ok()
          : fail(
              `gate answer(s) not confirmed delivered to the model: ${bad
                .map(
                  (g) =>
                    `"${g.question}" (${
                      g.delivered === false
                        ? (g.error ?? "tool error")
                        : g.reason === "no-pairing-metadata"
                          ? "no pairing metadata — gate had no toolUseId"
                          : "delivery unobserved — no tool_result for this gate"
                    })`,
                )
                .join("; ")}`,
            ),
      );
    } else {
      // inverse: expect a CONFIRMED delivery failure (a real errored tool_result), not merely unobserved.
      const failedConfirmed = ctx.gateDeliveries.filter((g) => g.delivered === false);
      results.push(failedConfirmed.length > 0 ? ok() : fail(`expected a confirmed gate-delivery failure but none was observed`));
    }
  }
  if (a.gate_answer_count_min !== undefined) {
    if (ctx.gateDeliveriesMissing) {
      results.push(fail(`evidence unavailable: gate-delivery telemetry absent from result.json — cannot evaluate gate_answer_count_min`));
    } else {
      const delivered = ctx.gateDeliveries.filter((g) => g.delivered === true).length;
      results.push(
        delivered >= a.gate_answer_count_min
          ? ok()
          : fail(`only ${delivered} gate answer(s) confirmed delivered, need ≥ ${a.gate_answer_count_min}`),
      );
    }
  }
  if (a.artifact_json !== undefined) {
    const aj = a.artifact_json;
    const file = containedPath(ctx.workRoot, aj.artifact);
    if (!file) results.push(fail(`unsafe artifact_json path "${aj.artifact}" — must stay under the work root (no absolute paths or "..")`));
    else {
      // verify the real path (after symlink resolution) is still under workRoot.
      const realFile = containedRealPath(ctx.workRoot, file);
      // A body-less manifest entry (a read-only connected-folder input, or an artifact over the body
      // cap) has no content in the cassette — artifact_json cannot be evaluated on replay (the 0-byte
      // placeholder isn't parseable). To keep record/verify-run/replay SYMMETRIC (no green-record →
      // red-replay), treat such a target as evidence-unavailable on EVERY lane: `truncatedPaths` flags
      // it on replay; `readonlyFolderRoots` flags the read-only-input case on the live/verify-run lanes
      // where the real file is still on disk. (Existence keys stay green — existence is provable from
      // the recorded hash — but content is genuinely absent, so this fails loud, never vacuous.)
      const rel = relative(resolve(ctx.workRoot), file);
      const isReadonlyInput = (ctx.readonlyFolderRoots ?? []).some((pre) => rel === pre || rel.startsWith(pre + "/"));
      const bodyLess = truncated.has(rel) || isReadonlyInput;
      if (!realFile) {
        results.push(fail(`unsafe artifact_json path "${aj.artifact}" — symlink target escapes the work root`));
      } else if (!existsSync(realFile)) {
        results.push(fail(`artifact_json: file not found: ${aj.artifact} (under ${ctx.workRoot})`));
      } else if (bodyLess) {
        // On live/verify-run `isReadonlyInput` pinpoints the cause (a read-only input) — give the exact
        // remedy. On replay the cassette records only `truncated:true` (not WHY), so the cause is
        // ambiguous — name BOTH so the remedy is never wrong (a stale "raise --max-artifact-bytes" hint
        // for a read-only input would send the author chasing a record loop that can't help).
        results.push(
          fail(
            `evidence unavailable: artifact_json target "${aj.artifact}" was captured body-less ` +
              (isReadonlyInput
                ? `(read-only connected-folder input — its content is never captured; assert artifact_json on a deliverable instead)`
                : `(a read-only connected-folder input, or an artifact larger than the body cap — if an input, assert on a deliverable; if a large deliverable, raise --max-artifact-bytes)`) +
              ` — content is not in the cassette, so it cannot be evaluated on replay`,
          ),
        );
      } else {
        let doc: unknown;
        let parsed = true;
        const fileSizeLimit = 10 * 1024 * 1024;
        const fileSize = statSync(realFile).size;
        if (fileSize > fileSizeLimit) {
          results.push(fail(`artifact_json: file too large to parse as JSON (${fileSize} bytes, limit 10 MiB)`));
          parsed = false;
        }
        try {
          if (parsed) doc = JSON.parse(readFileSync(realFile, "utf8"));
        } catch (e) {
          parsed = false;
          results.push(fail(`artifact_json: ${aj.artifact} is not valid JSON: ${String((e as Error).message)}`));
        }
        if (parsed) {
          const r = resolveDotPath(doc, aj.path);
          if (r.state === "unresolved") {
            // Malformed/truncated artifact for this path — fail loud, NOT a vacuous "absent" pass (the
            // false-green at the field level).
            results.push(
              fail(`artifact_json: path "${aj.path}" unresolvable in ${aj.artifact} — intermediate "${r.at}" is missing or not an object`),
            );
          } else {
            const present = r.state === "value";
            const val = r.state === "value" ? r.value : undefined;
            let any = false;
            if (aj.exists !== undefined) {
              any = true;
              results.push(
                present === aj.exists ? ok() : fail(`artifact_json: "${aj.path ?? "(root)"}" exists=${present}, expected ${aj.exists}`),
              );
            }
            if (aj.absent !== undefined) {
              any = true;
              const absent = r.state === "absent";
              results.push(absent === aj.absent ? ok() : fail(`artifact_json: "${aj.path}" absent=${absent}, expected ${aj.absent}`));
            }
            if (aj.is_null !== undefined) {
              any = true;
              if (!present) {
                results.push(
                  fail(
                    `artifact_json: "${aj.path ?? "(root)"}" is_null: path is absent — cannot determine null-ness (use absent: true to assert absence)`,
                  ),
                );
              } else {
                const isNull = val === null;
                results.push(
                  isNull === aj.is_null ? ok() : fail(`artifact_json: "${aj.path ?? "(root)"}" is_null=${isNull}, expected ${aj.is_null}`),
                );
              }
            }
            if (aj.equals !== undefined) {
              any = true;
              results.push(
                present && jsonEq(val, aj.equals)
                  ? ok()
                  : fail(`artifact_json: "${aj.path}" = ${JSON.stringify(val)}, expected ${JSON.stringify(aj.equals)}`),
              );
            }
            if (aj.gt !== undefined) {
              any = true;
              results.push(
                typeof val === "number" && val > aj.gt
                  ? ok()
                  : fail(`artifact_json: "${aj.path}" = ${JSON.stringify(val)}, expected > ${aj.gt}`),
              );
            }
            // Set membership — the resolved value deep-equals one of a fixed set. Stable for stochastic
            // (LLM-extracted) values where `equals` would churn across re-records. `present &&` guard mirrors
            // `equals` so an absent value never vacuously satisfies it.
            if (aj.in !== undefined) {
              any = true;
              results.push(
                present && Array.isArray(aj.in) && aj.in.some((x) => jsonEq(val, x))
                  ? ok()
                  : fail(`artifact_json: "${aj.path}" = ${JSON.stringify(val)}, expected one of ${JSON.stringify(aj.in)}`),
              );
            }
            // No operator → an existence assertion (the value must be present).
            if (!any)
              results.push(
                present ? ok() : fail(`artifact_json: "${aj.path ?? "(root)"}" is not present (no operator given → existence check)`),
              );
          }
        }
      }
    }
  }
  if (a.result !== undefined) results.push(ctx.result === a.result ? ok() : fail(`result was ${ctx.result}, expected ${a.result}`));

  if (results.length === 0) return { assertion: a, pass: false, message: "empty assertion" };
  const firstFail = results.find((r): r is { pass: false; message: string } => !r.pass);
  return firstFail ? { assertion: a, pass: false, message: firstFail.message } : { assertion: a, pass: true };
}
