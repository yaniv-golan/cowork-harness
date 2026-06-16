import { defineConfig } from "vitest/config";

// Live contract suite only (needs Docker + the staged binary; token-gated cases need
// CLAUDE_CODE_OAUTH_TOKEN). `npm run test:live`.
export default defineConfig({
  test: {
    include: ["test/live-contract.test.ts"],
    testTimeout: 90000,
  },
});
