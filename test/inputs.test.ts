import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveInputs } from "../src/run/inputs.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "inputs-"));
}

describe("resolveInputs", () => {
  it("returns a single file as-is regardless of extension", () => {
    const d = tmp();
    const f = join(d, "x.cassette.json");
    writeFileSync(f, "{}");
    expect(resolveInputs(f, ".cassette.json")).toEqual({ files: [f], isDir: false });
  });

  it("lists a directory's matching files, sorted", () => {
    const d = tmp();
    writeFileSync(join(d, "b.cassette.json"), "{}");
    writeFileSync(join(d, "a.cassette.json"), "{}");
    writeFileSync(join(d, "note.txt"), "x");
    const r = resolveInputs(d, ".cassette.json");
    expect("files" in r && r.files).toEqual([join(d, "a.cassette.json"), join(d, "b.cassette.json")]);
  });

  it("supports multiple extensions (run's .yaml + .yml)", () => {
    const d = tmp();
    writeFileSync(join(d, "a.yaml"), "x");
    writeFileSync(join(d, "b.yml"), "x");
    writeFileSync(join(d, "c.json"), "x");
    const r = resolveInputs(d, [".yaml", ".yml"]);
    expect("files" in r && r.files.map((f) => f.endsWith(".json"))).toEqual([false, false]);
    expect("files" in r && r.files.length).toBe(2);
  });

  it("errors loud on an empty directory (no vacuous pass)", () => {
    expect("error" in resolveInputs(tmp(), ".cassette.json")).toBe(true);
  });

  it("errors on a missing path", () => {
    expect("error" in resolveInputs(join(tmpdir(), "nope-does-not-exist-xyz"), ".cassette.json")).toBe(true);
  });
});
