// A --resume turn of a workspace_fixture scenario, end to end through the real `executeScenario` at the protocol
// tier with a stub agent (no model call): the resume flag must reach `evaluate()`, so `authored: true` on turn 2
// fails instead of crediting turn 2 with turn 1's writes; and a resume turn that does not redeclare the fixture is
// refused with a hint that says so. Synthetic data only.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeScenario, parseScenarioFile } from "../src/run/execute.js";
import { POSIX, makeStubFixture, type StubFixture } from "./helpers/stub-agent.js";

const line = (o: unknown) => `printf '%s\\n' '${JSON.stringify(o)}'`;
const SID = "11111111-1111-4111-8111-111111111111";
const STUB = [
  `echo started > "$STUB_PID"`,
  // Turn 1 ("write"): the step writes a new file and rewrites a fixture file. Turn 2 ("noop") does nothing.
  `if [ "$(cat "$STUB_MODE")" = write ]; then echo "turn1 memo" > outputs/memo.md; echo "turn1 rewrote" > outputs/report.md; fi`,
  line({ type: "system", subtype: "init", session_id: SID, model: "claude-sonnet-5", tools: [], cwd: "/tmp" }),
  line({
    type: "assistant",
    message: { id: "m1", role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "ok" }] },
    session_id: SID,
  }),
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
  dir = mkdtempSync(join(tmpdir(), "wsfx-resume-"));
  setEnv("COWORK_HARNESS_FORBID_SPAWN", "0");
  setEnv("PATH", f.env.PATH!);
  setEnv("HOME", f.env.HOME!);
  setEnv("CLAUDE_CONFIG_DIR", f.env.CLAUDE_CONFIG_DIR!);
  setEnv("COWORK_HARNESS_RUNS_DIR", f.runsDir);
  setEnv("COWORK_HARNESS_MODEL", "claude-sonnet-5");
  setEnv("STUB_PID", f.stubPidFile);
  setEnv("STUB_ENV_DUMP", f.envDump);
  setEnv("STUB_MODE", join(dir, "mode"));
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

function write(name: string, body: string[]): string {
  const p = join(dir, name);
  writeFileSync(p, body.join("\n") + "\n");
  return p;
}

describe.runIf(POSIX)("workspace_fixture --resume, through the real executeScenario (protocol, stub agent)", () => {
  it("turn 2 does nothing: every `authored: true` fails as a --resume turn, though turn 1 wrote and rewrote the files", async () => {
    mkdirSync(join(dir, "fx"));
    writeFileSync(join(dir, "fx", "report.md"), "# step 1\n");
    const src = join(dir, "src");
    mkdirSync(src);
    writeFileSync(join(src, "f.txt"), "x");
    write("s.yaml", ["folders:", `  - from: ${src}`]);
    const head = ["name: rs", "baseline: latest", "session: ./s.yaml", "fidelity: protocol", "prompt: hi"];
    const t1 = write("t1.yaml", [
      ...head,
      "workspace_fixture: ./fx",
      "assert:",
      "  - file_exists: {path: outputs/memo.md, authored: true}",
    ]);
    writeFileSync(join(dir, "mode"), "write");
    const r1 = await executeScenario(parseScenarioFile(t1), { sessionId: "sess-r" });
    expect(r1.assertions.map((a) => a.pass)).toEqual([true]); // turn 1 did write it

    writeFileSync(join(dir, "mode"), "noop");
    const t2 = write("t2.yaml", [
      ...head,
      "workspace_fixture: ./fx",
      "assert:",
      "  - file_exists: {path: outputs/memo.md, authored: true}",
      "  - file_exists: {path: outputs/report.md, authored: true}",
      "  - artifact_text: {artifact: outputs/report.md, contains: [turn1], authored: true}",
    ]);
    const r2 = await executeScenario(parseScenarioFile(t2), { sessionId: "sess-r", resume: true });
    expect(r2.assertions).toHaveLength(3);
    for (const a of r2.assertions) {
      expect(a.pass).toBe(false);
      expect(a.message).toMatch(/--resume turn/);
    }

    // A resume turn that omits workspace_fixture is a different session origin: refused, and the hint says why.
    const t3 = write("t3.yaml", [...head, "assert:", "  - file_exists: {path: outputs/memo.md, authored: true}"]);
    await expect(executeScenario(parseScenarioFile(t3), { sessionId: "sess-r", resume: true })).rejects.toThrow(
      /must declare the same session and the same workspace_fixture/,
    );
  }, 120_000);
});
