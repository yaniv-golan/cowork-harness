import { warn, tildeify } from "../io.js";
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { parseMessage, type AgentEvent, type DecisionRequest } from "../agent/session.js";
import { labelSource } from "./gate-provenance.js";
import type { RunResult } from "../types.js";
import { readIndex, resolveRunsExactFromIndex, resolveRunsFragmentFromIndex, type RunIndexRow } from "./run-index.js";

/**
 * The default runs root when no override is set: a per-user state dir OUTSIDE any working tree, so run
 * artifacts (often sensitive skill inputs/outputs) never land in a repo. Matches the `~/.cowork-harness/`
 * convention used by the VM work dir (`lima.ts` `VM_WORK_HOST`). FLAT (shared across all projects on the
 * machine): ephemeral `local_*` run dirs carry a unique hrtime id so they never path-collide; pinned
 * `sess-*` dirs are deterministic, so a cross-project collision is guarded in `execute.ts` (the writer
 * errors rather than overwriting another project's session) and `prune` never prunes them.
 */
export function defaultRunsHome(): string {
  return join(homedir(), ".cowork-harness", "runs");
}

/**
 * Resolve the runs/ root for READS (`trace`/`scaffold`/`verify-run`). `COWORK_HARNESS_RUNS_DIR` override
 * if set, else `defaultRunsHome()`. Both halves are ABSOLUTE, so a `trace <run-id>` resolves from any
 * directory — the absolute default replaces the old cwd-relative / repo-root walk more simply, and
 * makes write/read roots identical so they can't drift. (An env-set *write* followed by a no-env read
 * won't be found — pass the same env/flag, or an explicit run-dir/events.jsonl path.)
 */
export function runsRoot(): string {
  return process.env.COWORK_HARNESS_RUNS_DIR ?? defaultRunsHome();
}

/** The root that run WRITERS use — identical resolution to `runsRoot()` so a write and a subsequent
 *  `trace`/read resolve to the same place. */
export function runsWriteRoot(): string {
  return process.env.COWORK_HARNESS_RUNS_DIR ?? defaultRunsHome();
}

/** One-time stderr notice of where runs are written, shown only when the user did NOT pick a location
 *  (no `--run-dir` / `COWORK_HARNESS_RUNS_DIR`) — keeps the default `~/.cowork-harness/runs` discoverable
 *  after moving output out of cwd, without polluting `--quiet` or a `--output-format json` stdout
 *  envelope. Gated on env-PRESENCE (the `--run-dir` flag sets that env, so both flag and env suppress it).
 */
export function noteRunsLocation(opts: { json: boolean; quiet: boolean; suppress?: boolean }): void {
  if (opts.json || opts.quiet || opts.suppress) return; // suppress: --demo wants clean output (runs stay durable)
  if (process.env.COWORK_HARNESS_RUNS_DIR !== undefined) return;
  process.stderr.write(`runs → ${tildeify(runsWriteRoot())} (override with --run-dir / COWORK_HARNESS_RUNS_DIR)\n`);
}

/**
 * `trace` view — a human/machine-readable digest of a run's `events.jsonl`, so triage doesn't require
 * reverse-engineering the raw stream-json. It reuses `parseMessage` (the same translation the live
 * session uses) so the view stays correct as the schema evolves, and DEDUPES the dispatch block:
 * `parseMessage` yields BOTH a `tool_use` and a `subagent_dispatch` for one `Agent` call, so the
 * `tool_use` row is suppressed in favor of the richer dispatch row.
 */
export interface TraceRow {
  kind: "tool" | "dispatch" | "decision" | "text" | "result";
  name?: string;
  detail?: string;
  agentType?: string;
  declaredTools?: string[];
  description?: string; // dispatch description — identifies an `unknown`-typed dispatch
  child?: boolean; // ran inside a sub-agent (had a parentToolUseId)
  toolUseId?: string; // for pairing a tool row with its result
  resultStatus?: "ok" | "error"; // the tool's outcome (was invisible before)
  resultText?: string; // first line of the result/error
}

function isDispatchTool(name: string, input: unknown): boolean {
  return name === "Agent" || name === "Task" || (typeof input === "object" && input !== null && "subagent_type" in input);
}

