import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  packageEvidence,
  sectionBudgetSum,
  trimToPackageCap,
  MAX_PACKAGE_BYTES,
  SKILL_CORPUS_CEILING,
  TRANSCRIPT_CAP,
  TRUNCATION_MARKER,
  ELISION_MARKER,
} from "../src/critique/package-evidence.js";
import type { TurnBoundary } from "../src/critique/evidence.js";

// Whole-corpus packaging. The design this replaced shared 8 KiB across ALL reference files, filled in
// filename-sort order: measured across 9 real consumer runs the alphabetically-first file was the sole
// survivor in 9 of 9, and 11 of 13 distinct reference files had NEVER reached an evaluator — including a
// scoring rubric a sub-agent had opened in order to do the scoring. These tests pin the properties that
// replaced it, and three of them (marked) FAIL against the pre-change code by construction.

const EMPTY_BOUNDARY: TurnBoundary = { events: { size: 0 }, timeline: { size: 0 } };

function findSection(sections: { title: string; body: string }[], startsWith: string) {
  return sections.find((s) => s.title.startsWith(startsWith));
}

function makeRunDir(transcript = "turn-1 transcript"): string {
  const runDir = mkdtempSync(join(tmpdir(), "cwh-wc-run-"));
  const turnDir = join(runDir, "turns", "1");
  mkdirSync(turnDir, { recursive: true });
  writeFileSync(
    join(turnDir, "result.json"),
    // `referencesAccessed: []` is the OBSERVED-nothing state. Its ABSENCE means "no observable tool
    // stream" and must suppress the no-access signal entirely — pinned by its own test below.
    JSON.stringify({
      finalMessage: "ok",
      referencesRead: [],
      referencesAccessed: [],
      skillActivity: [],
      toolCounts: {},
      result: "success",
    }),
  );
  writeFileSync(join(turnDir, "run.jsonl"), JSON.stringify({ t: "transcript", text: transcript }) + "\n");
  return runDir;
}

function makeSkillDir(): string {
  return mkdtempSync(join(tmpdir(), "cwh-wc-skill-"));
}

function pkgOf(runDir: string, skillDir: string) {
  return packageEvidence(runDir, EMPTY_BOUNDARY, skillDir, true, { mountRoot: skillDir });
}

