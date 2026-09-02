import { describe, it, expect } from "vitest";
import { extractAgentReleaseChannel, checkAgentReleaseChannel } from "../src/sync/cowork-sync.js";

/**
 * `fetchOfficialElfChecksum` hard-coded the STABLE versioned release path. Desktop also stages release
 * CANDIDATES, served only from `…/claude-code-releases/rc/<commit>/`, so for agent 2.1.255 the stable
 * path 404'd and the baseline recorded `manifestChecksumMatch:"unknown"` for a build whose checksum IS
 * published and DOES match. The commit is undiscoverable from the network, so the channel must be read
 * out of the asar.
 *
 * Every fixture below is built from the REAL literals in the shipped asars (1.40609.1 for RC, 1.40609.0
 * for stable, 1.24012.11 for the single-quote delimiter), not invented ones.
 */

const STABLE = "https://downloads.claude.ai/claude-code-releases";
const RC = "https://downloads.claude.ai/claude-code-releases/rc/aa8f2d981f0481a41774e243a213e29dfe810e1f";

/** The descriptor as Desktop actually emits it. `nested` reproduces the RC-only `manifest.baseUrl`,
 *  which PRECEDES the top-level one in the byte stream — the whole point of test 3. */
function descriptor(opts: { version: string; baseUrl: string; nested?: string; delim?: string }): string {
  const d = opts.delim ?? "`";
  const manifest = {
    version: opts.version,
    commit: "aa8f2d981f0481a41774e243a213e29dfe810e1f",
    buildDate: "2026-08-30T19:51:41Z",
    platforms: {
      "linux-arm64": { binary: "claude.zst", checksum: "a4385a4caf6f15eced01357b01dcb965ee69c0fe0043bd9f156ce32d29489b3c", size: 75681561 },
    },
    sdkCompat: { testedWrapperVersions: ["0.3.226", "0.3.227"], harnessSchema: 1 },
    ...(opts.nested ? { baseUrl: opts.nested } : {}),
  };
  const blob = JSON.stringify({
    version: opts.version,
    manifest,
    baseUrl: opts.baseUrl,
    sdkWrapperVersion: "0.3.255-rc.20260830.t194148.shaaa8f2d9",
  });
  return `function xX(){return JSON.parse(${d}${blob}${d})}`;
}

/** Every asar also carries an ssh-releases descriptor. Measured 0 of 24 times does it come first, so it
 *  is a decoy in principle only — kept as a cheap assertion, NOT as the hazard this defends against. */
const SSH_DESCRIPTOR = `function yY(){return JSON.parse(\`{"version":"1.0.0","manifest":{"version":"1.0.0"},"baseUrl":"https://downloads.claude.ai/claude-ssh-releases"}\`)}`;

