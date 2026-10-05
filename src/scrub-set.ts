/**
 * The scrub-set fingerprint a run records (`RunResult.scrubSet`), so a later re-grade can PROVE that the set it
 * scrubs with covers every string the run scrubbed — never by comparing values, which are never recorded.
 *
 * Each string the run's scrub used (every `collectSecrets()` entry: a named key's value, a literal, and their
 * encodings) is recorded as an HMAC-SHA256 under a random per-installation key, `scrubset.key` in the runs root
 * (0600, created on the first run, never inside a run dir). With no public verifier, a shared result.json gives
 * nothing to brute-force. A re-grade recomputes the HMACs of its own set under the same key: when every recorded
 * one is among them, the run's set is a subset of this one (a grown set included). A missing or different key
 * (another machine), or a run recorded before the field existed, proves nothing.
 *
 * The stored strings use a 16-letter alphabet with no digit and no `a`–`f`, so a hex- or digit-shaped secret can
 * never match inside them when the whole result is scrubbed as text. A fingerprint the scrub did change (a secret
 * made only of those letters) fails validation and proves nothing: fail closed.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync, constants } from "node:fs";
import { dirname, join } from "node:path";

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
 *  else is not a key — it proves nothing and is never overwritten. */
function readKeyFile(path: string): Buffer | undefined {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || (st.mode & 0o077) !== 0) return undefined;
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) return undefined;
    const hex = readFileSync(path, "utf8").trim();
    return /^[0-9a-f]{64}$/.test(hex) ? Buffer.from(hex, "hex") : undefined;
  } catch {
    return undefined;
  }
}

/** The installation key in `root`, created (0600, exclusive) when absent. Undefined when it cannot be made or read. */
export function scrubKey(root: string): Buffer | undefined {
  const path = join(root, SCRUB_KEY_FILE);
  const existing = readKeyFile(path);
  if (existing) return existing;
  try {
    mkdirSync(root, { recursive: true });
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      if ((fstatSync(fd).mode & 0o077) !== 0) return undefined;
      writeSync(fd, randomBytes(32).toString("hex") + "\n");
    } finally {
      closeSync(fd);
    }
  } catch {
    // Created by a concurrent run between the read and the create, or not creatable at all: read whatever is there.
  }
  return readKeyFile(path);
}

/** The fingerprint of a scrub set (`collectSecrets()` output) under `key`. */
export function scrubSetRecord(secrets: readonly string[], key: Buffer): ScrubSetRecord {
  const values = [...new Set(secrets.filter((s) => s.length > 0).map((s) => hmacOf(key, s)))].sort();
  return { v: 1, keyId: keyIdOf(key), values };
}

/** The fingerprint a run records, or undefined when no key can be made (the run then proves nothing later). */
export function runScrubSet(secrets: readonly string[], runsRoot: string): ScrubSetRecord | undefined {
  const key = scrubKey(runsRoot);
  return key ? scrubSetRecord(secrets, key) : undefined;
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

/** Why a run's scrub set is not proven covered: it records none (`legacy`), the record was changed (`mangled`), no
 *  key here has its id (`key`), or a string it scrubbed is not in this set (`smaller`). */
export type ScrubCoverage = { covered: true } | { covered: false; why: "legacy" | "mangled" | "key" | "smaller" };

/**
 * Whether `secrets` provably covers the scrub set the run in `runDir` recorded (`recorded`: its result.json
 * `scrubSet`). The key is looked up in the runs root that holds the run (`<root>/<scenario>/<run>`) and in the
 * current runs root. Read only: never creates a key.
 */
export function scrubCoverage(recorded: unknown, runDir: string, secrets: readonly string[], currentRunsRoot: string): ScrubCoverage {
  if (recorded === undefined) return { covered: false, why: "legacy" };
  const run = parseScrubSet(recorded);
  if (!run) return { covered: false, why: "mangled" };
  const key = [dirname(dirname(runDir)), currentRunsRoot]
    .map((root) => readKeyFile(join(root, SCRUB_KEY_FILE)))
    .find((k) => k !== undefined && keyIdOf(k) === run.keyId);
  if (!key) return { covered: false, why: "key" };
  const now = new Set(scrubSetRecord(secrets, key).values);
  return run.values.every((v) => now.has(v)) ? { covered: true } : { covered: false, why: "smaller" };
}

/** Plain words for a `ScrubCoverage` failure, never naming a value. */
export function coverageWhy(c: Extract<ScrubCoverage, { covered: false }>): string {
  switch (c.why) {
    case "legacy":
      return "the run predates the scrub-set record (harness < 4.4), so its scrub set cannot be proven covered";
    case "mangled":
      return "the run's recorded scrub-set fingerprint is unreadable, so its scrub set cannot be proven covered";
    case "key":
      return `the run's scrub-set fingerprint was made with another installation's ${SCRUB_KEY_FILE} (another machine, or the key was replaced), so its scrub set cannot be proven covered`;
    case "smaller":
      return "this process's scrub set lacks a value the run scrubbed (COWORK_HARNESS_SCRUB_VALUES / COWORK_HARNESS_SCRUB_KEYS, or a rotated token)";
  }
}
