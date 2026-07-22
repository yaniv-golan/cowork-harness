import { describe, it, expect } from "vitest";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { runsWriteRoot } from "../src/run/trace-view.js";

// THE GUARD FOR test/setup/runs-root.ts.
//
// The setup file is invisible: nothing fails if it stops working, tests just quietly start writing into
// the developer's real ~/.cowork-harness/runs again — which is how two run dirs per suite execution ended
// up in a live 122k-file history without anyone noticing. This asserts the property directly, so the
// protection cannot rot silently.

describe("test runs are isolated from the real runs root", () => {
  it("resolves the runs root to a temp dir, never under the home directory", () => {
    const root = resolve(runsWriteRoot());
    expect(process.env.COWORK_HARNESS_RUNS_DIR, "the setup file did not set a runs root").toBeDefined();
    expect(
      root.startsWith(resolve(homedir()) + "/") && !root.startsWith(resolve(tmpdir())),
      `tests would write to ${root}, inside the real home — see test/setup/runs-root.ts`,
    ).toBe(false);
  });

  it("a test that sets its own runs root still wins", () => {
    // The setup file fills in a default; it must never override a deliberate choice, or the 15 files that
    // manage their own root would silently stop doing so.
    const prev = process.env.COWORK_HARNESS_RUNS_DIR;
    process.env.COWORK_HARNESS_RUNS_DIR = "/tmp/explicitly-chosen";
    try {
      expect(runsWriteRoot()).toBe("/tmp/explicitly-chosen");
    } finally {
      if (prev === undefined) delete process.env.COWORK_HARNESS_RUNS_DIR;
      else process.env.COWORK_HARNESS_RUNS_DIR = prev;
    }
  });
});
