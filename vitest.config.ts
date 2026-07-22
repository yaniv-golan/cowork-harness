import { defineConfig } from "vitest/config";

// The fast unit lane excludes the live contract suite (needs Docker + the staged binary
// + a token). Run that separately: `npm run test:live`.
export default defineConfig({
  test: {
    // Give every test process its own runs root so nothing writes into the developer's real
    // ~/.cowork-harness/runs. See test/setup/runs-root.ts for why this is structural rather than per-file.
    setupFiles: ["test/setup/runs-root.ts"],
    // `runs/` is ephemeral live-lane output (gitignored); it can hold permission-restricted agent artifacts
    // (e.g. macOS IPC semaphore files) that crash vitest's test-file walk with EACCES. It is never test
    // source, so exclude it from discovery.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/runs/**",
      "test/live-contract.test.ts",
      "**/.claude/worktrees/**",
      "**/.worktrees/**",
    ],
  },
});
