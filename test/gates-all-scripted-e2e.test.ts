// gates_all_scripted through the real executeScenario (protocol tier, stub agent, no model call), then verify-run over
// the kept run dir. The stub sends the AskUserQuestion frame a kept protocol-smoke run recorded
// (test/fixtures/gates-all-scripted/scripted/events.jsonl), waits for the harness's answer, then finishes.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeScenario, parseScenarioFile } from "../src/run/execute.js";
import { assertContextFromRunDir } from "../src/run/verify-context.js";
import { evaluate } from "../src/assert.js";
import { POSIX, makeStubFixture, type StubFixture } from "./helpers/stub-agent.js";

const FRAME = readFileSync(join(import.meta.dirname, "fixtures", "gates-all-scripted", "scripted", "events.jsonl"), "utf8")
  .split("\n")
  .find((l) => l.includes('"tool_name":"AskUserQuestion"'))!;
const line = (o: unknown) => `printf '%s\\n' '${JSON.stringify(o)}'`;
const SID = "44444444-4444-4444-8444-444444444444";
const STUB = [
  `echo started > "$STUB_PID"`,
  line({ type: "system", subtype: "init", session_id: SID, model: "claude-sonnet-5", tools: [], cwd: "/tmp" }),
  `printf '%s\\n' '${FRAME}'`,
  // Wait for the harness's answer to the gate, then finish the turn.
  `while IFS= read -r l; do case "$l" in *control_response*) break;; esac; done`,
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
  dir = mkdtempSync(join(tmpdir(), "gates-all-scripted-e2e-"));
  setEnv("COWORK_HARNESS_FORBID_SPAWN", "0");
  setEnv("PATH", f.env.PATH!);
  setEnv("HOME", f.env.HOME!);
  setEnv("CLAUDE_CONFIG_DIR", f.env.CLAUDE_CONFIG_DIR!);
  setEnv("COWORK_HARNESS_RUNS_DIR", f.runsDir);
  setEnv("COWORK_HARNESS_MODEL", "claude-sonnet-5");
  setEnv("STUB_PID", f.stubPidFile);
  setEnv("STUB_ENV_DUMP", f.envDump);
  setEnv("COWORK_HARNESS_GITSET", "0");
  setEnv("COWORK_MANAGED_CONFIG", "1");
  for (const k of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"])
    setEnv(k, k === "CLAUDE_CODE_OAUTH_TOKEN" ? "stub-not-a-real-token" : "");
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
  f.cleanup();
});

function scenario(name: string, lines: string[]): string {
  const p = join(dir, `${name}.yaml`);
  writeFileSync(
    p,
    [`name: ${name}`, "baseline: latest", "fidelity: protocol", "prompt: hi", ...lines, "assert:", "  - gates_all_scripted: true"].join(
      "\n",
    ) + "\n",
  );
  return p;
}

function turnResult(runDir: string): string {
  const t = join(runDir, "turns");
  return join(t, readdirSync(t)[0]!, "result.json");
}

describe.runIf(POSIX)("gates_all_scripted on the live lane and verify-run (protocol, stub agent)", () => {
  it("a scripted answer passes live, and verify-run of the kept run agrees", async () => {
    const p = scenario("scripted", ["answers:", '  - when_question: ".*"', "    choose: first"]);
    const r = await executeScenario(parseScenarioFile(p), {});
    const live = r.assertions.find((a) => a.assertion.gates_all_scripted !== undefined)!;
    expect(live.pass, live.message).toBe(true);
    const v = assertContextFromRunDir(r.outDir, parseScenarioFile(p));
    if (!v.ok) throw new Error(JSON.stringify(v));
    const [vr] = evaluate(parseScenarioFile(p).assert, v.ctx);
    expect(vr!.pass, vr!.message).toBe(true);
  }, 120_000);

  it("an `on_unanswered: first` answer fails live naming the gate, and verify-run agrees", async () => {
    const p = scenario("first", ["on_unanswered: first"]);
    const r = await executeScenario(parseScenarioFile(p), {});
    const live = r.assertions.find((a) => a.assertion.gates_all_scripted !== undefined)!;
    expect(live.pass).toBe(false);
    expect(live.message).toContain("Which output format should the note.md file use?");
    expect(live.message).toMatch(/answered by first/);
    const v = assertContextFromRunDir(r.outDir, parseScenarioFile(p));
    if (!v.ok) throw new Error(JSON.stringify(v));
    const [vr] = evaluate(parseScenarioFile(p).assert, v.ctx);
    expect(vr!.pass).toBe(false);
    expect(vr!.message).toContain("Which output format should the note.md file use?");
  }, 120_000);

  it("verify-run of a result.json with no decisions record is evidence-unavailable, not a pass", async () => {
    const p = scenario("old", ["answers:", '  - when_question: ".*"', "    choose: first"]);
    const r = await executeScenario(parseScenarioFile(p), {});
    const rj = turnResult(r.outDir);
    const { decisions: _d, ...rest } = JSON.parse(readFileSync(rj, "utf8"));
    writeFileSync(rj, JSON.stringify(rest));
    const v = assertContextFromRunDir(r.outDir, parseScenarioFile(p));
    if (!v.ok) throw new Error(JSON.stringify(v));
    const [vr] = evaluate(parseScenarioFile(p).assert, v.ctx);
    expect(vr!.pass).toBe(false);
    expect(vr!.message).toMatch(/^evidence unavailable/);
  }, 120_000);
});
