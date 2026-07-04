import { describe, it, expect } from "vitest";
import { parseArgs, ArgError } from "../src/cli-args.js";

const SPEC = {
  booleans: ["--strict"],
  values: ["--out", "--output-format", "--decider-cmd"],
  repeated: ["--allow"],
  enums: { "--output-format": ["text", "json"] },
  // "-s" is a synthetic alias for the mechanism test below — no real command declares it (and none
  // declares `-V`, which was retired; verbose is long-only).
  aliases: { "-q": "--quiet", "-s": "--strict" },
  noDashValue: ["--out", "--decider-cmd"],
};

describe("parseArgs", () => {
  it("does not treat a value-flag's value as a positional", () => {
    const p = parseArgs(["x.yaml", "--output-format", "json"], SPEC);
    expect(p.positionals).toEqual(["x.yaml"]);
    expect(p.options["--output-format"]).toBe("json");
  });

  it("collects booleans and repeated flags", () => {
    const p = parseArgs(["a", "--strict", "--allow", "re1", "--allow", "re2"], SPEC);
    expect(p.flags["--strict"]).toBe(true);
    expect(p.repeated["--allow"]).toEqual(["re1", "re2"]);
  });

  it("supports the equals form for value-flags and booleans-reject-equals", () => {
    expect(parseArgs(["--out=foo"], SPEC).options["--out"]).toBe("foo");
    expect(() => parseArgs(["--strict=foo"], SPEC)).toThrow(ArgError);
  });

  it("rejects unknown enum / missing value / unknown flag", () => {
    expect(() => parseArgs(["a", "--output-format", "xml"], SPEC)).toThrow(ArgError);
    expect(() => parseArgs(["a", "--out"], { ...SPEC })).toThrow(/requires a value/);
    expect(() => parseArgs(["a", "--bogus"], SPEC)).toThrow(/unknown flag/);
  });

  it("resolves short-flag aliases and fails loud on an unknown short flag", () => {
    const p = parseArgs(["a", "-q", "-s"], { ...SPEC, booleans: ["--strict", "--quiet"] });
    expect(p.flags["--quiet"]).toBe(true);
    expect(p.flags["--strict"]).toBe(true);
    // `-V` is retired everywhere (verbose is long-only) — undeclared, so it must fail loud, not alias.
    expect(() => parseArgs(["-V"], SPEC)).toThrow(/unknown flag/);
    expect(() => parseArgs(["-z"], SPEC)).toThrow(/unknown flag/);
  });

  it("treats a lone '-' as a positional", () => {
    expect(parseArgs(["-"], SPEC).positionals).toEqual(["-"]);
  });

  it("opt-in dash guard: rejects a spaced flag-looking value for noDashValue flags", () => {
    expect(() => parseArgs(["--out", "--oops"], SPEC)).toThrow(/missing value/);
    expect(() => parseArgs(["--decider-cmd", "--output-format"], SPEC)).toThrow(/missing value/);
  });

  it("dash guard: the equals form bypasses (a genuine dash-leading value)", () => {
    expect(parseArgs(["--out=-weird"], SPEC).options["--out"]).toBe("-weird");
  });

  it("dash guard does NOT apply to non-noDashValue flags (numeric/semantic owns the error)", () => {
    // --output-format is not in noDashValue; a dash value reaches the enum check, not the dash guard.
    expect(() => parseArgs(["--output-format", "-1"], SPEC)).toThrow(/expected one of/);
  });

  // non-empty value policy (default reject empty/whitespace; opt out per-flag).
  it("rejects an empty value for a value-flag by default (spaced and equals forms)", () => {
    expect(() => parseArgs(["--out", ""], SPEC)).toThrow(/--out requires a non-empty value/);
    expect(() => parseArgs(["--out="], SPEC)).toThrow(/--out requires a non-empty value/);
  });

  it("rejects a whitespace-only value for a value-flag by default", () => {
    expect(() => parseArgs(["--out", "   "], SPEC)).toThrow(/--out requires a non-empty value/);
    expect(() => parseArgs(["--out=\t"], SPEC)).toThrow(/--out requires a non-empty value/);
  });

  it("rejects an empty value for a repeated value-flag by default", () => {
    expect(() => parseArgs(["--allow", ""], SPEC)).toThrow(/--allow requires a non-empty value/);
  });

  it("the empty-value default fires before the enum check (clear non-empty message, not enum mismatch)", () => {
    expect(() => parseArgs(["--output-format", ""], SPEC)).toThrow(/--output-format requires a non-empty value/);
  });

  it("allowEmpty opts a flag out of the non-empty default (spaced and equals forms)", () => {
    const optOut = { ...SPEC, allowEmpty: ["--out"] };
    expect(parseArgs(["--out", ""], optOut).options["--out"]).toBe("");
    expect(parseArgs(["--out="], optOut).options["--out"]).toBe("");
    // the opt-out is per-flag: a non-opted flag still rejects empty
    expect(() => parseArgs(["--decider-cmd", ""], optOut)).toThrow(/--decider-cmd requires a non-empty value/);
  });
});
