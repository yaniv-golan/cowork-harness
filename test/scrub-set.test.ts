// The scrub-set fingerprint (`src/scrub-set.ts`): its stored form survives any hex- or digit-shaped scrub, and the
// installation key proves coverage only when it is a private regular file with the run's key id.
import { describe, it, expect, afterEach } from "vitest";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrub } from "../src/secrets.js";
import { SCRUB_KEY_FILE, parseScrubSet, scrubCoverage, scrubKey, scrubSetRecord } from "../src/scrub-set.js";

const dirs: string[] = [];
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "scrubset-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
// A run dir two levels under its runs root, as `<root>/<scenario>/<run>`.
const runDirIn = (root: string) => join(root, "alpha", "local_x");
const SET = ["zebra-kettle-quiet-orbit", "maple-harbor-silent-quill"];

describe.runIf(process.platform !== "win32")("scrub-set fingerprint", () => {
  it("no hex digit or decimal digit can occur inside a stored record", () => {
    const key = scrubKey(fresh())!;
    const rec = scrubSetRecord(SET, key);
    const text = JSON.stringify(rec.values) + rec.keyId;
    expect(scrub(text, [..."0123456789abcdef"])).toBe(text);
    expect(parseScrubSet(rec)).toEqual(rec);
    expect(parseScrubSet({ ...rec, values: ["[REDACTED]"] })).toBeUndefined();
  });

  it("covered: a subset or equal set under the same key; refused: smaller, legacy, mangled, another key", () => {
    const root = fresh();
    const rec = scrubSetRecord(SET, scrubKey(root)!);
    const cur = root;
    expect(scrubCoverage(rec, runDirIn(root), [...SET, "extra-value-heron"], cur)).toEqual({ covered: true });
    expect(scrubCoverage(rec, runDirIn(root), SET.slice(0, 1), cur)).toEqual({ covered: false, why: "smaller" });
    expect(scrubCoverage(undefined, runDirIn(root), SET, cur)).toEqual({ covered: false, why: "legacy" });
    expect(scrubCoverage({ v: 1, keyId: "x", values: [] }, runDirIn(root), SET, cur)).toEqual({ covered: false, why: "mangled" });
    const other = fresh();
    expect(scrubCoverage(rec, runDirIn(other), SET, other)).toEqual({ covered: false, why: "key" });
  });

  it("a key readable by others, or a symlink, proves nothing", () => {
    const root = fresh();
    const rec = scrubSetRecord(SET, scrubKey(root)!);
    const keyFile = join(root, SCRUB_KEY_FILE);
    chmodSync(keyFile, 0o644);
    expect(scrubCoverage(rec, runDirIn(root), SET, root)).toEqual({ covered: false, why: "key" });
    chmodSync(keyFile, 0o600);
    const linked = fresh();
    symlinkSync(keyFile, join(linked, SCRUB_KEY_FILE));
    expect(scrubCoverage(rec, runDirIn(linked), SET, linked)).toEqual({ covered: false, why: "key" });
  });

  it("an existing non-key file is never overwritten and yields no key", () => {
    const root = fresh();
    writeFileSync(join(root, SCRUB_KEY_FILE), "not a key\n", { mode: 0o600 });
    expect(scrubKey(root)).toBeUndefined();
    writeFileSync(join(root, SCRUB_KEY_FILE), randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
    expect(scrubKey(root)).toBeDefined();
  });
});
