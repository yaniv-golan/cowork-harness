import { describe, it, expect } from "vitest";
import { parseArgs, ArgError } from "../src/cli-args.js";

const SPEC = {
  booleans: ["--strict"],
  values: ["--out", "--output-format", "--decider-cmd"],
  repeated: ["--allow"],
  enums: { "--output-format": ["text", "json"] },
  aliases: { "-q": "--quiet", "-V": "--verbose" },
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
    const p = parseArgs(["a", "-q", "-V"], { ...SPEC, booleans: ["--strict", "--quiet", "--verbose"] });
    expect(p.flags["--quiet"]).toBe(true);
    expect(p.flags["--verbose"]).toBe(true);
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
});
