import { warn, tildeify } from "../io.js";
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { parseMessage, type AgentEvent, type DecisionRequest } from "../agent/session.js";
import { labelSource } from "./gate-provenance.js";
import type { RunResult } from "../types.js";
import { readIndex, resolveRunsExactFromIndex, resolveRunsFragmentFromIndex, type RunIndexRow } from "./run-index.js";
import { readTimeline } from "../agent/timeline.js";
import { foldToolDurations } from "./timeline-fold.js";

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
  kind: "tool" | "dispatch" | "decision" | "text" | "result" | "thinking";
  name?: string;
  detail?: string;
  agentType?: string;
  declaredTools?: string[];
  description?: string; // dispatch description — identifies an `unknown`-typed dispatch
  child?: boolean; // ran inside a sub-agent (had a parentToolUseId)
  toolUseId?: string; // for pairing a tool row with its result
  resultStatus?: "ok" | "error"; // the tool's outcome (was invisible before)
  resultText?: string; // first line of the result/error (120-char cap) — what the default/tools view shows
  resultTextFull?: string; // error rows only: the FULL multi-line result, capped at TOOL_ERROR_TEXT_CAP —
  detailFull?: string; // error rows only: the FULL (uncapped-to-cap) input/command — powers `--view tool-errors`
}

/** Cap for the fuller error captures (`resultTextFull`/`detailFull`). Bounds a runaway stderr / huge
 *  argument blob so a single errored call can't balloon the `--view tool-errors` JSON envelope. Stated in
 *  `trace --help`. The 120-char `resultText` other views use is unaffected. */
const TOOL_ERROR_TEXT_CAP = 4096;

function isDispatchTool(name: string, input: unknown): boolean {
  return name === "Agent" || name === "Task" || (typeof input === "object" && input !== null && "subagent_type" in input);
}

/** `translate` runs BEFORE the 100-char slice — a translated (VM->host) path is a different length
 *  than the VM path it replaced, so translating a slice would risk cutting mid-path or leaving a
 *  dangling fragment. Defaults to identity (the `--translate-paths` consumer, `cli.ts`, is the only
 *  caller that ever passes something else). */
function summarize(input: unknown, translate: (s: string) => string): string {
  try {
    const s = translate(JSON.stringify(input));
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

/** Same pre-slice ordering as `summarize`: `translate` runs on the full text, THEN the 120-char
 *  assistant-text slice is taken — see `summarize`'s doc comment for why the order matters. */
function rowFor(ev: AgentEvent, translate: (s: string) => string): TraceRow[] {
  switch (ev.type) {
    case "tool_use":
      if (isDispatchTool(ev.name, ev.input)) return []; // covered by the paired subagent_dispatch row
      return [
        { kind: "tool", name: ev.name, detail: summarize(ev.input, translate), child: !!ev.parentToolUseId, toolUseId: ev.toolUseId },
      ];
    case "subagent_dispatch":
      return [{ kind: "dispatch", name: "Agent", agentType: ev.agentType, declaredTools: ev.declaredTools, description: ev.description }];
    case "assistant_text":
      return ev.parentToolUseId || !ev.text.trim() ? [] : [{ kind: "text", detail: translate(ev.text.replace(/\s+/g, " ")).slice(0, 120) }];
    case "thinking":
      return !ev.text.trim() ? [] : [{ kind: "thinking", detail: translate(ev.text.replace(/\s+/g, " ")).slice(0, 120) }];
    case "decision":
      return [{ kind: "decision", name: ev.request.kind, detail: decisionDetail(ev.request) }];
    case "result":
      return [{ kind: "result", detail: ev.isError ? "error" : "success" }];
    default:
      return [];
  }
}

/** Resolves `arg` against a set of already-tiered index rows (exact OR fragment — caller picks the
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
 *  fragment through — making it index-aware migrates all four for free, with full behavioral safety:
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
 *  dir's events.jsonl on disk) and the cassette diff engine (a cassette's `events[]`, already in memory,
 *  no file to read) build on. `source` is only used in the malformed-line warning. */
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
    // parseMessage now THROWS a typed protocol error on a malformed init/content frame (#1/#2). The trace
    // lane must not abort on one bad frame — skip it loudly (same "skip malformed but be LOUD" contract as
    // the JSON.parse catch above and cassette.ts's per-line handling).
    try {
      events.push(...parseMessage(msg));
    } catch (e) {
      warn(`::warning:: trace: skipping malformed protocol frame in ${source}: ${String((e as Error)?.message ?? e).slice(0, 160)}\n`);
    }
  }
  return events;
}

