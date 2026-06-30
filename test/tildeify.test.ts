import { describe, it, expect, afterEach } from "vitest";
import { tildeify } from "../src/io.js";

// F3: collapse $HOME → ~ for display, so human output never leaks the username / FS layout.

const withHome = (home: string | undefined, fn: () => void) => {
  const prev = process.env.HOME;
  if (home === undefined) delete process.env.HOME;
  else process.env.HOME = home;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
  }
};

afterEach(() => {
  /* withHome restores per-call */
});

describe("F3 — tildeify", () => {
  it("collapses a leading $HOME to ~", () => {
    withHome("/Users/someone", () => {
      expect(tildeify("/Users/someone/.cowork-harness/runs/x/local_1")).toBe("~/.cowork-harness/runs/x/local_1");
      expect(tildeify("/Users/someone")).toBe("~");
    });
  });

  it("leaves non-home paths and look-alikes unchanged", () => {
    withHome("/Users/someone", () => {
      expect(tildeify("/tmp/ch-demo/runs/x")).toBe("/tmp/ch-demo/runs/x");
      // a prefix that is not a path-segment boundary must NOT match
      expect(tildeify("/Users/someone-else/x")).toBe("/Users/someone-else/x");
    });
  });

  it("is a no-op when HOME is unset, '/', or the input is empty", () => {
    withHome(undefined, () => expect(tildeify("/Users/x/y")).toBe("/Users/x/y"));
    withHome("/", () => expect(tildeify("/anything")).toBe("/anything"));
    withHome("/Users/x", () => expect(tildeify("")).toBe(""));
  });
});
