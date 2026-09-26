import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CLI,
  POSIX,
  alive,
  credentialLeaks,
  exited,
  makeStubFixture,
  readPid,
  readStatus,
  spawnCli,
  waitFor,
  type StubFixture,
} from "./helpers/stub-agent.js";

// A signal sent to the harness process alone (a wrapper script, a CI cancel, `timeout(1)`) must still end
// the run with a record and take the agent down with it. On the protocol tier nothing listened for the
// signal, so Node died by it: no exit hook ran, status.json stayed "running", and the host agent was never
// signalled — it lived on and could finish a paid turn. These drive the BUILT CLI against a stub agent, so
// they spend nothing.
//
// Signalling the harness pid ONLY is deliberate: a terminal Ctrl-C signals the whole foreground process
// group, which would hit the stub directly and prove nothing about the harness forwarding it.

const can = POSIX && existsSync(CLI);

async function startRun(f: StubFixture, extraArgs: string[] = []) {
  const cli = spawnCli(f, ["run", f.scenario, ...extraArgs]);
  const up = await waitFor(() => !!readPid(f.stubPidFile) && readStatus(f)?.state === "running", 20_000);
  expect(up, `the run never reached a live agent + "running" status. stderr:\n${cli.stderrText()}`).toBe(true);
  const stubPid = readPid(f.stubPidFile)!;
  expect(alive(stubPid), "the stub must be alive before the signal, or the test proves nothing").toBe(true);
  // The stub wrote its env before its pid, so the dump is complete: no credential may have reached it.
  expect(credentialLeaks(f.envDump)).toEqual([]);
  return { cli, stubPid };
}

describe.runIf(can)("a signalled run ends with a record and no surviving agent (protocol tier)", () => {
  // Predicted RED on the unfixed tree: {code:null, signal:"SIGINT"}, status.json still "running" with a frozen
  // updatedAt, and the stub alive (it never reads stdin, so the harness closing its pipe does not end it).
  it('SIGINT: exit 130, status.json "error", agent dead', async () => {
    const f = makeStubFixture("exec sleep 300");
    try {
      const { cli, stubPid } = await startRun(f);
      process.kill(cli.pid!, "SIGINT");
      const r = await exited(cli);
      expect(r, cli.stderrText()).toEqual({ code: 130, signal: null });
      expect(readStatus(f)?.state).toBe("error");
      expect(await waitFor(() => !alive(stubPid), 3000), `agent ${stubPid} outlived the harness`).toBe(true);
      expect(credentialLeaks(f.envDump)).toEqual([]);
    } finally {
      f.cleanup();
    }
  });

  // Predicted RED: {code:null, signal:"SIGTERM"}, "running", stub alive.
  it('SIGTERM: exit 143, status.json "error", agent dead', async () => {
    const f = makeStubFixture("exec sleep 300");
    try {
      const { cli, stubPid } = await startRun(f);
      process.kill(cli.pid!, "SIGTERM");
      const r = await exited(cli);
      expect(r, cli.stderrText()).toEqual({ code: 143, signal: null });
      expect(readStatus(f)?.state).toBe("error");
      expect(await waitFor(() => !alive(stubPid), 3000)).toBe(true);
      expect(credentialLeaks(f.envDump)).toEqual([]);
    } finally {
      f.cleanup();
    }
  });

  // Predicted RED: signal death and a stub that is alive indefinitely (nothing ever escalates).
  it("an agent that ignores SIGTERM is SIGKILLed after the grace period", async () => {
    const f = makeStubFixture("trap '' TERM\nwhile :; do sleep 1; done");
    try {
      const { cli, stubPid } = await startRun(f);
      process.kill(cli.pid!, "SIGINT");
      const r = await exited(cli);
      expect(r, cli.stderrText()).toEqual({ code: 130, signal: null });
      expect(readStatus(f)?.state).toBe("error");
      expect(await waitFor(() => !alive(stubPid), 5000), `SIGTERM-ignoring agent ${stubPid} survived`).toBe(true);
    } finally {
      f.cleanup();
    }
  });

  // The --decider-cmd helper is spawned in its own process group before the run starts, and its cleanup
  // used to re-raise the signal when it was the only listener — keeping the default (die by the signal,
  // skip every exit hook). Predicted RED: the helper's grandchild dies (that half already worked), but the
  // exit is {code:null, signal:"SIGINT"}, status.json stays "running" and the agent stub is alive. The helper
  // never answers (`cat >/dev/null`) and the stub raises no gate, so nothing ends the run before the signal.
  it("composes with the --decider-cmd helper cleanup: helper, agent and status all handled", async () => {
    const f = makeStubFixture("exec sleep 300");
    const helperPidFile = join(f.root, "helper.pid");
    try {
      const { cli, stubPid } = await startRun(f, ["--decider-cmd", `sleep 300 & echo $! > '${helperPidFile}'; cat >/dev/null`]);
      expect(await waitFor(() => !!readPid(helperPidFile))).toBe(true);
      const helperPid = readPid(helperPidFile)!;
      expect(alive(helperPid)).toBe(true);
      process.kill(cli.pid!, "SIGINT");
      const r = await exited(cli);
      try {
        expect(r, cli.stderrText()).toEqual({ code: 130, signal: null });
        expect(await waitFor(() => !alive(helperPid), 3000), `helper grandchild ${helperPid} survived`).toBe(true);
        expect(readStatus(f)?.state).toBe("error");
        expect(await waitFor(() => !alive(stubPid), 3000), `agent ${stubPid} outlived the harness`).toBe(true);
      } finally {
        if (alive(helperPid)) process.kill(helperPid, "SIGKILL");
      }
    } finally {
      f.cleanup();
    }
  });

  it("the fixture's credential instrument can see a leak (so an empty result above means something)", () => {
    const f = makeStubFixture("exit 0");
    try {
      writeFileSync(f.envDump, "PATH=/bin\nANTHROPIC_API_KEY=x\nCLAUDE_CODE_OAUTH_TOKEN=\n");
      expect(credentialLeaks(f.envDump)).toEqual(["ANTHROPIC_API_KEY"]);
      expect(readFileSync(f.envDump, "utf8")).toContain("CLAUDE_CODE_OAUTH_TOKEN=\n");
    } finally {
      f.cleanup();
    }
  });
});
