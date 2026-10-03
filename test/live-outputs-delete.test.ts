import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadBaseline, resolveAgentBinary } from "../src/baseline.js";

/**
 * PROVE the outputs-delete guard matches the real product, end to end.
 *
 * ── WHAT THE PRODUCT DOES, PER RELEASE ───────────────────────────────────────────────────────────
 *
 * From Desktop 2.16120.0 a normal Cowork session mounts outputs `rwd`: deletes there succeed (measured on
 * 2.19675.0: `rm`, `mv` and overwrite-by-rename, no permission card). Before that outputs was `rw` and
 * `unlink`/`rmdir` failed with EPERM. The harness's DEFAULT verdict follows the baseline's recorded mode
 * (persisted as `result.outputsMountMode`); `no_delete_in_outputs: true` checks on every baseline. So the
 * expectations below depend on the `latest` baseline, read from its RAW JSON — never through the harness's own
 * helper, which is the code under test. `allow_outputs_delete` has no live exercise here while `latest` records
 * `rwd`: it has nothing to waive there (its verdict side is unit-tested on an `rw`-stamped result).
 *
 * The scanner is LIVE-ONLY — cassettes carry no `scan` and `no_delete_in_outputs` is in
 * `LIVE_ONLY_KEYS` — so replay is structurally blind to it and unit tests only ever exercise
 * `isOutputsDelete` in isolation. Nothing else covers agent → bash → events.jsonl → scan → verdict,
 * which is how a wrong RULE (treating `truncate` as a delete) survived to a consumer: the tests pinned
 * the implementation precisely, against a policy nobody had measured.
 *
 * ── WHY THESE ARE ORDINARY TASKS, NOT PINNED COMMANDS ────────────────────────────────────────────
 *
 * This suite used to hand the agent a byte-pinned destructive command wrapped in a stack of
 * prohibitions ("run this EXACTLY as written… do not modify it… do not run any other command") plus an
 * unexplained sentinel token, and assert the command came back verbatim. The agent increasingly refused
 * — not over the file operation, but over the framing. Measured across 27 case-runs the refusal rate was
 * 41%, and a refused case SKIPS, so it verifies nothing. Every case was refused at least once; the worst
 * sat at 67%.
 *
 * Two attempts are recorded so they are not retried blind:
 *   - Explaining the request (stated purpose, what the marker was for, "the command seeds its own file")
 *     made it WORSE — refusals rose, `truncate` was refused for the first time in six runs, and the
 *     verbatim check failed for the first time in 27 executions. The agent named the additions as the
 *     tell: *"'testing a safety guard,' 'run exactly as written,' a made-up-looking marker to 'match
 *     against logs' … is a common pattern for getting an assistant to execute something without
 *     scrutinizing it"*. Explaining the marker made it read MORE like a canary, not less.
 *   - Retargeting one case away from `/tmp` helped that case (4/6 refusals → 2/4), since all four of its
 *     refusals had objected to the destination. It did not fix the class.
 *
 * What fixes the class is asking for a REAL TASK whose completion requires the file operation. The agent
 * has no delete tool, so removing a file must go through Bash — the exact path the guard watches — and a
 * benign creative task gives it no reason to refuse. Measured: 6/6 case-runs complied, 0 refusals —
 * 3 per case, re-derivable at any time by counting the surviving `cwh-od-*` dirs whose `s.yaml`
 * mentions a poem. Re-derive rather than inherit this figure: earlier drafts of these comments said
 * 4/4 and 2/2 for the two cases, and the run dirs say 3 and 3.
 *
 * The trade, stated plainly: the agent picks its own filenames and command form (observed: absolute
 * `/sessions/<id>/mnt/outputs/…` paths, `poem1`/`poem_a` names, a `python3 -c random.choice` to choose),
 * so nothing can be byte-pinned. Assertions are on SHAPE (how many deletes, under outputs or not, guard
 * status) plus something the pinned suite never checked at all: the real filesystem EFFECT — that the
 * file is actually gone. `scanEvents` flags the tool_use, i.e. the INTENT; checking what survives in
 * `mnt/outputs` is what separates "it was proposed" from "it happened".
 *
 * The two cases are a POLARITY PAIR: one task must trip the guard, one must not. Command-form
 * distinctions that cannot be asked for naturally — "emptying a file is not a delete", "a commented-out
 * `rm` is not a delete", the `mv` spellings — are pure classification and live in `test/execute.test.ts`,
 * deterministically and for free.
 *
 * Live-lane, gated on Docker + the staged agent + a token; skips cleanly otherwise (same convention as
 * live-contract.test.ts). Both vitest configs select live suites by the `test/live-*.test.ts` GLOB, so
 * this file needs no config edit to be excluded from the default lane or included here.
 * Run: CLAUDE_CODE_OAUTH_TOKEN=$(cat ~/.cowork-harness-token) vitest run --config vitest.config.live.ts live-outputs-delete
 */
