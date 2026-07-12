import { ABSTAIN, type Abstain, type Decider, type Decision, type RunContext } from "../decide/decider.js";
import type { DecisionRequest } from "../agent/session.js";
import { PATH_GATE_TOOL_NAMES } from "./pretooluse-path-hook.js";
import { isVmSessionsPath } from "../vm-paths.js";

/** The SDK's own working-directory deny reason (asar `Zt`, `.vite/build/index.chunk-CS-g0Skn.js`,
 *  Desktop 1.20186.1 — also on the wire as decision_reason). Production's canUseTool wrapper rewrites
 *  denials carrying it. Byte-verified against the extracted asar (`const pe=["file_path","path"],
 *  Zt="Path is outside allowed working directories"`). */
export const SDK_WORKING_DIR_DENY = "Path is outside allowed working directories";

const GATED = new Set<string>(PATH_GATE_TOOL_NAMES);
const PATH_KEYS = ["file_path", "path"] as const;

/** Every non-abstain return is a FULL Decision ({response, by, rationale} — decider.ts:25-30): the
 *  permission payload nests under `response`, matching PermissionDefaultDecider's shape. */
const deny = (message: string, rationale: string): Decision => ({
  response: { kind: "permission", behavior: "deny", message },
  by: "agent",
  rationale,
});

/**
 * Port of production's canUseTool chain (Desktop 1.20186.1, `.vite/build/index.chunk-CS-g0Skn.js`):
 * `Se && (e.canUseTool = async (g,S,k) => xe(g,S) ?? Qt(g,S,k.decisionReason,n) ?? Se(g,S,k))` — the
 * `/sessions` guard duplicated into canUseTool, then the SDK deny-reason rewriter, then the ORIGINAL
 * callback. The harness analog of "installed only when a callback exists" is composition into the
 * always-present Decider chain, FIRST (Chain stops at the first non-abstain — placed later it would
 * never run). Denies short-circuit the ask, exactly as production's `??`-chain short-circuits `Se`.
 *
 * Both `xe` and `Qt`'s texts below are reproduced VERBATIM from the extracted asar (byte-faithful port,
 * same practice as the pretooluse-path-hook.ts gate). `xe`'s text matches
 * `src/hostloop/pretooluse-path-hook.ts`'s existing `/sessions` VM-path message exactly (same production
 * string, two call sites).
 */
export function makeHostLoopCanUseToolGate(): Decider {
  return {
    async decide(req: DecisionRequest, _ctx?: RunContext): Promise<Decision | Abstain> {
      if (req.kind !== "permission" || !GATED.has(req.tool)) return ABSTAIN;
      // xe: the /sessions guard (both keys, 5-set only — MultiEdit not in the set, matching production).
      for (const key of PATH_KEYS) {
        const v = req.input[key];
        if (typeof v === "string" && isVmSessionsPath(v))
          return deny(
            `\`${v}\` is a VM path. In this session the ${req.tool} tool runs on the host filesystem, where ` +
              `\`/sessions/...\` doesn't exist. Use the host path for this file (connected folders are available ` +
              `at their real locations), or use the \`bash\` tool — which runs inside the VM — to operate on ` +
              `\`/sessions/...\` paths.`,
            "hostloop canUseTool VM-path guard",
          );
      }
      // Qt: production's shape (`function Qt(e,o,r,n){ if(!GATED.includes(e))return; const s=[...].find(...);
      // if(s!==void 0)return ...,r===Zt?{...}:{...} }`) keys on the PATH, not the reason: whenever a gated
      // request carries a path (`s !== void 0`) it is DENIED, and `decisionReason` ONLY selects the wording
      // — the exact working-directory constant (`r === Zt`) → connected-folder wording; anything else →
      // protected-location wording. A gated request with NO path is left to Se/the policy chain (abstain).
      //
      // Production's Qt ALSO branches on a 4th param `n` (session type: chat vs cowork-task), producing a
      // scratch-directory-worded variant of BOTH messages for chat-type sessions — a dimension this port does
      // NOT model (DecisionRequest carries no session-type signal, and this gate has no config surface for
      // it, unlike the PreToolUse gate's `scratchMode`). The texts below are the COWORK-TASK (non-chat)
      // variant, matching what this repo's DecisionRequest/hostloop lanes actually produce today.
      const raw = PATH_KEYS.map((k) => req.input[k]).find((v): v is string => typeof v === "string");
      if (raw === undefined) return ABSTAIN; // no path → not Qt's concern (the /sessions guard above already ran)
      return req.decisionReason === SDK_WORKING_DIR_DENY
        ? deny(
            `\`${raw}\` is outside this session's connected folders, so ${req.tool} can't reach it. If this is a user project or working folder, request it with the \`request_cowork_directory\` tool — the user will be asked to approve it. Don't request system or application-internal directories.`,
            "hostloop canUseTool path deny (working-directory wording)",
          )
        : deny(
            `${req.tool} on \`${raw}\` is blocked in this session — it resolves to a protected location or a path outside the connected folder. Work on a copy under the session outputs folder if you need to modify it.`,
            "hostloop canUseTool path deny (protected-location wording)",
          );
    },
  };
}
