// `hillclimb run` through the real CLI and the real per-scenario runner, with only the agent replaced: the stub
// `claude` (test/helpers/stub-agent.ts) first on PATH, at the protocol tier under a managed config dir (a made-up
// token; the stub goes nowhere). It streams one sub-agent dispatch and writes that child's transcript where the
// real agent does. No model call, no spend.
//
// Every transcript line here is SYNTHETIC (frame shapes with placeholder text); the withheld prompt parts are the
// BUILTIN-PART placeholders, guarded by test/fixture-transcript-guard.test.ts.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { CLI, POSIX, credentialLeaks, makeStubFixture, type StubFixture } from "./helpers/stub-agent.js";
import { checkFlowDir } from "../src/hillclimb/schema-check.js";

const BUILTIN = ["BUILTIN-PART-0", "BUILTIN-PART-1", "BUILTIN-PART-2", "BUILTIN-PART-3"];
const MODEL = "claude-sonnet-5";
const line = (o: unknown) => `printf '%s\\n' '${JSON.stringify(o)}'`;

const STUB = [
  `D="$CLAUDE_CONFIG_DIR/projects/-stub-cwd/stub-session/subagents"`,
  `mkdir -p "$D"`,
  `${line({ agentType: "general-purpose", description: "worker", toolUseId: "toolu_worker", spawnDepth: 1 })} > "$D/agent-a1.meta.json"`,
  `${line({ type: "attachment", attachment: { type: "prompt_snapshot", systemPrompt: [...BUILTIN, "SYNTHETIC last part"] } })} > "$D/agent-a1.jsonl"`,
  `${line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "child finding" }] } })} >> "$D/agent-a1.jsonl"`,
  line({ type: "system", subtype: "init", session_id: "stub", model: MODEL, tools: ["Agent"], cwd: "/tmp" }),
  line({
    type: "assistant",
    message: {
      id: "msg_1",
      role: "assistant",
      model: MODEL,
      content: [
        {
          type: "tool_use",
          id: "toolu_worker",
          name: "Agent",
          input: { description: "worker", subagent_type: "general-purpose", prompt: "go" },
        },
      ],
    },
    session_id: "stub",
  }),
  line({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_worker", content: "done" }] },
    session_id: "stub",
  }),
  line({
    type: "assistant",
    message: { id: "msg_2", role: "assistant", model: MODEL, content: [{ type: "text", text: "All done." }] },
    session_id: "stub",
  }),
  line({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "All done.",
    session_id: "stub",
    num_turns: 1,
    stop_reason: "end_turn",
    modelUsage: { [MODEL]: { inputTokens: 10, outputTokens: 5, costUSD: 0.01 } },
  }),
  "cat >/dev/null",
].join("\n");

let f: StubFixture;
let work: string;
beforeEach(() => {
  f = makeStubFixture(STUB);
  work = realpathSync(mkdtempSync(join(tmpdir(), "hc-e2e-")));
});
afterEach(() => {
  f.cleanup();
  rmSync(work, { recursive: true, force: true });
});

const filesUnder = (d: string): string[] =>
  readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? filesUnder(join(d, n)) : [join(d, n)]));

describe.runIf(POSIX)("hillclimb run through the CLI (stub agent, protocol, managed config)", () => {
  it("a baseline pass writes a scored row, a trace with the sub-agent's system turn, and a flow `check` accepts", () => {
    const plugin = join(work, "plugin", "my-plugin");
    mkdirSync(join(plugin, "skills", "x"), { recursive: true });
    writeFileSync(join(plugin, "skills", "x", "SKILL.md"), "---\nname: x\ndescription: d\n---\nbody\n");
    const evals = join(f.cwd, "evals");
    mkdirSync(evals);
    writeFileSync(join(evals, "_session.yaml"), `model: ${MODEL}\nplugins:\n  local_plugins:\n    - ${plugin}\n`);
    writeFileSync(
      join(evals, "alpha.yaml"),
      "name: alpha\nbaseline: latest\nsession: ./_session.yaml\nfidelity: protocol\nprompt: hi\nassert:\n  - result: success\n",
    );
    const env = { ...f.env, COWORK_MANAGED_CONFIG: "1", CLAUDE_CODE_OAUTH_TOKEN: "stub-not-a-real-token" };
    const cli = (...a: string[]) =>
      spawnSync(process.execPath, [CLI, "hillclimb", ...a], { cwd: f.cwd, env, encoding: "utf8", timeout: 60_000 });

    const r = cli("run", "evals", "--flow", "flow", "--approve-harness", "--concurrency", "1");
    expect(r.status, r.stderr).toBe(0);
    expect(credentialLeaks(f.envDump).filter((k) => k !== "CLAUDE_CODE_OAUTH_TOKEN")).toEqual([]);

    const flow = join(f.cwd, "flow");
    const row = JSON.parse(readFileSync(join(flow, "baseline", "results.jsonl"), "utf8").trim()) as Record<string, unknown>;
    expect(row).toMatchObject({ prompt_id: "alpha", rep: 0, model: MODEL, grade: { pass: 1 } });
    expect((row.meta as Record<string, unknown>).subagent_turns).toBe("complete");

    const turns = JSON.parse(readFileSync(join(flow, "baseline", "traces", "alpha_rep0.json"), "utf8")) as Array<{
      role: string;
      content: string;
    }>;
    const sys = turns.filter((t) => t.role === "system").map((t) => t.content);
    expect(sys).toHaveLength(1);
    // The child's snapshot was read through the kept run. The protocol tier sends no sub-agent append, so the state
    // is "none received"; the "as received" branch is covered with SYNTHETIC lines in hillclimb-subagent-system.
    expect(sys[0]).toBe("[sub-agent general-purpose#1 system — harness append: none received]");
    expect(turns.some((t) => t.content === "[sub-agent general-purpose#1] child finding")).toBe(true);

    // No withheld part reached any byte of the flow.
    for (const p of filesUnder(flow)) for (const b of BUILTIN) expect(readFileSync(p, "utf8").includes(b), `${p} holds ${b}`).toBe(false);

    expect(checkFlowDir(flow, { profile: "harness" }).errors).toBe(0);
    expect(cli("check", "--flow", "flow").status).toBe(0);
  }, 90_000);
});