/** Parse every event from an events.jsonl (the shared first pass for the trace views). */
function eventsOf(file: string): AgentEvent[] {
  return eventsFromLines(readFileSync(file, "utf8").split("\n"), file);
}

/** Options shared by `buildTrace`/`buildTraceFromEvents`. `translate` (the `trace --translate-paths`
 *  consumer) rewrites VM paths to host paths in row TEXT — summaries, assistant text, tool-result heads —
 *  BEFORE any of it is sliced to its ~100/120-char display length (see `summarize`/`rowFor`'s doc
 *  comments for why the order matters). Defaults to identity, matching every caller before this option
 *  existed (the cassette diff engine and cassette replay both get untranslated rows unless they opt in). */
export interface BuildTraceOptions {
  tools?: boolean;
  translate?: (text: string) => string;
}

/** Core trace-row building over an already-parsed event array — the part of `buildTrace` that doesn't
 *  care whether the events came from a file (run dir) or were passed in directly (the cassette diff
 *  engine, cassette `events[]`). `buildTrace` is the file-path convenience wrapper over this. */
function buildTraceFromEvents(events: AgentEvent[], opts: BuildTraceOptions = {}): TraceRow[] {
  const translate = opts.translate ?? ((s: string) => s);
  // Pair tool_use ↔ tool_result by toolUseId so each tool row carries its OUTCOME — the single
  // highest-value forensics fix: a tool error (e.g. the q.map) is now visible in one command.
  const results = new Map<string, { isError: boolean; text: string }>();
  for (const ev of events) if (ev.type === "tool_result" && ev.toolUseId) results.set(ev.toolUseId, { isError: ev.isError, text: ev.text });
  const rows: TraceRow[] = [];
  for (const ev of events) {
    for (const row of rowFor(ev, translate)) {
      if (row.kind === "tool" && row.toolUseId && results.has(row.toolUseId)) {
        const r = results.get(row.toolUseId)!;
        row.resultStatus = r.isError ? "error" : "ok";
        // translate the first line BEFORE slicing (same ordering rule as summarize/rowFor above).
        row.resultText = translate(r.text.split("\n")[0]).slice(0, 120);
        if (r.isError) {
          // Fuller capture for the `tool-errors` drill-down: the WHOLE multi-line stderr (not just
          // line 1) and the full input/command, each capped. The default/tools view still reads the
          // 120-char first-line `resultText` above, so those rows are unchanged.
          row.resultTextFull = translate(r.text).slice(0, TOOL_ERROR_TEXT_CAP);
          if (ev.type === "tool_use") row.detailFull = translate(JSON.stringify(ev.input)).slice(0, TOOL_ERROR_TEXT_CAP);
        }
      }
      rows.push(row);
    }
  }
  return opts.tools ? rows.filter((r) => r.kind === "tool" || r.kind === "dispatch") : rows;
}

export function buildTrace(file: string, opts: BuildTraceOptions = {}): TraceRow[] {
  return buildTraceFromEvents(eventsOf(file), opts);
}

export interface GateTraceRow {
  question: string;
  requestId?: string; // the gate's request_id (from the events.jsonl decision) — used to pair provenance by id
  subQuestionCount: number; // req.questions.length — the number `questions_count_max` counts THIS gate as (a bundled AskUserQuestion with K sub-questions counts as K, not 1)
  injectedAnswer?: string; // what the harness answered (from control-out.jsonl)
  delivered: "ok" | "error" | "unobserved"; // the tool_result outcome
  error?: string; // first line of the error if delivery failed
  answeredBy?: string; // provenance from the sibling result.json (scripted | llm | external | first | human)
  model?: string; // decider model when answeredBy === "llm"
}

