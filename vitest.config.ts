import { defineConfig } from "vitest/config";

// The fast unit lane excludes the live contract suite (needs Docker + the staged binary
// + a token). Run that separately: `npm run test:live`.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "test/live-contract.test.ts"],
  },
});
