// Run the checks that today only fail AFTER a tag is pushed — locally, before the tag exists.
// All checks are read-only (no writes, no push, no publish).
//
//   npx tsx scripts/release-preflight.ts             # pre-flight for the release branch/PR
//   npx tsx scripts/release-preflight.ts --for-tag    # ALSO run the tag-time HEAD/CI check (hard fail)
//
// Checks 1-4 mirror (and check 2 tightens) the gates release.yml enforces after the tag push:
//   1. check:versions passes (scripts/check-versions.ts).
//   2. CHANGELOG.md has a "## [<package.json version>]" heading (release.yml:54-59's regex) AND —
//      stricter than release.yml — the section body is non-empty.
//   3. The tag `v<version>` does not already exist, locally or on origin.
//   4. The working tree is clean (`git status --porcelain` empty).
//   5. Best-effort, WARN-only: nudge about the ANTHROPIC_API_KEY repo secret (the live suite runs only with it).
//   6. --for-tag only, HARD fail: HEAD == origin/main HEAD, and a successful push-event ci.yml run
//      exists for HEAD — the exact check that would have caught the 0.33.0 mis-tag (tagging a
//      release-branch head instead of the merge commit).

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkVersions } from "./check-versions.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const r = (p: string) => readFileSync(join(REPO_ROOT, p), "utf8");
const json = (p: string) => JSON.parse(r(p)) as Record<string, any>;

const SEMVER = /^\d+\.\d+\.\d+$/;

/** Same shape as check-versions.ts's SEMVER check — kept local so this file has no side-effecting import. */
export function isValidSemver(v: string): boolean {
  return SEMVER.test(v);
}

/**
 * Mirrors release.yml's "Verify CHANGELOG has a heading for this version" step (an anchored
 * `^## \[<version>\]` heading match) — implemented here as a literal line-prefix test on
 * `## [<version>]`, so the version is matched verbatim (dots stay literal; no regex built from the
 * version) — plus a stricter, preflight-only requirement that the section body (everything between
 * this heading and the next `## [`) is non-empty. release.yml itself does NOT require a non-empty body
 * (its release-notes extraction step has its own fallback for that); this function is intentionally
 * stricter so an accidentally-empty section is caught before the tag.
 */
export function changelogHasVersionSection(changelogText: string, version: string): boolean {
  const headingPrefix = `## [${version}]`;
  const lines = changelogText.split("\n");
  let inSection = false;
  const body: string[] = [];
  for (const line of lines) {
    if (!inSection) {
      if (line.startsWith(headingPrefix)) inSection = true;
      continue;
    }
    if (line.startsWith("## [")) break;
    body.push(line);
  }
  return body.some((line) => line.trim().length > 0);
}

/**
 * Whether tag `v<version>` already exists, either locally (`git tag -l` output, one tag per entry) or
 * on origin (`git ls-remote --tags origin` output, raw lines of the form `<sha>\trefs/tags/vX.Y.Z`,
 * possibly with a trailing `^{}` for the dereferenced annotated-tag entry).
 */
export function tagExists(localTags: string[], remoteRefLines: string[], version: string): boolean {
  const tagName = `v${version}`;
  if (localTags.includes(tagName)) return true;
  const suffixRe = new RegExp(`refs/tags/${tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\^\\{\\})?$`);
  return remoteRefLines.some((line) => suffixRe.test(line.trim()));
}

type CheckStatus = "PASS" | "FAIL" | "WARN" | "SKIP";
interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

