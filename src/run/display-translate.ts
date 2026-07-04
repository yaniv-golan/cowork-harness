import { join, resolve } from "node:path";
import type { VmPathContext } from "../vm-paths.js";
import { deepTranslateVMPaths, normalizeEncodePath } from "../vm-paths.js";

/**
 * CONTRACT: this module is the SINGLE policy seam for translating model-visible VM paths into
 * human-displayed paths. The closure here decides WHETHER a run's display surfaces (the live renderer
 * today; any future consumer of the same `AgentEvent` stream — a TUI, a web view — tomorrow) rewrite VM
 * paths to host paths, and performs the rewrite when they do. It is deliberately factored OUT of the
 * renderer (see docs/internal/2026-07-03-computer-link-scheme-research-and-plan.md, "Forward-
 * compatibility — a future full TUI", for the full rationale) so the policy can't drift between
 * consumers: any future frontend MUST consume `makeDisplayTranslator` + `vmPathContextFromPlan` rather
 * than re-deriving these rules against its own copy of the gate condition.
 *
 * Three invariants make up the gate (each enforced by a dedicated CONTRACT test in
 * test/display-translate.test.ts — copy that table, don't hand-roll a new gate check):
 *   1. **hostloop-only** — translate iff `effectiveFidelity === "hostloop"`. WHY: that's the one tier
 *      where the resolved host path is production-identical; at container/microvm/protocol a mount's
 *      "host" side is harness-internal staging, so translating there would be LESS faithful than the
 *      VM-shaped path production's own model also emits.
 *   2. **identity-without-ctx** — translate iff a `VmPathContext` was supplied. WHY: replay has no
 *      LaunchPlan/run-dir to resolve against — there is nothing to translate against, so identity is the
 *      only correct behavior, matching today's raw-VM-path replay rendering.
 *   3. **identity-when-shareable** — translate iff NOT `shareable` (e.g. `--compact`/`--demo`, or a
 *      future frontend's own export/share mode). WHY: shareable output must never leak a real host path
 *      (`/Users/…`) into something meant to be handed to someone else; this suppression wins even at
 *      hostloop with a ctx present.
 */
export interface DisplayTranslateOptions {
  /** The run's VM-path resolution context (mounts + run dirs). Absent for replay (a cassette has no
   *  LaunchPlan/run-dir — there is nothing to resolve against) — identity in that case, matching
   *  today's raw-VM-path replay rendering. */
  ctx?: VmPathContext;
  /** The tier actually used this run (post `cowork` gate resolution). Translate ONLY at `"hostloop"` —
   *  that is the one tier where the resolved host path is production-identical (a real user folder /
   *  the real staged uploads dir). At container/microvm/protocol, a mount's "host" side is harness-
   *  internal staging (`outDir/work/session/mnt/...`) — showing that would be LESS faithful than
   *  today's `/sessions/...` and would leak the runs dir, so those tiers stay untranslated. */
  effectiveFidelity?: string;
  /** `--compact`/`--demo` (or a future TUI's own export/share mode): the shareable, no-host-paths
   *  output. Its only existing tool, `collapseSessionRoot`, collapses `/sessions/<id>/mnt/` -> `mnt/`
   *  and cannot re-suppress an ALREADY-TRANSLATED `/Users/...` link — so shareable mode forces
   *  identity here rather than relying on that collapse to clean up after us. */
  shareable?: boolean;
}

/**
 * Build the display translator for one run. Gate: translate iff `effectiveFidelity === "hostloop"`
 * AND a ctx was supplied AND the output isn't shareable — every other combination (including
 * shareable-at-hostloop) is identity. See `DisplayTranslateOptions` for the rationale behind each leg.
 *
 * When active, this is host-loop mode in the vm-paths.ts sense (`hostLoopMode: true`): the model
 * already speaks host paths at this tier, so `deepTranslateVMPaths` mainly runs the
 * `encodeComputerUrlsForHostLoop` percent-encoding normalization pass; any VM-shaped path that still
 * shows up in the same text (unusual at hostloop, not impossible) maps through `ctx` too —
 * harmless belt-and-braces, not the primary job here.
 */
