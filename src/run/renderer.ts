import { writeSync } from "node:fs";
import { tildeify } from "../io.js";
import type { AgentEvent } from "../agent/session.js";
import type { RunHooks } from "./run.js";
import type { RunResult } from "../types.js";
import { computeVerdict, type GuardReport, type GuardStatus } from "./verdict.js";
import { formatGateProvenanceLine } from "./gate-provenance.js";

/**
 * Shared output renderer. The seam is `RunHooks` (attached to `Run` via `executeScenario`): it
 * consumes the live `AgentEvent` stream and writes the HUMAN view to **stderr** (never stdout — that
 * stays machine-only for `--output-format json`). It also buffers the transcript so the CLI can show it on a
 * FAILED `run` (the debug win) instead of making you spelunk `runs/…`. The verdict footer is CLI-side
 * (`renderFooter`) because assertions are evaluated after the run finishes.
 */
export interface RenderPlan {
  live: boolean; // stream assistant text to stderr as it arrives
  progress: boolean; // per-tool-call markers
  verbose: boolean; // + thinking, tool inputs, sub-agent tree
  color: boolean; // ANSI on stderr
  compact: boolean; // --compact/--demo: collapse /sessions/<id>/mnt/ → mnt/ in rendered tool inputs
  /** Display-only VM->host path rewrite (see src/run/display-translate.ts — makeDisplayTranslator
   *  owns the policy of WHEN this runs; the renderer just applies whatever it's handed). Absent
   *  (undefined) is identity — every call site that doesn't build one (replay's cassette.ts renderer,
   *  in particular) renders exactly as before. Applied at every surface a human reads: assistant text
   *  (incl. sub-agent text), tool_use input summaries, and tool_result heads — production deep-walks
   *  every message block, so translating assistant text alone would show a mix of host and `/sessions/`
   *  paths in the same transcript. Never applied to RunRecord/run.jsonl/result.json/events — those stay
   *  the raw, model-visible record.
   */
  translate?: (s: string) => string;
  /** OSC 8 hyperlink decoration (see src/run/display-translate.ts — `linkifyForTerminal` +
   *  `shouldLinkify`, which owns the TTY/CI/env/shareable gate; the renderer just applies whatever
   *  it's handed, same pattern as `translate`). Absent (undefined) is identity. Applied AFTER
   *  `translate`, and ONLY on the live-sink write path for ASSISTANT TEXT (top-level and sub-agent) —
   *  it is never truncated live, and it's where a deliverable `computer://` link actually shows up.
   *  Deliberately NOT applied to tool_use input summaries or tool_result heads: both are hard-sliced
   *  to ~80 chars BEFORE any decoration could run (see `inputSummary` / the tool_result branch
   *  below), and a sliced `computer://` URL wrapped post-slice would be a silently wrong-target link
   *  — plain text is strictly better there than a link to the wrong path. NEVER applied to the
   *  transcript buffer (`dump()`/the failure-footer path) — that stays escape-free, translated-but-
   *  plain text, since it may be piped or copied verbatim.
   */
  linkify?: (s: string) => string;
}
export interface Renderer extends RunHooks {
  dump(): string;
  summary(): { tools: number; subagents: number };
  lastActivity(): number; // ms-epoch of the last streamed event (drives the idle heartbeat)
}

type Sink = (s: string) => void;
const stderr: Sink = (s) => writeSync(2, s); // sync: the footer is the last write before process.exit (pipe-safe)

const TRUNC_CHARS = 2000;
const TRUNC_LINES = 24;

function c(plan: RenderPlan, code: string, s: string): string {
  return plan.color && !process.env.NO_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s;
}
const dim = (p: RenderPlan, s: string) => c(p, "2", s);
const red = (p: RenderPlan, s: string) => c(p, "31", s);
const green = (p: RenderPlan, s: string) => c(p, "32", s);
const bold = (p: RenderPlan, s: string) => c(p, "1", s);

const TOOL_CATEGORY_MARKER: Record<string, string> = {
  Read: "@",
  Glob: "@",
  Grep: "@",
  LS: "@",
  NotebookRead: "@",
  Write: "#",
  Edit: "#",
  NotebookEdit: "#",
  Bash: "!",
  BashOutput: "!",
  KillShell: "!",
  WebFetch: "?",
  WebSearch: "?",
};
/** One-char category prefix for a tool marker line — read (@) / mutate (#) / shell (!) / network (?) /
 *  uncategorized (·, unchanged default). Purely cosmetic; does not affect what's counted or gated. */
