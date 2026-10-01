// `authored: true` on a file the pre-run walk never covered, through the real executeScenario at the protocol tier
// with a stub agent (no model call). The pre-run manifest walks outputs/, uploads/ and the connected folders only,
// so a file staged elsewhere under the work root before the run (here a plugin's own data file, mirrored into
// .local-plugins/) is absent from the manifest without being new. It must never read as written by the run.
// Synthetic data only.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeScenario, parseScenarioFile } from "../src/run/execute.js";
import { POSIX, makeStubFixture, type StubFixture } from "./helpers/stub-agent.js";

const line = (o: unknown) => `printf '%s\\n' '${JSON.stringify(o)}'`;
const SID = "22222222-2222-4222-8222-222222222222";
const STUB = [
  `echo started > "$STUB_PID"`,
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
  dir = mkdtempSync(join(tmpdir(), "authored-roots-"));
  setEnv("COWORK_HARNESS_FORBID_SPAWN", "0");
  setEnv("PATH", f.env.PATH!);
  setEnv("HOME", f.env.HOME!);
  setEnv("CLAUDE_CONFIG_DIR", f.env.CLAUDE_CONFIG_DIR!);
  setEnv("COWORK_HARNESS_RUNS_DIR", f.runsDir);
  setEnv("COWORK_HARNESS_MODEL", "claude-sonnet-5");
  setEnv("STUB_PID", f.stubPidFile);
  setEnv("STUB_ENV_DUMP", f.envDump);
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

/** A local plugin carrying a data file, staged into .local-plugins/ before the run. */
function pluginWithScore(root: string): string {
  const plug = join(root, "plug");
  mkdirSync(join(plug, ".claude-plugin"), { recursive: true });
  mkdirSync(join(plug, "skills", "s"), { recursive: true });
  mkdirSync(join(plug, "data"), { recursive: true });
  writeFileSync(join(plug, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "plug", version: "1.0.0" }));
  writeFileSync(join(plug, "skills", "s", "SKILL.md"), "---\nname: s\ndescription: a stub skill\n---\nbody\n");
  writeFileSync(join(plug, "data", "score.json"), '{"score": 9}\n');
  return plug;
}

describe.runIf(POSIX)("authored: true outside the walked pre-run roots (protocol, stub agent)", () => {
  it("a plugin data file staged before the run is not authored — evidence unavailable, never a pass", async () => {
    const plug = pluginWithScore(dir);
    writeFileSync(join(dir, "s.yaml"), ["plugins:", "  local_plugins:", `    - ${plug}`].join("\n") + "\n");
    // Find where staging puts it (the marketplace segment is the harness's choice), then assert on that path.
    const probe = join(dir, "probe.yaml");
    writeFileSync(probe, ["name: probe", "baseline: latest", "session: ./s.yaml", "fidelity: protocol", "prompt: hi"].join("\n") + "\n");
    await executeScenario(parseScenarioFile(probe), {});
    const rel = readFileSync(join(dir, "found"), "utf8").trim().split("\n")[0].replace(/^\.\//, "");
    expect(rel).toMatch(/^\.local-plugins\/.*data\/score\.json$/);

    const sc = join(dir, "t.yaml");
    writeFileSync(
      sc,
      [
        "name: t",
        "baseline: latest",
        "session: ./s.yaml",
        "fidelity: protocol",
        "prompt: hi",
        "assert:",
        `  - file_exists: {path: ${rel}, authored: true}`,
        `  - artifact_json: {artifact: ${rel}, path: score, authored: true}`,
      ].join("\n") + "\n",
    );
    const r = await executeScenario(parseScenarioFile(sc), {});
    expect(r.assertions).toHaveLength(2);
    for (const a of r.assertions) {
      expect(a.pass).toBe(false);
      expect(a.message).toMatch(/^evidence unavailable: .* — it is outside the folders the pre-run manifest covers/);
    }
  }, 120_000);
});
