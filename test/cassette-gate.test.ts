import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync, cpSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";

// The pre-commit cassette gate, and the CI sweep it pre-empts.
//
// WHY THIS FILE EXISTS. For the maintainer — the only person who records host-inheriting cassettes —
// `.githooks/pre-commit` is not one layer of two. `ci.yml` triggers on `push: [main]` and `pull_request`,
// and the documented local workflow lands with `merge --ff-only` into `main` and pushes afterwards, so by
// the time CI reds, the cassette is already in public history. That is the exact shape of the inventory
// leak this gate exists to prevent. Every hole in the hook is therefore a single point of failure, and
// until now the hook had no test of any kind.
//
// The hook's `verify-cassettes` calls are driven through a STUB `dist/cli.js` in a scratch repo. That is
// deliberate: the point under test is the hook's own exit-code handling, and reproducing a genuine exit 2
// or a genuine exit-3-with-an-error-cause from the real CLI would couple these tests to CLI internals that
// have nothing to do with the branch being exercised. The stub's contract (exit code + `--output-format
// json` payload) is pinned against the real CLI in `pins the real CLI's exit-code contract` below, so the
// stub cannot drift into testing a CLI that no longer exists.

const HOOK = resolve(".githooks/pre-commit");
const REAL_CLI = resolve("dist/cli.js");

/** A scratch git repo with the hook copied in. `stubExit`/`stubJson` drive the fake `dist/cli.js`. */
function scratchRepo(opts: {
  stubExit?: number;
  stubJson?: unknown;
  withDist?: boolean;
  replaysDir?: boolean;
  stageBaseline?: boolean;
  stage?: Record<string, string>;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "cwh-hook-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("config", "commit.gpgsign", "false");

  mkdirSync(join(dir, ".githooks"), { recursive: true });
  cpSync(HOOK, join(dir, ".githooks", "pre-commit"));
  chmodSync(join(dir, ".githooks", "pre-commit"), 0o755);

  if (opts.replaysDir !== false) {
    mkdirSync(join(dir, "examples", "replays"), { recursive: true });
    writeFileSync(join(dir, "examples", "replays", "x.cassette.json"), "{}");
  }

  if (opts.withDist !== false) {
    mkdirSync(join(dir, "dist"), { recursive: true });
    // The stub distinguishes the JSON probe (used only by the exit-3 cause split) from the human run.
    const json = JSON.stringify(opts.stubJson ?? { results: [] });
    writeFileSync(
      join(dir, "dist", "cli.js"),
      [
        // The JSON probe branch MUST exit with the same code as the human branch. The real CLI does:
        // `verify-cassettes --output-format json` on an unscannable cassette exits 3, which is the whole
        // reason the hook is in that branch. A stub that exited 0 here hid a live fail-open — the hook
        // appended a second "true" from `|| echo true` and the resulting "truetrue" failed an `= "true"`
        // comparison, waving the unscannable cassette through. Stub fidelity on the EXIT CODE, not just
        // the payload, is what makes these tests evidence.
        `const argv = process.argv.slice(2);`,
        `if (argv.includes("--output-format") && argv.includes("json")) {`,
        `  process.stdout.write(${JSON.stringify(json)});`,
        `  process.exit(${opts.stubExit ?? 0});`,
        `}`,
        `process.stdout.write("stub verify-cassettes ran: " + argv.join(" ") + "\\n");`,
        `process.exit(${opts.stubExit ?? 0});`,
      ].join("\n"),
    );
  }

  for (const [rel, body] of Object.entries(opts.stage ?? {})) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), body);
    git("add", rel);
  }

  // Stage a baseline — the hook's name-derived trigger. Nothing below runs without some trigger.
  if (opts.stageBaseline !== false) {
    mkdirSync(join(dir, "baselines"), { recursive: true });
    writeFileSync(join(dir, "baselines", "desktop-9.9.9.json"), "{}");
    git("add", "baselines/desktop-9.9.9.json");
  }
  return dir;
}

