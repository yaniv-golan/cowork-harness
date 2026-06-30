import { describe, it, expect } from "vitest";
import { inputSummary } from "../src/run/renderer.js";

// Under --compact, `-V` tool inputs collapse the cowork session-root prefix
// `/sessions/<id>/mnt/` → `mnt/`. Display-only; covers all session-id shapes; replace runs BEFORE the
// 80-char truncation so a boundary past char 80 still collapses; L0/protocol `work/` paths are untouched.

describe("inputSummary compact path collapse", () => {
  it("collapses an ephemeral local_<id> session path", () => {
    const out = inputSummary({ command: "cat /sessions/local_abc123/mnt/uploads/x" }, true);
    expect(out).toContain("mnt/uploads/x");
    expect(out).not.toContain("/sessions/");
  });

  it("collapses a PINNED sess-<id> session path (the case the first regex missed)", () => {
    const out = inputSummary({ command: "cat /sessions/sess-my-run/mnt/outputs/y" }, true);
    expect(out).toContain("mnt/outputs/y");
    expect(out).not.toContain("/sessions/");
  });

  it("collapses even when the /mnt/ boundary sits PAST char 80 (replace-before-truncate)", () => {
    // pre-collapse JSON is > 80 chars with the /mnt/ boundary past 80; after collapse it fits in 80.
    const pad = "x".repeat(50);
    const out = inputSummary({ command: `${pad} /sessions/local_abc123/mnt/f` }, true);
    // replace-before-slice ⇒ no truncation marker, full collapsed path visible.
    expect(out).not.toContain("…"); // would be present if the collapse ran AFTER the slice
    expect(out).toContain("mnt/f");
    expect(out).not.toContain("/sessions/");
  });

  it("leaves the full path under compact:false", () => {
    const out = inputSummary({ command: "cat /sessions/local_abc123/mnt/x" }, false);
    expect(out).toContain("/sessions/local_abc123/mnt/x");
  });

  it("leaves a /sessions/ path WITHOUT a /mnt/ segment untouched", () => {
    const out = inputSummary({ path: "/sessions/data/report" }, true);
    expect(out).toContain("/sessions/data/report");
  });
});
