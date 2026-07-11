import { defineConfig } from "vitest/config";

// Live suites only (need real infra; token-gated cases need CLAUDE_CODE_OAUTH_TOKEN). `npm run test:live`.
// live-contract: Docker + the staged binary. live-matrix: `protocol` fidelity only — a live token, no Docker.
// LOCAL-ONLY lane: CI runners can never satisfy live-contract's Docker + macOS-staged-agent skipIf, so a
// green CI run carries ZERO coverage from this config — never count it as CI-verified.
export default defineConfig({
  test: {
    include: ["test/live-contract.test.ts", "test/live-matrix.test.ts"],
    testTimeout: 180000,
  },
});
