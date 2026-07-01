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

function truncate(text: string, verbose: boolean): string {
  if (verbose) return text;
  let t = text;
  const lines = t.split("\n");
  if (lines.length > TRUNC_LINES) t = lines.slice(0, TRUNC_LINES).join("\n") + "\n… (truncated)";
  if (t.length > TRUNC_CHARS) t = t.slice(0, TRUNC_CHARS) + " … (truncated)";
  return t;
}
export function inputSummary(input: unknown, compact = false): string {
  try {
    let s = JSON.stringify(input);
    // under --compact, collapse the ephemeral cowork session-root prefix so `-V` tool inputs are
    // shareable. Run BEFORE the 80-char slice so a `/mnt/` boundary past char 80 still collapses.
    // Display-only — the agent's real args (and run.jsonl) are untouched. Covers all cowork-tier
    // session-id shapes (`local_*`, pinned `sess-*`); the L0/protocol tier uses host `work/` paths, so
    // this correctly no-ops there.
    if (compact) s = s.replace(/\/sessions\/[^/]+\/mnt\//g, "mnt/");
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
  let last = Date.now();
  return {
    onEvent(e: AgentEvent) {
      last = Date.now();
      switch (e.type) {
        case "assistant_text":
          if (!e.parentToolUseId) {
            transcript.push(e.text);
            // The assistant message IS the deliverable in skill/chat mode — show it in FULL (no
            // truncation). Truncation only applies to the run failure-transcript dump (renderFooter).
            if (plan.live) write(`\n${bold(plan, "claude›")} ${e.text}\n`);
          } else if (plan.verbose && e.text.trim()) {
            write(`  ${dim(plan, "↳ " + e.text)}\n`);
          }
          break;
        case "tool_use":
          if (!e.parentToolUseId) {
            tools++;
            if (plan.progress) write(`  ${dim(plan, "· " + e.name + (plan.verbose ? " " + inputSummary(e.input, plan.compact) : ""))}\n`);
          }
          break;
        case "subagent_dispatch":
          subagents++;
          if (plan.verbose) write(`  ${dim(plan, "└ sub-agent: " + e.agentType + " [" + e.declaredTools.join(",") + "]")}\n`);
          break;
        case "thinking":
          if (plan.verbose && e.text.trim()) write(`  ${dim(plan, "(thinking…)")}\n`);
          break;
        case "error":
          write(`  ${red(plan, "! " + e.source + ": " + e.message)}\n`);
          break;
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
  // run doesn't read as a skill defect.
  const errLabel = r.result === "error" ? (r.resultErrorKind === "transport" ? "transport-error" : "error") : "FAIL";
  write(`${red(plan, "✗ " + errLabel)} ${meta}\n`);
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
  const u = r.unanswered ?? [];
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
