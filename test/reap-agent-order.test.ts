import { describe, it, expect } from "vitest";
import { reapAgentOnTeardown } from "../src/run/execute.js";
import type { TerminableAgent } from "../src/termination.js";

// The normal-path teardown must keep the agent registered with the termination handler until it is dead.
// On microvm it first waits (up to a second) for the host client to exit on its own; a signal landing in
// that wait used to find NO registered agent — the handler then exited at once and left the guest agent
// running and the limactl client orphaned. So: wait, kill, and only then de-register.

function fakeAgent(log: string[]): TerminableAgent {
  let alive = true;
  return {
    alive: () => alive,
    terminate: () => log.push("terminate"),
    forceKill: () => {
      log.push("forceKill");
      alive = false;
    },
    exited: () => new Promise<void>(() => {}), // the client lingers
  };
}

describe("reapAgentOnTeardown", () => {
  it("microvm: guest kill, then the client SIGKILL, and only then de-register", async () => {
    const log: string[] = [];
    let registeredDuringWait: boolean | undefined;
    let registered = true;
    const agent = fakeAgent(log);
    const origForceKill = agent.forceKill;
    agent.forceKill = () => {
      registeredDuringWait = registered;
      origForceKill();
    };
    await reapAgentOnTeardown({
      microvm: true,
      agent,
      child: { kill: (s?: NodeJS.Signals) => void log.push(`child ${s}`) },
      deregister: () => {
        registered = false;
        log.push("deregister");
      },
      settleMs: 10,
    });
    expect(log).toEqual(["forceKill", "child SIGKILL", "deregister"]);
    expect(registeredDuringWait).toBe(true);
  });

  it("tree agent still running: wait, SIGTERM the tree, wait the grace, force-kill it, and only then de-register", async () => {
    const log: string[] = [];
    await reapAgentOnTeardown({
      microvm: false,
      agent: fakeAgent(log),
      child: { kill: (s?: NodeJS.Signals) => void log.push(`child ${s}`) },
      deregister: () => log.push("deregister"),
      settleMs: 10,
      graceMs: 10,
    });
    // The leader dies with the tree (forceKill ends with a pid SIGKILL of a surviving leader); a bare
    // child SIGKILL here would leave every process the agent started running.
    expect(log).toEqual(["terminate", "forceKill", "deregister"]);
  });

  it("tree agent: without an explicit grace it waits the agent's own grace period (hostloop's is longer)", async () => {
    const log: string[] = [];
    const agent = { ...fakeAgent(log), graceMs: 300 };
    const t = Date.now();
    await reapAgentOnTeardown({ microvm: false, agent, deregister: () => log.push("deregister"), settleMs: 10 });
    const ms = Date.now() - t;
    expect(log).toEqual(["terminate", "forceKill", "deregister"]);
    expect(ms).toBeGreaterThanOrEqual(290);
    expect(ms).toBeLessThan(1500);
  });

  it("tree agent whose leader already exited: no SIGTERM round, the tree is still force-killed", async () => {
    const log: string[] = [];
    const agent = fakeAgent(log);
    agent.alive = () => false;
    await reapAgentOnTeardown({
      microvm: false,
      agent,
      child: { kill: (s?: NodeJS.Signals) => void log.push(`child ${s}`) },
      deregister: () => log.push("deregister"),
    });
    expect(log).toEqual(["forceKill", "deregister"]);
  });

  it("container (no host agent): SIGKILL the docker client, then de-register", async () => {
    const log: string[] = [];
    await reapAgentOnTeardown({
      microvm: false,
      child: { kill: (s?: NodeJS.Signals) => void log.push(`child ${s}`) },
      deregister: () => log.push("deregister"),
    });
    expect(log).toEqual(["child SIGKILL", "deregister"]);
  });

  it("microvm agent that already exited: no guest kill", async () => {
    const log: string[] = [];
    const agent = fakeAgent(log);
    agent.alive = () => false;
    await reapAgentOnTeardown({
      microvm: true,
      agent,
      child: { kill: () => void log.push("child") },
      deregister: () => log.push("deregister"),
    });
    expect(log).toEqual(["child", "deregister"]);
  });

  it("reports the time the host-agent stop sequence took, so a run's durationMs can leave it out", async () => {
    const tree = await reapAgentOnTeardown({ microvm: false, agent: fakeAgent([]), settleMs: 60, graceMs: 60 });
    expect(tree).toBeGreaterThanOrEqual(110);
    expect(tree).toBeLessThan(1500);
    const container = await reapAgentOnTeardown({ microvm: false, child: { kill: () => {} } });
    expect(container).toBe(0);
  });

  it("tree agent: the force-kill waits for the drive loop's last asynchronous listing to land", async () => {
    const log: string[] = [];
    const agent = fakeAgent(log);
    agent.alive = () => false;
    agent.idle = () => new Promise<void>((res) => setTimeout(() => (log.push("listing landed"), res()), 50));
    await reapAgentOnTeardown({ microvm: false, agent, deregister: () => log.push("deregister") });
    expect(log).toEqual(["listing landed", "forceKill", "deregister"]);
  });
});
