import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { fileTimings, formatTimings } from "../scripts/ci/vitest-file-timing.js";

// CI's floor job writes vitest's JSON report and appends per-file wall time to its log (scripts/ci/vitest-file-timing.ts).
describe("vitest per-file timing", () => {
  it("orders files slowest first and leaves out a file without timestamps", () => {
    const rows = fileTimings(
      {
        testResults: [
          { name: "/r/test/a.test.ts", status: "passed", startTime: 1000, endTime: 3500 },
          { name: "/r/test/b.test.ts", status: "failed", startTime: 1000, endTime: 9000 },
          { name: "/r/test/c.test.ts", status: "passed" },
        ],
      },
      "/r",
    );
    expect(rows).toEqual([
      { file: "test/b.test.ts", status: "failed", ms: 8000 },
      { file: "test/a.test.ts", status: "passed", ms: 2500 },
    ]);
    const text = formatTimings(rows, 1, 3);
    expect(text).toContain("slowest 1 of 3 files");
    expect(text).toContain("8.0s");
    expect(text).not.toContain("a.test.ts");
  });

  it.each([
    ["ci.yml", "floor"],
    ["floor-unsharded.yml", "floor-unsharded"],
  ])("%s's %s job writes the JSON report from the workflow step, not from `npm run ci`", (file, id) => {
    // `npm run ci` is also prepublishOnly and runs locally, where $RUNNER_TEMP is unset.
    expect(JSON.parse(readFileSync(resolve("package.json"), "utf8")).scripts.ci).toBe("npm run typecheck && npm run build && npm run test");
    const doc = parse(readFileSync(resolve(".github/workflows", file), "utf8")) as { jobs: Record<string, { steps: { run?: string }[] }> };
    const runs = doc.jobs[id]!.steps.map((s) => s.run ?? "").join("\n");
    expect(runs).toContain("--reporter=hanging-process");
    expect(runs).toContain('--outputFile.json="$RUNNER_TEMP/hangs/vitest-files.json"');
    expect(runs).toContain("scripts/ci/vitest-file-timing.ts");
  });
});
