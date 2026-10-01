// A FIFO (or any non-regular file) at an artifact path is refused BEFORE anything opens it: opening a FIFO for
// reading blocks until a writer appears, and evaluate() is synchronous, so a FIFO the agent left in outputs/
// would wedge the run. Each check runs in a CHILD process with a timeout, so a regression fails the test instead of
// hanging the worker. Synthetic data only.

import { describe, it, expect } from "vitest";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const POSIX = process.platform !== "win32";

function inChild(body: string): { status: number | null; out: string; timedOut: boolean } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fifo-")));
  const mnt = join(dir, "mnt");
  mkdirSync(join(mnt, "outputs"), { recursive: true });
  execFileSync("mkfifo", [join(mnt, "outputs", "p.json")]);
  const script = join(dir, "probe.mts");
  writeFileSync(
    script,
    `import { evaluate } from ${JSON.stringify(resolve("src/assert.ts"))};
import { extractMetrics } from ${JSON.stringify(resolve("src/metrics.ts"))};
const mnt = ${JSON.stringify(mnt)};
const ctx = { transcript: "", toolsCalled: new Set(), subagentTools: new Set(), egress: [], result: "success", workRoot: mnt,
  userVisiblePrefixes: ["outputs"], preRunHashes: {}, preRunPaths: [], outputsDeletes: [], mountDeletes: [], questions: [],
  hostPathLeaked: false, selfHealRan: false, subagents: [], gateDeliveries: [], toolResultTexts: [], skillsInvoked: [],
  skillToolAvailable: true, slashInvokedSkills: [] };
${body}`,
  );
  const r = spawnSync(process.execPath, ["--import", "tsx", script], { encoding: "utf8", timeout: 20_000 });
  return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? ""), timedOut: r.error !== undefined || r.signal !== null };
}

describe.runIf(POSIX)("a FIFO at an artifact path is never opened", () => {
  it("artifact_json fails, naming it not a regular file", () => {
    const r = inChild(`console.log(JSON.stringify(evaluate([{ artifact_json: { artifact: "outputs/p.json", path: "n" } }], ctx)[0]));`);
    expect(r.timedOut, "artifact_json blocked on the FIFO").toBe(false);
    expect(r.out).toContain('"pass":false');
    expect(r.out).toContain("artifact_json: outputs/p.json is not a regular file");
  });
  it("artifact_text fails, naming it not a regular file", () => {
    const r = inChild(
      `console.log(JSON.stringify(evaluate([{ artifact_text: { artifact: "outputs/p.json", contains: ["x"] } }], ctx)[0]));`,
    );
    expect(r.timedOut, "artifact_text blocked on the FIFO").toBe(false);
    expect(r.out).toContain('"pass":false');
    expect(r.out).toContain("artifact_text: outputs/p.json is not a regular file");
  });
  it("a metric on it is missing_artifact", () => {
    const r = inChild(
      `console.log(JSON.stringify(extractMetrics(ctx, [{ id: "n", artifact: "outputs/p.json", path: "n", better: "higher", scale: 1 }])));`,
    );
    expect(r.timedOut, "the metrics extractor blocked on the FIFO").toBe(false);
    expect(r.out).toContain('[{"id":"n","unavailable":"missing_artifact"}]');
  });
});
