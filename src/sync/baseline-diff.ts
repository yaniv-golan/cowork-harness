// The recursive structural differ for baselines, replacing the one-level `diff()` in cli.ts
// (stringify-compares each top key, printing whole subtrees on any nested change). Used by both the
// standalone `diff <baseline-a> <baseline-b>` command and the refactored `sync --diff`.

import { SCHEDULED_SESSION_WITHHELD_CONDITIONAL_TOOLS, SCHEDULED_SESSION_WITHHELD_TOOLS, withheldToolGateOn } from "../types.js";

export type BaselineDiffEntry =
  | { path: string; kind: "scalar"; from: unknown; to: unknown; annotation: boolean }
  | { path: string; kind: "array"; added: unknown[]; removed: unknown[]; annotation: boolean }
  | { path: string; kind: "added"; to: unknown; annotation: boolean }
  | { path: string; kind: "removed"; from: unknown; annotation: boolean };

/** A path segment is annotation-class ($comment, note, or any $-prefixed key) — still diffed (never
 *  silently dropped), but tagged so the changelog renderer can de-emphasize it rather than let comment
 *  churn read as real drift. */
function isAnnotationKey(key: string): boolean {
  return key.startsWith("$") || key === "note";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Two arrays diffed by structural (JSON) membership, order-insensitive — the fields this differ sees
 *  (allowDomains, tools, mounts) are sets/bags, not order-significant sequences. */
function diffArray(path: string, a: unknown[], b: unknown[], annotation: boolean): BaselineDiffEntry[] {
  const aKeys = a.map((v) => JSON.stringify(v));
  const bKeys = b.map((v) => JSON.stringify(v));
  const added = b.filter((_, i) => !aKeys.includes(bKeys[i]));
  const removed = a.filter((_, i) => !bKeys.includes(aKeys[i]));
  if (added.length === 0 && removed.length === 0) return [];
  return [{ path, kind: "array", added, removed, annotation }];
}

/**
 * Recursive structural diff between two baseline-shaped objects (or any nested JSON value reached
 * during that recursion). `pathAnnotation` carries whether any ancestor segment was itself
 * annotation-class, so a nested field under `$comment` (unlikely, but not assumed away) inherits the
 * tag rather than needing every leaf to re-derive it.
 */
export function diffBaselines(a: unknown, b: unknown, path = "", pathAnnotation = false): BaselineDiffEntry[] {
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    const out: BaselineDiffEntry[] = [];
    for (const k of keys) {
      const childPath = path ? `${path}.${k}` : k;
      const childAnnotation = pathAnnotation || isAnnotationKey(k);
      const hasA = Object.prototype.hasOwnProperty.call(a, k);
      const hasB = Object.prototype.hasOwnProperty.call(b, k);
      if (!hasA) {
        out.push({ path: childPath, kind: "added", to: b[k], annotation: childAnnotation });
      } else if (!hasB) {
        out.push({ path: childPath, kind: "removed", from: a[k], annotation: childAnnotation });
      } else {
        out.push(...diffBaselines(a[k], b[k], childPath, childAnnotation));
      }
    }
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) return diffArray(path, a, b, pathAnnotation);
  // scalar (or a type mismatch, e.g. object vs string — treated as a plain value change, not a crash)
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  return [{ path, kind: "scalar", from: a, to: b, annotation: pathAnnotation }];
}

const INIT = "provenance.desktopInitSurface";

type Kinds = { interactive?: number; scheduled?: number; other?: number; unknown?: number };
const describeKinds = (k: Kinds) =>
  (["interactive", "scheduled", "other", "unknown"] as const)
    .filter((n) => (k[n] ?? 0) > 0)
    .map((n) => `${k[n]} ${n}`)
    .join(", ") || "none";
const scheduledOnly = (k: Kinds | undefined) =>
  k !== undefined && (k.scheduled ?? 0) > 0 && !(k.interactive ?? 0) && !(k.other ?? 0) && !(k.unknown ?? 0);

/** The session-kind entries of one observed block, folded into one line, plus the kinds now read. A block gains
 *  `sessionKinds` whole (one `added` entry) or changes per leaf (scalar entries under it). */
