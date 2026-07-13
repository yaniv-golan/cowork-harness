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
//   5. README floor === floor: every `cowork-harness@>=X.Y.Z` in README.md matches the SKILL.md floor
//                              (README is not version-controlled by the package; it drifts silently otherwise).
//   5b. SKILL floors === floor: every `@>=X.Y.Z` in SKILL.md (incl. a BARE `Pin `@>=X`` with no
//                              `cowork-harness` prefix) matches the floor — invariant 3 reads only the
//                              first prefixed match, so a bare floor drifted silently (stale 0.33.0→1.0.0).
//   6. ref stamps === tracks:  each `references/*.md` "Tracks `cowork-harness X.Y.Z`" matches tracks-harness.
//   7. baseline pins agree:    SKILL.md's `(baseline desktop-X.Y.Z)` and README.md's "latest shipped
//                              baseline" sentence agree with each other AND are not behind the max
//                              version present in baselines/desktop-*.json. (DESIGN.md is deliberately
//                              NOT checked here — its baseline mentions are point-in-time verification
//                              stamps, not "current" pins, and are allowed to lag until a real
//                              re-verification pass. docs/cowork-spawn-contract-*.md is likewise NOT a
//                              pin: it is frozen historical research, not updated per release — see its
//                              own applicability note.)
//   8. copy-paste CI `V=X.Y.Z` pins match the max baseline's agentVersion: the literal agent-binary
//      version hardcoded in README.md / ci-recipe.md / docs/maintenance.md's "stage the agent binary"
//      bash snippets (meant to be copy-pasted into a CONSUMER repo's own CI, which has no baselines/
//      dir of its own — so these stay literals, not a dynamic `jq` read) must equal the newest
//      baselines/desktop-*.json's `agentVersion`.
import { readdirSync, readFileSync } from "node:fs";
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

  // Baseline pins (invariant 7) — extracted here so they can ride in `values` alongside the rest.
  const skillBaseline = skillMd.match(/tracks-harness:\s*cowork-harness\s+\d+\.\d+\.\d+\s*\(baseline\s+desktop-(\d+\.\d+\.\d+)\)/)?.[1];
  const readmeText = r("README.md");
  const readmeBaseline = readmeText.match(/latest shipped baseline[^.]*?is\s+\*\*`desktop-(\d+\.\d+\.\d+)`\*\*/)?.[1];
  const baselineFiles = readdirSync(join(REPO_ROOT, "baselines")).filter((f) => /^desktop-\d+\.\d+\.\d+\.json$/.test(f));
  const baselineVersions = baselineFiles.map((f) => f.match(/^desktop-(\d+\.\d+\.\d+)\.json$/)![1]);
  const maxBaseline = baselineVersions.reduce((max, v) => (cmp(v, max) > 0 ? v : max), baselineVersions[0]);

  const values = {
    pkg,
    lockRoot,
    lockPkg,
    market,
    plugin,
    skillVer,
    tracks,
    floor,
    skillBaseline,
    readmeBaseline,
    maxBaseline,
  };

  // 1. npm self-consistency
  if (!SEMVER.test(pkg)) errors.push(`package.json version "${pkg}" is not X.Y.Z`);
  if (lockRoot !== pkg) errors.push(`package-lock.json root version "${lockRoot}" != package.json "${pkg}"`);
  if (lockPkg !== pkg) errors.push(`package-lock.json packages[""].version "${lockPkg}" != package.json "${pkg}"`);

  // 2. skill self-consistency
  const skillSet = new Set([market, plugin, skillVer]);
  if (skillSet.size !== 1 || [...skillSet][0] === undefined) {
    errors.push(`skill version mismatch — marketplace.json=${market}, plugin.json=${plugin}, SKILL.md=${skillVer} (all three must agree)`);
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

  // 5. README bootstrap floor(s) must match the SKILL.md floor (README is not under any other version check,
  //    so it drifts silently — this is the guard that would have caught the @>=0.9.0-while-package-0.12.0 gap).
  const readme = r("README.md");
  const readmeFloors = [...readme.matchAll(/cowork-harness@>=(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
  if (floor) {
    if (readmeFloors.length === 0) errors.push(`README.md has no "cowork-harness@>=X.Y.Z" floor to verify against SKILL.md "@>=${floor}"`);
    for (const f of readmeFloors) if (f !== floor) errors.push(`README.md floor "@>=${f}" != SKILL.md floor "@>=${floor}"`);
  }

  // 5b. EVERY `@>=X.Y.Z` inside SKILL.md must equal the floor — including a BARE `Pin `@>=X`` with no
  //     `cowork-harness` prefix. Invariant 3 reads only the FIRST `cowork-harness@>=` match, so a bare
  //     floor drifted silently (it shipped stale from 0.33.0 through 1.0.0). This catches all of them.
  if (floor) {
    const skillFloors = [...skillMd.matchAll(/@>=(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
    for (const f of skillFloors) if (f !== floor) errors.push(`SKILL.md floor "@>=${f}" != SKILL.md bootstrap floor "@>=${floor}" (a bare \`@>=X\` drifted — bump it)`);
  }

  // 6. Each reference doc's "Tracks `cowork-harness X.Y.Z`" stamp must match tracks-harness.
  const refFiles = [
    ".claude/skills/cowork-harness/references/ci-recipe.md",
    ".claude/skills/cowork-harness/references/scenario-schema.md",
    ".claude/skills/cowork-harness/references/fidelity-and-answers.md",
  ];
  if (tracks) {
    for (const f of refFiles) {
      const stamp = r(f).match(/Tracks\s+`cowork-harness\s+(\d+\.\d+\.\d+)`/)?.[1];
      if (!stamp) errors.push(`${f} has no "Tracks \`cowork-harness X.Y.Z\`" stamp`);
      else if (stamp !== tracks) errors.push(`${f} stamp "${stamp}" != tracks-harness "${tracks}"`);
    }
  }

  // 7. baseline pins agree with each other, and none is behind the max baseline file on disk.
  if (!skillBaseline) {
    errors.push(`could not find "(baseline desktop-X.Y.Z)" on the tracks-harness line in SKILL.md`);
  }
  if (!readmeBaseline) {
    errors.push(`could not find the "latest shipped baseline ... is **\`desktop-X.Y.Z\`**" sentence in README.md`);
  }
  if (baselineVersions.length === 0) {
    errors.push(`no baselines/desktop-*.json files found — cannot compute max baseline`);
  }
  const pins: Array<{ label: string; version: string | undefined }> = [
    { label: "SKILL.md tracks-harness baseline", version: skillBaseline },
    { label: "README.md latest-shipped-baseline", version: readmeBaseline },
  ];
  const presentPins = pins.filter((p): p is { label: string; version: string } => p.version !== undefined);
  for (let i = 1; i < presentPins.length; i++) {
    if (presentPins[i].version !== presentPins[0].version) {
      errors.push(
        `baseline pin mismatch — ${presentPins[0].label}="${presentPins[0].version}" != ${presentPins[i].label}="${presentPins[i].version}"`,
      );
    }
  }
  if (maxBaseline) {
    for (const p of presentPins) {
      if (cmp(p.version, maxBaseline) < 0) {
        errors.push(`${p.label}="${p.version}" is behind the max baselines/desktop-*.json version "${maxBaseline}"`);
      }
    }
  }

  // 8. copy-paste CI `V=X.Y.Z` agent-binary pins must match the max baseline's agentVersion.
  let maxAgentVersion: string | undefined;
  if (maxBaseline) {
    maxAgentVersion = json(`baselines/desktop-${maxBaseline}.json`).agentVersion as string | undefined;
  }
  const vPinFiles = ["README.md", ".claude/skills/cowork-harness/references/ci-recipe.md", "docs/maintenance.md"];
  if (maxAgentVersion) {
    for (const f of vPinFiles) {
      const pin = r(f).match(/\bV=(\d+\.\d+\.\d+)\b/)?.[1];
      if (!pin) {
        errors.push(`${f} has no "V=X.Y.Z" agent-binary pin to verify against baseline agentVersion "${maxAgentVersion}"`);
      } else if (pin !== maxAgentVersion) {
        errors.push(`${f} pin "V=${pin}" != max baseline's agentVersion "${maxAgentVersion}" (baselines/desktop-${maxBaseline}.json)`);
      }
    }
  } else if (maxBaseline) {
    errors.push(`baselines/desktop-${maxBaseline}.json has no "agentVersion" field`);
  }

  return {
    ok: errors.length === 0,
    errors,
    values: {
      ...values,
      readmeFloors: readmeFloors.join(","),
      baselineVersions: baselineVersions.join(","),
      maxAgentVersion,
    },
  };
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
