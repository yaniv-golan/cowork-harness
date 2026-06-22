import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFingerprint, checkStaleness, type Cassette } from "../src/run/cassette.js";

// L1 INVARIANT (staleness redesign, Phase A): record → verify the SAME tree ⇒ GREEN, and an out-of-band
// OS-junk touch must NOT re-stale (the H9 fix). This is the durable backstop: if any future change makes a
// freshly-recorded cassette report stale, or makes a .DS_Store drift count, this test fails.

function skillTree(): { root: string; session: string; pluginDir: string } {
  const root = mkdtempSync(join(tmpdir(), "stale-"));
  const pluginDir = join(root, "plugin");
  mkdirSync(join(pluginDir, "skills", "cap-table"), { recursive: true });
  writeFileSync(join(pluginDir, "skills", "cap-table", "SKILL.md"), "# cap-table skill\n");
  const session = join(root, "session.yaml");
  writeFileSync(session, "skills:\n  local: [./plugin]\n");
  return { root, session, pluginDir };
}

const cassetteFor = (fp: ReturnType<typeof buildFingerprint>, skills?: string[]): Cassette =>
  ({ fingerprint: fp, cassetteVersion: 99, scenario: { session: "session.yaml", skills, name: "t" } }) as unknown as Cassette;

describe("staleness round-trip invariant (L1)", () => {
  it("record → verify the unchanged tree ⇒ GREEN (no staleness messages)", () => {
    const { root, session } = skillTree();
    const fp = buildFingerprint(session, "1.14271.0", root);
    expect(checkStaleness(cassetteFor(fp), root)).toEqual([]); // unchanged ⇒ fresh
  });

  it("H9 — an OS-junk touch (.DS_Store created, then rewritten) does NOT re-stale", () => {
    const { root, session, pluginDir } = skillTree();
    const fp = buildFingerprint(session, "1.14271.0", root);
    // Finder writes a .DS_Store after record…
    writeFileSync(join(pluginDir, ".DS_Store"), "\x00\x01finder");
    expect(checkStaleness(cassetteFor(fp), root)).toEqual([]); // still fresh — the H9 fix
    // …and rewrites it later (icon moved)
    writeFileSync(join(pluginDir, ".DS_Store"), "\x00\x02finder-moved");
    expect(checkStaleness(cassetteFor(fp), root)).toEqual([]); // still fresh
  });

  it("a REAL source change still re-stales (the fix didn't weaken detection)", () => {
    const { root, session, pluginDir } = skillTree();
    const fp = buildFingerprint(session, "1.14271.0", root);
    writeFileSync(join(pluginDir, "skills", "cap-table", "SKILL.md"), "# v2 — behavior changed\n");
    const msgs = checkStaleness(cassetteFor(fp), root);
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs.join(" ")).toMatch(/changed since record/);
  });

  it("holds under F-6 skill scoping too (scoped record → scoped verify ⇒ green; OS-junk drift ⇒ green)", () => {
    const { root, session, pluginDir } = skillTree();
    const fp = buildFingerprint(session, "1.14271.0", root, ["cap-table"]);
    expect(checkStaleness(cassetteFor(fp, ["cap-table"]), root)).toEqual([]);
    writeFileSync(join(pluginDir, ".DS_Store"), "\x00\x01finder");
    writeFileSync(join(pluginDir, "skills", "cap-table", ".DS_Store"), "\x00\x01finder");
    expect(checkStaleness(cassetteFor(fp, ["cap-table"]), root)).toEqual([]); // junk drift in scope ⇒ still green
  });
});