function sessionKindsChange(mine: BaselineDiffEntry[], block: string): { line?: string; to?: Kinds; handled: BaselineDiffEntry[] } {
  const path = `${block}.sessionKinds`;
  const whole = mine.find((e) => e.path === path);
  if (whole?.kind === "added")
    return { line: `session kinds read: ${describeKinds(whole.to as Kinds)}`, to: whole.to as Kinds, handled: [whole] };
  const leaves = mine.filter((e) => e.path.startsWith(`${path}.`) && e.kind === "scalar");
  if (leaves.length === 0) return { handled: [] };
  const from: Kinds = {};
  const to: Kinds = {};
  for (const e of leaves) {
    if (e.kind !== "scalar") continue;
    const k = e.path.slice(path.length + 1) as keyof Kinds;
    from[k] = e.from as number;
    to[k] = e.to as number;
  }
  // Leaves name only the counts that moved; an unmoved count may be non-zero, so "scheduled-only" is not decidable here.
  return { line: `session kinds read changed (${describeKinds(from)} → ${describeKinds(to)}, other counts unchanged)`, handled: leaves };
}
const SCHEDULED_ONLY_NOTE =
  "every session read was a scheduled task, which Desktop never offers it to, so this is not evidence of a removal; sync asserts the code path that offers it to an untyped session, and its gate is on in the new baseline's `provenance.gates`";

const SCHEDULED_CONDITIONAL_NOTE =
  "every session read was a scheduled task, which Desktop never offers them to, and an ordinary session gets them only on the host-loop lane when the account has typed-artifact types — not attributable from this data either way; sync asserts the code path that offers them";

type InitServer = { presence?: string; toolsAll?: string[]; toolsSome?: string[] };
type InitBlock = { agentVersion?: string; appVersion?: string; observed?: boolean; servers?: Record<string, InitServer> };

const code = (xs: readonly string[]) => xs.map((x) => `\`${x}\``).join(", ");

function describeInitServer(s: InitServer | undefined): string {
  const all = s?.toolsAll ?? [];
  const some = s?.toolsSome ?? [];
  return `${all.length ? code(all) : "(none in every session)"}${some.length ? `; in some sessions only: ${code(some)}` : ""}`;
}

function describeInitBlock(b: InitBlock): string {
  if (!b.observed) return `UNOBSERVED at \`${b.appVersion}\` / agent \`${b.agentVersion}\` (no Cowork session since install)`;
  const servers = Object.entries(b.servers ?? {});
  if (servers.length === 0) return `observed at \`${b.appVersion}\`, but no Desktop server was connected`;
  return servers.map(([name, s]) => `\`${name}\` (${s.presence}): ${describeInitServer(s)}`).join(" · ");
}

/** Block-level rendering for `provenance.desktopInitSurface`, run BEFORE the per-entry loop because two of
 *  its cases are not expressible per entry: an `observed` true→false transition must replace the per-server
 *  removals it causes (otherwise "unobserved" reads as every Desktop server disappearing), and a tool that
 *  moved between `toolsAll` and `toolsSome` arrives as two array entries that only mean something together.
 *  Also handles first introduction, where the differ emits ONE whole-object `added` and never recurses.
 *  Entries under the block that none of this recognizes are returned in `rest`, so they still render
 *  generically — never silently dropped. `next` is the NEW baseline: a withheld tool's absence reads as the session
 *  kind only while the gate it also needs is on there; without `next`, or with the gate off, it stays DISAPPEARED. */
