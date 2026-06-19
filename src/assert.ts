import { existsSync, readFileSync, statSync, realpathSync } from "node:fs";
import { join, resolve, relative, isAbsolute, sep } from "node:path";
import type { Assertion, RunResult } from "./types.js";
import { compileUserRegex } from "./regex.js";

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
 * Bug 37: containedPath checks lexical traversal but not symlink targets. A symlink inside the workspace
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
 * #5: resolve a dotted path into a parsed JSON document with THREE distinct outcomes (conflating them
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
 */
export function hostMatches(host: string, needle: string): boolean {
  return host === needle || host.endsWith("." + needle);
}

export interface AssertContext {
  transcript: string;
  toolsCalled: Set<string>;
  subagentTools: Set<string>;
  egress: RunResult["egress"];
  result: "success" | "error";
  workRoot: string; // dir under which file_exists paths resolve (L0: work/, L1/L2: work/session/mnt)
  userVisiblePrefixes: string[]; // path prefixes promoted to the user (e.g. outputs, .projects)
  outputsDeletes: string[]; // delete ops that touched mnt/outputs (post-run scan)
  questions: string[]; // AskUserQuestion question texts asked
  hostPathLeaked: boolean; // a host path (/Users//opt) appeared in model-visible text
  selfHealRan: boolean; // a /sessions/<id>/mnt plugin script was invoked (plugin-root self-heal)
  subagents: { agentType: string; declaredTools: string[]; toolsUsed: string[]; description?: string }[]; // A3 dispatch tree (B2 assertions)
  gateDeliveries: {
    question: string;
    delivered: boolean | null;
    error?: string;
    reason?: "ok" | "errored" | "unobserved" | "no-pairing-metadata";
  }[]; // Part 3: per-gate answer-delivery outcome
}

export function evaluate(assertions: Assertion[], ctx: AssertContext): RunResult["assertions"] {
  return assertions.map((a) => check(a, ctx));
}

type KeyResult = { pass: true } | { pass: false; message: string };

