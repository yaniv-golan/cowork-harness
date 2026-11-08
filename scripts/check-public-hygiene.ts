#!/usr/bin/env node
// Checks what a pull request is about to publish: its commit messages, the lines it adds, the paths it adds, and its
// title, body and branch name. Exit 0 is clean, 1 is a finding, 2 means the check itself could not run.
//
// Three rules keep it from passing without having looked:
//  - Matching happens here, in Node. `git grep -E` treats `\b` as matching nothing on macOS, so a pattern run through it
//    finds nothing and reads as clean.
//  - Every public pattern must match its known-positive samples, and miss its known-negative ones, before any scan.
//  - Matched text is never printed: one line can carry two hits, so printing it for one could publish the other.
//
// Erasable TypeScript and `node:` imports only, so CI can run this file with Node's type stripping and no install.
// The patterns are assembled from fragments so that this file does not match itself; a test holds it to that.
//
// Two limits, because this guards against accidents rather than a hostile author:
//  - A file git calls binary from its content (a NUL near its start, as in UTF-16) is reported as "binary, not scanned"
//    and does not fail the check. Its content is not decoded. A file forced binary by an attribute is a finding.
//  - Git does not produce a remerge diff for an octopus merge, so what such a merge alone adds is seen only if it is
//    still there at the head of the range.

import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLEAN = 0;
const FINDING = 1;
const INSTRUMENT_FAILED = 2;

class InstrumentError extends Error {}

const INTERNAL_DOCS = "docs/" + "internal";

export interface PublicPattern {
  name: string;
  re: RegExp;
  /** Files whose added lines may contain this. Everywhere else, and in every message, title and body, it is a finding. */
  allowedIn?: readonly string[];
}

/** The only files that may name the directory itself. A citation of a file inside it is a finding even here. */
export const INTERNAL_DOCS_DIR_ALLOWLIST: readonly string[] = [
  ".gitignore",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "SPEC.md",
  "package.json",
  "baselines/prompts/cowork-system-prompt-fingerprints.json",
  "test/docs-index-sync.test.ts",
  "test/docs-present-tense.test.ts",
  "test/no-internal-doc-references.test.ts",
];

export const PUBLIC_PATTERNS: readonly PublicPattern[] = [
  { name: "register id", re: new RegExp("\\bR\\d{2,3}\\b") },
  { name: "review label", re: new RegExp("\\b[PG]\\d-\\d+\\b") },
  { name: "session name", re: new RegExp("\\bcwh-" + "\\d+\\b") },
  { name: "co-author trailer", re: new RegExp("co-" + "authored-by:.*" + "claude", "i") },
  { name: "session trailer", re: new RegExp("claude-" + "session:", "i") },
  { name: "session url", re: new RegExp("claude\\.ai/" + "code/session", "i") },
  { name: "generated footer", re: new RegExp("generated with " + "\\[?claude code", "i") },
  { name: "internal doc citation", re: new RegExp(INTERNAL_DOCS + "/[A-Za-z0-9_]") },
  { name: "internal docs directory", re: new RegExp(INTERNAL_DOCS + "(?!/[A-Za-z0-9_])"), allowedIn: INTERNAL_DOCS_DIR_ALLOWLIST },
];

/** Out of reach of the public patterns, because this file holds every one's known-positive. The private ones still read it. */
export const EXCLUDED_PATHS: readonly string[] = ["test/fixtures/public-hygiene/samples.json"];

const SAMPLES_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "public-hygiene", "samples.json");

function selfCheck(): void {
  let samples: Record<string, { positive?: string[]; negative?: string[] }>;
  try {
    samples = JSON.parse(readFileSync(SAMPLES_FILE, "utf8"));
  } catch {
    throw new InstrumentError("self-check: the samples file is missing or not JSON");
  }
  const names = new Set(PUBLIC_PATTERNS.map((p) => p.name));
  for (const name of Object.keys(samples)) {
    if (!names.has(name)) throw new InstrumentError(`self-check: samples for an unknown pattern: ${name}`);
  }
  for (const p of PUBLIC_PATTERNS) {
    const { positive = [], negative = [] } = samples[p.name] ?? {};
    if (positive.length === 0 || negative.length === 0) throw new InstrumentError(`self-check: ${p.name} has no samples`);
    if (!positive.every((s) => p.re.test(s))) throw new InstrumentError(`self-check: ${p.name} missed a known-positive sample`);
    if (negative.some((s) => p.re.test(s))) throw new InstrumentError(`self-check: ${p.name} matched a known-negative sample`);
  }
}

