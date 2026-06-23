import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// The linter (scenario.py) bundles a pure-Python PyYAML under _vendor/ so `lint` works on a stock python3
// with no `pip install pyyaml` (npm consumers / bare CI). These tests prove the vendored copy is present
// and is actually used when the environment has no system PyYAML.
const SCRIPT = resolve(".claude/skills/cowork-harness/scripts/scenario.py");
const VENDOR = resolve(".claude/skills/cowork-harness/scripts/_vendor/yaml/__init__.py");
const py = process.env.PYTHON ?? "python3";
const havePython = spawnSync(py, ["--version"], { stdio: "ignore" }).status === 0;

describe("bundled PyYAML", () => {
  it("the vendored pure-Python yaml package is present next to scenario.py", () => {
    expect(existsSync(VENDOR)).toBe(true);
    expect(existsSync(resolve(".claude/skills/cowork-harness/scripts/_vendor/yaml/LICENSE"))).toBe(true);
  });

  it.skipIf(!havePython)("scenario.py lints with NO system PyYAML (python3 -S forces the vendored fallback)", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-vy-"));
    // a minimal, valid scenario the linter can parse end-to-end
    writeFileSync(join(d, "s.yaml"), "name: smoke\nprompt: do the thing\nfidelity: container\nassert:\n  - result: success\n");
    // -S: skip site-packages (no system PyYAML on the path) → scenario.py must use the bundled copy.
    // -B: don't write __pycache__ into the vendored dir during the test.
    const r = spawnSync(py, ["-S", "-B", SCRIPT, "lint", join(d, "s.yaml")], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect((r.stdout || "") + (r.stderr || "")).not.toMatch(/requires PyYAML|could not be loaded/);
  });

  it.skipIf(!havePython)("python3 -S genuinely has no system yaml (so the test above truly exercises the fallback)", () => {
    // If this fails (system yaml is importable under -S), the fallback test would be a false positive.
    const r = spawnSync(py, ["-S", "-c", "import yaml"], { encoding: "utf8" });
    expect(r.status).not.toBe(0);
  });
});
