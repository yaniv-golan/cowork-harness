import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCassette, readRerecordTarget, CASSETTE_VERSION, MIN_SUPPORTED_CASSETTE_VERSION } from "../src/run/cassette.js";
import { DEFAULT_USER_VISIBLE_ROOTS, recordedControlOut } from "./helpers/minimal-cassette.js";

function writeCassette(dir: string, body: object): string {
  const path = join(dir, "s.cassette.json");
  writeFileSync(path, JSON.stringify(body));
  return path;
}

// The v12 floor (the jcs1 hash epoch) and what a cassette must carry to load above it. Every refusal here is
// re-recordable, and says how: a below-floor cassette names its remedy by version (a 4.x `rehash` migrates v10/v11;
// nothing but a re-record helps v9 and below).
describe("cassette version floor (v12) and the replay contract", () => {
  // Matches CassetteShape (src/run/cassette.ts): top-level `events: string[]`, `scenario.prompt`/
  // `scenario.session` as strings, `scenario.assert` an array.
  const minimalScenario = { prompt: "test prompt", session: "session.yaml", assert: [] };
  const contract = { controlOut: recordedControlOut(), userVisibleRoots: [...DEFAULT_USER_VISIBLE_ROOTS] };
  const read = (body: object) => readCassette(writeCassette(mkdtempSync(join(tmpdir(), "cc-floor-")), body));

  it("the floor is v12", () => {
    expect(MIN_SUPPORTED_CASSETTE_VERSION).toBe(12);
  });

  it("v10/v11: refused, naming the 4.x rehash AND re-record", () => {
    for (const v of [10, 11]) {
      const r = read({ cassetteVersion: v, events: [], scenario: minimalScenario, ...contract });
      expect(r).toEqual({
        error: `cassette recorded at v${v} (before 2.0.0) is below the minimum supported v12 — run \`npx cowork-harness@4 rehash <dir/>\` on it, or re-record it (\`record <dir/> --rerecord-stale\`)`,
        rerecordable: true,
      });
    }
  });

  it("v9 and below: refused, naming re-record as the only remedy", () => {
    for (const v of [9, 8]) {
      const r = read({ cassetteVersion: v, events: [], scenario: minimalScenario, ...contract });
      expect(r).toEqual({
        error: `cassette recorded at v${v} (before 2.0.0) is below the minimum supported v12 — re-record it (\`record <dir/> --rerecord-stale\`); a 4.x \`rehash\` cannot migrate a v${v} cassette`,
        rerecordable: true,
      });
    }
  });

  it("rejects a cassette with no cassetteVersion field at all (reads as 0)", () => {
    expect("error" in read({ events: [], scenario: minimalScenario, ...contract })).toBe(true);
  });

  it("at the floor: loads with the contract, and is refused (re-recordable) without either field", () => {
    expect("error" in read({ cassetteVersion: 12, events: [], scenario: minimalScenario, ...contract })).toBe(false);
    const noControl = read({ cassetteVersion: 12, events: [], scenario: minimalScenario, userVisibleRoots: ["outputs"] });
    expect(noControl).toEqual({
      error: "cassette has no `controlOut` (the recorded control responses replay grades decisions against) — re-record it",
      rerecordable: true,
    });
    const noRoots = read({ cassetteVersion: 12, events: [], scenario: minimalScenario, controlOut: recordedControlOut() });
    expect(noRoots).toEqual({
      error: "cassette has no `userVisibleRoots` (the mount roots its manifest is replayed under) — re-record it",
      rerecordable: true,
    });
  });

  it("an EMPTY controlOut loads (evaluated on replay, where any decision in it fails as truncated)", () => {
    const r = read({ cassetteVersion: 12, events: [], scenario: minimalScenario, controlOut: [], userVisibleRoots: [] });
    expect("error" in r).toBe(false);
  });

  it("a NEWER cassette missing either field is too new, never re-recordable — a re-record would overwrite a newer build's file", () => {
    const v = CASSETTE_VERSION + 1;
    const tooNew = `cassette format too new: v${v} > this harness's v${CASSETTE_VERSION} — upgrade cowork-harness to read it`;
    for (const body of [
      { cassetteVersion: v, events: [], scenario: minimalScenario, userVisibleRoots: ["outputs"] },
      { cassetteVersion: v, events: [], scenario: minimalScenario, controlOut: recordedControlOut() },
    ]) {
      const dir = mkdtempSync(join(tmpdir(), "cc-floor-"));
      const path = writeCassette(dir, body);
      expect(readCassette(path)).toEqual({ error: tooNew });
      // --rerecord-stale's reader: an error it reports, not an old cassette it re-records.
      expect(readRerecordTarget(path)).toEqual({ error: tooNew });
    }
  });

  it("accepts the current cassette version", () => {
    expect("error" in read({ cassetteVersion: CASSETTE_VERSION, events: [], scenario: minimalScenario, ...contract })).toBe(false);
  });
});
