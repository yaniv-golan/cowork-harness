// The scrub-set fingerprint (`src/scrub-set.ts`): its stored form survives any hex- or digit-shaped scrub, the
// installation key proves coverage only when it is a private regular file with the run's key id, and an unusable key
// is said (once, with its path and the defect) and recorded instead of failing silently.
import { describe, it, expect, afterEach } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { scrub } from "../src/secrets.js";
import { SCRUB_KEY_FILE, parseScrubSet, runScrubSet, scrubCoverage, scrubKey, scrubKeyPath, scrubSetRecord } from "../src/scrub-set.js";

const dirs: string[] = [];
// A runs root nested in its own temp dir: the key lives beside it, so never in the shared tmpdir.
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "scrubset-"));
  dirs.push(d);
  return join(d, "runs");
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
// A run dir two levels under its runs root, as `<root>/<scenario>/<run>`.
const runDirIn = (root: string) => join(root, "alpha", "local_x");
const SET = ["zebra-kettle-quiet-orbit", "maple-harbor-silent-quill"];
const keyOf = (root: string) => {
  const k = scrubKey(root);
  if (!("key" in k)) throw new Error(k.why);
  return k.key;
};
const ran = (rec: unknown) => ({ scrubSet: rec });

describe.runIf(process.platform !== "win32")("scrub-set fingerprint", () => {
  it("no hex digit or decimal digit can occur inside a stored record", () => {
    const rec = scrubSetRecord(SET, keyOf(fresh()));
    const text = JSON.stringify(rec.values) + rec.keyId;
    expect(scrub(text, [..."0123456789abcdef"])).toBe(text);
    expect(parseScrubSet(rec)).toEqual(rec);
    expect(parseScrubSet({ ...rec, values: ["[REDACTED]"] })).toBeUndefined();
  });

  it("covered: a subset or equal set under the same key; refused: smaller, legacy, unrecorded, mangled, another key", () => {
    const root = fresh();
    const rec = scrubSetRecord(SET, keyOf(root));
    expect(scrubCoverage(ran(rec), runDirIn(root), [...SET, "extra-value-heron"], root)).toEqual({ covered: true });
    expect(scrubCoverage(ran(rec), runDirIn(root), SET.slice(0, 1), root)).toEqual({ covered: false, why: "smaller" });
    expect(scrubCoverage({}, runDirIn(root), SET, root)).toEqual({ covered: false, why: "legacy" });
    expect(scrubCoverage({ scrubSetUnavailable: "x is empty" }, runDirIn(root), SET, root)).toEqual({
      covered: false,
      why: "unrecorded",
      detail: "x is empty",
    });
    expect(scrubCoverage(ran({ v: 1, keyId: "x", values: [] }), runDirIn(root), SET, root)).toEqual({ covered: false, why: "mangled" });
    const other = fresh();
    expect(scrubCoverage(ran(rec), runDirIn(other), SET, other)).toEqual({ covered: false, why: "key" });
  });

  it("a key readable by others, or a symlink, proves nothing", () => {
    const root = fresh();
    const rec = scrubSetRecord(SET, keyOf(root));
    const keyFile = scrubKeyPath(root);
    expect(keyFile).toBe(join(dirname(root), SCRUB_KEY_FILE));
    chmodSync(keyFile, 0o644);
    expect(scrubCoverage(ran(rec), runDirIn(root), SET, root)).toEqual({ covered: false, why: "key" });
    chmodSync(keyFile, 0o600);
    const linked = fresh();
    mkdirSync(dirname(scrubKeyPath(linked)), { recursive: true });
    symlinkSync(keyFile, scrubKeyPath(linked));
    expect(scrubCoverage(ran(rec), runDirIn(linked), SET, linked)).toEqual({ covered: false, why: "key" });
  });

  it("a key is created whole, beside the root, leaving no temp file", () => {
    const root = fresh();
    keyOf(root);
    expect(readdirSync(dirname(root))).toEqual([SCRUB_KEY_FILE]);
  });

  it("a 0-byte key (an interrupted create) is recreated; any other unusable file is left alone and named", () => {
    const root = fresh();
    mkdirSync(dirname(root), { recursive: true });
    writeFileSync(scrubKeyPath(root), "", { mode: 0o600 });
    expect("key" in scrubKey(root)).toBe(true);
    const bad = fresh();
    mkdirSync(dirname(bad), { recursive: true });
    writeFileSync(scrubKeyPath(bad), "not a key\n", { mode: 0o600 });
    const got = scrubKey(bad);
    expect(got).toEqual({ why: `${scrubKeyPath(bad)} does not hold a 64-hex-digit key` });
    const loose = fresh();
    mkdirSync(dirname(loose), { recursive: true });
    writeFileSync(scrubKeyPath(loose), randomBytes(32).toString("hex") + "\n", { mode: 0o644 });
    chmodSync(scrubKeyPath(loose), 0o644);
    expect("why" in scrubKey(loose) && (scrubKey(loose) as { why: string }).why).toMatch(/readable or writable by others \(mode 644/);
  });

  it("an unusable key is warned about once, naming its path, and recorded as unavailable", () => {
    const root = fresh();
    mkdirSync(dirname(root), { recursive: true });
    writeFileSync(scrubKeyPath(root), "not a key\n", { mode: 0o600 });
    const said: string[] = [];
    const a = runScrubSet(SET, root, (l) => said.push(l));
    const b = runScrubSet(SET, root, (l) => said.push(l));
    expect(a).toEqual({ unavailable: `${scrubKeyPath(root)} does not hold a 64-hex-digit key` });
    expect(b).toEqual(a);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(scrubKeyPath(root));
    expect(said[0]).toMatch(/no scrub-set fingerprint is recorded/);
  });
});