/**
 * `trace --view questions` — pair each AskUserQuestion gate's **question → injected answer → delivered result**, so
 * the full gate lifecycle is inspectable in one command (no hand-parsing control-out.jsonl). Bridges the
 * differing keys: the gate's `decision` (events.jsonl) carries both the UUID `request_id` AND the `toolu_`
 * `toolUseId`; the injected answer lives in `control-out.jsonl` keyed by `request_id`; the delivered result
 * is a `tool_result` keyed by `toolUseId`.
 *
 * Each row is one gate (one AskUserQuestion tool call), which may bundle several sub-questions —
 * `subQuestionCount` carries that count so a reader can reconcile this view against
 * `questions_count_max`, which counts sub-questions, not gates/tool-calls (see `formatGateTrace`'s
 * footer total and `docs/scenario.md`/`docs/cassette.md`'s `questions_count_max` row).
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
      requestId: req.id,
      subQuestionCount: req.questions.length,
      injectedAnswer: answers.get(req.id),
      delivered: tr ? (tr.isError ? "error" : "ok") : "unobserved",
      ...(tr?.isError ? { error: tr.text.split("\n")[0].slice(0, 160) } : {}),
    });
  }
  // Provenance annotation (best-effort): pair each gate row with its recorded `by`/`model` from the
  // sibling result.json. Preferred pairing is BY request_id — a persisted answered question decision now
  // carries `requestId` (#20), so a retried/duplicated gate event (an extra row with no matching decision)
  // can't shift every later row's label out of position, which the old positional pairing was prone to.
  // Records predating `requestId` fall back to the positional pairing (in ask order, against every
  // question-kind decision so denied/mismatched gates keep the index spaces aligned).
  const resultPath = join(file, "..", "result.json");
  if (existsSync(resultPath)) {
    try {
      const persisted = JSON.parse(readFileSync(resultPath, "utf8")) as RunResult;
      const questionDecisions = (persisted.decisions ?? []).filter((d) => d.kind === "question");
      const answeredById = new Map<string, (typeof questionDecisions)[number]>();
      for (const d of questionDecisions) if (d.decision === "answered" && d.requestId) answeredById.set(d.requestId, d);
      if (answeredById.size > 0) {
        for (const row of rows) {
          const d = row.requestId ? answeredById.get(row.requestId) : undefined;
          if (d) {
            row.answeredBy = d.by;
            row.model = d.model;
          }
        }
      } else {
        // Legacy positional fallback (records written before requestId was persisted).
        for (let i = 0; i < rows.length; i++) {
          const d = questionDecisions[i];
          if (!d || d.decision !== "answered") continue;
          rows[i].answeredBy = d.by;
          rows[i].model = d.model;
        }
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
  const lines = rows.map((r) => {
    const prov = r.answeredBy ? `\n    by: ${labelSource(r.answeredBy)}${r.model ? ` (${r.model})` : ""}` : "";
    // sub-question count is shown only when the gate bundled more than one — reconciles this row
    // against questions_count_max, which counts sub-questions, not gates.
    const subCount = r.subQuestionCount > 1 ? ` (${r.subQuestionCount} sub-questions)` : "";
    return `${mark[r.delivered]} gate "${r.question}"${subCount}\n    answered: ${r.injectedAnswer ?? "(none)"}\n    delivered: ${r.delivered}${r.error ? ` — ${r.error}` : ""}${prov}`;
  });
  const totalSubQuestions = rows.reduce((sum, r) => sum + r.subQuestionCount, 0);
  lines.push(
    `\n${rows.length} gate(s), ${totalSubQuestions} sub-question(s) total — questions_count_max counts sub-questions (assert with \`questions_count_max: ${totalSubQuestions}\`)`,
  );
  return lines.join("\n");
}

export interface DispatchNode {
  toolUseId: string;
  agentType: string;
  description?: string;
  declaredTools: string[];
  depth: number; // 0 = top-level dispatch; >0 = dispatched by another sub-agent
  prompt?: string;
  model?: string;
  output?: string; // paired from a tool_result in the same events file, by toolUseId
}

/**
 * `trace --view dispatches` — the sub-agent dispatch tree, so an author can read off the REAL total
 * dispatch count (what `dispatch_count_max` asserts against) instead of guess-and-check, and see the
 * nesting (a sub-agent that dispatches further). Ordered by appearance; depth derived from
 * `parentToolUseId` chains among the dispatches themselves.
 */