export function toolMarker(name: string): string {
  return TOOL_CATEGORY_MARKER[name] ?? "·";
}

function truncate(text: string, verbose: boolean): string {
  if (verbose) return text;
  let t = text;
  const lines = t.split("\n");
  if (lines.length > TRUNC_LINES) t = lines.slice(0, TRUNC_LINES).join("\n") + "\n… (truncated)";
  if (t.length > TRUNC_CHARS) t = t.slice(0, TRUNC_CHARS) + " … (truncated)";
  return t;
}
// Under --compact, collapse the ephemeral cowork session-root prefix (`/sessions/<id>/mnt/` → `mnt/`)
// so shareable output isn't cluttered with long in-container paths. Display-only — the agent's real args
// and run.jsonl are untouched. Covers all cowork-tier session-id shapes (`local_*`, pinned `sess-*`); the
// L0/protocol tier uses host `work/` paths, so this correctly no-ops there. Applied to BOTH `-V` tool
// inputs and the tool_result `→`/`✗` outcome lines, so --compact is consistent across them.
export function collapseSessionRoot(s: string): string {
  return s.replace(/\/sessions\/[^/]+\/mnt\//g, "mnt/");
}

export function inputSummary(input: unknown, compact = false, translate?: (s: string) => string): string {
  try {
    let s = JSON.stringify(input);
    // translate (hostloop display rewrite) runs before compact's collapse — the two are mutually
    // exclusive in practice (shareable output forces translate to identity, see display-translate.ts),
    // but ordering it first keeps the rule "translate real paths, then apply the shareable transform"
    // consistent regardless.
    if (translate) s = translate(s);
    // Run the collapse BEFORE the 80-char slice so a `/mnt/` boundary past char 80 still collapses.
    if (compact) s = collapseSessionRoot(s);
    if (s.length <= 80) return s;
    // tell the reader HOW MUCH was cut — a bare "…" left you guessing whether you were seeing 90 or
    // 9000 chars of input.
    return `${s.slice(0, 80)}… [+${s.length - 80} chars]`;
  } catch {
    return "";
  }
}

/** Start marker — printed by the CLI BEFORE the run (gated at the call site), to cover the
 *  build/spawn silent window with a per-scenario progress line. */
export function renderStart(label: string, fidelity: string, plan: RenderPlan, write: Sink = stderr): void {
  write(`${dim(plan, `▶ ${label} [${fidelity}] running…`)}\n`);
}

/** Build a renderer (a `RunHooks` + `dump()`/`summary()`). Always buffers; `live`/`progress` gate writes. */
export function makeRenderer(plan: RenderPlan, write: Sink = stderr): Renderer {
  const transcript: string[] = [];
  let tools = 0;
  let subagents = 0;
  // toolUseId -> true for TOP-LEVEL tool calls only, so a tool_result can look up whether its
  // originating tool_use was ever rendered (nested calls are never shown, so their results aren't
  // either — same gate `tool_use` itself already applies). Deleted on first matching result: one
  // result per call, so this can't grow unbounded across a long chat session.
  const topLevelToolCalls = new Set<string>();
  // subagent's own toolUseId -> nesting depth (1-based). Read when a NEW subagent_dispatch names a
  // parentToolUseId, to indent proportionally to how deep the dispatch tree goes.
  const agentDepth = new Map<string, number>();
  let last = Date.now();
  let turnStart = Date.now(); // reset on each "result" — drives the turn-boundary separator's elapsed time
  return {
    onEvent(e: AgentEvent) {
      last = Date.now();
      switch (e.type) {
        case "assistant_text":
          if (!e.parentToolUseId) {
            // translate BEFORE pushing to the transcript buffer, so what's DISPLAYED (the live `write`
            // below) and what's later DUMPED (renderFooter's failure transcript) agree — production
            // deep-walks every block a human eventually sees, never just the live stream.
            const text = plan.translate ? plan.translate(e.text) : e.text;
            transcript.push(text); // buffer stays escape-free: linkify is a LIVE-sink-only decoration
            // The assistant message IS the deliverable in skill/chat mode — show it in FULL (no
            // truncation). Truncation only applies to the run failure-transcript dump (renderFooter).
            if (plan.live) write(`\n${bold(plan, "claude›")} ${plan.linkify ? plan.linkify(text) : text}\n`);
          } else if (plan.verbose && e.text.trim()) {
            // sub-agent/dispatch-child text gets the SAME transform — production translates the whole
            // message tree, not just the top-level agent's text.
            const text = plan.translate ? plan.translate(e.text) : e.text;
            write(`  ${dim(plan, "↳ " + (plan.linkify ? plan.linkify(text) : text))}\n`);
          }
          break;
        case "tool_use":
          if (!e.parentToolUseId) {
            tools++;
            if (e.toolUseId) topLevelToolCalls.add(e.toolUseId);
            // No `plan.linkify` here, deliberately: `inputSummary` hard-slices to ~80 chars, and a
            // `computer://` URL linkified AFTER that slice would be a silently wrong-target link (see
            // the `linkify` doc on `RenderPlan` above).
            if (plan.progress)
              write(
                `  ${dim(plan, toolMarker(e.name) + " " + e.name + (plan.verbose ? " " + inputSummary(e.input, plan.compact, plan.translate) : ""))}\n`,
              );
          }
          break;
        case "tool_result": {
          if (!e.toolUseId || !topLevelToolCalls.has(e.toolUseId)) break; // nested or unpaired — not rendered
          topLevelToolCalls.delete(e.toolUseId);
          if (plan.progress) {
            // translate, THEN collapse the session-root, THEN slice to 80 chars — matching inputSummary's
            // ordering, so --compact stays consistent between a tool's input line and its outcome line.
            // No `plan.linkify` here either, same reason as the tool_use branch above: this line is
            // hard-sliced to 80 chars, so linkifying it could wrap a truncated (wrong-target) URL.
            let head = e.text.split("\n")[0];
            if (plan.translate) head = plan.translate(head);
            if (plan.compact) head = collapseSessionRoot(head);
            head = head.slice(0, 80);
            write(`    ${e.isError ? red(plan, "✗ " + head) : dim(plan, "→ " + head)}\n`);
          }
          break;
        }
        case "subagent_dispatch": {
          subagents++;
          const depth = e.parentToolUseId ? (agentDepth.get(e.parentToolUseId) ?? 0) + 1 : 1;
          agentDepth.set(e.toolUseId, depth);
          if (plan.verbose)
            write(
              `  ${"  ".repeat(depth - 1)}${dim(plan, "└ sub-agent: " + e.dispatchAgentType + " [" + e.declaredTools.join(",") + "]")}\n`,
            );
          break;
        }
        case "thinking":
          if (plan.verbose && e.text.trim()) write(`  ${dim(plan, "(thinking…)")}\n`);
          break;
        case "error":
          write(`  ${red(plan, "! " + e.source + ": " + e.message)}\n`);
          break;
        case "result": {
          if (plan.live) {
            const elapsed = ((Date.now() - turnStart) / 1000).toFixed(1);
            write(`${dim(plan, `── +${elapsed}s ──`)}\n`);
          }
          turnStart = Date.now();
          break;
        }
      }
    },
    dump() {
      return transcript.join("\n");
    },
    summary() {
      return { tools, subagents };
    },
    lastActivity() {
      return last;
    },
  };
}

/**
 * Idle heartbeat for long (5–20 min) runs: a periodic "still running" line on stderr so the user
 * (or a CI log watcher) knows the agent hasn't hung during a silent window (deep thinking, a slow
 * tool). It is IDLE-aware — it stays quiet while live output is flowing (only fires when no event has
 * arrived for `idleMs`). Disable with `COWORK_HARNESS_NO_HEARTBEAT=1`; tune with
 * `COWORK_HARNESS_HEARTBEAT_MS`. Returns a stop function (call it in a `finally`).
 */
export function startHeartbeat(renderer: Renderer | undefined, plan: RenderPlan, startMs: number, write: Sink = stderr): () => void {
  if (process.env.COWORK_HARNESS_NO_HEARTBEAT) return () => {};
  // Reject negative/zero/NaN/non-finite so a bad value can't invert the idle guard (idle is always ≥ 0,
  // so a negative idleMs would make every tick fire and flood stderr) — fall back to the 30s default.
  const n = Number(process.env.COWORK_HARNESS_HEARTBEAT_MS);
  const idleMs = Number.isFinite(n) && n > 0 ? n : 30_000;
  const tick = () => {
    const idle = Date.now() - (renderer?.lastActivity() ?? startMs);
    if (idle < idleMs) return; // recent output — stay quiet
    const sum = renderer?.summary() ?? { tools: 0, subagents: 0 };
    const secs = Math.round((Date.now() - startMs) / 1000);
    write(`${dim(plan, `  … still running (${secs}s · ${sum.tools} tools)`)}\n`);
  };
  const h = setInterval(tick, idleMs);
  if (typeof h.unref === "function") h.unref(); // never keep the process alive on our account
  return () => clearInterval(h);
}

/** Verdict footer (CLI-side, after RunResult). On FAIL, prints the failing transcript (the debug win). */
export function renderFooter(
  r: RunResult,
  plan: RenderPlan,
  opts: { durationMs?: number; renderer?: Renderer; keep?: boolean; write?: Sink; lane?: "live" | "replay"; scaffoldTip?: boolean } = {},
): void {
  const write = opts.write ?? stderr;
  // pass/fail and the failure reasons come from the SAME verdict the exit code / envelope use.
  const verdict = computeVerdict(r, opts.lane ?? "live");
  const passed = verdict.pass;
  const failSignals = verdict.signals.filter((s) => s.severity === "fail");
  const sum = opts.renderer?.summary() ?? { tools: 0, subagents: 0 };
  const dur = opts.durationMs != null ? ` · ${(opts.durationMs / 1000).toFixed(1)}s` : "";
  // an LLM-decided run is NOT reproducible — never let a green read as a deterministic pass.
  const nd = r.nonDeterministic ? " " + red(plan, "⚠ non-deterministic (LLM-decided)") : "";
  const meta = `[${r.fidelity}] · ${sum.tools} tools${sum.subagents ? ` · ${sum.subagents} sub-agents` : ""}${dur}`;
  if (passed) {
    write(`${green(plan, "✓ " + r.result)} ${meta}${nd}${opts.keep ? " · " + tildeify(r.outDir) : ""}\n`);
    if (opts.keep && r.outputsDir) write(`   ${dim(plan, "→ outputs: " + tildeify(r.outputsDir))}\n`);
    if (opts.lane !== "replay" && r.outDir) write(`   ${dim(plan, "→ result: " + tildeify(r.outDir) + "/result.json")}\n`);
    renderGuards(verdict.guards, plan, write); // make the safety nets that ran an enumerable, visible fact
    renderGateProvenance(r, plan, write);
    renderAnswerHints(r, plan, write);
    // scaffold tip — only for skill (exploratory) runs, not automated `run` scenarios.
    // Callers opt in via scaffoldTip: true; run command omits it (you already have a scenario YAML).
    if (opts.scaffoldTip && opts.lane !== "replay" && r.outDir) {
      write(`   ${dim(plan, "Tip: scaffold " + tildeify(r.outDir) + " → turn this run into a starter scenario YAML")}\n`);
    }
    return;
  }
  // a tail-end transport drop renders distinctly from a generic error/FAIL, so a flaky-connection
  // run doesn't read as a skill defect. Otherwise append the most specific terminal reason we have — the
  // SDK subtype (error_max_turns / …) if present, else the errorSource (no_result / exit / timeout / …) —
  // so a failure line names WHY instead of a bare "error" (the reviewer's black-box complaint).
  // Prefer the SDK subtype ONLY when the terminal error actually came from a result event — otherwise a
  // stale subtype from an earlier turn's result could mislabel a later exit/timeout/no_result error.
  const errReason = r.errorSource === "result" && r.resultSubtype && r.resultSubtype !== "success" ? r.resultSubtype : r.errorSource;
  const errLabel =
    r.result === "error"
      ? r.resultErrorKind === "usage_limit"
        ? "usage-limit (retry after reset)"
        : r.resultErrorKind === "transport"
          ? "transport-error"
          : errReason
            ? `error (${errReason})`
            : "error"
      : "FAIL";
  write(`${red(plan, "✗ " + errLabel)} ${meta}\n`);
  if (r.result === "error" && r.errorSource === "no_result")
    write(
      `   ${dim(plan, "no terminal result event (likely turn/time exhaustion) — see " + (r.stderrLogPath ? tildeify(r.stderrLogPath) : "the run's agent.stderr.log"))}\n`,
    );
  for (const s of failSignals) write(`   ${red(plan, "✗ " + s.message)}\n`);
  renderGuards(verdict.guards, plan, write); // show which guards ran even on a fail (no silent guards)
  renderGateProvenance(r, plan, write);
  renderAnswerHints(r, plan, write);
  const t = opts.renderer?.dump().trim();
  if (t) {
    write(`   ${dim(plan, "── transcript ──")}\n`);
    write(
      truncate(t, plan.verbose)
        .split("\n")
        .map((l) => "   " + l)
        .join("\n") + "\n",
    );
    write(`   ${dim(plan, "→ full run: " + tildeify(r.outDir) + "/run.jsonl")}\n`);
    if (r.outputsDir) write(`   ${dim(plan, "→ outputs:  " + tildeify(r.outputsDir))}\n`);
  }
  if (opts.lane !== "replay" && r.outDir) write(`   ${dim(plan, "→ result: " + tildeify(r.outDir) + "/result.json")}\n`);
}

/**
 * Surface every question the agent asked that was NOT scripted (auto-answered by `first`, or
 * answered interactively by `prompt`) as a copy-pasteable `--answer "<q>=<choice>"` line. This is the
 * "run once, then script it" loop: do an exploratory run with `--on-unanswered first`, read these
 * lines off the footer, paste them back as `--answer …` for a deterministic re-run. Scripted answers
 * are not echoed (they're already in the command). No-op when nothing was auto-answered.
 */
// the "guards active this run" roster. ✓ ran clean · ✗ fired · — N/A this lane/tier · ? unverified.
// The load-bearing rule (no silent-false-green): a guard that didn't run renders — / ?, never ✓.
function renderGuards(guards: GuardReport[], plan: RenderPlan, write: Sink): void {
  if (!guards.length) return;
  const sym = (s: GuardStatus) => (s === "ok" ? "✓" : s === "fired" ? "✗" : s === "unverified" ? "?" : "—");
  write(`   ${dim(plan, "guards: " + guards.map((g) => `${g.name} ${sym(g.status)}`).join("  "))}\n`);
}

// One-line gate-provenance summary ("gates: 3 · 2 decided(llm), 1 scripted"). Counts only — the
// per-gate answers live in the scrubbed result.json, never on stderr. No-op when the run had no gates.
function renderGateProvenance(r: RunResult, plan: RenderPlan, write: Sink): void {
  if (!r.gateProvenance) return;
  const line = formatGateProvenanceLine(r.gateProvenance);
  if (line) write(`   ${dim(plan, line)}\n`);
}

function renderAnswerHints(r: RunResult, plan: RenderPlan, write: Sink): void {
  const u = r.nonReproducibleAnswers ?? [];
  if (!u.length) return;
  // partition by the REAL `by:` vocabulary (decider.ts:25 — scripted|cowork|strict|human|agent|
  // external|first|fail|replay; `scripted` answers never reach `unanswered`, see run.ts:256). The old
  // binary split (agent vs everything-else→"scripted") mislabeled `external`/`human` answers — those are
  // marked nonDeterministic by execute.ts (`by` ∈ agent|external|human) and are NOT reproducible via
  // --answer, so telling the user to "add --answer" for them was wrong.
  const NON_DETERMINISTIC = new Set(["llm", "external", "human"]); // mirrors execute.ts nonDeterministic
  const scriptable = u.filter((a) => !NON_DETERMINISTIC.has(a.by)); // `first` (auto-default) + scripted-defaults — pinnable via --answer
  const nondet = u.filter((a) => NON_DETERMINISTIC.has(a.by)); // LLM/external/human — not reproducible by --answer
  if (scriptable.length) {
    write(`   ${dim(plan, `${scriptable.length} question(s) were auto-answered — to script, add:`)}\n`);
    for (const a of scriptable) write(`   ${dim(plan, `--answer ${JSON.stringify(`${a.question}=${a.chosen}`)}`)}\n`);
  }
  if (nondet.length) {
    // these answers are NON-deterministic (LLM/external/human-decided) — --answer does NOT reproduce
    // them. Surface what was chosen and nudge toward pinning a deterministic answer for reproducibility.
    write(
      `   ${dim(plan, `${nondet.length} question(s) answered non-deterministically (LLM/external/human) — not reproducible via --answer; pin for reproducibility:`)}\n`,
    );
    for (const a of nondet) write(`   ${dim(plan, `chose ${JSON.stringify(`${a.question}=${a.chosen}`)} (by ${a.by})`)}\n`);
  }
}
