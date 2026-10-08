// `fixture export --session-paths` / `--exclude`, and the staging half: a session-path token in a committed
// fixture becomes the new session's root, as the tier's agent sees it.
import { createHash } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { exportFixture } from "../src/fixture/export.js";
import {
  asText,
  SESSION_ROOT_TOKEN,
  SESSION_TOKEN_SCHEME,
  substituteSessionTokens,
  tokenizeSessionPaths,
  VM_SESSION_ROOT_TOKEN,
} from "../src/fixture/session-tokens.js";
import {
  crossTierFixtureWarning,
  isTokenisedFileSig,
  scanWorkspaceFixture,
  stageWorkspaceFixture,
  workspaceFixtureSig,
} from "../src/fixture/workspace.js";
import { hostLoopSessionRoots } from "../src/runtime/hostloop.js";
import { listBaselineNames, loadBaseline, resolveMounts } from "../src/baseline.js";
import { loadSession, resolveLaunchSources } from "../src/session.js";
import { fixtureBinariesHashOnly } from "../src/run/cassette.js";
import { hostPathTokens } from "../src/run/host-path-tokens.js";
import { scanText } from "../src/scan.js";
import { UsageError } from "../src/errors.js";

const SID = "local_abc";
let tmp: string;
let run: string;
let outputs: string;
let hostRoot: string;
beforeEach(() => {
  vi.stubEnv("COWORK_HARNESS_GITSET", "0");
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "fixture-tokens-")));
  run = join(tmp, "runs", "scenario-x", SID);
  hostRoot = join(run, "work", "session");
  outputs = join(hostRoot, "mnt", "outputs");
  mkdirSync(outputs, { recursive: true });
  mkdirSync(join(run, "turns", "1"), { recursive: true });
  writeFileSync(join(run, "turns", "1", "result.json"), JSON.stringify({ result: "success", command: "run", outputsDir: outputs }));
  writeFileSync(join(run, "mounts.json"), JSON.stringify({ v: 1, sessionId: SID, effectiveFidelity: "hostloop", outputsHostDir: outputs }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

const out = () => join(tmp, "fixture");
const base = (over: Partial<Parameters<typeof exportFixture>[0]> = {}) => ({
  runDir: run,
  out: out(),
  allowHostPaths: false,
  secrets: [] as string[],
  ...over,
});
const put = (rel: string, data: string | Buffer) => {
  mkdirSync(dirname(join(outputs, rel)), { recursive: true });
  writeFileSync(join(outputs, rel), data);
};
const got = (rel: string) => readFileSync(join(out(), rel), "utf8");

/** The deck-review shape: the file tools' host view and bash's guest view of the same session. */
function deckReviewShape(): void {
  put("artifacts/.host-outputs-dir.json", JSON.stringify({ host_outputs_dir: outputs }));
  put("artifacts/.host-outputs-probe", outputs);
  put("artifacts/report.json", JSON.stringify({ report: `/sessions/${SID}/mnt/outputs/artifacts/report.md`, n: 3 }));
  put("artifacts/run_status.json", `{"plugin":"/sessions/${SID}/mnt/.local-plugins/marketplaces/m/p/x.json"}`);
  put("plain.md", "# no paths here\n");
}

describe("fixture export --session-paths", () => {
  it("default export still refuses a session path as run_path, and names --session-paths as the remedy", () => {
    deckReviewShape();
    const r = exportFixture(base());
    expect(r.exitCode).toBe(2);
    expect(r.refused.map((f) => f.file).sort()).toEqual([
      "artifacts/.host-outputs-dir.json",
      "artifacts/.host-outputs-probe",
      "artifacts/report.json",
      "artifacts/run_status.json",
    ]);
    expect(r.refused.every((f) => f.kind === "run_path")).toBe(true);
    expect(r.message).toContain("--session-paths");
    expect(r.substituted).toBeUndefined();
  });

  it("tokenises both views of THIS session and leaves every other byte alone", () => {
    deckReviewShape();
    const r = exportFixture(base({ sessionPaths: true }));
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(got("artifacts/.host-outputs-dir.json")).host_outputs_dir).toBe(`${SESSION_ROOT_TOKEN}/mnt/outputs`);
    expect(got("artifacts/.host-outputs-probe")).toBe(`${SESSION_ROOT_TOKEN}/mnt/outputs`);
    expect(JSON.parse(got("artifacts/report.json"))).toEqual({ report: `${VM_SESSION_ROOT_TOKEN}/mnt/outputs/artifacts/report.md`, n: 3 });
    expect(got("artifacts/run_status.json")).toBe(`{"plugin":"${VM_SESSION_ROOT_TOKEN}/mnt/.local-plugins/marketplaces/m/p/x.json"}`);
    expect(got("plain.md")).toBe("# no paths here\n");
    expect(r.substituted).toEqual([
      { file: "artifacts/.host-outputs-dir.json", count: 1 },
      { file: "artifacts/.host-outputs-probe", count: 1 },
      { file: "artifacts/report.json", count: 1 },
      { file: "artifacts/run_status.json", count: 1 },
    ]);
  });

  it("another session's path is not this run's: still refused", () => {
    put("other.json", `{"p":"/sessions/local_other/mnt/outputs/x"}`);
    const r = exportFixture(base({ sessionPaths: true }));
    expect(r.exitCode).toBe(2);
    expect(r.refused).toEqual([{ file: "other.json", kind: "run_path" }]);
  });

  it("a run path outside the session root (the hostloop skills dir) is still refused", () => {
    put("skills.txt", join(run, "claude-config", "skills", "x", "SKILL.md"));
    const r = exportFixture(base({ sessionPaths: true }));
    expect(r.refused).toEqual([{ file: "skills.txt", kind: "run_path" }]);
  });

  it("a host path is still refused without --allow-host-paths", () => {
    put("a.json", JSON.stringify({ o: `/sessions/${SID}/mnt/outputs/a`, h: "/Users/someone/Documents/deck.pdf" }));
    const r = exportFixture(base({ sessionPaths: true }));
    expect(r.refused).toEqual([{ file: "a.json", kind: "host_path" }]);
    expect(exportFixture(base({ sessionPaths: true, allowHostPaths: true })).exitCode).toBe(0);
  });

  it("a secret is still refused, checked on the original bytes", () => {
    put("a.txt", `/sessions/${SID}/mnt/outputs/x sk-ant-secret-value-123`);
    const r = exportFixture(base({ sessionPaths: true, secrets: ["sk-ant-secret-value-123"] }));
    expect(r.refused).toEqual([{ file: "a.txt", kind: "secret" }]);
  });

  it("a file that already holds a token is refused (text or binary) — the substitution would be ambiguous", () => {
    put("t.txt", `${VM_SESSION_ROOT_TOKEN}/mnt/outputs/x`);
    put("b.bin", Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(SESSION_ROOT_TOKEN)]));
    for (const sessionPaths of [false, true]) {
      rmSync(out(), { recursive: true, force: true });
      const r = exportFixture(base({ sessionPaths }));
      expect(r.refused.sort((a, b) => a.file.localeCompare(b.file))).toEqual([
        { file: "b.bin", kind: "token" },
        { file: "t.txt", kind: "token" },
      ]);
    }
  });

  it("a binary file is never rewritten", () => {
    const bin = Buffer.concat([Buffer.from([0, 0, 1]), Buffer.from(`/sessions/${SID}/mnt/outputs/x`)]);
    put("b.bin", bin);
    const r = exportFixture(base({ sessionPaths: true }));
    expect(r.exitCode).toBe(0);
    expect(readFileSync(join(out(), "b.bin")).equals(bin)).toBe(true);
    expect(r.substituted).toEqual([]);
  });

  it("refuses when tokenising would pull a NUL into the sniff window (staging would read it as binary)", () => {
    // The host root is longer than its token, so tokenising it shifts the NUL left, into the first 8 KiB.
    expect(hostRoot.length).toBeGreaterThan(SESSION_ROOT_TOKEN.length + 4);
    const head = Buffer.from(`${hostRoot}/mnt`);
    put("edge.txt", Buffer.concat([head, Buffer.alloc(8192 - head.length + 2, 0x61), Buffer.from([0])]));
    expect(asText(readFileSync(join(outputs, "edge.txt")))).not.toBeNull();
    expect(exportFixture(base({ sessionPaths: true })).refused).toEqual([{ file: "edge.txt", kind: "token" }]);
  });

  it("a Latin-1 file is rewritten at byte level, never re-encoded", () => {
    const latin = Buffer.concat([Buffer.from([0xe9, 0x20]), Buffer.from(`/sessions/${SID}/mnt/outputs/x`), Buffer.from([0xfc])]);
    put("l.csv", latin);
    expect(exportFixture(base({ sessionPaths: true })).exitCode).toBe(0);
    expect(
      readFileSync(join(out(), "l.csv")).equals(
        Buffer.concat([Buffer.from([0xe9, 0x20]), Buffer.from(`${VM_SESSION_ROOT_TOKEN}/mnt/outputs/x`), Buffer.from([0xfc])]),
      ),
    ).toBe(true);
  });

  it("uses the RECORDED outputs path, so a moved run dir still tokenises what its agent wrote", () => {
    deckReviewShape();
    const moved = join(tmp, "elsewhere", SID);
    mkdirSync(dirname(moved), { recursive: true });
    renameSync(run, moved);
    const r = exportFixture(base({ runDir: moved, sessionPaths: true }));
    expect(r.exitCode).toBe(0);
    expect(readFileSync(join(out(), "artifacts/.host-outputs-probe"), "utf8")).toBe(`${SESSION_ROOT_TOKEN}/mnt/outputs`);
  });

  it("refuses a protocol run (no session layout) and a run with no recorded session id", () => {
    const work = join(run, "work", "outputs");
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, "a.txt"), "x");
    writeFileSync(join(run, "turns", "1", "result.json"), JSON.stringify({ result: "success", command: "run", outputsDir: work }));
    expect(exportFixture(base({ sessionPaths: true })).message).toMatch(/protocol run .* no session layout/);
    writeFileSync(join(run, "turns", "1", "result.json"), JSON.stringify({ result: "success", command: "run", outputsDir: outputs }));
    put("a.txt", "x");
    writeFileSync(join(run, "mounts.json"), JSON.stringify({ sessionId: "../../etc" }));
    expect(exportFixture(base({ sessionPaths: true })).message).toMatch(/records no session id/);
  });
});