export function makeDisplayTranslator(opts: DisplayTranslateOptions): (text: string) => string {
  const { ctx, effectiveFidelity, shareable } = opts;
  if (effectiveFidelity !== "hostloop" || !ctx || shareable) return (text: string) => text;
  return (text: string) => deepTranslateVMPaths(text, ctx, /* hostLoopMode */ true);
}

/**
 * Build a `VmPathContext` from a run's `LaunchPlan` + run directory — pure joins, no filesystem
 * access, so it's safe to call before (or regardless of whether) anything is actually staged on disk.
 * Mirrors the SAME derivations the hostloop runtime itself uses, so the resolved paths agree with what
 * hostloop actually spawns against:
 *   - outputs/uploads: `<outDir>/work/session/mnt/{outputs,uploads}` — matches `hostOutputsDir` in
 *     `src/runtime/hostloop.ts` (`mntHost = join(resolve(outDir), "work", "session", "mnt")`) and the
 *     sibling `uploads` dir `stageHostLoopWorkspace` (`src/runtime/hostloop-stage.ts`) creates there.
 *   - folders: every `kind: "folder"` mount's `mountPath -> hostPath` (hostloop bind-mounts folders at
 *     their REAL host path — never a staged copy — so this is also production-identical, unlike the
 *     container/microvm tiers' staged-copy "host" side).
 * `.host-home`/`.auto-memory` are left unset (dormant features — see the plan's §1.8; `mapVMPathToHostPath`
 * already returns null for them without a resolver, which is correct until those gates flip).
 */
export function vmPathContextFromPlan(
  sessionId: string,
  plan: { mounts: Array<{ kind: string; hostPath: string; mountPath: string }> },
  outDir: string,
): VmPathContext {
  const mntHost = join(resolve(outDir), "work", "session", "mnt");
  const folders = new Map<string, string>();
  for (const m of plan.mounts) {
    if (m.kind === "folder") folders.set(m.mountPath, m.hostPath);
  }
  return {
    sessionId,
    outputsHostDir: join(mntHost, "outputs"),
    uploadsHostDir: join(mntHost, "uploads"),
    folders,
  };
}

// --- linkifyForTerminal: OSC 8 hyperlink decoration ---------------------------------------------
//
// This is a PRESENTATION decorator, not policy — it is the sibling of the closure above, not part of
// it. `makeDisplayTranslator` decides WHAT a path says (VM path vs. host path); `linkifyForTerminal`
// decides how a TERMINAL shows a `computer://` occurrence that's already there (a clickable OSC 8
// escape, on terminals that render it; invisible escapes around unchanged plain text on ones that
// don't). It never rewrites path content, so unlike `makeDisplayTranslator` it needs no
// `VmPathContext` and no fidelity/shareable gate of its own — the caller applies it only when that's
// appropriate (see `shouldLinkify` below), and, independent of that, it only ever wraps HOST-shaped
// payloads: a VM-shaped `/sessions/<id>/...` link has nothing on the host filesystem to resolve to,
// so it is always left exactly as written regardless of caller gating.

const OSC8_START = "\x1b]8;;";
const OSC8_SEP = "\x1b\\"; // ST (String Terminator) — closes the OSC 8 URI param before the display text
const OSC8_CLOSE = `${OSC8_START}${OSC8_SEP}`; // an empty-URI OSC 8 sequence ends the hyperlink

/** Same three-alternative scan order as vm-paths.ts's `encodeComputerUrlsForHostLoop` / computer-
 *  links.ts's `extractComputerLinks` (backtick-quoted, then markdown-link-open, then bare token) — a
 *  verified-safe pattern for telling the three `computer://` positions apart without double-counting
 *  a markdown/backtick occurrence as a bare token too. Both of those functions' own copies are
 *  module-private, so this is a small local re-statement of the same regex rather than a shared
 *  export (promoting it was out of this item's file scope; the three copies are kept in sync by
 *  inspection — each is ~1 line). */
