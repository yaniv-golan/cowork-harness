// `answer_channel: none` end to end over a REAL cassette: `record` drives a stub agent through the protocol tier (no
// model call), then `replay`, `--assert-from`, `verify-run` and `record --dry-run` run on what it wrote. The stub
// writes the skill's status file to $COWORK_ARTIFACTS_ROOT and ends on a question in prose, as the live agent did.
// Synthetic data only.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLI, POSIX, QUESTION_FRAME, exited, makeStubFixture, spawnCli, type StubFixture } from "./helpers/stub-agent.js";

const can = POSIX && existsSync(CLI);
const DUMMY = { ANTHROPIC_API_KEY: "stub-placeholder-not-a-credential" };
const out = (o: unknown) => `printf '%s\\n' '${JSON.stringify(o)}'`;
const STUB = [
  `printf '%s\\n' "$@" > "$STUB_ARGV"`,
  `mkdir -p "$COWORK_ARTIFACTS_ROOT/runs/r1"`,
  `printf '{"status": "waiting"}' > "$COWORK_ARTIFACTS_ROOT/runs/r1/run_status.json"`,
  out({ type: "system", subtype: "init", session_id: "stub", model: "claude-sonnet-5", tools: [], cwd: "/tmp" }),
  // The skill's script runs first, as on the live agent: a tool before the question is what the ordinary stall rule
  // cannot see past.
  out({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "python3 step1.py" } }] },
    session_id: "stub",
  }),
  out({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "waiting at g1" }] },
    session_id: "stub",
  }),
  out({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "The run is waiting at gate g1. Which option, a or b?" }] },
    session_id: "stub",
  }),
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Which option, a or b?",
    session_id: "stub",
    num_turns: 1,
    total_cost_usd: 0.01,
    usage: { input_tokens: 1, output_tokens: 1 },
  }),
  "cat >/dev/null",
].join("\n");

const PARKED = "  - artifact_json: { artifact: outputs/artifacts/runs/r1/run_status.json, path: status, equals: waiting }";

function fixture(body = STUB): StubFixture & { argv: string } {
  const f = makeStubFixture(body, DUMMY);
  const argv = join(f.root, "stub.argv");
  f.env.STUB_ARGV = argv;
  // The protocol probe reads the host `claude --help`: list the option and its `none` value before the stub's own list.
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
  return { ...f, argv };
}
function scenario(f: StubFixture, file: string, assert: string[]): string {
  const p = join(f.cwd, file);
  writeFileSync(
    p,
    ["name: ac", "baseline: latest", "session: ./s.yaml", "fidelity: protocol", "prompt: run the gated probe", "assert:", ...assert].join(
      "\n",
    ) + "\n",
  );
  return p;
}
async function cli(f: StubFixture, args: string[]) {
  const c = spawnCli(f, args);
  const r = await exited(c, 60_000);
  return { ...r, stdout: c.stdoutText(), stderr: c.stderrText() };
}
const codes = (r: { verdict: { signals: { code: string; severity: string }[] } }) =>
  r.verdict.signals.map((s) => `${s.code}:${s.severity}`);

