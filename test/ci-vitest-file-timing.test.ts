import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

  it("the floor job writes the JSON report from the workflow step, not from `npm run ci`", () => {
    // `npm run ci` is also prepublishOnly and runs locally, where $RUNNER_TEMP is unset.
    expect(JSON.parse(readFileSync(resolve("package.json"), "utf8")).scripts.ci).toBe("npm run typecheck && npm run build && npm run test");
    const ci = readFileSync(resolve(".github/workflows/ci.yml"), "utf8");
    const floor = ci.slice(ci.indexOf("\n  floor:"), ci.indexOf("\n  metric-runtimes:"));
    expect(floor).toContain("--reporter=hanging-process");
    expect(floor).toContain('--outputFile.json="$RUNNER_TEMP/hangs/vitest-files.json"');
    expect(floor).toContain("scripts/ci/vitest-file-timing.ts");
  });
});
