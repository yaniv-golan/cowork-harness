import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ALWAYS_CONTENT_KEYS, QUESTION_GATE_KEYS, MANIFEST_KEYS, LIVE_ONLY_KEYS } from "../src/run/cassette";
import { VERDICT_MODIFIER_KEYS, ScenarioObject } from "../src/types.js";

// Anti-drift guard: docs/cassette.md's "Assertion table" hand-documents every replay-evaluated
// assertion key. Source of truth = the three key arrays in src/run/cassette.ts (ALWAYS_CONTENT_KEYS /
// QUESTION_GATE_KEYS / MANIFEST_KEYS) — a key added to any of them without a matching doc row would
// silently make the table (which claims to "mirror" that source) go stale. Catch that here instead of
// relying on a human noticing during review.
describe("docs/cassette.md ↔ src/run/cassette.ts replay-key sync", () => {
  const docs = readFileSync(resolve("docs/cassette.md"), "utf8");
  const allKeys = [...new Set([...ALWAYS_CONTENT_KEYS, ...QUESTION_GATE_KEYS, ...MANIFEST_KEYS])];

  it("parsed a sane key set", () => {
    // sanity: catches an import that silently resolved to an empty/undefined array
    expect(allKeys.length).toBeGreaterThan(15);
    expect(allKeys).toContain("skill_triggered");
    expect(allKeys).toContain("file_exists");
  });

  it("every replay-evaluated assertion key is documented as a backtick-quoted token", () => {
    const missing = allKeys.filter((k) => !docs.includes(`\`${k}\``));
    expect(missing, `docs/cassette.md is missing a row for: ${missing.join(", ")}`).toEqual([]);
  });
});

// Anti-drift guard: docs/cli.md's "What replay checks" blockquote table summarizes the same four key
// buckets as its own compact reference. Unlike docs/cassette.md's per-key table (guarded above), this
// table groups keys under wildcard tokens (`transcript_*`, `tool_*`, ...) instead of listing every
// member — so this guard is wildcard-aware: a key is "covered" if its literal backtick token appears
// in the right bucket's cell, OR a `prefix_*` token appears whose prefix is a prefix of the key.
describe("docs/cli.md ↔ src/run/cassette.ts replay-bucket sync", () => {
  const readme = readFileSync(resolve("docs/cli.md"), "utf8");

  const markerIdx = readme.indexOf("> **What replay checks.**");
  const endIdx = markerIdx === -1 ? -1 : readme.indexOf("Authoritative list:", markerIdx);
  // Fail loudly (not a silent vacuous pass) if the marker/table moved or was renamed — same
  // anti-false-pass discipline test/scenario-docs-sync.test.ts uses for its own anchor.
  it('found the "What replay checks" table', () => {
    expect(
      markerIdx,
      'docs/cli.md\'s "> **What replay checks.**" marker was not found — did the table move or get renamed?',
    ).toBeGreaterThan(-1);
    expect(endIdx, 'README.md\'s "Authoritative list:" trailer (end of the replay-bucket table) was not found').toBeGreaterThan(markerIdx);
  });

  const table = markerIdx === -1 || endIdx === -1 ? "" : readme.slice(markerIdx, endIdx);

  // A row looks like `> | <label> | <cell...> |`. Anchoring the label between two `|`s (only
  // whitespace on either side) rules out "Always skipped (live-only)" false-matching a plain
  // "Always" lookup.
  const cellFor = (labelPattern: string): string => {
    const re = new RegExp(String.raw`^>\s*\|\s*${labelPattern}\s*\|(.*)\|\s*$`, "m");
    return table.match(re)?.[1] ?? "";
  };
  const alwaysCell = cellFor("Always");
  const controlOutCell = cellFor(String.raw`Always, against the recorded \`controlOut\`[^|]*`);
  const manifestCell = cellFor(String.raw`Only if the cassette carries an \`artifacts\` manifest`);
  const liveOnlyCell = cellFor(String.raw`Always skipped \(live-only\)`);

  it("parsed all four non-empty bucket cells", () => {
    // sanity: a table refactor that renames/reorders a row shouldn't silently reduce this guard to a
    // vacuous "no keys were missing because we found zero cells" pass.
    expect(alwaysCell.length, "Always cell not found/empty").toBeGreaterThan(0);
    expect(controlOutCell.length, "controlOut cell not found/empty").toBeGreaterThan(0);
    expect(manifestCell.length, "manifest cell not found/empty").toBeGreaterThan(0);
    expect(liveOnlyCell.length, "live-only cell not found/empty").toBeGreaterThan(0);
  });

  const covered = (key: string, cell: string): boolean => {
    if (cell.includes(`\`${key}\``)) return true;
    for (const m of cell.matchAll(/`([a-zA-Z0-9]+_)\*`/g)) {
      if (key.startsWith(m[1])) return true;
    }
    return false;
  };

  // The verdict-modifier keys (allow_permissive_auto_allow, etc.) are folded into ALWAYS_CONTENT_KEYS
  // (see its definition) but README's Always cell represents them only as the prose phrase "the
  // verdict modifiers" — no literal or wildcard token a mechanical `covered()` check could match.
  // Excluded here the same way scenario-docs-sync.test.ts excludes its own non-literal NON_AUTHORABLE
  // set, rather than forcing "the verdict modifiers" to become wildcard-matchable prose.
  const verdictModifierSet = new Set<string>(VERDICT_MODIFIER_KEYS);
  const alwaysCheckable = ALWAYS_CONTENT_KEYS.filter((k) => !verdictModifierSet.has(k));

  it("every Always-bucket key (except the verdict modifiers) is covered in the Always cell", () => {
    const missing = alwaysCheckable.filter((k) => !covered(k, alwaysCell));
    expect(missing, `README.md's Always cell is missing: ${missing.join(", ")}`).toEqual([]);
  });

  it("every controlOut-bucket key is covered in the controlOut cell", () => {
    const missing = QUESTION_GATE_KEYS.filter((k) => !covered(k, controlOutCell));
    expect(missing, `README.md's controlOut cell is missing: ${missing.join(", ")}`).toEqual([]);
  });

  it("every manifest-bucket key is covered in the manifest cell", () => {
    const missing = MANIFEST_KEYS.filter((k) => !covered(k, manifestCell));
    expect(missing, `README.md's manifest cell is missing: ${missing.join(", ")}`).toEqual([]);
  });

  it("every live-only-bucket key is covered in the live-only cell", () => {
    const missing = LIVE_ONLY_KEYS.filter((k) => !covered(k, liveOnlyCell));
    expect(missing, `README.md's live-only cell is missing: ${missing.join(", ")}`).toEqual([]);
  });
});

