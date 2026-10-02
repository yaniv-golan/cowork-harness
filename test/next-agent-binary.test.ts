// `sync` builds the next baseline's `agentBinary` by spreading the base and overriding the fields it re-derives. Two
// of those fields — `nativeBuilds` (the native build per CPU arch) and `releaseBaseUrl` (the staging channel) — must be
// recomputed from THIS sync's asar every time and NEVER carried from the base: a carried map would pin the previous
// version's builds next to a new path (every hostloop host then classifies `kind:"build"` and fails), and a carried
// channel would hide a stable<->RC flip from `sync --diff`. Dropping the override line is silent everywhere else.
import { describe, it, expect } from "vitest";
import { buildNextAgentBinary } from "../src/baseline.js";

const NEW_PATH = "~/Library/Application Support/Claude/claude-code/2.1.290/aaaaaaaaaaaa/claude.app/Contents/MacOS/claude";
const base = {
  stagedPath: "~/Library/Application Support/Claude/claude-code-vm/2.1.286/claude",
  format: "elf-aarch64",
  nativeStagedPath: "~/Library/Application Support/Claude/claude-code/2.1.286/f2326db61802/claude.app/Contents/MacOS/claude",
  nativeBuilds: { arm64: "f2326db61802", x64: "fda00b160da4" },
  releaseBaseUrl: "https://downloads.claude.ai/claude-code-releases/rc/0123456789abcdef0123456789abcdef01234567",
  sha256: "old",
  shaProvenance: "measured-local",
  manifestChecksumMatch: true,
};
const derived = (channel: unknown, releaseBaseUrl: string | null) => ({
  stagedPath: "~/Library/Application Support/Claude/claude-code-vm/2.1.290/claude",
  nativeStagedPath: NEW_PATH,
  channel: channel as Parameters<typeof buildNextAgentBinary>[1]["channel"],
  releaseBaseUrl,
});

describe("buildNextAgentBinary — the fields sync re-derives are never carried from the base", () => {
  it("no channel: neither nativeBuilds nor releaseBaseUrl survives from the base", () => {
    const next = buildNextAgentBinary(base, derived(null, null));
    expect(next).not.toHaveProperty("nativeBuilds", base.nativeBuilds);
    expect(next.nativeBuilds).toBeUndefined();
    expect(next.releaseBaseUrl).toBeUndefined();
    // and JSON drops them, so the written file carries neither
    expect(JSON.parse(JSON.stringify(next))).not.toHaveProperty("nativeBuilds");
    expect(JSON.parse(JSON.stringify(next))).not.toHaveProperty("releaseBaseUrl");
  });

  it("a channel for ANOTHER version (after an auto-update): no map, never the base's", () => {
    const next = buildNextAgentBinary(
      base,
      derived({ sdkVersion: "2.1.288", nativeBuilds: { "darwin-arm64": "bbbbbbbbbbbb" } }, "https://x/stable"),
    );
    expect(next.nativeBuilds).toBeUndefined();
    expect(next.releaseBaseUrl).toBe("https://x/stable");
  });

  it("a channel matching the pinned version: the FRESH map and channel", () => {
    const next = buildNextAgentBinary(
      base,
      derived(
        { sdkVersion: "2.1.290", nativeBuilds: { "darwin-arm64": "aaaaaaaaaaaa", "darwin-x64": "cccccccccccc" } },
        "https://downloads.claude.ai/claude-code-releases",
      ),
    );
    expect(next.nativeBuilds).toEqual({ arm64: "aaaaaaaaaaaa", x64: "cccccccccccc" });
    expect(next.releaseBaseUrl).toBe("https://downloads.claude.ai/claude-code-releases");
    expect(next.nativeStagedPath).toBe(NEW_PATH);
  });

  it("keeps the base's hand-authored fields, and drops sha fields it could not re-derive", () => {
    const next = buildNextAgentBinary(base, derived(null, null));
    expect(next.format).toBe("elf-aarch64");
    expect(next.sha256).toBeUndefined();
    expect(next.shaProvenance).toBeUndefined();
    const withSha = buildNextAgentBinary(base, {
      ...derived(null, null),
      sha256: "new",
      shaProvenance: "measured-local",
      manifestChecksumMatch: "unknown",
    });
    expect(withSha).toMatchObject({ sha256: "new", shaProvenance: "measured-local", manifestChecksumMatch: "unknown" });
  });
});