describe("tokenizeSessionPaths — bounded matches only", () => {
  const roots = [{ from: `/sessions/${SID}`, token: VM_SESSION_ROOT_TOKEN }];
  it.each([
    [`/sessions/${SID}x/mnt`, 0],
    [`https://h/api/sessions/${SID}/mnt`, 0],
    [`a/sessions/${SID}/mnt`, 0],
    [`/sessions/${SID}@x`, 0],
    [`"/sessions/${SID}/mnt"`, 1],
    [`/sessions/${SID}`, 1],
    [`cd /sessions/${SID}; ls /sessions/${SID}/mnt`, 2],
  ])("%s → %i", (text, n) => {
    expect(tokenizeSessionPaths(Buffer.from(text), roots).count).toBe(n);
  });
  it("replaces the longer root first", () => {
    // Listed shortest first: the order given must not decide it.
    const t = tokenizeSessionPaths(Buffer.from("/a/b/work/session/x"), [
      { from: "/a", token: VM_SESSION_ROOT_TOKEN },
      { from: "/a/b/work/session", token: SESSION_ROOT_TOKEN },
    ]);
    expect(t.data.toString()).toBe(`${SESSION_ROOT_TOKEN}/x`);
  });
  it("the path scanners never read a tokenised path as a host path", () => {
    for (const t of [
      `${SESSION_ROOT_TOKEN}/mnt/outputs`,
      `${VM_SESSION_ROOT_TOKEN}/mnt/.local-plugins/m/p`,
      `${VM_SESSION_ROOT_TOKEN}/.claude/skills`,
    ]) {
      expect(hostPathTokens(t)).toEqual([]);
      expect(scanText(t, "", []).filter((f) => f.cls === "path")).toEqual([]);
    }
  });
  it("neither token contains the other", () => {
    expect(SESSION_ROOT_TOKEN.includes(VM_SESSION_ROOT_TOKEN) || VM_SESSION_ROOT_TOKEN.includes(SESSION_ROOT_TOKEN)).toBe(false);
  });
});