function privatePatternsFile(): string {
  return join(homedir(), ".config", "cowork-harness", "private-hygiene-patterns.txt");
}

/** Fixed strings, matched case-insensitively. An error here names the line's position, never its text. */
function loadPrivatePatterns(): RegExp[] {
  let raw: string;
  try {
    raw = readFileSync(privatePatternsFile(), "utf8");
  } catch {
    throw new InstrumentError("private pattern file: missing or unreadable");
  }
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
  if (lines.length === 0) throw new InstrumentError("private pattern file: no patterns");
  return lines.map((line, i) => {
    try {
      const re = new RegExp(line.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&"), "i");
      if (re.test(line)) return re;
    } catch {
      /* reported below, without the text */
    }
    throw new InstrumentError(`private pattern ${i + 1}: invalid`);
  });
}

function runGit(args: string[], cwd: string): string {
  const r = spawnSync("git", ["-c", "core.quotePath=false", ...args], { cwd, encoding: "utf8", maxBuffer: 2 ** 30 });
  if (r.status !== 0) throw new InstrumentError(`git ${args[0]} failed (exit ${r.status})`);
  return r.stdout;
}

function unquoteGitPath(raw: string): string {
  const noTab = raw.endsWith("\t") ? raw.slice(0, -1) : raw;
  if (!(noTab.startsWith('"') && noTab.endsWith('"'))) return noTab;
  const bytes: number[] = [];
  const body = Buffer.from(noTab.slice(1, -1), "utf8");
  const simple: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== 92) {
      bytes.push(body[i]!);
      continue;
    }
    const next = String.fromCharCode(body[++i]!);
    if (next in simple) {
      bytes.push(simple[next]!);
    } else {
      bytes.push(parseInt(body.subarray(i, i + 3).toString("latin1"), 8));
      i += 2;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

const stripPrefix = (p: string): string => (p.startsWith("b/") ? p.slice(2) : p);

export interface ParsedDiff {
  added: { path: string; line: number; text: string }[];
  paths: string[];
  binaries: string[];
}

function binaryPath(line: string): string | undefined {
  const body = line.slice("Binary files ".length, -" differ".length);
  if (body.endsWith(" and /dev/null")) return undefined;
  if (body.startsWith("/dev/null and ")) return stripPrefix(unquoteGitPath(body.slice("/dev/null and ".length)));
  // `a/P and b/P` with --no-renames, so the two halves are the same length, whatever P contains.
  const half = (body.length - " and ".length) / 2;
  return stripPrefix(unquoteGitPath(body.slice(half + " and ".length)));
}

/** Reads `git diff -U0`. Hunk lengths decide what is content, so an added line that starts with `++ b/` stays content. */
export function parseDiff(diff: string): ParsedDiff {
  const lines = diff.split("\n");
  const out: ParsedDiff = { added: [], paths: [], binaries: [] };
  let path: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.startsWith("diff --git ")) {
      path = undefined;
    } else if (l.startsWith("+++ ")) {
      const target = l.slice(4);
      path = target === "/dev/null" || target === "/dev/null\t" ? undefined : stripPrefix(unquoteGitPath(target));
      if (path !== undefined) out.paths.push(path);
    } else if (l.startsWith("Binary files ") && l.endsWith(" differ")) {
      const binary = binaryPath(l);
      if (binary !== undefined) out.binaries.push(binary);
    } else if (l.startsWith("@@ ")) {
      const m = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (!m) throw new InstrumentError("could not read a diff hunk header");
      let removed = m[1] === undefined ? 1 : Number(m[1]);
      let toAdd = m[3] === undefined ? 1 : Number(m[3]);
      let at = Number(m[2]);
      while (removed > 0 || toAdd > 0) {
        const body = lines[++i];
        if (body === undefined) throw new InstrumentError("a diff hunk ended early");
        if (body.startsWith("\\")) continue;
        if (body.startsWith("-")) {
          removed--;
        } else if (body.startsWith("+")) {
          if (path !== undefined) out.added.push({ path, line: at, text: body.slice(1) });
          at++;
          toAdd--;
        } else {
          throw new InstrumentError("could not read a diff hunk line");
        }
      }
    }
  }
  return out;
}

