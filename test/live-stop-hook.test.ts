import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { loadBaseline, resolveAgentBinary } from "../src/baseline.js";
import { loadDotenv } from "../src/dotenv.js";

/**
 * A plugin's Stop hook, end to end at `container`: the harness passes --include-hook-events (the plugin
 * declares hooks), the hook blocks once (exit 2), the agent resends with the demanded word, and all of it
 * is graded through `hook_event_fired` / `hook_event_blocked`.
 *
 * Why live: the evaluator's unit tests run over frames copied from ONE recording of this same probe. If
 * the agent changes the frame shape, drops exit_code, or moves the emit gate, the unit tests stay green
 * against a stale fixture while every real run fails. This is the only thing that notices.
 *
 * Gated like live-outputs-delete.test.ts (Docker + image + staged agent + token); skips otherwise, loudly.
 * Run: CLAUDE_CODE_OAUTH_TOKEN=$(cat ~/.cowork-harness-token) vitest run --config vitest.config.live.ts live-stop-hook
 */
loadDotenv(); // same credential source the CLI itself uses; an exported var still wins
const IMAGE = process.env.COWORK_AGENT_IMAGE?.trim() || "cowork-agent-base:2";
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

// A silent skip is the failure mode this lane is prone to — say so on stderr.
if (!CAN)
  process.stderr.write(
    `::warning:: live-stop-hook SKIPPED — NOT live-validated (docker=${dockerOk} image=${imageOk} agent=${!!AGENT} token=${!!TOKEN})\n`,
  );

describe.skipIf(!CAN)("live: plugin Stop hook blocks once and is graded (container)", () => {
  it("hook_event_fired: Stop, hook_event_blocked: Stop, the hook's stderr and the resent PINEAPPLE all pass", () => {
    const r = spawnSync(
      "node",
      [resolve("dist/cli.js"), "run", "examples/probes/stop-hook-probe.scenario.yaml", "--output-format", "json"],
      { encoding: "utf8", env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, timeout: 600_000 },
    );
    expect(r.status, `run exited ${r.status}\n${r.stderr}\n${r.stdout.slice(0, 2000)}`).toBe(0);
    const out = JSON.parse(r.stdout);
    const assertions = (out.results ?? []).flatMap(
      (res: { assertions?: { pass: boolean; assertion?: unknown; message?: string }[] }) => res.assertions ?? [],
    );
    const failed = assertions.filter((a: { pass: boolean }) => !a.pass);
    expect(assertions.length, "expected exactly the probe's four assertions").toBe(4);
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
  }, 620_000);
});
