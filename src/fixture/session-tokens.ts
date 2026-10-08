// Session-path tokens: how a `workspace_fixture` carries a path into the session it was recorded in.
//
// A skill can record where its files are and read that back as path data — an outputs-dir probe, a sub-agent's
// OUTPUT_PATH, a deliverable path a later step compares as a string. Those paths name ONE session, so a fixture
// copied verbatim would hand the next run paths into a session that is gone. `fixture export --session-paths`
// rewrites this run's session root to a token; staging writes the new session's root in its place.
//
// Two tokens, because on hostloop the agent sees its session two ways: its file tools run on the host (under
// the run dir) and its bash runs in the VM (under `/sessions/<id>`). Elsewhere both views are the guest path.
//
// Leaf module: export.ts and workspace.ts both import it, so the two ends share one text test and one token set.

import { UsageError } from "../errors.js";

/** The session root as the agent's FILE TOOLS see it. */
export const SESSION_ROOT_TOKEN = "__COWORK_HARNESS_SESSION_ROOT__";
/** The session root as the agent's BASH sees it (`/sessions/<id>`). */
export const VM_SESSION_ROOT_TOKEN = "__COWORK_HARNESS_VM_SESSION_ROOT__";
export const SESSION_TOKENS = [SESSION_ROOT_TOKEN, VM_SESSION_ROOT_TOKEN] as const;
/** The substitution scheme, stamped into a tokenised file's fixture signature (`<sha>+t1`). Change it whenever
 *  the tokens or the per-tier values change: a cassette recorded under the old scheme then reads as stale. */
export const SESSION_TOKEN_SCHEME = "t1";

/** The values staging writes in place of the tokens. */
export interface SessionRoots {
  sessionRoot: string;
  vmSessionRoot: string;
}

/** Text when it holds no NUL in its first 8 KiB. Decoded as UTF-8 when that is lossless, else as Latin-1 (a
 *  legacy-encoded CSV is still text, and every path root is ASCII). */
export function asText(buf: Buffer): string | null {
  if (buf.subarray(0, 8192).includes(0)) return null;
  const utf8 = buf.toString("utf8");
  return Buffer.from(utf8, "utf8").equals(buf) ? utf8 : buf.toString("latin1");
}

/** Is `buf` valid UTF-8 (lossless round trip)? */
function isUtf8(buf: Buffer): boolean {
  return Buffer.from(buf.toString("utf8"), "utf8").equals(buf);
}

/** Does `buf` hold either token anywhere (text or binary)? */
export function containsSessionToken(buf: Buffer): boolean {
  return SESSION_TOKENS.some((t) => buf.includes(t));
}

const NAME_CHAR = /[A-Za-z0-9._~-]/;

/**
 * Replace each bounded occurrence of each `from` with its token, at BYTE level: the buffer is read as Latin-1
 * (one char per byte), so a file that is not UTF-8 is never re-encoded. A `from` is matched as its UTF-8 bytes.
 * Bounded as `namesRunPath` bounds a run path: the byte before does not continue a name or a URL path, the one
 * after does not continue a name (`/` or a quote does; a `.` that ends a sentence does too). Longest `from` first, so a root that contains another
 * is replaced whole.
 */
export function tokenizeSessionPaths(buf: Buffer, roots: ReadonlyArray<{ from: string; token: string }>): { data: Buffer; count: number } {
  let s = buf.toString("latin1");
  let count = 0;
  for (const { from, token } of [...roots].filter((r) => r.from !== "").sort((a, b) => b.from.length - a.from.length)) {
    const needle = Buffer.from(from, "utf8").toString("latin1");
    let out = "";
    let at = 0;
    for (let i = s.indexOf(needle); i !== -1; i = s.indexOf(needle, i + 1)) {
      if (i < at) continue;
      const before = s[i - 1];
      const after = s[i + needle.length];
      if (before !== undefined && NAME_CHAR.test(before)) continue;
      // A `.` ends the path when the sentence ends there (`… is /sessions/x. Done`); elsewhere it continues a name.
      const sentenceEnd = after === "." && (s[i + needle.length + 1] === undefined || /\s/.test(s[i + needle.length + 1]!));
      if (after !== undefined && !sentenceEnd && (NAME_CHAR.test(after) || after === "@")) continue;
      out += s.slice(at, i) + token;
      at = i + needle.length;
      count++;
    }
    s = out + s.slice(at);
  }
  return { data: Buffer.from(s, "latin1"), count };
}

/** Why a root value cannot be written into a fixture file, or undefined. Staging inserts it unescaped into
 *  whatever the file is (JSON, shell, CSV), so a quote, a backslash, whitespace or a control character in it
 *  would break the file's syntax rather than name a path. */
export function sessionRootValueProblem(v: string): string | undefined {
  if (!v.startsWith("/")) return `${JSON.stringify(v)} is not an absolute path`;
  if (/["\\\s\p{Cc}]/u.test(v)) return `${JSON.stringify(v)} holds a quote, a backslash, whitespace or a control character`;
  return undefined;
}

/** Why `roots` cannot be written into a fixture, or undefined. */
export function sessionRootsProblem(roots: SessionRoots): string | undefined {
  for (const v of [roots.sessionRoot, roots.vmSessionRoot]) {
    const problem = sessionRootValueProblem(v);
    if (problem) return `cannot write this run's session root into the workspace_fixture: ${problem}`;
  }
  return undefined;
}

/** Write `roots` in place of the tokens. Throws when a value cannot be inserted safely (see
 *  {@link sessionRootValueProblem}), or when the file is not UTF-8 and a value is not ASCII (its UTF-8 bytes
 *  would be mojibake in the file's own encoding). */
export function substituteSessionTokens(buf: Buffer, roots: SessionRoots): Buffer {
  const problem = sessionRootsProblem(roots);
  if (problem) throw new UsageError(problem);
  if (!isUtf8(buf) && !/^[\x00-\x7f]*$/.test(roots.sessionRoot + roots.vmSessionRoot))
    throw new UsageError("cannot write a non-ASCII session root into a workspace_fixture file that is not UTF-8");
  let s = buf.toString("latin1");
  s = s.split(SESSION_ROOT_TOKEN).join(Buffer.from(roots.sessionRoot, "utf8").toString("latin1"));
  s = s.split(VM_SESSION_ROOT_TOKEN).join(Buffer.from(roots.vmSessionRoot, "utf8").toString("latin1"));
  return Buffer.from(s, "latin1");
}