const LINK_SCAN_RE = /(`computer:\/\/[^`]+`)|(\]\(computer:\/\/)|(computer:\/\/)/g;

const BARE_TOKEN_DELIMITERS = new Set(['"', "`", "]", "\\"]);

/** Paren-balanced token scanner — a local copy of vm-paths.ts's `scanTokenEnd` (module-private
 *  there). Scans forward from `start` for the end of a path-ish token: parens are balanced (so
 *  `report (draft).pdf` isn't cut at its own inner `)`); when `delimiters` is given, scanning also
 *  stops at the first delimiter char (or whitespace) seen at paren-depth 0. Returns the index one
 *  past the last token character. */
function scanTokenEnd(text: string, start: number, delimiters: Set<string> | null): number {
  let depth = 0;
  let lastOpenParen = -1;
  for (let i = start; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch === "(") {
      if (depth === 0) lastOpenParen = i;
      depth++;
    } else if (ch === ")") {
      if (depth === 0) return i;
      depth--;
      if (depth === 0) lastOpenParen = -1;
    } else if (depth === 0 && delimiters !== null && (delimiters.has(ch) || /\s/.test(ch))) {
      return i;
    }
  }
  return depth > 0 ? lastOpenParen : text.length;
}

/** Percent-decode a `/`-delimited payload one segment at a time (mirrors vm-paths.ts's own
 *  per-segment decode discipline — never a whole-string `decodeURIComponent`, so an already-decoded
 *  literal `%` in one segment can't corrupt an adjacent one). Used only to classify the payload's
 *  SHAPE (host vs. VM); the URI itself is built via `normalizeEncodePath`, which does its own
 *  decode-then-re-encode pass. */
function decodePathSegments(payload: string): string {
  return payload
    .split("/")
    .map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg; // not percent-encoded (or malformed) — keep as given
      }
    })
    .join("/");
}

/** True for a decoded `computer://` payload that is HOST-shaped: an absolute path (`/`-rooted) that
 *  is NOT itself VM-shaped (`/sessions/...`). Only host-shaped payloads have a `file://` target that
 *  resolves on THIS machine — a VM-shaped payload (still `/sessions/<id>/...` because this run never
 *  translated it: a non-hostloop tier, or hostloop with no ctx) names nothing on the host. */
function isHostShapedPayload(decoded: string): boolean {
  return decoded.startsWith("/") && !decoded.startsWith("/sessions/");
}

/** Wrap `displayText` (the untouched, original `computer://...` substring) in an OSC 8 hyperlink
 *  whose target is `file://` + the host path, normalized via `normalizeEncodePath` — decode-then-
 *  re-encode, NEVER a second raw encode pass over `displayPayload` (which may already be percent-
 *  encoded from the markdown/bare-token translate pass — a second encode would turn `%20` into
 *  `%2520`). */
function wrapOSC8(displayText: string, displayPayload: string): string {
  const uri = "file://" + normalizeEncodePath(displayPayload);
  return `${OSC8_START}${uri}${OSC8_SEP}${displayText}${OSC8_CLOSE}`;
}

