/**
 * Web-search anchors in the staged agent binary, for the frozen search corpus.
 *
 * The agent's WebSearch tool makes a NESTED model request that carries the `web_search_*` server tool, a fixed
 * system sentence, and one user message made of a fixed prefix plus the query. A later release's search interceptor
 * will recognise that request by those three facts, so `sync` records them per agent version. Anchors that moved,
 * vanished or disagree refuse the write (`searchAnchorsForSync`'s `refuse`), overridden only by
 * `--allow-missing-search-anchors`: a silent fallback to pass-through would let a live search into a run labelled
 * frozen.
 *
 * The two prose literals are agent text, so only their sha256 and UTF-8 byte length are recorded, never the text.
 * The tool type and the CCR route pieces are identifiers and are recorded as they are.
 *
 * Each literal is located by code SHAPE inside the one call site that carries the `querySource` marker, never by a
 * whole-binary search: the binary holds a second copy of most literals in its string table, so a whole-binary
 * "exactly once" rule would fail on every build.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
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

/** The no-request templates sit in the same tool definition, before the call-site marker (~1.6 KB for the budget
 *  template and ~3.2 KB for `validateInput` in 2.1.295). */
const NO_REQUEST_WINDOW_BEFORE = 6000;
const MISSING_QUERY = new RegExp(`if\\(!${IDENT}\\.length\\)return\\{result:!1,message:${LIT},errorCode:1\\}`, "g");
const BOTH_DOMAIN_LISTS = new RegExp(`return\\{result:!1,message:${LIT},errorCode:2\\}`, "g");
/** A fixed segment of a template literal: no backtick, escape, newline or substitution. */
const SEGMENT = "((?:(?!\\$\\{)[^`\\\\\\n])*)";
/** The budget-cap result: fixed P1, the turn|session variable, fixed P2, then the next substitution. */
const BUDGET = new RegExp(`results:\\[\`${SEGMENT}\\$\\{(${IDENT})\\}${SEGMENT}\\$\\{`, "g");
/** The tool runner's schema-failure result: located from its one ZOD_VALIDATION telemetry marker (runner code shared by
 *  every tool, far from the WebSearch tool), then the one wrapped result built just after it. */
const ZOD_MARKER = new RegExp(`errorCode:${IDENT}\\("ZOD_VALIDATION"\\)`, "g");
const ZOD_WINDOW_AFTER = 1500;
const INPUT_VALIDATION_RESULT = new RegExp(`content:\`<tool_use_error>${SEGMENT}\\$\\{${IDENT}\\}</tool_use_error>\``, "g");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const CCR = {
  workerPath: { needle: "/worker/${", value: "/worker/" },
  searchRoute: { needles: ['"web-search"', "`web-search`"], value: "web-search" },
} as const;
/** The sessions base the worker route is appended to. Many routes share it (45 copies in 2.1.295 and 2.1.299), so it
 *  is located only in the window just before the one worker POST (174 bytes before it in both). */
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

/** The budget-cap template's two fixed segments: exactly one match, both printable ASCII, and the variable between
 *  them assigned the turn|session choice in the same window. */
function budgetTemplate(window: string, defects: string[]): { p1: string; p2: string } | undefined {
  const hits = [...window.matchAll(BUDGET)];
  if (hits.length !== 1) {
    defects.push(`noRequest.budget: ${hits.length} matches in the nested-search tool (expected exactly 1)`);
    return undefined;
  }
  const [, p1, ident, p2] = hits[0]!;
  const scope = new RegExp(`[,;{(\\s]${escapeRe(ident!)}=${IDENT}\\(\\)\\?"turn":"session"`, "g");
  if ([...window.matchAll(scope)].length !== 1) {
    // Agents 2.1.260-2.1.289 put a call count here (a session-only template); a user syncing against one meets this.
    defects.push(
      "noRequest.budget: this agent's budget message predates the supported template (the variable after its prefix is not the turn|session choice); update Claude Desktop, or pass --allow-missing-search-anchors",
    );
    return undefined;
  }
  if (!/^[\x20-\x7e]+$/.test(p1!) || !/^[\x20-\x7e]+$/.test(p2!)) {
    defects.push("noRequest.budget: a fixed segment is empty or not printable ASCII");
    return undefined;
  }
  return { p1: p1!, p2: p2! };
}