interface Options {
  base?: string;
  head?: string;
  stage?: "create" | "ready" | "merge";
  bodyFile?: string;
  titleFile?: string;
  branch?: string;
  pr?: string;
  requirePrivate: boolean;
}

const USAGE =
  "usage: check-public-hygiene --base <ref> --head <ref> [--stage create|ready|merge] [--body-file f] [--title-file f] [--branch name] [--pr N] [--require-private]";

function parseArgs(argv: string[]): Options {
  const o: Options = { requirePrivate: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--require-private") {
      o.requirePrivate = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) throw new InstrumentError(USAGE);
    if (a === "--base") o.base = value;
    else if (a === "--head") o.head = value;
    else if (a === "--body-file") o.bodyFile = value;
    else if (a === "--title-file") o.titleFile = value;
    else if (a === "--branch") o.branch = value;
    else if (a === "--pr") o.pr = value;
    else if (a === "--stage" && (value === "create" || value === "ready" || value === "merge")) o.stage = value;
    else throw new InstrumentError(USAGE);
  }
  if (!o.base || !o.head || o.base.startsWith("-") || o.head.startsWith("-")) throw new InstrumentError(USAGE);
  if (o.stage === "create" && !(o.bodyFile && o.titleFile && o.branch))
    throw new InstrumentError("--stage create needs --body-file, --title-file and --branch");
  if ((o.stage === "ready" || o.stage === "merge") && !(o.pr && /^\d+$/.test(o.pr)))
    throw new InstrumentError(`--stage ${o.stage} needs --pr N`);
  if (o.pr && o.stage !== "ready" && o.stage !== "merge") throw new InstrumentError("--pr goes with --stage ready or merge");
  return o;
}

function readRequiredFile(file: string, what: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    throw new InstrumentError(`could not read the ${what} file`);
  }
}

function fetchLive(pr: string): { title: string; body: string; branch: string } {
  const r = spawnSync("gh", ["pr", "view", pr, "--json", "title,body,headRefName"], { encoding: "utf8", maxBuffer: 2 ** 26 });
  if (r.status !== 0 || !r.stdout || r.stdout.trim() === "") throw new InstrumentError("could not fetch the pull request");
  let v: { title?: unknown; body?: unknown; headRefName?: unknown };
  try {
    v = JSON.parse(r.stdout);
  } catch {
    throw new InstrumentError("could not read the pull request as JSON");
  }
  if (typeof v.title !== "string" || typeof v.body !== "string" || typeof v.headRefName !== "string") {
    throw new InstrumentError("the pull request response is missing a field");
  }
  return { title: v.title, body: v.body, branch: v.headRefName };
}

