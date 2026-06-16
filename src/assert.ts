import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Assertion, RunResult } from "./types.js";

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
    let re: RegExp | undefined;
    try {
      re = new RegExp(a.transcript_matches, "i");
    } catch (e) {
      results.push(fail(`transcript_matches: bad regex "${a.transcript_matches}": ${String((e as Error).message)}`));
    }
    if (re) results.push(re.test(ctx.transcript) ? ok() : fail(`transcript did not match /${a.transcript_matches}/i`));
  }
  if (a.transcript_not_matches !== undefined) {
    let re: RegExp | undefined;
    try {
      re = new RegExp(a.transcript_not_matches, "i");
    } catch (e) {
      results.push(fail(`transcript_not_matches: bad regex "${a.transcript_not_matches}": ${String((e as Error).message)}`));
    }
    if (re) results.push(!re.test(ctx.transcript) ? ok() : fail(`transcript unexpectedly matched /${a.transcript_not_matches}/i`));
  }
  if (a.file_exists !== undefined)
    results.push(existsSync(join(ctx.workRoot, a.file_exists)) ? ok() : fail(`file not found: ${a.file_exists} (under ${ctx.workRoot})`));
  if (a.user_visible_artifact !== undefined) {
    const p = a.user_visible_artifact;
    const visible = ctx.userVisiblePrefixes.some((pre) => p === pre || p.startsWith(pre + "/"));
    if (!visible)
      results.push(
        fail(`"${p}" is not under a user-visible prefix (${ctx.userVisiblePrefixes.join(", ")}) — invisible to the user in Cowork`),
      );
    else results.push(existsSync(join(ctx.workRoot, p)) ? ok() : fail(`user-visible artifact not found: ${p}`));
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
    let rx: RegExp | undefined;
    try {
      rx = new RegExp(a.subagent_dispatched, "i");
    } catch (e) {
      results.push(fail(`subagent_dispatched: bad regex "${a.subagent_dispatched}": ${String((e as Error).message)}`));
    }
    if (rx)
      results.push(
        ctx.subagents.some((s) => rx!.test(s.agentType) || rx!.test(s.description ?? ""))
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
  if (a.transcript_no_host_path !== undefined)
    results.push(
      !ctx.hostPathLeaked === a.transcript_no_host_path ? ok() : fail(`host path leaked into model-visible text: ${ctx.hostPathLeaked}`),
    );
  if (a.question_asked !== undefined) {
    let rx: RegExp | undefined;
    try {
      rx = new RegExp(a.question_asked, "i");
    } catch (e) {
      results.push(fail(`question_asked: bad regex "${a.question_asked}": ${String((e as Error).message)}`));
    }
    if (rx) results.push(ctx.questions.some((q) => rx!.test(q)) ? ok() : fail(`no question matched: ${a.question_asked}`));
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
  if (a.result !== undefined) results.push(ctx.result === a.result ? ok() : fail(`result was ${ctx.result}, expected ${a.result}`));

  if (results.length === 0) return { assertion: a, pass: false, message: "empty assertion" };
  const firstFail = results.find((r): r is { pass: false; message: string } => !r.pass);
  return firstFail ? { assertion: a, pass: false, message: firstFail.message } : { assertion: a, pass: true };
}