const IMAGE = "cowork-agent-base:2";
let AGENT = "";
/** The outputs mode `latest` records, read from the raw baseline file (independent of the code under test). */
let LATEST_OUTPUTS_MODE: string | undefined;
let latestVersion: string | undefined;
try {
  const latest = loadBaseline("latest");
  latestVersion = latest.appVersion;
  AGENT = resolveAgentBinary(latest);
} catch {
  /* baseline/binary missing → skip */
}
// Read OUTSIDE the try above: a file-name mismatch must not masquerade as a missing agent and skip silently.
if (latestVersion !== undefined) {
  const raw = JSON.parse(readFileSync(resolve("baselines", `desktop-${latestVersion}.json`), "utf8")) as {
    mountLayout: { mounts: { name: string; mode: string }[] };
  };
  LATEST_OUTPUTS_MODE = raw.mountLayout.mounts.find((m) => m.name === "outputs")?.mode;
}
const RWD = LATEST_OUTPUTS_MODE === "rwd";
const dockerOk = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
const imageOk = dockerOk && spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" }).status === 0;
const TOKEN =
  process.env.CLAUDE_CODE_OAUTH_TOKEN ||
  (existsSync(`${homedir()}/.cowork-harness-token`) ? readFileSync(`${homedir()}/.cowork-harness-token`, "utf8").trim() : "");
const CAN = dockerOk && imageOk && !!AGENT && existsSync(AGENT) && !!TOKEN;
const CLI = resolve("dist/cli.js");

// A silent skip is the failure mode this lane is prone to — vitest.config.live.ts's own header warns a
// green run there can carry ZERO coverage. Say so on stderr rather than reporting a quiet pass.
if (!CAN)
  process.stderr.write(
    `::warning:: live-outputs-delete SKIPPED — NOT live-validated (docker=${dockerOk} image=${imageOk} agent=${!!AGENT} token=${!!TOKEN})\n`,
  );

interface Case {
  name: string;
  /** An ordinary task. NOT a pinned command — see the header for why that was abandoned. */
  prompt: string;
  /** `assert:` entries for the scenario. */
  assert: string;
  /** Expected count of detected deletes under outputs. */
  deletes: number;
  /** Expected roster status for the outputs-delete guard. */
  guard: "ok" | "fired" | "na";
  /** Expected verdict. */
  pass: boolean;
  /** Files expected to survive in mnt/outputs — the EFFECT check the pinned suite never had. */
  survivors: number;
  why: string;
}

const CASES: Case[] = [
  {
    name: "a task that requires a deletion, nothing asserted: the default verdict follows the baseline's outputs mode",
    prompt:
      "Create two poems in markdown files in the output folder, each 5 lines long.\n" +
      "  Pick one at random and present it to the user, and delete the other one.",
    // No waiver: on an rwd `latest` the delete passes by default (production allows it) and the guard reads
    // na; on an rw `latest` it fails outputs_delete and the guard fires. Either way the scan records it.
    assert: "  - result: success\n",
    deletes: 1,
    guard: RWD ? "na" : "fired",
    pass: RWD,
    survivors: 1,
    why: "A real delete must reach scan → (default) verdict → guard. Measured 3/3 runs on the waiver form of this task.",
  },
  {
    name: "the same deletion with no_delete_in_outputs asserted: the check is restored on every baseline",
    prompt:
      "Create two poems in markdown files in the output folder, each 5 lines long.\n" +
      "  Pick one at random and present it to the user, and delete the other one.",
    assert: "  - no_delete_in_outputs: true\n",
    deletes: 1,
    guard: "fired",
    pass: false,
    survivors: 1,
    why: "The opt-back-in: an authored no_delete_in_outputs fails a real outputs delete whatever the baseline records.",
  },
  {
    name: "a task that touches outputs without deleting: the guard stays silent",
    prompt:
      "Write a 5-line poem to a markdown file in the output folder. Then rename that file\n" +
      "  to final.md, and show the poem to the user.",
    assert: "  - no_delete_in_outputs: true\n",
    deletes: 0,
    guard: "ok",
    pass: true,
    survivors: 1,
    why: "The other polarity: a rename WITHIN outputs must not be read as a delete. Measured 3/3 runs.",
  },
];

