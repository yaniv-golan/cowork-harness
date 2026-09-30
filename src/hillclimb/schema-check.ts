// Our reading of the hillclimb flow-directory contract, as published in anthropics/skills@8a1541c4a3ff under
// skills/claude-api/shared/evals/: report/SCHEMA.md (the state the report adapter PRODUCES), build-eval.md and
// eval-hillclimb.md (the results.jsonl / traces / _state.json the runner WRITES), report/runner-scaffold.mjs (the
// reference runner) and report/build-report-lite.mjs (the lite report builder). It checks a flow directory
// against that reading and returns findings.
//
// What it is NOT: a validator of the full report viewer. That viewer (build-report.mjs and its lib/) is not
// published at the pinned commit, so nothing here can prove the full viewer renders a flow correctly. A flow
// with zero findings is one this reading accepts, nothing more. Every finding carries the reading label for
// that reason.
//
// Two profiles:
//   - "schema":  only what the published sources state.
//   - "harness" (default): adds the conventions cowork-harness's own runner writes on top: `rep` always present,
//     `grade` always the dict form, `status` only "ok" or "truncated" (as the scaffold writes it), explanation
//     keys a subset of grade keys, and judge rationale marked untrusted. A flow written by some other runner
//     should be checked with "schema".
//
// Pure: `checkFlowSnapshot` reads nothing; `loadFlowSnapshot` is the only function that touches the disk, and
// it never follows a symlink (it records one as a finding instead).
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const SCHEMA_READING_COMMIT = "8a1541c4a3ffa5a20a5a91de0dcf3f0bab1d1ef4";
export const SCHEMA_READING = "our reading of SCHEMA.md@8a1541c4a3ff (with build-eval.md, runner-scaffold.mjs, build-report-lite.mjs)";
export const SCHEMA_READING_DISCLAIMER =
  "This checks our reading of the published hillclimb sources; it proves nothing about the full report viewer, which is not published.";

export type FindingLevel = "error" | "note";

export interface SchemaFinding {
  level: FindingLevel;
  /** Stable rule id, e.g. `row.grade`. */
  rule: string;
  /** Path relative to the flow root (`/`-separated). */
  file: string;
  /** 1-based line for JSONL files. */
  line?: number;
  message: string;
}

export interface SchemaCheckReport {
  reading: string;
  disclaimer: string;
  profile: SchemaProfile;
  findings: SchemaFinding[];
  errors: number;
  notes: number;
}

export type SchemaProfile = "schema" | "harness";

export interface VariantSnapshot {
  results?: string;
  errors?: string;
  summary?: string;
  /** Trace file basename -> text. */
  traces: Record<string, string>;
}

export interface FlowSnapshot {
  /** Top-level entries of the flow dir. A symlink is `symlink`, never `dir`. */
  entries: { name: string; kind: "dir" | "file" | "symlink" | "other" }[];
  /** `_state.json` text, when present. */
  state?: string;
  /** Keyed by variant dir name, for every top-level dir whose name the lite builder accepts (`baseline|v\d+`). */
  variants: Record<string, VariantSnapshot>;
  /** Every regular file under the flow root (relative, `/`-separated). When absent, attachment refs are not
   *  checked for existence. */
  files?: string[];
  /** Every symlink met anywhere under the flow root (relative). */
  symlinks?: string[];
}

// ---- constants read from the sources -------------------------------------------------------------------------

