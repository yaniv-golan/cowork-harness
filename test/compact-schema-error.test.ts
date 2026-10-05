import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { compactSchemaError } from "../src/errors.js";

// A broken-file listing used to print `ZodError.message` — `JSON.stringify(issues, null, 2)`, 13-16
// lines per file. A consumer measured a 35-file corpus break at ~455 lines, none of it suppressed by
// `--quiet` (correctly: those lines are the failure, not the preview — the bug was their SIZE).
// `compactSchemaError` shipped for a `::notice::` path and had NO tests; it is now the single formatter
// for every render site, so it gets some.
describe("compactSchemaError", () => {
  it("renders one clause per issue, with a path an author can locate", () => {
    const out = compactSchemaError([
      { code: "unrecognized_keys", message: 'Unrecognized key: "not_a_real_key"', path: ["assert", 0] },
      { code: "invalid_value", message: "Invalid option", path: ["assert", 0, "path_denied", "source"] },
    ]);
    // BRACKETED indices: `assert.0` is not a shape you can find in a YAML file.
    expect(out).toBe('Unrecognized key: "not_a_real_key" at assert[0]; Invalid option at assert[0].path_denied.source');
  });

  it("caps a long issue list and says how many it hid", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ message: `issue ${i}`, path: ["assert", i] }));
    expect(compactSchemaError(many)).toMatch(/issue 0 at assert\[0\].*… \+3 more$/);
  });

  it("accepts an already-formatted message (the sites that only have a string)", () => {
    const formatted = `invalid scenario x.yaml: ${JSON.stringify([{ message: "Bad thing", path: ["fidelity"] }], null, 2)}`;
    expect(compactSchemaError(formatted)).toBe("Bad thing at fidelity");
  });

  it("MUST NOT THROW — an unparseable or pathless input still yields a usable line", () => {
    expect(compactSchemaError("YAML parse error: bad\n\n  - a: 1\n ^")).toBe("YAML parse error: bad - a: 1 ^");
    expect(compactSchemaError("[not json at all")).toBe("[not json at all");
    expect(compactSchemaError([{ message: "no path here" }])).toBe("no path here at (root)");
    expect(() => compactSchemaError([null, 3, { nope: 1 }] as unknown[])).not.toThrow();
  });
});

const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);
function cli(args: string[]) {
  const r = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, COWORK_HARNESS_RUNS_DIR: join(mkdtempSync(join(tmpdir(), "cse-runs-")), "runs") },
  });
  return { code: r.status, stderr: r.stderr ?? "", stdout: r.stdout ?? "" };
}
const BROKEN = "name: b\nprompt: hi\nfidelity: protocol\nassert:\n  - not_a_real_key: true\n";
const BAD_YAML = "name: y\nprompt: hi\nfidelity: protocol\nassert:\n  - a: 1\n   b: 2\n";

describe.skipIf(!can)("a broken-file listing is one line per file", () => {
  // Asserted on STDERR (`log` writes fd 2) and by SHAPE, not by a total line count — that count moves
  // with the runs header, the all-broken summary, and any warning, none of which this owns.
  const listing = (body: string, ext = "yaml") => {
    const w = mkdtempSync(join(tmpdir(), "cse-"));
    const dir = join(w, "corpus");
    mkdirSync(dir);
    for (const n of ["a", "b"]) writeFileSync(join(dir, `${n}.${ext}`), body);
    return cli(["record", dir, "--dry-run", "--quiet"]);
  };

  it("a schema break prints no JSON scaffolding", () => {
    const r = listing(BROKEN);
    expect(r.stderr.split("\n").filter((l) => l.startsWith("✗ broken:")).length).toBe(2);
    expect(r.stderr, "the Zod issue array must not reach the terminal").not.toMatch(/"code":\s*"/);
    expect(r.stderr).not.toMatch(/^\s*\]\s*$/m);
    expect(r.stderr.split("\n").find((l) => l.includes("a.yaml"))).toMatch(/not_a_real_key/);
  });

  it("a YAML syntax break is collapsed too — it is a code frame, not a sentence", () => {
    // The likeliest way a whole corpus breaks at once is one bad indent. Left alone, this branch stayed
    // ~6 lines per file (two of them BLANK, which is worse than JSON in a CI log).
    const r = listing(BAD_YAML);
    expect(r.stderr.split("\n").filter((l) => l.startsWith("✗ broken:")).length).toBe(2);
    expect(r.stderr, "the code frame's caret line must not survive").not.toMatch(/^\s*\^\s*$/m);
    expect(r.stderr.split("\n").find((l) => l.includes("a.yaml"))).toMatch(/YAML parse error/);
  });

  it("the file path is not printed twice on one line", () => {
    const r = listing(BROKEN);
    const line = r.stderr.split("\n").find((l) => l.startsWith("✗ broken:")) ?? "";
    expect(line.split("a.yaml").length - 1, "the listing already names the file").toBe(1);
  });
});
