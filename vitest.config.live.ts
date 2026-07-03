import { defineConfig } from "vitest/config";

// Live suites only (need real infra; token-gated cases need CLAUDE_CODE_OAUTH_TOKEN). `npm run test:live`.
// live-contract: Docker + the staged binary. live-matrix: `protocol` fidelity only — a live token, no Docker.
export default defineConfig({
  test: {
    include: ["test/live-contract.test.ts", "test/live-matrix.test.ts"],
    testTimeout: 180000,
  },
});
