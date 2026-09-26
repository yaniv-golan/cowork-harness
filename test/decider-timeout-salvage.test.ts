import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CLI,
  POSIX,
  QUESTION_FRAME,
  alive,
  credentialLeaks,
  exited,
  makeStubFixture,
  readPid,
  readStatus,
  runDir,
  spawnCli,
  waitFor,
  type StubFixture,
} from "./helpers/stub-agent.js";

// A decider channel that never answers (or dies) is an unanswered gate: the run must end the way every
// other unanswered gate ends — a partial result.json with a failing verdict, a clean `unanswered` error,
// exit 2 — not a raw stack trace, an `internal` error category, and no result.json at all. The stub agent
// raises one AskUserQuestion gate and waits; the scenario scripts no answer, so the gate goes to the
// external decider channel. No agent, no spend.

const can = POSIX && existsSync(CLI);
const GATE_STUB = `printf '%s\\n' '${QUESTION_FRAME}'\nexec sleep 300`;

async function runToEnd(f: StubFixture, args: string[]) {
  const cli = spawnCli(f, ["run", f.scenario, ...args]);
  const r = await exited(cli, 25_000);
  // Every run here reaches the stub; none may have handed it a credential.
  expect(credentialLeaks(f.envDump)).toEqual([]);
  return { ...r, stdout: cli.stdoutText(), stderr: cli.stderrText() };
}

function result(f: StubFixture): any {
  const d = runDir(f);
  const p = d && join(d, "turns", "1", "result.json");
  return p && existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : undefined;
}

describe.runIf(can)("a decider channel that fails to answer ends the run as an unanswered-gate partial", () => {
  // Predicted RED on the unfixed tree: exit 2 but `error.category === "internal"` and no turns/1/result.json
  // (the plain timeout Error unwinds straight to the top-level catch; status.json is "error" only because the
  // exit sweep ran, with no errorSource).
  it("--decider-cmd timeout, JSON mode: unanswered envelope, partial result.json, errorSource decider_timeout", async () => {
    const f = makeStubFixture(GATE_STUB, { COWORK_HARNESS_DECIDER_CMD_TIMEOUT_MS: "300" });
    try {
      const r = await runToEnd(f, ["--decider-cmd", "cat >/dev/null", "--output-format", "json"]);
      expect(r.code, r.stderr).toBe(2);
      const env = JSON.parse(r.stdout);
      expect(env.error?.category).toBe("unanswered");
      const res = result(f);
      expect(res, "turns/1/result.json must exist").toBeDefined();
      expect(res.partial).toBe(true);
      expect(res.result).toBe("error");
      expect(res.errorSource).toBe("decider_timeout");
      expect(res.verdict.pass).toBe(false);
      expect(res.unansweredGate.message).toMatch(/timed out/);
      const st = readStatus(f)!;
      expect(st.state).toBe("error");
      expect(st.errorSource).toBe("decider_timeout");
      const stubPid = readPid(f.stubPidFile)!;
      expect(await waitFor(() => !alive(stubPid), 3000), "the agent must not outlive the run").toBe(true);
      expect(credentialLeaks(f.envDump)).toEqual([]);
    } finally {
      f.cleanup();
    }
  });

  // Predicted RED: the raw `Error: … timed out …` stack (`at Timeout.<anonymous>`) on stderr.
  it("--decider-cmd timeout, text mode: one clean unanswered line, no stack trace", async () => {
    const f = makeStubFixture(GATE_STUB, { COWORK_HARNESS_DECIDER_CMD_TIMEOUT_MS: "300" });
    try {
      const r = await runToEnd(f, ["--decider-cmd", "cat >/dev/null"]);
      expect(r.code, r.stderr).toBe(2);
      expect(r.stderr).toContain("unanswered question (on_unanswered=decider-cmd)");
      expect(r.stderr).not.toMatch(/\n\s+at /);
    } finally {
      f.cleanup();
    }
  });

  // --decider-dir already salvaged its backstop (the channel returned null → UnansweredError), so this red is
  // a NEW-FIELD red, not a reproduction of the stack-trace defect: today result.json exists but carries no
  // errorSource, and the message says the channel "closed without a response" — which is not what happened.
  it("--decider-dir backstop: the same partial, now labelled decider_timeout", async () => {
    const f = makeStubFixture(GATE_STUB, { COWORK_HARNESS_DECIDER_DIR_TIMEOUT_MS: "300", COWORK_HARNESS_DECIDER_DIR_POLL_MS: "50" });
    const dir = join(f.root, "gates");
    mkdirSync(dir);
    try {
      const r = await runToEnd(f, ["--decider-dir", dir, "--output-format", "json"]);
      expect(r.code, r.stderr).toBe(2);
      expect(JSON.parse(r.stdout).error?.category).toBe("unanswered");
      const res = result(f);
      expect(res?.partial).toBe(true);
      expect(res.errorSource).toBe("decider_timeout");
      expect(res.unansweredGate.message).toMatch(/timed out|no answer/i);
      expect(readStatus(f)?.errorSource).toBe("decider_timeout");
    } finally {
      f.cleanup();
    }
  });

  // The helper exits long before the first gate, so `write` finds it dead and throws — the plain
  // "helper exited before answering" Error. Predicted RED: `internal`, no result.json. (If the EOF path won
  // the race instead, the unfixed tree would already give `unanswered` + result.json — which is why only the
  // category and the file are asserted, and errorSource must NOT claim a timeout.)
  it("--decider-cmd helper that exits before answering: unanswered, partial result.json, not a timeout", async () => {
    const f = makeStubFixture(GATE_STUB);
    try {
      const r = await runToEnd(f, ["--decider-cmd", "exit 0", "--output-format", "json"]);
      expect(r.code, r.stderr).toBe(2);
      expect(JSON.parse(r.stdout).error?.category).toBe("unanswered");
      const res = result(f);
      expect(res?.partial).toBe(true);
      expect(res.errorSource).not.toBe("decider_timeout");
    } finally {
      f.cleanup();
    }
  });
});
