// `agent_env.passthrough` through the real entry points: each place a run is refused before it starts (the run itself,
// the dry-run / batch pre-flight, and multi-leg's per-leg pre-flight), the Desktop-version-gated key in the derived
// refusal set, and the names recorded in result.json by a real protocol run with a stub agent (no model call).
// Synthetic data only.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeScenario, launchSourcesPreflight, loadMultiLegScenario, loadScenarioPure, parseScenarioFile } from "../src/run/execute.js";
import { loadBaseline } from "../src/baseline.js";
import { passthroughRefusalSet } from "../src/runtime/passthrough.js";
import { BACKGROUND_TASKS_ENV_KEY } from "../src/runtime/argv.js";
import { POSIX, makeStubFixture, type StubFixture } from "./helpers/stub-agent.js";

let dir: string;
const saved: Record<string, string | undefined> = {};
function setEnv(k: string, v: string | undefined): void {
  if (!(k in saved)) saved[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pt-wiring-"));
  setEnv("COWORK_HARNESS_RUNS_DIR", join(dir, "runs"));
  setEnv("COWORK_HARNESS_MODEL", "claude-sonnet-5");
  setEnv("CLAUDE_CODE_OAUTH_TOKEN", "stub-not-a-real-token");
  setEnv("ANTHROPIC_API_KEY", undefined);
  setEnv("ANTHROPIC_AUTH_TOKEN", undefined);
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, text: string) => {
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
};
const sessionWith = (names: string[]) => write("s.yaml", `agent_env:\n  passthrough: [${names.join(", ")}]\n`);

describe("the derived refusal set covers the Desktop-version-gated key", () => {
  it("a baseline below the gate still refuses the key the gate sets", () => {
    const old = loadBaseline("desktop-1.11847.5");
    expect(passthroughRefusalSet(old).has("CLAUDE_CODE_DESKTOP_APP_VERSION")).toBe(true);
    // That baseline pins no background-tasks value, so the builder emits none: the set still refuses the key it owns.
    expect(passthroughRefusalSet(old).has(BACKGROUND_TASKS_ENV_KEY)).toBe(true);
  });
});

describe("agent_env.passthrough is refused before the run, at every entry point", () => {
  it("run: a container scenario with a passthrough is refused before the run dir exists", async () => {
    sessionWith(["HTTPS_PROXY"]);
    const sc = write("t.yaml", "name: t\nbaseline: latest\nsession: ./s.yaml\nfidelity: container\nprompt: hi\n");
    await expect(executeScenario(parseScenarioFile(sc), {})).rejects.toThrow(/agent_env\.passthrough.*container/);
    expect(existsSync(join(dir, "runs"))).toBe(false);
  });

  it("the dry-run / batch pre-flight refuses it too", () => {
    sessionWith(["HTTPS_PROXY"]);
    const sc = write("t.yaml", "name: t\nbaseline: latest\nsession: ./s.yaml\nfidelity: container\nprompt: hi\n");
    expect(() => launchSourcesPreflight(loadScenarioPure(sc), "claude-sonnet-5", { quiet: true })).toThrow(/agent_env\.passthrough/);
  });

  it("multi-leg: refused before any leg runs", async () => {
    const { executeMultiLeg } = await import("../src/run/multi-leg.js");
    sessionWith(["CLAUDE_CODE_OAUTH_TOKEN"]);
    const p = write(
      "legs.yaml",
      "baseline: latest\nsession: ./s.yaml\nfidelity: protocol\nlegs:\n  - { id: a, prompt: x }\n  - { id: b, prompt: y }\n",
    );
    await expect(executeMultiLeg(loadMultiLegScenario(p))).rejects.toThrow(/agent_env\.passthrough.*credential/);
    expect(existsSync(join(dir, "runs"))).toBe(false);
  });
});

describe.runIf(POSIX)("result.json records the passthrough names (protocol, stub agent)", () => {
  const SID = "33333333-3333-4333-8333-333333333333";
  const line = (o: unknown) => `printf '%s\\n' '${JSON.stringify(o)}'`;
  let f: StubFixture;
  beforeEach(() => {
    f = makeStubFixture(
      [
        line({ type: "system", subtype: "init", session_id: SID, model: "claude-sonnet-5", tools: [], cwd: "/tmp" }),
        line({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: SID, num_turns: 1 }),
        "cat >/dev/null",
      ].join("\n"),
    );
    setEnv("COWORK_HARNESS_FORBID_SPAWN", "0");
    setEnv("PATH", f.env.PATH!);
    setEnv("HOME", f.env.HOME!);
    setEnv("CLAUDE_CONFIG_DIR", f.env.CLAUDE_CONFIG_DIR!);
    setEnv("COWORK_HARNESS_RUNS_DIR", f.runsDir);
    setEnv("STUB_PID", f.stubPidFile);
    setEnv("STUB_ENV_DUMP", f.envDump);
    setEnv("COWORK_HARNESS_GITSET", "0");
    setEnv("PT_WIRING_PROBE", "set");
  });
  afterEach(() => f.cleanup());

  it("names only, as listed; a name left unset or empty is named on stderr", async () => {
    sessionWith(["PT_WIRING_PROBE", "PT_WIRING_UNSET", "PT_WIRING_EMPTY"]);
    setEnv("PT_WIRING_UNSET", undefined);
    setEnv("PT_WIRING_EMPTY", "");
    const sc = write("t.yaml", "name: t\nbaseline: latest\nsession: ./s.yaml\nfidelity: protocol\nprompt: hi\n");
    const err: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array) => (err.push(String(c)), true));
    let r;
    try {
      r = await executeScenario(parseScenarioFile(sc), {});
    } finally {
      spy.mockRestore();
    }
    expect(err.join("")).toContain("[agent_env] passthrough: unset or empty in this environment: PT_WIRING_UNSET, PT_WIRING_EMPTY\n");
    expect(r.agentEnvPassthrough).toEqual(["PT_WIRING_PROBE", "PT_WIRING_UNSET", "PT_WIRING_EMPTY"]);
    expect(readFileSync(f.envDump, "utf8")).toMatch(/^PT_WIRING_PROBE=/m);
  });
});
