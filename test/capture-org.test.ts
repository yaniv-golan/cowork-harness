import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  captureOrgAt,
  orgRef,
  readCaptureOrg,
  checkCaptureOrg,
  readLocalOrg,
  recordCaptureOrg,
  LOCAL_ORG_RECORD,
  type LocalOrg,
} from "../src/sync/capture-org.js";
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

describe("checkCaptureOrg — the write gate compares against this machine's record", () => {
  const rA = { observed: true as const, orgRef: orgRef(A) };
  const rB = { observed: true as const, orgRef: orgRef(B) };
  const unobserved = { observed: false as const };
  const okA: LocalOrg = { state: "ok", orgRef: orgRef(A) };
  const okB: LocalOrg = { state: "ok", orgRef: orgRef(B) };
  const absent: LocalOrg = { state: "absent" };
  const corrupt: LocalOrg = { state: "corrupt" };

  it("passes the organisation this machine last synced under, silently when the baseline's matches", () => {
    expect(checkCaptureOrg(okA, rA, rA, false)).toEqual({ refuse: null, notes: [] });
  });
  it("refuses a switch on this machine, in both directions", () => {
    expect(checkCaptureOrg(okA, rA, rB, false).refuse).toMatch(/different org/);
    expect(checkCaptureOrg(okB, rB, rA, false).refuse).toMatch(/different org/);
  });
  it("refuses an unobserved capture when this machine has a record", () => {
    expect(checkCaptureOrg(okA, rA, unobserved, false).refuse).toMatch(/cannot tell/);
  });
  it("fails closed on a corrupt or unreadable record, observed capture or not", () => {
    for (const now of [rA, unobserved]) expect(checkCaptureOrg(corrupt, rA, now, false).refuse).toMatch(/record .* unreadable/);
  });
  it("the override turns every refusal into a warning", () => {
    for (const [local, now] of [
      [okA, rB],
      [okA, unobserved],
      [corrupt, rA],
      [corrupt, unobserved],
    ] as const) {
      const r = checkCaptureOrg(local, rA, now, true);
      expect(r.refuse).toBeNull();
      expect(r.notes.join("\n")).toMatch(/WARNING: captureOrg: .*--allow-org-change/);
    }
  });
  it("the first sync on a machine never refuses: same as the baseline is a note", () => {
    const r = checkCaptureOrg(absent, rA, rA, false);
    expect(r.refuse).toBeNull();
    expect(r.notes.join("\n")).toMatch(/first sync on this machine/);
    expect(r.notes.join("\n")).not.toMatch(/WARNING/);
  });
  it("the first sync on a machine under another organisation from the baseline's warns and does not refuse", () => {
    const r = checkCaptureOrg(absent, rA, rB, false);
    expect(r.refuse).toBeNull();
    expect(r.notes.join("\n")).toMatch(/WARNING: captureOrg: .*baseline/);
  });
  it("warns on every sync whose organisation differs from the baseline's, once this machine's record agrees", () => {
    const r = checkCaptureOrg(okB, rA, rB, false);
    expect(r.refuse).toBeNull();
    expect(r.notes.join("\n")).toMatch(/WARNING: captureOrg: .*baseline/);
  });
  it("the first sync with an unobserved capture is a note, not a refusal", () => {
    for (const baseline of [rA, unobserved, undefined]) {
      const r = checkCaptureOrg(absent, baseline, unobserved, false);
      expect(r.refuse).toBeNull();
      expect(r.notes.join("\n")).toMatch(/not recorded/);
    }
  });
  it("a baseline with no recorded organisation adds no baseline warning", () => {
    expect(checkCaptureOrg(okA, undefined, rA, false)).toEqual({ refuse: null, notes: [] });
  });
});