function summarize(input: unknown): string {
  try {
    const s = JSON.stringify(input);
    return s.length > 100 ? s.slice(0, 100) + "…" : s;
  } catch {
    return "";
  }
}

function decisionDetail(req: DecisionRequest): string {
  if (req.kind === "permission") return req.tool;
  if (req.kind === "question") return req.questions.map((q) => q.question ?? q.header ?? "").join(" / ");
  if (req.kind === "dialog") return req.dialogKind;
  return req.prompt ?? req.server ?? "";
}

function rowFor(ev: AgentEvent): TraceRow[] {
  switch (ev.type) {
    case "tool_use":
      if (isDispatchTool(ev.name, ev.input)) return []; // covered by the paired subagent_dispatch row
      return [{ kind: "tool", name: ev.name, detail: summarize(ev.input), child: !!ev.parentToolUseId, toolUseId: ev.toolUseId }];
    case "subagent_dispatch":
      return [{ kind: "dispatch", name: "Agent", agentType: ev.agentType, declaredTools: ev.declaredTools, description: ev.description }];
    case "assistant_text":
      return ev.parentToolUseId || !ev.text.trim() ? [] : [{ kind: "text", detail: ev.text.replace(/\s+/g, " ").slice(0, 120) }];
    case "decision":
      return [{ kind: "decision", name: ev.request.kind, detail: decisionDetail(ev.request) }];
    case "result":
      return [{ kind: "result", detail: ev.isError ? "error" : "success" }];
    default:
      return [];
  }
}

/** E4: resolves `arg` against a set of already-tiered index rows (exact OR fragment — caller picks the
 *  tier), tie-breaking on the index row's `ts` (the run's actual creation time — a strictly better signal
 *  than a directory's `mtime`, which the filesystem walk uses and which can be touched by unrelated
 *  filesystem operations). Returns `undefined` on no rows, OR when the winning row's `events.jsonl` no
 *  longer exists on disk (an index entry surviving a `prune` of the physical run dir) — either way, the
 *  caller falls through to the next tier. */
function resolveViaIndexRows(rows: RunIndexRow[], arg: string): string | undefined {
  if (rows.length === 0) return undefined;
  const sorted = rows.length > 1 ? [...rows].sort((a, b) => (a.ts < b.ts ? 1 : -1)) : rows;
  if (sorted.length > 1) {
    warn(
      `::warning:: ambiguous trace fragment "${arg}" matches ${sorted.length} indexed run(s):\n` +
        sorted.map((r) => `  ${join(r.outDir, "events.jsonl")}`).join("\n") +
        `\nUsing the most recent: ${join(sorted[0].outDir, "events.jsonl")}\nPass a more specific id or full path to be deterministic.\n`,
    );
  }
  const f = join(sorted[0].outDir, "events.jsonl");
  return existsSync(f) ? f : undefined;
}

/** Resolve `arg` to an events.jsonl: a direct file, a run dir, or a run-id/scenario fragment under runs/.
 *  `resolveEventsFile` is the single choke point trace/inspect/scaffold/status all resolve a run-id/
 *  fragment through — making it index-aware (E4) migrates all four for free, with full behavioral safety:
 *  an index MISS (a pre-index-era run, or index.jsonl never built via `--reindex`) falls straight through
 *  to the filesystem walk, unchanged.
 *
 *  Tier order is index-EXACT → filesystem-EXACT → index-FRAGMENT → filesystem-FRAGMENT, deliberately
 *  interleaved rather than "try the whole index, then the whole walk" — an EARLIER version tried the
 *  index's exact-then-fragment fallback as one block before the walk, which meant an index FRAGMENT hit
 *  could shadow a filesystem EXACT hit for a run that predates the index (e.g. an on-disk `sess-a` run
 *  dir + an indexed `sess-abc` run: `resolveEventsFile("sess-a")` would silently resolve to `sess-abc`'s
 *  events.jsonl instead of `sess-a`'s own, no warning — `sess-*` ids are user-chosen, so this collision is
 *  realistic, not hypothetical). Interleaving preserves the walk's own "exact always wins over any
 *  fragment, regardless of source" invariant exactly. */
