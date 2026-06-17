// Guards version lockstep across the npm package and the companion skill, so a
// hand-edited release can't drift. Fails loud (exit 1) on any mismatch.
//
//   npm run check:versions
//
// Invariants (the skill versions INDEPENDENTLY from the npm package — see
// docs/maintenance.md — so we do NOT require the skill version to equal the
// package version):
//   1. npm self-consistency:   package.json === package-lock.json (root + "" package).
//   2. skill self-consistency: marketplace.json === skill plugin.json === SKILL.md `version:`.
//   3. floor === tracks:       SKILL.md bootstrap floor `@>=X.Y.Z` === `tracks-harness:` version.
//   4. floor <= package:       the harness version the skill demands must be one this repo
//                              can publish (else the skill ships ahead of npm).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const r = (p: string) => readFileSync(join(REPO_ROOT, p), "utf8");
const json = (p: string) => JSON.parse(r(p)) as Record<string, any>;

const SEMVER = /^\d+\.\d+\.\d+$/;
/** Compare two X.Y.Z strings: <0 if a<b, 0 if equal, >0 if a>b. */
function cmp(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

export function checkVersions(): { ok: boolean; errors: string[]; values: Record<string, string | undefined> } {
  const errors: string[] = [];

  const pkg = json("package.json").version as string;
  const lock = json("package-lock.json");
  const lockRoot = lock.version as string;
  const lockPkg = lock.packages?.[""]?.version as string | undefined;

  const market = json(".claude-plugin/marketplace.json").plugins?.[0]?.version as string | undefined;
  const plugin = json(".claude/skills/cowork-harness/.claude-plugin/plugin.json").version as string | undefined;

  const skillMd = r(".claude/skills/cowork-harness/SKILL.md");
  const frontmatter = skillMd.split("---")[1] ?? "";
  const skillVer = frontmatter.match(/^\s*version:\s*(\S+)\s*$/m)?.[1];
  const tracks = skillMd.match(/tracks-harness:\s*cowork-harness\s+(\d+\.\d+\.\d+)/)?.[1];
  const floor = skillMd.match(/cowork-harness@>=(\d+\.\d+\.\d+)/)?.[1];

  const values = { pkg, lockRoot, lockPkg, market, plugin, skillVer, tracks, floor };

  // 1. npm self-consistency
  if (!SEMVER.test(pkg)) errors.push(`package.json version "${pkg}" is not X.Y.Z`);
  if (lockRoot !== pkg) errors.push(`package-lock.json root version "${lockRoot}" != package.json "${pkg}"`);
  if (lockPkg !== pkg) errors.push(`package-lock.json packages[""].version "${lockPkg}" != package.json "${pkg}"`);

  // 2. skill self-consistency
  const skillSet = new Set([market, plugin, skillVer]);
  if (skillSet.size !== 1 || [...skillSet][0] === undefined) {
    errors.push(
      `skill version mismatch — marketplace.json=${market}, plugin.json=${plugin}, SKILL.md=${skillVer} (all three must agree)`,
    );
  }

  // 3. floor === tracks-harness
  if (!floor) errors.push(`could not find bootstrap floor "cowork-harness@>=X.Y.Z" in SKILL.md`);
  if (!tracks) errors.push(`could not find "tracks-harness: cowork-harness X.Y.Z" in SKILL.md`);
  if (floor && tracks && floor !== tracks) {
    errors.push(`bootstrap floor "@>=${floor}" != tracks-harness "${tracks}" (keep them in lockstep)`);
  }

  // 4. floor <= package.json (the skill must not demand an unpublished/future harness)
  if (floor && SEMVER.test(pkg) && cmp(floor, pkg) > 0) {
    errors.push(`bootstrap floor "@>=${floor}" is ahead of package.json "${pkg}" — skill would lead npm`);
  }

  return { ok: errors.length === 0, errors, values };
}

function main(): void {
  const { ok, errors, values } = checkVersions();
  process.stdout.write(`version lockstep: ${JSON.stringify(values)}\n`);
  if (ok) {
    process.stdout.write("✓ all version strings are aligned\n");
    return;
  }
  for (const e of errors) process.stderr.write(`::error::${e}\n`);
  process.exitCode = 1;
}

// Run only when invoked directly (so a test can import checkVersions without side effects).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
