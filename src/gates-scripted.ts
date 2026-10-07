// `gates_all_scripted`: every gate that fired was answered by a scripted rule, so nothing stood in for a human
// (the LLM decider, `first`, an external or human decider, or cowork parity's permissive auto-allow).
//
// Evidence is `RunResult.decisions`, attributed by `by`. Replay answers every gate from the recording, so there
// `by` is always "replay" and each gate is re-classified against the cassette's FROZEN `answers:` with the scripted
// decider's own lookup. That is exact for question gates: the scripted decider runs first in the chain and, when
// its rules cover every sub-question, answers the batch itself or throws (it never falls through).
import {
  ScriptedDecider,
  PERMISSIVE_AUTOALLOW_RATIONALE,
  DEFAULT_ALLOW_RATIONALE,
  STRICT_DENY_RATIONALE,
  isDefaultAllowedTool,
} from "./decide/decider.js";
import type { AnswerRule, RunResult } from "./types.js";

type DecisionRow = RunResult["decisions"][number];

export interface GateEvidence {
  /** The run's decisions; undefined when the result carries no decisions channel (an older result.json). */
  decisions: RunResult["decisions"] | undefined;
  /** Every sub-question asked (`RunRecord.questions`), captured at ask time, so a gate the run never answered shows. */
  questions: string[];
  questionsMissing?: boolean;
  /** Replay only: the cassette's frozen `answers:`, which a `by: "replay"` decision is re-classified against. */
  frozenAnswers?: AnswerRule[];
}

export type GatesAllScriptedOpt = true | { include_permissions?: boolean };

/** Every `by` the decider chain records. Anything else is unattributable, never assumed scripted. */
const KNOWN_BY = new Set([
  "scripted",
  "cowork",
  "strict",
  "human",
  "llm",
  "agent",
  "external",
  "first",
  "fail",
  "replay",
  "abstain-fallback",
  "none",
]);
const WORKSPACE_WEB_FETCH_TOOL = "mcp__workspace__web_fetch";

type Verdict = { kind: "scripted" } | { kind: "not"; why: string } | { kind: "unavailable"; why: string };

function labelsOf(d: DecisionRow): string[] {
  if (d.questions?.length) return d.questions.map((q) => q.question || q.header || "");
  return d.detail && typeof d.detail === "object" ? Object.keys(d.detail as object) : [];
}

function classifyQuestion(d: DecisionRow, rules: ScriptedDecider | null | undefined): Verdict {
  if (d.by === "scripted") return { kind: "scripted" };
  if (d.by === "replay") {
    if (rules === undefined) return { kind: "unavailable", why: "answered from a recording with no frozen answers to classify it against" };
    if (rules === null) return { kind: "unavailable", why: "the cassette's frozen answers do not compile" };
    const qs = d.questions?.length ? d.questions : labelsOf(d).map((question) => ({ question }));
    if (!qs.length) return { kind: "unavailable", why: "the recorded gate carries no question text" };
    const missed = rules.unansweredOf(qs);
    return missed.length === 0
      ? { kind: "scripted" }
      : { kind: "not", why: `no frozen rule answers ${missed.map((m) => JSON.stringify(m)).join(", ")}` };
  }
  if (d.by === undefined || !KNOWN_BY.has(d.by)) return { kind: "unavailable", why: `unattributed answer (by: ${d.by ?? "absent"})` };
  return { kind: "not", why: `answered by ${d.by}` };
}

