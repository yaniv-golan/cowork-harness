import { describe, it, expect } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { CATALOG_FILES, CATALOG_HUB } from "./helpers/assertion-catalog.js";

// The assertion catalog is the one skill reference every new assertion key grows. `lint-skill` fails a
// reference past _SKILL_REFERENCE_READ_CAP (what one whole-file Read returns), and that fired at release
// time, after several branches had each added rows that fit alone. This keeps 10% headroom per catalog
// file so the next split is forced by the PR that crosses the line, not by whichever PR merges last. The
// cap is read from scenario.py, its single source; raising it is not the remedy — split a family out.
const SKILL_DIR = ".claude/skills/cowork-harness";
const py = readFileSync(resolve(`${SKILL_DIR}/scripts/scenario.py`), "utf8");
const cap = Number(/^_SKILL_REFERENCE_READ_CAP = ([\d_]+)$/m.exec(py)?.[1]?.replaceAll("_", ""));
const HEADROOM = 0.1;

describe("assertion catalog: each file keeps headroom under the reference read cap", () => {
  it("found the cap and the hub plus its per-family files (not a vacuous pass)", () => {
    expect(cap).toBe(60_000);
    expect(CATALOG_FILES).toContain(CATALOG_HUB);
    expect(CATALOG_FILES.length).toBeGreaterThanOrEqual(4);
  });

  for (const f of CATALOG_FILES)
    it(`${basename(f)} stays at least ${HEADROOM * 100}% under the ${cap.toLocaleString("en-US")} B cap`, () => {
      const size = statSync(resolve(f)).size;
      expect(
        size,
        `${f} is ${size.toLocaleString("en-US")} B; keep it under ${(cap * (1 - HEADROOM)).toLocaleString("en-US")} B by moving a family to its own assertion-catalog-<family>.md`,
      ).toBeLessThanOrEqual(cap * (1 - HEADROOM));
    });

  it("every per-family file is linked from the hub and from SKILL.md, so a reader can find its rows", () => {
    const hub = readFileSync(resolve(CATALOG_HUB), "utf8");
    const skill = readFileSync(resolve(`${SKILL_DIR}/SKILL.md`), "utf8");
    for (const f of CATALOG_FILES.filter((x) => x !== CATALOG_HUB)) {
      const name = basename(f);
      expect(hub, `${name} not linked from assertion-catalog.md`).toContain(`(./${name})`);
      expect(skill, `${name} not linked from SKILL.md`).toContain(`(references/${name})`);
    }
  });
});
