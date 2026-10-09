// T-G2 — replay the flagship cassette from a REAL extracted tarball, and pin what staleness does there.
//
// `npm-payload-flagship-replay.test.ts` asserts the payload: every file the cassette resolves is in
// `files[]`. This asserts the BEHAVIOUR the payload was supposed to buy — the documented first command
// actually runs from an npm install — and then measures what a tampered skill file does to it.
//
// WHAT IT FOUND, and why the arms are paired. A cassette is recorded in `git` file-set mode (the default,
// inside a work tree). An extracted tarball is not a work tree, so the walk falls back to `raw`. A hash
// taken over a different file-set boundary is not comparable to the recorded one, so `verifyStaleness`
// SHORT-CIRCUITS at the mode branch (`cassette.ts`, the `recMode !== liveMode` arm) and emits `format`
// instead of a content diff. `format` sits outside SKILL_DRIFT_CLASSES. The consequence, measured below:
//
//   in an extracted tarball, `--fail-on-skill-drift` reports ok:true on a tampered skill file.
//
// That is the designed behaviour, not a bug being papered over — a git-mode digest and a raw-mode digest
// cover different file sets, and inventing a diff between them would be misleading. It is pinned here
// because it is surprising, because it is the state EVERY npm consumer replays in, and because the
// alternative (classing the mode flip `unverifiable-skill`, as the hash-epoch branch directly above it is
// classed for the same incomparability) would make a bare replay from an npm install exit non-zero — the
// exact promise the payload fix exists to keep. Whoever changes that trade-off should have to change this
// test and say so.
//
// The git-mode arm is the positive control. Without it, "no skill finding in the tarball" could just mean
// the mutation never applied or the runner is broken — a test that cannot fail. Same directory, same
// mutation, same flag: `git init` makes it exit 1 with class `skill`.
//
// Needs dist/cli.js (the `ci` script builds first).

import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, appendFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CASSETTE = "examples/replays/example-pdf-skill.cassette.json";
const SKILL_FILE = "examples/skills/my-pdf-skill/skills/my-pdf-skill/SKILL.md";

type Run = { code: number; classes: string[]; failureKinds: string[]; ok: boolean };

function replay(cwd: string, flags: string[]): Run {
  const r = spawnSync(process.execPath, ["dist/cli.js", "replay", CASSETTE, "--output-format", "json", ...flags], {
    cwd,
    encoding: "utf8",
  });
  if (!r.stdout.trim()) throw new Error(`replay produced no JSON (code ${r.status}):\n${r.stderr}`);
  const env = JSON.parse(r.stdout) as {
    ok: boolean;
    results: { staleness?: { class: string }[]; verdict: { failures?: { kind: string }[] } }[];
  };
  const res = env.results[0];
  return {
    code: r.status ?? -1,
    ok: env.ok,
    classes: (res.staleness ?? []).map((s) => s.class),
    failureKinds: (res.verdict.failures ?? []).map((f) => f.kind),
  };
}

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

let pkg: string;
const runs: Record<string, Run> = {};

beforeAll(() => {
  // A tarball extracted INSIDE a work tree makes `git ls-files` report every extracted file as untracked,
  // so the tracked set comes back empty and staleness blames the skill instead of the boundary. os.tmpdir()
  // is outside the repo; the assertion below is there because that artifact already cost real debugging time.
  const lab = mkdtempSync(join(tmpdir(), "cwh-payload-"));
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--pack-destination", lab, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }),
  ) as { filename: string }[];
  execFileSync("tar", ["xzf", join(lab, packed[0].filename)], { cwd: lab });
  pkg = join(lab, "package");

  // Only the DECLARED runtime deps — so a `dist/` import of an undeclared package fails here the way it
  // would fail a real install, instead of being masked by the repo's full node_modules.
  const deps = Object.keys(
    (JSON.parse(execFileSync("node", ["-p", "JSON.stringify(require('./package.json').dependencies)"], { encoding: "utf8" })) ??
      {}) as Record<string, string>,
  );
  mkdirSync(join(pkg, "node_modules"), { recursive: true });
  for (const d of deps) symlinkSync(resolve("node_modules", d), join(pkg, "node_modules", d));

  // Fail with the CAUSE, not a downstream ENOENT, when `files[]` stops shipping what this needs.
  const need = (rel: string, why: string) => {
    if (!existsSync(join(pkg, rel))) throw new Error(`the tarball does not ship ${rel} — ${why}`);
  };
  need("dist/cli.js", "run `npm run build` first (the `ci` script does)");

  runs.rawClean = replay(pkg, []);
  git(pkg, ["init", "-q", "."]);
  git(pkg, ["add", "-A"]);
  runs.gitCleanStrict = replay(pkg, ["--strict"]);
  need(SKILL_FILE, "package.json files[] no longer ships the flagship skill sources");
  appendFileSync(join(pkg, SKILL_FILE), "\n<!-- drift -->\n");
  git(pkg, ["add", "-A"]);
  runs.gitDrift = replay(pkg, ["--fail-on-skill-drift"]);
  rmSync(join(pkg, ".git"), { recursive: true, force: true });
  runs.rawDrift = replay(pkg, ["--fail-on-skill-drift"]);
  runs.rawDriftStrict = replay(pkg, ["--strict"]);
}, 180_000);

