// The live lane's credential. Every live suite gates on CLAUDE_CODE_OAUTH_TOKEN, and before this file each suite
// resolved it with its own chain, so the same machine could run one suite and silently skip another. This setup
// file runs in every live worker (vitest.config.live.ts `setupFiles`), resolves the token once by one chain and
// puts it in process.env, which every harness spawn in a live suite passes on. The value is never printed;
// COWORK_HARNESS_LIVE_TOKEN_SOURCE says where it came from.
import { applyLiveToken } from "./live-token-resolve.js";

applyLiveToken(process.env);