function inputValidationPrefix(buf: Buffer, defects: string[]): string | undefined {
  const name = "noRequest.inputValidationPrefix";
  const text = buf.toString("latin1");
  const marks = [...text.matchAll(ZOD_MARKER)];
  if (marks.length !== 1) {
    defects.push(`${name}: ${marks.length} schema-failure markers in the agent binary (expected exactly 1)`);
    return undefined;
  }
  const window = text.slice(marks[0]!.index!, marks[0]!.index! + ZOD_WINDOW_AFTER);
  const hits = [...window.matchAll(INPUT_VALIDATION_RESULT)].map((m) => m[1]!);
  if (hits.length !== 1) {
    defects.push(`${name}: ${hits.length} wrapped results after the schema-failure marker (expected exactly 1)`);
    return undefined;
  }
  if (!/^[\x20-\x7e]+$/.test(hits[0]!)) {
    defects.push(`${name}: the prefix is empty or not printable ASCII`);
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

  const nrWindow = buf.subarray(Math.max(0, at - NO_REQUEST_WINDOW_BEFORE), at).toString("latin1");
  const missingQuery = oneLiteral(nrWindow, MISSING_QUERY, "noRequest.missingQuery", defects);
  const bothDomainLists = oneLiteral(nrWindow, BOTH_DOMAIN_LISTS, "noRequest.bothDomainLists", defects);
  const budget = budgetTemplate(nrWindow, defects);
  const ivPrefix = inputValidationPrefix(buf, defects);

  if (
    defects.length ||
    prefix === undefined ||
    sentence === undefined ||
    missingQuery === undefined ||
    bothDomainLists === undefined ||
    budget === undefined ||
    ivPrefix === undefined
  )
    return { ok: false, defects };
  return {
    ok: true,
    anchors: {
      toolType: types[0]!,
      systemSentence: hashed(sentence),
      userPrefix: hashed(prefix),
      ccr: { sessionsPath: CCR_SESSIONS.value, workerPath: CCR.workerPath.value, searchRoute: CCR.searchRoute.value },
      noRequest: {
        missingQuery: hashed(missingQuery),
        bothDomainLists: hashed(bothDomainLists),
        budgetPrefix: hashed(budget.p1),
        budgetFragment: hashed(budget.p2),
        inputValidationPrefix: hashed(ivPrefix),
      },
    },
  };
}

type Staged = Buffer | { unreadable: string } | null;

/** A staged agent binary for `searchAnchorsForSync`: its bytes, `{unreadable}` when it exists but cannot be read
 *  (an EACCES binary is a finding, never an uncaught throw), or null when it is not staged. */
export function stagedForAnchors(path: string): Staged {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path);
  } catch (e) {
    return { unreadable: (e as NodeJS.ErrnoException).code ?? "error" };
  }
}
type Extracted =
  { state: "ok"; anchors: SearchAnchors } | { state: "fail"; why: string } | { state: "unreadable"; why: string } | { state: "absent" };

function extracted(bin: Staged): Extracted {
  if (bin === null) return { state: "absent" };
  if (!Buffer.isBuffer(bin)) return { state: "unreadable", why: `could not be read (${bin.unreadable})` };
  const r = extractSearchAnchors(bin);
  return r.ok
    ? { state: "ok", anchors: r.anchors }
    : { state: "fail", why: `its anchors could not be extracted (${r.defects.join("; ")})` };
}

/** `sync`'s decision for `agentBinary.searchAnchors`. Pure: the caller reads the binaries. Hostloop runs the
 *  NATIVE agent, so the native decides wherever one is staged, and an unreadable one refuses; the VM ELF corroborates
 *  it on the same version and stands in for it only when no native is staged. `refuse` is sync's own refusal (exit 1,
 *  overridden only by `--allow-missing-search-anchors`), so a baseline never loses its anchors silently and never
 *  carries anchors a staged binary could contradict. Notes never carry a literal's text.
 *  - `elfVersion` is the VM agent's `.sdk-version` (the baseline's `agentVersion`); `nativeVersion` is the native
 *    agent's staged version, or null when none is staged; they stage on separate cadences. An unreadable ELF counts
 *    as an ELF whose anchors could not be extracted. */