describe("fixture export --exclude", () => {
  it("drops a named file or a directory, listing it as excluded", () => {
    deckReviewShape();
    const r = exportFixture(base({ exclude: ["artifacts/.host-outputs-probe", "./artifacts/run_status.json"] }));
    expect(r.refused.map((f) => f.file).sort()).toEqual(["artifacts/.host-outputs-dir.json", "artifacts/report.json"]);
    rmSync(out(), { recursive: true, force: true });
    const d = exportFixture(base({ exclude: ["artifacts/"] }));
    expect(d.exitCode).toBe(0);
    expect(d.written).toEqual(["plain.md"]);
    expect(d.skipped).toEqual([{ file: "artifacts", why: "excluded" }]);
  });
  it("an --exclude that names nothing is refused", () => {
    put("a.txt", "x");
    const r = exportFixture(base({ exclude: ["a.txt", "artifacts/typo.json"] }));
    expect(r.exitCode).toBe(2);
    expect(r.message).toMatch(/--exclude "artifacts\/typo.json" names no file/);
    expect(readdirSync(tmp)).not.toContain("fixture");
  });
});

describe("staging a tokenised fixture", () => {
  function exported(): string {
    deckReviewShape();
    expect(exportFixture(base({ sessionPaths: true })).exitCode).toBe(0);
    return out();
  }

  it("round trip: staged on hostloop as a NEW session, every path names the new run, and re-exporting reproduces the fixture", () => {
    const fx = exported();
    const scan = scanWorkspaceFixture(fx);
    expect(scan.files.filter((f) => f.tokens).map((f) => f.path)).toEqual([
      "artifacts/.host-outputs-dir.json",
      "artifacts/.host-outputs-probe",
      "artifacts/report.json",
      "artifacts/run_status.json",
    ]);
    const newSid = "local_new";
    const newRun = join(tmp, "runs", "scenario-x", newSid);
    const roots = hostLoopSessionRoots(loadBaseline("latest"), newSid, newRun);
    const newOutputs = join(roots.sessionRoot, "mnt", "outputs");
    mkdirSync(newOutputs, { recursive: true });
    expect(stageWorkspaceFixture(scan, newOutputs, roots)).toEqual({ sessionRootTokens: 2, vmSessionRootTokens: 2 });
    // The independent half: the new run's outputs dir as the run itself records it.
    expect(JSON.parse(readFileSync(join(newOutputs, "artifacts/.host-outputs-dir.json"), "utf8")).host_outputs_dir).toBe(
      join(resolve(newRun), "work", "session", "mnt", "outputs"),
    );
    expect(readFileSync(join(newOutputs, "artifacts/report.json"), "utf8")).toContain(
      `"/sessions/${newSid}/mnt/outputs/artifacts/report.md"`,
    );
    // Re-export the new run: the same fixture bytes come back.
    mkdirSync(join(newRun, "turns", "1"), { recursive: true });
    writeFileSync(join(newRun, "turns", "1", "result.json"), JSON.stringify({ result: "success", command: "run", outputsDir: newOutputs }));
    writeFileSync(join(newRun, "mounts.json"), JSON.stringify({ sessionId: newSid }));
    const again = join(tmp, "fixture2");
    expect(exportFixture(base({ runDir: newRun, out: again, sessionPaths: true })).exitCode).toBe(0);
    for (const f of scan.files) expect(readFileSync(join(again, f.path)).equals(readFileSync(join(fx, f.path)))).toBe(true);
  });

  it("container and microvm hand both tokens the guest root", () => {
    const scan = scanWorkspaceFixture(exported());
    const o = join(tmp, "ct");
    mkdirSync(o);
    const counts = stageWorkspaceFixture(scan, o, { sessionRoot: "/sessions/ct1", vmSessionRoot: "/sessions/ct1" });
    expect(readFileSync(join(o, "artifacts/.host-outputs-probe"), "utf8")).toBe("/sessions/ct1/mnt/outputs");
    expect(crossTierFixtureWarning(scan, counts)).toBeUndefined();
  });

  it("refuses to stage tokens with no roots (protocol) — never hands the agent a raw token", () => {
    const scan = scanWorkspaceFixture(exported());
    const o = join(tmp, "p");
    mkdirSync(o);
    expect(() => stageWorkspaceFixture(scan, o)).toThrow(/no session layout/);
  });

  it("refuses the protocol tier before spend, and allows the others", () => {
    const fx = exported();
    const call = (tier: "protocol" | "container") =>
      resolveLaunchSources(loadSession({}), loadBaseline("latest"), tier, false, {
        stageFilters: false,
        quiet: true,
        workspaceFixture: fx,
      });
    expect(() => call("protocol")).toThrow(UsageError);
    expect(() => call("protocol")).toThrow(/protocol tier has no session layout/);
    expect(call("container").workspaceFixture?.files.some((f) => f.tokens)).toBe(true);
  });

  it("a binary fixture file holding a token is refused at scan", () => {
    const fx = join(tmp, "fxb");
    mkdirSync(fx);
    writeFileSync(join(fx, "b.bin"), Buffer.concat([Buffer.from([0, 1]), Buffer.from(SESSION_ROOT_TOKEN)]));
    expect(() => scanWorkspaceFixture(fx)).toThrow(/is binary and holds a session-path token/);
  });

  it("refuses a root value that would break the file's syntax, and a non-ASCII root into a non-UTF-8 file", () => {
    const tok = Buffer.from(`"${SESSION_ROOT_TOKEN}"`);
    expect(() => substituteSessionTokens(tok, { sessionRoot: "/a b", vmSessionRoot: "/s" })).toThrow(/whitespace/);
    expect(() => substituteSessionTokens(tok, { sessionRoot: '/a"b', vmSessionRoot: "/s" })).toThrow(/quote/);
    expect(() => substituteSessionTokens(tok, { sessionRoot: "rel", vmSessionRoot: "/s" })).toThrow(/not an absolute path/);
    const latin = Buffer.concat([Buffer.from([0xe9]), tok]);
    expect(() => substituteSessionTokens(latin, { sessionRoot: "/Users/é", vmSessionRoot: "/s" })).toThrow(/not UTF-8/);
    expect(
      substituteSessionTokens(latin, { sessionRoot: "/Users/e", vmSessionRoot: "/s" }).equals(
        Buffer.concat([Buffer.from([0xe9]), Buffer.from('"/Users/e"')]),
      ),
    ).toBe(true);
  });

  it("warns, with the reason, when a fixture carries only the VM token (a container/microvm export) on hostloop", () => {
    const scan = scanWorkspaceFixture(exported());
    const w = crossTierFixtureWarning(scan, { sessionRootTokens: 0, vmSessionRootTokens: 3 });
    expect(w).toMatch(/one path serves both the file tools and bash/);
    expect(crossTierFixtureWarning(scan, { sessionRootTokens: 1, vmSessionRootTokens: 3 })).toBeUndefined();
    expect(crossTierFixtureWarning(scan, { sessionRootTokens: 0, vmSessionRootTokens: 0 })).toBeUndefined();
  });
});

