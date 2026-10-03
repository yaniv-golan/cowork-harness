import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initMemoryPaths } from "./helpers/init-memory-paths.js";

/**
 * Live, AFTER half of the auto-memory witness (the BEFORE half is in test/auto-memory-env.test.ts: every committed
 * pre-fix cassette's init frame carries `memory_paths`). With the recorded gate 123929380 off — every committed
 * baseline — the harness sends CLAUDE_CODE_DISABLE_AUTO_MEMORY:"1", and the agent then writes NO `memory_paths`
 * into its init frame. The builder tests prove the env is built; this proves a spawned agent actually honoured it.
 *
 * BILLED. The RELEASING.md live-gate step runs it once per tier:
 *   COWORK_LIVE_AUTO_MEMORY_FIDELITY=protocol|container|hostloop (default protocol)
 *   COWORK_LIVE_REQUIRE=1 — a missing prerequisite FAILS the suite instead of skipping it, so a skip cannot read
 *   as a pass.
 * `protocol` runs the HOST `claude` on PATH, not the staged agent Cowork runs; `container` (Docker + image +
 * staged binary) and `hostloop` (macOS + staged native app) run the staged agent.
 */

const FIDELITY = process.env.COWORK_LIVE_AUTO_MEMORY_FIDELITY ?? "protocol";
const REQUIRE = process.env.COWORK_LIVE_REQUIRE === "1";
const CLI = resolve("dist/cli.js");
const cliOk = existsSync(CLI);
// Only protocol needs the host CLI; the other tiers' own prerequisites fail the run loudly if missing.
const hostClaudeOk = FIDELITY !== "protocol" || spawnSync("claude", ["--version"], { stdio: "ignore" }).status === 0;
const TOKEN =
  process.env.CLAUDE_CODE_OAUTH_TOKEN ||
  (existsSync(`${homedir()}/.cowork-harness-token`) ? readFileSync(`${homedir()}/.cowork-harness-token`, "utf8").trim() : "");
const CAN = cliOk && hostClaudeOk && !!TOKEN;
const why = `dist/cli.js:${cliOk} host-claude:${hostClaudeOk} token:${!!TOKEN}`;
if (!CAN) process.stderr.write(`::warning:: live-auto-memory (${FIDELITY}) SKIPPED — ${why}.\n`);

describe.runIf(REQUIRE && !CAN)("live-auto-memory prerequisites (COWORK_LIVE_REQUIRE=1)", () => {
  it("are present", () => expect(CAN, `missing prerequisite — ${why}`).toBe(true));
});

describe.skipIf(!CAN)(`live: the init frame carries no memory_paths when the recorded gate is off (${FIDELITY})`, () => {
  it(`${FIDELITY}, baseline latest`, () => {
    const dir = mkdtempSync(join(tmpdir(), "live-auto-memory-"));
    writeFileSync(join(dir, "session.yaml"), "effort: low\nextended_thinking: false\npermission_mode: default\n");
    const file = join(dir, "s.yaml");
    writeFileSync(
      file,
      `baseline: latest\nsession: ./session.yaml\nfidelity: ${FIDELITY}\nprompt: |\n  Reply with just the word "done".\nassert:\n  - result: success\n`,
    );
    const r = spawnSync("node", [CLI, "--run-dir", join(dir, "runs"), "run", file, "--output-format", "json"], {
      encoding: "utf8",
      cwd: dir,
      env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
      timeout: 300_000,
    });
    const res = JSON.parse(r.stdout).results?.[0];
    expect(res, `no result envelope; stderr: ${r.stderr.slice(-400)}`).toBeTruthy();
    const events = join(res.outDir, "events.jsonl");
    process.stderr.write(`live-auto-memory (${FIDELITY}): checked ${events}\n`);
    const seen = initMemoryPaths(readFileSync(events, "utf8").split("\n").filter(Boolean));
    expect(seen.initSeen, "no init frame recorded — nothing to judge").toBe(true);
    expect(seen.memoryPaths).toBeUndefined();
  }, 330_000);
});
