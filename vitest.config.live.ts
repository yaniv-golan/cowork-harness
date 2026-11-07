import { defineConfig } from "vitest/config";

// Live suites only (need real infra; token-gated cases need CLAUDE_CODE_OAUTH_TOKEN). `npm run test:live`.
// live-contract: Docker + the staged binary. live-matrix: `protocol` fidelity only — a live token, no Docker.
// live-resume-continuity: Docker + image + staged binary + token.
// LOCAL-ONLY lane: CI runners can never satisfy live-contract's Docker + macOS-staged-agent skipIf, so a
// green CI run carries ZERO coverage from this config — never count it as CI-verified.
//
// A GLOB, matching `vitest.config.ts`'s exclude glob. A hand-maintained file list drifts silently in the
// worst possible direction: `live-resume-continuity` was absent here while also being skip-gated in the
// default lane, so its assertions executed NOWHERE. Adding a live suite must never require remembering
// two edits.
//
// SPENDING: this lane bills. The `globalSetup` below says so once per run, and says the part that is
// easy to get wrong — an empty environment does NOT make it free, because at hostloop the agent
// self-sources credentials from the macOS Keychain. It lives in the CONFIG rather than the npm script
// so a direct `npx vitest run --config vitest.config.live.ts` gets it too.
export default defineConfig({
  test: {
    include: ["test/live-*.test.ts"],
    testTimeout: 180000,
    globalSetup: ["test/setup/live-lane-notice.ts"],
    // A run must resolve a model; live-model sets COWORK_HARNESS_MODEL in every worker when it is unset.
    // live-token resolves CLAUDE_CODE_OAUTH_TOKEN once, by one chain, for every live suite.
    setupFiles: ["test/setup/live-model.ts", "test/setup/live-token.ts"],
  },
});
