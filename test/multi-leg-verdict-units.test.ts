import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { mergeGuards, vacuousLegBlockRefusal, executeMultiLeg } from "../src/run/multi-leg.js";
import { loadMultiLegScenario } from "../src/run/execute.js";
import { UsageError } from "../src/errors.js";

// Small pure pieces of the multi-leg verdict and its up-front checks.
describe("multi-leg verdict units", () => {
  it("mergeGuards keeps one guard per name at the worst status any leg reported", () => {
    const merged = mergeGuards([
      { name: "host-path", status: "fired" },
      { name: "outputs-delete", status: "na" },
      { name: "host-path", status: "ok" }, // a later leg where it held must not hide the earlier fire
      { name: "outputs-delete", status: "ok" },
      { name: "capability-use", status: "unverified" },
      { name: "capability-use", status: "ok" },
    ]);
    expect(Object.fromEntries(merged.map((g) => [g.name, g.status]))).toEqual({
      "host-path": "fired",
      "outputs-delete": "ok",
      "capability-use": "unverified",
    });
  });

  it("a later `none` leg with no positive file assertion is refused, naming the leg", () => {
    const leg = { id: "resume", prompt: "go", assert: [] } as unknown as Parameters<typeof vacuousLegBlockRefusal>[0];
    expect(vacuousLegBlockRefusal(leg, [{ result: "success" }] as never)).toMatch(/^leg "resume": under `answer_channel: none`/);
    // a bare file_exists counts only with authored: true; a value assertion counts as written
    expect(vacuousLegBlockRefusal(leg, [{ file_exists: "outputs/x" }] as never)).toMatch(/^leg "resume"/);
    expect(vacuousLegBlockRefusal(leg, [{ file_exists: { path: "outputs/x", authored: true } }] as never)).toBeUndefined();
    expect(
      vacuousLegBlockRefusal(leg, [{ artifact_json: { artifact: "outputs/s.json", path: "status", equals: "ok" } }] as never),
    ).toBeUndefined();
  });

  it("a malformed caller run id is refused before any root is created", async () => {
    const ms = loadMultiLegScenario(resolve("examples/probes/resumable-probe.scenario.yaml"));
    await expect(executeMultiLeg(ms, { runId: "../escape" } as never)).rejects.toThrow(UsageError);
    await expect(executeMultiLeg(ms, { runId: "../escape" } as never)).rejects.toThrow(/run id "\.\.\/escape" must be local_/);
  });
});
