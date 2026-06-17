import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRedactionPolicy, redactText } from "../src/redact.js";

const ENV_KEYS = ["COWORK_HARNESS_REDACT_PATTERNS", "COWORK_HARNESS_REDACT_KEYS"];
const saved: Record<string, string | undefined> = {};
function setEnv(k: string, v: string | undefined) {
  if (!(k in saved)) saved[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (k in saved) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  }
});

function dirWith(json: unknown): string {
  const d = mkdtempSync(join(tmpdir(), "cwh-redact-cfg-"));
  writeFileSync(join(d, ".cowork-redact.json"), JSON.stringify(json));
  return d;
}

describe("loadRedactionPolicy", () => {
  it("no config + no env → empty policy (no-op)", () => {
    for (const k of ENV_KEYS) setEnv(k, undefined);
    const d = mkdtempSync(join(tmpdir(), "cwh-redact-none-"));
    const p = loadRedactionPolicy([d]);
    expect(p.patterns).toEqual([]);
    expect(redactText("alice@acme.com", p)).toBe("alice@acme.com");
  });

  it("reads patterns + keys from .cowork-redact.json", () => {
    for (const k of ENV_KEYS) setEnv(k, undefined);
    const d = dirWith({ patterns: [{ regex: "[\\w.+-]+@[\\w.-]+\\.[a-z]{2,}", label: "email", flags: "gi" }], keys: ["ssn"] });
    const p = loadRedactionPolicy([d]);
    expect(p.patterns.length).toBe(1);
    expect(p.keyNames).toContain("ssn");
    expect(redactText("x alice@acme.com", p)).not.toContain("alice@acme.com");
  });

  it("merges env COWORK_HARNESS_REDACT_PATTERNS / _KEYS", () => {
    setEnv("COWORK_HARNESS_REDACT_PATTERNS", "secret\\d+");
    setEnv("COWORK_HARNESS_REDACT_KEYS", "token,apikey");
    const d = mkdtempSync(join(tmpdir(), "cwh-redact-env-"));
    const p = loadRedactionPolicy([d]);
    expect(p.keyNames).toEqual(expect.arrayContaining(["token", "apikey"]));
    expect(redactText("secret42 here", p)).not.toContain("secret42");
  });

  it("a malformed regex in config FAILS LOUD (under-redaction = leak)", () => {
    for (const k of ENV_KEYS) setEnv(k, undefined);
    const d = dirWith({ patterns: [{ regex: "(", label: "bad" }] });
    expect(() => loadRedactionPolicy([d])).toThrow();
  });
});
