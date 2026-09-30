import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import readline from "node:readline";
import { makeContainerPhaseReap } from "../src/run/execute.js";
import { wireChatInterrupt, ttyTurns } from "../src/run/chat.js";

// Where the process-tree kill is wired in. The tree agent itself is covered by agent-tree(.live).test.ts;
// these pin that each stop site hands the agent to it instead of SIGKILLing one pid.

describe("the Ctrl-C container-phase thunk (run and chat)", () => {
  function fire(fidelity: string) {
    const log: string[] = [];
    const run = makeContainerPhaseReap({
      fidelity,
      child: () => ({ kill: (s?: NodeJS.Signals) => void log.push(`child ${s}`) }),
      containerName: () => "ctr",
      markTearingDown: () => log.push("mark"),
      rm: (name) => log.push(`rm ${name}`),
    });
    run();
    return log;
  }

  it("hostloop: leaves the native agent to the termination handler (SIGTERM + grace), then removes the sidecar", () => {
    expect(fire("hostloop")).toEqual(["mark", "rm ctr"]);
  });

  it("container: SIGKILLs the docker client, then removes the container", () => {
    expect(fire("container")).toEqual(["child SIGKILL", "mark", "rm ctr"]);
  });
});

describe("chat: a Ctrl-C on the terminal reaches the termination handler mid-turn", () => {
  function tty() {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const rl = readline.createInterface({ input, output, terminal: true });
    let closed = false;
    rl.on("close", () => (closed = true));
    return { input, rl, closed: () => closed };
  }

  it("mid-turn: Ctrl-C is forwarded as SIGINT instead of closing the prompt", () => {
    const t = tty();
    const forwarded: string[] = [];
    wireChatInterrupt(t.rl, { atTurnPrompt: () => false, forward: () => forwarded.push("SIGINT") });
    t.input.write("\x03");
    expect(forwarded).toEqual(["SIGINT"]);
    expect(t.closed()).toBe(false);
    t.rl.close();
  });

  it("at the `you>` prompt: Ctrl-C ends the session the way EOF does (the result is still written)", () => {
    const t = tty();
    const forwarded: string[] = [];
    wireChatInterrupt(t.rl, { atTurnPrompt: () => true, forward: () => forwarded.push("SIGINT") });
    t.input.write("\x03");
    expect(forwarded).toEqual([]);
    expect(t.closed()).toBe(true);
  });
});

describe("chat: ending the session opens the exit hold that protects its result", () => {
  async function drain(lines: string[]) {
    const input = new PassThrough();
    const rl = readline.createInterface({ input, output: new PassThrough(), terminal: false });
    const events: string[] = [];
    const turnPrompt = { open: false, ended: () => void events.push("ended") };
    // Fed one line per prompt: readline drops lines that arrive while no question is pending.
    const feed = [...lines];
    const next = () => setTimeout(() => (feed.length ? input.write(feed.shift()!) : input.end()), 10);
    next();
    for await (const t of ttyTurns(rl, turnPrompt)) {
      events.push(`turn ${t}`);
      next();
    }
    rl.close();
    return events;
  }
  it("/exit ends the turns and opens the hold", async () => {
    expect(await drain(["hello\n", "/exit\n"])).toEqual(["turn hello", "ended"]);
  });
  it("EOF ends the turns and opens the hold", async () => {
    expect(await drain(["hello\n"])).toEqual(["turn hello", "ended"]);
  });
});

describe("stop sites route through the tree kill", () => {
  const execute = readFileSync("src/run/execute.ts", "utf8");
  const chat = readFileSync("src/run/chat.ts", "utf8");

  it("run and chat build the Ctrl-C thunk from makeContainerPhaseReap and tear down through reapAgentOnTeardown", () => {
    for (const src of [execute, chat]) {
      expect(src).toContain("makeContainerPhaseReap(");
      expect(src).toContain("reapAgentOnTeardown(");
    }
  });

  it("no stop site SIGKILLs the agent by pid directly any more", () => {
    // The one remaining direct child SIGKILL lives inside reapAgentOnTeardown / makeContainerPhaseReap,
    // reached only for the container tier's docker client.
    const bare = /child\?\.kill\?\.\("SIGKILL"\)/g;
    expect(chat.match(bare) ?? []).toEqual([]);
    expect((execute.match(bare) ?? []).length).toBeLessThanOrEqual(2);
  });

  it("chat installs the termination handler and registers the agent at protocol and hostloop", () => {
    expect(chat).toContain("installTerminationHandler()");
    expect(chat).toContain("registerAgent(");
    expect(chat).toContain("wireChatInterrupt(rl");
  });

  it("run and chat leave the host-agent stop sequence out of durationMs", () => {
    const executeDurations = execute.match(/durationMs: Date\.now\(\) - startedAt[^,\n]*/g) ?? [];
    expect(executeDurations.length).toBeGreaterThanOrEqual(2);
    for (const d of executeDurations) expect(d).toContain("- agentStopMs");
    expect(chat).toMatch(/durationMs: Date\.now\(\) - start - agentStopMs/);
  });
});