export function renderInitSurfaceEntries(entries: BaselineDiffEntry[], next?: unknown): { lines: string[]; rest: BaselineDiffEntry[] } {
  const mine = entries.filter((e) => e.path === INIT || e.path.startsWith(`${INIT}.`));
  const rest = entries.filter((e) => !mine.includes(e));
  const lines: string[] = [];
  if (mine.length === 0) return { lines, rest };

  const unhandled: BaselineDiffEntry[] = [];
  const whole = mine.find((e) => e.path === INIT);
  if (whole) {
    if (whole.kind === "added") lines.push(`- Desktop init surface now recorded: ${describeInitBlock(whole.to as InitBlock)}`);
    else if (whole.kind === "removed") lines.push("- Desktop init surface no longer recorded (field removed)");
    else unhandled.push(whole);
  }

  const observed = mine.find((e) => e.path === `${INIT}.observed` && e.kind === "scalar");
  const becameUnobserved = observed?.kind === "scalar" && observed.from === true && observed.to === false;
  const scalarTo = (leaf: string) => {
    const e = mine.find((x) => x.path === `${INIT}.${leaf}` && x.kind === "scalar");
    return e?.kind === "scalar" ? String(e.to) : undefined;
  };
  const app = scalarTo("appVersion");
  const agent = scalarTo("agentVersion");
  if (becameUnobserved) {
    lines.push(
      `- Desktop init surface UNOBSERVED${app ? ` at \`${app}\`` : ""}${agent ? ` / agent \`${agent}\`` : ""} — no Cowork session since install, so the server/tool removals below it are NOT evidence (not shown). Start a Cowork session and re-sync; the release preflight refuses this state`,
    );
  } else {
    if (observed?.kind === "scalar") lines.push("- Desktop init surface now OBSERVED (was unobserved)");
    if (app || agent)
      lines.push(
        `- Desktop init surface re-read for ${app ? `\`${app}\`` : "the same Desktop"} / agent ${agent ? `\`${agent}\`` : "unchanged"}`,
      );
  }

  const kinds = sessionKindsChange(mine, INIT);
  if (kinds.line && !becameUnobserved) lines.push(`- Desktop init surface ${kinds.line}`);
  // Only a diff that SHOWS the kinds becoming scheduled-only licenses reading a withheld tool's absence as the kind.
  const withheldByKind = scheduledOnly(kinds.to);
  const toolMoves = new Map<string, { addAll: string[]; addSome: string[]; rmAll: string[]; rmSome: string[] }>();
  for (const e of mine) {
    if (e === whole || e === observed || kinds.handled.includes(e)) continue;
    if (e.path === `${INIT}.appVersion` || e.path === `${INIT}.agentVersion`) {
      if (e.kind !== "scalar") unhandled.push(e);
      continue;
    }
    const server = e.path.match(/^provenance\.desktopInitSurface\.servers\.([^.]+)$/);
    if (server) {
      if (becameUnobserved && e.kind === "removed") continue;
      if (e.kind === "added") lines.push(`- Desktop server \`${server[1]}\` APPEARED: ${describeInitServer(e.to as InitServer)}`);
      else if (e.kind === "removed")
        lines.push(`- Desktop server \`${server[1]}\` DISAPPEARED (declared: ${describeInitServer(e.from as InitServer)})`);
      else unhandled.push(e);
      continue;
    }
    const presence = e.path.match(/^provenance\.desktopInitSurface\.servers\.([^.]+)\.presence$/);
    if (presence && e.kind === "scalar") {
      lines.push(
        `- Desktop server \`${presence[1]}\` presence: \`${e.from}\` → \`${e.to}\` (sensitive to the mix of session kinds read — a prompt to look, not evidence)`,
      );
      continue;
    }
    const list = e.path.match(/^provenance\.desktopInitSurface\.servers\.([^.]+)\.(toolsAll|toolsSome)$/);
    if (list && e.kind === "array") {
      const m = toolMoves.get(list[1]) ?? { addAll: [], addSome: [], rmAll: [], rmSome: [] };
      const [add, rm] = list[2] === "toolsAll" ? [m.addAll, m.rmAll] : [m.addSome, m.rmSome];
      add.push(...(e.added as string[]));
      rm.push(...(e.removed as string[]));
      toolMoves.set(list[1], m);
      continue;
    }
    unhandled.push(e);
  }
  for (const [server, m] of [...toolMoves.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const moved = (from: string[], to: string[]) => to.filter((t) => from.includes(t));
    const toAll = moved(m.rmSome, m.addAll);
    const toSome = moved(m.rmAll, m.addSome);
    const appeared = [...m.addAll, ...m.addSome].filter((t) => !toAll.includes(t) && !toSome.includes(t));
    const gone = [...m.rmAll, ...m.rmSome].filter((t) => !toAll.includes(t) && !toSome.includes(t));
    const withheld = withheldByKind
      ? gone.filter((t) => (SCHEDULED_SESSION_WITHHELD_TOOLS[server] ?? []).includes(t) && withheldToolGateOn(next, server, t))
      : [];
    // Only a tool that GOES is attributed. The reverse is not: an interactive read on an account with typed-artifact
    // types shows the cowork tools as ten plain APPEARED rows, since their arrival is real evidence about that read.
    const conditional = withheldByKind
      ? gone.filter((t) => !withheld.includes(t) && (SCHEDULED_SESSION_WITHHELD_CONDITIONAL_TOOLS[server] ?? []).includes(t))
      : [];
    const disappeared = gone.filter((t) => !withheld.includes(t) && !conditional.includes(t));
    if (appeared.length) lines.push(`- Desktop server \`${server}\`: tool(s) APPEARED: ${code(appeared.sort())}`);
    if (disappeared.length) lines.push(`- Desktop server \`${server}\`: tool(s) DISAPPEARED: ${code(disappeared.sort())}`);
    if (withheld.length) lines.push(`- Desktop server \`${server}\`: ${code(withheld.sort())} not observed: ${SCHEDULED_ONLY_NOTE}`);
    if (conditional.length)
      lines.push(`- Desktop server \`${server}\`: ${code(conditional.sort())} not observed: ${SCHEDULED_CONDITIONAL_NOTE}`);
    const mix = "(sensitive to the mix of session kinds read — a prompt to look, not evidence)";
    if (toAll.length) lines.push(`- Desktop server \`${server}\`: ${code(toAll.sort())} moved from some sessions to every session ${mix}`);
    if (toSome.length)
      lines.push(`- Desktop server \`${server}\`: ${code(toSome.sort())} moved from every session to some sessions ${mix}`);
  }
  return { lines, rest: [...rest, ...unhandled] };
}

