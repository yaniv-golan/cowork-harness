import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Live matrix tests (E3's own "optional live e2e", plus a regression pin for the Fable/Opus-found
 * "one cell's unanswered gate must not crash the whole matrix" bug; a live test for that specific bug
 * was originally deferred, then built here on request).
 *
 * `fidelity: protocol` (L0) needs NO Docker and NO staged agent — `spawnProtocol` spawns the HOST `claude`
 * from PATH (src/runtime/protocol.ts) and never calls `resolveAgentBinary`. So the gate probes the host
 * CLI + a live token, unlike test/live-contract.test.ts (which does need Docker + the staged binary).
 *
 * The baselines this file matrices over are axis VALUES, not binaries to run: at protocol fidelity they
 * select config, and nothing resolves a staged ELF for them.
 *
 * GATE HISTORY — read before "simplifying" this back. The gate used to require
 * `resolveAgentBinary(loadBaseline("desktop-1.18286.0"))` to exist, on the since-obsoleted reasoning that
 * both matrixed baselines pin the same staged agent (2.1.197) so only one binary would be needed. That
 * binary requirement was never real for this tier, and Desktop PRUNES old staged agents on update — so
 * once the machine moved past 2.1.197 the whole suite `skipIf`-ed itself out on every developer machine
 * and in CI, silently, for many releases. It was found only by auditing which suites a live run had
 * actually executed. Gate on what the tier genuinely uses, never on an incidental artifact.
 *
 * Run locally: CLAUDE_CODE_OAUTH_TOKEN=$(cat ~/.cowork-harness-token) vitest run --config vitest.config.live.ts live-matrix
 */

const CLI = resolve("dist/cli.js");
const cliOk = existsSync(CLI);
// The real dependency: the host `claude` this tier spawns. `--version` (not `command -v`) so a present
// but unrunnable CLI fails the gate rather than producing a confusing mid-test spawn error.
const hostClaudeOk = spawnSync("claude", ["--version"], { stdio: "ignore" }).status === 0;
// Resolved once for the whole live lane by test/setup/live-token.ts (vitest.config.live.ts `setupFiles`).
const TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "";
const CAN = cliOk && hostClaudeOk && !!TOKEN;

// A silent skip is this lane's characteristic failure — vitest.config.live.ts's own header warns a green
// run there can carry ZERO coverage, and this suite spent many releases proving it. Say so on stderr.
if (!CAN)
  process.stderr.write(
    `::warning:: live-matrix SKIPPED — dist/cli.js:${cliOk} host-claude:${hostClaudeOk} token:${!!TOKEN}. ` +
      `This suite is the ONLY protocol-tier live coverage; a green live lane without it verifies container/hostloop only.\n`,
  );

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
  // Deliberately cheap: low effort, thinking disabled, no mounts — this is a live-execution smoke
  // test for the MATRIX RUNNER's own plumbing (cell expansion, per-cell overrides, rollup aggregation),
  // not a test of skill/agent capability, so it should cost as little as possible per cell. (This
  // scenario runs at `fidelity: protocol`, which doesn't wire the thinking flag at all today, but the
  // session must still be the cheapest faithful config.)
  writeFileSync(p, "model: claude-opus-4-8\neffort: low\nextended_thinking: false\npermission_mode: default\npermission_parity: cowork\n");
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
