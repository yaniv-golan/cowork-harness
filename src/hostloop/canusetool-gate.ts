import { homedir } from "node:os";
import { join } from "node:path";
import { ABSTAIN, type Abstain, type Decider, type Decision, type RunContext } from "../decide/decider.js";
import type { DecisionRequest } from "../agent/session.js";
import { PATH_GATE_TOOL_NAMES, expandTilde } from "./pretooluse-path-hook.js";
import { isVmSessionsPath } from "../vm-paths.js";

/** The SDK's own working-directory deny reason (asar `Zt`, `.vite/build/index.chunk-CS-g0Skn.js`,
 *  Desktop 1.20186.1 — also on the wire as decision_reason). Production's canUseTool wrapper rewrites
 *  denials carrying it. Byte-verified against the extracted asar (`const pe=["file_path","path"],
 *  Zt="Path is outside allowed working directories"`). */
export const SDK_WORKING_DIR_DENY = "Path is outside allowed working directories";

const GATED = new Set<string>(PATH_GATE_TOOL_NAMES);
const PATH_KEYS = ["file_path", "path"] as const;

const REQUEST_COWORK_DIRECTORY = "mcp__cowork__request_cowork_directory";

// Faithful (partial) port of Cowork's protected-folder-grant refusal (production `deniedCoworkMountRoot`
// / telemetry `lam_folder_grant_refused_protected`, Desktop 1.22209.0, `.vite/build/index.chunk-B6ZcqAwc.js`).
//
// UNREACHABLE TODAY: request_cowork_directory is not a registered/invokable tool in any lane of this
// harness (hostloop registers only bash+web_fetch, container only present_files — see
// docs/internal/2026-07-03-host-vm-bridge-capability-gaps.md, Tier 2, "the tool itself is never
// invokable. Emulated: no."). This check can never fire until that separate, larger gap is closed. It's
// ported now anyway so the exact refusal semantics are ready to activate the moment it is.
//
// Two closed sets, both resolved as exact-match-or-descendant of homedir()+entry. Deliberately NOT ported:
// the "managed" (Cowork-internal Scheduled/Artifacts/config-dir) branch of production's check, which
// depends on Cowork app-data-root concepts this harness has no analog for; and the reverse containment
// direction (an ANCESTOR request that would incidentally expose one of these paths, e.g. requesting `~`
// itself) — production's exact semantics for that direction weren't confirmed during investigation. Both
// gaps ABSTAIN rather than silently allow, but that ABSTAIN does NOT reach a human-approval prompt — this
// harness has no human-prompt path for plain permission requests at all. It falls through the Chain
// (execute.ts:698 / chat.ts:359-364) to PermissionDefaultDecider (decider.ts:236-256): under
// `permission_parity: "strict"` that's a deny, but under the DEFAULT `"cowork"` parity (session.ts:90) it's
// a decisive, loudly-flagged auto-ALLOW (rationale `PERMISSIVE_AUTOALLOW_RATIONALE` = "allow-unscripted
// (cowork parity)", audit-visible as `rec.permissiveAutoAllow`) — an unattended allow, not a prompt. Either
// way it just isn't auto-refused pre-prompt the way production refuses it. Also unhandled, unlike the sibling
// PreToolUse gate (pretooluse-path-hook.ts, which trims + lexically resolves + realpaths): no `.trim()`
// on the raw input and no case-folding — e.g. `" ~/.ssh"` (leading space) or `~/.SSH` (case-insensitive
// filesystem) will miss the deny and fall through to ABSTAIN. `..` segments ARE normalized for tilde-form
// input (expandTilde uses path.join, which collapses them — `~/foo/../.ssh` IS denied); a non-tilde
// absolute path containing `..` (e.g. `${home}/foo/../.ssh`) is NOT normalized and will miss.
const PROTECTED_DIRS = [".ssh", ".aws", ".gnupg", ".kube", ".docker", ".claude", ".config/gcloud", ".config/gh", ".config/powershell"];
const PROTECTED_DOTFILES = [".zshrc", ".zshenv", ".zprofile", ".zlogin", ".bashrc", ".bash_profile", ".bash_login", ".profile", ".netrc"];

const FOLDER_GRANT_DENIED_MESSAGE =
  "A requested folder can't be granted to this session. Ask the user to connect the folder they want using the folder picker on their device, or pick a different folder.";

/** True if `requested` (already tilde/absolute-resolved) equals or descends from `homedir()/entry`. */
function isUnderHomeEntry(requested: string, entry: string): boolean {
  const root = join(homedir(), entry);
  return requested === root || requested.startsWith(root + "/") || requested.startsWith(root + "\\");
}

function isProtectedHomePath(rawPath: string): boolean {
  const resolved = expandTilde(rawPath);
  return [...PROTECTED_DIRS, ...PROTECTED_DOTFILES].some((entry) => isUnderHomeEntry(resolved, entry));
}

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
      if (req.kind !== "permission") return ABSTAIN;
      if (req.tool === REQUEST_COWORK_DIRECTORY) {
        const raw = req.input.path;
        if (typeof raw === "string" && isProtectedHomePath(raw)) {
          return deny(FOLDER_GRANT_DENIED_MESSAGE, "hostloop canUseTool folder-grant deny (protected home path)");
        }
        return ABSTAIN; // no protected-path match → falls through the Chain to PermissionDefaultDecider:
        // strict-parity deny, or default cowork-parity auto-ALLOW (PERMISSIVE_AUTOALLOW_RATIONALE) — NOT a
        // human-approval prompt (see the doc comment above)
      }
      if (!GATED.has(req.tool)) return ABSTAIN;
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
