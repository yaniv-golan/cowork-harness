import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { discoverScenarios } from "../src/run/cassette.js";

function dir(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "cwh-disc-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(d, name), body);
  return d;
}

describe("discoverScenarios — positive prompt: signal (N1)", () => {
  it("classifies a scenario, a session (no prompt → skip), and a broken scenario (→ broken, NOT skip)", () => {
    const d = dir({
      "good.yaml": "prompt: do the thing\nfidelity: container\n",
      "session.yaml": "skills:\n  local:\n    - ./s\n", // no prompt → a session, announced skip
      "broken.yaml": "prompt: x\nfidelity: not-a-real-tier\n", // has prompt but bad schema → BROKEN, not skipped
    });
    const r = discoverScenarios(d);
    expect(r.scenarios.map((f) => basename(f))).toEqual(["good.yaml"]);
    expect(r.skipped.map((f) => basename(f))).toEqual(["session.yaml"]);
    expect(r.broken.map((b) => basename(b.file))).toEqual(["broken.yaml"]);
  });

  it("unparseable YAML → broken (not a silent skip)", () => {
    const d = dir({ "junk.yaml": "prompt: [unclosed\n::::\n" });
    const r = discoverScenarios(d);
    expect(r.broken.length).toBe(1);
    expect(r.scenarios).toEqual([]);
    expect(r.skipped).toEqual([]);
  });

  it("only *.yaml/*.yml are considered (non-recursive)", () => {
    const d = dir({ "a.yaml": "prompt: hi\n", "notes.md": "prompt: hi", "b.txt": "prompt: hi" });
    const r = discoverScenarios(d);
    expect(r.scenarios.map((f) => basename(f))).toEqual(["a.yaml"]);
  });
});
