import { describe, it, expect } from "vitest";
import { tierVacuousTool, tierVacuousMessage, objectFormTierVacuous } from "../src/run/tier-vacuous-tools";

// `tool_not_called` on a tool the TIER never serves passes vacuously — it can never be violated. This
// table is what the harness refuses at load. The tests that matter most are the NEGATIVE ones: the check
// is a hard refusal, so a false positive makes a legitimate scenario unrunnable.

const GATE_ON = true;
const GATE_OFF = false;

describe("tools a tier provably does not serve", () => {
  it("hostloop replaces Bash and WebFetch, and removes NotebookEdit", () => {
    expect(tierVacuousTool("Bash", "hostloop", GATE_ON)).toEqual({ tool: "Bash", tier: "hostloop", instead: "mcp__workspace__bash" });
    expect(tierVacuousTool("WebFetch", "hostloop", GATE_ON)).toEqual({
      tool: "WebFetch",
      tier: "hostloop",
      instead: "mcp__workspace__web_fetch",
    });
    // Removed outright, so there is nothing to assert instead.
    expect(tierVacuousTool("NotebookEdit", "hostloop", GATE_ON)).toEqual({ tool: "NotebookEdit", tier: "hostloop", instead: null });
  });

  it("container keeps the built-in shell — the INVERSE direction is what is vacuous there", () => {
    expect(tierVacuousTool("Bash", "container", GATE_ON)).toBeUndefined();
    expect(tierVacuousTool("mcp__workspace__bash", "container", GATE_ON)).toEqual({
      tool: "mcp__workspace__bash",
      tier: "container",
      instead: "Bash",
    });
  });

  it("WebFetch at container is vacuous only when the VM-loop swap gate is ON", () => {
    expect(tierVacuousTool("WebFetch", "container", GATE_ON)?.instead).toBe("mcp__workspace__web_fetch");
    expect(tierVacuousTool("WebFetch", "container", GATE_OFF)).toBeUndefined();
  });

  it("microvm serves no workspace tools at all", () => {
    expect(tierVacuousTool("mcp__workspace__bash", "microvm", GATE_ON)?.instead).toBe("Bash");
    expect(tierVacuousTool("mcp__workspace__web_fetch", "microvm", GATE_ON)?.instead).toBe("WebFetch");
    expect(tierVacuousTool("Bash", "microvm", GATE_ON)).toBeUndefined();
  });

  it("protocol is never judged — its surface is the operator's own host CLI registry", () => {
    for (const t of ["Bash", "WebFetch", "NotebookEdit", "mcp__workspace__bash"])
      expect(tierVacuousTool(t, "protocol", GATE_ON), t).toBeUndefined();
  });
});

describe("what the check must NOT reject — it is a hard refusal, so a false positive is unrunnable", () => {
  it("an MCP tool from a session mcp.config is never rejected", () => {
    // The finding that sank the general design: `--tools` gates the BUILT-IN set only ("Specify the list
    // of available tools from the built-in set" — the binary's own help), while every tier separately
    // passes --mcp-config. A launch-set-derived check would have rejected this while the tool was
    // registered and callable — and a destructive third-party tool is the most valuable thing there is
    // to assert `tool_not_called` on. The repo ships examples/data/mcp.json declaring exactly such a
    // server.
    for (const tier of ["hostloop", "container", "microvm"])
      expect(tierVacuousTool("mcp__example-fs__write_file", tier, GATE_ON), tier).toBeUndefined();
  });

  it("a tool that is merely UNUSED is never rejected — only ones the tier does not serve", () => {
    // WebFetch at container with the gate off is offered and simply went uncalled in every measured run.
    // That is a real, satisfiable assertion.
    expect(tierVacuousTool("WebFetch", "container", GATE_OFF)).toBeUndefined();
    expect(tierVacuousTool("Read", "hostloop", GATE_ON)).toBeUndefined();
  });

  it("GLOBS are never rejected — a pattern is not a literal claim about one tool", () => {
    for (const g of ["mcp__*", "*", "Ba*", "B?sh", "mcp__workspace__*"]) expect(tierVacuousTool(g, "hostloop", GATE_ON), g).toBeUndefined();
  });

  it("an out-of-table name is not rejected, even when it happens to be vacuous", () => {
    // `REPL` is in spawn.tools but absent from the binary's registry, so it is genuinely unservable —
    // and deliberately NOT caught. The table is closed on purpose: under-approximating is the correct
    // side to err on when the verdict is a refusal.
    expect(tierVacuousTool("REPL", "hostloop", GATE_ON)).toBeUndefined();
    expect(tierVacuousTool("JavaScript", "hostloop", GATE_ON)).toBeUndefined();
  });

  it("an unknown tier is inert rather than guessing", () => {
    expect(tierVacuousTool("Bash", "some-future-tier", GATE_ON)).toBeUndefined();
  });
});

