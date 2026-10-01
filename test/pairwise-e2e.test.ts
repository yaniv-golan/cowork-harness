import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeScenario, parseScenarioFile } from "../src/run/execute.js";
import type { CompleteStructured, StructuredCall } from "../src/decide/pairwise-judge.js";
import { pairwiseComposeKey } from "../src/run/pairwise-prepass.js";
import { freezeRef } from "../src/refs/store.js";
import { composeFromRunDir } from "../src/refs/compose.js";
import { POSIX, makeStubFixture, type StubFixture } from "./helpers/stub-agent.js";

// semantic_pairwise through the REAL executeScenario with only the agent and the judge transport replaced: the
// stub `claude` streams a short answer; the structured transport is injected and records what it was sent. No
// model call, no spend. It fails if the pre-pass is not wired, if references are not resolved against the scenario
// file, or if a missing reference is not refused before the agent spawns.

const line = (o: unknown) => `printf '%s\\n' '${JSON.stringify(o)}'`;
const ANSWER = "PAIRWISE-CANDIDATE: the answer is 42.";
const STUB = [
  `echo started > "$STUB_PID"`,
  line({ type: "system", subtype: "init", session_id: "stub", model: "claude-sonnet-5", tools: [], cwd: "/tmp" }),
  line({
    type: "assistant",
    message: { id: "m1", role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: ANSWER }] },
    session_id: "stub",
  }),
  line({ type: "result", subtype: "success", is_error: false, result: ANSWER, session_id: "stub", num_turns: 1 }),
  "cat >/dev/null",
].join("\n");

let f: StubFixture;
let dir: string;
const saved: Record<string, string | undefined> = {};
function setEnv(k: string, v: string): void {
  if (!(k in saved)) saved[k] = process.env[k];
  process.env[k] = v;
}
beforeEach(() => {
  f = makeStubFixture(STUB);
  dir = mkdtempSync(join(tmpdir(), "pairwise-e2e-"));
  setEnv("COWORK_HARNESS_FORBID_SPAWN", "0");
  setEnv("PATH", f.env.PATH!);
  setEnv("HOME", f.env.HOME!);
  setEnv("CLAUDE_CONFIG_DIR", f.env.CLAUDE_CONFIG_DIR!);
  setEnv("COWORK_HARNESS_RUNS_DIR", f.runsDir);
  setEnv("COWORK_HARNESS_MODEL", "claude-sonnet-5");
  setEnv("STUB_PID", f.stubPidFile);
  setEnv("STUB_ENV_DUMP", f.envDump);
  setEnv("COWORK_MANAGED_CONFIG", "1");
  for (const k of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"])
    setEnv(k, k === "CLAUDE_CODE_OAUTH_TOKEN" ? "stub-not-a-real-token" : "");
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
  f.cleanup();
});

function scenario(extra: string[] = []): string {
  const file = join(dir, "pairwise-e2e.yaml");
  writeFileSync(
    file,
    [
      "baseline: latest",
      "session: (inline)",
      "fidelity: protocol",
      "prompt: what is the answer?",
      "assert:",
      "  - semantic_pairwise:",
      "      rubric: ['gives the answer']",
      "      refs: [refs]",
      ...extra,
      "",
    ].join("\n"),
  );
  return file;
}

describe.runIf(POSIX)("semantic_pairwise through the real executeScenario (protocol)", () => {
  it("judges the run's answer against the frozen reference resolved beside the scenario", async () => {
    const file = scenario();
    const sc = parseScenarioFile(file);
    freezeRef(
      join(dir, "refs"),
      "pairwise-e2e",
      { command: "test", runDir: "~/r", resultSha256: "a".repeat(64) },
      { [pairwiseComposeKey(sc.assert[0]!)]: "FROZEN REFERENCE ANSWER" },
      { harnessVersion: "t", composerId: "c" },
    );
    const calls: StructuredCall[] = [];
    const complete: CompleteStructured = async (c) => {
      calls.push(c);
      const candIsA = c.user.indexOf("PAIRWISE-CANDIDATE") < c.user.indexOf("FROZEN REFERENCE");
      return {
        structured: { rationale: "Output A states the answer.", verdict: candIsA ? "A" : "B" },
        model: "claude-judge-x",
        subtype: "success",
      };
    };
    const res = await executeScenario(sc, { pairwiseComplete: complete });
    const a = res.assertions.find((x) => x.assertion.semantic_pairwise !== undefined)!;
    expect(a.pass).toBe(true);
    expect(a.pairwise).toMatchObject([{ ref: "refs", status: "graded", outcome: "win", value: 1 }]);
    expect(a.judgeModel).toBe("claude-judge-x");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.user).toContain("what is the answer?");
    expect(calls[0]!.user).toContain(ANSWER);
    expect(calls[0]!.user).toContain("FROZEN REFERENCE ANSWER");
  });

  it("a missing reference is refused BEFORE the agent spawns (nothing is spent)", async () => {
    const file = scenario();
    await expect(
      executeScenario(parseScenarioFile(file), { pairwiseComplete: async () => ({ structured: undefined, model: "x" }) }),
    ).rejects.toThrow(
      /semantic_pairwise: refusing before the run spends anything[\s\S]*reference "refs": reference store \S+ does not exist/,
    );
    expect(existsSync(f.stubPidFile)).toBe(false);
  });
});