describe("this machine's record (readLocalOrg / recordCaptureOrg)", () => {
  const home = () => mkdtempSync(join(tmpdir(), "cwh-org-home-"));
  it("is absent when the file does not exist", () => {
    expect(readLocalOrg(join(home(), "sub", "sync-capture-org.json"))).toEqual({ state: "absent" });
  });
  it("records an observed capture: only the hash, 0600, in a 0700 dir it creates, and reads back", () => {
    const p = join(home(), "sub", "sync-capture-org.json");
    expect(recordCaptureOrg(p, { observed: true, orgRef: orgRef(A) })).toBeNull();
    expect(readLocalOrg(p)).toEqual({ state: "ok", orgRef: orgRef(A) });
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(p)).mode & 0o777).toBe(0o700);
    expect(readFileSync(p, "utf8")).not.toContain(A);
  });
  it("an unobserved capture never writes or resets the record", () => {
    const p = join(home(), "sync-capture-org.json");
    expect(recordCaptureOrg(p, { observed: false })).toBeNull();
    expect(existsSync(p)).toBe(false);
    recordCaptureOrg(p, { observed: true, orgRef: orgRef(A) });
    expect(recordCaptureOrg(p, { observed: false })).toBeNull();
    expect(readLocalOrg(p)).toEqual({ state: "ok", orgRef: orgRef(A) });
  });
  it("is corrupt when the file is not JSON, fails the schema, or cannot be read", () => {
    const h = home();
    writeFileSync(join(h, "bad.json"), "{not json");
    writeFileSync(join(h, "shape.json"), JSON.stringify({ orgRef: A }));
    writeFileSync(join(h, "extra.json"), JSON.stringify({ orgRef: orgRef(A), orgId: A }));
    mkdirSync(join(h, "dir.json"));
    for (const f of ["bad.json", "shape.json", "extra.json", "dir.json"]) expect(readLocalOrg(join(h, f))).toEqual({ state: "corrupt" });
  });
  it("an observed capture overwrites a corrupt record (after an override), still 0600", () => {
    const p = join(home(), "sync-capture-org.json");
    writeFileSync(p, "{not json", { mode: 0o644 });
    expect(recordCaptureOrg(p, { observed: true, orgRef: orgRef(B) })).toBeNull();
    expect(readLocalOrg(p)).toEqual({ state: "ok", orgRef: orgRef(B) });
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });
  it("a failed record write is a warning, not a throw", () => {
    const h = home();
    writeFileSync(join(h, "file"), "");
    expect(recordCaptureOrg(join(h, "file", "sync-capture-org.json"), { observed: true, orgRef: orgRef(A) })).toMatch(
      /^WARNING: captureOrg:/,
    );
  });
  it("the default record lives under ~/.cowork-harness", () => {
    expect(LOCAL_ORG_RECORD).toBe(join(homedir(), ".cowork-harness", "sync-capture-org.json"));
  });
});

describe("sync wiring (source text): the capture-org check against this machine's record", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf8");
  it("calls checkCaptureOrg with this machine's record, the previous baseline's, and the override flag, and fails on a refusal", () => {
    expect(cli).toMatch(
      /checkCaptureOrg\(\s*readLocalOrg\(LOCAL_ORG_RECORD\),\s*prevOrg\.success \? prevOrg\.data : undefined,\s*res\.captureOrg,\s*!!syncParsed\.flags\["--allow-org-change"\],?\s*\)/,
    );
    expect(cli).toMatch(/if \(org\.refuse\) return fail\("sync"/);
    expect(cli).toMatch(/captureOrg: res\.captureOrg,/);
  });
  it("the check runs before the baseline is written, and the record is updated only after it", () => {
    const write = cli.indexOf("writeFileSync(baselinePath");
    const record = cli.indexOf("recordCaptureOrg(LOCAL_ORG_RECORD, res.captureOrg)");
    expect(cli.search(/checkCaptureOrg\(\s*readLocalOrg/)).toBeGreaterThan(0);
    expect(cli.search(/checkCaptureOrg\(\s*readLocalOrg/)).toBeLessThan(write);
    expect(record).toBeGreaterThan(write);
    // inside the same `if (!diffFlag)` block: `sync --diff` never records
    expect(cli.lastIndexOf("if (!diffFlag) {", write)).toBe(cli.lastIndexOf("if (!diffFlag) {", record));
  });
});