/** runner-scaffold.mjs l.199. Stricter than the lite builder's `v\d+` (build-report-lite.mjs l.156). */
export const VARIANT_DIR_RE = /^(baseline|v[1-9]\d*)$/;
const LITE_VARIANT_DIR_RE = /^(baseline|v\d+)$/;
/** build-report-lite.mjs l.231: directory names the lite builder ignores without a warning. */
const LITE_NON_VARIANT_DIRS = new Set(["trajectory", "attachments", "refs", "ref", "inputs", "out", "target", "__pycache__"]);
/** build-report-lite.mjs l.342: a trace link is emitted only for such an id. */
const LINK_SAFE_ID_RE = /^[A-Za-z0-9_.-]+$/;
/** runner-scaffold.mjs pathSafeId: an id it passes through unchanged is `[\w.-]` and at most 129 chars. */
const PATH_SAFE_MAX = 129;
/** build-eval.md l.119 and runner-scaffold.mjs perf keys: `usage` keys read by exact name. */
export const USAGE_KEYS = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const;
/** Top-level numeric perf keys: build-eval.md l.118 plus SCHEMA.md l.93's default perf set. */
const NUMERIC_PERF_KEYS = ["cost_usd", "latency_s", "tool_calls", "web_searches", "in_tokens", "out_tokens"] as const;
const METRIC_KINDS = new Set(["binary", "float", "judge"]);
const METRIC_LABEL_MAX = 14;
/** SCHEMA.md l.205. */
const TURN_ROLES = new Set(["system", "user", "assistant", "tool_call", "tool_result"]);
const TURN_KEYS = new Set(["role", "content", "name", "thinking", "attachments"]);
/** SCHEMA.md l.172-173. */
const ATTACHMENT_KINDS = new Set(["image", "svg", "html", "pdf", "json", "text", "code", "file", "url"]);
/** runner-scaffold.mjs failure classes (l.291, 318, 491, 555). Others are allowed but noted. */
const KNOWN_FAILURE_CLASSES = new Set(["error", "serving_substitution", "timeout"]);
/** runner-scaffold.mjs l.551-564: every key an errors.jsonl line may carry. `meta` is ours. */
const ERROR_ROW_KEYS = new Set([
  "prompt_id",
  "rep",
  "original_id",
  "failure_class",
  "error",
  "retries",
  "judge_retries",
  "model",
  "usage",
  "judge_model",
  "judge_usage",
  "latency_s",
  "meta",
]);
/** cowork-harness convention: every judge rationale is prefixed so a reader never takes it as instructions. */
export const UNTRUSTED_JUDGE_PREFIX = "[untrusted judge] ";
const TRACE_NAME_RE = /^(.+)_rep(\d+)\.json$/;
const FLAT_TRACE_NAME_RE = /^(.+)\.json$/;

// ---- helpers ------------------------------------------------------------------------------------------------

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isFiniteNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isNonNegInt = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0;

/** A `prompt_id` the lite builder links a trace for (build-report-lite.mjs l.342). */
export function isLinkSafeId(id: string): boolean {
  return LINK_SAFE_ID_RE.test(id) && !/^\.+$/.test(id);
}

/** An id the scaffold's `pathSafeId` returns unchanged, i.e. one that can ever equal a row's `prompt_id`. */
export function isPathSafeId(id: string): boolean {
  return /^[\w.-]+$/.test(id) && id.length <= PATH_SAFE_MAX;
}

function camelToSnake(k: string): string {
  return k.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
}

interface Declared {
  metrics: { id: string; kind?: string }[];
  perfFields: string[];
  metricsDeclared: boolean;
  splitIds: Map<string, string>;
}

class Collector {
  readonly findings: SchemaFinding[] = [];
  add(level: FindingLevel, rule: string, file: string, message: string, line?: number): void {
    this.findings.push(line === undefined ? { level, rule, file, message } : { level, rule, file, line, message });
  }
  error(rule: string, file: string, message: string, line?: number): void {
    this.add("error", rule, file, message, line);
  }
  note(rule: string, file: string, message: string, line?: number): void {
    this.add("note", rule, file, message, line);
  }
}

function parseJsonl(text: string): { line: number; value?: unknown; bad?: string }[] {
  const out: { line: number; value?: unknown; bad?: string }[] = [];
  text.split("\n").forEach((raw, i) => {
    if (!raw.trim()) return;
    try {
      out.push({ line: i + 1, value: JSON.parse(raw) });
    } catch (e) {
      out.push({ line: i + 1, bad: e instanceof Error ? e.message : String(e) });
    }
  });
  return out;
}

// ---- per-shape checks ---------------------------------------------------------------------------------------