function classifyPermission(d: DecisionRow, rules: ScriptedDecider | null | undefined): Verdict {
  switch (d.by) {
    case "scripted":
      return { kind: "scripted" };
    // The harness's own fixed rules: the hostloop protected-path gate and a malformed web_fetch request.
    case "agent":
      return { kind: "scripted" };
    // The fail-closed deny when no decider answered: fixed, and nobody stood in.
    case "none":
      return { kind: "scripted" };
    case "cowork":
    case "strict":
      if (d.rationale === PERMISSIVE_AUTOALLOW_RATIONALE) return { kind: "not", why: "permissive off-registry auto-allow (cowork parity)" };
      if (d.rationale === DEFAULT_ALLOW_RATIONALE || d.rationale === STRICT_DENY_RATIONALE) return { kind: "scripted" };
      return { kind: "unavailable", why: `parity default with an unrecognised rationale (${d.rationale ?? "absent"})` };
    case "replay": {
      if (rules === undefined)
        return { kind: "unavailable", why: "answered from a recording with no frozen answers to classify it against" };
      if (rules === null) return { kind: "unavailable", why: "the cassette's frozen answers do not compile" };
      if (rules.answersTool(d.name)) return { kind: "scripted" };
      // A web_fetch gate is decided per domain by whatever terminal the run had; a recording does not say which.
      if (d.name === WORKSPACE_WEB_FETCH_TOOL || d.name.startsWith("webfetch:"))
        return { kind: "unavailable", why: "a replayed web_fetch permission cannot be attributed" };
      if (isDefaultAllowedTool(d.name)) return { kind: "scripted" };
      // No rule and off the registry: the parity default answered. It never abstains here, so an allow is the
      // permissive cowork auto-allow, and a deny is a fixed rule (strict parity, or the hostloop path gate).
      if (d.decision === "allow") return { kind: "not", why: "permissive off-registry auto-allow (cowork parity)" };
      if (d.decision === "deny") return { kind: "scripted" };
      return { kind: "unavailable", why: `replayed permission with outcome ${d.decision}` };
    }
    default:
      if (d.by === undefined || !KNOWN_BY.has(d.by)) return { kind: "unavailable", why: `unattributed answer (by: ${d.by ?? "absent"})` };
      return { kind: "not", why: `answered by ${d.by}` };
  }
}

/** The sub-questions asked that no question decision answered (a multiset difference by text). */
function unanswered(asked: string[], decisions: RunResult["decisions"]): string[] {
  const left = new Map<string, number>();
  for (const d of decisions) if (d.kind === "question") for (const l of labelsOf(d)) left.set(l, (left.get(l) ?? 0) + 1);
  const out: string[] = [];
  for (const q of asked) {
    const n = left.get(q) ?? 0;
    if (n > 0) left.set(q, n - 1);
    else out.push(q);
  }
  return out;
}

const short = (s: string) => JSON.stringify(s.length > 120 ? `${s.slice(0, 117)}...` : s);

export function checkGatesAllScripted(opt: GatesAllScriptedOpt, ev: GateEvidence): { pass: boolean; message: string } {
  const withPermissions = opt !== true && opt.include_permissions === true;
  if (ev.decisions === undefined)
    return { pass: false, message: "evidence unavailable: the result carries no decisions record — cannot tell who answered its gates" };
  if (ev.questionsMissing)
    return {
      pass: false,
      message: "evidence unavailable: the asked-question record is absent — cannot tell whether a gate went unanswered",
    };
  let rules: ScriptedDecider | null | undefined;
  if (ev.frozenAnswers !== undefined) {
    try {
      rules = new ScriptedDecider(ev.frozenAnswers);
    } catch {
      rules = null;
    }
  }
  const questions = ev.decisions.filter((d) => d.kind === "question");
  // An agent error event is recorded as a `tool` row too; it is not a permission gate.
  const permissions = withPermissions ? ev.decisions.filter((d) => d.kind === "tool" && d.decision !== "error") : [];
  const not: string[] = [];
  const unavailable: string[] = [];
  for (const d of questions) {
    const v = classifyQuestion(d, rules);
    const name = labelsOf(d).map(short).join(" / ") || "(no question text)";
    if (v.kind === "not") not.push(`question gate ${name}: ${v.why}`);
    else if (v.kind === "unavailable") unavailable.push(`question gate ${name}: ${v.why}`);
  }
  for (const q of unanswered(ev.questions, ev.decisions)) not.push(`question gate ${short(q)}: asked, but no answer was recorded`);
  for (const d of permissions) {
    const v = classifyPermission(d, rules);
    if (v.kind === "not") not.push(`permission ${d.name} (${d.decision}): ${v.why}`);
    else if (v.kind === "unavailable") unavailable.push(`permission ${d.name} (${d.decision}): ${v.why}`);
  }
  if (not.length)
    return {
      pass: false,
      message:
        `${not.length} gate(s) not answered by a scripted rule — ${not.join("; ")}` +
        (unavailable.length ? ` (and ${unavailable.length} unattributable)` : ""),
    };
  if (unavailable.length) return { pass: false, message: `evidence unavailable: ${unavailable.join("; ")}` };
  const perm = withPermissions ? `, ${permissions.length} permission decision(s) by scripted or fixed rules` : "";
  return {
    pass: true,
    message: questions.length
      ? `all ${questions.length} question gate(s) answered by scripted rules${perm}`
      : `no question gate fired${perm} — pair with gate_answer_count_min or questions_count_max to say whether gates were expected`,
  };
}
