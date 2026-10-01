import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeScenario, parseScenarioFile } from "../src/run/execute.js";
import type { SemanticJudge } from "../src/assert.js";
import { POSIX, makeStubFixture, type StubFixture } from "./helpers/stub-agent.js";

// `include_subagent_text` through the REAL executeScenario, with only the agent replaced: the stub `claude`
// (test/helpers/stub-agent.ts) first on PATH, at the protocol tier under managed config. The stub writes one
// sub-agent's child transcript where the real host `claude` does — under its `CLAUDE_CONFIG_DIR`, which the
// managed branch sets to the run's own config dir — and streams a dispatch of that sub-agent. The judge is
// injected and records the document it was handed. No agent, no model call, no spend.
//
// The unit tests of the capture-then-judge helper cannot see how executeScenario wires the ctx, the capture
// root and the persisted result together; this can. It fails if the judge runs before the capture, if the
// protocol tier has no capture root, or if the judge's ctx and the persisted result stop sharing objects.

const FAKE_TOKEN = "stub-not-a-real-token";
const CREDENTIAL_VARS = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"] as const;

const line = (o: unknown) => `printf '%s\\n' '${JSON.stringify(o)}'`;
const CHILD_TEXT = "SUBAGENT-FINDING: the answer is 42.";

// The layout captureSubagentReasoning globs: <root>/projects/**/subagents/agent-<id>.meta.json (joined on its
// toolUseId) with the sibling agent-<id>.jsonl in the transcript's per-line shape.
const STUB = [
  `D="$CLAUDE_CONFIG_DIR/projects/-stub-cwd/stub-session/subagents"`,
  `mkdir -p "$D"`,
  `${line({ agentType: "general-purpose", description: "worker", toolUseId: "toolu_worker", spawnDepth: 1 })} > "$D/agent-a1.meta.json"`,
  `${line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: CHILD_TEXT }] } })} > "$D/agent-a1.jsonl"`,
  line({ type: "system", subtype: "init", session_id: "stub", model: "claude-sonnet-5", tools: ["Agent"], cwd: "/tmp" }),
  line({
    type: "assistant",
    message: {
      id: "msg_1",
      role: "assistant",
      model: "claude-sonnet-5",
      content: [
        {
          type: "tool_use",
          id: "toolu_worker",
          name: "Agent",
          input: { description: "worker", subagent_type: "general-purpose", prompt: "find it" },
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
    message: { id: "msg_2", role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "All done." }] },
    session_id: "stub",
  }),
  line({ type: "result", subtype: "success", is_error: false, result: "All done.", session_id: "stub", num_turns: 1 }),
  "cat >/dev/null",
].join("\n");

let f: StubFixture;
const saved: Record<string, string | undefined> = {};
function setEnv(k: string, v: string): void {
  if (!(k in saved)) saved[k] = process.env[k];
  process.env[k] = v;
}

beforeEach(() => {
  f = makeStubFixture(STUB);
  // In-process run: the fixture's env is applied to THIS process for the test, then restored.
  setEnv("COWORK_HARNESS_FORBID_SPAWN", "0");
  setEnv("PATH", f.env.PATH!);
  setEnv("HOME", f.env.HOME!);
  setEnv("CLAUDE_CONFIG_DIR", f.env.CLAUDE_CONFIG_DIR!);
  setEnv("COWORK_HARNESS_RUNS_DIR", f.runsDir);
  setEnv("COWORK_HARNESS_MODEL", "claude-sonnet-5");
  setEnv("STUB_PID", f.stubPidFile);
  setEnv("STUB_ENV_DUMP", f.envDump);
  // Managed config is what points the agent's CLAUDE_CONFIG_DIR at the run's own dir; it needs a token, so a
  // made-up one is supplied (the stub is the agent — it goes nowhere). Every other credential is blanked so
  // nothing ambient from the developer's shell can reach the child.
  setEnv("COWORK_MANAGED_CONFIG", "1");
  for (const k of CREDENTIAL_VARS) setEnv(k, k === "CLAUDE_CODE_OAUTH_TOKEN" ? FAKE_TOKEN : "");
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete saved[k];
  }
  f.cleanup();
});

describe.runIf(POSIX)("include_subagent_text through the real executeScenario (protocol, managed config)", () => {
  it("the judge receives the sub-agent's text, and result.subagents persists the same reasoning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "subagent-e2e-scn-"));
    try {
      const file = join(dir, "subagent-e2e.yaml");
      writeFileSync(
        file,
        [
          "name: subagent-e2e",
          "baseline: latest",
          "session: (inline)",
          "fidelity: protocol",
          "prompt: hi",
          "assert:",
          "  - semantic_matches:",
          "      rubric: ['the sub-agent found the answer']",
          "      include_subagent_text: true",
          "",
        ].join("\n"),
      );
      const received: string[] = [];
      const judge = (async (rubric: string[], answer: string) => {
        received.push(answer);
        return rubric.map((_, i) => ({ index: i, pass: true }));
      }) as SemanticJudge;

      const res = await executeScenario(parseScenarioFile(file), { semanticJudge: judge });

      // Credential safety: the only credential the stub received is the made-up one.
      const env = readFileSync(f.envDump, "utf8").split("\n");
      for (const k of CREDENTIAL_VARS) {
        const v = env.find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1) ?? "";
        expect(v === "" || v === FAKE_TOKEN, `${k} reached the stub with a value that is not the fake token`).toBe(true);
      }

      expect(res.subagents?.map((s) => s.toolUseId)).toEqual(["toolu_worker"]);
      expect(received, "the judge was never called").toHaveLength(1);
      expect(received[0]).toContain("## Sub-agent output: worker");
      expect(received[0]).toContain(CHILD_TEXT);
      // The result side of the same link: what result.json persists is what the judge was handed.
      const persisted = res.subagents![0].reasoning?.filter((t) => t.kind === "text").map((t) => t.text);
      expect(persisted).toEqual([CHILD_TEXT]);
      const graded = res.assertions.find((a) => a.judgedDoc);
      expect(graded?.judgedDoc?.sections.map((s) => s.kind)).toContain("subagent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("a deadline that passed before the judge phase skips every judge and ends the run as a timeout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "subagent-e2e-deadline-"));
    try {
      const file = join(dir, "deadline.yaml");
      writeFileSync(
        file,
        [
          "name: deadline",
          "baseline: latest",
          "session: (inline)",
          "fidelity: protocol",
          "prompt: hi",
          "assert:",
          "  - semantic_matches:",
          "      rubric: ['x']",
          "",
        ].join("\n"),
      );
      let judged = 0;
      const judge: SemanticJudge = async (rubric) => {
        judged++;
        return rubric.map((claim, index) => ({ index, claim, pass: true }));
      };
      const res = await executeScenario(parseScenarioFile(file), { semanticJudge: judge, deadline: Date.now() - 1 });
      expect(judged).toBe(0);
      expect(res.result).toBe("error");
      expect(res.errorSource).toBe("timeout");
      // the sub-agent capture still ran: the trace keeps the child's reasoning
      expect(res.subagents?.[0].reasoning?.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
