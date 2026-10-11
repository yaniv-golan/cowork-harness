// A multi-leg scenario end to end through the real CLI: `run` drives a stub agent through the protocol tier (no model
// call, no spend) for two prompt legs. The stub behaves like a gated skill that resumes from its own status file: it
// parks at `waiting` when it finds no run, and completes (invocation 2) when it finds a waiting one. Synthetic data only.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLI, POSIX, exited, makeStubFixture, spawnCli, type StubFixture } from "./helpers/stub-agent.js";
import { classifyRunDir } from "../src/run/turn-layout.js";

const can = POSIX && existsSync(CLI);
const DUMMY = { ANTHROPIC_API_KEY: "stub-placeholder-not-a-credential" };
const out = (o: unknown) => `printf '%s\\n' '${JSON.stringify(o)}'`;
const S = '"$COWORK_ARTIFACTS_ROOT/runs/r1/run_status.json"';
const STUB = [
  `mkdir -p "$COWORK_ARTIFACTS_ROOT/runs/r1"`,
  `if grep -q waiting ${S} 2>/dev/null; then printf '{"status":"complete","invocation":2,"resumed_from":{"gate":"g1"}}' > ${S}; ` +
    `else printf '{"status":"waiting","invocation":1}' > ${S}; fi`,
  out({ type: "system", subtype: "init", session_id: "stub", model: "claude-sonnet-5", tools: [], cwd: "/tmp" }),
  out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done for now." }] }, session_id: "stub" }),
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Done for now.",
    session_id: "stub",
    num_turns: 1,
    total_cost_usd: 0.01,
    usage: { input_tokens: 1, output_tokens: 1 },
  }),
  "cat >/dev/null",
].join("\n");

function fixture(): StubFixture {
  const f = makeStubFixture(STUB, DUMMY);
  const bin = join(f.root, "bin", "claude");
  writeFileSync(
    bin,
    readFileSync(bin, "utf8").replace(
      "#!/bin/sh\n",
      `#!/bin/sh\nif [ "$1" = "--help" ]; then echo '  --permission-prompts <target>  Who answers: "host" or "none"'; fi\n`,
    ),
  );
  writeFileSync(
    join(f.cwd, "s.yaml"),
    ["answer_channel: none", "permission_mode: bypassPermissions", "agent_env:", "  artifacts_root: artifacts"].join("\n") + "\n",
  );
  return f;
}

const STATUS = "outputs/artifacts/runs/r1/run_status.json";
function scenario(f: StubFixture, workdir: "persistent" | "cowork-task"): string {
  const p = join(f.cwd, `ml-${workdir}.yaml`);
  writeFileSync(
    p,
    [
      "name: ml",
      "baseline: latest",
      "session: ./s.yaml",
      "fidelity: protocol",
      `workdir: ${workdir}`,
      "legs:",
      "  - id: ask",
      "    prompt: run the gated probe",
      "    assert:",
      `      - artifact_json: { artifact: ${STATUS}, path: status, equals: waiting }`,
      "  - id: resume",
      "    prompt: run the gated probe. FS_HOST_ANSWER g1=a",
      "    assert:",
      `      - artifact_json: { artifact: ${STATUS}, path: status, equals: complete }`,
      `      - artifact_json: { artifact: ${STATUS}, path: invocation, equals: 2 }`,
    ].join("\n") + "\n",
  );
  return p;
}
async function cli(f: StubFixture, args: string[]) {
  const c = spawnCli(f, args);
  const r = await exited(c, 120_000);
  return { ...r, stdout: c.stdoutText(), stderr: c.stderrText() };
}
const onlyRun = (f: StubFixture): string => {
  const d = join(f.runsDir, "ml");
  const runs = readdirSync(d).filter((x) => !x.startsWith("."));
  expect(runs).toHaveLength(1);
  return join(d, runs[0]!);
};

describe.runIf(can)("multi-leg run (stub agent, protocol)", () => {
  it("persistent: leg 2 is a new session that sees leg 1's files and completes the run; one index row", async () => {
    const f = fixture();
    try {
      const r = await cli(f, ["run", scenario(f, "persistent"), "--output-format", "json"]);
      expect(r.code, r.stderr).toBe(0);
      const env = JSON.parse(r.stdout);
      expect(env.ok).toBe(true);
      expect(env.results).toHaveLength(2);
      expect(env.multiLeg.legs.map((l: { id: string; status: string }) => `${l.id}:${l.status}`)).toEqual(["ask:passed", "resume:passed"]);
      const ids = env.multiLeg.legs.map((l: { agentSessionId: string }) => l.agentSessionId);
      expect(new Set(ids).size).toBe(2); // two sessions, not a resume
      const root = onlyRun(f);
      expect(classifyRunDir(root)).toEqual({ kind: "legs", legs: ["ask", "resume"], complete: true });
      expect(existsSync(join(root, "work"))).toBe(true); // the shared tree is at the scenario root
      expect(existsSync(join(root, "legs", "ask", "work"))).toBe(false);
      const index = readFileSync(join(f.runsDir, "index.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(index.filter((row: { slug: string }) => row.slug === "ml")).toHaveLength(1);
      expect(index[index.length - 1]).toMatchObject({ multiLeg: true, pass: true, outDir: root });
    } finally {
      f.cleanup();
    }
  });

  it("cowork-task: leg 2's new task does not see leg 1's outputs, so the resume fails on invocation and the run fails", async () => {
    const f = fixture();
    try {
      const r = await cli(f, ["run", scenario(f, "cowork-task"), "--output-format", "json"]);
      expect(r.code).toBe(1);
      const env = JSON.parse(r.stdout);
      expect(env.ok).toBe(false);
      const resume = env.multiLeg.legs.find((l: { id: string }) => l.id === "resume");
      expect(resume.status).toBe("failed");
      const failures = resume.verdict.failures.map((x: { message: string }) => x.message).join("\n");
      expect(failures).toMatch(/status/); // the fresh run parked again: status is waiting, not complete
      expect(failures).toMatch(/invocation/);
      const root = onlyRun(f);
      expect(existsSync(join(root, "legs", "ask", "work"))).toBe(true);
      expect(existsSync(join(root, "legs", "resume", "work"))).toBe(true);
    } finally {
      f.cleanup();
    }
  });
});
