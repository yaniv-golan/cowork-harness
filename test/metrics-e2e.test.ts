// Scenario metrics through the real executeScenario at the protocol tier with a stub agent (no model call): the
// declaration arms the pre-run manifest on its own, a fixture file the run left alone or rewrote with identical
// bytes is pre_run, a file staged outside the walked roots is pre_run, lane remote is remote, and the key is absent
// when nothing is declared (an empty list included) and on a partial run. Synthetic data only.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv from "ajv";
import { spawnSync } from "node:child_process";
import { executeScenario, parseScenarioFile } from "../src/run/execute.js";
import { POSIX, QUESTION_FRAME, makeStubFixture, type StubFixture } from "./helpers/stub-agent.js";

const line = (o: unknown) => `printf '%s\\n' '${JSON.stringify(o)}'`;
const SID = "33333333-3333-4333-8333-333333333333";
// The stub runs one of a few scripted actions (named in $STUB_MODE), then reports success.
const STUB = [
  `echo started > "$STUB_PID"`,
  `MODE="$(cat "$STUB_MODE")"`,
  `if [ "$MODE" = write ]; then printf '{"words": 1200}' > outputs/m.json; fi`,
  `if [ "$MODE" = fixture ]; then printf '{"n": 2}' > outputs/new.json; printf '{"n": 22}' > outputs/changed.json; cp outputs/same.json outputs/same.tmp; mv outputs/same.tmp outputs/same.json; fi`,
  `if [ "$MODE" = ask ]; then printf '%s\\n' '${QUESTION_FRAME}'; exec sleep 300; fi`,
  `find . -name score.json > "$STUB_FOUND" 2>/dev/null`,
  line({ type: "system", subtype: "init", session_id: SID, model: "claude-sonnet-5", tools: [], cwd: "/tmp" }),
  line({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: SID, num_turns: 1 }),
  "cat >/dev/null",
].join("\n");

let f: StubFixture;
let dir: string;
const saved: Record<string, string | undefined> = {};
function setEnv(k: string, v: string): void {
  if (!(k in saved)) saved[k] = process.env[k];
  process.env[k] = v;
}
beforeEach(() => {
  f = makeStubFixture(STUB);
  dir = mkdtempSync(join(tmpdir(), "metrics-e2e-"));
  setEnv("COWORK_HARNESS_FORBID_SPAWN", "0");
  setEnv("PATH", f.env.PATH!);
  setEnv("HOME", f.env.HOME!);
  setEnv("CLAUDE_CONFIG_DIR", f.env.CLAUDE_CONFIG_DIR!);
  setEnv("COWORK_HARNESS_RUNS_DIR", f.runsDir);
  setEnv("COWORK_HARNESS_MODEL", "claude-sonnet-5");
  setEnv("STUB_PID", f.stubPidFile);
  setEnv("STUB_ENV_DUMP", f.envDump);
  setEnv("STUB_MODE", join(dir, "mode"));
  setEnv("STUB_FOUND", join(dir, "found"));
  setEnv("COWORK_HARNESS_GITSET", "0");
  setEnv("COWORK_MANAGED_CONFIG", "1");
  for (const k of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"])
    setEnv(k, k === "CLAUDE_CODE_OAUTH_TOKEN" ? "stub-not-a-real-token" : "");
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
  f.cleanup();
});

function scenario(name: string, mode: string, lines: string[]): string {
  writeFileSync(join(dir, "mode"), mode);
  const p = join(dir, `${name}.yaml`);
  writeFileSync(p, [`name: ${name}`, "baseline: latest", "fidelity: protocol", "prompt: hi", ...lines].join("\n") + "\n");
  return p;
}
const metric = (id: string, artifact: string, path = "n") =>
  `  - {id: ${id}, artifact: ${artifact}, path: ${path}, better: higher, scale: 100}`;
const validateRunResult = new Ajv({ strict: true }).compile(JSON.parse(readFileSync("schema/run-result.json", "utf8")));
function persisted(name: string): Record<string, unknown> {
  const found: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory() && e.name !== "work") walk(p);
      else if (e.name === "result.json" && p.includes(`${name}`)) found.push(p);
    }
  };
  walk(f.runsDir);
  expect(found, `one result.json for ${name}`).toHaveLength(1);
  return JSON.parse(readFileSync(found[0], "utf8"));
}

