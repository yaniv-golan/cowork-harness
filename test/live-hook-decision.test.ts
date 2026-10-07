import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { loadBaseline, resolveAgentBinary } from "../src/baseline.js";
import { loadDotenv } from "../src/dotenv.js";

/**
 * A plugin's command hooks deciding by both channels, end to end at `container`: a PreToolUse hook that denies by
 * JSON on stdout (exit 0), one that exits 2, and a Stop hook that blocks once by JSON. Graded through
 * `hook_decision`, the count form of `hook_event_blocked` with `via`, and the probe's other hook assertions.
 *
 * Why live: the evaluator's unit tests read frames copied from ONE recording of this probe
 * (test/fixtures/hook-frames/hook-decision.events.jsonl). If the agent moves the JSON off `stdout`, renames
 * `hook_name`'s `<event>:<tool>` form, or changes how an exit-2 PreToolUse frame looks, those tests stay green over a
 * stale fixture and a cassette replays the old shape; only a fresh run notices.
 *
 * Spend is bounded three ways: `--max-budget-usd` refuses the run before it starts when the scenario's cost history
 * predicts more than the cap; the session's `agent_max_turns: 8` and the scenario's `timeout_ms: 180000` stop the
 * agent; and the scenario's `max_cost_usd: 0.25` fails a run that cost more. The recorded run took 4 turns, 13 s and
 * $0.066. The harness gets no cost signal mid-run, so no cap aborts on dollars.
 *
 * Gated like live-stop-hook.test.ts (Docker + image + staged agent + token); skips otherwise, loudly.
 * Run: CLAUDE_CODE_OAUTH_TOKEN=$(cat ~/.cowork-harness-token) vitest run --config vitest.config.live.ts live-hook-decision
 */
loadDotenv(); // same credential source the CLI itself uses; an exported var still wins
const IMAGE = process.env.COWORK_AGENT_IMAGE?.trim() || "cowork-agent-base:2";
const BUDGET_USD = "0.25";
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
    `::warning:: live-hook-decision SKIPPED — NOT live-validated (docker=${dockerOk} image=${imageOk} agent=${!!AGENT} token=${!!TOKEN})\n`,
  );

type Graded = { pass: boolean; assertion?: Record<string, unknown>; message?: string };

describe.skipIf(!CAN)("live: plugin hooks decide by JSON and by exit 2, and the hook keys grade them (container)", () => {
  it("hook_decision, hook_event_blocked (bare and via) and the probe's other assertions pass on fresh frames", () => {
    const r = spawnSync(
      "node",
      [
        resolve("dist/cli.js"),
        "run",
        "examples/probes/hook-decision-probe.scenario.yaml",
        "--max-budget-usd",
        BUDGET_USD,
        "--output-format",
        "json",
      ],
      { encoding: "utf8", env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, timeout: 300_000 },
    );
    expect(r.status, `run exited ${r.status}\n${r.stderr}\n${r.stdout.slice(0, 2000)}`).toBe(0);
    const out = JSON.parse(r.stdout);
    const graded: Graded[] = (out.results ?? []).flatMap((res: { assertions?: Graded[] }) => res.assertions ?? []);
    const failed = graded.filter((a) => !a.pass);
    expect(graded.length, "expected exactly the probe's twelve assertions").toBe(12);
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
    // Each new key graded a real frame: present, and passing on its own.
    for (const key of ["hook_decision", "hook_event_blocked"]) {
      const of = graded.filter((a) => a.assertion !== undefined && key in a.assertion);
      expect(of.length, `${key} assertions graded`).toBe(3);
      expect(
        of.every((a) => a.pass),
        key,
      ).toBe(true);
    }
  }, 320_000);
});