/** Copy a committed cassette in as the "this directory verifies clean" fixture, with its `fingerprint`
 *  STRIPPED.
 *
 *  Normalising that axis is load-bearing, not tidiness. These cases are about the hook's exit-code
 *  handling; the cassette is scenery. But a committed fixture carries `fingerprint.baseline`, and EVERY
 *  parity sync moves `latest` and stales it — at which point the directory scan exits 1, the hook blocks,
 *  and these cases fail with a message about baseline drift that has nothing to do with what they test.
 *  Verified by simulation, not assumed: re-stamping the fixture to an older baseline reds exactly the two
 *  cases below, and restoring this line greens them again.
 *
 *  With no fingerprint there is no baseline or skill axis to go stale, and the file still verifies clean
 *  (exit 0), so the fixture keeps its only job and a future sync cannot touch it. Credit to the peer
 *  session that hit the same coupling from the other side. */
function stageCleanReplays(dir: string): void {
  mkdirSync(join(dir, "examples", "replays"), { recursive: true });
  const c = JSON.parse(readFileSync(resolve("examples/replays/example-multiselect-gate.cassette.json"), "utf8")) as Record<string, unknown>;
  delete c.fingerprint;
  writeFileSync(join(dir, "examples", "replays", "clean.cassette.json"), JSON.stringify(c, null, 2));
}