// The "a cassette freezes the WHOLE scenario" passage hand-enumerates every ScenarioObject field, in two
// docs. It had already gone stale — omitting `timeout_ms`, `on_unanswered` and `allow_host_writes` — which
// matters because the passage's whole point is that editing any of them on disk cannot move a plain
// replay's verdict. A field the list forgets reads as a field the freeze does not cover.
describe("the whole-scenario freeze passage names every ScenarioObject field", () => {
  const FIELDS = Object.keys(ScenarioObject.shape);

  for (const file of ["docs/scenario.md", "docs/cassette.md"]) {
    it(`${file} enumerates all ${FIELDS.length} scenario fields`, () => {
      const text = readFileSync(resolve(file), "utf8");
      const start = text.indexOf("freezes the");
      expect(start, `could not locate the freeze passage in ${file}`).toBeGreaterThan(-1);
      // Bound to the passage, not the file: every field name appears elsewhere in these docs, so an
      // unbounded search would pass while the list itself was missing entries.
      const passage = text.slice(start, start + 700);
      const missing = FIELDS.filter((f) => !passage.includes(`\`${f}\``));
      expect(missing, `${file}'s freeze passage omits: ${missing.join(", ")}`).toEqual([]);
    });
  }
});

// ── T-G1: the replay-class buckets, guarded INDEPENDENTLY ────────────────────────────────────────────
//
// The docs/cassette.md guard at the top of this file compares a UNION of three buckets, and leaves
// LIVE_ONLY_KEYS out entirely. A union cannot see a key MOVING between buckets — and the move is the
// change that matters, because the bucket is what tells an author whether their assertion survives a
// token-free replay or is silently skipped. Two real misclassifications were sitting behind that blind
// spot when this was written:
//
//   * `fidelity-and-answers.md` enumerated the live-only set and omitted `no_delete_in_mounts`, so a
//     reader counting on that list would expect it to replay.
//   * `scenario.py`'s scaffold emitted `file_exists`/`user_visible_artifact` under a heading reading
//     "LIVE-only (skipped on replay)". Both are MANIFEST_KEYS — they replay whenever the cassette
//     carries an artifacts manifest, which `record` has snapshotted since 0.24. The scaffold contradicted
//     the taxonomy in its OWN file, and taught the misconception the `manifest-needs-snapshot` INFO exists
//     to correct.
//
// The scenario.py check is deliberately a SELF-consistency check against that file's own sets, not a
// mirror of the TS constants: `scenario.py:67` says outright that it is "NOT a 1:1 mirror" (it keeps the
// verdict modifiers out of CONTENT_KEYS on purpose), so demanding equality would be wrong and would get
// worked around rather than fixed.