describe.runIf(can)("answer_channel: none over a recorded cassette (stub agent, protocol)", () => {
  it("records, replays and refuses a re-grade the run itself would refuse", async () => {
    const f = fixture();
    try {
      const good = scenario(f, "ac.yaml", [PARKED]);
      const cass = join(f.cwd, "ac.cassette.json");

      // Live: the spawn carries the flag, the env carries the artifacts root, and the run is parked, not stalled.
      const rec = await cli(f, ["record", good, "--out", cass, "--output-format", "json"]);
      expect(rec.code, rec.stderr).toBe(0);
      const live = JSON.parse(rec.stdout).results[0];
      expect(live.answerChannel).toBe("none");
      expect(codes(live)).toContain("parked_at_question:warn");
      expect(codes(live).some((c: string) => c.startsWith("stalled"))).toBe(false);
      const argv = readFileSync(f.argv, "utf8").split("\n");
      expect(argv[argv.indexOf("--permission-prompts") + 1]).toBe("none");
      expect(argv).not.toContain("--permission-prompt-tool");
      expect(readFileSync(f.envDump, "utf8")).toMatch(/^COWORK_ARTIFACTS_ROOT=.*\/outputs\/artifacts$/m);

      // The cassette freezes the channel and stamps v15.
      const c = JSON.parse(readFileSync(cass, "utf8"));
      expect({ answerChannel: c.answerChannel, v: c.cassetteVersion }).toEqual({ answerChannel: "none", v: 15 });

      // Replay re-drives with the channel still absent: parked again.
      const rep = await cli(f, ["replay", cass, "--output-format", "json"]);
      expect(rep.code, rep.stderr).toBe(0);
      expect(codes(JSON.parse(rep.stdout).results[0])).toContain("parked_at_question:warn");

      // Without the frozen field the same events replay WITH a channel: a tool ran before the question, so the ordinary
      // stall rule does not fire and the stop goes unreported. This is what the freeze is for.
      const bare = join(f.cwd, "bare.cassette.json");
      delete c.answerChannel;
      writeFileSync(bare, JSON.stringify(c));
      const repBare = await cli(f, ["replay", bare, "--output-format", "json"]);
      expect(repBare.code, repBare.stderr).toBe(0);
      expect(codes(JSON.parse(repBare.stdout).results[0]).filter((x: string) => /parked|stalled/.test(x))).toEqual([]);

      // A block the run would refuse at load is refused on every re-grade path too, and before spending.
      const bad = scenario(f, "bad.yaml", [PARKED, "  - questions_count_max: 0"]);
      const af = await cli(f, ["replay", cass, "--assert-from", bad]);
      expect(af.code).not.toBe(0);
      expect(af.stderr).toMatch(/answer_channel: none.*questions_count_max/);
      const vr = await cli(f, ["verify-run", live.outDir, bad]);
      expect(vr.code).not.toBe(0);
      expect(vr.stderr + vr.stdout).toMatch(/answer_channel: none.*questions_count_max/);
      const dry = await cli(f, ["record", bad, "--out", join(f.cwd, "bad.cassette.json"), "--dry-run"]);
      expect(dry.code).not.toBe(0);
      expect(dry.stderr + dry.stdout).toMatch(/answer_channel: none.*questions_count_max/);
      // The accepted block still verifies.
      const ok = await cli(f, ["verify-run", live.outDir, good]);
      expect(ok.code, ok.stderr).toBe(0);

      // Removing the key from the session makes the recording stale: it no longer describes this session.
      writeFileSync(
        join(f.cwd, "s.yaml"),
        ["permission_mode: bypassPermissions", "agent_env:", "  artifacts_root: artifacts"].join("\n") + "\n",
      );
      const stale = await cli(f, ["verify-cassettes", cass]);
      expect(stale.code).toBe(1);
      expect(stale.stderr + stale.stdout).toMatch(/session-shape fingerprint/);
    } finally {
      f.cleanup();
    }
  }, 180_000);
});

// An agent that ignored the flag and sent a question anyway: refused, never answered, and the run ends in error, live
// and again on replay of its recording.
const VIOLATING = [
  `printf '%s\\n' "$@" > "$STUB_ARGV"`,
  out({ type: "system", subtype: "init", session_id: "stub", model: "claude-sonnet-5", tools: [], cwd: "/tmp" }),
  `printf '%s\\n' '${QUESTION_FRAME}'`,
  `while IFS= read -r l; do case "$l" in *control_response*) printf '%s\\n' "$l" > "$STUB_ARGV.reply"; break;; esac; done`,
  out({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "stub", num_turns: 1, total_cost_usd: 0.01 }),
  "cat >/dev/null",
].join("\n");

describe.runIf(can)("a request that reaches the harness anyway (stub agent, protocol)", () => {
  it("is denied, ends the run in error, and replays the same way", async () => {
    const f = fixture(VIOLATING);
    try {
      const sc = scenario(f, "v.yaml", [PARKED]);
      const cass = join(f.cwd, "v.cassette.json");
      const rec = await cli(f, ["record", sc, "--out", cass, "--allow-failing", "--output-format", "json"]);
      const live = JSON.parse(rec.stdout).results[0];
      expect({ result: live.result, errorSource: live.errorSource }).toEqual({ result: "error", errorSource: "answer_channel_violation" });
      // The reply the agent got: a deny, never an answer.
      const reply = readFileSync(`${f.argv}.reply`, "utf8");
      expect(reply).toMatch(/"behavior":"deny"/);
      expect(reply).not.toMatch(/"answers"/);
      const rep = await cli(f, ["replay", cass, "--output-format", "json"]);
      expect(rep.code).toBe(1);
      const r = JSON.parse(rep.stdout).results[0];
      expect({ result: r.result, errorSource: r.errorSource }).toEqual({ result: "error", errorSource: "answer_channel_violation" });
    } finally {
      f.cleanup();
    }
  }, 180_000);
});
