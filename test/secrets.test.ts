import { describe, it, expect, afterEach } from "vitest";
import { collectSecrets, scrub } from "../src/secrets.js";

// the scrub set covers the known auth keys + ANTHROPIC_CUSTOM_HEADERS, plus user-configured
// keys (COWORK_HARNESS_SCRUB_KEYS) and literal values (COWORK_HARNESS_SCRUB_VALUES). Token-free.
describe("secret collection covers more than the three auth tokens", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of [
      "ANTHROPIC_CUSTOM_HEADERS",
      "COWORK_HARNESS_SCRUB_KEYS",
      "COWORK_HARNESS_SCRUB_VALUES",
      "MY_PROXY_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ])
      delete process.env[k];
    Object.assign(process.env, saved);
  });

  it("scrubs ANTHROPIC_CUSTOM_HEADERS (raw + base64)", () => {
    process.env.ANTHROPIC_CUSTOM_HEADERS = "Authorization: Bearer hdr-secret";
    const secrets = collectSecrets();
    expect(scrub("leak: Authorization: Bearer hdr-secret", secrets)).not.toContain("hdr-secret");
    expect(secrets).toContain(Buffer.from("Authorization: Bearer hdr-secret").toString("base64"));
  });

  it("scrubs a user-named extra env key via COWORK_HARNESS_SCRUB_KEYS", () => {
    process.env.MY_PROXY_TOKEN = "proxy-abc-123";
    process.env.COWORK_HARNESS_SCRUB_KEYS = "MY_PROXY_TOKEN, ANOTHER_ABSENT";
    expect(scrub("here is proxy-abc-123 in a log", collectSecrets())).toBe("here is [REDACTED] in a log");
  });

  it("scrubs literal values via COWORK_HARNESS_SCRUB_VALUES", () => {
    process.env.COWORK_HARNESS_SCRUB_VALUES = "hunter2,topsecret";
    const out = scrub("a=hunter2 b=topsecret", collectSecrets());
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("topsecret");
  });
});
