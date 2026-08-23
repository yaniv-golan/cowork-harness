// Guards version lockstep across the npm package and the companion skill, so a
// hand-edited release can't drift. Fails loud (exit 1) on any mismatch.
//
//   npm run check:versions
//
// Invariants (the skill versions INDEPENDENTLY from the npm package — see
// docs/maintenance.md — so we do NOT require the skill version to equal the
// package version):
//   1. npm self-consistency:   package.json === package-lock.json (root + "" package).
//   2. skill self-consistency: marketplace.json === skill plugin.json === SKILL.md `version:`.
//   3. floor === tracks:       SKILL.md bootstrap floor `@>=X.Y.Z` === `tracks-harness:` version.
//   4. floor <= package:       the harness version the skill demands must be one this repo
//                              can publish (else the skill ships ahead of npm).
//   5. README floor === floor: every `cowork-harness@>=X.Y.Z` in README.md matches the SKILL.md floor
//                              (README is not version-controlled by the package; it drifts silently otherwise).
//   5b. SKILL floors === floor: every `@>=X.Y.Z` in SKILL.md (incl. a BARE `Pin `@>=X`` with no
//                              `cowork-harness` prefix) matches the floor — invariant 3 reads only the
//                              first prefixed match, so a bare floor drifted silently (stale 0.33.0→1.0.0).
//   6. ref stamps === tracks:  each `references/*.md` "Tracks `cowork-harness X.Y.Z`" matches tracks-harness,
//                              and any `(baseline desktop-X.Y.Z)` pin next to that stamp matches SKILL.md's
//                              tracks-harness baseline (the refs lagged two Desktop syncs before this check).
//   7. baseline pins agree:    SKILL.md's `(baseline desktop-X.Y.Z)` and README.md's "latest shipped
//                              baseline" sentence agree with each other AND are not behind the max
//                              version present in baselines/desktop-*.json. (DESIGN.md's DATED
//                              verification-pass notes are deliberately NOT checked here — they are
//                              point-in-time stamps, allowed to lag until a real re-verification pass;
//                              its one present-tense "currently" sentence IS checked, by invariant 9.
//                              docs/cowork-spawn-contract-*.md is likewise NOT a pin: it is frozen
//                              historical research, not updated per release — see its own
//                              applicability note.)
//   8. copy-paste CI `V=X.Y.Z` pins match the max baseline's agentVersion: the literal agent-binary
//      version hardcoded in README.md / ci-recipe.md / docs/maintenance.md's "stage the agent binary"
//      bash snippets (meant to be copy-pasted into a CONSUMER repo's own CI, which has no baselines/
//      dir of its own — so these stay literals, not a dynamic `jq` read) must equal the newest
//      baselines/desktop-*.json's `agentVersion`.
//   9. DESIGN.md's current-state sentence ("currently **<agent>**, per `baselines/desktop-<ver>.json`")
//      matches the max baseline + its agentVersion. Unlike DESIGN.md's dated verification notes
//      (exempt, see 7), this sentence claims the PRESENT, so it must not lag.
//   10. SKILL.md's prose "Version note" blockquote (the human-facing sentence right below the
//       intro — "the facts ... track `cowork-harness X.Y.Z` (baseline `desktop-X.Y.Z`)") must agree
//       with the floor and skillBaseline invariants above already enforce. This prose was previously
//       an UNGUARDED version surface: nothing stopped it drifting independently of the machine-checked
//       tracks-harness/floor metadata line right above it.
//   11. DESIGN.md's "Scope of that claim" note — the disclosure of how much of the CURRENT baseline is
//       actually live-verified — agrees with baselines/desktop-*.json. Two forms, selected by whether the
//       note's live-pass baseline IS the newest: NO-GAP (must say so explicitly and carry no stale
//       enumeration) and GAP (must enumerate — list contiguous through the newest baseline, both counts
//       matching the list and the real agentVersion transitions). Either way the named agent must be the
//       max baseline's. Like 9 this claims the PRESENT, so the dated-note exemption does not cover it;
//       and because shipping a baseline flips NO-GAP into GAP, a new release forces the note to be
//       rewritten instead of silently overstating coverage. It had drifted twice unnoticed before this
//       existed — see `checkDesignScopeNote`.
//   12. cassette-format claims === the constants: SPEC.md's max/min/retained-range sentences and
//       task-recipes.md's schema pointer + "current max: N" track `CASSETTE_VERSION`,
//       `MIN_SUPPORTED_CASSETTE_VERSION` and the schema/cassette.v*.json files on disk. CURRENT
//       claims only — docs/scenario.md and docs/cassette.md explain the v10/v11 `lane: remote`
//       regime as correct history, and CHANGELOG.md is nothing but history; neither is checked.
//       See `checkCassetteVersionClaims`.
//   13. floors are BOUNDED: no shipped doc may advertise `cowork-harness@>=X.Y.Z`. `>=` crosses
//       majors (measured: `@>=1.0.0` resolves 2.0.0), so an unbounded floor hands a consumer the
//       next BREAKING release — which is how the skill's own floor pointed at a deprecated 2.0.0.
//       The canonical form is `@^X.Y.Z`. Placeholder `X.Y.Z` prose is fine (it is not a version);
//       CHANGELOG.md is exempt, being history. Also checks that every doc carrying a live floor
//       agrees with SKILL.md's — invariants 3/5/5b covered only SKILL.md and README.md, leaving
//       ci-recipe.md and examples/replays/README.md to drift unseen. Covers the Action's own
//       `version:` input too: `version: ">=1.11.0"` is the same unbounded floor with no `@` in it,
//       so the `@>=` pattern could not see it.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const r = (p: string) => readFileSync(join(REPO_ROOT, p), "utf8");
const json = (p: string) => JSON.parse(r(p)) as Record<string, any>;

const TASK_RECIPES = ".claude/skills/cowork-harness/references/task-recipes.md";