export function resolveEventsFile(arg: string): string {
  if (existsSync(arg) && statSync(arg).isFile()) return arg;
  if (existsSync(arg) && statSync(arg).isDirectory()) {
    const f = join(arg, "events.jsonl");
    if (existsSync(f)) return f;
  }
  const root = runsRoot(); // COWORK_HARNESS_RUNS_DIR, else the absolute ~/.cowork-harness/runs — not cwd-relative
  const indexRows = readIndex(root);
  const viaIndexExact = resolveViaIndexRows(resolveRunsExactFromIndex(indexRows, arg), arg);
  if (viaIndexExact) return viaIndexExact;
  if (existsSync(root)) {
    // prefer EXACT match first; only fall through to fragment matching if nothing exact was found.
    // Collect ALL fragment matches and warn loudly (with candidates) before picking deterministically.
    for (const scen of readdirSync(root)) {
      const sd = join(root, scen);
      let sdStat;
      try {
        sdStat = statSync(sd);
      } catch {
        continue;
      }
      if (!sdStat.isDirectory()) continue;
      const direct = join(sd, arg, "events.jsonl");
      if (existsSync(direct)) return direct; // exact run-dir name match under scenario dir
    }
  }
  const viaIndexFragment = resolveViaIndexRows(resolveRunsFragmentFromIndex(indexRows, arg), arg);
  if (viaIndexFragment) return viaIndexFragment;
  if (existsSync(root)) {
    // Fragment matching: collect all candidates so ambiguity is surfaced, not silently resolved.
    const candidates: string[] = [];
    for (const scen of readdirSync(root)) {
      const sd = join(root, scen);
      let sdStat;
      try {
        sdStat = statSync(sd);
      } catch {
        continue;
      }
      if (!sdStat.isDirectory()) continue;
      for (const run of readdirSync(sd)) {
        const f = join(sd, run, "events.jsonl");
        if (!existsSync(f)) continue;
        if (run.includes(arg) || scen.includes(arg)) candidates.push(f);
      }
    }
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
      candidates.sort((a, b) => {
        let am = 0,
          bm = 0;
        try {
          am = statSync(dirname(a)).mtimeMs;
        } catch {}
        try {
          bm = statSync(dirname(b)).mtimeMs;
        } catch {}
        return bm !== am ? bm - am : b.localeCompare(a);
      });
      warn(
        `::warning:: ambiguous trace fragment "${arg}" matches ${candidates.length} run dirs:\n` +
          candidates.map((c) => `  ${c}`).join("\n") +
          `\nUsing the most recent: ${candidates[0]}\nPass a more specific id or full path to be deterministic.\n`,
      );
      return candidates[0];
    }
  }
  throw new Error(`no events.jsonl for "${arg}" — pass a run dir, an events.jsonl path, or a run id under runs/`);
}

/** Parse every event from a pre-read array of raw JSONL lines — the shared core both `eventsOf` (a run
 *  dir's events.jsonl on disk) and E2's diff engine (a cassette's `events[]`, already in memory, no file
 *  to read) build on. `source` is only used in the malformed-line warning. */
export function eventsFromLines(lines: string[], source = "<lines>"): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      // skip malformed JSON (a truncated final line is normal) but be LOUD — mirror cassette.ts.
      warn(`::warning:: trace: skipping malformed JSON line in ${source}: ${line.slice(0, 120)}\n`);
      continue;
    }
    events.push(...parseMessage(msg));
  }
  return events;
}

/** Parse every event from an events.jsonl (the shared first pass for the trace views). */
function eventsOf(file: string): AgentEvent[] {
  return eventsFromLines(readFileSync(file, "utf8").split("\n"), file);
}

/** Core trace-row building over an already-parsed event array — the part of `buildTrace` that doesn't
 *  care whether the events came from a file (run dir) or were passed in directly (E2's diff engine,
 *  cassette `events[]`). `buildTrace` is the file-path convenience wrapper over this. */
export function buildTraceFromEvents(events: AgentEvent[], opts: { tools?: boolean } = {}): TraceRow[] {
  // Pair tool_use ↔ tool_result by toolUseId so each tool row carries its OUTCOME — the single
  // highest-value forensics fix: a tool error (e.g. the q.map) is now visible in one command.
  const results = new Map<string, { isError: boolean; text: string }>();
  for (const ev of events) if (ev.type === "tool_result" && ev.toolUseId) results.set(ev.toolUseId, { isError: ev.isError, text: ev.text });
  const rows: TraceRow[] = [];
  for (const ev of events) {
    for (const row of rowFor(ev)) {
      if (row.kind === "tool" && row.toolUseId && results.has(row.toolUseId)) {
        const r = results.get(row.toolUseId)!;
        row.resultStatus = r.isError ? "error" : "ok";
        row.resultText = r.text.split("\n")[0].slice(0, 120);
      }
      rows.push(row);
    }
  }
  return opts.tools ? rows.filter((r) => r.kind === "tool" || r.kind === "dispatch") : rows;
}