describe("extractAgentReleaseChannel", () => {
  it("reads the stable channel", () => {
    expect(extractAgentReleaseChannel(descriptor({ version: "2.1.247", baseUrl: STABLE }))).toEqual({
      baseUrl: STABLE,
      sdkVersion: "2.1.247",
    });
  });

  it("reads the RC channel — the case the stable-only fetch could not address", () => {
    expect(extractAgentReleaseChannel(descriptor({ version: "2.1.255", baseUrl: RC, nested: RC }))).toEqual({
      baseUrl: RC,
      sdkVersion: "2.1.255",
    });
  });

  // THE REAL HAZARD. On RC builds `manifest.baseUrl` precedes the top-level one in the byte stream, so a
  // `"baseUrl":"([^"]+)"` first-match reads the NESTED key. Both agree on every shipped RC build, which is
  // exactly why it is latent rather than broken. The fixture makes them DISAGREE so the two implementations
  // are separable: a first-match returns the nested value and fails; the shipped parser returns the top-level
  // one. Verified against a first-match stand-in below so this cannot be a test that only ever passes.
  it("returns the TOP-LEVEL baseUrl, not the nested manifest.baseUrl that precedes it", () => {
    const decoyNested = `${STABLE}/rc/${"b".repeat(40)}`;
    const bundle = descriptor({ version: "2.1.255", baseUrl: RC, nested: decoyNested });
    expect(bundle.indexOf(decoyNested)).toBeLessThan(bundle.lastIndexOf(RC));
    const naiveFirstMatch = /"baseUrl":"([^"]+)"/.exec(bundle)?.[1];
    expect(naiveFirstMatch).toBe(decoyNested); // the implementation this test rules out
    expect(extractAgentReleaseChannel(bundle)?.baseUrl).toBe(RC);
  });

  // The delimiter flipped at Desktop 1.25927.0 — `JSON.parse('…')` in 12 of 24 backed-up asars and
  // backticks in the other 12. A backtick-only matcher is blind to half the population.
  it.each([
    ["backtick", "`"],
    ["single-quote", "'"],
  ])("accepts the %s delimiter", (_label, delim) => {
    expect(extractAgentReleaseChannel(descriptor({ version: "2.1.219", baseUrl: STABLE, delim }))?.baseUrl).toBe(STABLE);
  });

  it("ignores the claude-ssh-releases descriptor even when it comes first", () => {
    expect(extractAgentReleaseChannel(SSH_DESCRIPTOR + descriptor({ version: "2.1.247", baseUrl: STABLE }))?.baseUrl).toBe(STABLE);
  });

  it("returns null on more than one DISTINCT descriptor rather than picking one", () => {
    const two = descriptor({ version: "2.1.247", baseUrl: STABLE }) + descriptor({ version: "2.1.255", baseUrl: RC });
    expect(extractAgentReleaseChannel(two)).toBeNull();
  });

  it("tolerates the same descriptor appearing twice (duplicates are not ambiguity)", () => {
    const d = descriptor({ version: "2.1.247", baseUrl: STABLE });
    expect(extractAgentReleaseChannel(d + d)?.baseUrl).toBe(STABLE);
  });

  it.each([
    ["no descriptor at all", "const x = 1;"],
    ["an off-channel host", descriptor({ version: "2.1.247", baseUrl: "https://evil.example/claude-code-releases" })],
    ["a short rc sha", descriptor({ version: "2.1.247", baseUrl: `${STABLE}/rc/aa8f2d9` })],
    ["a trailing path segment", descriptor({ version: "2.1.247", baseUrl: `${STABLE}/2.1.247` })],
  ])("returns null for %s — never a silent stable-path fallback", (_label, bundle) => {
    expect(extractAgentReleaseChannel(bundle)).toBeNull();
  });

  it("returns null when the descriptor's own two version fields disagree", () => {
    const bundle = descriptor({ version: "2.1.255", baseUrl: STABLE }).replace(
      '"version":"2.1.255","commit"',
      '"version":"2.1.999","commit"',
    );
    expect(extractAgentReleaseChannel(bundle)).toBeNull();
  });
});

describe("checkAgentReleaseChannel — NOTE-class only, never write-blocking", () => {
  it("says nothing when the pinned SDK is the staged version", () => {
    expect(checkAgentReleaseChannel({ baseUrl: STABLE, sdkVersion: "2.1.247" }, "2.1.247")).toEqual([]);
  });

  // MEASURED BENIGN, TWICE. Desktop pins the NEXT SDK in the asar while still staging the previous one:
  // 1.20186.0 staged 2.1.202 with the descriptor reading 2.1.205, and 1.20186.9 staged 2.1.205 reading
  // 2.1.209 — 2 of the 21 backed-up asars that have a committed baseline. Both recorded a CORRECT
  // `manifestChecksumMatch:true`. An earlier draft of this change made the disagreement a hard delta,
  // which would have refused both of those syncs.
  it.each([
    ["1.20186.0", "2.1.205", "2.1.202"],
    ["1.20186.9", "2.1.209", "2.1.205"],
  ])("on a STABLE base, a version disagreement (%s) is one plain note, not a warning", (_desktop, sdk, staged) => {
    const notes = checkAgentReleaseChannel({ baseUrl: STABLE, sdkVersion: sdk }, staged);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("Benign on the stable channel");
    expect(notes[0]).not.toContain("WARNING");
  });

  it("on an RC base, the same disagreement is a WARNING — there the commit is the version's identity", () => {
    const notes = checkAgentReleaseChannel({ baseUrl: RC, sdkVersion: "2.1.250" }, "2.1.255");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("WARNING");
    expect(notes[0]).toContain("RELEASE-CANDIDATE");
  });

  it("a missing descriptor notes that the cross-check was SKIPPED, not that the stable path was tried", () => {
    const notes = checkAgentReleaseChannel(null, "2.1.255");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("SKIPPED");
    expect(notes[0]).toContain("unknown");
  });
});
