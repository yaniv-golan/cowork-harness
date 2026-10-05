/**
 * The scrub-set fingerprint a run records (`RunResult.scrubSet`), so a later re-grade can PROVE that the set it
 * scrubs with covers every string the run scrubbed — never by comparing values, which are never recorded.
 *
 * Each string the run's scrub used (every `collectSecrets()` entry: a named key's value, a literal, and their
 * encodings) is recorded as an HMAC-SHA256 under a random per-installation key, `scrubset.key` BESIDE the runs root
 * (`~/.cowork-harness/scrubset.key` for the default root; 0600, created on the first run). Never inside the runs root,
 * so a runs root shared or uploaded as an artifact carries the HMACs without the key that could test guesses. With no public verifier, a shared result.json gives
 * nothing to brute-force. A re-grade recomputes the HMACs of its own set under the same key: when every recorded
 * one is among them, the run's set is a subset of this one (a grown set included). A missing or different key
 * (another machine), or a run recorded before the field existed, proves nothing.
 *
 * The stored strings use a 16-letter alphabet with no digit and no `a`–`f`, so a hex- or digit-shaped secret can
 * never match inside them when the whole result is scrubbed as text. A fingerprint the scrub did change (a secret
 * made only of those letters) fails validation and proves nothing: fail closed.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { closeSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeSync, constants } from "node:fs";
import { warn } from "./io.js";
import { dirname, join, resolve } from "node:path";

export const SCRUB_KEY_FILE = "scrubset.key";
const ALPHABET = "ghjkmnpqrstvwxyz";
const VALUE_CHARS = 32; // 128 bits
const VALUE_RE = new RegExp(`^[${ALPHABET}]{${VALUE_CHARS}}$`);
const KEY_ID_RE = new RegExp(`^[${ALPHABET}]{16}$`);

export interface ScrubSetRecord {
  v: 1;
  /** Which installation key the values are under (a hash of the key, never the key). */
  keyId: string;
  /** One keyed HMAC per distinct string the run's scrub used, sorted. */
  values: string[];
}

const encode = (b: Buffer, chars: number): string => {
  let out = "";
  for (const byte of b) {
    out += ALPHABET[byte >> 4]! + ALPHABET[byte & 15]!;
    if (out.length >= chars) break;
  }
  return out.slice(0, chars);
};

const keyIdOf = (key: Buffer): string => encode(createHash("sha256").update("cowork-harness scrubset key id\0").update(key).digest(), 16);
const hmacOf = (key: Buffer, s: string): string => encode(createHmac("sha256", key).update(s, "utf8").digest(), VALUE_CHARS);

/** Read a key file: a regular file (not a link), owned by this user, readable by no one else, 64 hex. Anything
 *  else is not a key — it proves nothing and is never used. `why` names the defect (never the key). */
function readKeyFile(path: string): { key: Buffer } | { why: string; absent?: true } {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return { why: `${path} does not exist`, absent: true };
  }
  if (!st.isFile()) return { why: `${path} is not a regular file (a symlink or a directory)` };
  if ((st.mode & 0o077) !== 0)
    return { why: `${path} is readable or writable by others (mode ${(st.mode & 0o777).toString(8)}; it must be 600)` };
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) return { why: `${path} is owned by another user` };
  if (st.size === 0) return { why: `${path} is empty (an interrupted create): remove it to let the next run create a key` };
  let hex: string;
  try {
    hex = readFileSync(path, "utf8").trim();
  } catch (e) {
    return { why: `${path} cannot be read (${(e as Error).message})` };
  }
  return /^[0-9a-f]{64}$/.test(hex) ? { key: Buffer.from(hex, "hex") } : { why: `${path} does not hold a 64-hex-digit key` };
}

/** Where the installation key of a runs root lives: beside it, in its parent directory. */
export const scrubKeyPath = (runsRoot: string): string => join(dirname(resolve(runsRoot)), SCRUB_KEY_FILE);

const KEY_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
/** Errors a filesystem with no hard links gives `link`. */
const NO_LINKS = new Set(["ENOTSUP", "EOPNOTSUPP", "EPERM", "ENOSYS", "EXDEV", "EMLINK"]);

function writeNewFile(path: string, body: string): void {
  const fd = openSync(path, KEY_FLAGS, 0o600);
  try {
    writeSync(fd, body);
  } finally {
    closeSync(fd);
  }
}

/** Write a fresh key next to `path` and link it into place: a reader sees either no key or a complete one, never a
 *  partial file, and a concurrent creator's key is never replaced (`link` does not overwrite). On a filesystem with
 *  no hard links the key is created at `path` directly, exclusively (O_EXCL), so an existing key is still never
 *  replaced; a reader racing that create, or a crash during it, sees an incomplete file, which reads as unusable —
 *  never as a key — and is named in the diagnostic, not reused. */
