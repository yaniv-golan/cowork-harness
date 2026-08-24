import { defineConfig } from "vitest/config";

// The fast unit lane excludes EVERY live suite (they need Docker + the staged binary + a token).
// Run those separately: `npm run test:live`.
//
// The exclusion is a GLOB, not a filename list, and that is load-bearing. Naming files individually
// left `live-matrix` and `live-resume-continuity` in this lane, where they were held back only by
// their own `describe.skipIf(!CAN)`. On a normal dev machine (Docker up, image pulled, agent staged)
// the ONLY false leg of `CAN` is the token — so plain `npm test` was one `export
// CLAUDE_CODE_OAUTH_TOKEN=…` away from spending real money. Note the live suites read that token from
// `process.env` or `~/.cowork-harness-token` and NOT from the repo `.env` (vitest loads no dotenv), so
// checking `.env` is the wrong way to reassure yourself here.
//
// Keep this glob and `vitest.config.live.ts`'s `include` glob in sync: excluding here without
// including there would strand a live suite in neither lane.
export default defineConfig({
  test: {
    // Give every test process its own runs root so nothing writes into the developer's real
    // ~/.cowork-harness/runs. See test/setup/runs-root.ts for why this is structural rather than per-file.
    setupFiles: ["test/setup/runs-root.ts"],
    // 93 test files spawn a subprocess (the built CLI, `claude`, git); only a handful declare a timeout,
    // so the rest inherited vitest's 5s default. They measure 167-888ms locally — a comfortable margin
    // until you remember this lane runs 344 files in parallel across every core, and a CI runner is ~3x
    // slower again. That is how an 888ms subprocess test crosses 5s; it cost two red CI runs on unrelated
    // PRs before anyone looked. 30s is ~34x the slowest measured non-e2e case, so contention cannot
    // realistically reach it, while a genuine HANG still fails ~6x faster than in the live lane
    // (vitest.config.live.ts sets 180s). Per-test values still win where a suite needs more.
    testTimeout: 30_000,
    // `runs/` is ephemeral live-lane output (gitignored); it can hold permission-restricted agent artifacts
    // (e.g. macOS IPC semaphore files) that crash vitest's test-file walk with EACCES. It is never test
    // source, so exclude it from discovery.
    exclude: ["**/node_modules/**", "**/dist/**", "**/runs/**", "test/live-*.test.ts", "**/.claude/worktrees/**", "**/.worktrees/**"],
  },
});