/** Run the hook. Returns its exit code and combined output — never throws on a non-zero exit. */
function runHook(dir: string): { code: number; out: string } {
  try {
    const out = execFileSync("bash", [join(dir, ".githooks", "pre-commit")], {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
      env: { ...process.env, PATH: process.env.PATH ?? "" },
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe("pre-commit cassette gate — it must FAIL CLOSED", () => {
  it("blocks when dist/ is not built, instead of warning and letting the commit through", () => {
    // This is the state a fresh clone, a `git clean -xdf`, a branch switch AND a failing typecheck all
    // land in — `npm run build` does `rm -rf dist` FIRST, so a mid-refactor tree has no dist/cli.js at
    // all. The old hook echoed a ⚠ and fell through, so the guard was off in exactly the situations it is
    // easiest to be in, and the warning scrolled past above a successful commit.
    const dir = scratchRepo({ withDist: false });
    const { code, out } = runHook(dir);
    expect(code).not.toBe(0);
    expect(out).toMatch(/dist\/cli\.js not built/);
    expect(out).toMatch(/npm run build/);
  });

  it("blocks on exit 2 — a renamed directory or a renamed flag, which no test elsewhere would catch", () => {
    // `hook_status` used to be a DENYLIST testing `= 1` and `= 3`; everything else fell through to a
    // successful commit. Exit 2 is reached by renaming/emptying examples/replays/ or renaming any CLI
    // flag the hook passes — both ordinary refactors that fail nothing else in the tree.
    const { code, out } = runHook(scratchRepo({ stubExit: 2 }));
    expect(code).not.toBe(0);
    expect(out).toMatch(/did not pass cleanly \(exit 2\)/);
  });

  it("blocks on exit 127 — node missing from PATH must not read as 'verified clean'", () => {
    const { code } = runHook(scratchRepo({ stubExit: 127 }));
    expect(code).not.toBe(0);
  });

  it("still blocks on exit 1, the finding it always blocked on", () => {
    const { code, out } = runHook(scratchRepo({ stubExit: 1 }));
    expect(code).not.toBe(0);
    expect(out).toMatch(/host-inventory/);
  });

  it("lets a clean run through — and proves the gate actually RAN, not that it silently no-op'd", () => {
    // The tautology trap: asserting only `code === 0` in a scratch repo passes even if verify-cassettes is
    // deleted from the tree, because a hook that does nothing also exits 0. Assert the stub's own output.
    const { code, out } = runHook(scratchRepo({ stubExit: 0 }));
    expect(code).toBe(0);
    expect(out).toMatch(/stub verify-cassettes ran/);
  });
});

describe("pre-commit cassette gate — exit 3 is split by CAUSE, not waved through wholesale", () => {
  // `cmdVerifyCassettes` returns 3 for several different things, so the exit code alone cannot say
  // whether the privacy scan ran. The envelope answers that directly with `privacyScanned`, and the gate
  // keys on it: a cassette that merely fails SHAPE validation is still scanned (see the read-boundary
  // split in test/scan-read-boundary.test.ts) and must NOT block, while one whose transcript could not be
  // read at all must, because zero findings there is an absence of evidence, not evidence of absence.
  // Keying on `error` instead — as the first version did — blocked commits touching a scannable eval
  // fixture, which is how an operator learns to reach for --no-verify.
  it("blocks when the privacy scan could not run at all", () => {
    const { code, out } = runHook(
      scratchRepo({ stubExit: 3, stubJson: { results: [{ file: "x", error: "unreadable JSON", version: [], privacyScanned: false }] } }),
    );
    expect(code).not.toBe(0);
    expect(out).toMatch(/could NOT BE SCANNED/);
  });

  it("blocks whenever privacyScanned is false, whatever the accompanying error says", () => {
    const { code, out } = runHook(
      scratchRepo({
        stubExit: 3,
        stubJson: { results: [{ file: "x", error: null, version: ["recorded at v99"], privacyScanned: false }] },
      }),
    );
    expect(code).not.toBe(0);
    expect(out).toMatch(/could NOT BE SCANNED/);
  });

  it("WARNS but allows when the file WAS scanned and only staleness is unverifiable", () => {
    // Staleness genuinely is "we looked and could not conclude", and it is common on a moved cassette.
    // Blocking here would train the maintainer to reach for --no-verify, which is worse than the warning.
    const { code, out } = runHook(
      scratchRepo({ stubExit: 3, stubJson: { results: [{ file: "x", error: null, version: [], privacyScanned: true }] } }),
    );
    expect(code).toBe(0);
    expect(out).toMatch(/unverifiable STALENESS/);
  });

  it("fails CLOSED when the JSON probe itself is unparseable", () => {
    // If the cause cannot be determined, the answer is not "assume staleness". Note the payload here is
    // VALID JSON with no `results` array — the first draft of this test passed a bare JSON string and the
    // probe read it as "nothing unscanned", which is the fail-open the `Array.isArray` check now closes.
    const { code, out } = runHook(scratchRepo({ stubExit: 3, stubJson: { notResults: 1 } }));
    expect(code).not.toBe(0);
    expect(out).toMatch(/could NOT BE SCANNED/);
  });
});

describe("pre-commit cassette gate — the two blind spots in any FILENAME-derived rule", () => {
  const RECORDING = JSON.stringify({ generator: "cowork-harness", events: [], scenario: {} });

  it("catches a recording written to a path that is not *.cassette.json", () => {
    // `record --out` accepts an arbitrary path with no suffix validation, so `--out notes/run.json` is a
    // real recording — carrying a real host inventory — that the name regex cannot see. Before this, such
    // a commit did not trigger the hook AT ALL: not the directory scan, not the per-file loop.
    const { code, out } = runHook(scratchRepo({ stubExit: 0, stageBaseline: false, stage: { "notes/run.json": RECORDING } }));
    expect(out, "a generator-stamped .json did not trigger the gate").toMatch(/stub verify-cassettes ran/);
    expect(out).toMatch(/notes\/run\.json/);
    expect(code).toBe(0);
  });

  it("does not mistake an ordinary staged .json for a recording", () => {
    // The content probe must not turn every package.json edit into a cassette scan.
    const { out } = runHook(scratchRepo({ stubExit: 0, stageBaseline: false, stage: { "tsconfig.json": '{"compilerOptions":{}}' } }));
    expect(out).toBe("");
  });

  it("scans a cassette in a SUBDIRECTORY of examples/replays/, which the directory scan cannot reach", () => {
    // `resolveInputs` does not recurse, so the `verify-cassettes examples/replays/` invocation never sees
    // a nested file — and the per-file loop used to exclude everything under `^examples/replays/`, so the
    // file was covered by neither. `isRepoVisiblePath`'s own docstring uses this exact path as its example.
    const { out } = runHook(
      scratchRepo({ stubExit: 0, stageBaseline: false, stage: { "examples/replays/sub/x.cassette.json": RECORDING } }),
    );
    expect(out).toMatch(/examples\/replays\/sub\/x\.cassette\.json/);
  });

  it("does not re-scan a cassette the directory invocation already covers", () => {
    // The dedup must stay precise: a file DIRECTLY in examples/replays/ is covered by the directory scan,
    // and scanning it twice doubles the cost of every re-record commit.
    const { out } = runHook(scratchRepo({ stubExit: 0, stageBaseline: false, stage: { "examples/replays/top.cassette.json": RECORDING } }));
    expect(out).not.toMatch(/examples\/replays\/top\.cassette\.json/);
    expect(out).toMatch(/stub verify-cassettes ran/);
  });
});

describe("pre-commit cassette gate — the hook must not abort on the ordinary paths", () => {
  // These exist because the content-derived trigger BROKE the hook for every normal commit and no test
  // above could see it: `scratchRepo` always stages a baseline `.json`, so the probe's `grep` always
  // matched. With `set -euo pipefail`, a `grep` that matches nothing exits 1, `pipefail` propagates it out
  // of the command substitution, and the assignment kills the hook — so EVERY commit that staged no
  // `.json` failed with no output at all. Caught by running the real hook on the real repo, not by any
  // scratch fixture, which is the lesson: exercise the empty case explicitly.
  it("exits 0 when nothing at all is staged", () => {
    const { code, out } = runHook(scratchRepo({ stubExit: 0, stageBaseline: false }));
    expect(code, `hook aborted on an empty index: ${out}`).toBe(0);
  });

  it("exits 0 when only non-JSON files are staged", () => {
    const { code, out } = runHook(scratchRepo({ stubExit: 0, stageBaseline: false, stage: { "README.md": "hi\n" } }));
    expect(code, `hook aborted with no staged .json: ${out}`).toBe(0);
    expect(out).toBe("");
  });
});

describe("pre-commit cassette gate — hygiene", () => {
  it("does not write its scratch output to a predictable world-writable path", () => {
    const hook = readFileSync(HOOK, "utf8");
    expect(hook).not.toMatch(/\/tmp\/cwh-verify-cassettes/);
    expect(hook).toMatch(/mktemp/);
  });

  it("is no laxer than the CI step scanning the same directory", () => {
    // The hook used to pass --allow-email/--allow-domain that ci.yml does not, so the local gate — the
    // ONLY gate on the push-to-main path — suppressed findings that CI would have raised.
    const hook = readFileSync(HOOK, "utf8");
    const hookAllows = [...hook.matchAll(/--allow-[a-z-]+/g)].map((m) => m[0]);
    expect(hookAllows).toEqual([]);
  });
});

describe("CI scans every tracked cassette", () => {
  const tracked = () => execFileSync("git", ["ls-files", "*.cassette.json"], { encoding: "utf8" }).split("\n").filter(Boolean);

  // Derived from git, never hard-coded: a test that asserts "there are 4 cassettes" is a fact about the
  // repo, not about ci.yml, and cannot fail when someone breaks the glob in the workflow.
  it("every tracked cassette is covered by a CI verify step or by the ONE documented exclusion", () => {
    const ci = readFileSync(join(".github", "workflows", "ci.yml"), "utf8");
    const doc = parse(ci) as { jobs?: Record<string, { steps?: { run?: string }[] }> };
    const runs = Object.values(doc.jobs ?? {}).flatMap((j) => (j.steps ?? []).map((s) => s.run ?? ""));

    const scansReplaysDir = runs.some((r) => /verify-cassettes\s+examples\/replays\//.test(r));
    const sweepsResidual = runs.some((r) => /git ls-files '\*\.cassette\.json'/.test(r) && /verify-cassettes/.test(r));
    expect(scansReplaysDir, "ci.yml no longer scans examples/replays/").toBe(true);
    expect(sweepsResidual, "ci.yml no longer sweeps tracked cassettes outside examples/replays/").toBe(true);

    // The exclusion is read OUT of ci.yml, so deleting it there fails here rather than silently widening.
    const excl = /EXCLUDE='([^']+)'/.exec(runs.join("\n"));
    expect(excl, "the documented EXCLUDE pattern vanished from ci.yml").not.toBeNull();
    const excluded = new RegExp(excl![1].replace(/\\\\/g, "\\"));

    // Two scanned roots: examples/replays/ (its own directory step) and test/fixtures/ (test-only
    // recordings that must stay out of the examples directory's replay and re-record cycle), which the
    // residual sweep above scans one file at a time. Anywhere else is still a finding: a cassette in a new
    // location is a decision to make here, on purpose, not a path the sweep happens to reach.
    const SWEPT_ROOTS = ["test/fixtures/"];
    const uncovered = tracked().filter(
      (f) => !f.startsWith("examples/replays/") && !excluded.test(f) && !(sweepsResidual && SWEPT_ROOTS.some((r) => f.startsWith(r))),
    );
    expect(uncovered, `tracked cassette(s) gated by nothing: ${uncovered.join(", ")}`).toEqual([]);
    expect(tracked().length, "the *.cassette.json pathspec stopped matching anything").toBeGreaterThan(0);
  });

  it("no recording hides behind a non-.cassette.json name (record --out does not validate the suffix)", () => {
    // `record --out` takes an arbitrary path, so `--out examples/replays/x.json` is invisible to the CI
    // pathspec, to the hook's trigger regex, and to `git ls-files '*.cassette.json'`. Cross-check the
    // suffix-derived set against a CONTENT-derived one.
    const byContent = execFileSync("git", ["grep", "-l", '"generator": *"cowork-harness"', "--", "*.json"], {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean)
      .sort();
    expect(byContent).toEqual(tracked().sort());
  });

  it("the documented exclusion still describes a file that is genuinely unverifiable", () => {
    // If someone gives report-check.cassette.json a `scenario.session`, it stops being unverifiable and
    // the exclusion becomes an unexplained hole. Pin the reason, not just the path.
    const p = join("test", "evals", "files", "report-check.cassette.json");
    expect(existsSync(p)).toBe(true);
    const c = JSON.parse(readFileSync(p, "utf8")) as { scenario?: { session?: string }; fingerprint?: { skillHash?: string } };
    expect(c.scenario?.session, "report-check.cassette.json became a valid cassette — drop the ci.yml exclusion").toBeUndefined();
    expect(c.fingerprint?.skillHash).toBe("sha256:synthetic-eval-fixture");
  });
});

describe("END TO END: the real hook, the real CLI, the real unscannable cassette", () => {
  // THE test that matters, and the one that was missing. Everything above drives a stub, so it can only
  // ever prove the hook handles what the stub DOES — and a stub is a claim about the CLI, not the CLI. The
  // first version of this suite was 22 green while the hook had a live fail-open: the real
  // `verify-cassettes --output-format json` exits 3 on an unscannable cassette (that is why the hook is in
  // that branch at all), `pipefail` lifted that out of the probe pipeline, `|| echo true` appended a SECOND
  // "true", and the resulting "truetrue" failed the `= "true"` comparison — so the cassette the privacy
  // scan never ran on was waved through as ordinary staleness. The stub exited 0 on that branch, so no
  // amount of stub-based coverage could see it.
  //
  // This case wires the actual repo hook to the actual built CLI against test/evals/files/report-check.cassette.json,
  // which is genuinely unscannable (no `scenario.session` ⇒ `readCassette` rejects the shape ⇒ `scanCassette`
  // never runs). If the hook stops blocking it, the gate has a hole.
  const built = existsSync(REAL_CLI);
  beforeAll(() => {
    if (!built) throw new Error("dist/cli.js missing — run `npm run build`; this case must not silently skip");
  });

  it("blocks a commit that stages a cassette the privacy scan cannot run on", () => {
    const dir = mkdtempSync(join(tmpdir(), "cwh-hook-e2e-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");

    // The REAL hook and the REAL CLI — symlinked so this tracks the tree rather than a copy of it.
    mkdirSync(join(dir, ".githooks"), { recursive: true });
    cpSync(HOOK, join(dir, ".githooks", "pre-commit"));
    symlinkSync(resolve("dist"), join(dir, "dist"));
    symlinkSync(resolve("src"), join(dir, "src")); // the hook reads the source's RECORDED_SCRUB_VERSION
    symlinkSync(resolve("node_modules"), join(dir, "node_modules"));

    // A clean fixture so the DIRECTORY scan passes; the unscannable one staged alongside it, so the only
    // thing that can block is the per-file check.
    stageCleanReplays(dir);
    // A cassette with NO transcript — genuinely unscannable. (It used to be report-check.cassette.json,
    // but the read-boundary split made that file scannable on purpose, so it no longer tests this.)
    mkdirSync(join(dir, "evals"), { recursive: true });
    writeFileSync(
      join(dir, "evals", "unscannable.cassette.json"),
      JSON.stringify({ generator: "cowork-harness", scenario: { prompt: "x" } }),
    );
    git("add", "evals/unscannable.cassette.json");

    let code = 0;
    let out = "";
    try {
      out = execFileSync("bash", [join(dir, ".githooks", "pre-commit")], { cwd: dir, encoding: "utf8", stdio: "pipe" });
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      code = err.status ?? -1;
      out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    }
    expect(code, `the hook allowed an unscannable cassette through:\n${out}`).not.toBe(0);
    expect(out).toMatch(/could NOT BE SCANNED/);
    expect(out).not.toMatch(/scan passed/);
  });
});

describe("END TO END: a shape-invalid but SCANNABLE cassette must not block", () => {
  // The other side of the case above, and the reason the read-boundary split was worth doing. The repo's
  // own eval fixture has no `scenario.session`, so it fails shape validation — but its transcript reads
  // fine and the privacy scan runs on it. Blocking here (which the first version of this gate did) is a
  // false positive on a file that IS checked, and the cost of a false positive on a pre-commit hook is
  // that the operator learns to pass --no-verify, which disables the gate for everything.
  const built = existsSync(REAL_CLI);
  beforeAll(() => {
    if (!built) throw new Error("dist/cli.js missing — run `npm run build`; this case must not silently skip");
  });

  it("allows a commit staging a cassette that fails shape validation but was scanned clean", () => {
    const dir = mkdtempSync(join(tmpdir(), "cwh-hook-e2e2-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    mkdirSync(join(dir, ".githooks"), { recursive: true });
    cpSync(HOOK, join(dir, ".githooks", "pre-commit"));
    symlinkSync(resolve("dist"), join(dir, "dist"));
    symlinkSync(resolve("src"), join(dir, "src")); // the hook reads the source's RECORDED_SCRUB_VERSION
    symlinkSync(resolve("node_modules"), join(dir, "node_modules"));
    stageCleanReplays(dir);
    mkdirSync(join(dir, "evals"), { recursive: true });
    cpSync(resolve("test/evals/files/report-check.cassette.json"), join(dir, "evals", "attachment.cassette.json"));
    git("add", "evals/attachment.cassette.json");

    let code = 0;
    let out = "";
    try {
      out = execFileSync("bash", [join(dir, ".githooks", "pre-commit")], { cwd: dir, encoding: "utf8", stdio: "pipe" });
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      code = err.status ?? -1;
      out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    }
    expect(code, `a scannable cassette was blocked:\n${out}`).toBe(0);
    expect(out).not.toMatch(/could NOT BE SCANNED/);
  });
});

describe("the stub's contract matches the real CLI", () => {
  // Everything above drives a stub. These pin the two facts the stub encodes, against the real binary, so
  // the suite cannot pass while testing a CLI shape that no longer exists.
  const built = existsSync(REAL_CLI);
  beforeAll(() => {
    if (!built) throw new Error("dist/cli.js missing — run `npm run build`; these cases must not silently skip");
  });

  it("exits 2 on a missing directory", () => {
    let code = 0;
    try {
      execFileSync("node", [REAL_CLI, "verify-cassettes", "does-not-exist-anywhere/"], { stdio: "pipe" });
    } catch (e) {
      code = (e as { status?: number }).status ?? -1;
    }
    expect(code).toBe(2);
  });

  it("exits 3 on a shape-invalid cassette, and still reports privacyScanned", () => {
    let code = 0;
    let out = "";
    try {
      out = execFileSync("node", [REAL_CLI, "verify-cassettes", "test/evals/files/report-check.cassette.json", "--output-format", "json"], {
        encoding: "utf8",
        stdio: "pipe",
      });
    } catch (e) {
      const err = e as { status?: number; stdout?: string };
      code = err.status ?? -1;
      out = err.stdout ?? "";
    }
    expect(code).toBe(3);
    const parsed = JSON.parse(out) as { results: { error?: string | null; version?: unknown[]; privacyScanned?: boolean }[] };
    expect(parsed.results[0].error).toMatch(/invalid cassette shape/);
    expect(Array.isArray(parsed.results[0].version)).toBe(true);
    // ...and it reports that the privacy scan DID run despite the shape failure — the field the hook
    // keys on, pinned here against the real binary so the stub above cannot drift away from it.
    expect(parsed.results[0].privacyScanned).toBe(true);
  });
});

describe("pre-commit — a recorded transcript's non-assistant/user lines are never committed", () => {
  // Agent-binary text — the built-in sub-agent prompt in a `prompt_snapshot` attachment, the tool and agent
  // listings, the frame around a sub-agent's report — rides in a run's transcript lines. A staged fixture
  // transcript (.jsonl under test/fixtures/ or examples/) must not carry any of it.
  const attachment = '{"type":"attachment","attachment":{"type":"prompt_snapshot","systemPrompt":["x"]}}\n';
  it("blocks an attachment line in a staged fixture transcript", () => {
    const { code, out } = runHook(
      scratchRepo({ stubExit: 0, stageBaseline: false, stage: { "test/fixtures/r/agent-x.jsonl": attachment } }),
    );
    expect(code).toBe(1);
    expect(out).toMatch(/test\/fixtures\/r\/agent-x\.jsonl/);
  });

  it("blocks a sentinel of agent-binary text in a staged example transcript", () => {
    const line = '{"type":"user","message":{"content":"[Subagent hand-back] The text below"}}\n';
    const { code } = runHook(scratchRepo({ stubExit: 0, stageBaseline: false, stage: { "examples/x/events.jsonl": line } }));
    expect(code).toBe(1);
  });

  it("lets a clean fixture transcript through, and ignores .jsonl outside test/fixtures/ and examples/", () => {
    const clean = '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}\n';
    expect(runHook(scratchRepo({ stubExit: 0, stageBaseline: false, stage: { "test/fixtures/r/events.jsonl": clean } })).code).toBe(0);
    expect(runHook(scratchRepo({ stubExit: 0, stageBaseline: false, stage: { "notes/a.jsonl": attachment } })).code).toBe(0);
  });
});
