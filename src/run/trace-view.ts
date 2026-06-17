import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseMessage, type AgentEvent, type DecisionRequest } from "../agent/session.js";

/**
 * #45: resolve the runs/ root so `trace <run-id>` works from ANY directory, not just from the dir that
 * happens to contain a `runs/`. Order: an explicit `COWORK_HARNESS_RUNS_DIR` override; then a `runs/`
 * under the current cwd (the path `execute.ts`/`chat.ts` write to today — preserved so a read finds a
 * just-written run); then the REPO-relative `runs/` derived from this module's URL (mirrors the
 * `sidecar.ts`/`grants.ts` `fileURLToPath(new URL("../..", import.meta.url))` pattern), which is what
 * makes the cross-directory case work. The WRITERS (`execute.ts`/`chat.ts`) now route through
 * `runsWriteRoot()` below, so a `COWORK_HARNESS_RUNS_DIR` override is honored on write and the
 * write/read roots can no longer drift.
 */
export function runsRoot(): string {
  if (process.env.COWORK_HARNESS_RUNS_DIR) return process.env.COWORK_HARNESS_RUNS_DIR;
  const cwdRuns = join(process.cwd(), "runs");
  if (existsSync(cwdRuns)) return cwdRuns;
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  return join(repoRoot, "runs");
}

/** The root that run WRITERS use: the `COWORK_HARNESS_RUNS_DIR` override if set, else a cwd-relative
 *  `runs/`. This is the env-honoring half of `runsRoot()` (no repo-root fallback — a writer needs a
 *  deterministic target), so a write and a subsequent `trace`/read resolve to the same place. */
export function runsWriteRoot(): string {
  return process.env.COWORK_HARNESS_RUNS_DIR ?? join(process.cwd(), "runs");
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
  description?: string; // dispatch description — identifies an `unknown`-typed dispatch (O1)
  child?: boolean; // ran inside a sub-agent (had a parentToolUseId)
  toolUseId?: string; // for pairing a tool row with its result
  resultStatus?: "ok" | "error"; // the tool's outcome (Part 4 — was invisible before)
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

/** Resolve `arg` to an events.jsonl: a direct file, a run dir, or a run-id/scenario fragment under runs/. */
export function resolveEventsFile(arg: string): string {
  if (existsSync(arg) && statSync(arg).isFile()) return arg;
  if (existsSync(arg) && statSync(arg).isDirectory()) {
    const f = join(arg, "events.jsonl");
    if (existsSync(f)) return f;
  }
  const root = runsRoot(); // #45: repo-relative (or COWORK_HARNESS_RUNS_DIR), not cwd-relative
  if (existsSync(root)) {
    // E: prefer EXACT match first; only fall through to fragment matching if nothing exact was found.
    // Collect ALL fragment matches and warn loudly (with candidates) before picking deterministically.
    for (const scen of readdirSync(root)) {
      const sd = join(root, scen);
      if (!statSync(sd).isDirectory()) continue;
      const direct = join(sd, arg, "events.jsonl");
      if (existsSync(direct)) return direct; // exact run-dir name match under scenario dir
    }
    // Fragment matching: collect all candidates so ambiguity is surfaced, not silently resolved.
    const candidates: string[] = [];
    for (const scen of readdirSync(root)) {
      const sd = join(root, scen);
      if (!statSync(sd).isDirectory()) continue;
      for (const run of readdirSync(sd)) {
        const f = join(sd, run, "events.jsonl");
        if (!existsSync(f)) continue;
        if (run.includes(arg) || scen.includes(arg)) candidates.push(f);
      }
    }
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
      // Sort deterministically (most recent first by run dir name, which encodes a timestamp).
      candidates.sort((a, b) => b.localeCompare(a));
      process.stderr.write(
        `::warning:: ambiguous trace fragment "${arg}" matches ${candidates.length} run dirs:\n` +
          candidates.map((c) => `  ${c}`).join("\n") +
          `\nUsing the most recent: ${candidates[0]}\nPass a more specific id or full path to be deterministic.\n`,
      );
      return candidates[0];
    }
  }
  throw new Error(`no events.jsonl for "${arg}" — pass a run dir, an events.jsonl path, or a run id under runs/`);
}

/** Parse every event from an events.jsonl (the shared first pass for the trace views). */
function eventsOf(file: string): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      // #47: skip malformed JSON (a truncated final line is normal) but be LOUD — mirror cassette.ts.
      process.stderr.write(`::warning:: trace: skipping malformed JSON line in ${file}: ${line.slice(0, 120)}\n`);
      continue;
    }
    events.push(...parseMessage(msg));
  }
  return events;
}

export function buildTrace(file: string, opts: { tools?: boolean } = {}): TraceRow[] {
  const events = eventsOf(file);
  // Pair tool_use ↔ tool_result by toolUseId so each tool row carries its OUTCOME (Part 4) — the single
  // highest-value forensics fix: a tool error (e.g. the O7 q.map) is now visible in one command.
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

export interface GateTraceRow {
  question: string;
  injectedAnswer?: string; // what the harness answered (from control-out.jsonl)
  delivered: "ok" | "error" | "unobserved"; // the tool_result outcome
  error?: string; // first line of the error if delivery failed
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
        // #47: a malformed control-out line is skipped (truncation is normal) but surfaced loudly.
        process.stderr.write(`::warning:: trace: skipping malformed JSON line in ${controlOut}: ${line.slice(0, 120)}\n`);
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
  return rows;
}

export function formatGateTrace(rows: GateTraceRow[]): string {
  if (!rows.length) return "(no AskUserQuestion gates in this run)";
  const mark = { ok: "✓", error: "✗", unobserved: "?" } as const;
  return rows
    .map(
      (r) =>
        `${mark[r.delivered]} gate "${r.question}"\n    answered: ${r.injectedAnswer ?? "(none)"}\n    delivered: ${r.delivered}${r.error ? ` — ${r.error}` : ""}`,
    )
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
 * `trace --dispatches` (#6) — the sub-agent dispatch tree, so an author can read off the REAL total
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
