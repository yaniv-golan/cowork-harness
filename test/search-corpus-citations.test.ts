import { describe, it, expect } from "vitest";
import { extractUrls } from "../src/hostloop/provenance.js";
import { citationUrls } from "../src/search-corpus/citations.js";

// The agent's URL extraction (the port that seeds the web_fetch provenance gate) is pinned to its own outputs: the
// citation reading built beside it must never change it. The oracle is the port's output as it shipped.
const PORT: [string, string[]][] = [
  ["[https://a.com/b](https://a.com/b)", ["https://a.com/b](https://a.com/b)", "https://a.com/b](https://a.com/b)"]],
  ["**https://a.com/b**", ["https://a.com/b**", "https://a.com/b**"]],
  ["Source: https://a.com/x_y_", ["https://a.com/x_y_", "https://a.com/x_y_"]],
  ["See https://a.com/b.", ["https://a.com/b", "https://a.com/b"]],
  ["(https://a.com/b)", ["https://a.com/b", "https://a.com/b"]],
  ["www.a.com/x and a.com/y", ["https://www.a.com/x", "https://www.a.com/x", "https://a.com/y"]],
  ["http://A.COM/Path/#frag", ["http://a.com/Path", "https://a.com/Path"]],
  ["https://a.com/b?x=1, then c.org.", ["https://a.com/b?x=1", "https://a.com/b?x=1", "https://c.org/"]],
  ["*https://a.com/b*", ["https://a.com/b*", "https://a.com/b*"]],
  ["_https://a.com/b_", ["https://a.com/b_", "https://a.com/b_"]],
  ["**https://a.com/b**.", ["https://a.com/b**", "https://a.com/b**"]],
  ["mailto:x@a.com and user@a.com", []],
  ["README.md deck.pdf", ["https://readme.md/", "https://deck.pdf/"]],
];

describe("extractUrls: the port of the agent's extraction, unchanged", () => {
  it.each(PORT)("%j", (input, want) => {
    expect(extractUrls(input)).toEqual(want);
  });
});

describe("citationUrls: the URLs a deliverable cites", () => {
  it.each([
    ["[https://a.com/b](https://a.com/b)", ["https://a.com/b", "https://a.com/b"]],
    ["**https://a.com/b**", ["https://a.com/b"]],
    ["*https://a.com/b*", ["https://a.com/b"]],
    ["_https://a.com/b_", ["https://a.com/b"]],
    ["**https://a.com/b**.", ["https://a.com/b"]],
    ["See https://a.com/b.", ["https://a.com/b"]],
    ["www.a.com/x and a.com/y", ["www.a.com/x", "www.a.com/x", "a.com/y"].map((u) => `https://${u}`)],
  ])("%j", (input, want) => {
    expect(citationUrls(input)).toEqual(want);
  });
  it("never reads a scheme as a host: no https://https", () => {
    for (const input of ["[https://a.com/b](https://a.com/b)", "https://a.com/b", "http://a.com/b and www.c.com"])
      expect(citationUrls(input).some((u) => /^https:\/\/https?/.test(u) || u.includes("https//"))).toBe(false);
  });
});
