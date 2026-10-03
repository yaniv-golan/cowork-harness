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
 * `fidelity: protocol` needs only the host `claude` and a token (no Docker, no staged agent), like live-matrix.
 * BILLED. Run: CLAUDE_CODE_OAUTH_TOKEN=$(cat ~/.cowork-harness-token) vitest run --config vitest.config.live.ts live-auto-memory
 * For the other tiers, the RELEASING.md live-gate step reads the same field from a container or hostloop run.
 */

const CLI = resolve("dist/cli.js");
const cliOk = existsSync(CLI);
const hostClaudeOk = spawnSync("claude", ["--version"], { stdio: "ignore" }).status === 0;
const TOKEN =
  process.env.CLAUDE_CODE_OAUTH_TOKEN ||
  (existsSync(`${homedir()}/.cowork-harness-token`) ? readFileSync(`${homedir()}/.cowork-harness-token`, "utf8").trim() : "");
const CAN = cliOk && hostClaudeOk && !!TOKEN;
if (!CAN)
  process.stderr.write(`::warning:: live-auto-memory SKIPPED — dist/cli.js:${cliOk} host-claude:${hostClaudeOk} token:${!!TOKEN}.\n`);

describe.skipIf(!CAN)("live: the init frame carries no memory_paths when the recorded gate is off", () => {
  it("protocol, baseline latest", () => {
    const dir = mkdtempSync(join(tmpdir(), "live-auto-memory-"));
    writeFileSync(join(dir, "session.yaml"), "effort: low\nextended_thinking: false\npermission_mode: default\n");
    const file = join(dir, "s.yaml");
    writeFileSync(
      file,
      `baseline: latest\nsession: ./session.yaml\nfidelity: protocol\nprompt: |\n  Reply with just the word "done".\nassert:\n  - result: success\n`,
    );
    const r = spawnSync("node", [CLI, "--run-dir", join(dir, "runs"), "run", file, "--output-format", "json"], {
      encoding: "utf8",
      cwd: dir,
      env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
      timeout: 180_000,
    });
    const res = JSON.parse(r.stdout).results?.[0];
    expect(res, `no result envelope; stderr: ${r.stderr.slice(-400)}`).toBeTruthy();
    const lines = readFileSync(join(res.outDir, "events.jsonl"), "utf8").split("\n").filter(Boolean);
    const seen = initMemoryPaths(lines);
    expect(seen.initSeen, "no init frame recorded — nothing to judge").toBe(true);
    expect(seen.memoryPaths).toBeUndefined();
  });
});
