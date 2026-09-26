import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { captureOutputsBaseline, readOutputsBaseline } from "../src/run/pre-run-manifest.js";
import { collectArtifactPathsWithHealth } from "../src/run/artifacts.js";
import { outputsFsDiff } from "../src/run/execute.js";

/**
 * The outputs-delete filesystem diff through its REAL producers, end to end: the turn-start snapshot
 * (`captureOutputsBaseline`), its reader, the real post-run walk, and `outputsFsDiff` with the live
 * assembler's hash function. The unit tests elsewhere hand-build the baseline object; this pins the seam
 * between producer and consumer — in particular the hash format the rename exemption depends on, whose
 * silent drift would turn every rename into a reported delete.
 */
function turn(mutate: (outputs: string) => void) {
  const outDir = mkdtempSync(join(tmpdir(), "cwh-odrt-"));
  const workRoot = join(outDir, "work", "session", "mnt");
  const outputs = join(workRoot, "outputs");
  mkdirSync(join(outputs, "dir"), { recursive: true });
  writeFileSync(join(outputs, "a.md"), "alpha\n");
  writeFileSync(join(outputs, "dir", "b.md"), "beta\n");
  captureOutputsBaseline(workRoot, outDir);
  mutate(outputs);
  const hash = (rel: string) => {
    try {
      return createHash("sha256")
        .update(readFileSync(join(workRoot, rel)))
        .digest("hex");
    } catch {
      return null;
    }
  };
  return outputsFsDiff(readOutputsBaseline(outDir), collectArtifactPathsWithHealth(workRoot, ["outputs"]), hash);
}

describe("outputs filesystem diff — real producer round trip", () => {
  it("nothing touched ⇒ clean", () => {
    expect(turn(() => {}).status).toBe("clean");
  });

  it("a deleted pre-existing file ⇒ one finding naming it", () => {
    const d = turn((o) => rmSync(join(o, "a.md")));
    expect(d.status).toBe("findings");
    expect(d.findings).toEqual(["[fs-diff] output file removed post-run: outputs/a.md"]);
  });

  it("a rename within outputs ⇒ clean (the content reappears at a new path)", () => {
    expect(turn((o) => renameSync(join(o, "a.md"), join(o, "renamed.md"))).status).toBe("clean");
  });

  it("an atomic tmp-then-rename replace ⇒ clean", () => {
    expect(
      turn((o) => {
        writeFileSync(join(o, "a.md.tmp"), "alpha v2\n");
        renameSync(join(o, "a.md.tmp"), join(o, "a.md"));
      }).status,
    ).toBe("clean");
  });

  it("an in-place edit ⇒ clean", () => {
    expect(turn((o) => appendFileSync(join(o, "dir", "b.md"), "more\n")).status).toBe("clean");
  });
});