/**
 * Decorate every HOST-shaped `computer://<absolute host path>` occurrence in `text` with an OSC 8
 * hyperlink escape: `\x1b]8;;file://<host, normalize-encoded>\x1b\\<original computer:// text>\x1b]8;;\x1b\\`.
 * The DISPLAYED text is always the ORIGINAL `computer://...` substring, byte-for-byte — a non-OSC-8-
 * aware pipe or terminal sees exactly today's plain output (the escapes are invisible or a no-op on
 * every other terminal). Pure and TUI-reusable: this function does no gating of its own (see
 * `shouldLinkify`) and touches only the string handed to it.
 *
 * Positions (rev 2, binding):
 *   - Markdown-link (`](computer://...)`) and bare tokens are linkified when host-shaped.
 *   - Backtick-quoted (`` `computer://...` ``) spans are NEVER linkified — a code span is a
 *     quotation, not an affordance, and it sidesteps that position's deliberately-unencoded payload.
 *   - VM-shaped payloads (`/sessions/...`) are left exactly as written at every position — nothing on
 *     the host resolves them.
 *
 * Idempotent: an occurrence already immediately preceded by this function's own OSC 8 opening
 * terminator (`\x1b\\`) is left untouched rather than wrapped again — this also rules out double-
 * ENCODING (an already-wrapped occurrence's URI is never re-run through `normalizeEncodePath`), not
 * just double-wrapping.
 */
export function linkifyForTerminal(text: string): string {
  if (!text.includes("computer://")) return text;
  const re = new RegExp(LINK_SCAN_RE.source, "g");
  let out = "";
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const whole = m[0];
    const backtick = m[1];
    const markdownOpen = m[2];
    const bare = m[3];
    out += text.slice(cursor, m.index);
    if (backtick !== undefined) {
      // Code spans are quotations, not affordances — never linkified, matching the module doc above.
      out += backtick;
      cursor = m.index + whole.length;
    } else if (markdownOpen !== undefined) {
      const contentStart = m.index + whole.length;
      const end = scanTokenEnd(text, contentStart, null);
      if (text.charAt(end) === ")") {
        const captured = text.slice(contentStart, end);
        const decoded = decodePathSegments(captured);
        out += isHostShapedPayload(decoded)
          ? markdownOpen.slice(0, 2) + wrapOSC8(`computer://${captured}`, captured)
          : markdownOpen + captured;
        out += ")";
        cursor = end + 1;
      } else {
        // Unterminated `](computer://…` — leave verbatim, matching production's own lenient handling.
        out += markdownOpen;
        cursor = contentStart;
      }
    } else if (bare !== undefined) {
      // A bare token immediately preceded by our own OSC 8 opening terminator is already wrapped —
      // skip it rather than wrap (or re-encode) it a second time.
      const alreadyWrapped = text.slice(0, m.index).endsWith(OSC8_SEP);
      const contentStart = m.index + whole.length;
      const end = scanTokenEnd(text, contentStart, BARE_TOKEN_DELIMITERS);
      const captured = text.slice(contentStart, end);
      if (!alreadyWrapped && isHostShapedPayload(decodePathSegments(captured))) {
        out += wrapOSC8(`computer://${captured}`, captured);
      } else {
        out += bare + captured;
      }
      cursor = end;
    }
    re.lastIndex = cursor;
  }
  out += text.slice(cursor);
  return out;
}

/**
 * The hyperlink decoration gate (rev 2, item 3.2 — ALL must hold): the sink is a real TTY
 * (`stderr.isTTY`, since the renderer only ever writes decoration to stderr); `CI` is unset (CI logs
 * are files, not an interactive terminal someone clicks in — mirrors the existing `!process.env.CI`
 * TTY gate at the `--on-unanswered` default, cli.ts); `COWORK_HARNESS_NO_HYPERLINKS` is unset (an
 * explicit opt-out, same naming precedent as `COWORK_HARNESS_NO_HEARTBEAT` in renderer.ts); and the
 * output isn't `shareable` (`--compact`/`--demo`, or chat's fixed non-shareable `false` — escape
 * sequences in shareable output are noise, same reasoning `makeDisplayTranslator`'s own `shareable`
 * leg uses). Exported as a small pure function (rather than gating inline at each call site) so the
 * gate itself is unit-testable without monkeypatching `process`.
 */
export function shouldLinkify(env: Record<string, string | undefined>, isTTY: boolean, shareable: boolean): boolean {
  return isTTY && !env.CI && !env.COWORK_HARNESS_NO_HYPERLINKS && !shareable;
}