interface RunOut {
  pass: boolean;
  outputsMountMode: string | undefined;
  signals: string[];
  deletes: string[];
  guard: string | undefined;
  outDir: string;
}

function runCase(c: Case, dir: string): RunOut {
  writeFileSync(join(dir, "minimal.yaml"), "permission_mode: default\n");
  const file = join(dir, "s.yaml");
  writeFileSync(file, `baseline: latest\nsession: ./minimal.yaml\nfidelity: container\nprompt: |\n  ${c.prompt}\nassert:\n${c.assert}`);
  const r = spawnSync("node", [CLI, "--run-dir", join(dir, "runs"), "run", file, "--output-format", "json"], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
    timeout: 300_000, // the `it` timeout cannot fire while spawnSync blocks the thread
  });
  const res = JSON.parse(r.stdout).results?.[0];
  expect(res, `no result envelope; stderr: ${r.stderr.slice(-400)}`).toBeTruthy();
  return {
    pass: res.verdict.pass,
    outputsMountMode: res.outputsMountMode,
    signals: res.verdict.signals.map((s: { code: string }) => s.code),
    deletes: res.scan?.outputsDeletes ?? [],
    guard: res.verdict.guards.find((g: { name: string }) => g.name === "outputs-delete")?.status,
    outDir: res.outDir,
  };
}

/** Bash tool_use count. Zero means the agent never reached the path the scanner watches, so the guard
 *  observed nothing — a non-verification, not a guard failure. */
function bashCalls(outDir: string): number {
  let n = 0;
  for (const line of readFileSync(join(outDir, "events.jsonl"), "utf8").split("\n").filter(Boolean)) {
    let m: { message?: { content?: unknown[] } };
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    for (const b of m.message?.content ?? []) {
      const blk = b as { type?: string; name?: string };
      if (blk.type === "tool_use" && blk.name === "Bash") n++;
    }
  }
  return n;
}

/** What actually survived in mnt/outputs. The INTENT is in `scan`; this is the EFFECT. */
function outputsSurvivors(outDir: string): string[] {
  const dir = join(outDir, "work", "session", "mnt", "outputs");
  return existsSync(dir) ? readdirSync(dir) : [];
}

describe.skipIf(!CAN)("live: the outputs-delete guard matches the real product", () => {
  for (const c of CASES) {
    it(
      c.name,
      (ctx) => {
        const dir = mkdtempSync(join(tmpdir(), "cwh-od-"));
        const out = runCase(c, dir);

        // EVIDENCE FIRST. Zero Bash calls means the agent never reached the watched path — the guard
        // observed nothing, so neither green nor red would be honest. Far rarer now that the cases are
        // ordinary tasks (0 of 6 measured runs), but kept: a skip states plainly that nothing was
        // verified, and if the bash path itself regressed EVERY case skips, which is louder than a red.
        if (bashCalls(out.outDir) === 0) {
          process.stderr.write(
            `::warning:: live-outputs-delete SKIPPED "${c.name}" — the agent issued NO Bash call, so the guard ` +
              `observed nothing. With an ordinary task this should be rare; if it persists across runs the task ` +
              `has stopped requiring the file operation it was written to require.\n`,
          );
          ctx.skip();
          return;
        }

        // Shape, not bytes: the agent picks its own filenames and command form.
        expect(out.deletes, `${c.name}: expected ${c.deletes} detected delete(s), got ${JSON.stringify(out.deletes)}`).toHaveLength(
          c.deletes,
        );
        // A path that merely LOOKS like outputs must not satisfy a firing case.
        for (const d of out.deletes) expect(d, "a detected delete must reference the outputs directory").toMatch(/outputs\b/);
        // The producer, end to end: the persisted mode is the raw baseline value (the unit suite can only
        // source-pin this).
        expect(out.outputsMountMode, "result.outputsMountMode must be the latest baseline's recorded outputs mode").toBe(
          LATEST_OUTPUTS_MODE === "rwd" ? "rwd" : "rw",
        );
        expect(out.guard, "the roster reports what the guard OBSERVED, or na where outputs is not delete-denied").toBe(c.guard);
        expect(out.pass, c.why).toBe(c.pass);
        if (c.deletes === 0) expect(out.signals).not.toContain("outputs_delete");

        // EFFECT: the pinned suite only ever proved a command was proposed. This proves it happened.
        expect(outputsSurvivors(out.outDir), `${c.name}: expected ${c.survivors} file(s) left in mnt/outputs`).toHaveLength(c.survivors);
      },
      600_000,
    );
  }
});