describe("the refusal message", () => {
  it("names the replacement in the SAME key the author wrote, and the positive sibling", () => {
    const m = tierVacuousMessage(tierVacuousTool("Bash", "hostloop", GATE_ON)!, "tool_not_called", "my-scenario");
    expect(m).toMatch(/my-scenario/);
    expect(m).toMatch(/can never be violated at fidelity `hostloop`/);
    expect(m).toMatch(/passes vacuously and verifies nothing/);
    expect(m).toMatch(/tool_not_called: "mcp__workspace__bash"/); // the remedy, spelled out
    expect(m).toMatch(/tool_called: "Bash"` fails normally/); // the sibling that behaves differently
  });

  it("echoes the sub-agent key back when that is what was written", () => {
    // An earlier version hardcoded `tool_not_called` in the remedy, which would have told an author who
    // wrote `subagent_tool_absent` to fix a key they had not used.
    const m = tierVacuousMessage(tierVacuousTool("Bash", "hostloop", GATE_ON)!, "subagent_tool_absent", "s");
    expect(m).toMatch(/`subagent_tool_absent: "Bash"` can never be violated/);
    expect(m).toMatch(/Assert `subagent_tool_absent: "mcp__workspace__bash"` instead/);
  });

  it("says there is nothing to assert instead when the tier simply removes the tool", () => {
    const m = tierVacuousMessage(tierVacuousTool("NotebookEdit", "hostloop", GATE_ON)!, "tool_not_called", "s");
    expect(m).toMatch(/removes `NotebookEdit` outright.*no replacement.*drop this assertion/s);
  });
});

// ── the wiring: a real scenario load must actually refuse ────────────────────────────────────────────
// The table above is inert unless executeScenario consults it. These drive the real load path, which
// throws before buildLaunchPlan and before any spawn — token-free, no Docker (the same property
// test/execute-origin-guard.test.ts relies on).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeScenario, parseScenarioFile } from "../src/run/execute";

// A run must resolve a model (4.0.0), and that refusal comes before this one; pin it so the load reaches the
// tier check.
const executePinned = (s: Parameters<typeof executeScenario>[0]) => executeScenario(s, { modelOverride: "claude-sonnet-5" });

function scenarioWith(tier: string, asserts: string): ReturnType<typeof parseScenarioFile> {
  const dir = mkdtempSync(join(tmpdir(), "cwh-tv-"));
  writeFileSync(join(dir, "s.yaml"), "folders: []\n");
  const f = join(dir, "sc.yaml");
  writeFileSync(f, `name: tv\nbaseline: latest\nsession: (inline)\nfidelity: ${tier}\nprompt: hi\nassert:\n${asserts}`);
  return parseScenarioFile(f);
}

describe("executeScenario refuses a tier-vacuous tool_not_called at load", () => {
  it("rejects `Bash` at hostloop, naming the replacement", async () => {
    await expect(executePinned(scenarioWith("hostloop", `  - tool_not_called: Bash\n`))).rejects.toThrow(
      /can never be violated at fidelity `hostloop`[\s\S]*mcp__workspace__bash/,
    );
  });

  it("rejects the sub-agent form of the same claim — the asymmetry the first cut shipped", async () => {
    // Refusing `tool_not_called: "Bash"` at hostloop while greening `subagent_tool_absent: "Bash"` taught
    // an author that this class is caught, then did not catch it. `subagent_tool_absent` reads the tools
    // sub-agents actually USED (assert.ts's ctx.subagentTools), not a per-dispatch declared list, so the
    // same table applies — the belief that it read a different inventory was simply wrong.
    await expect(executePinned(scenarioWith("hostloop", `  - subagent_tool_absent: Bash\n`))).rejects.toThrow(
      /`subagent_tool_absent: "Bash"` can never be violated at fidelity `hostloop`/,
    );
  });

  it("rejects the INVERSE at container", async () => {
    await expect(executePinned(scenarioWith("container", `  - tool_not_called: mcp__workspace__bash\n`))).rejects.toThrow(
      /can never be violated at fidelity `container`/,
    );
  });

  // NO negative cases here, deliberately. Passing the check means the load CONTINUES into staging and a
  // real container spawn — Docker, minutes, and a flaky unit test. The "must not reject" cases live in
  // the table describe above instead, which is where the decision is actually made: executeScenario
  // passes the pattern straight through, so a name absent from the table cannot be refused here.
});

describe("the object form of tool_not_called is held to the same tier table", () => {
  it("rejects an object whose only tool is unserved (an input regex does not rescue it)", async () => {
    await expect(
      executePinned(scenarioWith("hostloop", `  - tool_not_called: { tool: Bash, input: { command: 'rm\\s+-rf' } }\n`)),
    ).rejects.toThrow(/can never be violated at fidelity `hostloop`[\s\S]*mcp__workspace__bash/);
  });

  it("rejects a LIST only when EVERY member is unserved", async () => {
    await expect(
      executePinned(scenarioWith("hostloop", `  - tool_not_called: { tool: [Bash, WebFetch], input: { command: x } }\n`)),
    ).rejects.toThrow(/can never be violated at fidelity `hostloop`/);
  });
  // A list with one served member ([Bash, mcp__workspace__bash]) is NOT refused — asserted on the pure
  // table helper, since passing this check would continue into a real spawn.
  it("a list with one served member is not vacuous", () => {
    expect(objectFormTierVacuous({ tool: ["Bash", "mcp__workspace__bash"] }, "hostloop", false)).toBeUndefined();
    expect(objectFormTierVacuous({ tool: ["Bash", "WebFetch"] }, "hostloop", false)?.tool).toBe("Bash");
    expect(objectFormTierVacuous({ tool: "Ba*" }, "hostloop", false)).toBeUndefined();
  });
});

describe("a bad regex nested in the object form is a load-time error, not a post-spend one", () => {
  for (const [label, yaml] of [
    ["input field", `  - tool_called: { tool: Bash, input: { command: '(' } }\n`],
    ["input_any", `  - tool_called: { tool: Bash, input_any: '[' }\n`],
    ["result.not_matches", `  - tool_not_called: { tool: Bash, result: { not_matches: '(' } }\n`],
    ["subagent_type", `  - tool_called: { tool: Bash, scope: subagent, subagent_type: '(' }\n`],
  ] as const)
    it(label, () => {
      expect(() => scenarioWith("container", yaml)).toThrow(/bad regex in tool_(not_)?called\./);
    });
});

// The remote lane's device tools: served only under `device_bridge: true`, and only two of them. A negative
// assertion on one the run cannot serve passes vacuously, whatever the tier.
describe("device tools the run does not serve", () => {
  const DB = "mcp__remote-devices__device_bash";
  it("device_bash and get_device_info are vacuous without device_bridge, and served with it", () => {
    for (const tool of [DB, "mcp__remote-devices__get_device_info"]) {
      for (const tier of ["container", "hostloop", "microvm"])
        expect(tierVacuousTool(tool, tier, GATE_OFF), `${tool} ${tier}`).toMatchObject({ tool, reason: "device-bridge-off" });
      expect(tierVacuousTool(tool, "container", GATE_OFF, true)).toBeUndefined();
    }
  });
  it("a device tool the harness never serves is vacuous even with the bridge", () => {
    expect(tierVacuousTool("mcp__remote-devices__device_list_dir", "container", GATE_OFF, true)).toMatchObject({
      reason: "device-unserved",
    });
    expect(tierVacuousTool("mcp__remote-devices__device_commit_files", "hostloop", GATE_OFF)).toMatchObject({ reason: "device-unserved" });
  });
  it("leaves protocol, globs and a bridged host server's tools alone", () => {
    expect(tierVacuousTool(DB, "protocol", GATE_OFF)).toBeUndefined();
    expect(tierVacuousTool("mcp__remote-devices__*", "container", GATE_OFF)).toBeUndefined();
    expect(tierVacuousTool("mcp__remote-devices__acme__lookup", "container", GATE_OFF)).toBeUndefined();
  });
  it("the message names device_bridge as the way to serve it", () => {
    const f = tierVacuousTool(DB, "container", GATE_OFF)!;
    expect(tierVacuousMessage(f, "tool_not_called", "s")).toMatch(/device_bridge: true/);
  });
  it("executeScenario refuses it at load, before any spend", async () => {
    await expect(executePinned(scenarioWith("container", `  - tool_not_called: ${DB}\n`))).rejects.toThrow(/device_bridge: true/);
    await expect(executePinned(scenarioWith("container", `  - subagent_tool_absent: ${DB}\n`))).rejects.toThrow(/device_bridge: true/);
    await expect(executePinned(scenarioWith("container", `  - tool_not_called: {tool: ${DB}}\n`))).rejects.toThrow(/device_bridge: true/);
  });
});

describe("the device-tool list is one list", () => {
  it("tier-vacuous-tools.ts, the skill linter and the newest baseline's cloud block name the same tools", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    /** The quoted names between `start` and the first `end` after it. */
    const names = (src: string, start: string, end: string) => {
      const from = src.indexOf(start);
      expect(from, start).toBeGreaterThan(-1);
      const block = src.slice(from, src.indexOf(end, from));
      return [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
    };
    const ts = names(readFileSync("src/run/tier-vacuous-tools.ts", "utf8"), "const REMOTE_DEVICE_TOOLS = new Set([", "]);");
    const py = names(readFileSync(".claude/skills/cowork-harness/scripts/scenario.py", "utf8"), "_REMOTE_DEVICE_TOOLS = {", "}");
    const newest = readdirSync("baselines")
      .map((f) => /^desktop-(\d+)\.(\d+)\.(\d+)\.json$/.exec(f))
      .filter((m): m is RegExpExecArray => !!m)
      .sort((a, b) => +a[1] - +b[1] || +a[2] - +b[2] || +a[3] - +b[3])
      .pop()!;
    const base = [...JSON.parse(readFileSync(`baselines/${newest[0]}`, "utf8")).cloud.remoteDevicesTools].sort();
    expect(ts).toHaveLength(14);
    expect(py).toEqual(ts);
    expect(base).toEqual(ts);
  });
});