describe("the substitution stamp in the fixture signature", () => {
  const files = [
    { path: "a.json", sha256: "a".repeat(64), exec: false },
    { path: "run.sh", sha256: "b".repeat(64), exec: true },
  ];
  it("leaves an untokenised fixture's signature exactly as before (no cassette re-record)", () => {
    const h = createHash("sha256");
    for (const f of files) h.update(`F:${f.path}\0${f.sha256}\0${f.exec ? "x" : "-"}\0`);
    expect(workspaceFixtureSig(files)).toBe(h.digest("hex"));
    expect(workspaceFixtureSig(files.map((f) => ({ ...f, tokens: false })))).toBe(workspaceFixtureSig(files));
  });
  it("a tokenised file changes the signature and carries the scheme in its per-file sig", () => {
    expect(workspaceFixtureSig([{ ...files[0]!, tokens: true }, files[1]!])).not.toBe(workspaceFixtureSig(files));
    deckReviewShape();
    expect(exportFixture(base({ sessionPaths: true })).exitCode).toBe(0);
    const scan = scanWorkspaceFixture(out());
    const sigs = new Map(scan.fileSigs);
    expect(sigs.get("artifacts/report.json")).toMatch(new RegExp(`^[0-9a-f]{64}\\+${SESSION_TOKEN_SCHEME}$`));
    expect(sigs.get("plain.md")).toMatch(/^[0-9a-f]{64}$/);
    expect(isTokenisedFileSig(sigs.get("artifacts/report.json")!)).toBe(true);
    expect(isTokenisedFileSig(sigs.get("plain.md")!)).toBe(false);
    expect(isTokenisedFileSig(`${"c".repeat(64)}+x`)).toBe(false);
  });
});

