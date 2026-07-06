import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replayCassette, assertRedactionVerdictPreserved, buildFingerprint, CASSETTE_VERSION } from "../src/run/cassette.js";
import { loadBaseline } from "../src/baseline.js";

// Regression: the redaction verdict-preservation self-check (`assertRedactionVerdictPreserved`) used to
// replay the cassette with NO `cassetteDir`, so the RELOCATABLE (relative) session path could not resolve,
// `skillHash` recomputed to undefined, and every redacted record emitted a spurious
// `unverifiable-skill` staleness warning ("skill dirs not resolvable from the cassette location"). The fix
// threads `dirname(cassettePath)` through — the same dir `verify-cassettes` passes — so the skill resolves
// and no bogus warning fires.

const LIVE = loadBaseline("latest").appVersion;

const origWrite = process.stderr.write.bind(process.stderr);
afterEach(() => {
  process.stderr.write = origWrite;
});
function captureStderr(): { get: () => string } {
  let buf = "";
  process.stderr.write = ((s: string | Uint8Array) => {
    buf += typeof s === "string" ? s : Buffer.from(s).toString();
    return true;
  }) as typeof process.stderr.write;
  return { get: () => buf };
}

const okEvents = () => [
  JSON.stringify({ type: "system", subtype: "init", tools: [] }),
  JSON.stringify({ type: "result", subtype: "success", is_error: false }),
];

/** A cassette whose session path is RELATIVE (relocatable, as record writes it) and whose fingerprint
 *  carries a real skillHash — resolvable only when the correct cassetteDir is supplied. */
function relocatableCassetteWithSkill(): { cassette: any; cassetteDir: string } {
  const cassetteDir = mkdtempSync(join(tmpdir(), "cwh-selfcheck-"));
  const skillDir = join(cassetteDir, "myskill");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# myskill\ncontent\n");
  writeFileSync(join(cassetteDir, "session.yaml"), "skills:\n  local:\n    - ./myskill\n");
  // Recorded fingerprint is computed with the resolved (correct) dir — exactly what record does.
  const fingerprint = buildFingerprint("session.yaml", LIVE, cassetteDir);
  expect(fingerprint.skillHash).toMatch(/^[0-9a-f]{64}$/); // sanity: the skill IS hashable
  const cassette = {
    scenario: {
      name: "c",
      baseline: "latest",
      session: "session.yaml", // RELATIVE — the relocatable form
      fidelity: "container",
      prompt: "hi",
      answers: [],
      expect_denied: [],
      assert: [{ result: "success" }],
    },
    events: okEvents(),
    controlOut: [],
    fingerprint,
    cassetteVersion: CASSETTE_VERSION,
  } as any;
  return { cassette, cassetteDir };
}

describe("redaction self-check does not emit a spurious skill-staleness warning", () => {
  it("replayCassette resolves the skill when cassetteDir is passed, and only then", async () => {
    const { cassette, cassetteDir } = relocatableCassetteWithSkill();
    captureStderr();

    // With the correct dir: the relative session resolves, skillHash recomputes and matches → no finding.
    const withDir = await replayCassette(cassette, [], { cassetteDir });
    expect(withDir.staleness?.some((s) => s.class === "unverifiable-skill")).toBeFalsy();

    // Without it (the old self-check behavior): the relative path can't resolve → unverifiable-skill.
    // This is what makes the fix load-bearing — if someone drops the arg again, this asymmetry returns.
    const withoutDir = await replayCassette(cassette, [], {});
    expect(withoutDir.staleness?.some((s) => s.class === "unverifiable-skill")).toBe(true);
  });

  it("assertRedactionVerdictPreserved emits no `unverifiable-skill` warning when given the cassette dir", async () => {
    const { cassette, cassetteDir } = relocatableCassetteWithSkill();
    const cap = captureStderr();
    // base === redacted ⇒ verdicts trivially match (no throw); we only care about the staleness noise.
    await assertRedactionVerdictPreserved(cassette, cassette, cassetteDir);
    const out = cap.get();
    expect(out).not.toMatch(/unverifiable-skill|skill dirs not resolvable/);
  });
});
