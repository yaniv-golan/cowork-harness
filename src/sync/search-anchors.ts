/**
 * Web-search anchors in the staged agent binary, for the frozen search corpus.
 *
 * The agent's WebSearch tool makes a NESTED model request that carries the `web_search_*` server tool, a fixed
 * system sentence, and one user message made of a fixed prefix plus the query. The interceptor recognises that
 * request by those three facts, so `sync` records them per agent version, and a release whose anchors moved or
 * vanished fails the sync like a gate drift (a silent fallback to pass-through would let a live search into a run
 * labelled frozen).
 *
 * The two prose literals are agent text, so only their sha256 and UTF-8 byte length are recorded, never the text.
 * The tool type and the CCR route pieces are identifiers and are recorded as they are.
 *
 * Each literal is located by code SHAPE inside the one call site that carries the `querySource` marker, never by a
 * whole-binary search: the binary holds a second copy of most literals in its string table, so a whole-binary
 * "exactly once" rule would fail on every build.
 */

import { createHash } from "node:crypto";
import type { SearchAnchors } from "../types.js";

/** The marker that names the nested search request's query source. It occurs once in the agent's JS. */
export const SEARCH_ANCHOR_CALL_SITE = 'querySource:"web_search_tool"';

/** How far before the marker the call site's literals sit (measured ~1.4 KB in 2.1.295), and after it. */
const WINDOW_BEFORE = 4000;
const WINDOW_AFTER = 400;

const IDENT = "[A-Za-z_$][\\w$]*";
/** A single-line string literal in either quote the minifier emits, with no escape and no `${` inside: an escape
 *  would make the bytes on the wire differ from the bytes in the binary, and a template substitution would hash
 *  text that is never sent. */