export function buildTrace(file: string, opts: { tools?: boolean } = {}): TraceRow[] {
  return buildTraceFromEvents(eventsOf(file), opts);
}

export interface GateTraceRow {
  question: string;
  injectedAnswer?: string; // what the harness answered (from control-out.jsonl)
  delivered: "ok" | "error" | "unobserved"; // the tool_result outcome
  error?: string; // first line of the error if delivery failed
  answeredBy?: string; // provenance from the sibling result.json (scripted | llm | external | first | human)
  model?: string; // decider model when answeredBy === "llm"
}

/**
 * `trace --gates` — pair each AskUserQuestion gate's **question → injected answer → delivered result**, so
 * the full gate lifecycle is inspectable in one command (no hand-parsing control-out.jsonl). Bridges the
 * differing keys: the gate's `decision` (events.jsonl) carries both the UUID `request_id` AND the `toolu_`
 * `toolUseId`; the injected answer lives in `control-out.jsonl` keyed by `request_id`; the delivered result
 * is a `tool_result` keyed by `toolUseId`.
 */
export function buildGateTrace(file: string): GateTraceRow[] {
  const events = eventsOf(file);
  const results = new Map<string, { isError: boolean; text: string }>();
  for (const ev of events) if (ev.type === "tool_result" && ev.toolUseId) results.set(ev.toolUseId, { isError: ev.isError, text: ev.text });
  // injected answers from the sibling control-out.jsonl, keyed by request_id
  const answers = new Map<string, string>();
  const controlOut = join(file, "..", "control-out.jsonl");
  if (existsSync(controlOut)) {
    for (const line of readFileSync(controlOut, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line);
        const rid = m?.response?.request_id;
        const a = m?.response?.response?.updatedInput?.answers;
        if (rid && a) answers.set(String(rid), JSON.stringify(a));
      } catch {
        // a malformed control-out line is skipped (truncation is normal) but surfaced loudly.
        warn(`::warning:: trace: skipping malformed JSON line in ${controlOut}: ${line.slice(0, 120)}\n`);
        continue;
      }
    }
  }
  const rows: GateTraceRow[] = [];
  for (const ev of events) {
    if (ev.type !== "decision" || ev.request.kind !== "question") continue;
    const req = ev.request;
    const tr = req.toolUseId ? results.get(req.toolUseId) : undefined;
    rows.push({
      question: req.questions.map((q) => q.question ?? q.header ?? "").join(" / "),
      injectedAnswer: answers.get(req.id),
      delivered: tr ? (tr.isError ? "error" : "ok") : "unobserved",
      ...(tr?.isError ? { error: tr.text.split("\n")[0].slice(0, 160) } : {}),
    });
  }
  // Provenance annotation (best-effort): pair each gate row with its recorded `by`/`model` from the
  // sibling result.json, in ask order. Missing result.json (bare events.jsonl trace) → left unannotated.
  // Pair against EVERY question-kind decision (answered OR denied), not summarizeGateProvenance's
  // gates[] — that array drops denied/mismatched gates, which would shift every row after one out of
  // position (rows[] here includes every asked gate, so the index spaces must match). Still positional,
  // not keyed by request_id: a duplicated/retried question event in events.jsonl (extra row, no matching
  // decision) could still misalign later rows — GateTraceRow carries no id to detect that case.
  const resultPath = join(file, "..", "result.json");
  if (existsSync(resultPath)) {
    try {
      const persisted = JSON.parse(readFileSync(resultPath, "utf8")) as RunResult;
      const questionDecisions = (persisted.decisions ?? []).filter((d) => d.kind === "question");
      for (let i = 0; i < rows.length; i++) {
        const d = questionDecisions[i];
        if (!d || d.decision !== "answered") continue;
        rows[i].answeredBy = d.by;
        rows[i].model = d.model;
      }
    } catch (e) {
      warn(`::warning:: trace: skipping unparseable ${resultPath}: ${String((e as Error).message)}\n`);
    }
  }
  return rows;
}