describe.runIf(POSIX)("scenario metrics, through the real executeScenario (protocol, stub agent)", () => {
  it("a metrics-only scenario (no fixture, no semantic or authored assert) arms the manifest and measures", async () => {
    const r = await executeScenario(
      parseScenarioFile(scenario("plain", "write", ["metrics:", metric("words", "outputs/m.json", "words")])),
      {},
    );
    expect(r.metrics).toEqual([{ id: "words", value: 1200 }]);
    const disk = persisted("plain");
    expect(disk.metrics).toEqual([{ id: "words", value: 1200 }]);
    expect(validateRunResult(disk), JSON.stringify(validateRunResult.errors)).toBe(true);
  }, 120_000);

  it("verify-run re-measures the CURRENT scenario's metrics from the kept work dir (not the live values)", async () => {
    const r = await executeScenario(
      parseScenarioFile(scenario("vr", "write", ["metrics:", metric("words", "outputs/m.json", "words")])),
      {},
    );
    expect(r.metrics).toEqual([{ id: "words", value: 1200 }]);
    const edited = scenario("vr", "write", ["metrics:", metric("again", "outputs/m.json", "words"), metric("gone", "outputs/none.json")]);
    const verify = () =>
      spawnSync(process.execPath, ["dist/cli.js", "verify-run", r.outDir, edited, "--output-format", "json"], { encoding: "utf8" });
    let v = verify();
    expect(JSON.parse(v.stdout).results[0].metrics, v.stderr).toEqual([
      { id: "again", value: 1200 },
      { id: "gone", unavailable: "missing_artifact" },
    ]);
    // The kept file edited since the run: its bytes no longer match the run's recorded hash.
    writeFileSync(join(String(r.workDir), "outputs", "m.json"), '{"words": 99999}');
    v = verify();
    expect(JSON.parse(v.stdout).results[0].metrics[0]).toEqual({ id: "again", unavailable: "pruned" });
    // A scenario with no metrics: none reported, though the live run had them.
    const none = scenario("vr", "write", []);
    v = spawnSync(process.execPath, ["dist/cli.js", "verify-run", r.outDir, none, "--output-format", "json"], { encoding: "utf8" });
    expect(JSON.parse(v.stdout).results[0]).not.toHaveProperty("metrics");
  }, 120_000);

  it("a fixture: new and rewritten are measured; untouched and rewritten-identically are pre_run", async () => {
    const fx = join(dir, "fx");
    mkdirSync(fx);
    writeFileSync(join(fx, "changed.json"), '{"n": 11}');
    writeFileSync(join(fx, "same.json"), '{"n": 33}');
    writeFileSync(join(fx, "kept.json"), '{"n": 44}');
    const p = scenario("fx", "fixture", [
      "workspace_fixture: ./fx",
      "metrics:",
      metric("fresh", "outputs/new.json"),
      metric("rewritten", "outputs/changed.json"),
      metric("identical", "outputs/same.json"),
      metric("untouched", "outputs/kept.json"),
    ]);
    const r = await executeScenario(parseScenarioFile(p), {});
    expect(r.metrics).toEqual([
      { id: "fresh", value: 2 },
      { id: "rewritten", value: 22 },
      { id: "identical", unavailable: "pre_run" },
      { id: "untouched", unavailable: "pre_run" },
    ]);
  }, 120_000);

  it("a file staged outside the walked roots before the run (a local plugin's data) is pre_run, never a value", async () => {
    const plug = join(dir, "plug");
    mkdirSync(join(plug, ".claude-plugin"), { recursive: true });
    mkdirSync(join(plug, "skills", "s"), { recursive: true });
    mkdirSync(join(plug, "data"), { recursive: true });
    writeFileSync(join(plug, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "plug", version: "1.0.0" }));
    writeFileSync(join(plug, "skills", "s", "SKILL.md"), "---\nname: s\ndescription: a stub skill\n---\nbody\n");
    writeFileSync(join(plug, "data", "score.json"), '{"score": 9}\n');
    writeFileSync(join(dir, "s.yaml"), ["plugins:", "  local_plugins:", `    - ${plug}`].join("\n") + "\n");
    await executeScenario(parseScenarioFile(scenario("probe", "none", ["session: ./s.yaml"])), {});
    const rel = readFileSync(join(dir, "found"), "utf8").trim().split("\n")[0].replace(/^\.\//, "");
    expect(rel).toMatch(/^\.local-plugins\/.*data\/score\.json$/);
    const r = await executeScenario(
      parseScenarioFile(scenario("plug", "none", ["session: ./s.yaml", "metrics:", metric("score", rel, "score")])),
      {},
    );
    expect(r.metrics).toEqual([{ id: "score", unavailable: "pre_run" }]);
  }, 120_000);

  it("lane: remote is remote, though the file is on disk", async () => {
    const r = await executeScenario(
      parseScenarioFile(scenario("remote", "write", ["lane: remote", "metrics:", metric("words", "outputs/m.json", "words")])),
      {},
    );
    expect(r.metrics).toEqual([{ id: "words", unavailable: "remote" }]);
  }, 120_000);

  it("absent when nothing is declared, and for an empty list", async () => {
    const a = await executeScenario(parseScenarioFile(scenario("none", "write", [])), {});
    expect(a.metrics).toBeUndefined();
    expect(persisted("none")).not.toHaveProperty("metrics");
    const b = await executeScenario(parseScenarioFile(scenario("empty", "write", ["metrics: []"])), {});
    expect(b.metrics).toBeUndefined();
    expect(persisted("empty")).not.toHaveProperty("metrics");
  }, 120_000);

  it("absent on a partial run (an unanswered gate)", async () => {
    await expect(
      executeScenario(parseScenarioFile(scenario("partial", "ask", ["metrics:", metric("words", "outputs/m.json", "words")])), {}),
    ).rejects.toThrow();
    const disk = persisted("partial");
    expect(disk.partial).toBe(true);
    expect(disk).not.toHaveProperty("metrics");
    expect(existsSync(join(dir, "mode"))).toBe(true);
  }, 120_000);
});
