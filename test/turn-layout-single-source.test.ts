import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { PER_TURN_ARTIFACTS } from "../src/run/turn-layout.js";

// The guard for "biggest risk: a reader I did not find".
//
// Its predecessor matched a `join(<dirvar>, "<artifact>")` SHAPE, and both real-world escapes were invisible
// to it: run-index matched `/^result\.turn-\d+\.json$/` against a readdir entry, and critique/evidence.ts
// joined a loop variable over a candidates array. Neither line has a quoted artifact inside a `join(...)`.
// Chasing shapes means always being one shape behind — the regex caught 1 of 4 realistic reintroductions.
//
// THE SIGNAL IS NOT THE LITERAL, IT IS A LITERAL NOT HANDED TO THE SEAM. Every correct use passes the
// artifact name INTO `turnArtifactPath`/`resolveGraded`/`turnWriteDir`; addressing a per-turn artifact any
// other way means naming it next to some other path expression. So: flag a line that names an artifact (or
// the `.turn-<N>` mangle) and does NOT hand it to the seam. Files that use the seam pass for free, and the
// allowlist stays small enough to be read — 15 src files contain these literals, and allowlisting all of
// them would have made the scan meaningless.

function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...srcFiles(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Files allowed to address a per-turn artifact WITHOUT the seam.
 *
 *  Kept MINIMAL and justified per entry — this repo shipped a 39/40-dead allowlist, so an entry that is
 *  not defensible here is a bug, not a convenience. */
const ALLOWED = new Map<string, string>([
  ["src/run/turn-layout.ts", "the seam itself — it defines the addressing every other file borrows"],
  ["src/run/execute.ts", "the WRITER: it owns the layout it writes"],
  ["src/run/chat.ts", "a WRITER of its own turn-1 artifacts, same as execute.ts"],
  ["src/runtime/resource-sampler.ts", "a WRITER; takes an explicit turn and builds its own path"],
  [
    "src/run/migrate-run-dir.ts",
    "the MIGRATOR: reading a pre-layout dir's ROOT artifacts is its entire subject matter — it is the one " +
      "component whose INPUT is by definition the old shape. Every DESTINATION it builds goes through the seam.",
  ],
]);

/** Names a per-turn artifact, or the `<stem>.turn-<N>.<ext>` mangle a pre-layout writer produced. */
const NAMES_ARTIFACT = new RegExp([...PER_TURN_ARTIFACTS.map((a) => a.replace(".", "\\.")), String.raw`\w+\.turn-`].join("|"));

/** Actually BUILDS or TOUCHES a path, as opposed to naming a file in prose. Without this the scan flags
 *  every user-facing message and doc comment that mentions an artifact by name — which is most of
 *  `critique`, and which would make the guard noise everyone learns to allowlist around. */
const BUILDS_A_PATH = /join\(|`[^`]*\$\{[^}]*\}\/|existsSync\(|readFileSync\(|renameSync\(|writeFileSync\(/;

/** Hands that name to the seam — the only correct way to address a turn's artifact. */
const USES_SEAM = /turnArtifactPath\(|resolveGraded\(|turnWriteDir\(|PER_TURN_ARTIFACTS/;

const hits: { file: string; line: string }[] = [];
for (const abs of srcFiles(resolve("src"))) {
  const rel = abs.replace(resolve(".") + "/", "");
  if (ALLOWED.has(rel)) continue;
  for (const raw of readFileSync(abs, "utf8").split("\n")) {
    const line = raw.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, ""); // strip comments and doc-comment bodies
    if (!NAMES_ARTIFACT.test(line)) continue;
    if (!BUILDS_A_PATH.test(line)) continue; // prose naming a file is not an addressing bug
    if (USES_SEAM.test(line)) continue;
    hits.push({ file: rel, line: raw.trim().slice(0, 120) });
  }
}

describe("per-turn artifacts are addressed only through the seam", () => {
  it("the scan is not vacuous — it recognises every realistic reintroduction form", () => {
    // Anchored on LITERAL SAMPLES, never on a real source line: the previous liveness check pointed at the
    // legacy indexer's root read, and failed the moment that line was correctly deleted. An anchor that
    // rots when the code improves trains you to edit the guard whenever it complains.
    const CAUGHT = [
      'const p = join(outDir, "result.json");', // the plain form
      "const p = `${outDir}/result.json`;", // template literal — invisible to a join() shape matcher
      'const p = join(runRoot, "run.jsonl");', // a variable name no alternation would have listed
    ];
    for (const sample of CAUGHT) {
      expect(NAMES_ARTIFACT.test(sample) && BUILDS_A_PATH.test(sample) && !USES_SEAM.test(sample), `not recognised: ${sample}`).toBe(true);
    }
    // Prose that merely NAMES an artifact must not trip it — otherwise every message string in `critique`
    // becomes a hit and the allowlist grows until the scan means nothing.
    for (const prose of [
      'reason: "turn-1 result: DEGRADED (result.turn-1.json was never archived)",',
      " *  Read the ARCHIVED turn-1 transcript out of `run.turn-1.jsonl`.",
    ]) {
      expect(BUILDS_A_PATH.test(prose), `prose would be flagged: ${prose}`).toBe(false);
    }
    // The loop-variable escape has NO artifact name on its own line — line-level static analysis cannot
    // see it. That is what the behavioural decoy-poisoning guard covers; the two layers have deliberately
    // complementary blind spots, and neither is claimed to close the class alone.
    // And correct usage must NOT trip it, or the guard is noise everyone learns to allowlist around.
    for (const ok of ['turnArtifactPath(dir, n, "result.json")', 'resolveGraded(dir, "trace.json")']) {
      expect(USES_SEAM.test(ok), `correct usage flagged: ${ok}`).toBe(true);
    }
    expect(srcFiles(resolve("src")).length).toBeGreaterThan(50);
  });

  it("no file outside the seam, the writers and the migrator addresses one by hand", () => {
    expect(
      hits.map((h) => `${h.file}: ${h.line}`),
      "route these through turnArtifactPath()/resolveGraded(), or add a justified ALLOWED entry",
    ).toEqual([]);
  });

  it("every allowlist entry is still a real file with a stated reason", () => {
    // An allowlist that outlives its files is how the 39/40-dead one happened.
    for (const [rel, why] of ALLOWED) {
      expect(() => statSync(resolve(rel)), `allowlisted file no longer exists: ${rel}`).not.toThrow();
      expect(why.length, `allowlist entry ${rel} has no justification`).toBeGreaterThan(10);
    }
  });
});
