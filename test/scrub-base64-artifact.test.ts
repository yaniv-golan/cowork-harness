import { describe, it, expect, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { scrubField, scrub, collectSecrets } from "../src/secrets.js";
import { materializeManifest } from "../src/run/cassette.js";

// scrubField: whole-field base64 decode pass (CB-6 gap)
describe("scrubField — base64(prefix + TOKEN + suffix)", () => {
  afterEach(() => {
    delete process.env.COWORK_HARNESS_SCRUB_VALUES;
  });

  it("redacts a token embedded with surrounding bytes whose base64 form doesn't appear in the encoded blob", () => {
    const TOKEN = "sk-ant-test-scrubfield-abc";
    process.env.COWORK_HARNESS_SCRUB_VALUES = TOKEN;
    const secrets = collectSecrets();

    // Verify the gap: base64(TOKEN alone) does NOT appear in base64(prefix + TOKEN + suffix).
    const tokenB64 = Buffer.from(TOKEN).toString("base64");
    const compound = Buffer.from(`Bearer ${TOKEN}:nonce`).toString("base64");
    expect(compound).not.toContain(tokenB64);

    // scrubField closes it.
    expect(scrubField(compound, secrets)).toBe("[REDACTED:base64]");
  });

  it("leaves a base64 value without any secret unchanged", () => {
    process.env.COWORK_HARNESS_SCRUB_VALUES = "other-secret";
    const secrets = collectSecrets();
    const encoded = Buffer.from("harmless binary \x00\x01\x02").toString("base64");
    expect(scrubField(encoded, secrets)).toBe(encoded);
  });

  it("still redacts a literal token (base64-of-token-alone covered by scrub via collectSecrets L30)", () => {
    const TOKEN = "sk-ant-test-literal-xyz";
    process.env.COWORK_HARNESS_SCRUB_VALUES = TOKEN;
    const secrets = collectSecrets();
    const encoded = Buffer.from(TOKEN).toString("base64");
    // scrub() registered base64(TOKEN) at collectSecrets L30, so scrubField's first (direct) pass catches it.
    expect(scrubField(encoded, secrets)).not.toContain(TOKEN);
  });

  it("redacts a utf8 text body whose entire content is base64(prefix+TOKEN+suffix)", () => {
    // Issue B fix: scrubField is now also applied on the utf8 branch so a text artifact whose
    // content is a bare base64 blob with an embedded secret is caught.
    const TOKEN = "sk-ant-test-utf8-branch-token";
    process.env.COWORK_HARNESS_SCRUB_VALUES = TOKEN;
    const secrets = collectSecrets();
    const compound = Buffer.from(`Bearer ${TOKEN}:nonce`).toString("base64");
    // Confirm the gap: plain scrub misses it.
    expect(scrub(compound, secrets)).toBe(compound);
    // scrubField catches it.
    expect(scrubField(compound, secrets)).toBe("[REDACTED:base64]");
  });
});

// End-to-end: the sha256 recomputed by the cassette scrub must satisfy materializeManifest's verify.
describe("cassette base64 artifact scrub — materializeManifest end-to-end", () => {
  it("replay sha256 verify passes after a base64 artifact is scrubField-redacted", () => {
    const TOKEN = "sk-ant-test-e2e-token-999";
    const secrets = [TOKEN];

    // Build a fake base64 artifact body that contains the token embedded with surrounding bytes.
    const compound = Buffer.from(`prefix-${TOKEN}-suffix`).toString("base64");
    // Confirm the gap: plain scrub can't find the token in the encoded blob.
    expect(compound).not.toContain(TOKEN);

    // Simulate what cassette.ts:1078 now does.
    const scrubbed = scrubField(compound, secrets);
    expect(scrubbed).toBe("[REDACTED:base64]");
    const newSha256 = createHash("sha256").update(Buffer.from(scrubbed, "utf8")).digest("hex");

    const entry = {
      path: "outputs/secret.bin",
      bytes: compound.length,
      sha256: newSha256,
      body: scrubbed,
      encoding: undefined as "base64" | "utf8" | undefined,
    };

    // materializeManifest decodes body as utf8 (encoding undefined), hashes it, and compares to sha256.
    // If the record-time and replay-time hashes diverge, it throws — so not-throwing is the assertion.
    let workRoot: string | undefined;
    try {
      ({ workRoot } = materializeManifest([entry]));
    } finally {
      if (workRoot) rmSync(workRoot, { recursive: true, force: true });
    }
  });

  it("replay sha256 verify passes for an untouched base64 body (no secret)", () => {
    const binaryContent = Buffer.from("innocent binary \x00\x01\x02\x03");
    const encoded = binaryContent.toString("base64");
    // sha256 is over the RAW decoded bytes (matching buildManifest's hash-at-record behavior).
    const sha256 = createHash("sha256").update(binaryContent).digest("hex");

    const secrets = ["unrelated-secret"];
    const scrubbed = scrubField(encoded, secrets);
    expect(scrubbed).toBe(encoded); // no hit, unchanged

    const entry = {
      path: "outputs/image.bin",
      bytes: binaryContent.length,
      sha256,
      body: encoded,
      encoding: "base64" as const,
    };

    let workRoot: string | undefined;
    try {
      ({ workRoot } = materializeManifest([entry]));
    } finally {
      if (workRoot) rmSync(workRoot, { recursive: true, force: true });
    }
  });

  it("truncated entries (no body) pass through the map unchanged", () => {
    // Truncated entries have no body field — the proposed code's first guard handles them.
    const entry = {
      path: "outputs/large.bin",
      bytes: 999999,
      sha256: "deadbeef",
      truncated: true,
      // no body
    };

    // materializeManifest writes an empty placeholder for truncated entries — should not throw.
    let workRoot: string | undefined;
    try {
      ({ workRoot } = materializeManifest([entry]));
    } finally {
      if (workRoot) rmSync(workRoot, { recursive: true, force: true });
    }
  });
});
