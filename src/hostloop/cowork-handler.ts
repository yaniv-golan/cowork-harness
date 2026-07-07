import { copyFileSync, constants, existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { extname, join, posix, sep } from "node:path";
import type { McpHandler, McpResult } from "./workspace-handler.js";

/**
 * The `cowork` sdk-MCP server, driver-side — serves the single tool real Cowork gives an agent to
 * deliver a file to the user: `present_files`. A file written to the agent's cwd (the scratchpad,
 * `/sessions/<id>/…` outside `mnt/`) never reaches the user on its own; the agent must call
 * `present_files`, which copies it into `mnt/outputs` (where the post-run artifact scan looks) and
 * hands back the new path. A file already under a mount is passed through unchanged.
 *
 * The tool description below is harness-authored — the exact wire string wasn't captured in the
 * binary research that pinned the schema, `alwaysLoad` registration, and notify templates. Everything
 * else in this file (schema, algorithm, notify wording) is the pinned contract.
 */
const PRESENT_FILES_DESC =
  "Deliver a file to the user so they can open it on their own computer. If the file is in your " +
  "scratchpad (not under a mounted folder), it is copied into mnt/outputs first and the new path is " +
  "returned — keep working against that returned path, not the scratchpad original.";

// Exec/script extensions a presented file must never carry through untouched — a copy into
// mnt/outputs is a copy onto the user's real disk. `.skill` is deliberately NOT in this set.
const BLOCKED_EXTENSIONS = new Set([
  ".sh",
  ".bash",
  ".zsh",
  ".command",
  ".bat",
  ".cmd",
  ".ps1",
  ".vbs",
  ".js",
  ".py",
  ".rb",
  ".scpt",
  ".applescript",
  ".lnk",
  ".url",
  ".hta",
  ".reg",
]);

// Control characters, or `\ / :` anywhere in the basename.
const BLOCKED_BASENAME_CHARS = /[\x00-\x1f\x7f\\/:]/;

function isBlockedBasename(basename: string): boolean {
  if (basename === "" || basename === "." || basename === "..") return true;
  return BLOCKED_BASENAME_CHARS.test(basename);
}

function isBlockedExtension(basename: string): boolean {
  return BLOCKED_EXTENSIONS.has(extname(basename).toLowerCase());
}

/** First non-existent `name`, `name-1.ext`, `name-2.ext`, … inside `dir`. */
function pickCollisionSafeName(dir: string, basename: string): string {
  const ext = extname(basename);
  const stem = ext ? basename.slice(0, -ext.length) : basename;
  let candidate = basename;
  for (let n = 1; existsSync(join(dir, candidate)); n++) candidate = `${stem}-${n}${ext}`;
  return candidate;
}

export interface PresentedFile {
  from: string;
  to: string;
  promoted: boolean;
  error?: string;
}

type PromoteOutcome = { ok: true; vmOutputsPath: string } | { ok: false; error: string };

/**
 * Copy a scratchpad file (already confirmed to be a scratchpad path by the caller) into
 * `outputsHostDir`. Every failure — missing source, symlink, escape, blocked name/extension — takes
 * the same "copy failure" branch; nothing throws out of this function.
 */
function promoteScratchpadFile(vmPath: string, sessionRootVm: string, sessionHostDir: string, outputsHostDir: string): PromoteOutcome {
  try {
    const rel = vmPath.slice(sessionRootVm.length + 1);
    const hostSrc = join(sessionHostDir, rel);

    let st;
    try {
      st = lstatSync(hostSrc);
    } catch (e: any) {
      return { ok: false, error: `source not found (${e?.code ?? e?.message ?? String(e)})` };
    }
    // lstat (not stat) — does NOT follow symlinks, so a symlinked source is caught here regardless
    // of where it points; the copy is host-local with no guest-FS boundary to fall back on.
    if (st.isSymbolicLink()) return { ok: false, error: "source is a symlink" };
    if (!st.isFile()) return { ok: false, error: "source is not a regular file" };

    let sessionHostReal: string;
    let srcReal: string;
    try {
      sessionHostReal = realpathSync(sessionHostDir);
      srcReal = realpathSync(hostSrc);
    } catch (e: any) {
      return { ok: false, error: `could not resolve source path (${e?.message ?? String(e)})` };
    }
    // The naive VM-path prefix check (`isScratchpadVMPath`) is a plain `startsWith` and does not
    // normalize `..`; this realpath containment check is what actually stops a crafted
    // `/sessions/<id>/../../etc/passwd`-style path from reading outside the session tree.
    if (srcReal !== sessionHostReal && !srcReal.startsWith(sessionHostReal + sep))
      return { ok: false, error: "source escapes the session root" };

    const basename = posix.basename(vmPath);
    if (isBlockedBasename(basename)) return { ok: false, error: `blocked file name "${basename}"` };
    if (isBlockedExtension(basename)) return { ok: false, error: `blocked file extension on "${basename}"` };

    mkdirSync(outputsHostDir, { recursive: true });
    const outputsHostReal = realpathSync(outputsHostDir);
    const finalBasename = pickCollisionSafeName(outputsHostDir, basename);
    const destReal = join(outputsHostReal, finalBasename);
    if (destReal !== outputsHostReal && !destReal.startsWith(outputsHostReal + sep))
      return { ok: false, error: "destination escapes the outputs folder" };

    copyFileSync(hostSrc, join(outputsHostDir, finalBasename), constants.COPYFILE_EXCL);
    return { ok: true, vmOutputsPath: `${sessionRootVm}/mnt/outputs/${finalBasename}` };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

export function makeCoworkHandler(opts: {
  sessionRootVm: string; // "/sessions/<id>"
  sessionHostDir: string; // host path bind-mounted at sessionRootVm
  outputsHostDir: string; // host path of mnt/outputs
  /** Connected-folder mount paths (relative to mnt/, e.g. "my-src" or ".projects/my-src") — the
   *  session's `folder`-kind mounts. Real Cowork accepts a presented mnt path under one of these too. */
  folderMounts?: string[];
  onPresent?: (p: PresentedFile) => void;
}): McpHandler {
  const { sessionRootVm, sessionHostDir, outputsHostDir, folderMounts = [], onPresent } = opts;
  const isScratchpadVMPath = (vm: string) => vm.startsWith(`${sessionRootVm}/`) && !vm.startsWith(`${sessionRootVm}/mnt/`);

  // A path under mnt/ is presentable only if it lands under an actual mount (binary-verified against real
  // Cowork's sandbox handler): one of the fixed roots below, OR a connected folder's mount path. Any other
  // mnt/<X> — and a `.`/`..`/empty first segment — falls through to the "not accessible" rejection. No
  // existence/extension check here (those apply ONLY to scratchpad promotion, matching Cowork's ECe).
  const MOUNT_ROOT_ALLOWLIST = new Set(["outputs", "uploads", ".host-home", ".auto-memory"]);
  const isMountVMPath = (vm: string): boolean => {
    const prefix = `${sessionRootVm}/mnt/`;
    if (!vm.startsWith(prefix)) return false;
    const rel = vm.slice(prefix.length);
    const firstSegment = rel.split("/", 1)[0];
    if (firstSegment === "" || firstSegment === "." || firstSegment === "..") return false;
    if (MOUNT_ROOT_ALLOWLIST.has(firstSegment)) return true;
    // A connected folder mounts at mnt/<mountPath> (mountPath may itself be multi-segment, e.g.
    // ".projects/<name>") — accept a path AT or under it.
    return folderMounts.some((mp) => rel === mp || rel.startsWith(`${mp}/`));
  };

  const tools = [
    {
      name: "present_files",
      description: PRESENT_FILES_DESC,
      inputSchema: {
        type: "object",
        properties: {
          files: {
            type: "array",
            items: {
              type: "object",
              properties: { file_path: { type: "string" } },
              required: ["file_path"],
            },
          },
        },
        required: ["files"],
      },
      // NOT deferred behind ToolSearch — the tool must be visible from the first turn, exactly like
      // real Cowork, or a skill that writes-then-presents can never find it.
      _meta: { "anthropic/alwaysLoad": true },
    },
  ];

  return (_server, jr): McpResult => {
    const method = jr.method;
    if (method === "initialize")
      return {
        result: {
          protocolVersion: (jr.params && jr.params.protocolVersion) || "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "cowork", version: "1.0.0" },
        },
      };
    if (method === "tools/list") return { result: { tools } };
    if (method === "tools/call") {
      const name = jr.params?.name;
      if (name !== "present_files") return { error: { code: -32602, message: `unknown tool: ${name}` } };
      const filesArg = jr.params?.arguments?.files ?? [];

      // A non-array `files` (string, object, ...) must not reach `.some`/iteration below, which
      // would throw a TypeError instead of failing gracefully back to the agent.
      if (!Array.isArray(filesArg)) {
        return { error: { code: -32602, message: "present_files: files must be an array" } };
      }
      const files: { file_path: string }[] = filesArg;

      // Every entry must carry a non-empty string file_path before any path logic runs below — otherwise
      // a missing/wrong-typed field reaches `.startsWith` further down and throws instead of failing
      // gracefully back to the agent.
      const malformed = files.some((f) => typeof f.file_path !== "string" || f.file_path === "");
      if (malformed) return { error: { code: -32602, message: "present_files: each file requires a string file_path" } };

      // Pre-check: every path must be scratchpad OR already under a mount. Any other path is not
      // accessible on the user's computer at all — abort the WHOLE call before copying anything.
      const rejected = files.filter((f) => !isScratchpadVMPath(f.file_path) && !isMountVMPath(f.file_path));
      if (rejected.length) {
        return {
          error: {
            code: -32602,
            message: `Cannot present ${rejected.length} file(s) — not accessible on the user's computer: ${rejected
              .map((f) => f.file_path)
              .join(", ")}`,
          },
        };
      }

      const content: { type: string; text: string }[] = [];
      const notifies: string[] = [];
      for (const { file_path } of files) {
        if (isMountVMPath(file_path)) {
          content.push({ type: "text", text: file_path });
          onPresent?.({ from: file_path, to: file_path, promoted: false });
          continue;
        }
        const outcome = promoteScratchpadFile(file_path, sessionRootVm, sessionHostDir, outputsHostDir);
        if (outcome.ok) {
          content.push({ type: "text", text: outcome.vmOutputsPath });
          onPresent?.({ from: file_path, to: outcome.vmOutputsPath, promoted: true });
          notifies.push(
            `present_files: ${file_path} was in the scratchpad, so it's been copied to ${outcome.vmOutputsPath} for the user ` +
              `to open on their computer. Edit that path going forward — the scratchpad original won't reach the user.`,
          );
        } else {
          content.push({ type: "text", text: file_path });
          onPresent?.({ from: file_path, to: file_path, promoted: false, error: outcome.error });
          notifies.push(
            `present_files: ${file_path} could not be copied to the outputs folder (${outcome.error}). It remains in the ` +
              `scratchpad — the user can preview it but can't open it on their computer.`,
          );
        }
      }

      return notifies.length ? { result: { content }, notify: notifies.join("\n") } : { result: { content } };
    }
    return { result: {} }; // ping / notifications
  };
}