export function buildDispatchTree(file: string): { nodes: DispatchNode[]; total: number } {
  const events = eventsOf(file);
  const dispatches = events.filter((e): e is Extract<AgentEvent, { type: "subagent_dispatch" }> => e.type === "subagent_dispatch");
  const byId = new Map(dispatches.map((d) => [d.toolUseId, d]));
  // Pair each dispatch's own toolUseId against a tool_result in the SAME events file so `output` is
  // available without reading RunResult/RunRecord (mirrors buildTraceFromEvents's results.set(...) pairing).
  const results = new Map<string, string>();
  for (const ev of events) if (ev.type === "tool_result" && ev.toolUseId) results.set(ev.toolUseId, ev.text);
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
    prompt: d.prompt,
    model: d.model,
    output: results.get(d.toolUseId),
  }));
  return { nodes, total: nodes.length };
}

export function formatDispatchTree({ nodes, total }: { nodes: DispatchNode[]; total: number }): string {
  if (!nodes.length) return "(no sub-agent dispatches in this run)";
  const firstLine = (s?: string) => (s ? s.split("\n")[0] : undefined);
  const lines = nodes.map((n) => {
    const indent = "  ".repeat(n.depth);
    const tools = n.declaredTools.length ? ` [${n.declaredTools.join(",")}]` : "";
    const promptLine = firstLine(n.prompt);
    const outputLine = firstLine(n.output);
    const extra = [promptLine ? `prompt: ${promptLine}` : "", outputLine ? `output: ${outputLine}` : ""]
      .filter(Boolean)
      .map((s) => `\n${indent}  ${s}`)
      .join("");
    return `${indent}└ ${n.agentType}${n.description ? ` (${n.description})` : ""}${tools}${extra}`;
  });
  lines.push(`\n${total} sub-agent dispatch(es) total — assert with \`dispatch_count_max: ${total}\``);
  return lines.join("\n");
}

/**
 * `trace --view tool-durations` — per-tool call-count/timing aggregate, folded from the sibling
 * `timeline.jsonl`. Returns `{}` for a run dir with no timeline (an older recording that predates this
 * file, or a run that genuinely made no tool calls) — same "absent means no data, not an error" convention as the other
 * `build*` functions in this file.
 */
export function buildToolDurations(file: string): Record<string, { calls: number; totalMs: number; maxMs: number }> {
  const timelineData = readTimeline(join(file, ".."));
  return timelineData ? foldToolDurations(timelineData.events) : {};
}

export function formatToolDurations(durations: Record<string, { calls: number; totalMs: number; maxMs: number }>): string {
  const names = Object.keys(durations);
  if (!names.length) return "(no tool-duration data for this run — an older recording without timing, or no tool calls)";
  const lines = names.map((name) => {
    const d = durations[name];
    return `${name} ×${d.calls}, ${(d.totalMs / 1000).toFixed(1)}s total, ${(d.maxMs / 1000).toFixed(1)}s max`;
  });
  const totalMs = names.reduce((sum, name) => sum + durations[name].totalMs, 0);
  lines.push(`\n${names.length} tool(s), ${(totalMs / 1000).toFixed(1)}s combined wall-gap total`);
  return lines.join("\n");
}

/**
 * Combined cache-read ratio across every model in `modelUsage` —
 * `cacheReadInputTokens / (inputTokens + cacheReadInputTokens + cacheCreationInputTokens)`, summed
 * per-field across models before dividing (not an average of per-model ratios, which would
 * mis-weight a low-volume model against a high-volume one). Returns `undefined` when there's no
 * data or the denominator is zero (guards a NaN/Infinity% footer) — absence means "don't print the
 * footer line", not "0%".
 */
function cacheReadRatio(
  modelUsage: Record<string, { inputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }>,
): number | undefined {
  let input = 0;
  let cacheRead = 0;
  let cacheCreation = 0;
  for (const m of Object.values(modelUsage)) {
    input += m.inputTokens ?? 0;
    cacheRead += m.cacheReadInputTokens ?? 0;
    cacheCreation += m.cacheCreationInputTokens ?? 0;
  }
  const denom = input + cacheRead + cacheCreation;
  return denom > 0 ? cacheRead / denom : undefined;
}

