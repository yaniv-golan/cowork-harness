import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { FIDELITY_TIERS } from "../src/types.js";

// The fidelity tier list was written out as a literal in FIVE places in `src` alone — and a canonical
// `FIDELITY_TIERS` const already existed in cli.ts that three of the other sites simply did not use. That
// is how a list rots: the canonical value exists, nothing forces anyone to use it, and a copy goes stale
// without a single test turning red.
//
// A downstream consumer reading a stale tier list is one of the misreads this consolidation prevents, so
// the consolidation needs a guard or it will silently un-consolidate.

function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...srcFiles(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Any array literal spelling out the tier set, in any order and with any quoting/spacing. Deliberately
 *  order- and whitespace-insensitive: a copy that reorders the tiers is still a copy, and matching only
 *  the exact canonical spelling would let the next one through. */
function tierLiteralHits(): { file: string; snippet: string }[] {
  const hits: { file: string; snippet: string }[] = [];
  const arrayLiteral = /\[[^\]]*\]/g;
  for (const file of srcFiles(resolve("src"))) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(arrayLiteral)) {
      const body = m[0];
      const names = [...body.matchAll(/["']([a-z]+)["']/g)].map((x) => x[1]!);
      if (names.length !== FIDELITY_TIERS.length) continue;
      if ([...names].sort().join(",") !== [...FIDELITY_TIERS].sort().join(",")) continue;
      hits.push({ file: file.replace(resolve(".") + "/", ""), snippet: body.slice(0, 80) });
    }
  }
  return hits;
}

describe("fidelity tiers have a single source", () => {
  it("the guard can actually see tier literals (never go green over an empty scan)", () => {
    // If the scanner matched nothing at all, every assertion below would pass vacuously — including in a
    // tree where the list had been copied into ten new files.
    expect(srcFiles(resolve("src")).length).toBeGreaterThan(20);
    expect(FIDELITY_TIERS.length).toBe(5);
  });

  it("exactly ONE literal tier list exists in src — the canonical declaration", () => {
    const hits = tierLiteralHits();
    expect(
      hits.map((h) => `${h.file}: ${h.snippet}`),
      "a second literal tier list appeared — import FIDELITY_TIERS from types.ts instead of spelling it out",
    ).toHaveLength(1);
    expect(hits[0]!.file, "the one literal should be the canonical declaration in types.ts").toBe("src/types.ts");
  });

  it("the published scenario schema's enum matches the canonical const", () => {
    // schema/scenario.schema.json is a §12-covered contract surface that consumers commit and diff. It is
    // generated from the Zod enum, which is now derived from FIDELITY_TIERS — this pins that chain end to
    // end, so a regenerated schema that disagrees is caught rather than shipped.
    const schema = JSON.parse(readFileSync(resolve("schema/scenario.schema.json"), "utf8"));
    expect(schema.properties.fidelity.enum).toEqual([...FIDELITY_TIERS]);
  });

  it("the CLI help text advertises exactly the canonical tiers", () => {
    // The surface a user or coding agent actually reads. Help strings are hand-written prose, so they
    // cannot be generated from the const without a rewrite — but they CAN be checked against it.
    const cli = readFileSync(resolve("src/cli.ts"), "utf8");
    const joined = FIDELITY_TIERS.join("|");
    expect(cli, `help text no longer advertises "${joined}" — a tier was added or renamed without updating --help`).toContain(joined);
  });
});