describe.runIf(POSIX)("ref freeze composition from a REAL kept run (the live-fingerprint oracle)", () => {
  async function keptRun(): Promise<{ runDir: string; pairwiseFile: string }> {
    // The baseline run: a semantic_matches assert with the SAME evidence options records the live judgedDoc.
    const base = join(dir, "pairwise-e2e.yaml");
    writeFileSync(
      base,
      [
        "baseline: latest",
        "session: (inline)",
        "fidelity: protocol",
        "prompt: what is the answer?",
        "assert:",
        "  - semantic_matches:",
        "      rubric: ['gives the answer']",
        "",
      ].join("\n"),
    );
    const judge = (async (rubric: string[]) => rubric.map((_c, i) => ({ index: i, claim: _c, pass: true }))) as never;
    const res = await executeScenario(parseScenarioFile(base), { semanticJudge: judge });
    expect(res.assertions[0]!.judgedDoc?.sha256).toMatch(/^[0-9a-f]{64}$/);
    // The pairwise scenario that will be frozen: same name and prompt, a pairwise assert with the same options.
    const pdir = join(dir, "p");
    mkdirSync(pdir);
    const pairwiseFile = join(pdir, "pairwise-e2e.yaml");
    writeFileSync(
      pairwiseFile,
      [
        "baseline: latest",
        "session: (inline)",
        "fidelity: protocol",
        "prompt: what is the answer?",
        "assert:",
        "  - semantic_pairwise:",
        "      refs: [refs]",
        "",
      ].join("\n"),
    );
    return { runDir: res.outDir, pairwiseFile };
  }

  it("recomposes exactly the document the live judge read (fingerprint match), redacted for the store", async () => {
    const { runDir, pairwiseFile } = await keptRun();
    const c = composeFromRunDir(runDir, pairwiseFile, []);
    expect("refused" in c ? c.refused : "").toBe("");
    const ok = c as Exclude<typeof c, { refused: string }>;
    expect(ok.docs).toHaveLength(1);
    expect(ok.docs[0]!.live).toBe("match");
    expect(ok.docs[0]!.text).toContain(ANSWER);
    expect(ok.scenario).toBe("pairwise-e2e");
  });

  it("a kept run whose evidence changed after the run is reported as differs (and ref freeze refuses it)", async () => {
    const { runDir, pairwiseFile } = await keptRun();
    const side = join(runDir, "turns", "1", "run.jsonl");
    writeFileSync(side, readFileSync(side, "utf8").replace(/PAIRWISE-CANDIDATE/g, "EDITED-AFTER-THE-RUN"));
    const c = composeFromRunDir(runDir, pairwiseFile, []);
    expect("refused" in c ? "refused" : (c as { docs: Array<{ live: string }> }).docs[0]!.live).toBe("differs");
  });

  it("refuses a run of a different scenario", async () => {
    const { runDir } = await keptRun();
    const other = join(dir, "other.yaml");
    writeFileSync(
      other,
      [
        "baseline: latest",
        "session: (inline)",
        "fidelity: protocol",
        "prompt: what is the answer?",
        "assert:",
        "  - semantic_pairwise: {}",
        "",
      ].join("\n"),
    );
    const c = composeFromRunDir(runDir, other, []);
    expect("refused" in c && c.refused).toMatch(/run of scenario "pairwise-e2e", not "other"/);
  });
});
