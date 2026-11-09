import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * PROVE protocol-tier `--resume` continues the conversation: turn 1 is told a random token, turn 2 is a NEW host
 * agent process started with `--resume`, and it must answer with that token. The assertion is on the outcome
 * (turn 2's final message), not on argv; test/protocol-session-argv-e2e.test.ts is the argv test.
 *
 * The second suite PROVES the session's `agent_max_turns` reaches the protocol agent and stops it: the agent's own result
 * frame must say `error_max_turns` after one model request and one tool call, and `allow_max_turns` must count it as completed.
 *
 * Billed (two short model turns, then one capped run). It runs ONLY on an explicit opt-in, never on token presence alone:
 *   COWORK_LIVE_PROTOCOL_RESUME=1 npm run test:live -- live-protocol-resume
 * COWORK_LIVE_REQUIRE=1 turns a missing prerequisite into a failure instead of a skip. The opt-in is one of those
 * prerequisites, so a release gate that sets COWORK_LIVE_REQUIRE=1 must also set COWORK_LIVE_PROTOCOL_RESUME=1.
 */
const OPT_IN = process.env.COWORK_LIVE_PROTOCOL_RESUME === "1";
const REQUIRE = process.env.COWORK_LIVE_REQUIRE === "1";
// Resolved once for the whole live lane by test/setup/live-token.ts (vitest.config.live.ts `setupFiles`).
const TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "";
const CLI = resolve("dist/cli.js");
const CAN = OPT_IN && !!TOKEN && existsSync(CLI);

if (!CAN && (OPT_IN || REQUIRE))
  process.stderr.write(
    `::warning:: live-protocol-resume SKIPPED — NOT live-validated (opt-in=${OPT_IN} token=${!!TOKEN} cli=${existsSync(CLI)})\n`,
  );

function runSkill(folder: string, prompt: string, sessionId: string, resume: boolean, runsDir: string) {
  const args = ["skill", folder, prompt, "--fidelity", "protocol", "--session-id", sessionId, "--output-format", "json"];
  if (resume) args.push("--resume");
  const r = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: TOKEN, COWORK_HARNESS_GITSET: "0", COWORK_HARNESS_RUNS_DIR: runsDir },
    timeout: 240_000,
  });
  const res = JSON.parse(r.stdout || "{}").results?.[0] ?? {};
  return { finalMessage: String(res.finalMessage ?? ""), result: res.result, turn: res.turn, stderr: r.stderr };
}

/** The pinned session's run dir: the one holding `session.json`. */
function sessionDir(root: string): string | undefined {
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const p = join(root, e.name);
    if (existsSync(join(p, "session.json"))) return p;
    const deeper = sessionDir(p);
    if (deeper) return deeper;
  }
  return undefined;
}

describe.runIf(CAN || REQUIRE)("protocol --resume conversation continuity (billed, opt-in)", () => {
  it("turn 2 (a new agent process, --resume) recalls a token told only to turn 1", () => {
    expect(CAN, "prerequisites missing under COWORK_LIVE_REQUIRE=1").toBe(true);
    const folder = mkdtempSync(join(tmpdir(), "cwh-presume-skill-"));
    const runsDir = mkdtempSync(join(tmpdir(), "cwh-presume-runs-"));
    const token = `K${randomBytes(4).toString("hex").toUpperCase()}`;
    try {
      mkdirSync(join(folder, ".claude-plugin"), { recursive: true });
      writeFileSync(join(folder, "SKILL.md"), "---\nname: helper\ndescription: A helper skill.\n---\n\n# helper\n\nAssist the user.\n");
      const sid = `protocol-resume-${process.pid}`;
      const t1 = runSkill(folder, `Remember this codeword for later in our conversation: ${token}. Just say OK.`, sid, false, runsDir);
      expect(t1.result, t1.stderr).toBe("success");

      // The agent persisted the session in the run's managed config dir — the only config dir a protocol agent reads.
      const dir = sessionDir(runsDir)!;
      const { agentSessionId } = JSON.parse(readFileSync(join(dir, "session.json"), "utf8"));
      const projects = join(dir, "claude-config", "projects");
      const stored = existsSync(projects) && readdirSync(projects).some((p) => existsSync(join(projects, p, `${agentSessionId}.jsonl`)));
      expect(stored, `turn 1's transcript is under ${projects}`).toBe(true);

      const t2 = runSkill(folder, "What codeword did I ask you to remember? Reply with only that word.", sid, true, runsDir);
      expect(t2.result, t2.stderr).toBe("success");
      expect(t2.turn).toBe(2);
      expect(t2.finalMessage, `turn 2 must recall the turn-1 codeword — got: ${t2.finalMessage}`).toContain(token);
    } finally {
      rmSync(folder, { recursive: true, force: true });
      rmSync(runsDir, { recursive: true, force: true });
    }
  }, 600_000);
});

describe.runIf(CAN || REQUIRE)("protocol agent_max_turns stops the agent at the cap (billed, opt-in)", () => {
  it("agent_max_turns: 1 ⇒ the agent stops with error_max_turns after one model request and one tool call, and allow_max_turns completes it", () => {
    expect(CAN, "prerequisites missing under COWORK_LIVE_REQUIRE=1").toBe(true);
    const dir = mkdtempSync(join(tmpdir(), "cwh-pcap-"));
    const runsDir = mkdtempSync(join(tmpdir(), "cwh-pcap-runs-"));
    try {
      const session = join(dir, "capped.session.yaml");
      writeFileSync(session, "model: claude-haiku-4-5\npermission_parity: cowork\nagent_max_turns: 1\n");
      const scenario = join(dir, "capped.yaml");
      writeFileSync(
        scenario,
        `baseline: latest\nfidelity: protocol\nsession: ${session}\n` +
          "prompt: Run `echo one` with the Bash tool. After it returns, run `echo two` as a separate Bash call. Then tell me both outputs.\n" +
          "assert:\n  - allow_max_turns: true\n  - result: error\n",
      );
      const r = spawnSync("node", [CLI, "run", scenario, "--output-format", "json"], {
        encoding: "utf8",
        env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: TOKEN, COWORK_HARNESS_GITSET: "0", COWORK_HARNESS_RUNS_DIR: runsDir },
        timeout: 240_000,
      });
      const res = JSON.parse(r.stdout || "{}").results?.[0] ?? {};
      // The agent's own outcome, from its result frame: the cap stopped it, at the cap.
      expect(res.resultSubtype, r.stderr).toBe("error_max_turns");
      // The cap held: one model request and one tool call, so the second `echo` never ran. The agent's `num_turns`
      // is not pinned: 2.1.319 reports 2 for this same run.
      const frames = readFileSync(join(res.outDir, "events.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      const assistant = frames.filter((f) => f.type === "assistant");
      expect(new Set(assistant.map((f) => f.message.id)).size).toBe(1);
      expect(assistant.flatMap((f) => f.message.content).filter((c) => c.type === "tool_use")).toHaveLength(1);
      expect(res.turnCap).toEqual({ maxTurns: 1, source: "session" });
      expect(res.result).toBe("error");
      expect(res.verdict?.pass, JSON.stringify(res.verdict?.signals)).toBe(true);
      expect(r.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(runsDir, { recursive: true, force: true });
    }
  }, 300_000);
});
