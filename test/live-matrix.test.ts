import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadBaseline, resolveAgentBinary } from "../src/baseline.js";

/**
 * Live matrix tests (E3's own "optional live e2e", plus a regression pin for the Fable/Opus-found
 * "one cell's unanswered gate must not crash the whole matrix" bug — see docs/internal's Wave 3+4 build
 * notes for why a live test for that specific bug was originally deferred, then built here on request).
 *
 * `fidelity: protocol` (L0) needs NO Docker/staged agent — just the host `claude` CLI + a live token — so
 * gating is token-only, unlike test/live-contract.test.ts (which needs Docker + the staged binary too).
 * Both committed baselines this file matrices over (desktop-1.17377.2, desktop-1.18286.0) resolve to the
 * SAME staged agent version (2.1.197 — confirmed via each baseline's own agentBinary.stagedPath), so this
 * doesn't need two different staged binaries to exercise a genuine 2-value baseline axis.
 *
 * Run locally: CLAUDE_CODE_OAUTH_TOKEN=$(cat ~/.cowork-harness-token) vitest run --config vitest.config.live.ts live-matrix
 */

const CLI = resolve("dist/cli.js");
const cliOk = existsSync(CLI);
let binOk = false;
try {
  binOk = existsSync(resolveAgentBinary(loadBaseline("desktop-1.18286.0")));
} catch {
  binOk = false;
}
const TOKEN =
  process.env.CLAUDE_CODE_OAUTH_TOKEN ||
  (existsSync(`${homedir()}/.cowork-harness-token`) ? readFileSync(`${homedir()}/.cowork-harness-token`, "utf8").trim() : "");
const CAN = cliOk && binOk && !!TOKEN;

function run(args: string[], cwd: string) {
  const r = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    cwd,
    env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
    timeout: 180_000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function leanSession(dir: string): string {
  const p = join(dir, "session.yaml");
  // Deliberately cheap: low effort, small thinking budget, no mounts — this is a live-execution smoke
  // test for the MATRIX RUNNER's own plumbing (cell expansion, per-cell overrides, rollup aggregation),
  // not a test of skill/agent capability, so it should cost as little as possible per cell.
  writeFileSync(p, "model: claude-opus-4-8\neffort: low\nmax_thinking_tokens: 1024\npermission_mode: default\npermission_parity: cowork\n");
  return p;
}

describe.skipIf(!CAN)("live: run --matrix (E3's own live e2e + a regression pin)", () => {
  it("a genuine 2-cell baseline-axis matrix on protocol fidelity: both cells pass, one row each, exit 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "live-matrix-"));
    const sessionPath = leanSession(dir);
    writeFileSync(
      join(dir, "s.yaml"),
      `baseline: latest\nsession: ${sessionPath}\nfidelity: protocol\nprompt: |\n  Ask me to choose between "A" and "B", then reply with just the word "done".\nanswers:\n  - when_question: ".*"\n    choose: "first"\nassert:\n  - result: success\n`,
    );
    writeFileSync(join(dir, "m.yaml"), "baselines: [desktop-1.17377.2, desktop-1.18286.0]\n");

    const r = run(["run", "s.yaml", "--matrix", "m.yaml", "--output-format", "json"], dir);
    expect(r.code, `expected exit 0; stderr:\n${r.stderr}\nstdout:\n${r.stdout}`).toBe(0);
    const line = r.stdout.split("\n").find((l) => l.trim().startsWith("{"));
    expect(line, "expected a JSON envelope line on stdout").toBeTruthy();
    const envelope = JSON.parse(line!);
    expect(envelope.ok).toBe(true);
    expect(envelope.matrix.anyFail).toBe(false);
    expect(envelope.matrix.cells).toHaveLength(2);
    for (const cell of envelope.matrix.cells) {
      expect(cell.pass).toBe(true);
      expect(cell.error).toBeUndefined();
      expect(cell.axes.baseline).toMatch(/^desktop-1\.(17377\.2|18286\.0)$/);
    }
    // both baselines actually got exercised, not the same one twice
    const baselinesSeen = new Set(envelope.matrix.cells.map((c: any) => c.axes.baseline));
    expect(baselinesSeen.size).toBe(2);
    expect(envelope.results).toHaveLength(2); // both cells' raw RunResults are present, nothing hidden
  }, 180_000);

  it(
    "REGRESSION PIN: a matrix cell that hits a genuinely unanswered gate does not crash the whole " +
      "matrix — renders as a distinct cell error, sibling cells still complete, exit 1 with a full rollup " +
      "(not a process crash / bare jsonError envelope)",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "live-matrix-unanswered-"));
      const sessionPath = leanSession(dir);
      // NO `answers:` entries at all + the default on_unanswered:"fail" — the explicit imperative
      // instruction reliably makes the model call AskUserQuestion, which then has nothing to answer it.
      writeFileSync(
        join(dir, "s.yaml"),
        `baseline: latest\nsession: ${sessionPath}\nfidelity: protocol\nprompt: |\n  Call the AskUserQuestion tool right now, asking me to choose between "Option A" and "Option B". Do not do anything else first.\nassert:\n  - result: success\n`,
      );
      writeFileSync(join(dir, "m.yaml"), "baselines: [desktop-1.17377.2, desktop-1.18286.0]\n");

      // --concurrency 1 (sequential, the default) so cell ordering is deterministic — if the bug this
      // pins ever regressed, cell 1's UnansweredError would process.exit() before cell 2 ever ran.
      const r = run(["run", "s.yaml", "--matrix", "m.yaml", "--output-format", "json"], dir);
      expect(r.code, `expected exit 1 (both cells hit the unanswered gate); stderr:\n${r.stderr}\nstdout:\n${r.stdout}`).toBe(1);
      const line = r.stdout.split("\n").find((l) => l.trim().startsWith("{"));
      expect(line, "expected a full matrix JSON envelope on stdout — a crash would emit a bare jsonError instead").toBeTruthy();
      const envelope = JSON.parse(line!);
      expect(envelope.command).toBe("run"); // not the error envelope's {ok:false, error:{category:"unanswered",...}} shape
      expect(envelope.matrix).toBeDefined();
      expect(envelope.matrix.cells).toHaveLength(2); // BOTH cells completed — proves cell 1 didn't abort cell 2
      expect(envelope.matrix.anyFail).toBe(true);
      for (const cell of envelope.matrix.cells) {
        expect(cell.pass).toBe(false);
        expect(cell.error).toBeDefined();
        expect(cell.error).toMatch(/unanswered/i);
        expect(cell.failedAssertions).toEqual([]); // an infra/gate error is never conflated with a real assertion failure
      }
    },
    180_000,
  );
});