/** Best-effort read of the sibling `result.json` for a run dir, given its `events.jsonl` path. Returns
 *  `undefined` when there's no run dir (a bare `events.jsonl` was traced) or the file won't parse — the
 *  same "absent means degrade gracefully, don't crash" tolerance `buildGateTrace`'s provenance pass uses. */
function readSiblingResult(file: string): RunResult | undefined {
  const p = join(dirname(file), "result.json");
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as RunResult;
  } catch (e) {
    warn(`::warning:: trace: skipping unparseable ${p}: ${String((e as Error).message)}\n`);
    return undefined;
  }
}

/**
 * `trace --view tool-errors` — one row per ERRORED tool call, with the full command and the full
 * multi-line stderr (the `tools` view shows only the 120-char first line; `toolErrors` in `result.json`
 * shows only counts). The single most-requested trace gap: reading the actual errored commands used to
 * require `--view tools --output-format json | filter` and then hand-parsing `events.jsonl` because
 * `resultText` was truncated to the first line.
 */
export interface ToolErrorRow {
  name: string;
  detail: string; // full input/command (capped at TOOL_ERROR_TEXT_CAP)
  resultText: string; // full multi-line error text (capped at TOOL_ERROR_TEXT_CAP)
  child: boolean; // ran inside a sub-agent
}

export function buildToolErrors(file: string): ToolErrorRow[] {
  return buildTrace(file)
    .filter((r) => r.kind === "tool" && r.resultStatus === "error")
    .map((r) => ({
      name: r.name ?? "",
      detail: r.detailFull ?? r.detail ?? "",
      resultText: r.resultTextFull ?? r.resultText ?? "",
      child: !!r.child,
    }));
}

export function formatToolErrors(rows: ToolErrorRow[]): string {
  if (!rows.length) return "(no tool errors in this run)";
  const lines = rows.map((r) => {
    // indent continuation lines of a multi-line stderr so the block reads as one entry
    const err = r.resultText
      .split("\n")
      .map((l, i) => (i === 0 ? l : "         " + l))
      .join("\n");
    return `✗ ${r.name}${r.child ? " (sub-agent)" : ""}\n    $ ${r.detail}\n    → ${err}`;
  });
  lines.push(`\n${rows.length} errored tool call(s)`);
  return lines.join("\n");
}

/**
 * `trace --view files` — the run's `workspaceFiles[]` (class / bytes / sha256) as a class-grouped tree
 * with a diff column vs `preRunHashes` (added / modified / removed / unchanged), so "did the skill write
 * where expected / mutate an input" is a one-liner. Both fields live in `result.json`, so this view needs
 * a run dir, not a bare `events.jsonl`.
 */
interface FileRow {
  path: string;
  class?: "output" | "mount" | "input";
  bytes?: number;
  sha256?: string;
  diff: "added" | "modified" | "removed" | "unchanged" | "unavailable";
}
export interface FilesView {
  available: boolean; // false = no sibling result.json (bare events.jsonl was traced)
  reason?: string; // set when !available
  diffAvailable: boolean; // false = the run captured no preRunHashes (microvm / pre-0.27)
  rows: FileRow[];
}

export function buildFilesView(file: string): FilesView {
  const result = readSiblingResult(file);
  if (!result) return { available: false, reason: "files view needs a run dir (no sibling result.json)", diffAvailable: false, rows: [] };
  const wf = result.workspaceFiles ?? [];
  const pre = result.preRunHashes; // Record<path, string | null> | undefined
  const diffAvailable = pre !== undefined;
  const seen = new Set<string>();
  const rows: FileRow[] = [];
  for (const f of wf) {
    seen.add(f.path);
    let diff: FileRow["diff"];
    if (!diffAvailable) diff = "unavailable";
    else {
      const prev = pre![f.path];
      // a scrubbed/over-cap pre-hash (null) or a post-run hashError (sha256 undefined) means we can't
      // compare — surface "unavailable", NEVER a false "unchanged".
      if (prev === null || f.sha256 === undefined) diff = "unavailable";
      else if (prev === undefined) diff = "added";
      else diff = prev === f.sha256 ? "unchanged" : "modified";
    }
    rows.push({ path: f.path, class: f.class, bytes: f.bytes, sha256: f.sha256, diff });
  }
  // removed: a path present pre-run but absent from the post-run tree (skip null pre-hashes — can't tell).
  if (diffAvailable) {
    for (const [p, h] of Object.entries(pre!)) {
      if (seen.has(p) || h === null) continue;
      rows.push({ path: p, diff: "removed" });
    }
  }
  return { available: true, diffAvailable, rows };
}