describe("T-G1 · each replay-class bucket is guarded on its own, not as a union", () => {
  const NON_LIVE = [...ALWAYS_CONTENT_KEYS, ...QUESTION_GATE_KEYS, ...MANIFEST_KEYS];

  /** Text from `start` up to the first match of `end` — so a key elsewhere in the file can't satisfy
   *  a claim made by one specific passage. */
  const section = (text: string, start: string, end: RegExp): string => {
    const i = text.indexOf(start);
    if (i < 0) return "";
    const rest = text.slice(i + start.length);
    const m = end.exec(rest);
    return rest.slice(0, m ? m.index : rest.length);
  };

  const cassetteMd = readFileSync(resolve("docs/cassette.md"), "utf8");
  const fidelityMd = readFileSync(resolve(".claude/skills/cowork-harness/references/fidelity-and-answers.md"), "utf8");
  const scenarioPy = readFileSync(resolve(".claude/skills/cowork-harness/scripts/scenario.py"), "utf8");

  const skippedSection = section(cassetteMd, "### Still skipped on replay", /^#{2,3} /m);
  const liveOnlyList = section(fidelityMd, "keys is live-only and **skipped outright** on replay", /Everything else/);

  it("located every passage it claims to check (an empty section would pass vacuously)", () => {
    expect(skippedSection.length, 'docs/cassette.md "### Still skipped on replay" not found').toBeGreaterThan(100);
    expect(liveOnlyList.length, "fidelity-and-answers.md's live-only enumeration not found").toBeGreaterThan(50);
    expect(LIVE_ONLY_KEYS.length, "LIVE_ONLY_KEYS is empty — the import resolved to nothing").toBeGreaterThan(5);
  });

  // Two directions per consumer. Membership alone would stay green when a key moves INTO the bucket it
  // does not belong in; exclusion alone would stay green when one goes missing.
  it("docs/cassette.md's skipped-on-replay section names every live-only key AND no other bucket's", () => {
    const missing = LIVE_ONLY_KEYS.filter((k) => !skippedSection.includes(`\`${k}\``));
    expect(missing, `docs/cassette.md's "Still skipped on replay" omits: ${missing.join(", ")}`).toEqual([]);
    const wrong = NON_LIVE.filter((k) => skippedSection.includes(`\`${k}\``));
    expect(wrong, `docs/cassette.md lists these as skipped, but they are NOT live-only: ${wrong.join(", ")}`).toEqual([]);
  });

  it("fidelity-and-answers.md's live-only enumeration names every live-only key AND no other bucket's", () => {
    const missing = LIVE_ONLY_KEYS.filter((k) => !liveOnlyList.includes(`\`${k}\``));
    expect(missing, `the skill's live-only list omits: ${missing.join(", ")} — a reader expects these to replay`).toEqual([]);
    const wrong = NON_LIVE.filter((k) => liveOnlyList.includes(`\`${k}\``));
    expect(wrong, `the skill's live-only list wrongly includes: ${wrong.join(", ")}`).toEqual([]);
  });

  // The filesystem-assertion passages. The whole-file check at the top of this file let one through: the
  // cassette.md subsection opener listed six of the eight manifest keys, and the file still named all
  // eight two paragraphs earlier. Each passage is therefore checked on its own list, both directions.
  const OTHER_BUCKETS = [...ALWAYS_CONTENT_KEYS, ...QUESTION_GATE_KEYS, ...LIVE_ONLY_KEYS];
  const fsHeading = "### Filesystem assertions — replay-checkable WITH an artifact manifest";
  const fsParagraph = section(cassetteMd, fsHeading, /^#{2,3} /m)
    .trimStart()
    .split(/\n\s*\n/)[0];
  // The opener is the paragraph's first sentence — the list itself, before the body explains single keys.
  const cassetteOpener = fsParagraph.slice(0, fsParagraph.search(/\.\s/) + 1);
  const scenarioMd = readFileSync(resolve("docs/scenario.md"), "utf8");
  const scenarioParagraph = section(scenarioMd, "**Filesystem assertions**", /\n\s*\n/);
  const scenarioList = section(scenarioParagraph, "(", /\)/);

  it("located both filesystem-assertion passages (an empty passage would pass vacuously)", () => {
    expect(cassetteOpener.length, `docs/cassette.md "${fsHeading}" opener not found`).toBeGreaterThan(100);
    expect(scenarioList.length, 'docs/scenario.md "**Filesystem assertions** (…)" list not found').toBeGreaterThan(100);
    expect(MANIFEST_KEYS.length).toBeGreaterThan(5);
  });

  for (const [name, list] of [
    ["docs/cassette.md's filesystem-assertions opener", () => cassetteOpener],
    ["docs/scenario.md's **Filesystem assertions** list", () => scenarioList],
  ] as const) {
    it(`${name} names every MANIFEST_KEYS member AND no other bucket's`, () => {
      const missing = MANIFEST_KEYS.filter((k) => !list().includes(`\`${k}\``));
      expect(missing, `${name} omits: ${missing.join(", ")}`).toEqual([]);
      const wrong = OTHER_BUCKETS.filter((k) => list().includes(`\`${k}\``));
      expect(wrong, `${name} lists these, which are not manifest keys: ${wrong.join(", ")}`).toEqual([]);
    });
  }

  // A count written into either passage. Neither passage needs one, and once neither carries one the
  // passage check below is vacuous by design — keep it anyway: it exists to catch a count being
  // reintroduced ("all seven" and "five need the manifest" once sat next to a list of eight). Do not "fix"
  // it for never firing. The only count it can verify is the total, computed from the constant, so any
  // other number in these forms fails too: name the keys instead of counting them.
  const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
  const wrongCounts = (text: string): string[] => {
    const ok = [NUMBER_WORDS[MANIFEST_KEYS.length], String(MANIFEST_KEYS.length)];
    const forms = /\b(?:all (\w+)|(?<!\b(?:every|each|any) )(\w+) (?:need|needs|are|of these|of them)\b)/gi;
    return [...text.matchAll(forms)]
      .filter((m) => {
        const word = (m[1] ?? m[2]).toLowerCase();
        return (NUMBER_WORDS.includes(word) || /^\d+$/.test(word)) && !ok.includes(word);
      })
      .map((m) => m[0]);
  };

  it("the count matcher catches each count form (a dead matcher would pass everything)", () => {
    expect(wrongCounts("Without a manifest, all seven are skipped — five need the manifest.")).toEqual(["all seven", "five need"]);
    expect(wrongCounts("six of these read the body, and two are gated; 3 need it")).toEqual(["six of these", "two are", "3 need"]);
    expect(wrongCounts(`all ${NUMBER_WORDS[MANIFEST_KEYS.length]} are skipped; every one of these is a key`)).toEqual([]);
  });

  it("a filesystem-assertion passage that counts the keys counts MANIFEST_KEYS", () => {
    for (const passage of [fsParagraph, scenarioParagraph])
      expect(wrongCounts(passage), `MANIFEST_KEYS has ${MANIFEST_KEYS.length}; name the keys rather than counting them`).toEqual([]);
  });

  it("scenario.py's scaffold does not file a manifest-backed key under its LIVE-only heading", () => {
    // Self-consistency: `scenario.py` declares its own MANIFEST_KEYS set, and the scaffold must agree
    // with it. Parsed from the file so the check cannot drift from the set it is checking against.
    const declared = section(scenarioPy, "MANIFEST_KEYS = {", /\n}/);
    const pyManifestKeys = new Set([...declared.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]));
    expect(pyManifestKeys.size, "could not parse scenario.py's MANIFEST_KEYS").toBeGreaterThan(5);

    // Resolve key -> list variable -> the heading that variable is emitted under, rather than looking
    // for the key's literal text near the heading. The literal lives in the list-BUILDING block, far
    // from the heading, so a proximity check answers a different question: it happens to catch the
    // historical defect and stays GREEN when the two lists are merged behind one `L.extend(...)`,
    // which is the same misclassification reached by a refactor. Measured — that variant passed a
    // proximity check while the scaffold really did emit `file_exists` under the LIVE-only heading.
    const varOfKey = new Map<string, string>();
    for (const m of scenarioPy.matchAll(/(\w+)\.append\(f?"\s{2}- ([a-z_]+):/g)) varOfKey.set(m[2], m[1]);
    expect(varOfKey.size, 'parsed no `<var>.append("  - <key>:")` lines — the scaffold was restructured').toBeGreaterThan(4);

    // Walk the emit block: each `L.append("  # --- <heading> ---")` owns the `L.extend(<var>)` calls
    // that follow it, until the next heading.
    const liveVars = new Set<string>();
    let currentHeading: string | undefined;
    for (const line of scenarioPy.split("\n")) {
      const h = /L\.append\("\s*# --- (.+?) ---"\)/.exec(line);
      if (h) {
        currentHeading = h[1];
        continue;
      }
      const e = /L\.extend\((\w+)\)/.exec(line);
      if (e && currentHeading && /LIVE-only/i.test(currentHeading)) liveVars.add(e[1]);
    }
    expect(liveVars.size, "no list is emitted under a LIVE-only heading — the emit block was restructured").toBeGreaterThan(0);

    const misfiled = [...varOfKey].filter(([k, v]) => liveVars.has(v) && pyManifestKeys.has(k)).map(([k]) => k);
    expect(
      misfiled,
      `scenario.py's scaffold emits these under a "LIVE-only (skipped on replay)" heading while its own ` +
        `MANIFEST_KEYS says they replay from an artifacts manifest: ${misfiled.join(", ")}`,
    ).toEqual([]);
  });
});
