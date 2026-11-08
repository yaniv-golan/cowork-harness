import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

// A behaviour change leaves prose behind that still describes the old behaviour. Each change adds what it retired to
// test/fixtures/retired-phrases.json, and this fails on any return of those words in a tracked text file. A hit that
// is meant to stay gets an allowlist entry with its reason. A phrase wrapped across comment-prefixed lines (`// `) is not
// matched; one wrapped across plain lines is.

interface Phrase {
  phrase: string;
  reason: string;
}
interface Allowed extends Phrase {
  file: string;
}
const FIXTURE = "test/fixtures/retired-phrases.json";
const { phrases, allowlist } = JSON.parse(readFileSync(FIXTURE, "utf8")) as { phrases: Phrase[]; allowlist: Allowed[] };

/** Past release notes describe old behaviour on purpose; vendored code is not ours to reword; the fixture is the list. */
function isExcluded(file: string): boolean {
  return /(^|\/)_vendor\//.test(file) || file === "CHANGELOG.md" || file === FIXTURE;
}

/** Whole phrase, case-insensitive, and across line wrapping. */
function matcher(phrase: string): RegExp {
  const words = phrase
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&"));
  return new RegExp(`(?<![A-Za-z0-9_-])${words.join("\\s+")}(?![A-Za-z0-9_-])`, "i");
}

// Git only lists the text files; the matching is done here.
const tracked = execFileSync("git", ["grep", "-I", "-l", "", "--", "."], { encoding: "utf8", maxBuffer: 2 ** 26 })
  .split("\n")
  .filter((f) => f !== "" && existsSync(f));
const contents = new Map(tracked.filter((f) => !isExcluded(f)).map((f) => [f, readFileSync(f, "utf8")]));

describe("retired phrases", () => {
  it("has phrases, each with a reason, and read a non-trivial number of files", () => {
    expect(phrases.length).toBeGreaterThan(0);
    for (const p of phrases) expect(p.reason.trim(), p.phrase).not.toBe("");
    for (const a of allowlist) expect(a.reason.trim(), `${a.phrase} in ${a.file}`).not.toBe("");
    expect(contents.size).toBeGreaterThan(500);
  });

  it.each(phrases.map((p) => p.phrase))("%s appears nowhere it is not allowlisted", (phrase) => {
    const re = matcher(phrase);
    const allowed = new Set(allowlist.filter((a) => a.phrase === phrase).map((a) => a.file));
    const hits = [...contents].filter(([file, text]) => re.test(text) && !allowed.has(file)).map(([file]) => file);
    expect(hits).toEqual([]);
  });

  it.each(allowlist.map((a) => [a.phrase, a.file] as const))("the allowlist entry for %s in %s still matches", (phrase, file) => {
    expect(
      phrases.map((p) => p.phrase),
      "an allowlist entry for a phrase not on the list",
    ).toContain(phrase);
    expect(contents.has(file), `${file} is not scanned`).toBe(true);
    expect(matcher(phrase).test(contents.get(file)!), `${phrase} no longer appears in ${file}`).toBe(true);
  });

  it("leaves out exactly the release notes, vendored code and the list itself", () => {
    expect(isExcluded("CHANGELOG.md")).toBe(true);
    expect(isExcluded(FIXTURE)).toBe(true);
    expect(isExcluded("python/pkg/_vendor/x.py")).toBe(true);
    expect(isExcluded(".claude/skills/cowork-harness/scripts/_vendor/x.py")).toBe(true);
    expect(isExcluded("docs/CHANGELOG.md")).toBe(false);
    expect(isExcluded("src/vendor.ts")).toBe(false);
    // A new vendored directory should be a conscious addition to this exclusion.
    expect([
      ...new Set(tracked.filter((f) => /(^|\/)_vendor\//.test(f)).map((f) => f.slice(0, f.indexOf("_vendor/") + "_vendor".length))),
    ]).toEqual([".claude/skills/cowork-harness/scripts/_vendor"]);
    expect(tracked).toContain("CHANGELOG.md");
  });

  it("matches a whole phrase across a line wrap, in any case, and not inside a longer word", () => {
    const re = matcher("alpha beta gamma");
    expect(re.test("there is Alpha Beta\n  Gamma here")).toBe(true);
    expect(re.test("alpha beta gammas")).toBe(false);
    expect(re.test("x-alpha beta gamma")).toBe(false);
  });

  it("lists text files without any git regex, so that a pattern cannot silently match nothing", () => {
    const source = readFileSync("test/retired-phrases.test.ts", "utf8");
    expect(source).toContain(`execFileSync("git", ["grep", "-I", "-l", "", "--", "."]`);
    expect(source).not.toMatch(/\["grep", "-[EGP]"/);
  });
});
