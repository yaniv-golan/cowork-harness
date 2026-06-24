import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFingerprint, checkStaleness, scanCassette, redactCassette, CASSETTE_VERSION, type Cassette } from "../src/run/cassette.js";
import { type RedactionPolicy } from "../src/redact.js";
import { loadBaseline } from "../src/baseline.js";

// Dynamic so a baseline bump keeps the green/exact-diff assertions stable (checkStaleness compares
// the record's baseline to loadBaseline("latest").appVersion — record AT latest).
const LIVE_BASELINE = loadBaseline("latest").appVersion;

// v5 per-file manifest (fileSigs): exact-diff staleness reporting + privacy (scan/redact of paths).

function tree(skillName = "cap-table"): { root: string; session: string; skillFile: string } {
  const root = mkdtempSync(join(tmpdir(), "manifest-"));
  mkdirSync(join(root, "plugin", "skills", skillName), { recursive: true });
  const skillFile = join(root, "plugin", "skills", skillName, "SKILL.md");
  writeFileSync(skillFile, "# skill\n");
  const session = join(root, "session.yaml");
  writeFileSync(session, "skills:\n  local: [./plugin]\n");
  return { root, session, skillFile };
}

const mkCassette = (fp: ReturnType<typeof buildFingerprint>): Cassette =>
  ({
    cassetteVersion: CASSETTE_VERSION,
    scenario: {
      name: "t",
      baseline: LIVE_BASELINE,
      session: "session.yaml",
      fidelity: "container",
      prompt: "hi",
      answers: [],
      expect_denied: [],
      assert: [],
    },
    events: [],
    fingerprint: fp,
  }) as unknown as Cassette;

describe("v5 manifest — fileSigs", () => {
  it("is populated in the fingerprint with root-relative paths (never absolute)", () => {
    const { root, session } = tree();
    const fp = buildFingerprint(session, LIVE_BASELINE, root);
    expect(fp.fileSigs).toBeDefined();
    expect(fp.fileSigs!.map(([p]) => p)).toEqual(["skills/cap-table/SKILL.md"]);
    for (const [p] of fp.fileSigs!) expect(p.startsWith("/")).toBe(false); // no host path
  });

  it("checkStaleness names the EXACT changed file from the manifest", () => {
    const { root, session, skillFile } = tree();
    const fp = buildFingerprint(session, LIVE_BASELINE, root);
    const c = mkCassette(fp);
    expect(checkStaleness(c, root)).toEqual([]); // unchanged → green
    writeFileSync(skillFile, "# skill v2\n");
    const msg = checkStaleness(c, root).join(" ");
    expect(msg).toMatch(/skill files changed/);
    expect(msg).toMatch(/1 changed/);
    expect(msg).toMatch(/skills\/cap-table\/SKILL\.md/); // the exact file
  });

  it("names added and removed files distinctly", () => {
    const { root, session } = tree();
    const fp = buildFingerprint(session, LIVE_BASELINE, root);
    const c = mkCassette(fp);
    writeFileSync(join(root, "plugin", "skills", "cap-table", "helper.py"), "x=1\n"); // add
    const msg = checkStaleness(c, root).join(" ");
    expect(msg).toMatch(/1 added/);
    expect(msg).toMatch(/helper\.py/);
  });

  it("PRIVACY — scanCassette flags a PII-class token in a fileSigs path", () => {
    const { root, session } = tree("acme.com-export"); // a skill dir whose name embeds a domain
    const fp = buildFingerprint(session, LIVE_BASELINE, root);
    const c = mkCassette(fp);
    const findings = scanCassette(c, []);
    // the domain in the manifest path is surfaced under the fingerprint.fileSigs `where` (so a review catches it)
    expect(findings.some((f) => f.where === "fingerprint.fileSigs" && f.cls === "domain")).toBe(true);
  });

  it("PRIVACY — redactCassette rewrites a customer-named fileSigs path (keeps the sha)", () => {
    const { root, session } = tree("acme-onboarding");
    const fp = buildFingerprint(session, LIVE_BASELINE, root);
    const c = mkCassette(fp);
    const recordedSha = fp.fileSigs![0][1];
    const policy: RedactionPolicy = { patterns: [{ re: /acme-onboarding/gi, label: "cust" }], keyNames: [] };
    const red = redactCassette(c, policy);
    const [p, h] = red.fingerprint!.fileSigs![0];
    expect(p).not.toMatch(/acme-onboarding/i); // path component redacted
    expect(p).toMatch(/SKILL\.md/); // structure preserved
    expect(h).toBe(recordedSha); // the content sha is untouched
  });
});
