import { tildeify } from "../io.js";

// The host-path shape `hostPathLeaked` (src/run/execute.ts) looks for, as a TOKEN extractor. Kept in its
// own dependency-free module so the staging code (runtime/*) can tokenize input files without importing
// execute.ts, which imports the runtimes.

// A host root, preceded by a boundary: start of text, whitespace, a quote, `(`, `=`, `:`, a backtick, or a
// `file://` / `computer://` prefix with its optional authority. The roots and the boundary are exactly
// `hostPathLeaked`'s — see its doc comment in execute.ts for why each is there.
const BOUNDARY = String.raw`(^|[\s"'(=:` + "`" + String.raw`]|(?:file|computer):\/\/[^\s\/]*)`;
const ROOTS = String.raw`(\/Users\/|\/opt\/cowork\/|\/home\/|\/root\/|\/private\/var\/|\/private\/tmp\/|\/var\/folders\/|\/Volumes\/)`;
// The rest of the token, up to the first delimiter: whitespace, a quote, a backtick, `)`, `]`, `<`, `>`,
// `,`, `;` or a backslash (which ends a JSON-escaped line in raw text). A trailing `.` or `:` is NOT a
// delimiter, so a sentence-final path yields a token that no input file carries — the safe direction.
const TAIL = String.raw`([^\s"'` + "`" + String.raw`)\]<>,;\\]*)`;
const HOST_PATH_TOKEN_RE = new RegExp(BOUNDARY + ROOTS + TAIL, "g");

/** Decode each `%`-escape RUN independently (a stray `%`, as in `build 100% done`, would make a whole-text
 *  decodeURIComponent throw), then turn backslashes into slashes, so `%2FUsers%2F…` and `file:\\host\Users`
 *  are seen as the paths they spell. */
function decodedForm(text: string): string {
  const decoded = text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (m) => {
    try {
      return decodeURIComponent(m);
    } catch {
      return m;
    }
  });
  return decoded.replace(/\\/g, "/");
}

/** One host-path token in a text. `continued`: the token ended at whitespace, `,` or `;`, and the text
 *  goes on with a run containing `/` (up to the next whitespace) that does not itself start a new path or
 *  URL — `/Users/a/My Documents/x`,
 *  `/Users/a/proj,old/secret`. The token is then probably a TRUNCATED spelling of a longer path, and the
 *  input-provenance exemption refuses it: an unrelated input can easily carry the same truncated prefix. */
export interface HostPathTokenOccurrence {
  token: string;
  continued: boolean;
}

function continuesAsPath(text: string, end: number): boolean {
  const c = text[end];
  let i: number;
  if (c === "," || c === ";") i = end + 1;
  else if (c !== undefined && /\s/.test(c)) {
    i = end;
    while (i < text.length && /\s/.test(text[i])) i++;
  } else return false;
  let j = i;
  while (j < text.length && !/\s/.test(text[j])) j++;
  const run = text.slice(i, j);
  // After whitespace, a run that STARTS a new path or a URL is the next item of a list or command line
  // (`cp /a /b`, one path per line), not the rest of this one.
  if (/\s/.test(c) && (run.startsWith("/") || /^\w+:\/\//.test(run))) return false;
  return run.includes("/");
}

function occurrencesIn(text: string, into: HostPathTokenOccurrence[]): void {
  for (const m of text.matchAll(HOST_PATH_TOKEN_RE)) {
    const token = m[2] + m[3];
    into.push({ token, continued: continuesAsPath(text, m.index + m[0].length) });
  }
}

/** Every host-path token occurrence in `text`: each root match extended to the full path, from the raw text
 *  and — when decoding changes it — from its decoded, backslash-normalized form too. */
export function hostPathTokenOccurrences(text: string): HostPathTokenOccurrence[] {
  const out: HostPathTokenOccurrence[] = [];
  occurrencesIn(text, out);
  const normalized = decodedForm(text);
  if (normalized !== text) occurrencesIn(normalized, out);
  return out;
}

/**
 * Every host-path token in `text` (see {@link hostPathTokenOccurrences}). Non-empty exactly when
 * `hostPathLeaked(text)` is true. Tokens are compared verbatim; a symlinked and a realpath spelling of one
 * location are different tokens (so neither exempts the other — the safe side).
 */
export function hostPathTokens(text: string): string[] {
  return hostPathTokenOccurrences(text).map((o) => o.token);
}

/** Replace each host-path token with its `~` form when it is under $HOME, else `<host-path>`. Deterministic
 *  for a given text and $HOME, so a re-render is byte-identical. */
export function redactHostPaths(text: string): { text: string; redacted: number } {
  const tokens = [...new Set(hostPathTokenOccurrences(text).map((o) => o.token))].sort((a, b) => b.length - a.length);
  let out = text;
  let redacted = 0;
  for (const t of tokens) {
    const home = tildeify(t);
    const replacement = home !== t ? home : "<host-path>";
    const parts = out.split(t);
    if (parts.length > 1) {
      redacted += parts.length - 1;
      out = parts.join(replacement);
    }
  }
  return { text: out, redacted };
}