export function searchAnchorsForSync(a: {
  elf: Staged;
  native: Staged;
  elfVersion: string;
  nativeVersion: string | null;
  baseAgentVersion: string | undefined;
  base: SearchAnchors | undefined;
}): { anchors: SearchAnchors | undefined; notes: string[]; refuse: string | null } {
  const elf = extracted(a.elf);
  const native = extracted(a.native);
  const sameVersion = a.nativeVersion !== null && a.nativeVersion === a.elfVersion;
  const record = (anchors: SearchAnchors, source: "elf" | "native" | "both", notes: string[] = []) => ({
    anchors: { ...anchors, source },
    notes,
    refuse: null,
  });
  const refuse = (why: string) => ({ anchors: undefined, notes: [], refuse: `agentBinary.searchAnchors: ${why}` });
  const vm = `the VM agent ${a.elfVersion}`;
  const nat = `the native agent${a.nativeVersion ? ` ${a.nativeVersion}` : ""}`;

  if (native.state === "ok") {
    if (elf.state === "ok") {
      const equal = JSON.stringify(elf.anchors) === JSON.stringify(native.anchors);
      if (sameVersion)
        return equal
          ? record(native.anchors, "both")
          : refuse(`${nat}'s anchors differ from ${vm}'s, at the same version: an extractor finding`);
      return record(native.anchors, "native", [
        equal
          ? `searchAnchors from ${nat} (which hostloop runs); ${vm} agreed`
          : `searchAnchors from ${nat} (which hostloop runs); ${vm}'s anchors differ (the two stage on separate cadences)`,
      ]);
    }
    if (elf.state === "absent")
      return record(native.anchors, "native", [`searchAnchors from ${nat}; no VM agent is staged for ${a.elfVersion}`]);
    if (sameVersion)
      return refuse(`${vm} ${elf.why}, while ${nat} at the same version extracted${elf.state === "fail" ? ": an extractor finding" : ""}`);
    return record(native.anchors, "native", [`searchAnchors from ${nat} (which hostloop runs); ${vm} ${elf.why}`]);
  }
  // An unreadable native refuses whatever else is staged: hostloop can still run it, so the base's anchors cannot
  // stand in for it.
  if (native.state === "fail" || native.state === "unreadable")
    return refuse(`${nat} ${native.why}; hostloop runs it, so its anchors cannot be confirmed`);
  // No native agent is staged.
  if (elf.state === "ok")
    return record(elf.anchors, "elf", [
      `searchAnchors from ${vm}; no native agent is staged, so hostloop cannot run until one is; re-run sync once it is staged`,
    ]);
  if (elf.state !== "absent") return refuse(`${vm} ${elf.why}, and no native agent is staged`);
  if (a.baseAgentVersion !== a.elfVersion)
    return refuse(
      `no agent binary is staged for ${a.elfVersion} (the base is ${a.baseAgentVersion ?? "unknown"}); open Cowork once to stage it, then re-run sync`,
    );
  if (!a.base)
    return refuse(
      `no agent binary is staged for ${a.elfVersion} and the base has no anchors to carry; open Cowork once to stage it, then re-run sync`,
    );
  return {
    anchors: a.base,
    notes: [
      `searchAnchors carried from the base for agent version ${a.elfVersion} (the VM agent's .sdk-version); no agent binary is staged, so hostloop cannot run on this baseline until one is`,
      // A carried block cannot gain fields: re-syncing with nothing staged would carry it again, forever.
      ...(a.base.noRequest
        ? []
        : [
            "the carried anchors predate the no-request templates (noRequest): open Cowork once so the agent is staged, then re-run sync to record them",
          ]),
    ],
    refuse: null,
  };
}

/** How `sync` acts on `searchAnchorsForSync`'s `refuse`. Its own path, never an unknown delta, so `--allow-empty`
 *  does not cover it: a `--diff` prints it as "would refuse" and exits as `--diff` does (the defect is what a
 *  maintainer diagnoses); `--allow-missing-search-anchors` writes without anchors and warns; otherwise it fails. */
export function searchAnchorsRefusal(
  refuse: string | null,
  o: { diff: boolean; allow: boolean },
): { fail: string | null; log: string | null } {
  if (refuse === null) return { fail: null, log: null };
  if (o.diff) return { fail: null, log: `would refuse: ${refuse} (--allow-missing-search-anchors writes without anchors)` };
  if (o.allow)
    return {
      fail: null,
      log: `WARNING: ${refuse}; written without agentBinary.searchAnchors under --allow-missing-search-anchors, so no run against this baseline can serve a frozen search corpus`,
    };
  return {
    fail: `ERROR: ${refuse} — refusing to write baseline. Fix it, or pass --allow-missing-search-anchors to write without anchors (--allow-empty does not cover it).`,
    log: null,
  };
}