describe("record: an untouched tokenised fixture file is recorded hash-only", () => {
  it("drops the body of a session-path text file, keeps other text inline", () => {
    const entry = (path: string, sha: string) => ({ path, sha256: sha, bytes: 3, body: "abc", encoding: "utf8" as const });
    const m = fixtureBinariesHashOnly(
      [entry("outputs/a.json", "1"), entry("outputs/b.md", "2"), entry("outputs/c.json", "3")],
      ["a.json", "b.md", "c.json"],
      { "outputs/a.json": "1", "outputs/b.md": "2", "outputs/c.json": "changed" },
      ["a.json", "c.json"],
    );
    expect(m[0]).toMatchObject({ path: "outputs/a.json", truncated: true, truncationReason: "fixture" });
    expect(m[0]!.body).toBeUndefined();
    expect(m[1]!.body).toBe("abc");
    expect(m[2]!.body).toBe("abc"); // the step rewrote it: a deliverable, not fixture content
  });
});

describe("per-tier roots", () => {
  it("hostloop: the bash root is the prompt's {{vmCwd}} (resolveMounts sessionRoot) on every committed baseline", () => {
    for (const name of listBaselineNames()) {
      const b = loadBaseline(name);
      const r = hostLoopSessionRoots(b, "local_x", "/r/run");
      expect(r.vmSessionRoot, name).toBe(resolveMounts(b, "local_x").sessionRoot);
      expect(r.sessionRoot, name).toBe("/r/run/work/session");
    }
  });
});
