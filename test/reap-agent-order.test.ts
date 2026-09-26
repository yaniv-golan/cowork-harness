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

  it("non-microvm: no guest kill, SIGKILL the child, then de-register", async () => {
    const log: string[] = [];
    await reapAgentOnTeardown({
      microvm: false,
      agent: fakeAgent(log),
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
});