export function formatGateTrace(rows: GateTraceRow[]): string {
  if (!rows.length) return "(no AskUserQuestion gates in this run)";
  const mark = { ok: "✓", error: "✗", unobserved: "?" } as const;
  return rows
    .map((r) => {
      const prov = r.answeredBy ? `\n    by: ${labelSource(r.answeredBy)}${r.model ? ` (${r.model})` : ""}` : "";
      return `${mark[r.delivered]} gate "${r.question}"\n    answered: ${r.injectedAnswer ?? "(none)"}\n    delivered: ${r.delivered}${r.error ? ` — ${r.error}` : ""}${prov}`;
    })
    .join("\n");
}

export interface DispatchNode {
  toolUseId: string;
  agentType: string;
  description?: string;
  declaredTools: string[];
  depth: number; // 0 = top-level dispatch; >0 = dispatched by another sub-agent
}

/**
 * `trace --dispatches` — the sub-agent dispatch tree, so an author can read off the REAL total
 * dispatch count (what `dispatch_count_max` asserts against) instead of guess-and-check, and see the
 * nesting (a sub-agent that dispatches further). Ordered by appearance; depth derived from
 * `parentToolUseId` chains among the dispatches themselves.
 */
export function buildDispatchTree(file: string): { nodes: DispatchNode[]; total: number } {
  const events = eventsOf(file);
  const dispatches = events.filter((e): e is Extract<AgentEvent, { type: "subagent_dispatch" }> => e.type === "subagent_dispatch");
  const byId = new Map(dispatches.map((d) => [d.toolUseId, d]));
  const depthOf = (d: Extract<AgentEvent, { type: "subagent_dispatch" }>): number => {
    let depth = 0;
    let cur = d.parentToolUseId;
    const seen = new Set<string>(); // guard against a cyclic/self parent ref
    while (cur && byId.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      depth++;
      cur = byId.get(cur)!.parentToolUseId;
    }
    return depth;
  };
  const nodes = dispatches.map((d) => ({
    toolUseId: d.toolUseId,
    agentType: d.agentType,
    description: d.description,
    declaredTools: d.declaredTools,
    depth: depthOf(d),
  }));
  return { nodes, total: nodes.length };
}

export function formatDispatchTree({ nodes, total }: { nodes: DispatchNode[]; total: number }): string {
  if (!nodes.length) return "(no sub-agent dispatches in this run)";
  const lines = nodes.map((n) => {
    const indent = "  ".repeat(n.depth);
    const tools = n.declaredTools.length ? ` [${n.declaredTools.join(",")}]` : "";
    return `${indent}└ ${n.agentType}${n.description ? ` (${n.description})` : ""}${tools}`;
  });
  lines.push(`\n${total} sub-agent dispatch(es) total — assert with \`dispatch_count_max: ${total}\``);
  return lines.join("\n");
}

export function formatTrace(rows: TraceRow[]): string {
  const lines: string[] = [];
  for (const r of rows) {
    if (r.kind === "dispatch")
      lines.push(
        `└ dispatch ${r.agentType}${r.description ? ` (${r.description})` : ""}${r.declaredTools?.length ? " [" + r.declaredTools.join(",") + "]" : ""}`,
      );
    else if (r.kind === "tool")
      lines.push(
        `  ${r.child ? "  ↳" : "·"} ${r.name}${r.detail ? "  " + r.detail : ""}` +
          (r.resultStatus ? `  → ${r.resultStatus === "error" ? "✗ error: " + (r.resultText ?? "") : "ok"}` : ""),
      );
    else if (r.kind === "decision") lines.push(`? ${r.name}: ${r.detail}`);
    else if (r.kind === "result") lines.push(`= result: ${r.detail}`);
    else if (r.kind === "text") lines.push(`claude› ${r.detail}`);
  }
  const tools = rows.filter((r) => r.kind === "tool").length;
  const dispatched = rows.filter((r) => r.kind === "dispatch").length;
  lines.push(`\n${tools} tool calls · ${dispatched} sub-agent dispatch(es)`);
  return lines.join("\n");
}
