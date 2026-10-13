/**
 * Harvest WebSearch results from kept run dirs into search-pool records.
 *
 * Reads the RAW frames, not the RunResult copies (those keep only parsed links, or a byte-capped text):
 * - the main loop: `<run>/events.jsonl`, WebSearch `tool_use` blocks with no `parent_tool_use_id`, paired to their
 *   `tool_result` by `tool_use_id`;
 * - each sub-agent: its own transcript, `<run>/claude-config/projects/<proj>/<session>/subagents/agent-<id>.jsonl`,
 *   and its parented frames in events.jsonl (a transcript is not captured for every sub-agent). A search seen in
 *   both produces the same record id and is kept once.
 *
 * Each tool_result is parsed with the inverse of the agent's renderer and split into one record per link set (one
 * search plus its prose). Error results, results the parser cannot read, and results whose header query differs
 * from the tool_use's query are skipped and counted, never guessed at.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { initAgentVersion } from "../run/recorded-agent-version.js";
import { readLegMarker, resolveGraded } from "../run/turn-layout.js";
import { parseWebSearchResult, renderWebSearchResult, splitSearches, type SearchLink } from "./render.js";

export interface RecordSource {
  /** A hash of the run dir's `<scenario>/<run id>`, never a host path. */
  runRef: string;
  scenario: string | null;
  /** The skill under test, without its plugin prefix: a critique run's graded skill, else the one skill the
   *  fingerprint was scoped to, else the one skill the run invoked; null when none of them names exactly one. A pool
   *  holds one skill unless it is built as mixed. */
  skill: string | null;
  /** The skill sources' git HEAD at run time (`skillCommit`), when known. */
  skillRef: string | null;
  /** The skill snapshot's content signature (`fingerprint.contentSig`), the value eval and hillclimb compare arms
   *  by. Null when the run recorded none, which makes a pool's provenance "unknown". */
  variantHash: string | null;
  agentVersion: string | null;
  desktopVersion: string | null;
  model: string | null;
  recordedAt: string | null;
}

export interface PoolRecord {
  /** sha256 over canonical `{query, links, text}`. */
  id: string;
  query: string;
  links: SearchLink[];
  text: string;
  origin: "events" | "child-transcript";
  agent: "main" | "subagent";
  source: RecordSource;
}

export interface HarvestCounts {
  results: number;
  records: number;
  errorResults: number;
  unparsed: number;
  queryMismatch: number;
  /** A search whose only content is the agent's "Web search error" line. */
  searchErrors: number;
  /** Records dropped because another source in the same run produced the same id. */
  duplicates: number;
}

export function recordId(r: { query: string; links: SearchLink[]; text: string }): string {
  const canon = JSON.stringify({ links: r.links.map((l) => ({ title: l.title, url: l.url })), query: r.query, text: r.text });
  return createHash("sha256").update(canon, "utf8").digest("hex");
}

type Block = {
  type?: string;
  name?: string;
  id?: string;
  tool_use_id?: string;
  input?: { query?: unknown };
  content?: unknown;
  is_error?: boolean;
};

/** WebSearch tool_use/tool_result pairs from one jsonl transcript: main-loop frames, parented (sub-agent) frames, or
 *  all of them (a sub-agent's own transcript). */
function pairs(lines: string[], which: "main" | "parented" | "all"): { query: string; content: unknown; isError: boolean }[] {
  const asked = new Map<string, string>();
  const out: { query: string; content: unknown; isError: boolean }[] = [];
  for (const line of lines) {
    if (!line.includes("WebSearch") && !line.includes("tool_result")) continue;
    let o: { parent_tool_use_id?: unknown; message?: { content?: unknown } };
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (which === "main" && o.parent_tool_use_id) continue;
    if (which === "parented" && !o.parent_tool_use_id) continue;
    const c = o.message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c as Block[]) {
      if (b.type === "tool_use" && b.name === "WebSearch" && b.id && typeof b.input?.query === "string") asked.set(b.id, b.input.query);
      else if (b.type === "tool_result" && b.tool_use_id && asked.has(b.tool_use_id))
        out.push({ query: asked.get(b.tool_use_id)!, content: b.content, isError: b.is_error === true });
    }
  }
  return out;
}

function textOf(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content) && content.every((x) => x && typeof x === "object" && (x as { type?: string }).type === "text"))
    return content.map((x) => String((x as { text?: unknown }).text ?? "")).join("");
  return null;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(readFileSync(path, "utf8"));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The run's graded result, through the turn-layout seam (the graded alias, else turn 1). */
function resultOf(runDir: string): Record<string, unknown> | null {
  const p = resolveGraded(runDir, "result.json");
  return p ? readJson(p) : null;
}

function childTranscripts(runDir: string): string[] {
  const projects = join(runDir, "claude-config", "projects");
  const out: string[] = [];
  const ls = (d: string) => {
    try {
      return readdirSync(d);
    } catch {
      return [];
    }
  };
  for (const p of ls(projects))
    for (const s of ls(join(projects, p))) {
      const sub = join(projects, p, s, "subagents");
      for (const f of ls(sub)) if (/^agent-[\w-]+\.jsonl$/.test(f)) out.push(join(sub, f));
    }
  return out.sort();
}