describe("whole-corpus evidence packaging", () => {
  it("delivers every reference file WHOLE, including nested dirs and symlinks", () => {
    // The old walk was a single non-recursive readdirSync filtered by dirent.isFile(), which dropped
    // subdirectories AND symlinked files with no omission marker — "every reference ships" was silently
    // false for any nested layout. FAILS against the pre-change code (nested/symlinked files absent).
    const runDir = makeRunDir();
    const skillDir = makeSkillDir();
    writeFileSync(join(skillDir, "SKILL.md"), "# skill\nbody");
    mkdirSync(join(skillDir, "references", "nested"), { recursive: true });
    writeFileSync(join(skillDir, "references", "a-flat.md"), "FLAT-SENTINEL");
    writeFileSync(join(skillDir, "references", "nested", "deep.md"), "DEEP-SENTINEL");
    writeFileSync(join(skillDir, "references", "nested", "target.md"), "LINKED-SENTINEL");
    // An INTERNAL symlink — resolves inside references/, so it is legitimate skill content. A link that
    // escapes the tree is refused; that is its own test below.
    symlinkSync(join(skillDir, "references", "nested", "target.md"), join(skillDir, "references", "z-link.md"));

    const { sections } = pkgOf(runDir, skillDir);
    const content = findSection(sections, "references/ content")!.body;
    expect(content).toContain("FLAT-SENTINEL");
    expect(content).toContain("DEEP-SENTINEL");
    expect(content).toContain("LINKED-SENTINEL");
    expect(findSection(sections, "references/ available")!.body).toContain("nested/deep.md");
    expect(content).not.toContain(TRUNCATION_MARKER);

    rmSync(runDir, { recursive: true, force: true });
    rmSync(skillDir, { recursive: true, force: true });
  });

  it("packages a reference set far over the OLD 8 KiB shared budget with no cuts at all", () => {
    // The regression this whole change exists to prevent. FAILS against the pre-change code, where only
    // the alphabetically-first file survived and the rest were replaced by "(omitted — budget exhausted)".
    const runDir = makeRunDir();
    const skillDir = makeSkillDir();
    writeFileSync(join(skillDir, "SKILL.md"), "# skill\nbody");
    mkdirSync(join(skillDir, "references"), { recursive: true });
    const names = ["a-schemas.md", "b-rubric.md", "c-pitfalls.md", "d-criteria.md", "e-inputs.md"];
    for (const [i, n] of names.entries()) writeFileSync(join(skillDir, "references", n), `SENTINEL-${i}\n` + "x".repeat(20_000));

    const { sections, corpusCuts, truncated } = pkgOf(runDir, skillDir);
    const content = findSection(sections, "references/ content")!.body;
    for (const i of names.keys()) expect(content).toContain(`SENTINEL-${i}`);
    expect(content).not.toContain("(omitted");
    expect(corpusCuts).toHaveLength(0);
    expect(truncated).toBe(false);

    rmSync(runDir, { recursive: true, force: true });
    rmSync(skillDir, { recursive: true, force: true });
  });

  it("EXCLUDES untracked skill files, because the agent's mount never contained them", () => {
    // Staging delivers git-TRACKED files only (session.ts stageFilterFor). The packager used to read the
    // host dir raw, so an uncommitted reference was ABSENT from the agent's mount and PRESENT in the
    // evaluator's evidence — the agent says "the skill never explains X", the evaluator reads X, and the
    // true finding is marked `already-covered`. FAILS against the pre-change code (the untracked sentinel
    // appears in the corpus).
    const runDir = makeRunDir();
    const skillDir = makeSkillDir();
    mkdirSync(join(skillDir, "references"), { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# skill\nbody");
    writeFileSync(join(skillDir, "references", "committed.md"), "COMMITTED-SENTINEL");
    const git = (...a: string[]) => execFileSync("git", a, { cwd: skillDir, stdio: "ignore" });
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    git("add", "-A");
    git("commit", "-qm", "seed");
    // written AFTER the commit — tracked set does not contain it
    writeFileSync(join(skillDir, "references", "untracked.md"), "UNTRACKED-SENTINEL");
    writeFileSync(join(skillDir, "references", ".DS_Store"), "JUNK-SENTINEL");

    const { sections, corpusExcluded } = pkgOf(runDir, skillDir);
    const content = findSection(sections, "references/ content")!.body;
    expect(content).toContain("COMMITTED-SENTINEL");
    expect(content).not.toContain("UNTRACKED-SENTINEL");
    expect(content).not.toContain("JUNK-SENTINEL");
    expect(corpusExcluded).toContain("references/untracked.md");

    rmSync(runDir, { recursive: true, force: true });
    rmSync(skillDir, { recursive: true, force: true });
  });

  it("cuts loudly and file-by-file when the corpus ceiling is breached, and still completes", () => {
    const runDir = makeRunDir();
    const skillDir = makeSkillDir();
    mkdirSync(join(skillDir, "references"), { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# skill\n" + "s".repeat(200 * 1024));
    writeFileSync(join(skillDir, "references", "big-a.md"), "A".repeat(200 * 1024));
    writeFileSync(join(skillDir, "references", "big-b.md"), "B".repeat(200 * 1024));

    const { corpusCuts, corpusBytes, corpusCeiling, truncated, pkg } = pkgOf(runDir, skillDir);
    expect(corpusBytes).toBeGreaterThan(corpusCeiling);
    expect(truncated).toBe(true);
    expect(corpusCuts.length).toBeGreaterThan(0);
    // Every cut names its file — the whole point of "cut loudly"; the section-level trim could not do this
    // because references are one concatenated body by the time it runs.
    for (const c of corpusCuts) expect(c.name).toMatch(/SKILL\.md|references\/|agents/);
    expect(pkg.length).toBeGreaterThan(0); // the run still produces a package rather than refusing

    rmSync(runDir, { recursive: true, force: true });
    rmSync(skillDir, { recursive: true, force: true });
  });

  it("bounds the transcript head+tail, keeping BOTH ends, on code-point boundaries", () => {
    // A tail-only cut is the worst shape for a procedural skill: setup first, workflow steps LAST.
    const runDir = makeRunDir("HEAD-SENTINEL\n" + "€".repeat(TRANSCRIPT_CAP) + "\nTAIL-SENTINEL");
    const skillDir = makeSkillDir();
    writeFileSync(join(skillDir, "SKILL.md"), "# skill\nbody");

    const { sections } = pkgOf(runDir, skillDir);
    const body = findSection(sections, "Transcript")!.body;
    expect(body).toContain("HEAD-SENTINEL");
    expect(body).toContain("TAIL-SENTINEL");
    expect(body).toContain(ELISION_MARKER);
    // A naive byte slice through a 3-byte "€" yields U+FFFD at the cut; both ends must be aligned.
    expect(body).not.toContain("�");

    rmSync(runDir, { recursive: true, force: true });
    rmSync(skillDir, { recursive: true, force: true });
  });

  it("keeps the per-section budget sum under the overall cap", () => {
    // Previously asserted only in a prose comment. `sectionBudgetSum()` derives from the constants, so a
    // future budget change that inverts the relationship fails here instead of silently activating the
    // belt-and-suspenders trim on every run.
    expect(sectionBudgetSum()).toBeLessThan(MAX_PACKAGE_BYTES);
    expect(SKILL_CORPUS_CEILING).toBeLessThan(MAX_PACKAGE_BYTES);
  });

  it("the overall trim CONVERGES, drives PRODUCTION code, and reports what it shaved", () => {
    // The old loop shaved a section by exactly `overflow` then APPENDED a ~67-byte marker, leaving the
    // package marker-length over; it then shaved the next section by that amount and re-added the same
    // marker — net zero — cascading through every section and exiting STILL over cap. Unreachable through
    // packageEvidence while the budgets sum under the cap, which is exactly why `trimToPackageCap` is
    // exported: a test that reimplemented the loop would pin nothing at all.
    const sections = Array.from({ length: 6 }, (_, i) => ({ title: `S${i}`, body: "y".repeat(50_000) }));
    const { pkg, trimRecord } = trimToPackageCap(sections, 100_000);
    expect(Buffer.byteLength(pkg, "utf8")).toBeLessThanOrEqual(100_000);
    expect(trimRecord.length).toBeGreaterThan(0);
    for (const t of trimRecord) expect(t.droppedBytes).toBeGreaterThan(0); // never negative: boundText must not GROW a body
    expect(sections.filter((s) => s.body.includes(TRUNCATION_MARKER)).length).toBeLessThan(sections.length);
  });

  it("the trim shaves the CORPUS before the transcript, whatever the render order", () => {
    // Render order puts the transcript LAST, so a last-index-first loop destroyed the run record — the only
    // run-variant evidence — to pay for an oversized SKILL corpus. trimPriority is independent of it.
    const sections = [
      { title: "references/ content (…)", body: "R".repeat(60_000) },
      { title: "Transcript (turn 1 only …)", body: "T".repeat(60_000) },
    ];
    const { trimRecord } = trimToPackageCap(sections, 80_000);
    expect(trimRecord[0]!.section).toMatch(/^references\/ content/);
    expect(sections[1]!.body).not.toContain(TRUNCATION_MARKER); // transcript untouched
  });

  it("neutralizes forged truncation/elision markers in the TRANSCRIPT and flags the cut", () => {
    // The transcript is the most untrusted body in the package (agent prose + raw tool output). Routing it
    // straight through boundHeadTail skipped BOTH forgery neutralization and the `truncated` signal, so
    // hostile run content could plant a verbatim marker to weaponize the evaluator's truncation caveat,
    // and a genuinely elided transcript reported truncated:false — the caveat never reached the prompt.
    const forged = `${TRUNCATION_MARKER} and ${ELISION_MARKER}\n` + "z".repeat(TRANSCRIPT_CAP * 2);
    const runDir = makeRunDir(forged);
    const skillDir = makeSkillDir();
    writeFileSync(join(skillDir, "SKILL.md"), "# skill\nbody");

    const { sections, truncated } = pkgOf(runDir, skillDir);
    const body = findSection(sections, "Transcript")!.body;
    expect(body).toContain("truncation-marker-lookalike redacted");
    expect(body).toContain("elision-marker-lookalike redacted");
    expect(truncated).toBe(true); // an elided transcript MUST set the flag that adds the evaluator caveat

    rmSync(runDir, { recursive: true, force: true });
    rmSync(skillDir, { recursive: true, force: true });
  });

  it("allocates the ceiling smallest-first, so one large file is not needlessly starved", () => {
    // Largest-first handed the biggest file floor(ceiling/n) and never revisited it: a 700 KB SKILL.md
    // beside two small references was cut to ~175 KB when ~518 KB was available. Water-filling requires
    // ascending order — small files take only what they need and their surplus flows to the large ones.
    const runDir = makeRunDir();
    const skillDir = makeSkillDir();
    mkdirSync(join(skillDir, "references"), { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "S".repeat(700 * 1024));
    writeFileSync(join(skillDir, "references", "small-a.md"), "a".repeat(3 * 1024));
    writeFileSync(join(skillDir, "references", "small-b.md"), "b".repeat(3 * 1024));

    const { corpusCuts } = pkgOf(runDir, skillDir);
    const skillCut = corpusCuts.find((c) => c.name === "SKILL.md")!;
    // It must keep close to everything the ceiling permits, not a 1/3 share.
    expect(skillCut.keptBytes).toBeGreaterThan(SKILL_CORPUS_CEILING - 32 * 1024);
    // and the small files are untouched — they always fit under the fair share
    expect(corpusCuts.some((c) => c.name.startsWith("references/"))).toBe(false);

    rmSync(runDir, { recursive: true, force: true });
    rmSync(skillDir, { recursive: true, force: true });
  });

  it("a self-referential references symlink does not duplicate the corpus", () => {
    const runDir = makeRunDir();
    const skillDir = makeSkillDir();
    mkdirSync(join(skillDir, "references"), { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# skill\nbody");
    writeFileSync(join(skillDir, "references", "a.md"), "ONCE-SENTINEL");
    symlinkSync(join(skillDir, "references"), join(skillDir, "references", "self"));

    const { sections } = pkgOf(runDir, skillDir);
    const list = findSection(sections, "references/ available")!.body;
    expect(list.split("\n").filter((l) => l.trim())).toEqual(["a.md"]);
    const content = findSection(sections, "references/ content")!.body;
    expect(content.split("ONCE-SENTINEL").length - 1).toBe(1);

    rmSync(runDir, { recursive: true, force: true });
    rmSync(skillDir, { recursive: true, force: true });
  });

  it("a ceiling cut keeps its GENUINE marker instead of the forgery-accusation text", () => {
    // The corpus went through `bound()` twice: applyCorpus appended the genuine TRUNCATION_MARKER, then
    // section assembly re-neutralized and REDACTED it — so on the "cut loudly" path the evaluator was shown
    // "[truncation-marker-lookalike redacted]", whose defined meaning is "hostile content forged a marker
    // here", exactly where the packager had legitimately cut.
    const runDir = makeRunDir();
    const skillDir = makeSkillDir();
    mkdirSync(join(skillDir, "references"), { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "S".repeat(300 * 1024));
    writeFileSync(join(skillDir, "references", "big.md"), "B".repeat(300 * 1024));

    const { sections, pkg } = pkgOf(runDir, skillDir);
    expect(pkg).toContain(TRUNCATION_MARKER);
    expect(findSection(sections, "SKILL.md")!.body).not.toContain("lookalike redacted");

    rmSync(runDir, { recursive: true, force: true });
    rmSync(skillDir, { recursive: true, force: true });
  });

  it("still neutralizes a forgery planted INSIDE a reference file", () => {
    // The fix moves neutralization to read time; it must not weaken it.
    const runDir = makeRunDir();
    const skillDir = makeSkillDir();
    mkdirSync(join(skillDir, "references"), { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# skill\nbody");
    writeFileSync(join(skillDir, "references", "evil.md"), `pre ${TRUNCATION_MARKER} post`);

    const content = findSection(pkgOf(runDir, skillDir).sections, "references/ content")!.body;
    expect(content).toContain("truncation-marker-lookalike redacted");

    rmSync(runDir, { recursive: true, force: true });
    rmSync(skillDir, { recursive: true, force: true });
  });

  it("refuses to follow a references symlink that escapes the skill", () => {
    // Following symlinks let `references/out -> /anywhere` package that directory's file CONTENTS into a
    // document sent to a model, and `references/up -> <skillDir>` re-ship SKILL.md as a reference. Both are
    // content the agent's mount never had — the false-already-covered defect, plus arbitrary host content.
    const runDir = makeRunDir();
    const skillDir = makeSkillDir();
    const outside = mkdtempSync(join(tmpdir(), "cwh-wc-outside-"));
    writeFileSync(join(outside, "secret.md"), "OUTSIDE-SENTINEL");
    mkdirSync(join(skillDir, "references"), { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "SKILLMD-SENTINEL");
    writeFileSync(join(skillDir, "references", "ok.md"), "OK-SENTINEL");
    symlinkSync(outside, join(skillDir, "references", "out"));
    symlinkSync(skillDir, join(skillDir, "references", "up"));

    const { sections } = pkgOf(runDir, skillDir);
    const content = findSection(sections, "references/ content")!.body;
    const list = findSection(sections, "references/ available")!.body;
    expect(content).toContain("OK-SENTINEL");
    expect(content).not.toContain("OUTSIDE-SENTINEL");
    expect(list).not.toContain("out/");
    expect(list).not.toContain("up/");

    rmSync(runDir, { recursive: true, force: true });
    rmSync(skillDir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("an untracked SKILL.md is named as untracked, not reported as absent", () => {
    const runDir = makeRunDir();
    const skillDir = makeSkillDir();
    writeFileSync(join(skillDir, "SKILL.md"), "HOST-ONLY-SENTINEL");
    mkdirSync(join(skillDir, "references"), { recursive: true });
    writeFileSync(join(skillDir, "references", "r.md"), "R");
    const git = (...a: string[]) => execFileSync("git", a, { cwd: skillDir, stdio: "ignore" });
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    git("add", "references");
    git("commit", "-qm", "seed"); // SKILL.md deliberately never added

    const { sections, skillMdStatus, corpusExcluded } = pkgOf(runDir, skillDir);
    expect(skillMdStatus).toBe("untracked");
    expect(corpusExcluded).toContain("SKILL.md");
    const sec = findSection(sections, "SKILL.md")!;
    expect(sec.title).toContain("NOT delivered to the agent");
    expect(sec.body).not.toContain("no SKILL.md found"); // the old false statement
    expect(sec.body).not.toContain("HOST-ONLY-SENTINEL"); // content withheld, never graded

    rmSync(runDir, { recursive: true, force: true });
    rmSync(skillDir, { recursive: true, force: true });
  });

  it("does not emit the no-reads signal for a skill with no references at all", () => {
    const runDir = makeRunDir();
    const skillDir = makeSkillDir();
    writeFileSync(join(skillDir, "SKILL.md"), "# skill\nbody");
    expect(pkgOf(runDir, skillDir).noSkillFilesRead).toBeUndefined();
    rmSync(runDir, { recursive: true, force: true });
    rmSync(skillDir, { recursive: true, force: true });
  });

  it("neutralizes a forged marker planted in a reference FILENAME", () => {
    // The `### <name>` header is interpolated AFTER read-time neutralization, and the assembled section is
    // deliberately not re-neutralized — so a file literally named after the marker (a legal POSIX filename)
    // planted a verbatim marker in an untrusted body and could weaponize the evaluator's truncation caveat.
    const runDir = makeRunDir();
    const skillDir = makeSkillDir();
    mkdirSync(join(skillDir, "references"), { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# skill\nbody");
    writeFileSync(join(skillDir, "references", `${TRUNCATION_MARKER}.md`), "PAYLOAD-SENTINEL");

    const { sections, truncated } = pkgOf(runDir, skillDir);
    const content = findSection(sections, "references/ content")!.body;
    expect(content).toContain("truncation-marker-lookalike redacted");
    // ...and the file is still READ. Sanitizing the name at listing time instead of at render time made it
    // the `readFileSync` argument AND the git tracked-set key, so the file became unreadable (ENOENT) and
    // was mislabeled "could not be read" — content silently withheld from a perfectly readable file.
    expect(content).toContain("PAYLOAD-SENTINEL");
    expect(content).not.toContain("could not be read");
    expect(findSection(sections, "references/ available")!.body).not.toContain(TRUNCATION_MARKER);
    expect(truncated).toBe(false); // nothing was actually cut

    rmSync(runDir, { recursive: true, force: true });
    rmSync(skillDir, { recursive: true, force: true });
  });

  it("a many-reference skill is NOT flagged truncated just by its filename list", () => {
    // Content ships whole and the walk is recursive, so the name list grew — but it kept a 1 KiB cap, which
    // cut the NAMES and set `truncated`, handing the evaluator a caveat that steers claims to
    // not-adjudicable on every run, with nothing in corpusCuts/trimRecord to explain it.
    const runDir = makeRunDir();
    const skillDir = makeSkillDir();
    mkdirSync(join(skillDir, "references", "deeply", "nested"), { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# skill\nbody");
    for (let i = 0; i < 120; i++) writeFileSync(join(skillDir, "references", "deeply", "nested", `reference-file-${i}.md`), "x");

    const { truncated, corpusCuts, trimRecord } = pkgOf(runDir, skillDir);
    expect(truncated).toBe(false);
    expect(corpusCuts).toHaveLength(0);
    expect(trimRecord).toHaveLength(0);

    rmSync(runDir, { recursive: true, force: true });
    rmSync(skillDir, { recursive: true, force: true });
  });

  it("corpusCuts.keptBytes matches what was ACTUALLY shipped when the ceiling binds", () => {
    // The overhead figure was derived from PRE-cut bodies, so once the ceiling cut anything it computed to
    // 0, the section bound collapsed to exactly the ceiling with no room for the `### <path>` headers, and
    // the tail was chopped a second time — unrecorded, and through the last file's genuine marker.
    const runDir = makeRunDir();
    const skillDir = makeSkillDir();
    mkdirSync(join(skillDir, "references"), { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# skill\nbody");
    for (let i = 0; i < 30; i++) writeFileSync(join(skillDir, "references", `r${String(i).padStart(2, "0")}.md`), "z".repeat(30 * 1024));

    const { sections, corpusCuts } = pkgOf(runDir, skillDir);
    const content = findSection(sections, "references/ content")!.body;
    expect(corpusCuts.length).toBeGreaterThan(0);
    for (const c of corpusCuts.filter((x) => !x.omitted)) {
      const rel = c.name.replace(/^references\//, "");
      const start = content.indexOf(`### ${rel}\n`);
      expect(start).toBeGreaterThanOrEqual(0);
      const bodyStart = start + `### ${rel}\n`.length;
      const next = content.indexOf("\n\n### ", bodyStart);
      const shipped = Buffer.byteLength(content.slice(bodyStart, next === -1 ? undefined : next), "utf8");
      expect(shipped).toBe(c.keptBytes); // reported == delivered
    }

    rmSync(runDir, { recursive: true, force: true });
    rmSync(skillDir, { recursive: true, force: true });
  });

  it("emits the no-reads signal for a scripts-only skill", () => {
    // The predicate, report line and schema all say "references/ OR scripts/"; suppression looked only at
    // references/, so a scripts-only skill had the signal silently withheld.
    const runDir = makeRunDir();
    const skillDir = makeSkillDir();
    mkdirSync(join(skillDir, "scripts"), { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# skill\nbody");
    writeFileSync(join(skillDir, "scripts", "run.py"), "print(1)");
    expect(pkgOf(runDir, skillDir).noSkillFilesRead).toBe(true);
    rmSync(runDir, { recursive: true, force: true });
    rmSync(skillDir, { recursive: true, force: true });
  });

  it("withholds the no-access signal entirely when the run recorded NO observable tool stream", () => {
    // `referencesAccessed: []` (looked, saw nothing) and an ABSENT field (could not look) must not
    // collapse. Collapsing them turns "we could not verify" into a clean negative — the exact
    // false-green this signal exists to stop producing.
    const runDir = mkdtempSync(join(tmpdir(), "cwh-wc-run-"));
    const turnDir = join(runDir, "turns", "1");
    mkdirSync(turnDir, { recursive: true });
    writeFileSync(
      join(turnDir, "result.json"),
      JSON.stringify({ finalMessage: "ok", referencesRead: [], skillActivity: [], toolCounts: {}, result: "success" }),
    );
    writeFileSync(join(turnDir, "run.jsonl"), JSON.stringify({ t: "transcript", text: "t" }) + "\n");
    const skillDir = makeSkillDir();
    mkdirSync(join(skillDir, "references"), { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# skill\nbody");
    writeFileSync(join(skillDir, "references", "a.md"), "guidance");
    const pkg = pkgOf(runDir, skillDir);
    expect(pkg.noSkillFilesRead).toBeUndefined();
    expect(findSection(pkg.sections, "referencesAccessed")!.body).toMatch(/unavailable — this run recorded no observable tool stream/);
    rmSync(runDir, { recursive: true, force: true });
    rmSync(skillDir, { recursive: true, force: true });
  });

  it("names the CHANNEL each reference was reached through, including a Bash access the Read tool never saw", () => {
    const runDir = mkdtempSync(join(tmpdir(), "cwh-wc-run-"));
    const turnDir = join(runDir, "turns", "1");
    mkdirSync(turnDir, { recursive: true });
    writeFileSync(
      join(turnDir, "result.json"),
      JSON.stringify({
        finalMessage: "ok",
        referencesRead: [],
        referencesAccessed: [{ path: "references/env.md", via: ["bash"] }],
        subagents: [{ referencesAccessed: [{ path: "references/env.md", via: ["read"] }] }],
        skillActivity: [],
        toolCounts: {},
        result: "success",
      }),
    );
    writeFileSync(join(turnDir, "run.jsonl"), JSON.stringify({ t: "transcript", text: "t" }) + "\n");
    const skillDir = makeSkillDir();
    mkdirSync(join(skillDir, "references"), { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# skill\nbody");
    writeFileSync(join(skillDir, "references", "env.md"), "guidance");
    const pkg = pkgOf(runDir, skillDir);
    // A Bash-only access is a real access: the signal must NOT fire, even though `referencesRead` is [].
    expect(pkg.noSkillFilesRead).toBe(false);
    // Main-agent and sub-agent channels merge onto one line rather than listing the path twice.
    expect(findSection(pkg.sections, "referencesAccessed")!.body).toMatch(/references\/env\.md \(bash, read\)/);
    rmSync(runDir, { recursive: true, force: true });
    rmSync(skillDir, { recursive: true, force: true });
  });

  it("keptBytes matches shipped bytes even when the ceiling OMITS files (omission notes are overhead)", () => {
    // An omitted file returns a ~180 B note the allocator budgeted ZERO for. Counting it as body understated
    // the overhead per omission, so the section bound cut the tail a second time — files vanished header and
    // all while corpusCuts still reported bytes shipped for them, and trimRecord stayed empty.
    const runDir = makeRunDir();
    const skillDir = makeSkillDir();
    mkdirSync(join(skillDir, "references"), { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# skill\nbody");
    for (let i = 0; i < 300; i++) writeFileSync(join(skillDir, "references", `r${String(i).padStart(3, "0")}.md`), "z".repeat(3 * 1024));

    const { sections, corpusCuts } = pkgOf(runDir, skillDir);
    const content = findSection(sections, "references/ content")!.body;
    expect(corpusCuts.some((c) => c.omitted)).toBe(true); // the regime under test
    for (const c of corpusCuts.filter((x) => !x.omitted)) {
      const rel = c.name.replace(/^references\//, "");
      const start = content.indexOf(`### ${rel}\n`);
      expect(start).toBeGreaterThanOrEqual(0); // no file may vanish header-and-all
      const bodyStart = start + `### ${rel}\n`.length;
      const next = content.indexOf("\n\n### ", bodyStart);
      expect(Buffer.byteLength(content.slice(bodyStart, next === -1 ? undefined : next), "utf8")).toBe(c.keptBytes);
    }

    rmSync(runDir, { recursive: true, force: true });
    rmSync(skillDir, { recursive: true, force: true });
  });

  it("a read-heavy run is NOT flagged truncated by its referencesRead path list", () => {
    // The sibling of the filename-list cap, left rationed at 1 KiB: ~25-40 reference reads is ordinary on a
    // large tree, and it set `truncated` on every run — caveat steering claims to not-adjudicable, with
    // evidenceBudget entirely clean and nothing to explain it.
    const reads = Array.from({ length: 40 }, (_, i) => `references/deeply/nested/reference-file-${i}.md`);
    const runDir = mkdtempSync(join(tmpdir(), "cwh-wc-run-"));
    const turnDir = join(runDir, "turns", "1");
    mkdirSync(turnDir, { recursive: true });
    writeFileSync(
      join(turnDir, "result.json"),
      JSON.stringify({ finalMessage: "ok", referencesRead: reads, skillActivity: [], toolCounts: {}, result: "success" }),
    );
    writeFileSync(join(turnDir, "run.jsonl"), JSON.stringify({ t: "transcript", text: "t" }) + "\n");
    const skillDir = makeSkillDir();
    writeFileSync(join(skillDir, "SKILL.md"), "# skill\nbody");

    const r = pkgOf(runDir, skillDir);
    expect(r.truncated).toBe(false);
    expect(r.packageTruncated).toBe(false);

    rmSync(runDir, { recursive: true, force: true });
    rmSync(skillDir, { recursive: true, force: true });
  });

  it("a symlink loop under scripts/ terminates by guard, not by the OS link limit", () => {
    // hasAnyFile follows symlinks, so `scripts/self -> scripts` recurses. It previously terminated only
    // because the OS raised ELOOP ~32 levels down and the catch swallowed it — depth-limited by accident,
    // and sibling self-links branch that into 2^depth paths.
    const runDir = makeRunDir();
    const skillDir = makeSkillDir();
    writeFileSync(join(skillDir, "SKILL.md"), "# skill\nbody");
    mkdirSync(join(skillDir, "scripts", "deep"), { recursive: true });
    symlinkSync(join(skillDir, "scripts"), join(skillDir, "scripts", "a"));
    symlinkSync(join(skillDir, "scripts"), join(skillDir, "scripts", "deep", "b"));
    const t0 = Date.now();
    expect(pkgOf(runDir, skillDir).noSkillFilesRead).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(2000); // not an exponential walk
    rmSync(runDir, { recursive: true, force: true });
    rmSync(skillDir, { recursive: true, force: true });
  });

  it("an UNTRACKED scripts/ file does not trigger the no-reads signal (mount never had it)", () => {
    // The scripts leg probed the raw host dir with no tracked-set filter while the references leg used the
    // filtered list — so an uncommitted script, never delivered by staging, suppressed the signal. Two
    // fixes that each worked alone and did not compose.
    const runDir = makeRunDir();
    const skillDir = makeSkillDir();
    writeFileSync(join(skillDir, "SKILL.md"), "# skill\nbody");
    const git = (...a: string[]) => execFileSync("git", a, { cwd: skillDir, stdio: "ignore" });
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    git("add", "-A");
    git("commit", "-qm", "seed");
    mkdirSync(join(skillDir, "scripts"), { recursive: true });
    writeFileSync(join(skillDir, "scripts", "run.py"), "print(1)"); // untracked
    expect(pkgOf(runDir, skillDir).noSkillFilesRead).toBeUndefined();
    git("add", "-A");
    git("commit", "-qm", "track it");
    expect(pkgOf(runDir, skillDir).noSkillFilesRead).toBe(true); // delivered → signal is meaningful
    rmSync(runDir, { recursive: true, force: true });
    rmSync(skillDir, { recursive: true, force: true });
  });

  it("an empty scripts/ dir does not trigger the no-reads signal", () => {
    const runDir = makeRunDir();
    const skillDir = makeSkillDir();
    writeFileSync(join(skillDir, "SKILL.md"), "# skill\nbody");
    mkdirSync(join(skillDir, "scripts"), { recursive: true }); // exists, but holds nothing to read
    expect(pkgOf(runDir, skillDir).noSkillFilesRead).toBeUndefined();
    rmSync(runDir, { recursive: true, force: true });
    rmSync(skillDir, { recursive: true, force: true });
  });

  it("reports packageTruncated when the transcript is elided, with corpusCuts empty", () => {
    // The elision is the cut that actually happens on long runs, and it is what adds the evaluator's
    // truncation caveat — but no report field carried it, so an elided package looked identical to a clean
    // one and empty corpusCuts implied nothing had been cut at all.
    const runDir = makeRunDir("H\n" + "q".repeat(TRANSCRIPT_CAP * 2) + "\nT");
    const skillDir = makeSkillDir();
    writeFileSync(join(skillDir, "SKILL.md"), "# skill\nbody");
    const r = pkgOf(runDir, skillDir);
    expect(r.packageTruncated).toBe(true);
    expect(r.corpusCuts).toHaveLength(0);
    expect(r.trimRecord).toHaveLength(0);
    rmSync(runDir, { recursive: true, force: true });
    rmSync(skillDir, { recursive: true, force: true });
  });
});
