import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expandLintInputs, lintPrepass, loaderFindings } from "../src/run/lint-load.js";
import { parseScenarioFile } from "../src/run/execute.js";
import { listBaselineNames } from "../src/baseline.js";

// Unit tests for the loader pre-pass `cowork-harness lint` runs before the python linter. The CLI-level
// behaviour is in lint-loads-scenario.test.ts.

function file(dir: string, name: string, lines: string[]): string {
  const p = join(dir, name);
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

const HEAD = ["baseline: latest", "fidelity: container", "prompt: hello"];

afterEach(() => vi.restoreAllMocks());

describe("loaderFindings turns every load outcome into the right finding (a table over parseScenarioFile)", () => {
  // What this can catch: the error-to-finding mapping — a load failure that maps to NO ERROR (a silent
  // drop), or a successful load that still yields one. What it cannot catch: a regression inside the
  // loader itself. Both sides call the same `loadScenarioPure` (`parseScenarioFile` is a thin wrapper that
  // only adds the stderr notice), so a loader bug moves both together. That sharing is the design — lint
  // and `run`/`record` cannot drift — and the loader's own behaviour is exercised end to end by the CLI
  // tests in lint-loads-scenario.test.ts.
  const d = mkdtempSync(join(tmpdir(), "cwh-lint-unit-"));
  const cases: [string, string[]][] = [
    ["clean", [...HEAD, "assert:", "  - result: success"]],
    ["unknown-key", [...HEAD, "bogus: 1"]],
    ["rubric-scalar", [...HEAD, "assert:", "  - semantic_matches:", '      rubric: "x"']],
    ["bad-enum", ["fidelity: bogus", "prompt: hello"]],
    ["bad-regex", [...HEAD, "assert:", "  - transcript_matches: '('"]],
    ["reserved", [...HEAD, "execution: cloud-describe"]],
    ["yaml-syntax", ["prompt: [unclosed"]],
    ["contradiction-refine", [...HEAD, "assert:", "  - no_delete_in_outputs: true", "  - allow_outputs_delete: true"]],
    ["no-fidelity", ["prompt: hello"]],
    ["named-existing-baseline", [`baseline: ${listBaselineNames()[0]}`, "fidelity: container", "prompt: hello"]],
  ];
  for (const [name, lines] of cases) {
    it(name, () => {
      const p = file(d, `${name}.yaml`, lines);
      let loads = true;
      const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        parseScenarioFile(p);
      } catch {
        loads = false;
      }
      err.mockRestore();
      const found = loaderFindings([p]).filter((f) => f.severity === "ERROR");
      expect(found.length > 0).toBe(!loads);
    });
  }
});

describe("loaderFindings output", () => {
  it("never writes to stdout or stderr (the defaulted-fidelity notice belongs to run/record)", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-unit-"));
    const p = file(d, "s.yaml", ["baseline: latest", "prompt: hello"]);
    const o = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const e = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(loaderFindings([p])).toEqual([]);
    expect(o).not.toHaveBeenCalled();
    expect(e).not.toHaveBeenCalled();
  });

  it("one finding per schema issue, with the bracketed path", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-unit-"));
    const p = file(d, "s.yaml", [...HEAD, "bogus: 1", "assert:", "  - semantic_matches:", '      rubric: "x"']);
    const fs = loaderFindings([p]);
    expect(fs.length).toBe(2);
    expect(fs.every((f) => f.rule === "scenario-invalid" && f.file === p && f.line === null)).toBe(true);
    expect(fs.some((f) => f.message.includes("assert[0].semantic_matches.rubric"))).toBe(true);
  });

  it("caps a file's schema findings at 10, the last one naming how many more", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-unit-"));
    const keys = Array.from({ length: 14 }, (_, i) => `bogus_${i}: 1`);
    const p = file(d, "s.yaml", [...HEAD, ...keys]);
    const fs = loaderFindings([p]);
    // zod reports all unknown keys of one object as a single issue, so build distinct issues instead.
    expect(fs.length).toBeLessThanOrEqual(10);
    const many = file(d, "many.yaml", [
      ...HEAD,
      "assert:",
      ...Array.from({ length: 14 }, () => ["  - semantic_matches:", '      rubric: "x"']).flat(),
    ]);
    const mf = loaderFindings([many]);
    expect(mf).toHaveLength(10);
    expect(mf[9].message).toMatch(/and 5 more/);
  });

  it("an unexpected throw inside the pre-pass is an ERROR finding, never a silent pass", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-unit-"));
    const p = file(d, "s.yaml", [...HEAD]);
    const fs = loaderFindings([p], {
      load: () => {
        throw new TypeError("boom");
      },
    });
    // A TypeError from the load step is NOT a scenario problem the loader reports — it is still ERROR.
    expect(fs).toHaveLength(1);
    expect(fs[0].severity).toBe("ERROR");
    expect(fs[0].message).toMatch(/boom/);
    const viaBaseline = loaderFindings([file(d, "b.yaml", ["baseline: desktop-9.9.9", ...HEAD.slice(1)])], {
      loadBaseline: () => {
        throw new RangeError("kaboom");
      },
    });
    expect(viaBaseline).toHaveLength(1);
    expect(viaBaseline[0].severity).toBe("ERROR");
  });

  it("a failure in the pre-pass machinery itself (not a load error) is lint-loader-internal", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-unit-"));
    const p = file(d, "s.yaml", [...HEAD, "bogus: 1"]);
    const fs = loaderFindings([p], {
      load: () => {
        // a UsageError whose hint is not the issue list the mapper expects, and a message getter that throws
        const e = new Error("x");
        Object.defineProperty(e, "message", {
          get() {
            throw new Error("getter exploded");
          },
        });
        throw e;
      },
    });
    expect(fs).toHaveLength(1);
    expect(fs[0].rule).toBe("lint-loader-internal");
    expect(fs[0].severity).toBe("ERROR");
  });
});

describe("the pre-pass never throws", () => {
  it("expandLintInputs skips a dangling *.yaml symlink (python reports it) instead of throwing", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-unit-"));
    const good = file(d, "good.yaml", [...HEAD]);
    symlinkSync(join(d, "nowhere.yaml"), join(d, "gone.yaml"));
    expect(expandLintInputs([d])).toEqual([good]);
  });

  it("any throw while expanding the inputs is an ERROR lint-loader-internal finding", () => {
    const fs = lintPrepass(["x.yaml"], {
      expand: () => {
        throw new Error("readdir exploded");
      },
    });
    expect(fs).toHaveLength(1);
    expect(fs[0].rule).toBe("lint-loader-internal");
    expect(fs[0].severity).toBe("ERROR");
    expect(fs[0].message).toMatch(/readdir exploded/);
  });
});