function run(cmd: string, args: string[]): { ok: boolean; status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(cmd, args, { encoding: "utf8", cwd: REPO_ROOT });
  if (res.error) return { ok: false, status: null, stdout: "", stderr: String(res.error.message ?? res.error) };
  return { ok: res.status === 0, status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function checkCheckVersions(): CheckResult {
  const { ok, errors, values } = checkVersions();
  return {
    name: "check:versions",
    status: ok ? "PASS" : "FAIL",
    detail: ok ? `version lockstep OK (package.json=${values.pkg})` : errors.join("; "),
  };
}

function checkChangelog(version: string): CheckResult {
  const text = r("CHANGELOG.md");
  const ok = changelogHasVersionSection(text, version);
  return {
    name: "CHANGELOG.md heading + non-empty section",
    status: ok ? "PASS" : "FAIL",
    detail: ok ? `found non-empty "## [${version}]" section` : `missing, or empty, "## [${version}]" section in CHANGELOG.md`,
  };
}

function checkTagDoesNotExist(version: string): CheckResult {
  const local = run("git", ["tag", "-l"]);
  const localTags = local.stdout.split("\n").filter((l) => l.trim().length > 0);
  const remote = run("git", ["ls-remote", "--tags", "origin"]);
  if (!remote.ok) {
    return {
      name: `tag v${version} does not already exist`,
      status: "FAIL",
      detail: `could not query origin tags: ${remote.stderr || remote.stdout}`,
    };
  }
  const remoteLines = remote.stdout.split("\n").filter((l) => l.trim().length > 0);
  const exists = tagExists(localTags, remoteLines, version);
  return {
    name: `tag v${version} does not already exist`,
    status: exists ? "FAIL" : "PASS",
    detail: exists ? `v${version} already exists (local and/or origin)` : `v${version} is unused`,
  };
}

function checkWorkingTreeClean(): CheckResult {
  const status = run("git", ["status", "--porcelain"]);
  const clean = status.ok && status.stdout.trim().length === 0;
  return {
    name: "working tree clean",
    status: clean ? "PASS" : "FAIL",
    detail: clean ? "no uncommitted changes" : `uncommitted changes present:\n${status.stdout}`,
  };
}

/**
 * Best-effort, WARN-only. `gh secret list` sees ONLY repo-level Actions secrets — an org- or
 * environment-level ANTHROPIC_API_KEY would false-warn here, and the call itself needs admin scope on
 * the repo. If `gh` is unavailable or unauthenticated, print the reminder unconditionally rather than
 * silently skipping. Without the key the live suite soft-skips in CI (it is not a publish gate) — see
 * RELEASING.md.
 */
function checkLiveSuiteKeyReminder(): CheckResult {
  const REMINDER =
    "if ANTHROPIC_API_KEY is not set as a repo secret, the push-to-main live scenario suite soft-skips — " +
    "this release won't be live-validated in CI (set the secret to run it; see RELEASING.md). Note: `gh " +
    "secret list` only sees repo-level Actions secrets — an org/environment secret would false-warn here, " +
    "and the call needs admin scope.";

  const ghVersion = run("gh", ["--version"]);
  if (!ghVersion.ok) {
    return { name: "live-suite key reminder", status: "WARN", detail: `gh not available — ${REMINDER}` };
  }
  const secrets = run("gh", ["secret", "list"]);
  if (!secrets.ok) {
    return {
      name: "live-suite key reminder",
      status: "WARN",
      detail: `gh secret list failed (unauthenticated or insufficient scope) — ${REMINDER}`,
    };
  }
  const hasKey = /^ANTHROPIC_API_KEY\b/m.test(secrets.stdout);
  return {
    name: "live-suite key reminder",
    status: hasKey ? "PASS" : "WARN",
    detail: hasKey ? "ANTHROPIC_API_KEY found among repo secrets" : `no repo-level ANTHROPIC_API_KEY — ${REMINDER}`,
  };
}

/**
 * [P4b] The check that directly prevents the 0.33.0 mis-tag: tagging a release-branch/PR head instead
 * of the merge commit. Only meaningful right before the tag push, so it is gated behind --for-tag and,
 * unlike checks 1-4, is a HARD failure there (tagging is near-irreversible).
 */
function checkForTag(): CheckResult {
  const fetch = run("git", ["fetch", "origin", "main"]);
  if (!fetch.ok) {
    return {
      name: "HEAD == origin/main, with a green push-event ci run",
      status: "FAIL",
      detail: `git fetch origin main failed: ${fetch.stderr || fetch.stdout}`,
    };
  }
  const head = run("git", ["rev-parse", "HEAD"]);
  const originMain = run("git", ["rev-parse", "origin/main"]);
  if (!head.ok || !originMain.ok) {
    return {
      name: "HEAD == origin/main, with a green push-event ci run",
      status: "FAIL",
      detail: "could not resolve HEAD or origin/main",
    };
  }
  const headSha = head.stdout.trim();
  const originSha = originMain.stdout.trim();
  if (headSha !== originSha) {
    return {
      name: "HEAD == origin/main, with a green push-event ci run",
      status: "FAIL",
      detail:
        `HEAD (${headSha}) != origin/main (${originSha}) — you are about to tag a branch/PR head, not the ` +
        `merge commit. Merge to main first (gh pr merge <n> --merge), then git checkout main && git pull.`,
    };
  }

  const ghVersion = run("gh", ["--version"]);
  if (!ghVersion.ok) {
    return {
      name: "HEAD == origin/main, with a green push-event ci run",
      status: "FAIL",
      detail: "HEAD == origin/main, but `gh` is unavailable — cannot verify a push-event ci.yml run for HEAD",
    };
  }

  const runList = run("gh", [
    "run",
    "list",
    "--workflow=ci.yml",
    `--commit=${headSha}`,
    "--event",
    "push",
    "-L1",
    "--json",
    "status,conclusion",
  ]);
  if (!runList.ok) {
    return {
      name: "HEAD == origin/main, with a green push-event ci run",
      status: "FAIL",
      detail: `gh run list failed: ${runList.stderr || runList.stdout}`,
    };
  }
  let runs: Array<{ status: string; conclusion: string | null }>;
  try {
    runs = JSON.parse(runList.stdout);
  } catch {
    return {
      name: "HEAD == origin/main, with a green push-event ci run",
      status: "FAIL",
      detail: `could not parse gh run list output: ${runList.stdout}`,
    };
  }
  if (runs.length === 0) {
    return {
      name: "HEAD == origin/main, with a green push-event ci run",
      status: "FAIL",
      detail: `no push-event ci.yml run found for HEAD (${headSha}) — full 40-char SHA required, a short SHA returns empty`,
    };
  }
  const [run0] = runs;
  const ok = run0.status === "completed" && run0.conclusion === "success";
  return {
    name: "HEAD == origin/main, with a green push-event ci run",
    status: ok ? "PASS" : "FAIL",
    detail: ok
      ? `HEAD == origin/main (${headSha}), push-event ci.yml: completed/success`
      : `push-event ci.yml for HEAD (${headSha}) is status=${run0.status} conclusion=${run0.conclusion}`,
  };
}

function printResult(res: CheckResult): void {
  const icon = res.status === "PASS" ? "✓" : res.status === "WARN" ? "⚠" : res.status === "SKIP" ? "–" : "✗";
  process.stdout.write(`${icon} [${res.status}] ${res.name}\n`);
  if (res.status !== "PASS") process.stdout.write(`    ${res.detail.replace(/\n/g, "\n    ")}\n`);
}

function main(): void {
  const forTag = process.argv.includes("--for-tag");
  const pkg = json("package.json");
  const version = pkg.version as string;
  if (!isValidSemver(version)) {
    process.stderr.write(`::error::package.json version "${version}" is not X.Y.Z\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`release preflight — version ${version}${forTag ? " (--for-tag)" : ""}\n\n`);

  const hardResults: CheckResult[] = [
    checkCheckVersions(),
    checkChangelog(version),
    checkTagDoesNotExist(version),
    checkWorkingTreeClean(),
  ];
  const warnResult = checkLiveSuiteKeyReminder();

  for (const res of hardResults) printResult(res);
  printResult(warnResult);

  let forTagResult: CheckResult | undefined;
  if (forTag) {
    forTagResult = checkForTag();
    printResult(forTagResult);
  }

  const hardFailed = hardResults.some((r) => r.status === "FAIL") || forTagResult?.status === "FAIL";

  process.stdout.write("\n");
  if (hardFailed) {
    process.stdout.write("✗ release preflight FAILED — fix the above before tagging.\n");
    process.exitCode = 1;
  } else {
    process.stdout.write("✓ release preflight PASSED.\n");
    if (forTag) {
      process.stdout.write(`\nNext:\n  git tag v${version}\n  git push origin v${version}\n`);
    }
  }
}

// Run only when invoked directly (so a test can import the pure helpers without side effects).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