function checkAttachments(c: Collector, file: string, where: string, v: unknown, files: Set<string> | undefined, line?: number): void {
  if (!Array.isArray(v)) {
    c.error("attachments.shape", file, `${where}.attachments must be a list of {kind?, ref, alt?}`, line);
    return;
  }
  v.forEach((a, i) => {
    const at = `${where}.attachments[${i}]`;
    if (!isObj(a)) {
      c.error("attachments.shape", file, `${at} must be an object`, line);
      return;
    }
    if (a.kind !== undefined && (typeof a.kind !== "string" || !ATTACHMENT_KINDS.has(a.kind)))
      c.error("attachments.kind", file, `${at}.kind ${JSON.stringify(a.kind)} is not one of ${[...ATTACHMENT_KINDS].join("|")}`, line);
    if (a.alt !== undefined && typeof a.alt !== "string") c.error("attachments.shape", file, `${at}.alt must be a string`, line);
    if (typeof a.ref !== "string" || !a.ref) {
      c.error("attachments.ref", file, `${at}.ref must be a non-empty string`, line);
      return;
    }
    const ref = a.ref;
    if (ref.startsWith("data:") || /^https?:\/\//i.test(ref)) return;
    if (ref.startsWith("/") || /^[A-Za-z]:[\\/]/.test(ref) || ref.includes("\\")) {
      c.error("attachments.ref", file, `${at}.ref must be a path relative to the flow root, a data: URI or a URL`, line);
      return;
    }
    if (ref.split("/").some((s) => s === ".." || s === ".")) {
      c.error("attachments.ref", file, `${at}.ref has a '.' or '..' segment`, line);
      return;
    }
    if (files && !files.has(ref))
      c.error("attachments.ref", file, `${at}.ref ${JSON.stringify(ref)} is not a regular file in the flow`, line);
  });
}

function checkUsage(c: Collector, file: string, key: string, v: unknown, line?: number): void {
  if (!isObj(v)) {
    c.error("usage.shape", file, `${key} must be an object`, line);
    return;
  }
  const known = new Set<string>(USAGE_KEYS);
  for (const [k, val] of Object.entries(v)) {
    if (known.has(k)) {
      // The SDK types the two cache counters as number | null.
      if (val === null && k.startsWith("cache_")) continue;
      if (!isNonNegInt(val)) c.error("usage.value", file, `${key}.${k} must be a non-negative integer`, line);
      continue;
    }
    const snake = camelToSnake(k);
    if (known.has(snake)) c.error("usage.key", file, `${key}.${k} is read by exact name; spell it ${snake}`, line);
    else c.note("usage.key", file, `${key}.${k} is not one of the keys the report reads (${USAGE_KEYS.join(", ")})`, line);
  }
}

function readDeclared(c: Collector, text: string | undefined): Declared {
  const d: Declared = { metrics: [], perfFields: [], metricsDeclared: false, splitIds: new Map() };
  const F = "_state.json";
  if (text === undefined) {
    c.note("state.absent", F, "no _state.json: metrics are inferred from grade keys, and any explanation key flips a metric to judge");
    return d;
  }
  let st: unknown;
  try {
    st = JSON.parse(text);
  } catch (e) {
    c.error("state.json", F, `not valid JSON (${e instanceof Error ? e.message : String(e)}); the scaffold refuses to run`);
    return d;
  }
  if (!isObj(st)) {
    c.error("state.json", F, "must be a JSON object");
    return d;
  }

  // build-report-lite.mjs l.298: `state.metrics || state.criteria` (the legacy key).
  let metricsCfg = st.metrics;
  if (metricsCfg === undefined && st.criteria !== undefined) {
    c.note("state.metrics", F, "metrics declared under the legacy `criteria` key; the report reads it, but `metrics` is the current name");
    metricsCfg = st.criteria;
  }
  if (metricsCfg === undefined) {
    c.note("state.metrics", F, "no `metrics`: kinds are inferred, and any explanation key flips a metric to judge");
  } else if (!Array.isArray(metricsCfg)) {
    c.error("state.metrics", F, "`metrics` must be a list");
  } else {
    d.metricsDeclared = true;
    const seen = new Set<string>();
    metricsCfg.forEach((m: unknown, i: number) => {
      const at = `metrics[${i}]`;
      if (typeof m === "string") {
        if (seen.has(m)) c.error("state.metrics", F, `${at}: duplicate metric id ${JSON.stringify(m)}`);
        seen.add(m);
        d.metrics.push({ id: m });
        return;
      }
      if (!isObj(m) || typeof m.id !== "string" || !m.id) {
        c.error("state.metrics", F, `${at} must be a string or an object with a non-empty string id`);
        return;
      }
      if (seen.has(m.id)) c.error("state.metrics", F, `${at}: duplicate metric id ${JSON.stringify(m.id)}`);
      seen.add(m.id);
      if (m.kind !== undefined && (typeof m.kind !== "string" || !METRIC_KINDS.has(m.kind)))
        c.error("state.metrics", F, `${at}.kind must be binary|float|judge`);
      else if (m.kind === undefined) c.note("state.metrics", F, `${at} (${m.id}) has no kind; SCHEMA.md marks kind required`);
      if (m.label !== undefined) {
        if (typeof m.label !== "string") c.error("state.metrics", F, `${at}.label must be a string`);
        else if (m.label.length > METRIC_LABEL_MAX)
          c.note("state.metrics", F, `${at}.label is ${m.label.length} chars; the full viewer truncates past ${METRIC_LABEL_MAX}`);
      }
      if (m.scale !== undefined && !isFiniteNum(m.scale)) c.error("state.metrics", F, `${at}.scale must be a number`);
      if (m.better !== undefined && m.better !== "higher" && m.better !== "lower")
        c.error("state.metrics", F, `${at}.better must be higher|lower`);
      d.metrics.push({ id: m.id, kind: typeof m.kind === "string" ? m.kind : undefined });
    });
  }

  if (st.perf_fields !== undefined) {
    if (!Array.isArray(st.perf_fields)) c.error("state.perf_fields", F, "`perf_fields` must be a list of {id, label?, unit?}");
    else
      st.perf_fields.forEach((p: unknown, i: number) => {
        if (!isObj(p) || typeof p.id !== "string" || !p.id) {
          c.error("state.perf_fields", F, `perf_fields[${i}] must be an object with a non-empty string id`);
          return;
        }
        if (p.label !== undefined && typeof p.label !== "string")
          c.error("state.perf_fields", F, `perf_fields[${i}].label must be a string`);
        if (p.unit !== undefined && typeof p.unit !== "string") c.error("state.perf_fields", F, `perf_fields[${i}].unit must be a string`);
        d.perfFields.push(p.id);
      });
  }

  for (const sp of ["train", "val", "test"]) {
    const key = `${sp}_ids`;
    const ids = st[key];
    if (ids === undefined) continue;
    if (!Array.isArray(ids)) {
      c.error("state.split", F, `\`${key}\` must be a list of ids (the scaffold exits 2)`);
      continue;
    }
    for (const raw of ids) {
      if (typeof raw !== "string" && typeof raw !== "number") {
        c.error("state.split", F, `${key} holds a non-string id ${JSON.stringify(raw)}`);
        continue;
      }
      const id = String(raw);
      if (!isPathSafeId(id)) {
        c.error("state.split", F, `${key} id ${JSON.stringify(id)} is not a path-safe id and can never match a row (the scaffold exits 2)`);
        continue;
      }
      const prev = d.splitIds.get(id);
      if (prev && prev !== sp) c.error("state.split", F, `id ${JSON.stringify(id)} is in both ${prev}_ids and ${key}`);
      d.splitIds.set(id, sp);
    }
  }

  if (st.harness_paths !== undefined) {
    if (!Array.isArray(st.harness_paths)) c.error("state.harness_paths", F, "`harness_paths` must be a list of paths");
    // The scaffold maps each entry through String(), so a non-string still works; it is just unusual.
    else if (!st.harness_paths.every((p) => typeof p === "string"))
      c.note("state.harness_paths", F, "`harness_paths` holds a non-string entry; the scaffold stringifies it");
  }
  if (st.harness_sha !== undefined && typeof st.harness_sha !== "string") c.error("state.harness_sha", F, "`harness_sha` must be a string");
  return d;
}

function checkRow(
  c: Collector,
  file: string,
  line: number,
  r: unknown,
  d: Declared,
  profile: SchemaProfile,
  files: Set<string> | undefined,
): { id?: string; rep?: number; repMissing?: boolean } {
  if (!isObj(r)) {
    c.error("row.shape", file, "a results.jsonl line must be a JSON object", line);
    return {};
  }
  let id: string | undefined;
  if (r.prompt_id === undefined) {
    const alias = r.id !== undefined ? "id" : r.case_id !== undefined ? "case_id" : undefined;
    if (alias) {
      c.note(
        "row.prompt_id",
        file,
        `case id spelled \`${alias}\`; the report accepts it, the scaffold and our runner write \`prompt_id\``,
        line,
      );
      id = String(r[alias]);
    } else {
      c.error("row.prompt_id", file, "no prompt_id: the lite builder skips this row with a warning", line);
    }
  } else if (typeof r.prompt_id !== "string" || !r.prompt_id) {
    c.error("row.prompt_id", file, "prompt_id must be a non-empty string", line);
  } else {
    id = r.prompt_id;
  }
  if (id !== undefined && !isLinkSafeId(id))
    c.error(
      "row.prompt_id",
      file,
      `prompt_id ${JSON.stringify(id)} is not link-safe (^[A-Za-z0-9_.-]+$, not all dots): no trace link is emitted`,
      line,
    );

  let rep: number | undefined;
  // Upstream `rep` is optional and defaults to the row's index among its case's rows (SCHEMA.md `rep?`,
  // build-report-lite.mjs l.341); resume in the scaffold and in our runner keys on it, so the harness requires it.
  if (r.rep === undefined) {
    if (profile === "harness") c.error("row.rep", file, "no rep: resume keys on (prompt_id, rep)", line);
    else c.note("row.rep", file, "no rep: the report uses the row's index among its case's rows", line);
  } else if (!isNonNegInt(r.rep)) c.error("row.rep", file, `rep must be a non-negative integer, got ${JSON.stringify(r.rep)}`, line);
  else rep = r.rep;

  if (typeof r.prompt !== "string") c.error("row.prompt", file, "prompt (the full prompt text) must be a string", line);
  if (r.tags !== undefined && !(Array.isArray(r.tags) && r.tags.every((t) => typeof t === "string")))
    c.error("row.tags", file, "tags must be a list of strings (tags[0] is the grouping key)", line);
  if (r.meta !== undefined && !isObj(r.meta)) c.error("row.meta", file, "meta must be an object", line);
  for (const k of ["model", "stop_reason", "judge_model"] as const)
    if (r[k] !== undefined && typeof r[k] !== "string") c.error(`row.${k}`, file, `${k} must be a string`, line);
  if (r.usage !== undefined) checkUsage(c, file, "usage", r.usage, line);
  if (r.judge_usage !== undefined) checkUsage(c, file, "judge_usage", r.judge_usage, line);

  const perf = new Set<string>([...NUMERIC_PERF_KEYS, ...d.perfFields]);
  for (const k of perf) {
    if (r[k] === undefined) continue;
    if (!isFiniteNum(r[k])) c.error("row.perf", file, `${k} must be a finite number, got ${JSON.stringify(r[k])}`, line);
  }
  for (const k of d.perfFields)
    if (r[k] === undefined) c.note("row.perf", file, `declared perf field ${k} is absent (the table shows an empty cell)`, line);

  // SCHEMA.md: `status` is present only when not 'ok' (e.g. 'truncated'); the scaffold writes "ok" or
  // "truncated" on every row. The report keeps any other value out of the means.
  if (r.status !== undefined && r.status !== "ok" && r.status !== "truncated") {
    const msg = `status ${JSON.stringify(r.status)} is neither "ok" nor "truncated": the report keeps this rep out of the means`;
    if (profile === "harness") c.error("row.status", file, msg, line);
    else c.note("row.status", file, msg, line);
  }

  // grade: the dict form, every declared metric present.
  const grade = r.grade;
  let gradeKeys: Set<string> | undefined;
  if (!isObj(grade)) {
    // A bare boolean or number is valid upstream (build-eval.md l.118; the report reads it as {score}). It only
    // renders blank when metrics are declared, since none of them is `score`. Our runner always writes the dict.
    const bare = typeof grade === "boolean" || isFiniteNum(grade);
    if (grade === undefined) c.error("row.grade", file, "no grade", line);
    else if (bare && profile === "schema" && !d.metricsDeclared)
      c.note("row.grade", file, `bare grade ${JSON.stringify(grade)}: the report reads it as the metric \`score\``, line);
    else
      c.error(
        "row.grade",
        file,
        bare
          ? `bare grade ${JSON.stringify(grade)}: the report reads it as \`score\`, which is no declared metric, so every metric cell is blank with no warning`
          : `grade must be a {metric_id: number} object; ${JSON.stringify(grade)} renders as a blank cell with no warning`,
        line,
      );
  } else {
    gradeKeys = new Set(Object.keys(grade));
    if (gradeKeys.size === 0) c.error("row.grade", file, "grade is an empty object", line);
    for (const [k, v] of Object.entries(grade))
      if (!isFiniteNum(v) && typeof v !== "boolean")
        c.error("row.grade", file, `grade.${k} must be a number or boolean; the report drops it silently`, line);
    for (const m of d.metrics) {
      if (!(m.id in grade)) {
        c.error("row.grade", file, `declared metric ${m.id} is missing from grade`, line);
        continue;
      }
      const v = grade[m.id];
      if (m.kind === "binary" && !(v === 0 || v === 1 || typeof v === "boolean"))
        c.error("row.grade", file, `grade.${m.id} is declared binary but is ${JSON.stringify(v)}`, line);
    }
  }

  // explanation: keys a subset of grade keys, string values.
  if (r.explanation !== undefined) {
    if (!isObj(r.explanation)) {
      c.error("row.explanation", file, "explanation must be a {metric_id: string} object", line);
    } else {
      const keys = Object.keys(r.explanation);
      for (const k of keys) {
        const v = r.explanation[k];
        if (typeof v !== "string") c.error("row.explanation", file, `explanation.${k} must be a string`, line);
        // Ours, not upstream: the report shows an explanation for any key.
        if (profile === "harness" && gradeKeys && !gradeKeys.has(k))
          c.error("row.explanation", file, `explanation.${k} has no matching grade key`, line);
        if (profile === "harness" && typeof v === "string" && !v.startsWith(UNTRUSTED_JUDGE_PREFIX))
          c.error("row.explanation", file, `explanation.${k} lacks the ${JSON.stringify(UNTRUSTED_JUDGE_PREFIX)} prefix`, line);
      }
      if (keys.length && !d.metricsDeclared)
        c.note(
          "row.explanation",
          file,
          "explanation keys with no declared metrics: the report infers those metrics as judge, which moves the primary metric",
          line,
        );
      if (profile === "harness" && keys.length && !(isObj(r.meta) && r.meta.explanation_untrusted === true))
        c.error("row.explanation", file, "explanation present but meta.explanation_untrusted is not true", line);
    }
  }

  if (r.attachments !== undefined) checkAttachments(c, file, "row", r.attachments, files, line);
  return { id, rep, repMissing: r.rep === undefined };
}

function checkErrorRow(c: Collector, file: string, line: number, e: unknown): void {
  if (!isObj(e)) {
    c.error("error.shape", file, "an errors.jsonl line must be a JSON object", line);
    return;
  }
  if (typeof e.prompt_id !== "string" || !e.prompt_id) c.error("error.prompt_id", file, "prompt_id must be a non-empty string", line);
  else if (!isLinkSafeId(e.prompt_id)) c.error("error.prompt_id", file, `prompt_id ${JSON.stringify(e.prompt_id)} is not link-safe`, line);
  if (!isNonNegInt(e.rep)) c.error("error.rep", file, "rep must be a non-negative integer", line);
  if (typeof e.failure_class !== "string" || !e.failure_class)
    c.error("error.failure_class", file, "failure_class must be a non-empty string", line);
  else if (!KNOWN_FAILURE_CLASSES.has(e.failure_class))
    c.note(
      "error.failure_class",
      file,
      `failure_class ${JSON.stringify(e.failure_class)} is not one the scaffold writes (error, serving_substitution, timeout)`,
      line,
    );
  if (typeof e.error !== "string") c.error("error.error", file, "error (the message) must be a string", line);
  for (const k of ["retries", "judge_retries"] as const)
    if (!isNonNegInt(e[k])) c.error(`error.${k}`, file, `${k} must be a non-negative integer`, line);
  if (!isFiniteNum(e.latency_s) || e.latency_s < 0) c.error("error.latency_s", file, "latency_s must be a non-negative number", line);
  for (const k of ["original_id", "model", "judge_model"] as const)
    if (e[k] !== undefined && typeof e[k] !== "string") c.error(`error.${k}`, file, `${k} must be a string`, line);
  if (e.usage !== undefined) checkUsage(c, file, "usage", e.usage, line);
  if (e.judge_usage !== undefined) checkUsage(c, file, "judge_usage", e.judge_usage, line);
  if (e.meta !== undefined && !isObj(e.meta)) c.error("error.meta", file, "meta must be an object", line);
  for (const k of Object.keys(e)) if (!ERROR_ROW_KEYS.has(k)) c.note("error.key", file, `unexpected key ${k}`, line);
}

function checkTrace(c: Collector, file: string, text: string, files: Set<string> | undefined): void {
  let turns: unknown;
  try {
    turns = JSON.parse(text);
  } catch (e) {
    c.error("trace.json", file, `not valid JSON (${e instanceof Error ? e.message : String(e)})`);
    return;
  }
  if (!Array.isArray(turns)) {
    c.error("trace.shape", file, "a trace must be a JSON list of turns");
    return;
  }
  turns.forEach((t, i) => {
    const at = `turn[${i}]`;
    if (!isObj(t)) {
      c.error("trace.turn", file, `${at} must be an object`);
      return;
    }
    if (typeof t.role !== "string" || !TURN_ROLES.has(t.role)) {
      c.error("trace.role", file, `${at}.role ${JSON.stringify(t.role)} is not one of ${[...TURN_ROLES].join("|")}`);
      return;
    }
    if (typeof t.content !== "string") c.error("trace.content", file, `${at}.content must be a string (turns do not nest)`);
    if (t.role === "tool_call" && (typeof t.name !== "string" || !t.name)) c.error("trace.name", file, `${at} is a tool_call with no name`);
    else if (t.name !== undefined && typeof t.name !== "string") c.error("trace.name", file, `${at}.name must be a string`);
    if (t.thinking !== undefined && typeof t.thinking !== "string") c.error("trace.thinking", file, `${at}.thinking must be a string`);
    if (t.attachments !== undefined) checkAttachments(c, file, at, t.attachments, files);
    for (const k of Object.keys(t)) if (!TURN_KEYS.has(k)) c.note("trace.key", file, `${at} has unexpected key ${k}`);
  });
}

// ---- entry points -------------------------------------------------------------------------------------------

export function checkFlowSnapshot(snap: FlowSnapshot, opts: { profile?: SchemaProfile } = {}): SchemaCheckReport {
  const profile = opts.profile ?? "harness";
  const c = new Collector();
  const files = snap.files ? new Set(snap.files) : undefined;

  for (const s of snap.symlinks ?? [])
    c.error("flow.symlink", s, "a symlink in the flow dir: the builders refuse to read or link through it");

  // Variant directory names.
  for (const e of snap.entries) {
    if (e.name.startsWith(".") || e.name.startsWith("_")) continue;
    if (e.kind === "symlink" && LITE_VARIANT_DIR_RE.test(e.name)) {
      c.error("variant.symlink", e.name, "a variant dir that is a symlink is silently skipped by the lite builder");
      continue;
    }
    if (e.kind !== "dir") continue;
    if (VARIANT_DIR_RE.test(e.name)) continue;
    if (LITE_VARIANT_DIR_RE.test(e.name))
      c.error("variant.name", e.name, "the lite builder accepts this name but the runner scaffold refuses it: use baseline or v1, v2, ...");
    else if (!LITE_NON_VARIANT_DIRS.has(e.name))
      c.error("variant.name", e.name, "not a variant dir name (baseline or v<N>): the report ignores it with a warning");
  }
  if (!snap.entries.some((e) => e.kind === "dir" && e.name === "baseline"))
    c.error("variant.baseline", "baseline", "no baseline/ directory: the first variant is treated as the baseline");

  const d = readDeclared(c, snap.state);
  const seenIds = new Set<string>();

  for (const [v, vs] of Object.entries(snap.variants)) {
    // v0/v01 are reported by name above, but the lite builder still reads them, so their rows are checked too.
    const rowKeys = new Set<string>();
    const resultsFile = `${v}/results.jsonl`;
    if (vs.results === undefined) {
      c.error("variant.results", resultsFile, "missing: the variant has no rows");
    } else {
      if (vs.results.length && !vs.results.endsWith("\n"))
        c.note("row.torn", resultsFile, "does not end in a newline: the next append joins its last line unless the writer repairs it");
      let n = 0;
      const perCase = new Map<string, number>();
      for (const { line, value, bad } of parseJsonl(vs.results)) {
        if (bad !== undefined) {
          c.error("row.json", resultsFile, `malformed JSON (${bad}): the lite builder skips it with a warning`, line);
          continue;
        }
        n++;
        const { id, rep: given, repMissing } = checkRow(c, resultsFile, line, value, d, profile, files);
        let rep = given;
        if (id !== undefined) {
          seenIds.add(id);
          const k = perCase.get(id) ?? 0;
          perCase.set(id, k + 1);
          // build-report-lite.mjs l.341: `r.rep ?? k`, k the row's index among its case's rows.
          if (repMissing && profile === "schema") rep = k;
        }
        if (id !== undefined && rep !== undefined) {
          const k = `${id}\0${rep}`;
          if (rowKeys.has(k)) c.error("row.duplicate", resultsFile, `duplicate (prompt_id, rep) = (${id}, ${rep})`, line);
          rowKeys.add(k);
        }
      }
      if (n === 0) c.error("variant.results", resultsFile, "no rows: the lite builder drops this variant (or refuses, for the first)");
    }

    if (vs.errors !== undefined)
      for (const { line, value, bad } of parseJsonl(vs.errors)) {
        if (bad !== undefined) c.error("error.json", `${v}/errors.jsonl`, `malformed JSON (${bad})`, line);
        else checkErrorRow(c, `${v}/errors.jsonl`, line, value);
      }

    if (vs.summary !== undefined) {
      const F = `${v}/summary.json`;
      let s: unknown;
      try {
        s = JSON.parse(vs.summary);
      } catch {
        s = undefined;
        c.error("summary.json", F, "not valid JSON: the report falls back silently");
      }
      if (s !== undefined && !isObj(s)) c.error("summary.json", F, "must be a JSON object");
      else if (isObj(s) && s.model !== undefined && typeof s.model !== "string") c.error("summary.model", F, "model must be a string");
    }

    const traceKeys = new Set<string>();
    for (const [name, text] of Object.entries(vs.traces)) {
      const F = `${v}/traces/${name}`;
      // <id>_rep<k>.json, or the flat <id>.json the report links as rep 0 (build-report-lite.mjs l.344).
      const m = TRACE_NAME_RE.exec(name) ?? FLAT_TRACE_NAME_RE.exec(name);
      if (!m || !isLinkSafeId(m[1]!))
        c.error("trace.name", F, "not named <prompt_id>_rep<k>.json (or <prompt_id>.json) with a link-safe id: the report never links it");
      else {
        const k = `${m[1]}\0${Number(m[2] ?? 0)}`;
        traceKeys.add(k);
        if (vs.results !== undefined && !rowKeys.has(k)) c.note("trace.orphan", F, "no results.jsonl row for this (prompt_id, rep)");
      }
      checkTrace(c, F, text, files);
    }
    for (const k of rowKeys)
      if (!traceKeys.has(k)) {
        const [id, rep] = k.split("\0");
        c.note("trace.missing", `${v}/traces/${id}_rep${rep}.json`, "row has no trace: no click-through for this rep");
      }
  }

  for (const [id, sp] of d.splitIds)
    if (!seenIds.has(id))
      c.note("state.split", "_state.json", `${sp}_ids id ${JSON.stringify(id)} matches no row (expected only for a trimmed run)`);

  const errors = c.findings.filter((f) => f.level === "error").length;
  return {
    reading: SCHEMA_READING,
    disclaimer: SCHEMA_READING_DISCLAIMER,
    profile,
    findings: c.findings,
    errors,
    notes: c.findings.length - errors,
  };
}

/** Reads a flow dir into a snapshot. Never follows a symlink: each one met is recorded, not entered. */
export function loadFlowSnapshot(flowDir: string): FlowSnapshot {
  const snap: FlowSnapshot = { entries: [], variants: {}, files: [], symlinks: [] };
  const readIf = (p: string): string | undefined => {
    const st = lstatSync(p, { throwIfNoEntry: false });
    return st?.isFile() ? readFileSync(p, "utf8") : undefined;
  };
  for (const e of readdirSync(flowDir, { withFileTypes: true })) {
    const kind = e.isSymbolicLink() ? "symlink" : e.isDirectory() ? "dir" : e.isFile() ? "file" : "other";
    snap.entries.push({ name: e.name, kind });
  }
  const walk = (rel: string): void => {
    for (const e of readdirSync(join(flowDir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) snap.symlinks!.push(r);
      else if (e.isDirectory()) walk(r);
      else if (e.isFile()) snap.files!.push(r);
    }
  };
  walk("");
  snap.state = readIf(join(flowDir, "_state.json"));
  for (const e of snap.entries) {
    if (e.kind !== "dir" || !LITE_VARIANT_DIR_RE.test(e.name)) continue;
    const vdir = join(flowDir, e.name);
    const traces: Record<string, string> = {};
    const tdir = join(vdir, "traces");
    if (lstatSync(tdir, { throwIfNoEntry: false })?.isDirectory())
      for (const t of readdirSync(tdir, { withFileTypes: true }))
        if (t.isFile() && t.name.endsWith(".json")) traces[t.name] = readFileSync(join(tdir, t.name), "utf8");
    snap.variants[e.name] = {
      results: readIf(join(vdir, "results.jsonl")),
      errors: readIf(join(vdir, "errors.jsonl")),
      summary: readIf(join(vdir, "summary.json")),
      traces,
    };
  }
  return snap;
}

export function checkFlowDir(flowDir: string, opts: { profile?: SchemaProfile } = {}): SchemaCheckReport {
  return checkFlowSnapshot(loadFlowSnapshot(flowDir), opts);
}
