/**
 * Content redaction for committed cassettes. DISTINCT from `secrets.ts` (which scrubs auth
 * tokens): this redacts author-configured PII patterns out of the cassette surface before it is written.
 *
 * Two hard requirements drive the design:
 *  - STRUCTURAL (not line-level) for JSON protocol lines: events/controlOut are JSON; redacting their raw
 *    text could unbalance the JSON (→ a silently skipped line on replay) or desync the AskUserQuestion
 *    question/answer strings the guard compares across events and controlOut. So JSON is parsed, every
 *    string LEAF and object KEY is redacted, then re-serialized.
 *  - COLLISION-SAFE deterministic tokens: `[REDACTED:<label>:<hash>]`. The hash (of the matched text) keeps
 *    the token stable across re-records (no churn) AND injective — two distinct names never collapse into a
 *    single `answers` map key. A genuine collision (astronomically rare) fails loud, never silently merges.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const RedactConfigSchema = z.object({
  patterns: z
    .array(
      z.object({
        regex: z.string(),
        label: z.string().optional(),
        flags: z.string().optional(),
      }),
    )
    .optional(),
  keys: z.array(z.string()).optional(),
});

export interface RedactionPolicy {
  patterns: { re: RegExp; label: string }[]; // value/key substrings to redact, by class
  keyNames: string[]; // JSON keys whose (string) value is redacted wholesale, regardless of pattern
}

export const EMPTY_POLICY: RedactionPolicy = { patterns: [], keyNames: [] };

function csv(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Assemble a redaction policy from `.cowork-redact.json` (searched in `searchDirs`, e.g. cwd then the
 *  scenario/cassette dir) merged with `COWORK_HARNESS_REDACT_PATTERNS`/`_KEYS`. No config + no env →
 *  EMPTY_POLICY (the opt-in default; the scanner is the always-on safety net). A malformed regex throws —
 *  a silently-dropped redaction rule is under-redaction, i.e. a leak. */
export function loadRedactionPolicy(searchDirs: string[]): RedactionPolicy {
  const patterns: { re: RegExp; label: string }[] = [];
  const keyNames: string[] = [];
  const seen = new Set<string>();
  for (const dir of searchDirs) {
    const f = join(dir, ".cowork-redact.json");
    if (seen.has(f) || !existsSync(f)) continue;
    seen.add(f);
    let cfg: z.infer<typeof RedactConfigSchema>;
    try {
      cfg = RedactConfigSchema.parse(JSON.parse(readFileSync(f, "utf8")));
    } catch (e) {
      throw new Error(`cowork-harness: invalid .cowork-redact.json: ${e instanceof z.ZodError ? e.message : String(e)}`);
    }
    for (const p of cfg.patterns ?? []) patterns.push({ re: new RegExp(p.regex, p.flags ?? "g"), label: p.label ?? "redacted" });
    for (const k of cfg.keys ?? []) keyNames.push(k);
  }
  for (const src of csv(process.env.COWORK_HARNESS_REDACT_PATTERNS)) patterns.push({ re: new RegExp(src, "g"), label: "redacted" });
  for (const k of csv(process.env.COWORK_HARNESS_REDACT_KEYS)) keyNames.push(k);
  return { patterns, keyNames };
}

/** Stable, collision-safe token for a matched span. Depends ONLY on the matched text (context-free), so the
 *  same logical string redacts identically wherever it appears (events question text == controlOut answers
 *  key) — the property the guard relies on. */
function token(label: string, match: string): string {
  const h = createHash("sha256").update(match).digest("hex").slice(0, 12);
  return `[REDACTED:${label}:${h}]`;
}

/** Apply every pattern to a single string. Each pattern is forced global so all occurrences go. */
export function redactText(text: string, policy: RedactionPolicy): string {
  let out = text;
  for (const { re, label } of policy.patterns) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    out = out.replace(g, (m) => token(label, m));
  }
  return out;
}

/** Recursively redact a parsed JSON value: string leaves AND object keys. Numbers/booleans/null pass
 *  through. A key collision after redaction (two distinct keys → one) throws — a silent merge would lose data
 *  and (for an `answers` map) break replay. */
export function redactStructural(value: unknown, policy: RedactionPolicy): unknown {
  if (typeof value === "string") return redactText(value, policy);
  if (Array.isArray(value)) return value.map((v) => redactStructural(v, policy));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const rk = redactText(k, policy);
      // A value under a configured key is redacted wholesale regardless of TYPE (a sensitive number/object
      // leaks just like a string). The hash is over its JSON form so the token stays deterministic.
      const rv = policy.keyNames.includes(k) ? token("key", typeof v === "string" ? v : JSON.stringify(v)) : redactStructural(v, policy);
      if (Object.prototype.hasOwnProperty.call(out, rk))
        throw new Error(`redaction collision: two distinct keys both redacted to "${rk}" — refusing to silently merge`);
      out[rk] = rv;
    }
    return out;
  }
  return value;
}

/** Redact one JSONL protocol line. If it parses as JSON, redact structurally (guaranteeing it still parses);
 *  otherwise fall back to safe text redaction (a non-JSON line has no protocol coupling). */
export function redactJsonLine(line: string, policy: RedactionPolicy): string {
  if (!line.trim()) return line;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return redactText(line, policy);
  }
  return JSON.stringify(redactStructural(parsed, policy));
}
