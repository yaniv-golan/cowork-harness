import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { confirmArtifactRuntime, confirmArtifactRuntimeWithLoader } from "../src/run/analyze-artifact-runtime.js";

// This repo is pure ESM ("type": "module") — `__dirname` is undefined; derive the repo root from
// `import.meta.url` instead (this file lives at `<repoRoot>/test/analyze-artifact-runtime.test.ts`),
// matching the convention in `test/analyze-artifact.test.ts`.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(REPO_ROOT, "test", "fixtures", "analyze-artifact-runtime");

function fixturePath(...parts: string[]): string {
  return join(FIXTURES, ...parts);
}

function readFixture(...parts: string[]): { path: string; html: string } {
  const path = fixturePath(...parts);
  return { path, html: readFileSync(path, "utf8") };
}

// Each confirmArtifactRuntime() call drives two full jsdom runs (200-mode + 404-mode); fixtures are
// deliberately minimal (per the prototype's own guidance — "keep fixtures minimal") but jsdom
// construction + event-loop settling can still be slow on a loaded CI box, so give these more room than
// vitest's 5s default.
const RUNTIME_TIMEOUT_MS = 20_000;

describe("confirmArtifactRuntime — jsdom-available path (real jsdom, this dev env has it installed)", () => {
  it(
    "a lost fetch-POST with an unconditional success message -> lost",
    async () => {
      const { path, html } = readFixture("lost", "index.html");
      const result = await confirmArtifactRuntime(path, html);
      expect(result.available).toBe(true);
      if (!result.available) throw new Error("unreachable — asserted available above");
      expect(result.verdict).toBe("lost");
      expect(result.confidence).toBe("high");
      expect(result.evidence.length).toBeGreaterThan(0);
      // The unread-response signal is the specific mechanism for this fixture.
      expect(result.evidence.some((e) => e.includes("never consulted"))).toBe(true);
    },
    RUNTIME_TIMEOUT_MS,
  );

  it(
    "a page that checks resp.ok and degrades on 404 -> suspect (not lost, not clean)",
    async () => {
      const { path, html } = readFixture("suspect", "index.html");
      const result = await confirmArtifactRuntime(path, html);
      expect(result.available).toBe(true);
      if (!result.available) throw new Error("unreachable — asserted available above");
      expect(result.verdict).toBe("suspect");
      expect(result.confidence).toBe("high");
    },
    RUNTIME_TIMEOUT_MS,
  );

  it(
    "a page with only a remote absolute POST -> clean (different bug class, explicitly ignored)",
    async () => {
      const { path, html } = readFixture("clean-remote", "index.html");
      const result = await confirmArtifactRuntime(path, html);
      expect(result.available).toBe(true);
      if (!result.available) throw new Error("unreachable — asserted available above");
      expect(result.verdict).toBe("clean");
      expect(result.evidence.some((e) => e.includes("remote"))).toBe(true);
    },
    RUNTIME_TIMEOUT_MS,
  );

  it(
    "a page with no interactive write-back at all -> clean",
    async () => {
      const { path, html } = readFixture("clean-no-writeback", "index.html");
      const result = await confirmArtifactRuntime(path, html);
      expect(result.available).toBe(true);
      if (!result.available) throw new Error("unreachable — asserted available above");
      expect(result.verdict).toBe("clean");
      expect(result.confidence).toBe("high");
    },
    RUNTIME_TIMEOUT_MS,
  );

  it(
    "a page whose script throws -> inconclusive, never a host-process crash",
    async () => {
      const { path, html } = readFixture("inconclusive-crash", "index.html");
      const result = await confirmArtifactRuntime(path, html);
      expect(result.available).toBe(true);
      if (!result.available) throw new Error("unreachable — asserted available above");
      expect(result.verdict).toBe("inconclusive");
      expect(result.confidence).toBe("low");
    },
    RUNTIME_TIMEOUT_MS,
  );

  it(
    "a page whose behavior depends entirely on an unloaded external CDN bundle -> inconclusive",
    async () => {
      const { path, html } = readFixture("inconclusive-external-cdn", "index.html");
      const result = await confirmArtifactRuntime(path, html);
      expect(result.available).toBe(true);
      if (!result.available) throw new Error("unreachable — asserted available above");
      expect(result.verdict).toBe("inconclusive");
      expect(result.evidence.some((e) => e.includes("external script"))).toBe(true);
    },
    RUNTIME_TIMEOUT_MS,
  );

  it(
    "a page with no interactive controls at all -> inconclusive (nothing to drive)",
    async () => {
      const { path, html } = readFixture("inconclusive-no-controls", "index.html");
      const result = await confirmArtifactRuntime(path, html);
      expect(result.available).toBe(true);
      if (!result.available) throw new Error("unreachable — asserted available above");
      expect(result.verdict).toBe("inconclusive");
      expect(result.evidence.some((e) => e.includes("no interactive controls"))).toBe(true);
    },
    RUNTIME_TIMEOUT_MS,
  );
});

describe("confirmArtifactRuntime — jsdom-unavailable guard (dependency rule: jsdom is a devDependency only)", () => {
  it("returns {available:false, reason} gracefully when the dynamic jsdom import fails, and never throws", async () => {
    // confirmArtifactRuntime() always uses the real dynamic `import("jsdom")` internally; jsdom IS
    // installed in this dev/test environment, so the only way to exercise the "not installed" guard path
    // without mutating node_modules is via the injectable-loader variant, which shares the exact same
    // guard logic (confirmArtifactRuntime is a thin wrapper that calls this with the real loader).
    const result = await confirmArtifactRuntimeWithLoader("unused.html", "<html></html>", async () => {
      throw new Error("Cannot find package 'jsdom' imported from analyze-artifact-runtime.ts");
    });
    expect(result).toEqual({
      available: false,
      reason: "jsdom not installed — run `npm i jsdom` to enable runtime confirmation",
    });
  });

  it("does not care WHY the loader failed — any rejection collapses to the same graceful reason", async () => {
    const result = await confirmArtifactRuntimeWithLoader("unused.html", "<html></html>", async () => {
      throw new TypeError("some unrelated resolution failure");
    });
    expect(result.available).toBe(false);
    if (result.available) throw new Error("unreachable — asserted unavailable above");
    expect(result.reason).toContain("jsdom not installed");
  });
});