const LIT = '(["`])((?:(?!\\1|\\$\\{)[^\\\\\\n])*)\\1';
const USER_PREFIX = new RegExp(`\\(\\{content:${LIT}\\+${IDENT}\\}\\)`, "g");
const SYSTEM_SENTENCE = new RegExp(`systemPrompt:${IDENT}\\(\\[${LIT}\\]\\)`, "g");
const TOOL_TYPE = /type:(["`])(web_search_[0-9A-Za-z_]+)\1/g;

const CCR = {
  workerPath: { needle: "/worker/${", value: "/worker/" },
  searchRoute: { needles: ['"web-search"', "`web-search`"], value: "web-search" },
} as const;
/** The sessions base the worker route is appended to. Many routes share it (45 copies in 2.1.295), so it is located
 *  only in the window just before the one worker POST (~140 bytes in 2.1.295). */
const CCR_SESSIONS = { needle: "/v1/code/sessions/${", value: "/v1/code/sessions/", windowBefore: 800 } as const;

export type SearchAnchorResult = { ok: true; anchors: SearchAnchors } | { ok: false; defects: string[] };

function countBytes(buf: Buffer, needle: string): number[] {
  const nb = Buffer.from(needle);
  const at: number[] = [];
  for (let i = buf.indexOf(nb); i !== -1; i = buf.indexOf(nb, i + nb.length)) at.push(i);
  return at;
}

function hashed(text: string): { sha256: string; bytes: number } {
  return { sha256: createHash("sha256").update(text, "utf8").digest("hex"), bytes: Buffer.byteLength(text, "utf8") };
}

/** One literal captured by `re` in the call-site window: exactly one match, printable ASCII only. */
function oneLiteral(window: string, re: RegExp, name: string, defects: string[]): string | undefined {
  const hits = [...window.matchAll(re)].map((m) => m[2]!);
  if (hits.length !== 1) {
    defects.push(`${name}: ${hits.length} matches in the nested-search call site (expected exactly 1)`);
    return undefined;
  }
  // The window is decoded as latin1, so any non-ASCII byte shows up here; requiring ASCII makes the recorded byte
  // length equal the literal's length in every encoding the predicate might compare in.
  if (!/^[\x20-\x7e]+$/.test(hits[0]!)) {
    defects.push(`${name}: the literal is not printable ASCII`);
    return undefined;
  }
  return hits[0];
}

/** Extract the web-search anchors from an agent binary's bytes. Pure. Never returns any literal's text. */
export function extractSearchAnchors(buf: Buffer): SearchAnchorResult {
  const defects: string[] = [];
  const marks = countBytes(buf, SEARCH_ANCHOR_CALL_SITE);
  if (marks.length !== 1) {
    return { ok: false, defects: [`${SEARCH_ANCHOR_CALL_SITE}: ${marks.length} matches in the agent binary (expected exactly 1)`] };
  }
  const at = marks[0]!;
  const window = buf.subarray(Math.max(0, at - WINDOW_BEFORE), at + WINDOW_AFTER).toString("latin1");

  const prefix = oneLiteral(window, USER_PREFIX, "userPrefix", defects);
  const sentence = oneLiteral(window, SYSTEM_SENTENCE, "systemSentence", defects);
  const types = [...window.matchAll(TOOL_TYPE)].map((m) => m[2]!);
  if (types.length !== 1) defects.push(`toolType: ${types.length} web_search_* type matches in the call site (expected exactly 1)`);

  for (const [name, spec] of Object.entries(CCR)) {
    const needles = "needles" in spec ? spec.needles : [spec.needle];
    const n = needles.reduce((sum, nd) => sum + countBytes(buf, nd).length, 0);
    if (n !== 1) defects.push(`ccr.${name}: ${n} matches in the agent binary (expected exactly 1)`);
  }
  const workers = countBytes(buf, CCR.workerPath.needle);
  if (workers.length === 1) {
    const w = workers[0]!;
    const before = buf.subarray(Math.max(0, w - CCR_SESSIONS.windowBefore), w);
    const n = countBytes(before, CCR_SESSIONS.needle).length;
    if (n !== 1) defects.push(`ccr.sessionsPath: ${n} matches just before the worker route (expected exactly 1)`);
  }

  if (defects.length || prefix === undefined || sentence === undefined) return { ok: false, defects };
  return {
    ok: true,
    anchors: {
      toolType: types[0]!,
      systemSentence: hashed(sentence),
      userPrefix: hashed(prefix),
      ccr: { sessionsPath: CCR_SESSIONS.value, workerPath: CCR.workerPath.value, searchRoute: CCR.searchRoute.value },
    },
  };
}

/** `sync`'s decision for `agentBinary.searchAnchors`. Pure: the caller reads the binaries.
 *  - `elf` present: extract; a failure is a delta, which blocks the write.
 *  - `native` present: its anchors must equal the ELF's, since hostloop runs it.
 *  - `elf` absent: carry the base's anchors only for the same agent version (the ELF is immutable per version),
 *    else record nothing (absent means unknown). */
export function searchAnchorsForSync(a: {
  elf: Buffer | null;
  native: Buffer | null;
  sameVersionAsBase: boolean;
  base: SearchAnchors | undefined;
}): { anchors: SearchAnchors | undefined; deltas: string[] } {
  if (!a.elf) return { anchors: a.sameVersionAsBase ? a.base : undefined, deltas: [] };
  const elf = extractSearchAnchors(a.elf);
  if (!elf.ok) return { anchors: undefined, deltas: elf.defects.map((d) => `agentBinary.searchAnchors: ${d}`) };
  const deltas: string[] = [];
  if (a.native) {
    const native = extractSearchAnchors(a.native);
    if (!native.ok)
      deltas.push(`agentBinary.searchAnchors: the native agent's web-search anchors could not be extracted (${native.defects.join("; ")})`);
    else if (JSON.stringify(native.anchors) !== JSON.stringify(elf.anchors))
      deltas.push("agentBinary.searchAnchors: the native agent's web-search anchors differ from the VM ELF's");
  }
  return { anchors: elf.anchors, deltas };
}