/** A skill name without its plugin prefix (`plugin:skill` → `skill`). */
const bareSkill = (s: string) => s.slice(s.lastIndexOf(":") + 1);

/** The one skill a list names, or null when it names none or several. */
function onlyOne(xs: unknown): string | null {
  if (!Array.isArray(xs)) return null;
  const names = [...new Set(xs.filter((x): x is string => typeof x === "string" && x.length > 0).map(bareSkill))];
  return names.length === 1 ? names[0]! : null;
}

function skillOf(runDir: string, r: Record<string, unknown>): string | null {
  const graded = (readJson(join(runDir, "critique-report.json")) ?? {}).gradedSkill;
  if (typeof graded === "string" && graded.length > 0) return bareSkill(graded);
  return onlyOne((r.fingerprint as { skillScope?: unknown } | undefined)?.skillScope) ?? onlyOne(r.skillsInvoked);
}

/** A run's reference: the hash of `<scenario>/<run id>`, never a host path. A multi-leg run's prompt leg
 *  (`<scenario>/<run id>/legs/<leg>`, marked by `leg.json`) hashes all four parts: its last two alone are
 *  `legs/<leg>`, the same for every run that has a leg of that id. */
export function runRefOf(runDir: string): string {
  const leg = basename(dirname(runDir)) === "legs" && readLegMarker(runDir) !== undefined;
  const root = leg ? dirname(dirname(runDir)) : runDir;
  const key = `${basename(dirname(root))}/${basename(root)}${leg ? `/legs/${basename(runDir)}` : ""}`;
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 16);
}

export function sourceOf(runDir: string, eventLines: string[]): RecordSource {
  const r = resultOf(runDir) ?? {};
  const status = readJson(join(runDir, "status.json")) ?? {};
  const fp = (r.fingerprint ?? {}) as { contentSig?: unknown };
  const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
  const models = Array.isArray(r.models) ? r.models : [];
  const skill = skillOf(runDir, r);
  return {
    runRef: runRefOf(runDir),
    scenario: str(r.scenario),
    skill,
    skillRef: str(r.skillCommit),
    variantHash: str(fp.contentSig),
    agentVersion: initAgentVersion(eventLines) ?? null,
    desktopVersion: str(r.baseline),
    model: str(models[0]),
    recordedAt: str(status.startedAt),
  };
}

/** Harvest one kept run dir. Pure apart from reads. */
export function harvestRun(runDir: string): { records: PoolRecord[]; counts: HarvestCounts } {
  const counts: HarvestCounts = { results: 0, records: 0, errorResults: 0, unparsed: 0, queryMismatch: 0, searchErrors: 0, duplicates: 0 };
  const records: PoolRecord[] = [];
  const eventsPath = join(runDir, "events.jsonl");
  const eventLines = existsSync(eventsPath) && statSync(eventsPath).isFile() ? readFileSync(eventsPath, "utf8").split("\n") : [];
  const source = sourceOf(runDir, eventLines);
  const take = (ps: ReturnType<typeof pairs>, origin: PoolRecord["origin"], agent: PoolRecord["agent"]) => {
    for (const p of ps) {
      counts.results++;
      if (p.isError) {
        counts.errorResults++;
        continue;
      }
      const t = textOf(p.content);
      const parsed = t === null ? null : parseWebSearchResult(t);
      if (!parsed || !parsed.ok) {
        counts.unparsed++;
        continue;
      }
      // Keep only what the agent's renderer would reproduce byte-for-byte: anything else was guessed at.
      if (renderWebSearchResult(parsed.result) !== t) {
        counts.unparsed++;
        continue;
      }
      if (parsed.result.query !== p.query) {
        counts.queryMismatch++;
        continue;
      }
      for (const s of splitSearches(parsed.result)) {
        if (s.links.length === 0 && /^Web search error: /.test(s.text)) {
          counts.searchErrors++;
          continue;
        }
        const rec = { query: p.query, links: s.links, text: s.text };
        records.push({ id: recordId(rec), ...rec, origin, agent, source });
        counts.records++;
      }
    }
  };
  take(pairs(eventLines, "main"), "events", "main");
  // A sub-agent's search is read from its own transcript AND from its parented frames in events.jsonl: the
  // transcript is not captured for every sub-agent, and the frames carry the same tool_result text, so the two
  // produce the same record id and the copy is dropped below.
  take(pairs(eventLines, "parented"), "events", "subagent");
  for (const f of childTranscripts(runDir)) take(pairs(readFileSync(f, "utf8").split("\n"), "all"), "child-transcript", "subagent");
  const seen = new Set<string>();
  const unique = records.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  counts.duplicates = records.length - unique.length;
  counts.records = unique.length;
  return { records: unique, counts };
}