const OBS = "provenance.observedSpawnEnv";
type ObsBlock = { observed?: boolean; appVersion?: string; reason?: string; declared?: string; keysAll?: string[]; keysSome?: string[] };

function describeObsBlock(b: ObsBlock): string {
  if (!b.observed) return `UNOBSERVED at \`${b.appVersion}\` (${b.reason}${b.declared ? `: ${b.declared}` : ""})`;
  const some = b.keysSome ?? [];
  return `recorded at \`${b.appVersion}\`: ${(b.keysAll ?? []).length} key(s) in every session${some.length ? `; in some: ${code(some)}` : ""}`;
}

/** Block-level rendering for `provenance.observedSpawnEnv`, for the same reasons as renderInitSurfaceEntries: an
 *  observed → unobserved change replaces the key removals it causes, and a key that moved between `keysAll` and
 *  `keysSome` arrives as two array entries that mean one thing. Unrecognized entries are returned in `rest`. */
export function renderObservedSpawnEnvEntries(entries: BaselineDiffEntry[]): { lines: string[]; rest: BaselineDiffEntry[] } {
  const mine = entries.filter((e) => e.path === OBS || e.path.startsWith(`${OBS}.`));
  const rest = entries.filter((e) => !mine.includes(e));
  const lines: string[] = [];
  if (mine.length === 0) return { lines, rest };
  const unhandled: BaselineDiffEntry[] = [];
  const whole = mine.find((e) => e.path === OBS);
  if (whole) {
    if (whole.kind === "added")
      lines.push(
        `- Desktop host-loop spawn env now ${describeObsBlock(whole.to as ObsBlock).replace(/^UNOBSERVED/, "recorded UNOBSERVED")}`,
      );
    else if (whole.kind === "removed") lines.push("- Desktop host-loop spawn env no longer recorded (field removed)");
    else unhandled.push(whole);
    return { lines, rest: [...rest, ...unhandled] };
  }
  const leaf = (name: string) => mine.find((e) => e.path === `${OBS}.${name}`);
  const value = (name: string): unknown => {
    const e = leaf(name);
    return e?.kind === "scalar" || e?.kind === "added" ? e.to : undefined;
  };
  const observed = leaf("observed");
  const app = (value("appVersion") as string | undefined) ?? undefined;
  if (observed?.kind === "scalar" && observed.from === true && observed.to === false) {
    const reason = value("reason") as string | undefined;
    const declared = value("declared") as string | undefined;
    lines.push(
      `- Desktop host-loop spawn env UNOBSERVED${app ? ` at \`${app}\`` : ""} (${reason ?? "?"}${declared ? `: ${declared}` : ""}) — the key removals it implies are NOT evidence (not shown)`,
    );
    return { lines, rest };
  }
  if (observed?.kind === "scalar" && observed.from === false && observed.to === true) {
    const keys = leaf("keysAll");
    const n = keys?.kind === "added" ? (keys.to as string[]).length : undefined;
    lines.push(
      `- Desktop host-loop spawn env now OBSERVED${app ? ` at \`${app}\`` : ""}${n !== undefined ? `: ${n} key(s) in every session` : ""}`,
    );
    return { lines, rest };
  }
  const arr = (name: string) => {
    const e = leaf(name);
    return e?.kind === "array" ? { added: e.added as string[], removed: e.removed as string[] } : { added: [], removed: [] };
  };
  const kinds = sessionKindsChange(mine, OBS);
  if (kinds.line) lines.push(`- Desktop host-loop spawn env ${kinds.line}`);
  const all = arr("keysAll");
  const some = arr("keysSome");
  const toAll = all.added.filter((k) => some.removed.includes(k));
  const toSome = some.added.filter((k) => all.removed.includes(k));
  const moved = new Set([...toAll, ...toSome]);
  // The scheduled-run key appearing is the kind, not a spawn change, when the diff shows every session became scheduled.
  const byKind = scheduledOnly(kinds.to) ? ["CLAUDE_CODE_HOST_SCHEDULED_RUN"] : [];
  const fromKind = all.added.filter((k) => byKind.includes(k));
  const appeared = [...all.added, ...some.added].filter((k) => !moved.has(k) && !fromKind.includes(k)).sort();
  const disappeared = [...all.removed, ...some.removed].filter((k) => !moved.has(k)).sort();
  if (fromKind.length)
    lines.push(
      `- Desktop host-loop spawn env: ${code(fromKind)} now in every session because every session read was a scheduled task (a dump counts as scheduled by carrying this key, so the line is circular here; sync's S6g check is what pins the key to scheduled runs)`,
    );
  if (appeared.length) lines.push(`- Desktop host-loop spawn env: key(s) APPEARED: ${code(appeared)}`);
  if (disappeared.length) lines.push(`- Desktop host-loop spawn env: key(s) DISAPPEARED: ${code(disappeared)}`);
  const mix = "(sensitive to the mix of session kinds read — a prompt to look, not evidence)";
  if (toAll.length) lines.push(`- Desktop host-loop spawn env: ${code(toAll.sort())} moved from some sessions to every session ${mix}`);
  if (toSome.length) lines.push(`- Desktop host-loop spawn env: ${code(toSome.sort())} moved from every session to some sessions ${mix}`);
  for (const e of mine) {
    if (kinds.handled.includes(e)) continue;
    if (e.path === `${OBS}.keysAll` || e.path === `${OBS}.keysSome`) {
      if (e.kind !== "array") unhandled.push(e);
      continue;
    }
    if (e.path === `${OBS}.appVersion` && e.kind === "scalar") {
      lines.push(`- Desktop host-loop spawn env re-read for \`${e.to}\``);
      continue;
    }
    if (e.path === `${OBS}.reason` && e.kind === "scalar") {
      lines.push(`- Desktop host-loop spawn env still unobserved: \`${e.from}\` → \`${e.to}\``);
      continue;
    }
    if (e.path === `${OBS}.sessions` || e.path === `${OBS}.nativeAgentVersions` || e.path === `${OBS}.withheld`) continue;
    unhandled.push(e);
  }
  return { lines, rest: [...rest, ...unhandled] };
}

/** Maps KNOWN baseline fields to prose; an unrecognized path still renders (never silently dropped),
 *  just as a generic line. Annotation-class entries are grouped into their own de-emphasized section
 *  instead of interleaved with real drift. */
/** Block-level rendering for the top-level `cloud` block (names, hashes and counts only, so no line can carry
 *  description text). Its first introduction is ONE count line rather than a dump of every fingerprint, and a
 *  fingerprint change is named per tool. Unrecognized entries under the block fall through to `rest`. */
export function renderCloudEntries(entries: BaselineDiffEntry[]): { lines: string[]; rest: BaselineDiffEntry[] } {
  const mine = entries.filter((e) => e.path === "cloud" || e.path.startsWith("cloud."));
  const rest = entries.filter((e) => !mine.includes(e));
  const lines: string[] = [];
  const unhandled: BaselineDiffEntry[] = [];
  type Fp = { name?: string; sha256?: string };
  for (const e of mine) {
    if (e.path === "cloud" && e.kind === "added") {
      const b = e.to as { remoteDevicesTools?: unknown[]; remoteDevicesDescriptions?: unknown[]; unreachable?: unknown[] };
      lines.push(
        `- cloud block now recorded: ${b.remoteDevicesTools?.length ?? 0} remote-devices tool(s), ${b.remoteDevicesDescriptions?.length ?? 0} description fingerprint(s), ${b.unreachable?.length ?? 0} unreachable feature(s)`,
      );
    } else if (e.path === "cloud" && e.kind === "removed") lines.push("- cloud block no longer recorded");
    else if (e.path === "cloud.remoteDevicesTools" && e.kind === "array") {
      if (e.added.length) lines.push(`- remote-devices tool(s) APPEARED: ${code(e.added as string[])}`);
      if (e.removed.length) lines.push(`- remote-devices tool(s) DISAPPEARED: ${code(e.removed as string[])}`);
    } else if (e.path === "cloud.remoteDevicesDescriptions" && e.kind === "array") {
      // A record whose name and text hash are on both sides moved only its `branch` (the selector assignment that
      // picks the same text was re-keyed): a relabel, rendered apart from a text change.
      const textKey = (f: Fp) => `${String(f.name)}\u0000${String(f.sha256)}`;
      const removedText = new Set((e.removed as Fp[]).map(textKey));
      const addedText = new Set((e.added as Fp[]).map(textKey));
      const per = new Map<string, { added: number; removed: number; relabeled: number }>();
      const bump = (n: string, k: "added" | "removed" | "relabeled") => {
        const c = per.get(n) ?? { added: 0, removed: 0, relabeled: 0 };
        c[k]++;
        per.set(n, c);
      };
      for (const f of e.added as Fp[]) bump(String(f.name), removedText.has(textKey(f)) ? "relabeled" : "added");
      for (const f of e.removed as Fp[]) if (!addedText.has(textKey(f))) bump(String(f.name), "removed");
      for (const [n, c] of [...per].sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (c.added || c.removed)
          lines.push(`- remote-devices \`${n}\`: description fingerprint(s) changed (+${c.added} −${c.removed} branch records)`);
        if (c.relabeled)
          lines.push(
            `- remote-devices \`${n}\`: ${c.relabeled} branch record(s) relabeled, same text (the conditions selecting it changed)`,
          );
      }
    } else if (e.path === "cloud.unreachable" && e.kind === "array") {
      if (e.added.length) lines.push(`- cloud.unreachable: added ${code(e.added as string[])}`);
      if (e.removed.length) lines.push(`- cloud.unreachable: removed ${code(e.removed as string[])}`);
    } else unhandled.push(e);
  }
  return { lines, rest: [...rest, ...unhandled] };
}

export function renderChangelog(allEntries: BaselineDiffEntry[], next?: unknown): string {
  const { lines: initOnly, rest: afterInit } = renderInitSurfaceEntries(allEntries, next);
  const { lines: obsLines, rest: afterObs } = renderObservedSpawnEnvEntries(afterInit);
  const { lines: cloudLines, rest: entries } = renderCloudEntries(afterObs);
  const initLines = [...initOnly, ...obsLines, ...cloudLines];
  const notable = entries.filter((e) => !e.annotation);
  const annotations = entries.filter((e) => e.annotation);
  const lines: string[] = [...initLines];

  const known: Record<string, (e: BaselineDiffEntry) => string | undefined> = {
    agentVersion: (e) => (e.kind === "scalar" ? `- staged agent bumped: \`${e.from}\` → \`${e.to}\`` : undefined),
    appVersion: (e) => (e.kind === "scalar" ? `- Desktop version bumped: \`${e.from}\` → \`${e.to}\`` : undefined),
    "network.allowDomains": (e) =>
      e.kind === "array"
        ? [
            e.added.length ? `- egress allowlist: added ${e.added.map((h) => `\`${h}\``).join(", ")}` : null,
            e.removed.length ? `- egress allowlist: removed ${e.removed.map((h) => `\`${h}\``).join(", ")}` : null,
          ]
            .filter(Boolean)
            .join("\n")
        : undefined,
    requireFullVmSandbox: (e) =>
      e.kind === "scalar"
        ? `- \`requireFullVmSandbox\`: \`${e.from}\` → \`${e.to}\``
        : e.kind === "added"
          ? `- \`requireFullVmSandbox\` introduced: \`${e.to}\``
          : undefined,
    "provenance.asarFingerprint": (e) =>
      e.kind === "scalar" ? `- cowork-relevant asar regions changed (fingerprint \`${e.from}\` → \`${e.to}\`)` : undefined,
    capturedAt: (e) => (e.kind === "scalar" ? `- baseline captured: \`${e.from}\` → \`${e.to}\`` : undefined),
    // The fcache snapshot identity. Only `content16` means the payload's CONTENT moved; the timestamp
    // and count move on refetches that changed nothing, so they are reported as the weaker signal.
    // No `added` branch: on first introduction the differ emits a single whole-object `added` at
    // `provenance.fcache` and never recurses, so a per-leaf added renderer here is unreachable.
    "provenance.fcache.content16": (e) =>
      e.kind === "scalar" ? `- fcache CONTENT changed (\`${e.from}\` → \`${e.to}\`) — gate membership and/or values moved` : undefined,
    "provenance.fcache.embeddedTimestamp": (e) =>
      e.kind === "scalar" ? `- fcache refetched (timestamp only; see content16 for whether it mattered)` : undefined,
    "provenance.fcache.featureCount": (e) => (e.kind === "scalar" ? `- fcache feature count: \`${e.from}\` → \`${e.to}\`` : undefined),
    // Gate ids referenced by the release's own bundle. Unlike the fcache leaves above this is a set, so
    // the delta names the ids outright — which is the whole point of recording it. `added` is reachable:
    // `provenance` already exists in every base, so the differ recurses and emits a per-LEAF `added` on
    // first introduction rather than one whole-object `added` (verified by executing diffBaselines).
    "provenance.asarGateIds": (e) =>
      e.kind === "array"
        ? `- gate ids referenced by the bundle: ${e.added.length} added${e.added.length ? ` (\`${e.added.join("`, `")}\`)` : ""}, ${e.removed.length} removed${e.removed.length ? ` (\`${e.removed.join("`, `")}\`)` : ""}`
        : e.kind === "added"
          ? `- gate ids referenced by the bundle: now recorded (${Array.isArray(e.to) ? e.to.length : 0} ids)`
          : undefined,
  };

  for (const e of notable) {
    // A value gate's SERVED KEY SET changing. Distinct from a value change, and previously invisible:
    // the gate regex below only matches paths ENDING at on|source|value, so a key appearing inside
    // `value` fell through to the generic renderer. It matters because an unserved key resolves to a
    // CODE default, which production may define as `true` — so a withdrawn key silently changes
    // behaviour with the gate still present and `on`. Observed for real: `pluginsFullSyncStalenessMs`
    // was served from 1.21459.0 and withdrawn at 1.24012.0.
    const servedKey = e.path.match(/^provenance\.gates\.([^.]+)\.value\.([^.]+)$/);
    if (servedKey && (e.kind === "added" || e.kind === "removed")) {
      const [, gate, key] = servedKey;
      lines.push(
        e.kind === "added"
          ? `- gate \`${gate}\`: now SERVES key \`${key}\` (\`${JSON.stringify(e.to)}\`) — previously fell back to the code default`
          : `- gate \`${gate}\`: STOPPED serving key \`${key}\` (was \`${JSON.stringify(e.from)}\`) — now falls back to the code default, which may not be the same value`,
      );
      continue;
    }
    // gate flips: provenance.gates.<name>.on|source|value|note
    const gateMatch = e.path.match(/^provenance\.gates\.([^.]+)\.(on|source|value)$/);
    if (gateMatch) {
      const [, gate, field] = gateMatch;
      if (e.kind === "scalar") lines.push(`- gate \`${gate}\`.${field}: \`${JSON.stringify(e.from)}\` → \`${JSON.stringify(e.to)}\``);
      else if (e.kind === "added") lines.push(`- gate \`${gate}\`.${field} introduced: \`${JSON.stringify(e.to)}\``);
      continue;
    }
    const renderer = known[e.path];
    const rendered = renderer?.(e);
    if (rendered) {
      lines.push(rendered);
      continue;
    }
    // field introduced in a newer baseline (older baseline predates it) reads as "introduced", not raw drift
    if (e.kind === "added") {
      lines.push(`- \`${e.path}\` introduced (field not present in the older baseline): \`${JSON.stringify(e.to)}\``);
    } else if (e.kind === "removed") {
      lines.push(`- \`${e.path}\` removed: was \`${JSON.stringify(e.from)}\``);
    } else if (e.kind === "scalar") {
      lines.push(`- \`${e.path}\`: \`${JSON.stringify(e.from)}\` → \`${JSON.stringify(e.to)}\``);
    } else {
      lines.push(`- \`${e.path}\`: added ${JSON.stringify(e.added)}, removed ${JSON.stringify(e.removed)}`);
    }
  }

  if (annotations.length) {
    lines.push("", "<details><summary>Annotations / comments changed</summary>", "");
    for (const e of annotations) {
      lines.push(`- \`${e.path}\` (annotation)`);
    }
    lines.push("</details>");
  }

  return lines.length ? lines.join("\n") + "\n" : "No differences.\n";
}

