import { defineConfig } from "vitest/config";

// The fast unit lane excludes the live contract suite (needs Docker + the staged binary
// + a token). Run that separately: `npm run test:live`.
export default defineConfig({
  test: {
    // `runs/` is ephemeral live-lane output (gitignored); it can hold permission-restricted agent artifacts
    // (e.g. macOS IPC semaphore files) that crash vitest's test-file walk with EACCES. It is never test
    // source, so exclude it from discovery.
    exclude: ["**/node_modules/**", "**/dist/**", "**/runs/**", "test/live-contract.test.ts"],
  },
});
