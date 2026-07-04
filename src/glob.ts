// Minimal glob matching for `no_unexpected_files` allowlists. No dependency (deps are yaml+zod
// only) and deliberately small:
//   - `**` as a WHOLE path segment matches any number of segments, including zero
//     (`outputs/**` matches `outputs/a.md` and `outputs/a/b.md`; a leading `**/` also matches
//     zero directories, so `**/x.md` matches `x.md`).
//   - `*` matches any run of non-`/` characters within a segment.
//   - `?` matches exactly one non-`/` character.
//   - everything else is literal (regex metacharacters are escaped); matching is case-sensitive
//     over the FULL `/`-normalized workRoot-relative path — no substring/prefix semantics.
//   - a `**` embedded inside a segment (`a**b`) is NOT special: each `*` degrades to `[^/]*`
//     (documented; standard globs treat it the same way).
// (Line comments, not a block comment — the `**/` examples above would terminate a `/*` block.)
export function globToRegExp(glob: string): RegExp {
  const segs = glob.replace(/\\/g, "/").split("/");
  let re = "^";
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const last = i === segs.length - 1;
    if (seg === "**") {
      // Whole-segment `**`: zero or more segments. The trailing form must also allow "nothing
      // more" without requiring a separator; the interior form consumes its own trailing `/`.
      re += last ? "(?:[^/]+(?:/[^/]+)*)?" : "(?:[^/]+/)*";
      continue;
    }
    for (const ch of seg) {
      if (ch === "*") re += "[^/]*";
      else if (ch === "?") re += "[^/]";
      else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    if (!last) re += "/";
  }
  return new RegExp(re + "$");
}

/** true iff `path` (workRoot-relative; `\` tolerated and normalized) matches ≥1 of `globs`.
 *  An empty `globs` list matches nothing — the "[] = no new files allowed" semantic. */
export function anyGlobMatches(globs: string[], path: string): boolean {
  const p = path.replace(/\\/g, "/");
  return globs.some((g) => globToRegExp(g).test(p));
}
