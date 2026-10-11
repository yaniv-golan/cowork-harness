import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActionStatus, resolveActionArgv, gradeAction, producedFiles, recordedStream } from "../src/run/host-action.js";
import { hostActionEnv } from "../src/run/host-action-runners.js";
import { buildLaunchPlan, loadSession } from "../src/session.js";
import { loadBaseline } from "../src/baseline.js";
import { SECRET_ENV_KEYS } from "../src/runtime/host-env.js";

// The host action's pure parts: the status read, the argv templating and its hardening, the grading, and the env each
// tier hands the action (the agent's own builder, minus the credentials).

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ml-action-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const put = (rel: string, body: string) => {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), body);
};

describe("readActionStatus", () => {
  it("reads a JSON object and checks expect (values and not_null)", () => {
    put("outputs/s.json", '{"status":"waiting","scripts_dir_shell":"/sessions/x/s","run_dir_shell":null}');
    expect(
      readActionStatus(dir, { artifact: "outputs/s.json", expect: { status: "waiting", scripts_dir_shell: { not_null: true } } }),
    ).toMatchObject({ ok: true });
    expect(readActionStatus(dir, { artifact: "outputs/s.json", expect: { run_dir_shell: { not_null: true } } })).toEqual({
      ok: false,
      why: 'status: outputs/s.json field "run_dir_shell" is null, expected a non-null value',
    });
    expect(readActionStatus(dir, { artifact: "outputs/s.json", expect: { status: "complete" } })).toMatchObject({
      ok: false,
      why: /expected "complete"/,
    });
  });
  it("fails on an absent, malformed, non-object or escaping status file", () => {
    put("outputs/bad.json", "{not json");
    put("outputs/arr.json", "[]");
    expect(readActionStatus(dir, { artifact: "outputs/none.json" })).toMatchObject({ ok: false, why: /absent/ });
    expect(readActionStatus(dir, { artifact: "outputs/bad.json" })).toMatchObject({ ok: false, why: /not valid JSON/ });
    expect(readActionStatus(dir, { artifact: "outputs/arr.json" })).toMatchObject({ ok: false, why: /not a JSON object/ });
    expect(readActionStatus(dir, { artifact: "../x.json" })).toMatchObject({ ok: false, why: /not a path under the work root/ });
  });
});

describe("resolveActionArgv", () => {
  const root = "/sessions/abc";
  const st = { ok: "/sessions/abc/mnt/scripts", rel: "mnt/x", flag: "-rf", up: "/sessions/abc/../etc", out: "/etc/passwd", n: 3 };
  it("substitutes string fields per element and leaves literal text alone", () => {
    expect(resolveActionArgv(["python3", "{status.ok}/apply.py", "--run", "r1"], st, root)).toEqual({
      ok: true,
      argv: ["python3", "/sessions/abc/mnt/scripts/apply.py", "--run", "r1"],
    });
  });
  const bad: Array<[string, string, RegExp]> = [
    ["a leading dash", "{status.flag}", /may not start with "-"/],
    ["a .. segment", "{status.up}", /\.\." segment/],
    ["a path outside the session root", "{status.out}", /outside the agent-visible session root/],
    ["a non-string value", "{status.n}", /not a string/],
    ["an absent field", "{status.zzz}", /absent/],
  ];
  for (const [label, el, re] of bad)
    it(`refuses ${label}`, () => {
      const r = resolveActionArgv(["tool", el], st, root);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.why).toMatch(re);
    });
  it("refuses a template with no status read, and an over-long value", () => {
    expect(resolveActionArgv(["{status.ok}"], undefined, root)).toMatchObject({ ok: false, why: /needs a `status:` read/ });
    expect(resolveActionArgv(["{status.long}"], { long: "a".repeat(5000) }, root)).toMatchObject({ ok: false, why: /longer than 4096/ });
  });
});

describe("gradeAction", () => {
  const ctx = (root: string) => ({ transcript: "", workRoot: root, effectiveFidelity: "protocol", lane: "local" }) as never;
  it("an unasserted exit code must be 0", () => {
    expect(gradeAction([], { exitCode: 1, timedOut: false }, "", ctx(dir))).toEqual([
      { assertion: { exit_code: 0 }, pass: false, message: "exited 1, expected 0 (default)" },
    ]);
    expect(gradeAction([{ exit_code: 3 }], { exitCode: 3, timedOut: false }, "", ctx(dir)).every((a) => a.pass)).toBe(true);
  });
  it("grades stdout regexes and file keys, and a timeout always fails", () => {
    put("outputs/c.json", "{}");
    const r = gradeAction(
      [{ stdout_matches: "applied \\d+" }, { stdout_not_matches: "error" }, { file_exists: "outputs/c.json" }],
      { exitCode: 0, timedOut: false },
      "applied 2 corrections",
      ctx(dir),
    );
    expect(r.map((a) => a.pass)).toEqual([true, true, true, true]);
    expect(gradeAction([], { exitCode: null, timedOut: true }, "", ctx(dir))[0]).toMatchObject({ pass: false, message: /timed out/ });
  });
  it("producedFiles lists created and changed files; recordedStream scrubs before hashing", () => {
    expect(producedFiles({ "outputs/a": "1", "outputs/b": "2" }, { "outputs/a": "1", "outputs/b": "3", "outputs/c": "4" })).toEqual([
      { path: "outputs/b", sha256: "3" },
      { path: "outputs/c", sha256: "4" },
    ]);
    expect(recordedStream("token sk-ant-SECRETVALUE here", 30, ["sk-ant-SECRETVALUE"]).head).not.toContain("SECRETVALUE");
  });
});

describe("hostActionEnv: the agent's env minus the credentials, on every tier", () => {
  it("carries no SECRET_ENV_KEYS (and on protocol no CLAUDE_CONFIG_DIR) even when the harness has them", () => {
    const saved: Record<string, string | undefined> = {};
    for (const k of [...SECRET_ENV_KEYS, "CLAUDE_CONFIG_DIR"]) {
      saved[k] = process.env[k];
      process.env[k] = k === "CLAUDE_CONFIG_DIR" ? "/operator/real/config" : "test-placeholder-not-a-credential";
    }
    try {
      const baseline = loadBaseline("latest");
      const session = loadSession({ agent_env: { artifacts_root: "artifacts" } });
      for (const tier of ["container", "microvm", "protocol"] as const) {
        const plan = buildLaunchPlan(session, baseline, join(dir, tier), tier);
        const env = hostActionEnv(tier, baseline, plan, {
          sessionId: "local_abc",
          proxyHost: "http://proxy:8080",
          outputsHost: join(dir, "outputs"),
        });
        for (const k of SECRET_ENV_KEYS) expect(env[k], `${tier} ${k}`).toBeUndefined();
        expect(env.COWORK_ARTIFACTS_ROOT, tier).toMatch(/\/outputs\/artifacts$/);
        if (tier === "protocol") expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
        else expect(env.CLAUDE_CONFIG_DIR, tier).toMatch(/\.claude$/);
      }
    } finally {
      for (const [k, v] of Object.entries(saved))
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
  });
});