export function formatFilesView(v: FilesView): string {
  if (!v.available) return `(${v.reason})`;
  if (!v.rows.length) return "(no workspace files recorded for this run)";
  const mark = { added: "+", modified: "~", removed: "-", unchanged: " ", unavailable: "?" } as const;
  const groups: Record<string, FileRow[]> = {};
  for (const r of v.rows) (groups[r.class ?? "(removed)"] ??= []).push(r);
  const lines: string[] = [];
  if (!v.diffAvailable) lines.push("diff vs pre-run: unavailable (no preRunHashes — microvm or pre-0.27 run)\n");
  for (const cls of Object.keys(groups)) {
    lines.push(`${cls}:`);
    for (const r of groups[cls]) {
      const size = r.bytes !== undefined ? ` (${r.bytes}B)` : "";
      lines.push(`  ${mark[r.diff]} ${r.path}${size}${r.diff === "unchanged" ? "" : `  [${r.diff}]`}`);
    }
  }
  lines.push(`\n${v.rows.length} file(s)`);
  return lines.join("\n");
}

/**
 * `trace --view usage` — the per-model token/cost breakdown from `RunResult.modelUsage` plus a per-model
 * cache-read ratio. The default view already prints a single combined cache-ratio FOOTER
 * (`cli.ts`); this view is the full breakdown, so the two don't double-render. Needs a run dir.
 */
interface UsageRow {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
  cacheReadRatio?: number; // cacheRead / (input + cacheRead + cacheCreation); undefined when denom is 0
}
export interface UsageView {
  rows: UsageRow[];
  note?: string; // degrade explanation when rows is empty (no run dir / no usage recorded)
}

export function buildUsageView(file: string): UsageView {
  const result = readSiblingResult(file);
  if (!result) return { rows: [], note: "usage view needs a run dir (no sibling result.json)" };
  const mu = result.modelUsage;
  if (!mu || Object.keys(mu).length === 0) return { rows: [], note: "no usage recorded" };
  const rows: UsageRow[] = Object.entries(mu).map(([model, u]) => ({
    model,
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheReadInputTokens: u.cacheReadInputTokens,
    cacheCreationInputTokens: u.cacheCreationInputTokens,
    costUSD: u.costUSD,
    cacheReadRatio: cacheReadRatio({ [model]: u }), // reuse the single-model denominator guard
  }));
  return { rows };
}

export function formatUsageView(v: UsageView): string {
  if (!v.rows.length) return `(${v.note ?? "no usage recorded"})`;
  const lines = v.rows.map((r) => {
    const cost = r.costUSD !== undefined ? `$${r.costUSD.toFixed(4)}` : "$?";
    const ratio = r.cacheReadRatio !== undefined ? `${Math.round(r.cacheReadRatio * 100)}% cache-read` : "cache-read n/a";
    return `${r.model}: in ${r.inputTokens ?? 0} / out ${r.outputTokens ?? 0} tok · ${cost} · ${ratio}`;
  });
  const totalCost = v.rows.reduce((sum, r) => sum + (r.costUSD ?? 0), 0);
  lines.push(`\n${v.rows.length} model(s), $${totalCost.toFixed(4)} total`);
  return lines.join("\n");
}

export function formatTrace(rows: TraceRow[], opts?: { modelUsage?: RunResult["modelUsage"] }): string {
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
    else if (r.kind === "thinking") lines.push(`~ ${r.detail}`);
  }
  const tools = rows.filter((r) => r.kind === "tool").length;
  const dispatched = rows.filter((r) => r.kind === "dispatch").length;
  lines.push(`\n${tools} tool calls · ${dispatched} sub-agent dispatch(es)`);
  if (opts?.modelUsage) {
    const ratio = cacheReadRatio(opts.modelUsage);
    if (ratio !== undefined) lines.push(`cache-read ratio: ${Math.round(ratio * 100)}%`);
  }
  return lines.join("\n");
}