function main(argv: string[], out: (s: string) => void): number {
  const o = parseArgs(argv);
  selfCheck();
  const privates = o.requirePrivate ? loadPrivatePatterns() : [];
  out(`public patterns: ${PUBLIC_PATTERNS.length}`);
  out(`private patterns: ${privates.length} loaded`);

  const findings: string[] = [];
  const hit = (text: string, inFile?: string): string[] => {
    const publicApplies = inFile === undefined || !EXCLUDED_PATHS.includes(inFile);
    const names = publicApplies
      ? PUBLIC_PATTERNS.filter((p) => p.re.test(text) && !(inFile !== undefined && p.allowedIn?.includes(inFile))).map((p) => p.name)
      : [];
    return privates.some((re) => re.test(text)) ? [...names, "private pattern"] : names;
  };
  const check = (where: string, text: string, inFile?: string) => {
    for (const name of hit(text, inFile)) findings.push(`${where}: ${name}`);
  };

  // Git prints paths from the top of the repository but reads a path given to check-attr from the working directory.
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (top.status !== 0) throw new InstrumentError("not inside a git repository");
  const root = top.stdout.replace(/\n$/, "");
  const git = (args: string[]) => runGit(args, root);

  for (const ref of [o.base!, o.head!]) {
    if (spawnSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: root, encoding: "utf8" }).status !== 0) {
      throw new InstrumentError("a ref does not resolve to a commit");
    }
  }
  // Two dots for the log: three would be the symmetric difference, and read main's commits since the fork as this branch's.
  const log = git(["log", "-z", "--format=%H%n%B", `${o.base}..${o.head}`]);
  const commits = log.split("\0").filter((c) => c.trim() !== "");
  if (commits.length === 0) throw new InstrumentError("the range holds no commits");
  const diffFlags = ["--no-renames", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/", "-U0", "--inter-hunk-context=0"];
  // Three dots for the diff: two would show lines main deleted after the fork as lines this branch added.
  const diff = parseDiff(git(["diff", ...diffFlags, `${o.base}...${o.head}`]));
  // Each commit as well: a push publishes every commit's tree, so a line added and later removed is still published.
  // `--remerge-diff` because `log -p` prints nothing for a merge, and a conflict resolution can add a line of its own.
  const perCommit = git(["log", "-p", "--remerge-diff", ...diffFlags, "--format=%x00%H", `${o.base}..${o.head}`])
    .split("\0")
    .slice(1)
    .map((chunk) => {
      const end = chunk.indexOf("\n");
      return { sha: chunk.slice(0, end === -1 ? undefined : end), diff: parseDiff(end === -1 ? "" : chunk.slice(end + 1)) };
    });

  for (const commit of commits) {
    const [sha = "", ...message] = commit.split("\n");
    message.forEach((line, i) => check(`commit ${sha.slice(0, 10)} message:${i + 1}`, line));
  }

  // A path that itself hits is reported by number, so that printing it cannot publish what it matched.
  const label = new Map<string, string>();
  const allPaths = [...new Set([diff, ...perCommit.map((c) => c.diff)].flatMap((d) => [...d.paths, ...d.binaries]))];
  allPaths.forEach((p, i) => {
    const names = hit(p, p);
    label.set(p, names.length > 0 ? `added path #${i + 1}` : p);
    for (const name of names) findings.push(`added path #${i + 1}: ${name}`);
  });
  for (const a of diff.added) check(`${label.get(a.path) ?? a.path}:${a.line}`, a.text, a.path);
  // Git decides "binary" from attributes the pull request can set, so a file forced binary by one is a finding. For every
  // commit in the range, git reads them from the checked-out tree, which is also what check-attr reads here.
  const reportBinary = (path: string, prefix: string) => {
    const name = label.get(path) ?? path;
    const forced = git(["check-attr", "-z", "diff", "--", path]).split("\0")[2] === "unset";
    if (forced) findings.push(`${prefix}${name}: binary by attribute, not scanned`);
    else out(`${prefix}${name}: binary, not scanned`);
  };
  for (const b of diff.binaries) reportBinary(b, "");
  for (const c of perCommit) {
    const where = `commit ${c.sha.slice(0, 10)} `;
    for (const a of c.diff.added) check(`${where}${label.get(a.path) ?? a.path}:${a.line}`, a.text, a.path);
    for (const b of c.diff.binaries) reportBinary(b, where);
  }

  let title: string | undefined;
  let body: string | undefined;
  let branch = o.branch;
  if (o.pr) {
    const live = fetchLive(o.pr);
    title = live.title;
    body = live.body;
    branch = live.branch;
  } else {
    if (o.titleFile) title = readRequiredFile(o.titleFile, "title");
    if (o.bodyFile) body = readRequiredFile(o.bodyFile, "body");
  }
  if (title !== undefined) {
    if (title.trim() === "") findings.push("title: a pull request title is required");
    title.split("\n").forEach((line, i) => check(`title:${i + 1}`, line));
  }
  if (body !== undefined) {
    if (body.trim() === "") findings.push("body: a pull request body is required");
    body.split("\n").forEach((line, i) => check(`body:${i + 1}`, line));
  }
  if (branch !== undefined) check("branch name", branch);

  for (const f of [...new Set(findings)]) out(f);
  out(`checked ${commits.length} commits, ${diff.added.length} added lines, ${allPaths.length} paths; ${new Set(findings).size} findings`);
  return findings.length > 0 ? FINDING : CLEAN;
}

export function run(argv: string[]): number {
  try {
    return main(argv, (s) => console.log(s));
  } catch (e) {
    console.error(`check-public-hygiene: ${e instanceof InstrumentError ? e.message : `internal error (${(e as Error).name})`}`);
    return INSTRUMENT_FAILED;
  }
}

function invokedDirectly(): boolean {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) process.exitCode = run(process.argv.slice(2));
