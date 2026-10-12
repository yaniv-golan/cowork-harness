import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureOrgAt, orgRef, readCaptureOrg, checkCaptureOrg } from "../src/sync/capture-org.js";
import { CaptureOrg } from "../src/types.js";

const A = "11111111-2222-3333-4444-555555555555";
const B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const at = (hh: string) => new Date(2026, 9, 12, +hh.slice(0, 2), +hh.slice(3, 5), +hh.slice(6, 8)).getTime();
// Line shapes measured in Desktop 2.31226.1's main.log (2026-10-12); ids invented.
const log = [
  `2026-10-12 08:36:53 [info] [oauth-v2] using cached token for orgId=${A}`,
  `2026-10-12 09:12:06 [info] [LocalSessionManager] Org changed from ${A} to ${B}, reinitializing sessions`,
  `2026-10-12 09:12:07 [info] [oauth-v2] using cached token for orgId=${B}`,
];

describe("captureOrgAt", () => {
  it("is the org the newest org-naming entry at or before the moment names", () => {
    expect(captureOrgAt(log, at("09:00:00"))).toBe(A);
    expect(captureOrgAt(log, at("09:12:06"))).toBe(B); // the change line names the NEW org
    expect(captureOrgAt(log, at("10:00:00"))).toBe(B);
  });
  it("is null before any entry, and ignores lines that name no org", () => {
    expect(captureOrgAt(log, at("08:00:00"))).toBeNull();
    expect(captureOrgAt(["2026-10-12 09:00:00 [info] something else orgId=not-a-uuid"], at("10:00:00"))).toBeNull();
  });
});

describe("orgRef", () => {
  it("is a short one-way hash, never the id", () => {
    expect(orgRef(A)).toMatch(/^[0-9a-f]{12}$/);
    expect(orgRef(A)).not.toBe(orgRef(B));
    expect(orgRef(A)).not.toContain("1111");
  });
});

describe("readCaptureOrg", () => {
  it("reads the rotated logs and records only the hash", () => {
    const dir = mkdtempSync(join(tmpdir(), "cwh-org-"));
    writeFileSync(join(dir, "main1.log"), log[0] + "\n");
    writeFileSync(join(dir, "main.log"), log.slice(1).join("\n") + "\n");
    const r = readCaptureOrg(dir, at("09:12:09"));
    expect(r).toEqual({ orgId: B, record: { observed: true, orgRef: orgRef(B) } });
    expect(CaptureOrg.safeParse(r.record).success).toBe(true);
    expect(JSON.stringify(r.record)).not.toContain(B);
  });
  it("is unobserved when any log file it reaches is unreadable (that file could hold the switch)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cwh-org-"));
    writeFileSync(join(dir, "main1.log"), log[0] + "\n");
    mkdirSync(join(dir, "main.log")); // a directory where the newest log should be: unreadable as a file
    expect(readCaptureOrg(dir, at("09:12:09"))).toEqual({ orgId: null, record: { observed: false } });
  });
  it("is unobserved with no logs or no org entry before the moment", () => {
    expect(readCaptureOrg(join(tmpdir(), "cwh-org-none"), at("10:00:00"))).toEqual({ orgId: null, record: { observed: false } });
    expect(readCaptureOrg(mkdtempSync(join(tmpdir(), "cwh-org-")), at("10:00:00"))).toEqual({ orgId: null, record: { observed: false } });
  });
});

describe("checkCaptureOrg — the write gate", () => {
  const prev = { observed: true as const, orgRef: orgRef(A) };
  it("passes the same org, and records a first capture with a note", () => {
    expect(checkCaptureOrg(prev, { observed: true, orgRef: orgRef(A) }, false)).toEqual({ refuse: null, notes: [] });
    const first = checkCaptureOrg(undefined, { observed: true, orgRef: orgRef(A) }, false);
    expect(first.refuse).toBeNull();
    expect(first.notes.join("\n")).toMatch(/first/);
  });
  it("refuses a different org, or an unobserved one when the previous baseline recorded one", () => {
    expect(checkCaptureOrg(prev, { observed: true, orgRef: orgRef(B) }, false).refuse).toMatch(/different org/);
    expect(checkCaptureOrg(prev, { observed: false }, false).refuse).toMatch(/cannot tell/);
  });
  it("the override turns either refusal into a warning", () => {
    for (const now of [{ observed: true as const, orgRef: orgRef(B) }, { observed: false as const }]) {
      const r = checkCaptureOrg(prev, now, true);
      expect(r.refuse).toBeNull();
      expect(r.notes.join("\n")).toMatch(/WARNING/);
    }
  });
  it("an unobserved org with no previous capture is a note, not a refusal", () => {
    const r = checkCaptureOrg(undefined, { observed: false }, false);
    expect(r.refuse).toBeNull();
    expect(r.notes.join("\n")).toMatch(/not recorded/);
  });
});

describe("sync wiring (source text): the capture-org check refuses the write", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf8");
  it("calls checkCaptureOrg with the previous baseline's record and the override flag, and fails on a refusal", () => {
    expect(cli).toMatch(
      /checkCaptureOrg\(prevOrg\.success \? prevOrg\.data : undefined, res\.captureOrg, !!syncParsed\.flags\["--allow-org-change"\]\)/,
    );
    expect(cli).toMatch(/if \(org\.refuse\) return fail\("sync"/);
    expect(cli).toMatch(/captureOrg: res\.captureOrg,/);
  });
  it("the check runs before the baseline is written", () => {
    expect(cli.indexOf("checkCaptureOrg(prevOrg")).toBeLessThan(cli.indexOf("writeFileSync(baselinePath"));
  });
});
