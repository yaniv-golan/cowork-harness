import { describe, it, expect } from "vitest";
import { loadBaseline } from "../src/baseline.js";
import type { LaunchPlan } from "../src/session.js";
import { agentArgs } from "../src/runtime/argv.js";
import { Run } from "../src/run/run.js";
import type { AgentSession, AgentEvent, DecisionResponse } from "../src/agent/session.js";
import { ScriptedDecider } from "../src/decide/decider.js";

// WS-C: turn budget (--max-turns passthrough) + wall-clock timeout (kill → errorSource:"timeout").

const baseline = loadBaseline("latest");
const mntRoot = "mnt";
function plan(over: Partial<LaunchPlan> = {}): LaunchPlan {
  return {
    configDir: "/HOST/CFG",
    mcpConfig: null,
    permissionMode: "default",
    permissionParity: "cowork",
    baseEnv: {},
    mounts: [],
    pluginDirs: [],
    egressAllow: ["api.anthropic.com"],
    ...over,
  };
}
const flagAfter = (args: string[], flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

describe("agent_max_turns → --max-turns passthrough", () => {
  it("omits --max-turns by default (agent inherits its own ceiling — faithful to interactive Cowork)", () => {
    expect(agentArgs(baseline, plan(), { mntRoot })).not.toContain("--max-turns");
  });

  it("emits --max-turns <n> when the session sets agentMaxTurns", () => {
    const args = agentArgs(baseline, plan({ agentMaxTurns: 500 }), { mntRoot });
    expect(flagAfter(args, "--max-turns")).toBe("500");
  });
});

/** A session whose event stream blocks until killed/closed — models a runaway/hung agent. */
class HangingSession implements AgentSession {
  killed = false;
  private release!: () => void;
  private gate = new Promise<void>((r) => (this.release = r));
  async *start(): AsyncIterable<AgentEvent> {
    await this.gate; // never yields on its own — only the timeout can end this
  }
  sendUserTurn(): void {}
  respond(_id: string, _r: DecisionResponse): void {}
  close(): void {
    this.release();
  }
  kill(): void {
    this.killed = true;
    this.release();
  }
}

describe("wall-clock timeout", () => {
  it("kills the hung agent and labels result:error / errorSource:'timeout'", async () => {
    const session = new HangingSession();
    // 6th ctor arg = runTimeoutMs. dialogTimeoutMs left default.
    const rec = await new Run(session, new ScriptedDecider([]), [], "t", undefined, 40).drive("go");
    expect(session.killed).toBe(true); // used kill(), not just close()
    expect(rec.result).toBe("error");
    expect(rec.errorSource).toBe("timeout"); // wins over the no_result / exit labeling
  });

  it("no timeout set → the timer never arms (a normal run is unaffected)", async () => {
    // A session that ends on its own immediately; with no runTimeoutMs the run completes normally.
    const quick: AgentSession = {
      async *start() {
        yield { type: "result", isError: false } as AgentEvent;
      },
      sendUserTurn() {},
      respond() {},
      close() {},
    };
    const rec = await new Run(quick, new ScriptedDecider([]), [], "t").drive("go");
    expect(rec.result).toBe("success");
    expect(rec.errorSource).toBeUndefined();
  });
});
