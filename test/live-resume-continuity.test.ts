import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadBaseline, resolveAgentBinary } from "../src/baseline.js";

/**
 * B2: PROVE container-tier --resume actually reloads the conversation across a fresh container.
 *
 * The --session-id + --resume plumbing was wired and argv-tested (test/session.test.ts) but never
 * proven end-to-end: does the native agent session persist in the bind-mounted mnt/.claude (not the
 * tmpfs HOME=/tmp) and reload the prior turn in a NEW container? This test establishes a secret in
 * turn 1, then resumes in turn 2 and checks the agent recalls it — continuity that only holds if the
 * session store survived the container boundary.
 *
 * Live-lane, gated on Docker + the staged agent + a token; skips cleanly otherwise (same convention as
 * live-contract.test.ts). Run: CLAUDE_CODE_OAUTH_TOKEN=$(cat ~/.cowork-harness-token) vitest run live-resume-continuity
 */
const IMAGE = "cowork-agent-base:2";
let AGENT = "";
try {
  AGENT = resolveAgentBinary(loadBaseline("latest"));
} catch {
  /* baseline/binary missing → skip */
}
const dockerOk = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
const imageOk = dockerOk && spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" }).status === 0;
const TOKEN =
  process.env.CLAUDE_CODE_OAUTH_TOKEN ||
  (existsSync(`${homedir()}/.cowork-harness-token`) ? readFileSync(`${homedir()}/.cowork-harness-token`, "utf8").trim() : "");
const CAN = dockerOk && imageOk && !!AGENT && existsSync(AGENT) && !!TOKEN;
const CLI = resolve("dist/cli.js");

function runSkill(
  folder: string,
  prompt: string,
  sessionId: string,
  resume: boolean,
): { finalMessage: string; result: string; effectiveFidelity: string; turn?: number } {
  const args = [
    "skill",
    folder,
    prompt,
    "--fidelity",
    "container",
    "--session-id",
    sessionId,
    "--output-format",
    "json",
    "--on-unanswered",
    "first",
  ];
  if (resume) args.push("--resume");
  const r = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: TOKEN, COWORK_HARNESS_GITSET: "0" },
    timeout: 240_000,
  });
  const env = JSON.parse(r.stdout || "{}");
  const res = env.results?.[0] ?? {};
  return { finalMessage: res.finalMessage ?? "", result: res.result ?? "", effectiveFidelity: res.effectiveFidelity ?? "", turn: res.turn };
}

describe.skipIf(!CAN)("container --resume conversation continuity (B2)", () => {
  it("turn 2 (resumed) recalls a secret established in turn 1 — the session survived the container boundary", () => {
    const folder = mkdtempSync(join(tmpdir(), "cwh-resume-skill-"));
    // minimal, valid skill so the mount isn't empty (copied raw — outside any repo, GITSET=0)
    mkdirSync(join(folder, ".claude-plugin"), { recursive: true });
    writeFileSync(join(folder, "SKILL.md"), "---\nname: helper\ndescription: A helper skill.\n---\n\n# helper\n\nAssist the user.\n");

    const sid = `resume-continuity-${process.pid}`;
    const t1 = runSkill(
      folder,
      "Please remember this fact for later in our conversation: my project's codeword is ZEPHYR7. Just say OK.",
      sid,
      false,
    );
    expect(t1.result, "turn 1 should complete").toBe("success");
    expect(t1.effectiveFidelity, "turn 1 must actually run in a container").toBe("container");

    const t2 = runSkill(folder, "What codeword did I ask you to remember? Reply with only that word.", sid, true);
    expect(t2.result, "turn 2 (resumed) should complete").toBe("success");
    // turn 2 is a fresh container — recalling the codeword proves the agent session reloaded across it
    expect(t2.finalMessage, `turn 2 must recall the turn-1 codeword — got: ${t2.finalMessage}`).toMatch(/ZEPHYR7/i);
  }, 300_000);
});