function createKey(path: string, link: (from: string, to: string) => void): void {
  const body = randomBytes(32).toString("hex") + "\n";
  const tmp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
  writeNewFile(tmp, body);
  try {
    link(tmp, path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "";
    if (code === "EEXIST") return;
    if (!NO_LINKS.has(code)) throw e;
    try {
      writeNewFile(path, body);
    } catch (e2) {
      if ((e2 as NodeJS.ErrnoException).code !== "EEXIST") throw e2;
    }
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** The installation key for `runsRoot`, created (0600) when absent. Any existing file that is not a usable key — an
 *  empty one included — is never touched or replaced (two processes can then never replace each other's key): `why`
 *  names the defect. `link` is a test seam. */
export function scrubKey(runsRoot: string, link: (from: string, to: string) => void = linkSync): { key: Buffer } | { why: string } {
  const path = scrubKeyPath(runsRoot);
  let got = readKeyFile(path);
  if ("key" in got) return got;
  if (!got.absent) return got;
  try {
    mkdirSync(dirname(path), { recursive: true });
    createKey(path, link);
  } catch (e) {
    return { why: `${path} could not be created (${(e as Error).message})` };
  }
  got = readKeyFile(path);
  return "key" in got ? got : { why: got.why };
}

/** The fingerprint of a scrub set (`collectSecrets()` output) under `key`. */
export function scrubSetRecord(secrets: readonly string[], key: Buffer): ScrubSetRecord {
  const values = [...new Set(secrets.filter((s) => s.length > 0).map((s) => hmacOf(key, s)))].sort();
  return { v: 1, keyId: keyIdOf(key), values };
}

const warnedKeys = new Set<string>();

/** The fingerprint a run records, or why none can be (`unavailable`, recorded on the result as
 *  `scrubSetUnavailable`). An unusable key is warned about once per process, naming its path and the defect. */
export function runScrubSet(
  secrets: readonly string[],
  runsRoot: string,
  say: (line: string) => void = warn,
): { record: ScrubSetRecord } | { unavailable: string } {
  const got = scrubKey(runsRoot);
  if ("key" in got) return { record: scrubSetRecord(secrets, got.key) };
  if (!warnedKeys.has(got.why)) {
    warnedKeys.add(got.why);
    say(
      `::warning:: [scrub-set] no scrub-set fingerprint is recorded: the installation key ${got.why}. A later re-grade of this run ` +
        `cannot prove its scrub set covered. Fix or remove the file (a missing key is created on the next run).\n`,
    );
  }
  return { unavailable: got.why };
}

/** A recorded value, validated: anything not exactly the shape written (absent, older, or changed by a scrub) is
 *  undefined. */
export function parseScrubSet(v: unknown): ScrubSetRecord | undefined {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (o.v !== 1 || typeof o.keyId !== "string" || !KEY_ID_RE.test(o.keyId) || !Array.isArray(o.values)) return undefined;
  if (!o.values.every((x) => typeof x === "string" && VALUE_RE.test(x))) return undefined;
  return { v: 1, keyId: o.keyId, values: o.values as string[] };
}

/** Why a run's scrub set is not proven covered: it predates the record (`legacy`), it recorded why it has none
 *  (`unrecorded`: its key was unusable, `detail` says how), the record was changed (`mangled`), no key here has its id
 *  (`key`), or a string it scrubbed is not in this set (`smaller`). */
export type ScrubCoverage =
  | { covered: true }
  | { covered: false; why: "legacy" | "mangled" | "key" | "smaller" }
  | { covered: false; why: "unrecorded"; detail: string };

/**
 * Whether `secrets` provably covers the scrub set the run in `runDir` recorded (its result.json `scrubSet`, or
 * `scrubSetUnavailable` when it could record none). The key is looked up beside the runs root that holds the run (`<root>/<scenario>/<run>`), then beside
 * the current runs root. Read only: never creates a key.
 */
export function scrubCoverage(
  result: { scrubSet?: unknown; scrubSetUnavailable?: unknown } | undefined,
  runDir: string,
  secrets: readonly string[],
  currentRunsRoot: string,
): ScrubCoverage {
  const recorded = result?.scrubSet;
  if (recorded === undefined)
    return typeof result?.scrubSetUnavailable === "string"
      ? { covered: false, why: "unrecorded", detail: result.scrubSetUnavailable }
      : { covered: false, why: "legacy" };
  const run = parseScrubSet(recorded);
  if (!run) return { covered: false, why: "mangled" };
  const key = [dirname(dirname(runDir)), currentRunsRoot]
    .map((root) => readKeyFile(scrubKeyPath(root)))
    .flatMap((k) => ("key" in k ? [k.key] : []))
    .find((k) => keyIdOf(k) === run.keyId);
  if (!key) return { covered: false, why: "key" };
  const now = new Set(scrubSetRecord(secrets, key).values);
  return run.values.every((v) => now.has(v)) ? { covered: true } : { covered: false, why: "smaller" };
}

/** Plain words for a `ScrubCoverage` failure, never naming a value. */
export function coverageWhy(c: Extract<ScrubCoverage, { covered: false }>): string {
  switch (c.why) {
    case "legacy":
      return "the run predates the scrub-set record (harness < 4.4), so its scrub set cannot be proven covered";
    case "unrecorded":
      return `this run recorded no scrub set (its key ${c.detail}), so its scrub set cannot be proven covered`;
    case "mangled":
      return "the run's recorded scrub-set fingerprint is unreadable, so its scrub set cannot be proven covered";
    case "key":
      return `the run's scrub-set fingerprint was made with another installation's ${SCRUB_KEY_FILE} (another machine, or the key was replaced), so its scrub set cannot be proven covered`;
    case "smaller":
      return "this process's scrub set lacks a value the run scrubbed (COWORK_HARNESS_SCRUB_VALUES / COWORK_HARNESS_SCRUB_KEYS, or a rotated token)";
  }
}