describe("T-G2 · replay from an extracted npm tarball", () => {
  it("measures a real extracted tarball, outside any git work tree", () => {
    expect(existsSync(join(pkg, "dist", "cli.js")), "the tarball shipped no dist/cli.js").toBe(true);
    expect(existsSync(join(pkg, SKILL_FILE)), "the tarball shipped no skill file to mutate").toBe(true);
    const probe = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: pkg, encoding: "utf8" });
    expect(probe.stdout.trim(), "the extract dir is inside a git work tree — every measurement here is void").not.toBe("true");
  });

  it("the documented first command runs green from an npm install", () => {
    // The 2.0.0 regression: `replay examples/replays/example-pdf-skill.cassette.json` exited 1 from a real
    // install. Exit 0 with only the honest boundary warning is the promise.
    expect(runs.rawClean.code, "the flagship replay is red from a tarball again").toBe(0);
    expect(runs.rawClean.classes).toEqual(["format"]);
  });

  it("the payload is fingerprint-complete: in git mode the same tarball is --strict clean", () => {
    // If `files[]` were missing any hashed file, the skill hash would differ here too and this would be
    // red — so this is what proves the boundary flip is the ONLY thing --strict objects to.
    expect(runs.gitCleanStrict.classes).toEqual([]);
    expect(runs.gitCleanStrict.code).toBe(0);
  });

  it("POSITIVE CONTROL — in git mode the tampered skill file is caught, classed `skill`", () => {
    expect(runs.gitDrift.classes).toContain("skill");
    expect(runs.gitDrift.failureKinds).toContain("staleness");
    expect(runs.gitDrift.code).toBe(1);
  });

  it("in the tarball the same tampering is NOT caught — the boundary flip masks it", () => {
    // Same directory, same mutation, same flag as the control above; only `.git` is gone. Read this next
    // to the header comment: it is pinned, not endorsed.
    expect(runs.rawDrift.classes).toEqual(["format"]);
    expect(runs.rawDrift.classes, "skill drift became visible in raw mode — re-read the trade-off above").not.toContain("skill");
    expect(runs.rawDrift.code).toBe(0);
    expect(runs.rawDrift.ok).toBe(true);
    // ...and --strict fails, but on the boundary, never naming the tampering.
    expect(runs.rawDriftStrict.code).toBe(1);
    expect(runs.rawDriftStrict.classes).toEqual(["format"]);
  });
});

describe("artifact_json.schema from an extracted npm tarball", () => {
  // ajv is a runtime dependency that loads lazily, on the first `schema:`. Only the declared runtime deps are linked
  // into the extract, so a schema check from the packed CLI proves ajv ships and resolves (`ajv/dist/2020.js`, with
  // the extension: ajv has no exports map, so the bare subpath fails under Node while tsc and vitest accept it).
  it("lint refuses a `format` keyword through the packed CLI", () => {
    const dir = mkdtempSync(join(tmpdir(), "cwh-payload-schema-"));
    const p = join(dir, "s.yaml");
    writeFileSync(
      p,
      [
        "baseline: latest",
        "fidelity: container",
        "prompt: hi",
        "assert:",
        "  - artifact_json: {artifact: outputs/p.json, schema: {type: object, properties: {m: {type: string, format: email}}}}",
      ].join("\n") + "\n",
    );
    const r = spawnSync(process.execPath, ["dist/cli.js", "lint", p], { cwd: pkg, encoding: "utf8" });
    rmSync(dir, { recursive: true, force: true });
    expect(`${r.stdout}${r.stderr}`).toMatch(/`format` \("email"\)/);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/Cannot find module|ERR_MODULE_NOT_FOUND/);
  });
});
