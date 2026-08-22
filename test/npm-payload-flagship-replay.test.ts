// T-P1 — the flagship zero-token replay must work from an npm install, not just a git checkout.
//
// `README.md` and `examples/replays/README.md` tell a new reader to run
//
//   cowork-harness replay examples/replays/example-pdf-skill.cassette.json
//
// as the first thing they do. From an npm install that exited 1: the cassette references
// `../sessions/default.yaml`, `../scenarios/…` and `../skills/my-pdf-skill`, and `package.json`'s
// `files[]` shipped only `examples/replays`. It is the first command in the docs and it was broken.
//
// WHY A PAYLOAD TEST AND NOT AN ORDINARY ONE. The regression lives in what npm SHIPS, not in the code.
// A source checkout has every file, so no ordinary test can see it — only the packed file list can.
//
// MEASURE THIS OUTSIDE A GIT REPOSITORY. Extracting the tarball inside a git work tree (a worktree, or
// anywhere under one) makes `git ls-files` report the extracted files as untracked, so the tracked set
// comes back EMPTY and staleness blames the skill ("2 removed") instead of the packaging. That artifact
// cost real debugging time and produced two wrong conclusions before it was spotted. `/tmp` is fine.
//
// SCOPE: this asserts the PAYLOAD. It deliberately does not assert `replay --strict` from a tarball,
// which is not a packaging defect — see STRICT_IS_OUT_OF_SCOPE below.

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Paths inside the tarball that the flagship cassette resolves at replay time. */
function requiredPayloadPaths(): string[] {
  const c = JSON.parse(readFileSync(resolve("examples/replays/example-pdf-skill.cassette.json"), "utf8")) as {
    scenario: { session: string };
    scenarioSource?: string;
    fingerprint?: { skillSources?: string[]; fileSigs?: [string, string][] };
  };
  const base = "examples/replays/";
  const rel = (p: string) => `package/${base}${p}`.replace(/\/\.\//g, "/");
  const out = [rel(c.scenario.session)];
  if (c.scenarioSource) out.push(rel(c.scenarioSource));
  // Every file the fingerprint hashed must be present, or staleness reports it "removed" — including
  // anything under a dot-directory, which is the case npm silently drops.
  for (const dir of c.fingerprint?.skillSources ?? []) for (const [f] of c.fingerprint?.fileSigs ?? []) out.push(rel(`${dir}/${f}`));
  // normalize ../ segments
  return out.map((p) =>
    p
      .split("/")
      .reduce<string[]>((a, s) => (s === ".." ? (a.pop(), a) : (a.push(s), a)), [])
      .join("/"),
  );
}

describe("T-P1 · the npm payload carries what the flagship replay needs", () => {
  const packed = (): string[] => {
    // `--dry-run --json` gives the exact file list npm would publish, without writing a tarball.
    const raw = execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return (JSON.parse(raw) as { files: { path: string }[] }[])[0].files.map((f) => `package/${f.path}`);
  };

  it("reads a sane payload and a sane requirement list (never go green over an empty read)", () => {
    expect(packed().length, "npm pack --dry-run returned almost nothing").toBeGreaterThan(50);
    expect(requiredPayloadPaths().length, "derived no required paths from the cassette").toBeGreaterThan(2);
  });

  it("ships every file the flagship cassette resolves", () => {
    const have = new Set(packed());
    const missing = requiredPayloadPaths().filter((p) => !have.has(p));
    expect(
      missing,
      `the documented zero-token replay will fail from an npm install — these are referenced by the cassette but not in files[]:\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });
});

// STRICT_IS_OUT_OF_SCOPE.
//
// `replay --strict` cannot pass from a tarball for this cassette, and that is correct behaviour:
//
//   - The cassette records `fingerprint.mode: "git"` — recorded inside a git work tree, the default.
//   - An extracted tarball is not one, so `gitTrackedSet` returns null and the walk falls back to raw
//     exactly as designed. Staleness then reports the honest, actionable
//     `recorded in 'git' file-set mode, verifying in 'raw' (COWORK_HARNESS_GITSET)` — classed `format`,
//     which warns at exit 0 and only fails under `--strict`. Measured outside any repo.
//
// So a git-recorded cassette is `--strict`-clean only inside a git work tree, by construction. Recording
// it raw would merely move the failure to the source checkout. `--strict` means "any staleness is a
// failure", and "this is not the file-set boundary I was recorded under" is a legitimate one. The plain
// command is the promise the docs make, and it is what this guard protects.
