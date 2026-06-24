import { describe, it, expect } from "vitest";
import { stripComments } from "../src/prompt.js";

describe("stripComments", () => {
  it("removes a simple HTML comment", () => {
    expect(stripComments("a<!-- x -->b")).toBe("ab");
  });

  it("removes multiple comments across lines", () => {
    expect(stripComments("a<!--\nx\n-->b<!--y-->c")).toBe("abc");
  });

  it("leaves comment-free content untouched", () => {
    expect(stripComments("plain text {{token}}")).toBe("plain text {{token}}");
  });

  // Regression: a single-pass replace is incomplete sanitization — removing the inner
  // `<!-- -->` here recombines the outer fragments into a fresh `<!-- x -->`, which a
  // one-shot `.replace` leaves behind. Repeating until stable strips it fully.
  // (CodeQL js/incomplete-multi-character-sanitization.)
  it("strips comment markers that recombine after one pass", () => {
    const out = stripComments("<!<!-- -->-- x -->");
    expect(out).not.toContain("<!--");
    expect(out).toBe("");
  });
});