/**
 * #5: evaluate EVERY present key (AND semantics) — a multi-key assertion passes iff all of its
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

  if (a.transcript_contains !== undefined)
    results.push(ctx.transcript.includes(a.transcript_contains) ? ok() : fail(`transcript missing "${a.transcript_contains}"`));
  if (a.transcript_not_contains !== undefined)
    results.push(
      !ctx.transcript.includes(a.transcript_not_contains) ? ok() : fail(`transcript unexpectedly contains "${a.transcript_not_contains}"`),
    );
  // Fuzzy content for stochastic prose. All regex-building assertions are try/catch-wrapped —
  // `evaluate()` is a bare `.map(check)` with no error boundary, so a malformed pattern must be a
  // clean assertion failure, not an uncaught throw. Case-insensitive ("i").
  if (a.transcript_matches !== undefined) {
    const c = compileUserRegex(a.transcript_matches);
    if ("error" in c) results.push(fail(`transcript_matches: bad regex "${a.transcript_matches}": ${c.error}`));
    else results.push(c.re.test(ctx.transcript) ? ok() : fail(`transcript did not match /${a.transcript_matches}/i`));
  }
  if (a.transcript_not_matches !== undefined) {
    const c = compileUserRegex(a.transcript_not_matches);
    if ("error" in c) results.push(fail(`transcript_not_matches: bad regex "${a.transcript_not_matches}": ${c.error}`));
    else results.push(!c.re.test(ctx.transcript) ? ok() : fail(`transcript unexpectedly matched /${a.transcript_not_matches}/i`));
  }
  if (a.file_exists !== undefined) {
    const abs = containedPath(ctx.workRoot, a.file_exists);
    if (!abs) results.push(fail(`unsafe file_exists path "${a.file_exists}" — must stay under the work root (no absolute paths or "..")`));
    else {
      // Bug 37: verify the real path (after symlink resolution) is still under workRoot.
      const real = containedRealPath(ctx.workRoot, abs);
      if (!real) results.push(fail(`unsafe file_exists path "${a.file_exists}" — symlink target escapes the work root`));
      else results.push(existsSync(real) ? ok() : fail(`file not found: ${a.file_exists} (under ${ctx.workRoot})`));
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
      const visible = ctx.userVisiblePrefixes.some((pre) => rel === pre || rel.startsWith(pre + "/"));
      if (!visible)
        results.push(
          fail(`"${p}" is not under a user-visible prefix (${ctx.userVisiblePrefixes.join(", ")}) — invisible to the user in Cowork`),
        );
      else {
        // Bug 37: verify the real path (after symlink resolution) is still under workRoot.
        const real = containedRealPath(ctx.workRoot, abs);
        if (!real) results.push(fail(`unsafe user_visible_artifact path "${p}" — symlink target escapes the work root`));
        else results.push(existsSync(real) ? ok() : fail(`user-visible artifact not found: ${p}`));
      }
    }
  }
  if (a.tool_called !== undefined) results.push(ctx.toolsCalled.has(a.tool_called) ? ok() : fail(`tool not called: ${a.tool_called}`));
  if (a.tool_not_called !== undefined)
    results.push(!ctx.toolsCalled.has(a.tool_not_called) ? ok() : fail(`tool unexpectedly called: ${a.tool_not_called}`));
  if (a.subagent_tool_used !== undefined)
    results.push(ctx.subagentTools.has(a.subagent_tool_used) ? ok() : fail(`sub-agent did not use: ${a.subagent_tool_used}`));
  if (a.subagent_tool_absent !== undefined)
    results.push(!ctx.subagentTools.has(a.subagent_tool_absent) ? ok() : fail(`sub-agent unexpectedly used: ${a.subagent_tool_absent}`));
  if (a.subagent_dispatched !== undefined) {
    // Match the agentType OR the description — skills often dispatch with only a `description`
    // (no subagent_type → agentType "unknown"), so name-matching alone would miss those (O1).
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
    // #25 / B2: declared a tool but never USED it — the observable proxy for the v0.3.0 fabrication
    // class. Previously also required `toolsUsed.length === 0`, which let "declared Bash, used Read"
    // pass; dropping that clause catches the broader declared-but-unused case.
    const culprit = ctx.subagents.find((s) => s.declaredTools.includes(t) && !s.toolsUsed.includes(t));
    results.push(
      culprit
        ? fail(`sub-agent "${culprit.agentType}" declared "${t}" but never used it (used: ${culprit.toolsUsed.join(", ") || "none"})`)
        : ok(),
    );
  }
  if (a.dispatch_count_max !== undefined)
    results.push(
      ctx.subagents.length <= a.dispatch_count_max
        ? ok()
        : fail(`dispatched ${ctx.subagents.length} sub-agents, max ${a.dispatch_count_max} (SPEC §10 cap {global:3})`),
    );
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
      ctx.outputsDeletes.length === 0
        ? ok()
        : fail(`delete op(s) touched outputs (forbidden in Cowork): ${ctx.outputsDeletes.slice(0, 3).join("; ")}`),
    );
  if (a.self_heal_ran !== undefined)
    results.push(ctx.selfHealRan === a.self_heal_ran ? ok() : fail(`self_heal_ran was ${ctx.selfHealRan}, expected ${a.self_heal_ran}`));
  // Verdict modifier (consumed by computeVerdict, not here). It always "passes" as an assertion so a
  // standalone `{allow_permissive_auto_allow: true}` is a valid non-empty assertion, not "empty assertion".
  if (a.allow_permissive_auto_allow !== undefined) results.push(ok());
  if (a.transcript_no_host_path !== undefined)
    results.push(
      !ctx.hostPathLeaked === a.transcript_no_host_path ? ok() : fail(`host path leaked into model-visible text: ${ctx.hostPathLeaked}`),
    );
  if (a.question_asked !== undefined) {
    const c = compileUserRegex(a.question_asked);
    if ("error" in c) results.push(fail(`question_asked: bad regex "${a.question_asked}": ${c.error}`));
    else results.push(ctx.questions.some((q) => c.re.test(q)) ? ok() : fail(`no question matched: ${a.question_asked}`));
  }
  if (a.questions_count_max !== undefined)
    results.push(
      ctx.questions.length <= a.questions_count_max ? ok() : fail(`asked ${ctx.questions.length} questions, max ${a.questions_count_max}`),
    );
  if (a.gate_answers_delivered !== undefined) {
    // #19: passes iff every answered gate's tool_result was OBSERVED and non-error. On a finished
    // run/cassette, an unobserved delivery (delivered=null) is NOT neutral — it is absence of the
    // evidence the assertion requires, so it fails loud ("no silent false-greens"). `delivered:
    // false` is a real errored tool_result; `null` is "no tool_result observed for this gate".
    if (a.gate_answers_delivered) {
      if (ctx.gateDeliveries.length === 0) {
        results.push(
          fail(
            "gate_answers_delivered: no gates were recorded during this run — either no gate fired, or gate delivery tracking is not wired. Expected at least one delivered gate.",
          ),
        );
      }
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
  if (a.artifact_json !== undefined) {
    const aj = a.artifact_json;
    const file = containedPath(ctx.workRoot, aj.artifact);
    if (!file) results.push(fail(`unsafe artifact_json path "${aj.artifact}" — must stay under the work root (no absolute paths or "..")`));
    else {
      // Bug 37: verify the real path (after symlink resolution) is still under workRoot.
      const realFile = containedRealPath(ctx.workRoot, file);
      if (!realFile) {
        results.push(fail(`unsafe artifact_json path "${aj.artifact}" — symlink target escapes the work root`));
      } else if (!existsSync(realFile)) {
        results.push(fail(`artifact_json: file not found: ${aj.artifact} (under ${ctx.workRoot})`));
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
            // Malformed/truncated artifact for this path — fail loud, NOT a vacuous "absent" pass (the H4
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
              const isNull = present && val === null;
              results.push(isNull === aj.is_null ? ok() : fail(`artifact_json: "${aj.path}" is_null=${isNull}, expected ${aj.is_null}`));
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
            // #4: set membership — the resolved value deep-equals one of a fixed set. Stable for stochastic
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