/** Plain-line rendering for `sync --diff` / a `diff` command's `--output-format text` — one line per
 *  entry at its exact leaf path, replacing the old one-level `diff()` which printed the WHOLE subtree
 *  under any top-level key that changed (so a single gate flip three levels deep used to dump all of
 *  `provenance`). No annotation/known-field prose here — that's `renderChangelog`'s job. */
export function formatDiffLines(allEntries: BaselineDiffEntry[], next?: unknown): string[] {
  // The init-surface block needs block-level context (see renderInitSurfaceEntries) — without it an
  // unobserved re-sync prints as three bare server removals here too.
  const { lines: initOnly, rest: afterInit } = renderInitSurfaceEntries(allEntries, next);
  const { lines: obsLines, rest: afterObs } = renderObservedSpawnEnvEntries(afterInit);
  const { lines: cloudLines, rest: entries } = renderCloudEntries(afterObs);
  const initLines = [...initOnly, ...obsLines, ...cloudLines];
  return [
    ...initLines.map((l) => l.replace(/^- /, "")),
    ...entries.map((e) => {
      if (e.kind === "scalar") return `${e.path}: ${JSON.stringify(e.from)} -> ${JSON.stringify(e.to)}`;
      if (e.kind === "added") return `${e.path}: (absent) -> ${JSON.stringify(e.to)}`;
      if (e.kind === "removed") return `${e.path}: ${JSON.stringify(e.from)} -> (absent)`;
      return `${e.path}: +${JSON.stringify(e.added)} -${JSON.stringify(e.removed)}`;
    }),
  ];
}