/** Markdown that ships to a reader — root pages, `docs/`, and the companion skill. `CHANGELOG.md` is
 *  excluded because it is history by construction.
 *
 *  Enumerated from git rather than by walking the filesystem, which gets the untracked working-notes
 *  directory excluded as a consequence of it being untracked instead of by a hardcoded path — and the
 *  same for any other scratch file a developer happens to have sitting under `docs/`. */
function shippedDocs(): { path: string; text: string }[] {
  const tracked = execFileSync("git", ["-C", REPO_ROOT, "ls-files", "-z", "*.md"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
    // An ALLOW-list of prefixes, not a deny-list: `baselines/prompts/**` is captured prompt text rather
    // than documentation, `test/**` holds fixtures that may name a bogus schema on purpose, and
    // `.github/**` ships to nobody. A new directory should have to opt in.
    .filter(
      (p) =>
        p !== "CHANGELOG.md" && (!p.includes("/") || ["docs/", ".claude/skills/", "examples/", "python/"].some((d) => p.startsWith(d))),
    );
  if (tracked.length === 0) throw new Error("shippedDocs(): git ls-files returned no markdown — the corpus would be empty");
  return tracked.map((path) => ({ path, text: r(path) }));
}

const SEMVER = /^\d+\.\d+\.\d+$/;
/** Compare two X.Y.Z strings: <0 if a<b, 0 if equal, >0 if a>b. */
function cmp(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/** Invariant 11 — DESIGN.md's "Scope of that claim" note, verified against the baselines.
 *
 *  That note is the repo's honest disclosure of how much of the CURRENT baseline is actually
 *  live-verified, and every figure in it is machine-derivable from baselines/desktop-*.json. It sits
 *  outside invariant 9 (which pins only the present-tense current-state sentence) and outside
 *  invariant 7's dated-note exemption, because unlike a dated note it makes a claim about the PRESENT
 *  — "N baselines have shipped since [the last live pass]" — which goes stale on its own every release.
 *
 *  It has silently drifted twice: the list was extended without recounting, leaving "four of which
 *  moved the agent ELF" when six of the nine listed had. UNDERSTATING how much is unverified is the one
 *  doc error worth failing a release over, so it is checked rather than trusted.
 *
 *  TWO FORMS, selected by whether the note's live-pass baseline IS the newest committed one:
 *    NO-GAP — nothing to enumerate, so the note must SAY so and must not carry a stale list.
 *    GAP    — the pass lags, so the note must enumerate what is unverified.
 *  The fork is what keeps a no-gap claim honest: a no-gap note is true only until the next baseline
 *  ships, and at that moment `passBaseline !== max` flips this into the GAP branch, which demands an
 *  enumeration the note does not have. Shipping a baseline therefore FORCES a rewrite rather than
 *  letting a once-true sentence quietly overstate coverage.
 *
 *  In the GAP form the list's START is deliberately NOT derived: the note omits baselines covered by the
 *  live pass itself, and encoding that rule here would just relocate the drift. Instead the list must be
 *  CONTIGUOUS from wherever it starts through the newest baseline — which is what actually catches a
 *  newly-shipped baseline being left out.
 *
 *  Pure (no disk access) so every branch can be mutation-tested; `checkVersions` supplies the real
 *  inputs. Any unparseable/missing note is an ERROR, never a skip — a guard that silently no-ops when
 *  the prose is reworded is the failure mode this whole invariant exists to prevent. */
export function checkDesignScopeNote(opts: {
  design: string;
  baselineVersions: string[];
  agentOf: (v: string) => string | undefined;
  maxBaseline?: string;
  maxAgentVersion?: string;
}): string[] {
  const { design, baselineVersions, agentOf, maxBaseline, maxAgentVersion } = opts;
  const errors: string[] = [];
  const ANCHOR = "**Scope of that claim, stated plainly.**";
  const scopeAt = design.indexOf(ANCHOR);
  if (scopeAt < 0) {
    errors.push(`DESIGN.md has no "${ANCHOR}" note to verify (invariant 11)`);
    return errors;
  }
  const nl = design.indexOf("\n", scopeAt);
  const para = design.slice(scopeAt, nl < 0 ? undefined : nl);

  // Which baseline the live pass was actually run against — `<date> / desktop-X.Y.Z`. Everything else
  // keys off this, so an unreadable one is fatal rather than a partial check.
  const passM = para.match(/`[^`]*\/\s*desktop-(\d+\.\d+\.\d+)`/);
  if (!passM) {
    errors.push('DESIGN.md scope note has no "`<date> / desktop-X.Y.Z`" live-pass baseline to key off');
    return errors;
  }
  const passBaseline = passM[1];
  if (!baselineVersions.includes(passBaseline)) {
    errors.push(`DESIGN.md scope note names live-pass baseline ${passBaseline}, which has no baselines/desktop-*.json`);
    return errors;
  }
  const agentM = para.match(/against agent \*\*(\d+\.\d+\.\d+)\*\*/) ?? para.match(/most recently to \*\*(\d+\.\d+\.\d+)\*\*/);
  if (maxAgentVersion && agentM && agentM[1] !== maxAgentVersion)
    errors.push(`DESIGN.md scope note's agent "${agentM[1]}" != max baseline's agentVersion "${maxAgentVersion}"`);
  else if (!agentM) errors.push("DESIGN.md scope note names no agent version");

  // NO-GAP form. When the live pass IS the newest baseline there is nothing to enumerate, so the note
  // must say so explicitly rather than carry a stale list. The moment a new baseline ships, passBaseline
  // stops being max and this falls through to the gap form below — which then DEMANDS the list. That is
  // the behaviour that makes shipping a baseline force this note to be updated.
  if (maxBaseline && passBaseline === maxBaseline) {
    if (!/no baselines have shipped since/i.test(para))
      errors.push(
        `DESIGN.md scope note's live pass (${passBaseline}) is the newest baseline, so it must state "no baselines have shipped since"`,
      );
    if (/baselines have shipped since \(/.test(para))
      errors.push(
        `DESIGN.md scope note still carries a "shipped since (<list>)" enumeration although the live pass is the newest baseline`,
      );
    return errors;
  }

  // GAP form — the live pass lags the newest baseline, so the note must enumerate what is unverified.
  // `baselines?` / `has|have`: the gap can be a single baseline (first hit at desktop-1.32885.1), and
  // forcing "one baselines have shipped" would trade grammar for nothing — the count is still checked
  // against the enumerated list below, so the singular form is not a loophole.
  const m = para.match(
    /\*{0,2}([A-Za-z-]+|\d+)\*{0,2} baselines? (?:has|have) shipped since \(([^)]*)\),\s*\*{0,2}([A-Za-z-]+|\d+)\*{0,2} of which moved the agent ELF[^*]*\*\*(\d+\.\d+\.\d+)\*\*/,
  );
  if (!m) {
    errors.push(
      `DESIGN.md scope note's live pass (${passBaseline}) lags the newest baseline (${maxBaseline}), so it must read "<N> baselines have shipped since (<list>), <M> of which moved the agent ELF … **<agent>**" — reword it back, or update invariant 11 deliberately`,
    );
    return errors;
  }
  const WORDS: Record<string, number> = {
    zero: 0,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
    twenty: 20,
    "twenty-one": 21,
    "twenty-two": 22,
    "twenty-three": 23,
    "twenty-four": 24,
    "twenty-five": 25,
  };
  const num = (s: string): number | undefined => (/^\d+$/.test(s) ? Number(s) : WORDS[s.toLowerCase()]);
  const listed = [...m[2].matchAll(/`(\d+\.\d+\.\d+)`/g)].map((x) => x[1]);
  const claimedCount = num(m[1]);
  const claimedMoves = num(m[3]);
  const sorted = [...baselineVersions].sort(cmp);
  // (the agent version named by this form is already checked above, shared with the no-gap form)

  const unknown = listed.filter((v) => !baselineVersions.includes(v));
  if (unknown.length) {
    errors.push(`DESIGN.md scope note lists baseline(s) with no baselines/desktop-*.json: ${unknown.join(", ")}`);
    return errors;
  }
  if (listed.length === 0) {
    errors.push("DESIGN.md scope note lists no baselines");
    return errors;
  }

  const startIdx = sorted.indexOf(listed[0]);
  const expected = sorted.slice(startIdx);
  if (listed.join(",") !== expected.join(","))
    errors.push(
      `DESIGN.md scope note baseline list is stale or out of order — expected every baseline from ${listed[0]} through ${maxBaseline ?? sorted[sorted.length - 1]}: ${expected.join(", ")} (found: ${listed.join(", ")})`,
    );

  if (claimedCount === undefined) errors.push(`DESIGN.md scope note count "${m[1]}" is not a number this check understands`);
  else if (claimedCount !== listed.length) errors.push(`DESIGN.md scope note says ${claimedCount} baselines but lists ${listed.length}`);

  // ELF moves across the listed range, seeded from the baseline immediately BEFORE the first listed one
  // — its agent version is the "before" state the first listed entry is compared against.
  if (startIdx <= 0) {
    errors.push(`DESIGN.md scope note starts at ${listed[0]}, which has no preceding baseline to compare agent versions against`);
    return errors;
  }
  let prev = agentOf(sorted[startIdx - 1]);
  let moves = 0;
  for (const v of listed) {
    const a = agentOf(v);
    if (a !== prev) moves++;
    prev = a;
  }
  if (claimedMoves === undefined) errors.push(`DESIGN.md scope note ELF-move count "${m[3]}" is not a number this check understands`);
  else if (claimedMoves !== moves)
    errors.push(`DESIGN.md scope note says ${claimedMoves} of those baselines moved the agent ELF; the baselines say ${moves}`);

  return errors;
}

/** Invariant 12 — the docs' claims about the cassette FORMAT track `CASSETTE_VERSION` /
 *  `MIN_SUPPORTED_CASSETTE_VERSION` and the schema files actually on disk.
 *
 *  `CASSETTE_VERSION` reached 12 while `task-recipes.md` still linked `schema/cassette.v11.json` and
 *  called 11 "current max" — the reference a skill author reads when they open a cassette pointed at a
 *  superseded schema, and at a version regime (`lane: remote` stamps 11, else 10) the hash-format epoch
 *  had already replaced. `SPEC.md` said v9 and v10 were "retained alongside v11", which both understates
 *  the retained set and re-states 11 as the top.
 *
 *  It guards CURRENT/MAX CLAIMS, not every mention of a version. `docs/scenario.md` and `docs/cassette.md`
 *  explain the v10-vs-v11 `lane: remote` regime at length and are correct history; `CHANGELOG.md` is
 *  nothing but history. Flagging those would train the next author to route around the check. So each
 *  present-tense claim is pinned by its own phrasing, the way invariants 9-11 pin DESIGN.md's — and a
 *  claim that cannot be FOUND is an error, so rewording the sentence fails rather than silently disabling
 *  the rule.
 *
 *  Pure (no disk access) so every branch can be mutation-tested; `checkVersions` supplies the real inputs. */
/** Session-shape fingerprint field claims (invariant 14).
 *
 *  The field set has ONE source of truth — `buildSessionFingerprint`'s `shape` literal in
 *  `src/run/cassette.ts` — and is re-stated in prose across the shipped corpus. Every re-statement is a
 *  staleness site, and hand-fixing them has already failed twice: one pass added a field to a single site
 *  and left it missing from the others, and a later audit of that same line still missed two more fields.
 *  So the sites are DISCOVERED, not listed. A new enumeration in a new doc is covered the day it lands.
 *
 *  A site is a span that (a) names the fingerprint via one of `MARKERS` and (b) contains the anchor token
 *  `folders`, which every enumeration states first. The span is the marker line plus its continuation
 *  lines — deliberately NOT the whole file: a file-scoped token check passes the moment an unrelated
 *  mention of a field name lands anywhere in the file, and would then never fail again.
 *
 *  Token matching is strict and case-sensitive against the canonical key names, so the corpus must use
 *  them verbatim. That is the point: the alternative is a singular/plural/case normalization loose
 *  enough that a wrong enumeration still satisfies it. */
const FP_MARKERS = /sessionFingerprint|session-SHAPE|session-shape|content-relevant SHAPE|content-SHAPE/;

/** Paths whose enumeration is deliberately frozen, each with the reason it is exempt. A retained
 *  historical schema documents the format as it stood at that version; rewriting its description would
 *  make it describe a shape its own consumers never saw. */
const FP_FROZEN: Record<string, string> = {
  "schema/cassette.v9.json": "retained historical schema — describes the v9 shape as shipped",
  "schema/cassette.v10.json": "retained historical schema — describes the v10 shape as shipped",
  "schema/cassette.v11.json": "retained historical schema — describes the v11 shape as shipped",
};

/** Extract the fingerprint shape's top-level keys from source text. Reads the text rather than importing
 *  `src/run/cassette.ts`: that module is large with side-effectful imports, and this script must stay
 *  runnable before a build (same rationale as the cassette-version constants). Parse-or-error, never
 *  parse-and-pass — a regex that stops matching must fail loudly, not silently approve every site. */
export function fingerprintShapeKeys(cassetteSrc: string): { keys: string[]; error?: string } {
  const start = cassetteSrc.indexOf("const shape = {");
  if (start < 0) return { keys: [], error: "could not find `const shape = {` in src/run/cassette.ts" };
  const end = cassetteSrc.indexOf("\n  };", start);
  if (end < 0) return { keys: [], error: "could not find the end of the `shape` literal in src/run/cassette.ts" };
  const block = cassetteSrc.slice(start, end);
  const literal = [...block.matchAll(/^    ([a-z_]+):/gm)].map((m) => m[1]);
  const spread = [...block.matchAll(/\?\s*\{\s*([a-z_]+):/g)].map((m) => m[1]);
  const keys = [...new Set([...literal, ...spread])].sort();
  if (keys.length < 6)
    return {
      keys,
      error: `extracted only ${keys.length} keys (${keys.join(",")}) from the \`shape\` literal — the extractor is broken, not the docs`,
    };
  return { keys };
}

export function checkFingerprintFieldClaims(opts: {
  keys: string[];
  corpus: { path: string; text: string }[];
  frozen?: Record<string, string>;
  /** Floor on how many sites the pattern must find. Meaningful only against the whole corpus (a unit case
   *  legitimately supplies prose with no enumeration), and set by the `check:versions` caller. Guards
   *  against SILENT EROSION: if a reword stops matching the pattern, the site drops out of coverage and
   *  everything still reads green. Raise this when a site is deliberately added. */
  minSites?: number;
}): string[] {
  const errors: string[] = [];
  const { keys, corpus } = opts;
  const frozen = opts.frozen ?? FP_FROZEN;
  let sites = 0;
  for (const { path, text } of corpus) {
    if (frozen[path]) continue;
    const lines = text.split("\n");
    let coveredThrough = -1;
    for (let i = 0; i < lines.length; i++) {
      // Anchor on the ENUMERATION, not the marker: `folders` is the field every enumeration states, and
      // anchoring here keeps the checked span to the text that does the enumerating. Anchoring on the
      // marker instead forces a forward walk to find the fields, and that walk is what silently turns
      // into a whole-file check (in JSON no line is blank or starts with a list marker, so it runs to
      // end-of-file and then passes forever).
      if (!/\bfolders\b/.test(lines[i]) || i <= coveredThrough) continue;
      // A marker on the line, or just above it — a JSON key can sit above its own `description`.
      if (!lines.slice(Math.max(0, i - 2), i + 1).some((l) => FP_MARKERS.test(l))) continue;
      let span = lines[i];
      // Prose wraps; JSON does not. The cap bounds a paragraph walk so tokens from an unrelated sentence
      // cannot satisfy the check.
      if (!path.endsWith(".json"))
        for (let j = i + 1; j < lines.length && j - i <= 8; j++) {
          const l = lines[j];
          if (l.trim() === "" || /^\s*([-*+]\s|#{1,6}\s|\|)/.test(l)) break;
          span += "\n" + l;
          coveredThrough = j;
        }
      sites++;
      const missing = keys.filter((k) => !new RegExp(`\\b${k}\\b`).test(span));
      if (missing.length)
        errors.push(
          `${path}:${i + 1} enumerates the sessionFingerprint field set but omits ${missing.map((m) => `\`${m}\``).join(", ")} ` +
            `— the shape in src/run/cassette.ts has ${keys.join(", ")}. Add the missing field(s), or add the path to FP_FROZEN with a reason.`,
        );
    }
  }
  if (opts.minSites !== undefined && sites < opts.minSites)
    errors.push(
      `checkFingerprintFieldClaims found ${sites} enumeration sites, expected at least ${opts.minSites} — a reword has ` +
        `dropped a site out of coverage (or one was removed on purpose, in which case lower the floor deliberately)`,
    );
  return errors;
}

export function checkCassetteVersionClaims(opts: {
  current: number;
  minSupported: number;
  /** Versions with a `schema/cassette.vN.json` on disk. */
  retained: number[];
  spec: string;
  taskRecipes: string;
  /** The whole shipped-doc corpus, for the referenced-schema-exists sweep. */
  docs: { path: string; text: string }[];
}): string[] {
  const errors: string[] = [];
  const { current, minSupported, retained, spec, taskRecipes, docs } = opts;

  if (!Number.isInteger(current) || current <= 0) errors.push(`could not read CASSETTE_VERSION from src/run/cassette.ts (got ${current})`);
  if (!Number.isInteger(minSupported) || minSupported <= 0)
    errors.push(`could not read MIN_SUPPORTED_CASSETTE_VERSION from src/run/cassette.ts (got ${minSupported})`);
  if (retained.length === 0) errors.push("no schema/cassette.v*.json files found — the schema sweep would be vacuous");
  // A corpus that quietly collapsed to nothing would make 12e vacuous while 12a-12d still passed, which
  // reads as "checked" in CI output. The floor sits well below the real count (~45).
  if (docs.length < 20) errors.push(`the shipped-doc corpus is only ${docs.length} files — the schema sweep would be near-vacuous`);
  if (errors.length) return errors; // everything below compares against these; do not report noise on top

  // 12a. SPEC's max-version claim, and the schema file it names alongside it.
  const max = /the maximum `cassetteVersion` this build writes\/reads is \*\*(\d+)\*\*\s*\n?\s*\(`schema\/cassette\.v(\d+)\.json`\)/.exec(
    spec,
  );
  if (!max)
    errors.push(
      'SPEC.md has no "the maximum `cassetteVersion` this build writes/reads is **N** (`schema/cassette.vN.json`)" claim to verify (invariant 12)',
    );
  else {
    if (Number(max[1]) !== current) errors.push(`SPEC.md says the maximum cassetteVersion is ${max[1]}; CASSETTE_VERSION is ${current}`);
    if (Number(max[2]) !== current)
      errors.push(`SPEC.md points at schema/cassette.v${max[2]}.json as the current schema; CASSETTE_VERSION is ${current}`);
  }

  // 12b. SPEC's read floor.
  const min = /The minimum supported read version is \*\*v(\d+)\*\*/.exec(spec);
  if (!min) errors.push('SPEC.md has no "The minimum supported read version is **vN**" claim to verify (invariant 12)');
  else if (Number(min[1]) !== minSupported)
    errors.push(`SPEC.md says the minimum supported read version is v${min[1]}; MIN_SUPPORTED_CASSETTE_VERSION is ${minSupported}`);

  // 12c. SPEC's retained-schema range. Stated as a RANGE rather than a list so it cannot go stale by
  // omission the way "v9 and v10 ... alongside v11" did — and the range is only honest while the set on
  // disk is contiguous, which is checked rather than assumed.
  const sorted = [...retained].sort((a, b) => a - b);
  const contiguous = sorted.every((v, i) => i === 0 || v === sorted[i - 1] + 1);
  // `\s+` not a space: the sentence wraps mid-claim in SPEC.md, and a regex that only matched the
  // one-line form would have reported "no claim to verify" for a claim that was right there.
  const range = /the retained schema files are\s+`schema\/cassette\.v(\d+)\.json`\s+through\s+`schema\/cassette\.v(\d+)\.json`/.exec(spec);
  if (!range)
    errors.push(
      'SPEC.md has no "the retained schema files are `schema/cassette.vN.json` through `schema/cassette.vM.json`" claim to verify (invariant 12)',
    );
  else if (!contiguous)
    errors.push(
      `schema/cassette.v*.json is no longer contiguous (${sorted.join(", ")}) — SPEC.md's "through" range cannot describe it; enumerate instead`,
    );
  else {
    if (Number(range[1]) !== sorted[0])
      errors.push(`SPEC.md says the retained schemas start at v${range[1]}; schema/ starts at v${sorted[0]}`);
    if (Number(range[2]) !== sorted[sorted.length - 1])
      errors.push(`SPEC.md says the retained schemas end at v${range[2]}; schema/ ends at v${sorted[sorted.length - 1]}`);
  }

  // 12d. task-recipes.md — the schema a skill author is pointed at, and its "current max" number.
  const anat = /Top-level fields of a `\*\.cassette\.json` \(schema \[`schema\/cassette\.v(\d+)\.json`\]\((\S+?)\)\)/.exec(taskRecipes);
  if (!anat)
    errors.push('task-recipes.md has no "Top-level fields of a `*.cassette.json` (schema [...])" pointer to verify (invariant 12)');
  else {
    if (Number(anat[1]) !== current)
      errors.push(`task-recipes.md points a skill author at schema/cassette.v${anat[1]}.json; CASSETTE_VERSION is ${current}`);
    if (!anat[2].endsWith(`/schema/cassette.v${anat[1]}.json`))
      errors.push(`task-recipes.md's schema link text and URL disagree: text says v${anat[1]}, URL is ${anat[2]}`);
  }
  const curMax = /current max: (\d+)/.exec(taskRecipes);
  if (!curMax) errors.push('task-recipes.md has no "current max: N" claim to verify (invariant 12)');
  else if (Number(curMax[1]) !== current) errors.push(`task-recipes.md says "current max: ${curMax[1]}"; CASSETTE_VERSION is ${current}`);

  // 12e. Nothing anywhere links a schema file that does not exist. Cheap, and the one rule that keeps
  // working if someone deletes a retained schema instead of adding one.
  const have = new Set(retained);
  for (const { path, text } of docs)
    for (const m of text.matchAll(/`?schema\/cassette\.v(\d+)\.json/g))
      if (!have.has(Number(m[1])))
        errors.push(`${path} references schema/cassette.v${m[1]}.json, which is not in schema/ (have v${sorted.join(", v")})`);

  return errors;
}

export function checkVersions(): { ok: boolean; errors: string[]; values: Record<string, string | undefined> } {
  const errors: string[] = [];

  const pkg = json("package.json").version as string;
  const lock = json("package-lock.json");
  const lockRoot = lock.version as string;
  const lockPkg = lock.packages?.[""]?.version as string | undefined;

  const market = json(".claude-plugin/marketplace.json").plugins?.[0]?.version as string | undefined;
  const plugin = json(".claude/skills/cowork-harness/.claude-plugin/plugin.json").version as string | undefined;

  const skillMd = r(".claude/skills/cowork-harness/SKILL.md");
  const frontmatter = skillMd.split("---")[1] ?? "";
  const skillVer = frontmatter.match(/^\s*version:\s*(\S+)\s*$/m)?.[1];
  const tracks = skillMd.match(/tracks-harness:\s*cowork-harness\s+(\d+\.\d+\.\d+)/)?.[1];
  const floor = skillMd.match(/cowork-harness@\^(\d+\.\d+\.\d+)/)?.[1];

  // Baseline pins (invariant 7) — extracted here so they can ride in `values` alongside the rest.
  const skillBaseline = skillMd.match(/tracks-harness:\s*cowork-harness\s+\d+\.\d+\.\d+\s*\(baseline\s+desktop-(\d+\.\d+\.\d+)\)/)?.[1];

  // "Version note" prose blockquote (invariant 10) — the human-facing sentence, distinct from the
  // machine-readable `tracks-harness:` frontmatter line above. It wraps across a `> `-prefixed line
  // break in the actual Markdown, so the regex spans that break explicitly rather than relying on
  // a dotall flag.
  const versionNote = skillMd.match(
    /\*\*Version note:\*\*.*?track\s+`cowork-harness\s+(\d+\.\d+\.\d+)`\s*\(baseline\s*\n>\s*`desktop-(\d+\.\d+\.\d+)`\)/,
  );
  const versionNoteVersion = versionNote?.[1];
  const versionNoteBaseline = versionNote?.[2];

  const readmeText = r("README.md");
  const readmeBaseline = readmeText.match(/latest shipped baseline[^.]*?is\s+\*\*`desktop-(\d+\.\d+\.\d+)`\*\*/)?.[1];
  const baselineFiles = readdirSync(join(REPO_ROOT, "baselines")).filter((f) => /^desktop-\d+\.\d+\.\d+\.json$/.test(f));
  const baselineVersions = baselineFiles.map((f) => f.match(/^desktop-(\d+\.\d+\.\d+)\.json$/)![1]);
  const maxBaseline = baselineVersions.reduce((max, v) => (cmp(v, max) > 0 ? v : max), baselineVersions[0]);

  const values = {
    pkg,
    lockRoot,
    lockPkg,
    market,
    plugin,
    skillVer,
    tracks,
    floor,
    skillBaseline,
    readmeBaseline,
    maxBaseline,
    versionNoteVersion,
    versionNoteBaseline,
  };

  // 1. npm self-consistency
  if (!SEMVER.test(pkg)) errors.push(`package.json version "${pkg}" is not X.Y.Z`);
  if (lockRoot !== pkg) errors.push(`package-lock.json root version "${lockRoot}" != package.json "${pkg}"`);
  if (lockPkg !== pkg) errors.push(`package-lock.json packages[""].version "${lockPkg}" != package.json "${pkg}"`);

  // 2. skill self-consistency
  const skillSet = new Set([market, plugin, skillVer]);
  if (skillSet.size !== 1 || [...skillSet][0] === undefined) {
    errors.push(`skill version mismatch — marketplace.json=${market}, plugin.json=${plugin}, SKILL.md=${skillVer} (all three must agree)`);
  }

  // 3. floor === tracks-harness
  if (!floor) errors.push(`could not find bootstrap floor "cowork-harness@^X.Y.Z" in SKILL.md`);
  if (!tracks) errors.push(`could not find "tracks-harness: cowork-harness X.Y.Z" in SKILL.md`);
  if (floor && tracks && floor !== tracks) {
    errors.push(`bootstrap floor "@^${floor}" != tracks-harness "${tracks}" (keep them in lockstep)`);
  }

  // 4. floor <= package.json (the skill must not demand an unpublished/future harness)
  if (floor && SEMVER.test(pkg) && cmp(floor, pkg) > 0) {
    errors.push(`bootstrap floor "@^${floor}" is ahead of package.json "${pkg}" — skill would lead npm`);
  }

  // 5. README bootstrap floor(s) must match the SKILL.md floor (README is not under any other version check,
  //    so it drifts silently — this is the guard that would have caught the @>=0.9.0-while-package-0.12.0 gap).
  const readme = r("README.md");
  const readmeFloors = [...readme.matchAll(/cowork-harness@\^(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
  if (floor) {
    if (readmeFloors.length === 0) errors.push(`README.md has no "cowork-harness@^X.Y.Z" floor to verify against SKILL.md "@^${floor}"`);
    for (const f of readmeFloors) if (f !== floor) errors.push(`README.md floor "@^${f}" != SKILL.md floor "@^${floor}"`);
  }

  // 5b. EVERY `@>=X.Y.Z` inside SKILL.md must equal the floor — including a BARE `Pin `@>=X`` with no
  //     `cowork-harness` prefix. Invariant 3 reads only the FIRST `cowork-harness@>=` match, so a bare
  //     floor drifted silently (it shipped stale from 0.33.0 through 1.0.0). This catches all of them.
  if (floor) {
    const skillFloors = [...skillMd.matchAll(/@\^(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
    for (const f of skillFloors)
      if (f !== floor) errors.push(`SKILL.md floor "@^${f}" != SKILL.md bootstrap floor "@^${floor}" (a bare \`@^X\` drifted — bump it)`);
  }

  // 6. Each reference doc's "Tracks `cowork-harness X.Y.Z`" stamp must match tracks-harness, and any
  //    `(baseline desktop-X.Y.Z)` pin in the doc must match SKILL.md's tracks-harness baseline. The
  //    baseline half is what caught the refs pinning desktop-1.20186.1 two Desktop syncs after
  //    SKILL.md moved on — RELEASING's checklist alone didn't hold.
  const refFiles = [
    ".claude/skills/cowork-harness/references/ci-recipe.md",
    ".claude/skills/cowork-harness/references/scenario-schema.md",
    ".claude/skills/cowork-harness/references/fidelity-and-answers.md",
    ".claude/skills/cowork-harness/references/task-recipes.md",
    ".claude/skills/cowork-harness/references/critique.md",
  ];
  for (const f of refFiles) {
    const refText = r(f);
    if (tracks) {
      const stamp = refText.match(/Tracks\s+`cowork-harness\s+(\d+\.\d+\.\d+)`/)?.[1];
      if (!stamp) errors.push(`${f} has no "Tracks \`cowork-harness X.Y.Z\`" stamp`);
      else if (stamp !== tracks) errors.push(`${f} stamp "${stamp}" != tracks-harness "${tracks}"`);
    }
    if (skillBaseline) {
      for (const m of refText.matchAll(/\(baseline\s+`?desktop-(\d+\.\d+\.\d+)`?\)/g)) {
        if (m[1] !== skillBaseline) {
          errors.push(`${f} baseline pin "desktop-${m[1]}" != SKILL.md tracks-harness baseline "desktop-${skillBaseline}"`);
        }
      }
    }
  }

  // 7. baseline pins agree with each other, and none is behind the max baseline file on disk.
  if (!skillBaseline) {
    errors.push(`could not find "(baseline desktop-X.Y.Z)" on the tracks-harness line in SKILL.md`);
  }
  if (!readmeBaseline) {
    errors.push(`could not find the "latest shipped baseline ... is **\`desktop-X.Y.Z\`**" sentence in README.md`);
  }
  if (baselineVersions.length === 0) {
    errors.push(`no baselines/desktop-*.json files found — cannot compute max baseline`);
  }
  const pins: Array<{ label: string; version: string | undefined }> = [
    { label: "SKILL.md tracks-harness baseline", version: skillBaseline },
    { label: "README.md latest-shipped-baseline", version: readmeBaseline },
  ];
  const presentPins = pins.filter((p): p is { label: string; version: string } => p.version !== undefined);
  for (let i = 1; i < presentPins.length; i++) {
    if (presentPins[i].version !== presentPins[0].version) {
      errors.push(
        `baseline pin mismatch — ${presentPins[0].label}="${presentPins[0].version}" != ${presentPins[i].label}="${presentPins[i].version}"`,
      );
    }
  }
  if (maxBaseline) {
    for (const p of presentPins) {
      if (cmp(p.version, maxBaseline) < 0) {
        errors.push(`${p.label}="${p.version}" is behind the max baselines/desktop-*.json version "${maxBaseline}"`);
      }
    }
  }

  // 8. copy-paste CI `V=X.Y.Z` agent-binary pins must match the max baseline's agentVersion.
  let maxAgentVersion: string | undefined;
  if (maxBaseline) {
    maxAgentVersion = json(`baselines/desktop-${maxBaseline}.json`).agentVersion as string | undefined;
  }
  const vPinFiles = ["README.md", ".claude/skills/cowork-harness/references/ci-recipe.md", "docs/maintenance.md"];
  if (maxAgentVersion) {
    for (const f of vPinFiles) {
      const pin = r(f).match(/\bV=(\d+\.\d+\.\d+)\b/)?.[1];
      if (!pin) {
        errors.push(`${f} has no "V=X.Y.Z" agent-binary pin to verify against baseline agentVersion "${maxAgentVersion}"`);
      } else if (pin !== maxAgentVersion) {
        errors.push(`${f} pin "V=${pin}" != max baseline's agentVersion "${maxAgentVersion}" (baselines/desktop-${maxBaseline}.json)`);
      }
    }
  } else if (maxBaseline) {
    errors.push(`baselines/desktop-${maxBaseline}.json has no "agentVersion" field`);
  }

  // 9. DESIGN.md's single present-tense current-state sentence must name the max baseline + its
  //    agentVersion. Scoped to the one `currently **X**, per \`baselines/...\`` sentence — the dated
  //    verification-pass notes elsewhere in DESIGN.md stay exempt (see invariant 7's note).
  const design = r("DESIGN.md");
  const designCurrent = design.match(/currently \*\*(\d+\.\d+\.\d+)\*\*, per `baselines\/desktop-(\d+\.\d+\.\d+)\.json`/);
  if (!designCurrent) {
    errors.push('DESIGN.md has no "currently **X.Y.Z**, per `baselines/desktop-X.Y.Z.json`" current-state sentence to verify');
  } else {
    if (maxAgentVersion && designCurrent[1] !== maxAgentVersion) {
      errors.push(`DESIGN.md current-state agent "${designCurrent[1]}" != max baseline's agentVersion "${maxAgentVersion}"`);
    }
    if (maxBaseline && designCurrent[2] !== maxBaseline) {
      errors.push(`DESIGN.md current-state baseline "desktop-${designCurrent[2]}" != max baseline "desktop-${maxBaseline}"`);
    }
  }

  // 10. SKILL.md's prose "Version note" blockquote must agree with the floor and skillBaseline it
  //     sits right next to — otherwise it's an ungrounded, ungoverned copy of the version metadata.
  if (!versionNote) {
    errors.push(`could not find SKILL.md "Version note" blockquote (version + baseline)`);
  } else {
    if (floor && versionNoteVersion !== floor) {
      errors.push(`SKILL.md "Version note" version "${versionNoteVersion}" != bootstrap floor "@>=${floor}"`);
    }
    if (skillBaseline && versionNoteBaseline !== skillBaseline) {
      errors.push(
        `SKILL.md "Version note" baseline "desktop-${versionNoteBaseline}" != tracks-harness baseline "desktop-${skillBaseline}"`,
      );
    }
  }

  // 11. DESIGN.md's "Scope of that claim" note is the repo's honest disclosure of how much of the
  //     CURRENT baseline is actually live-verified, and every figure in it is machine-derivable from
  //     baselines/desktop-*.json. It is deliberately outside invariant 9 (which pins only the
  //     present-tense current-state sentence) and outside invariant 7's dated-note exemption, because
  //     unlike a dated note this paragraph makes a claim about the PRESENT: "N baselines have shipped
  //     since [the last live pass]". That claim goes stale on its own every release.
  //
  //     It has silently drifted twice: the list was extended without recounting, leaving "four of which
  //     moved the agent ELF" when six of the nine listed had. Understating how much is unverified is the
  //     one doc error worth failing a release over, so it is checked rather than trusted.
  //
  //     The list's START is NOT derived — the paragraph deliberately omits baselines covered by the live
  //     pass itself, and encoding that rule here would just move the drift. Instead the list must be
  //     CONTIGUOUS from wherever it starts through the newest baseline, which is what actually catches a
  //     release being left out.
  errors.push(
    ...checkDesignScopeNote({
      design,
      baselineVersions,
      maxBaseline,
      maxAgentVersion,
      agentOf: (v) => json(`baselines/desktop-${v}.json`).agentVersion as string | undefined,
    }),
  );

  // 13. Bounded floors. `>=` is the defect, not the version behind it: it crosses majors, so a floor
  //     written that way resolves the next breaking release. Scanned across the whole shipped-doc corpus,
  //     not a hand-listed set of files — the two docs that drifted (ci-recipe, examples/replays/README)
  //     drifted precisely because they were not on such a list.
  {
    const docsForFloors = shippedDocs();
    if (docsForFloors.length < 20) errors.push(`floor scan corpus is only ${docsForFloors.length} files — near-vacuous`);
    for (const { path, text } of docsForFloors) {
      for (const m of text.matchAll(/(?:cowork-harness)?@>=(\d+\.\d+\.\d+)/g))
        errors.push(
          `${path} advertises an UNBOUNDED floor "@>=${m[1]}" — \`>=\` crosses majors (a consumer resolves the ` +
            `next breaking release). Use "@^${m[1]}".`,
        );
      // A doc may deliberately name an OLD floor to illustrate a past feature gate. That is exempt from
      // the equality rule — but never from the `>=` rule above: the FORM is the defect, whatever the
      // version. The opt-out is an explicit inline marker on the same line, so the intent is visible in
      // the doc rather than buried in a file list here.
      // The Action's OWN `version:` input takes the same kind of range, and invariant 13's `@>=` pattern is
      // blind to it — no `@` in `version: ">=1.11.0"`. Same defect, different syntax: a bare floor there
      // hands a copy-paster the next major. Anchored ranges (`^2`), exact pins and `latest` are all fine;
      // only the unbounded floor is not.
      for (const m of text.matchAll(/version:\s*"(>=[^"]*)"/g))
        if (!/<\s*\d/.test(m[1]))
          errors.push(
            `${path} sets the Action input \`version: "${m[1]}"\` — a bare floor crosses majors. Anchor it at ` +
              `the current major (\`^${(floor ?? "0").split(".")[0]}\`), pin an exact version, or omit it for \`latest\`.`,
          );
      if (floor)
        for (const line of text.split("\n")) {
          if (line.includes("floor-historical")) continue;
          for (const m of line.matchAll(/(?:cowork-harness)?@\^(\d+\.\d+\.\d+)/g))
            if (m[1] !== floor) errors.push(`${path} floor "@^${m[1]}" != SKILL.md floor "@^${floor}"`);
        }
    }
  }

  // 12. cassette-format claims (see `checkCassetteVersionClaims`). The constants are read out of the
  //     source text rather than imported: `src/run/cassette.ts` is a large module with side-effectful
  //     imports, and this script must stay runnable before a build. A regex that stops matching yields
  //     NaN, which the function reports as an error rather than passing.
  const cassetteSrc = r("src/run/cassette.ts");
  const constOf = (name: string) => Number(new RegExp(`export const ${name} = (\\d+);`).exec(cassetteSrc)?.[1]);
  const retained = readdirSync(join(REPO_ROOT, "schema"))
    .map((f) => /^cassette\.v(\d+)\.json$/.exec(f)?.[1])
    .flatMap((v) => (v === undefined ? [] : [Number(v)]));
  errors.push(
    ...checkCassetteVersionClaims({
      current: constOf("CASSETTE_VERSION"),
      minSupported: constOf("MIN_SUPPORTED_CASSETTE_VERSION"),
      retained,
      spec: r("SPEC.md"),
      taskRecipes: r(TASK_RECIPES),
      docs: shippedDocs(),
    }),
  );

  // 14. sessionFingerprint field claims (see `checkFingerprintFieldClaims`). The corpus is the shipped
  //     markdown plus the cassette schemas, whose `description` strings enumerate the same field set.
  const fpShape = fingerprintShapeKeys(cassetteSrc);
  if (fpShape.error) errors.push(fpShape.error);
  else
    errors.push(
      ...checkFingerprintFieldClaims({
        keys: fpShape.keys,
        corpus: [
          ...shippedDocs(),
          ...readdirSync(join(REPO_ROOT, "schema"))
            .filter((f) => /^cassette\.v\d+\.json$/.test(f))
            .map((f) => ({ path: `schema/${f}`, text: r(`schema/${f}`) })),
        ],
        // 6 prose sites + 2 in schema/cassette.v12.json; v9-v11 are frozen history (see FP_FROZEN).
        minSites: 8,
      }),
    );

  return {
    ok: errors.length === 0,
    errors,
    values: {
      ...values,
      readmeFloors: readmeFloors.join(","),
      baselineVersions: baselineVersions.join(","),
      maxAgentVersion,
    },
  };
}

function main(): void {
  const { ok, errors, values } = checkVersions();
  process.stdout.write(`version lockstep: ${JSON.stringify(values)}\n`);
  if (ok) {
    process.stdout.write("✓ all version strings are aligned\n");
    return;
  }
  for (const e of errors) process.stderr.write(`::error::${e}\n`);
  process.exitCode = 1;
}

// Run only when invoked directly (so a test can import checkVersions without side effects).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
