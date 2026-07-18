import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  confirmArtifactRuntime,
  confirmArtifactRuntimeWithLoader,
  isLoopbackHostname,
  isClearlyHarnessException,
} from "../src/run/analyze-artifact-runtime.js";

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

describe("confirmArtifactRuntime — bug-review regression fixtures (findings 18, 28-33)", () => {
  it(
    "an autosave fired by an `input` (edit) event, unread response -> lost (was clean/high)",
    async () => {
      const { path, html } = readFixture("edit-autosave-lost", "index.html");
      const result = await confirmArtifactRuntime(path, html);
      expect(result.available).toBe(true);
      if (!result.available) throw new Error("unreachable");
      // The old commit-only filter excluded the edit-attributed write entirely -> clean/high.
      expect(result.verdict).toBe("lost");
      expect(result.evidence.some((e) => e.includes("never consulted"))).toBe(true);
    },
    RUNTIME_TIMEOUT_MS,
  );

  it(
    "a load-time (null-action) write-back, unread response -> lost (was clean/high)",
    async () => {
      const { path, html } = readFixture("load-time-writeback-lost", "index.html");
      const result = await confirmArtifactRuntime(path, html);
      expect(result.available).toBe(true);
      if (!result.available) throw new Error("unreachable");
      expect(result.verdict).toBe("lost");
      // Unattributed writes are surfaced, labeled as load-time/async, never silently dropped to clean.
      expect(result.evidence.some((e) => e.includes("load-time/async"))).toBe(true);
    },
    RUNTIME_TIMEOUT_MS,
  );

  it(
    "fetch(new Request(...)) with a page-supplied Request polyfill -> lost (was clean, [object Object] GET)",
    async () => {
      const { path, html } = readFixture("request-object-writeback", "index.html");
      const result = await confirmArtifactRuntime(path, html);
      expect(result.available).toBe(true);
      if (!result.available) throw new Error("unreachable");
      expect(result.verdict).toBe("lost");
      // The recorded URL must be the Request's real url, not "[object Object]".
      expect(result.evidence.some((e) => e.includes("/api/save"))).toBe(true);
      expect(result.evidence.some((e) => e.includes("[object Object]"))).toBe(false);
    },
    RUNTIME_TIMEOUT_MS,
  );

  it(
    "XHR whose page reads responseText and distinguishes 200 vs 404 -> suspect (was mislabeled lost)",
    async () => {
      const { path, html } = readFixture("xhr-response-consumed-suspect", "index.html");
      const result = await confirmArtifactRuntime(path, html);
      expect(result.available).toBe(true);
      if (!result.available) throw new Error("unreachable");
      // Reading responseText now sets bodyConsulted, and both `load` listeners run -> the page provably
      // distinguishes success from failure -> suspect, not lost.
      expect(result.verdict).toBe("suspect");
    },
    RUNTIME_TIMEOUT_MS,
  );

  it(
    "a disabled destructive control is never activated -> clean (was lost via synthetic dispatch)",
    async () => {
      const { path, html } = readFixture("disabled-control-clean", "index.html");
      const result = await confirmArtifactRuntime(path, html);
      expect(result.available).toBe(true);
      if (!result.available) throw new Error("unreachable");
      expect(result.verdict).toBe("clean");
    },
    RUNTIME_TIMEOUT_MS,
  );

  it(
    "an unrelated external script + an observed native relative POST form -> lost (was inconclusive)",
    async () => {
      const { path, html } = readFixture("external-script-native-form-lost", "index.html");
      const result = await confirmArtifactRuntime(path, html);
      expect(result.available).toBe(true);
      if (!result.available) throw new Error("unreachable");
      // Observed write is analyzed FIRST — the external-script dependency no longer erases it.
      expect(result.verdict).toBe("lost");
    },
    RUNTIME_TIMEOUT_MS,
  );

  it(
    "a form targeting https://localhost.evil.com is remote -> clean (was a local lost false-positive)",
    async () => {
      const { path, html } = readFixture("localhost-lookalike-remote", "index.html");
      const result = await confirmArtifactRuntime(path, html);
      expect(result.available).toBe(true);
      if (!result.available) throw new Error("unreachable");
      expect(result.verdict).toBe("clean");
      expect(result.evidence.some((e) => e.includes("remote"))).toBe(true);
    },
    RUNTIME_TIMEOUT_MS,
  );
});

describe("isLoopbackHostname — exact normalized-hostname matching, not a prefix test", () => {
  it("recognizes genuine loopback hosts", () => {
    for (const h of ["localhost", "LOCALHOST", "localhost.", "127.0.0.1", "127.1.2.3", "0.0.0.0", "::1", "[::1]", "0:0:0:0:0:0:0:1"]) {
      expect(isLoopbackHostname(h)).toBe(true);
    }
  });
  it("rejects attacker hosts that merely start with a loopback token", () => {
    for (const h of [
      "localhost.evil.com",
      "127.evil.com",
      "0.0.0.0.evil.com",
      "127001.example.com",
      "notlocalhost",
      "example.com",
      "128.0.0.1",
      "227.0.0.1",
    ]) {
      expect(isLoopbackHostname(h)).toBe(false);
    }
  });
});

describe("isClearlyHarnessException — only re-throw exceptions clearly not from the page", () => {
  it("attributes jsdom/page-origin-framed exceptions to the page (not harness) so they stay swallowed→inconclusive", () => {
    const pageErr = new Error("boom");
    pageErr.stack = "Error: boom\n    at https://artifacts.cowork.invalid/v1/view/artifact/index.html:3:5";
    expect(isClearlyHarnessException(pageErr)).toBe(false);

    const jsdomErr = new Error("boom");
    jsdomErr.stack = "Error: boom\n    at Script.runInContext (node_modules/jsdom/lib/jsdom.js:1:1)";
    expect(isClearlyHarnessException(jsdomErr)).toBe(false);
  });
  it("flags an unrelated harness/test-runner exception (no page frame) so it is re-thrown fail-loud", () => {
    const harnessErr = new Error("unrelated");
    harnessErr.stack =
      "Error: unrelated\n    at Object.<anonymous> (/repo/test/some-other.test.ts:10:3)\n    at node_modules/vitest/dist/index.js:1:1";
    expect(isClearlyHarnessException(harnessErr)).toBe(true);
  });
  it("stays conservative (page attribution) when there is no usable stack", () => {
    const noStack = new Error("stack cleared");
    noStack.stack = "";
    expect(isClearlyHarnessException(noStack)).toBe(false);
    expect(isClearlyHarnessException("a string, not an Error")).toBe(false);
    expect(isClearlyHarnessException(undefined)).toBe(false);
  });
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
