import { describe, it, expect } from "vitest";
import { scanText } from "../src/scan.js";

// From Desktop 2.7032.0 a host-loop agent runs at /var/empty and reports its realpath, /private/var/empty.
// That is a macOS system constant, not a path that identifies anyone, so a recording carrying it must not
// fail the privacy scan. Anything else under /private/var still flags.
describe("privacy scan — the host-loop agent cwd", () => {
  it("does not flag /private/var/empty or a file the model named under it", () => {
    expect(scanText('{"cwd":"/private/var/empty"}', "x", []).filter((f) => f.cls === "path")).toEqual([]);
    expect(scanText("denied: /private/var/empty/probe.md", "x", []).filter((f) => f.cls === "path")).toEqual([]);
  });
  it("still flags other /private/var paths", () => {
    expect(scanText('{"p":"/private/var/folders/ab/T/x"}', "x", []).filter((f) => f.cls === "path").length).toBe(1);
    expect(scanText('{"p":"/private/var/emptyish/x"}', "x", []).filter((f) => f.cls === "path").length).toBe(1);
  });
});
